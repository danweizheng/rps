/**
 * app.js — 界面、游戏状态机、深链配对
 *
 * 对局规则（两端各自本地计算，不需要裁判）：
 *   出拳消息带一个「局号」r。谁先开新局，就把 r 加一。
 *   收到 r 比自己大，说明对方开了新的一局，本地这一拳作废。
 *   两边各自在拿到双方出拳后用同一套规则判定，结果必然一致，比分不会跑偏。
 */

import { Peer } from './rtc.js';

/* ── 常量 ─────────────────────────────────────────── */

const HANDS = {
  R: { emoji: '✊', name: '石头' },
  P: { emoji: '✋', name: '布' },
  S: { emoji: '✌️', name: '剪刀' },
};
const BEATS = { R: 'S', S: 'P', P: 'R' };   // 键 战胜 值

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ── 状态 ─────────────────────────────────────────── */

const state = {
  peer: null,
  role: null,              // 'host' | 'guest'
  round: 0,
  myPick: null,
  theirPick: null,
  settledRound: -1,        // 已算过分的局号，防止重复加分
  score: { me: 0, them: 0 },
  answerApplied: false,    // 房主是否已经用掉回应码
  applyingAnswer: false,
};

const resolved = () => Boolean(state.myPick && state.theirPick);

/* ── 小工具 ───────────────────────────────────────── */

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

function setBusy(on, text) {
  const el = $('#busy');
  el.hidden = !on;
  if (text) $('[data-busy-text]').textContent = text;
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  window.scrollTo(0, 0);
}

/** 把连接码包成可以扫的链接：<当前地址>#o=… / #a=… */
function deepLink(kind, code) {
  const url = new URL(location.href);
  url.hash = `${kind}=${code}`;
  return url.href;
}

function renderQr(selector, text) {
  const box = $(selector);
  if (!box) return;
  box.textContent = '';
  if (!text || !window.QrCreator) return;      // 没有二维码库也不影响复制粘贴
  const canvas = document.createElement('canvas');
  box.appendChild(canvas);
  try {
    window.QrCreator.render({
      text,
      ecLevel: 'L',                            // 连接码偏长，用最低纠错等级换容量
      size: 260,
      radius: 0,
      quiet: 3,
      minVersion: 1,
      maxVersion: 40,
      fill: '#0b0d12',
      background: '#ffffff',
    }, canvas);
  } catch (err) {
    box.textContent = '';
    console.warn('二维码生成失败，用下面的连接码复制即可：', err);
  }
}

async function copyFrom(key) {
  const el = $(`[data-out="${key}"]`);
  if (!el || !el.value) return;
  try {
    await navigator.clipboard.writeText(el.value);
    toast('已复制');
  } catch {
    el.removeAttribute('readonly');
    el.select();
    el.setSelectionRange(0, el.value.length);
    const ok = document.execCommand('copy');
    el.setAttribute('readonly', '');
    toast(ok ? '已复制' : '复制失败，请长按手动复制');
  }
}

/** 出拳时给手势一个弹一下的动画 */
function popHand(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('pop');
  void el.offsetWidth;                          // 强制重排，让动画能重播
  el.classList.add('pop');
}

/* ── 渲染 ─────────────────────────────────────────── */

function renderGame() {
  $('[data-score="me"]').textContent = state.score.me;
  $('[data-score="them"]').textContent = state.score.them;

  popHand($('[data-hand="me"]'), state.myPick ? HANDS[state.myPick].emoji : '❔');
  popHand($('[data-hand="them"]'), state.theirPick ? HANDS[state.theirPick].emoji : '❔');

  const out = $('[data-result]');
  delete out.dataset.tone;
  if (resolved()) {
    const verdict = judge(state.myPick, state.theirPick);
    if (verdict === 'me') { out.textContent = '这一局你赢了 🎉'; out.dataset.tone = 'me'; }
    else if (verdict === 'them') { out.textContent = '这一局你输了'; out.dataset.tone = 'them'; }
    else { out.textContent = '平局，再来一局'; out.dataset.tone = 'draw'; }
  } else if (state.myPick) {
    out.textContent = '等你对手出拳…';
  } else if (state.theirPick) {
    out.textContent = '对方已经出拳了，快选！';
  } else {
    out.textContent = '选一个出拳';
  }

  const locked = Boolean(state.myPick) && !resolved();   // 分晓之后可以直接开下一局
  $$('.choice').forEach((b) => {
    b.disabled = locked;
    b.classList.toggle('picked', b.dataset.pick === state.myPick);
  });
}

function setConn(ok, text) {
  $('[data-conn]').dataset.ok = ok ? '1' : '0';
  $('[data-conntext]').textContent = text;
}

