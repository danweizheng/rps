# 石头剪刀布 · 局域网对战

一个**最简版**的石头剪刀布联机游戏。两台设备连同一个 Wi-Fi，
浏览器之间用 WebRTC 点对点直连，**没有后端、没有信令服务器**。
以 PWA 形式实现，可以「添加到主屏幕」，离线也能打开。

线上地址：`https://<你的用户名>.github.io/rps/`

---

## 怎么玩

1. 两台设备都打开同一个网址（都连同一个 Wi-Fi）。
2. 一台点 **创建房间**，另一台点 **加入房间**。
3. 用二维码或复制粘贴，把三个码互相传一次：
   - 房主 → 生成「连接码」→ 给对方
   - 加入者 → 拿连接码生成「回应码」→ 回给房主
   - 房主 → 贴上回应码 → 开打
4. 出拳，比分自动同步。分晓之后任意一方再出拳就是下一局。

> 双方在同一个 Wi-Fi 下，第一次握手完成后就是纯 P2P 直连，
> 出拳数据不经过任何服务器。握手用的那串码只在两台设备之间传递。

**关于「没有服务器」**：本项目不含任何服务端代码，也不依赖信令服务。
代价是首轮握手要手工搬一次 SDP（就是那串连接码），换来的是完全静态托管、
零运维、零成本。

### 二维码怎么用

- **两个手机**：房主显示二维码 → 对方用**系统相机**扫码 → 自动打开并生成回应码 →
  对方显示二维码 → 房主用系统相机扫码 → 自动交回给原来那个标签页。
  （用 `BroadcastChannel` 在标签页之间传递，所以不用手动复制。）
- **手机 + 电脑**：电脑显示二维码给手机扫；手机生成的回应码用微信 / AirDrop 发回电脑复制粘贴。

---

## 项目结构

```
.
├── index.html               # 页面骨架（4 个视图：首页 / 房主 / 加入 / 对战）
├── styles.css               # 样式
├── app.js                   # 界面、游戏状态机、二维码深链配对
├── rtc.js                   # WebRTC 数据通道 + 连接码编解码（deflate + base64url）
├── sw.js                    # Service Worker（离线缓存）
├── manifest.webmanifest     # PWA 清单
├── icons/                   # 应用图标
├── vendor/                  # 第三方库（qr-creator，MIT，见同目录 LICENSE）
└── .nojekyll                # 让 GitHub Pages 原样发布，不走 Jekyll
```

### 实现要点

- **连接码**：SDP 用 `CompressionStream('deflate-raw')` 压缩再 base64url 编码，
  加前缀 `RPS1`。一对完整 offer/answer 各约 700～1200 字符，能塞进一张二维码。
  浏览器不支持压缩流时自动退回不压缩。
- **非 trickle ICE**：等 `iceGatheringState === 'complete'`（最多 4 秒）再编码，
  所以一次交换就能建连，不需要反复传候选地址。
- **判定不靠裁判**：出拳消息带局号 `r`，两端各自用同一套规则判定，结果必然一致。
  谁先出拳就把局号加一，收到更大的局号说明对方开了新局，本地这拳作废。
- **STUN**：配了 `stun.l.google.com` 作兜底，局域网直连本来不需要它。

---

## 本地开发

`navigator.clipboard` 和 Service Worker 需要安全上下文，所以别直接双击 `index.html`，
起个本地服务器：

```bash
# 任选一种
python -m http.server 8080
npx serve -l 8080
```

然后打开 <http://localhost:8080>。想在本机模拟两台设备，
开两个浏览器窗口（或一个普通窗口 + 一个无痕窗口）走一遍完整流程即可。

---

## 部署

GitHub Pages 直接以 **`main` 分支的根目录**作为站点源。仓库根目录有 `.nojekyll`，
所以文件是原样发布的，不会有 Jekyll 处理这一层。推到 `main` 就会自动重新发布：

```bash
git add -A
git commit -m "update"
git push
```

线上地址：`https://<用户名>.github.io/<仓库名>/`，可以在
**Settings → Pages** 里看到。

不用配 CI、不用装依赖、不用构建：所有资源路径都写成相对的（`./`），
所以放在仓库子路径下、或者以后绑自定义域名，代码都不用改。

---

## 兼容性

| 浏览器 | 最低版本 |
| --- | --- |
| Chrome / Edge | 80+ |
| Safari / iOS Safari | 16.4+（`CompressionStream` 的支持下限） |
| Firefox | 113+ |

低于上述版本时压缩不可用，会自动退回未压缩的连接码（更长但一样能用），
只有 Safari 16.4 以下完全不支持 `CompressionStream` 解码。

## 许可

游戏代码随意使用。`vendor/qr-creator.min.js` 来自
[qr-creator](https://github.com/nimiq/qr-creator)（MIT，Copyright © 2017 The Nimiq Foundation），
许可证见 `vendor/qr-creator.LICENSE`。
