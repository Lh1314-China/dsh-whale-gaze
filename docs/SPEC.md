# dsh-whale-gaze · 插件规格（描述词）

> 给 DeepSeek 写代码用的「基地」。这份文件本身就是插件的一部分（docs/SPEC.md）。
> 目标版本 v0.1.0，Host-only 插件，无新 npm 依赖，Windows。

## 1. 一句话

给 DSH 一双**常开的、便宜的眼睛**：接摄像头或屏幕上的视频页面，平时只在本地做
低分辨率运动/物体感知（不进模型上下文），眼睛（皮套）跟着画面里值得看的东西转；遇到值得
注意的瞬间就**定格**成一张照片，压成一行字进下一轮思考，需要细节时再 `read_image`。

## 2. 三档开销（这是整个设计的核心）

| 档 | 什么时候 | 代价 |
| --- | --- | --- |
| L0 看 | 常开，8fps，64×36 小帧，本地算 | 0 token |
| L1 记 | 每轮 prompt 注入一行 `视线：…` | ≈ 20-40 token |
| L2 定格 | 兴趣分过线 / 模型主动 `freeze` | 一张图（按需 read_image） |

**绝不**把原始帧送进上下文。

## 3. 文件结构

```
plugins/dsh-whale-gaze/
  package.json          # dsh.bundle.patch → cordis.patch.yml
  cordis.patch.yml      # insert 一行 whale-gaze
  index.js              # apply(ctx, config)：装配、定时器、工具、prompt context
  lib/frames.js         # ffmpeg 采集：小帧 rgb24 流 + latest.jpg
  lib/sense.js          # 小帧 → tick（运动/质心/亮度/肤色/兴趣分）
  lib/gate.js           # 兴趣闸门 + 定格落盘（inbox 轮转）
  lib/vts.js            # VTube Studio 最小 WebSocket 客户端 + 眼参数注入
  lib/tools.js          # eye_see 工具定义
  locale/zh.json, en.json
  icon.svg
  README.md
  docs/SPEC.md          # 本文件
  docs/DETAIL.md        # 插件详情页（给插件市场看）
  scripts/selftest-sense.mjs   # 纯函数自测
  scripts/selftest-frames.mjs  # 真摄像头冒烟（可选，需要相机）
```

## 4. 采集（已实测可用，不要改结构）

每个源一个 ffmpeg 子进程，**双输出**：小帧走 stdout，快照写同一个 latest.jpg（1fps 覆盖）。

```
ffmpeg -hide_banner -loglevel warning
  -f dshow -rtbufsize 64M -i "video=<DEVICE>"
  -filter_complex "[0:v]split=2[a][b];[a]fps=8,scale=64:36,format=rgb24[g];[b]fps=1,scale=960:-2[q]"
  -map "[g]" -f rawvideo -pix_fmt rgb24 pipe:1
  -map "[q]" -q:v 3 -f image2 -update 1 -y "<data>/live/<id>/latest.jpg"
```

- 屏幕源：把 `-f dshow -rtbufsize 64M -i "video=..."` 换成 `-f gdigrab -framerate 8 -i desktop`。
- 窗口源：`-f gdigrab -framerate 8 -i title=<窗口标题>`。
- 裁剪（可选）：在 filter 开头加 `crop=w:h:x:y,`。
- 小帧尺寸固定 64×36，一帧 6912 字节（64*36*3）。stdout 是字节流，必须按 6912 切帧，缓存
  不完整的尾巴。
- **坑**：a) 摄像头独占，上一个 ffmpeg 没死，下一个会拿不到帧（表现为 stdout 全空）——
  启动前必须先确认旧进程已退出；b) `child.kill()` 后要等 close 事件；c) 进程退出/报错时
  `status()` 要能带回 stderr 尾巴（最多 300 字）；d) Windows 路径含空格要原样传参数数组，
  不要拼字符串。

### lib/frames.js 接口（子代理 A 实现）

```js
export function createSource(options) // 返回 source 对象，见下
```