/* ── 判定与计分 ───────────────────────────────────── */

function judge(a, b) {
  if (a === b) return 'draw';
  return BEATS[a] === b ? 'me' : 'them';
}

/** 双方都出拳了就结算这一局（每局只算一次） */
function settle() {
  if (!resolved() || state.settledRound === state.round) return;
  state.settledRound = state.round;
  const verdict = judge(state.myPick, state.theirPick);
  if (verdict === 'me') state.score.me += 1;
  else if (verdict === 'them') state.score.them += 1;
}

/* ── 出拳 ─────────────────────────────────────────── */

function pick(hand) {
  if (!HANDS[hand]) return;
  if (!state.peer || !state.peer.isOpen()) { toast('还没连上对手'); return; }

  if (resolved()) {                 // 上一局已分晓，这一拳开新的一局
    state.round += 1;
    state.myPick = null;
    state.theirPick = null;
  }
  if (state.myPick) return;         // 本局已出拳，等对方

  state.myPick = hand;
  state.peer.send({ t: 'p', r: state.round, v: hand });
  settle();                         // 对方可能已经先出拳了，这一拳正好凑齐
  renderGame();
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.t !== 'p') return;
  const round = Number(msg.r) | 0;
  if (round > state.round) {        // 对方开了新的一局，本地作废
    state.round = round;
    state.myPick = null;
    state.theirPick = null;
  }
  if (round !== state.round) return;
  state.theirPick = HANDS[msg.v] ? msg.v : null;
  settle();
  renderGame();
}

/* ── 连接管理 ─────────────────────────────────────── */

function resetPeer() {
  const peer = state.peer;
  state.peer = null;
  if (peer) peer.close();
}

function wirePeer(peer) {
  const live = () => state.peer === peer;       // 换过一轮之后旧事件一律丢掉

  peer.addEventListener('open', () => {
    if (!live()) return;
    setBusy(false);
    setConn(true, '已连接');
    showView('game');
    renderGame();
    toast('对手已连接，开打！');
  });
  peer.addEventListener('message', (ev) => { if (live()) onMessage(ev.detail); });
  peer.addEventListener('close', () => { if (live()) setConn(false, '对手已离开'); });
  peer.addEventListener('error', () => { if (live()) setConn(false, '连接出错'); });
  peer.addEventListener('state', (ev) => {
    if (!live()) return;
    const s = ev.detail;
    if (s === 'failed') setConn(false, '连接失败，请重来');
    else if (s === 'disconnected') setConn(false, '连接中断');
    else if (s === 'closed') setConn(false, '连接已关闭');
  });
}

async function startHost() {
  resetPeer();
  showView('host');
  state.role = 'host';
  state.answerApplied = false;
  state.applyingAnswer = false;
  $('[data-note="handoff"]').hidden = true;
  $('[data-in="answer"]').value = '';
  setBusy(true, '正在生成连接码…');
  try {
    state.peer = new Peer();
    wirePeer(state.peer);
    const code = await state.peer.createOffer();
    $('[data-out="offer"]').value = code;
    renderQr('[data-qr="offer"]', deepLink('o', code));
  } catch (err) {
    toast('生成失败：' + err.message);
  } finally {
    setBusy(false);
  }
}

async function makeAnswer() {
  const code = $('[data-in="offer"]').value.trim();
  if (!code) { toast('请先粘贴房主的连接码'); return; }

  resetPeer();
  state.role = 'guest';
  setBusy(true, '正在生成回应码…');
  try {
    state.peer = new Peer();
    wirePeer(state.peer);
    const answer = await state.peer.createAnswer(code);
    $('[data-out="answer"]').value = answer;
    renderQr('[data-qr="answer"]', deepLink('a', answer));
    $$('[data-when="answered"]').forEach((n) => { n.hidden = false; });
    $('[data-qr="answer"]').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    toast('打不开这个连接码：' + err.message);
  } finally {
    setBusy(false);
  }
}

async function acceptAnswer() {
  const code = $('[data-in="answer"]').value.trim();
  if (!code) { toast('请先粘贴对方发回的回应码'); return; }
  if (!state.peer) { toast('房间已经失效，请重新创建'); return; }
  if (state.answerApplied || state.applyingAnswer) return;

  state.applyingAnswer = true;
  setBusy(true, '正在连接…');
  try {
    await state.peer.acceptAnswer(code);
    state.answerApplied = true;
    // 真正连上会触发 'open'，在那里切到对战界面
  } catch (err) {
    toast('回应码无效：' + err.message);
  } finally {
    state.applyingAnswer = false;
    setBusy(false);
  }
}

