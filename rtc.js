/**
 * rtc.js — WebRTC 数据通道 + 「连接码」编解码
 *
 * 设计要点：
 *  1. 不用信令服务器。SDP 先做 deflate 压缩再 base64url 编码，得到一串可复制、
 *     可塞进二维码的「连接码」，由用户手工在两端传递（复制粘贴或扫二维码）。
 *  2. 采用「非 trickle」方式：等 ICE 收集完成后再把完整 SDP 编码出去，
 *     这样一次交换就能建连，不需要多次传候选地址。
 *  3. 只在局域网用，STUN 仅作兜底（打不通直连时才会用到）。
 */

const CODE_PREFIX = 'RPS1';          // 连接码前缀，兼作版本号
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const GATHER_TIMEOUT = 4000;         // 等 ICE 收集完成的上限（毫秒）

/* ── base64url ─────────────────────────────────────── */

function toB64url(bytes) {
  let s = '';
  const CHUNK = 0x8000;                         // 分块，避免 apply 参数过多
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* ── deflate / inflate ─────────────────────────────── */

async function throughStream(bytes, stream) {
  const readable = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(readable).arrayBuffer());
}

const hasCompression = () =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/* ── 连接码 ────────────────────────────────────────── */

/** RTCSessionDescriptionInit → "RPS1…" 连接码 */
export async function encodeSignal(desc) {
  const raw = new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
  let flag = '0';
  let body = raw;
  if (hasCompression()) {
    try {
      body = await throughStream(raw, new CompressionStream('deflate-raw'));
      flag = '1';
    } catch {
      body = raw;                               // 压缩失败就退回明文
      flag = '0';
    }
  }
  return CODE_PREFIX + flag + toB64url(body);
}

/** 连接码 → { type, sdp } */
export async function decodeSignal(code) {
  const s = String(code || '').replace(/\s+/g, '');
  if (!s) throw new Error('连接码是空的');
  if (!s.startsWith(CODE_PREFIX)) throw new Error('这段文字不是连接码（开头应为 RPS1）');

  const flag = s[CODE_PREFIX.length];
  const payload = fromB64url(s.slice(CODE_PREFIX.length + 1));

  let raw;
  if (flag === '1') {
    if (!hasCompression()) throw new Error('这个浏览器不支持解压该连接码，请换用 Chrome / Edge / Safari 16.4+');
    raw = await throughStream(payload, new DecompressionStream('deflate-raw'));
  } else {
    raw = payload;
  }

  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error('连接码内容损坏，可能没复制完整');
  }
  if (!obj || !obj.t || typeof obj.s !== 'string') throw new Error('连接码内容不完整');
  return { type: obj.t, sdp: obj.s };
}

/* ── Peer ──────────────────────────────────────────── */

/**
 * 单向数据通道的极简封装。事件（CustomEvent）：
 *   'open'    通道打开
 *   'message' detail = 解析后的对象
 *   'close'   通道关闭
 *   'state'   detail = RTCPeerConnectionState
 *   'error'   detail = Error
 */
export class Peer extends EventTarget {
  constructor() {
    super();
    this.pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 0,
    });
    this.dc = null;

    this.pc.onconnectionstatechange = () => {
      this._emit('state', this.pc.connectionState);
    };
    this.pc.ondatachannel = (ev) => this._bind(ev.channel);
    // 单个 STUN 探不通不算错误，忽略即可（局域网直连本来就不需要它）
    this.pc.onicecandidateerror = () => {};
  }

  /* ---- 事件 ---- */
  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ---- 通道 ---- */
  _bind(channel) {
    this.dc = channel;
    this.dc.binaryType = 'arraybuffer';
    this.dc.onopen = () => this._emit('open');
    this.dc.onclose = () => this._emit('close');
    this.dc.onerror = () => this._emit('error', new Error('数据通道出错'));
    this.dc.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;                                   // 忽略看不懂的包
      }
      this._emit('message', msg);
    };
  }

  isOpen() {
    return Boolean(this.dc && this.dc.readyState === 'open');
  }

  send(obj) {
    if (!this.isOpen()) return false;
    this.dc.send(JSON.stringify(obj));
    return true;
  }

  /* ---- 握手 ---- */

  /** 房主：生成 offer 连接码 */
  async createOffer() {
    this._bind(this.pc.createDataChannel('game', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this._gatherIce();
    return encodeSignal(this.pc.localDescription);
  }

  /** 加入者：吃下 offer 连接码，生成 answer 连接码 */
  async createAnswer(offerCode) {
    const offer = await decodeSignal(offerCode);
    if (offer.type !== 'offer') throw new Error('这里需要房主的「连接码」，不是回应码');
    await this.pc.setRemoteDescription(offer);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this._gatherIce();
    return encodeSignal(this.pc.localDescription);
  }

  /** 房主：吃下 answer 连接码，连接随即开始建立 */
  async acceptAnswer(answerCode) {
    const answer = await decodeSignal(answerCode);
    if (answer.type !== 'answer') throw new Error('这里需要对方的「回应码」，不是连接码');
    await this.pc.setRemoteDescription(answer);
  }

  close() {
    try { this.dc && this.dc.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
  }

  /* ---- ICE ---- */

  _gatherIce(timeout = GATHER_TIMEOUT) {
    const pc = this.pc;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      // 超时也照样用已收集到的候选地址，总比卡住强
      const timer = setTimeout(finish, timeout);
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }
}