options：
- `id: string` — 源 id（`cam` / `screen` / `window`）
- `kind: 'camera' | 'screen' | 'window'`
- `device?: string` — 摄像头名，默认 `FHD Camera`
- `title?: string` — 窗口标题（kind=window 时必填）
- `fps?: number` — 默认 8
- `width/height?` — 小帧尺寸，默认 64/36
- `snapshotWidth?: number` — 默认 960
- `crop?: {w,h,x,y}` — 可选裁剪
- `ffmpegPath: string`
- `dataDir: string` — latest.jpg 写到 `<dataDir>/live/<id>/latest.jpg`
- `onFrame(rgb: Buffer, ts: number)` — 每小帧回调（同步、必须快）
- `logger?: (level, msg) => void`

source 对象：
- `async start()` — 起进程；等到第一帧或 3s 超时（超时抛错，带 stderr 尾巴）
- `async stop()` — kill 并等 close，清 timer
- `status()` — `{ id, kind, running, pid, fps, frames, lastFrameAt, error, latestJpeg }`
- `latestJpeg()` — latest.jpg 的绝对路径（可能还不存在）
- `subscribers` 不需要。

## 5. 感知（子代理 B 实现）

```js
export function createAnalyzer({ width = 64, height = 36 } = {})
```

- `push(rgb: Buffer, ts: number): Tick`
- Tick 字段：

```ts
{
  ts: number,
  w: number, h: number,
  frames: number,          // 累计帧数
  motion: number,          // 0..1，与上一帧差异像素占比
  centroid: [number, number], // 0..1 归一化，运动质心
  bbox: [number, number, number, number], // 0..1 归一化 x,y,w,h
  brightness: number,      // 0..1
  contrast: number,        // 0..1
  skin: number,            // 0..1 肤色像素占比（YCbCr 粗判）
  scene: boolean,          // 首帧或整体变化很大
  score: number            // 0..100 兴趣分
}
```

算法（保持简单，纯函数、可测）：
1. 亮度 `Y = 0.299R+0.587G+0.114B`；与上一帧逐像素绝对差，`>12` 记运动；
   运动占比 `motion`，质心按差值加权，bbox 取运动像素包围盒（都归一化）。
2. `contrast` = 亮度标准差 / 128，裁剪到 0..1。
3. 肤色：YCbCr 空间 `77<=Cb<=127 && 133<=Cr<=173 && Y>40`，占比 `skin`。
4. 场景切换：`meanAbsDiff > 38` 或首帧。
5. 兴趣分：`score = clamp(100 * (0.55*motion + 0.25*min(1, motionArea*4) + 0.20*skinBoost))`，
   其中 `skinBoost = skin>0.06 ? min(1, skin*6) : 0`；场景切换 +15（上限 100）；
   亮度 <0.06 时整体 ×0.4（太黑没什么可看）。
6. 必须处理 `frames===0`（scene=true，score=0，centroid 中心）。

`lib/gate.js`（同一子代理）：

```js
export function createGate(options)  // options: { threshold=55, cooldownMs=6000, minArea=0.02 }
// .evaluate(tick) → { fire: boolean, reason: string|null }
export function freeze({ latestJpeg, dataDir, sourceId, tick, keep=200 }) // → { ok, path, bytes, ts } | { ok:false, error }
```

- `evaluate`：`score >= threshold` 且 `motion >= 0.01` 且距上次 fire 超过 cooldown 且
  `bbox 面积 >= minArea`；连续触发时 reason 写清（如 `motion 34% @ 右中`）。
- `freeze`：把 latest.jpg 复制到 `<dataDir>/inbox/<yyyymmdd-hhmmss>-<sourceId>.jpg`；
  inbox 超过 keep 张时删最旧的（按文件名排序）；返回新路径。latest.jpg 不存在或 0 字节
  时返回 `{ok:false,error}`，不要抛。

自测 `scripts/selftest-sense.mjs`：用合成帧（全黑 / 全白 / 左半边一个方块移动）断言
motion、centroid 方向、scene 首帧、score 单调性；`node scripts/selftest-sense.mjs` 打印 PASS/FAIL，
失败退出码非 0。

## 6. 眼神跟随（子代理 C 实现）

```js
export function createVtsSink({ port = 8001, pluginName = 'dsh-whale-gaze', logger })
```

- `async connect()` — 最小 WebSocket 客户端（**不能用 ws 依赖**），到 `ws://127.0.0.1:<port>`：
  1. `AuthenticationTokenRequest`（`apiName:"VTubeStudioPublicAPI"`, `apiVersion:"1.0"`,
     `messageType`, `requestID`, `data:{pluginName,pluginDeveloper,pluginIcon:null}`）
  2. 收到 `AuthenticationTokenResponse.data.authenticationToken`
  3. `AuthenticationRequest` 带 token；`data.authenticated === true` 才算 ready