function goHome() {
  resetPeer();
  state.role = null;
  state.round = 0;
  state.myPick = null;
  state.theirPick = null;
  state.settledRound = -1;
  state.score = { me: 0, them: 0 };
  state.answerApplied = false;
  state.applyingAnswer = false;

  $('[data-out="offer"]').value = '';
  $('[data-out="answer"]').value = '';
  $('[data-in="offer"]').value = '';
  $('[data-in="answer"]').value = '';
  $$('[data-qr]').forEach((n) => { n.textContent = ''; });
  $$('[data-when="answered"]').forEach((n) => { n.hidden = true; });
  $('[data-note="handoff"]').hidden = true;
  setBusy(false);
  setConn(true, '已连接');
  showView('home');
}

/* ── 扫码打开时的深链处理 ─────────────────────────── */

/**
 * 扫二维码会在浏览器里新开一个标签页，而真正持有连接的房主页面在另一个标签页。
 * 这里用 BroadcastChannel 把回应码直接递给那个页面，用户不用手动复制。
 */
const PAIR_CHANNEL = 'rps-pair';
let pairChannel = null;
let pairMode = 'idle';       // 'idle' | 'await-ack'
let pairAcked = false;

function postPair(msg) {
  try { pairChannel && pairChannel.postMessage(msg); } catch { /* 忽略 */ }
}

function onPairMessage(ev) {
  const d = ev.data;
  if (!d) return;

  // 房主页面：收到回应码 → 直接建连并回执
  if (d.t === 'answer' && state.role === 'host' && state.peer && !state.answerApplied) {
    postPair({ t: 'got-answer' });
    $('[data-in="answer"]').value = d.code;
    acceptAnswer();
    return;
  }

  // 扫码打开的新页面：收到回执
  if (d.t === 'got-answer' && pairMode === 'await-ack') pairAcked = true;
}

function initPairChannel() {
  if (!('BroadcastChannel' in window)) return;
  pairChannel = new BroadcastChannel(PAIR_CHANNEL);
  pairChannel.addEventListener('message', onPairMessage);
}

/** 扫到的是「回应码」：交给原来那个创建房间的标签页 */
function handOffAnswer(code) {
  showView('host');
  $('[data-note="handoff"]').hidden = true;
  $('[data-in="answer"]').value = '';

  if (!pairChannel) {                          // 浏览器不支持，退回手动粘贴
    $('[data-in="answer"]').value = code;
    toast('请把这段回应码粘贴到「创建房间」那个页面');
    return;
  }

  pairMode = 'await-ack';
  pairAcked = false;
  let tries = 0;

  const tick = () => {
    if (pairAcked) {
      pairMode = 'idle';
      $('[data-in="answer"]').value = '';
      $('[data-note="handoff"]').hidden = false;
      toast('✓ 已把回应码交给房间页面');
      return;
    }
    if (tries++ >= 8) {
      pairMode = 'idle';
      $('[data-in="answer"]').value = code;
      toast('没找到还在等待的房间页面，请回到那个页面重新扫码');
      return;
    }
    postPair({ t: 'answer', code });
  };

  tick();
  const timer = setInterval(() => {
    tick();
    if (pairMode === 'idle') clearInterval(timer);
  }, 300);
}

async function handleDeepLink() {
  const m = /^#([oa])=(.+)$/.exec(location.hash);
  if (!m) return false;
  const kind = m[1];
  const code = m[2];
  history.replaceState(null, '', location.pathname + location.search);

  if (kind === 'o') {                    // 扫到了房主的连接码
    showView('join');
    $('[data-in="offer"]').value = code;
    await makeAnswer();
  } else {                               // 扫到了加入者的回应码
    handOffAnswer(code);
  }
  return true;
}

/* ── 交互绑定 ─────────────────────────────────────── */

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act],[data-pick]');
  if (!el) return;

  if (el.dataset.pick) { pick(el.dataset.pick); return; }

  switch (el.dataset.act) {
    case 'host':          await startHost(); break;
    case 'join':          showView('join'); break;
    case 'home':          goHome(); break;
    case 'copy':          await copyFrom(el.dataset.copy); break;
    case 'make-answer':   await makeAnswer(); break;
    case 'accept-answer': await acceptAnswer(); break;
  }
});

// 粘贴后按 Ctrl/⌘ + Enter 直接连接，省一次点击
$('[data-in="answer"]').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) acceptAnswer();
});

window.addEventListener('beforeunload', resetPeer);

/* ── 启动 ─────────────────────────────────────────── */

(async function boot() {
  initPairChannel();
  showView('home');
  renderGame();
  await handleDeepLink();

  // https 和 localhost 都是安全上下文，可以直接注册
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
