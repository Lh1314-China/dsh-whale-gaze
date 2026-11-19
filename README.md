# 溯光 · dsh-whale-gaze

给 DeepSeek Harness 一双**常开的、便宜的眼睛**：接摄像头或屏幕上的视频窗口，
在本地看小帧跟动作，让皮套的眼睛跟着转；值得看的瞬间定格成一张照片。
每轮只在思考里加一行「视线」，不把帧烧进上下文。

> Always-on, cheap eyes for DSH. It watches locally, reports one line per turn,
> and never uploads a frame.

## 前提

- **Windows**（插件声明 `os: ["win32"]`）。
- DSH `>=0.2.1-rc.2`，Node `>=20`（见 `dsh.compatibility`）。
- **ffmpeg**：看屏幕/窗口的视频、或想用快照时才需要；留空就用 PATH 上的 `ffmpeg`。
- **VTube Studio**：只有想让皮套眼睛跟着转时才需要；不装也能用其它功能。
- 装完**重启 DSH**。

## 安装

```powershell
# npm
dsh plugin --profile desktop add dsh-whale-gaze

# 或直接装 GitHub 仓库
dsh plugin --profile desktop add github:Lh1314-China/dsh-whale-gaze
```

## 皮套绑定（第一次用必读）

皮套**不打包在插件里**——插件只通过 VTS 的插件 API 驱动你正在用的模型，
所以换皮套不需要改插件，但要让它知道你的模型把「眼睛」叫什么。

1. 打开 VTube Studio，在「设置 → 插件 / API」里允许 API 访问（端口默认 `8001`）。
2. 第一次连接时 VTS 会弹授权框，点允许。
3. 跑一次绑定检测：

   ```powershell
   node scripts/vts-bind.mjs
   ```

   它会连上 VTS、列出你模型里含 `eye` 的参数，并给出可以直接粘贴的配置。
4. 把建议的 `eyeParams` 写进 profile 的 `cordis.patch.yml`（`whale-gaze` 那条的
   `config.vts` 下），然后重启 DSH：

   ```yaml
   vts:
     enabled: true
     port: 8001
     eyeParams:
       x: [ParamEyeBallX]
       y: [ParamEyeBallY]
   ```

5. 用 `eye_see action=status` 确认，应能看到一行：

   ```text
   vts ready eye=ParamEyeBallX/ParamEyeBallY (standard/standard)
   ```

### 让智能体自己识别皮套

不用你手抄参数名——插件在连上 VTS 时会自动问模型要参数表，按这个顺序匹配：

1. 你配置里写的 `eyeParams`
2. 自定义命名（`EyeLeftX` / `EyeRightX` / `EyeLeftY` / `EyeRightY`）
3. VTS 标准命名（`ParamEyeBallX` / `ParamEyeBallY`）

匹配结果会写进 `eye_see action=status` 的 `eye=...` 那一段，**智能体能直接读到**。
如果三组都对不上，状态里会给出「模型里含 eye 的参数」清单，智能体据此告诉你
该填哪两个名字。

### 换皮套

任意 VTS 模型都能用。如果新模型的眼球参数叫别的名字，按上面的清单填进
`eyeParams` 即可；方向反了开 `invertX` / `invertY`，转幅太小调大 `gainX` / `gainY`
（也可以运行时用 `eye_see action=tune` 调）。

## 用法

模型侧只有一个工具 `eye_see`：

| 参数 | 说明 |
|---|---|
| `action` | `status` 概览；`start` / `stop` 管理源；`look` 最新场景；`freeze` 现在存一张；`aim` 手动指向；`tune` 调幅度与偏置 |
| `source` | 源 id：`cam` / `screen` / `window`，或配置里的自定义 id |
| `device` | `action=start` 且是摄像头时用；留空自动挑第一个摄像头 |
| `title` | `action=start` 且 `kind=window` 时用 |
| `kind` | `camera` / `screen` / `window` |

返回的路径只是路径；要看细节由模型自己决定要不要 `read_image`——所以帧不会自动烧 token。

## 隐私与边界

- **不截屏上传、0 出网**：采集与感知都在插件进程里完成。
- 帧只在本机 `dataDir`（默认 `~/.dsh/whale-gaze`）。
- 摄像头常开要你显式打开（`autoStart: false` 是默认值）。
- 皮套一侧只写眼睛参数，不读你的模型或表情。

## 常见问题

| 现象 | 处理 |
|---|---|
| 装了但眼睛不转 | 先 `eye_see action=status` 看 `vts` 那行；没连上就跑 `node scripts/vts-bind.mjs` |
| 提示没有眼睛参数 | 你的模型用了别的名字；从 bind 输出的清单里挑两个填 `eyeParams` |
| 方向反了 | `invertX: true` 或 `invertY: true` |
| 转幅太小 | 调大 `gainX` / `gainY`，或 `eye_see action=tune` 现场试 |
| 摄像头打不开 | 用 `node scripts/vts-bind.mjs` 之外，也可以用 `ffmpeg -list_devices true -f dshow -i dummy` 看设备名，填进 `sources[].device` |

## 许可与声明

- **MIT**，见 [LICENSE](LICENSE)。
- 不捆绑 ffmpeg，也不捆绑任何皮套模型；两者都由使用者自行安装与授权。
- 只读取本机摄像头/屏幕/窗口的像素用于本地运动分析，不上传、不落盘原帧
  （只保留你主动 `freeze` 的那一张）。