- `inject(gx, gy)` — gx/gy ∈ [-1,1]（右/上为正），节流到 ≤20Hz，发
  `InjectParameterDataRequest`：`{faceFound:true, mode:'set', parameterValues:[
  {id:'EyeLeftX',value:0.5+gx*0.35},{id:'EyeRightX',value:0.5+gx*0.35},
  {id:'EyeLeftY',value:0.5+gy*0.30},{id:'EyeRightY',value:0.5+gy*0.30}]}`
  （Y 轴先按 VTS 约定「上=大」处理，配置里留 invertY 开关）
- `status()` — `{ connected, authorized, lastError, sent, lastSentAt }`
- `dispose()` — 关 socket，取消重连
- 断线后 5s 重试，退避到 60s；**任何失败都不能把异常抛进主循环**。
- 另提供 `createFileSink(dir)`：把 `{gx,gy,ts}` 写 `<dir>/gaze.json`（覆盖写），给其它皮套读。

自测：`node --check lib/vts.js`；没有 VTS 时 `status()` 必须返回 `connected:false`。

## 7. 插件外壳（我自己写，供参考）

```js
export const name = 'whale-gaze';
export const inject = ['tools', 'systemPrompt'];
export function apply(ctx, config) { ctx.effect(() => { ...; return cleanup; }, 'whale-gaze'); }
```

工具 `eye_see`（单工具多动作，省 token）：

| action | 参数 | 作用 |
| --- | --- | --- |
| `status` | — | 源、帧数、最新 tick、inbox 数、VTS 状态 |
| `start` | `source?`(`cam`/`screen`/`window`), `device?`, `title?` | 起一个源 |
| `stop` | `source?` | 停一个源（不带则全停） |
| `look` | `source?`, `freeze?` | 返回一行场景 + 可选的定格图路径（用 read_image 看） |
| `freeze` | `source?`, `note?` | 立刻定格一张，返回路径 |
| `aim` | `x?`, `y?`, `on?` | 手动瞄准（不开源也能让眼睛看某处），或 `on:false` 放手 |

返回一律 `{ text: string }`（output.schema 里只有 `text`），render 成一段 text。
`status` 用紧凑多行，最多 12 行。

## 8. 思考注入

```js
ctx.systemPrompt.context({
  name: 'whale-gaze',
  order: 900,
  text: () => line, // 没有源在跑返回 ''（空串不注入）
});
```

一行格式（≤ 90 字符，中文）：

```
视线：cam 8fps｜动 34% 偏右中｜屏幕 静止｜刚定格 18:42:07（cam）
```

- 只在有源运行时返回非空。
- 定格后 60s 内附「刚定格 HH:MM:SS」，并提示 `read_image <path>`？——**不要**在上下文里
  放路径（太长）；路径只在 `eye_see look` 的返回里给。

## 9. 配置

```yaml
- id: whale-gaze
  name: dsh-whale-gaze
  config:
    ffmpegPath: ''          # 空 = PATH 上的 ffmpeg
    dataDir: ''             # 空 = ~/.dsh/whale-gaze
    autoStart: false          # 摄像头常开必须由使用者显式打开
    sources:
      - id: cam
        kind: camera
        device: 'FHD Camera'
        fps: 8
    threshold: 55
    cooldownMs: 6000
    keep: 200
    promptLine: true
    vts:
      enabled: true
      port: 8001
```

## 10. 验收

1. `node --check index.js lib/*.js` 全过。
2. `node scripts/selftest-sense.mjs` PASS。
3. 真机：`eye_see action=start` 后 5s 内 `status` 里 frames > 0；`freeze` 产出的 jpg
   能被 `read_image` 打开。
4. 停源后 `Get-Process ffmpeg` 里没有残留（相机独占）。
5. 没有 VTS 时工具不报错，`status` 里写 `vts: unconnected`。

## 11. 不做（v0.1）

- 不做 ONNX 物体检测（留 `detector` 钩子，v0.2 接 yolov8n）。
- 不做 DSH 前端面板（v0.2 做摄像头预览 + 眼神调试）。
- 不做多路窗口同时抓（先一路）。
