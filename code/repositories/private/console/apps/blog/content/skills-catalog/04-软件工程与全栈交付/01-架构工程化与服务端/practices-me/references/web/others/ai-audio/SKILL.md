---
name: ai-audio-me
description: Use this skill for AI audio generation, MP3/TTS/dialogue export, or audio-editing engineering work including 音频编辑、裁剪、去静音、智能分段、波形渲染、长音频处理、长时异步任务、任务状态轮询、WebSocket/轮询状态同步、结果文件校验和音频编辑 CSS 布局避坑。
---

# AI Dialogue Audio Generator

This skill turns a lightweight user idea into a polished male/female dialogue script and a single final MP3. It captures the workflow learned from a real delivery: the user wanted one 1-hour audio file, not hundreds of short segment files. Optimize for the final listener experience and for a clean handoff.

## Core Rule

Deliver one final audio file unless the user explicitly asks for assets.

Intermediate speech clips, silence clips, concat lists, tool installs, and manifests are implementation details. Keep them in a temporary working directory and remove them after the final MP3 passes validation.

## Golden Case

The successful pattern:

1. Clarify only the parameters that block generation.
2. Write or expand the male/female dialogue script first.
3. Use different TTS voices for each speaker.
4. Generate speech clips and silence clips as temporary assets.
5. Concatenate into one MP3.
6. Validate the final MP3 duration with `mutagen`.
7. Delete temporary assets unless the user requests them.
8. Return the final MP3 path and a short verification summary.

For the travel dialogue task, the finished file was:

```text
out/dialogue_1h.mp3
duration: 3600.408 seconds
pause count: 76
pause range: 2 to 100 seconds
voices: zh-CN-YunjianNeural, zh-CN-XiaoxiaoNeural
```

## Failure Case To Avoid

The bad delivery pattern:

1. Leave hundreds of `speech_*.mp3` and `silence_*.mp3` files visible in `out`.
2. Let the user open a 7-second segment and think the whole task failed.
3. Describe the final MP3 path only after the user complains.
4. Make cleanup a separate burden for the user.

Prevent this by defaulting to `--clean-assets` in the bundled script and by placing temporary files under `.tmp-ai-dialogue-audio`.

## When The User Gives A Simple Prompt

If the user says something like "做一个男女对话音频，聊<某个主题>，一个小时，有停顿", do this:

1. Infer reasonable defaults where safe:
   - `language`: Chinese unless the user asks otherwise.
   - `speakers`: one male and one female.
   - `tone`: calm, warm, lightly happy.
   - `format`: MP3.
   - `delivery`: single final file.
2. Ask only when a missing value changes the output materially:
   - exact target duration if they say "long" but no duration.
   - pause interpretation if they give ambiguous numbers.
   - voice provider if online TTS is not allowed.
3. After clarification, proceed through script and audio generation without re-asking.

## Script Quality

Write the script as a real dialogue, not alternating bullet summaries.

Use:

- named speakers.
- short conversational turns.
- natural emotional continuity.
- clear topic progression.
- enough text for the requested spoken content.

For long audio with many silent pauses, the spoken text may be much shorter than the total duration. Make the script satisfying on its own, then use silence to reach the target duration.

Avoid:

- repetitive filler just to stretch length.
- a host monologue disguised as dialogue.
- visible instructions inside the script.
- saying the pause numbers aloud unless the user asks for guided meditation style.

## Audio Workflow

Use the bundled generation script first:

```powershell
python <bundled-generate-script> `
  --topic "<对话主题>" `
  --target-seconds 3600 `
  --pause-count 76 `
  --pause-min 2 `
  --pause-max 100 `
  --output out\dialogue_1h.mp3 `
  --clean-assets
```

The script expects these Python packages:

```text
edge-tts
imageio-ffmpeg
mutagen
```

If they are missing, install them into a workspace temp directory, not into the project dependency graph:

```powershell
New-Item -ItemType Directory -Force -Path .tmp-ai-dialogue-audio-tools | Out-Null
$env:TEMP=(Resolve-Path .tmp-ai-dialogue-audio-tools).Path
$env:TMP=(Resolve-Path .tmp-ai-dialogue-audio-tools).Path
python -m pip install --target .tmp-ai-dialogue-audio-tools edge-tts imageio-ffmpeg mutagen
$env:PYTHONPATH=(Resolve-Path .tmp-ai-dialogue-audio-tools).Path
```

If Windows fails while moving `ffmpeg` across drives, set `TEMP` and `TMP` to a workspace path and retry.

## Duration Strategy

The script computes total speech duration first, then distributes silence to hit the target duration.

Use constrained random pauses:

- never below the requested minimum.
- never above the requested maximum.
- total silence adjusted to match target duration after speech synthesis.
- fixed random seed recorded when reproducibility matters.

If the target cannot fit within the requested pause range, tell the user the exact constraint mismatch and ask which parameter to relax.

## Voice Strategy

Preferred Chinese voices:

- male: `zh-CN-YunjianNeural`
- female: `zh-CN-XiaoxiaoNeural`

Backup Chinese voices:

- male: `zh-CN-YunxiNeural`
- female: `zh-CN-XiaoyiNeural`

If online TTS fails, use local Windows SAPI only after telling the user the tradeoff. Local SAPI may have fewer voices and may not produce a convincing male/female pair.

## Clean Delivery Checklist

Before final response:

1. Confirm the final MP3 exists.
2. Confirm duration with `mutagen`, not by reading a filename.
3. Confirm file size is plausible.
4. Confirm there are no visible `speech_*.mp3` or `silence_*.mp3` assets in the delivery folder.
5. Return only the final MP3 path unless the user asked for script or manifest.

Final response should include:

- final MP3 path.
- duration in seconds and minutes.
- voice pair used.
- pause count and pause range if relevant.
- any failed validation or fallback used.

## Anti-Patterns

Never leave segment files as the apparent output. A folder full of 7-second clips fails the user intent even when the concat file exists.

Never install Python packages into project dependencies for this task. Use a temp target directory.

Never claim "one hour" without checking actual MP3 duration.

Never make the user hunt through asset folders to find the final file.

Never delete unrelated files. Only clean files created for the current audio run.

Never keep regenerating audio after a valid final MP3 exists unless the user asks for a change.

---

# 音频编辑（长时异步任务）

本章节沉淀「音频编辑」子能力的通用工程模式：对一条已有录音做裁剪、去静音、智能分段等处理，配合波形渲染与长时异步任务的状态同步。它和上方"AI 音频生成"是两个独立子能力，输入输出和技术栈完全不同。

## 区分两个子能力

| 子能力 | 输入 | 输出 | 关键技术 |
| --- | --- | --- | --- |
| AI 音频生成（本文件上半部分） | 一句话主题 | 一个 MP3 文件 | edge-tts / ffmpeg / mutagen |
| 音频编辑（本章节） | 一条已有录音 URL | 裁剪/去静音/智能分段后的音频文件 + 波形交互 | Taro + React + Zustand + scss + 后端处理服务 |

后续讲到波形、任务、轮询、mode，全部指音频编辑，不指音频生成。

## 能力边界与分层职责

音频编辑是一个跨端协作的长时异步系统，抽象为三层：`前端 → 业务网关服务 → 音频处理引擎服务`。前端只对接业务网关，禁止直连处理引擎。

| 层 | 职责 |
| --- | --- |
| 前端 | 波形渲染、任务状态机、裁剪/去静音/智能分段入口 |
| 业务网关服务 | 业务任务状态记录、转发处理引擎、接收回调 |
| 音频处理引擎服务 | 真实音频处理：ffprobe/ffmpeg、波形解析、异步任务、容量上报 |

分层边界规则：

- 前端默认访问业务网关暴露的 `/audio-edit/*` 路由；本地可把 API base 覆盖到本地业务网关地址做联调。
- 业务网关向处理引擎派发任务（内部 job 接口），处理引擎处理完后回调业务网关的内部 callback 接口。
- 前端禁直连处理引擎。业务网关的 `waveform` 是前端入口，处理引擎的波形提取入口只对业务网关开放。
- 生产链路与本地自测链路层次一致，本地用 mock 业务网关替换生产网关，减少对处理引擎的直连。

本地联调直传旁路：可通过 URL 参数携带已上传好的音频信息（如音频 URL、存储路径、时长、文件大小、格式）跳过录音 SDK，直接走既有的资源创建/更新接口。此类旁路参数应集中在一个契约文件维护，单位统一（如一律用毫秒），且只用于本地联调和问题复现，不改变真实录音上传流程。

## 页面 Hook 组织

当页面同时承载多个处理入口 + 后端任务状态机 + 播放器 + 拖拽交互时，单文件页面 hook 会超载。改用一个页面聚合 hook + 多个语义化子 hook。

页面聚合 hook 是唯一面向页面组件的层，只暴露最终页面模型（状态 + 事件）；其余子 hook 不被组件直接消费：

| hook 角色 | 职责 |
| --- | --- |
| 运行时 hook | 生命周期、路由解析、音频初始化、波形缓存、任务恢复 |
| 任务 hook | 后端任务状态机（唯一），创建/轮询/恢复/取消/保存 |
| 任务动作 hook | 多入口共用的任务动作封装 |
| 各模式动作 hook（裁剪/去静音/智能分段） | 各处理入口的模式适配与交互 |
| 播放器 / 裁剪拖拽 / 结果播放 hook | 各自局部交互 |

组件层只消费页面聚合 hook 的返回值，不直接调用 service 或读写 store。

## 任务状态机

任务状态机是长时异步处理的核心抽象。前端用页面语义的 `taskId`，后端用自己的 `jobId`（任务记录）。两者在 service 层做映射。

### 后端状态到页面状态映射

后端可能返回多种细粒度状态，前端应归一化为一组稳定的页面状态。示例映射：

| 后端状态 | 页面状态 | 含义 |
| --- | --- | --- |
| `pending` | `pending` | 任务已创建但未真正开始处理 |
| `processing` | `processing` | 任务正在处理 |
| `completed` | `success` | 任务已完成 |
| `confirmed` | `success` | 已确认另存（后端把 completed 推进到 confirmed） |
| `failed` | `failed` | 任务失败 |
| `canceled` | `canceled` | 用户或后端取消 |
| `timeout` | `failed` | 任务超时，前端归一化为 failed |

页面只消费 5 个通用状态：`pending` / `processing` / `success` / `failed` / `canceled`。

### 任务模式（mode）枚举

一个任务接口用 `mode` 区分多种处理能力，各模式差异化参数统一收敛进 `params` 字段，后端据此派发对应处理任务：

| mode | 页面语义 | 入参示例 |
| --- | --- | --- |
| `trim` | 裁剪 | `params.trim.start`、`params.trim.end`（秒级，3 位小数） |
| `remove_silence` | 去静音 | `params.silence` 可选（thresholdDb、minDurationSec） |
| `smart_clip` | 智能分段 | `params.segment` 可选（maxSizeBytes、maxDurationSec） |

### 轮询机制

任务 hook 封装轮询。关键常量示例：

| 常量 | 推荐值 | 用途 |
| --- | --- | --- |
| `POLLING_INTERVAL_MS` | 800 | 后端任务状态轮询间隔 |
| `POLLING_FAILURE_TOAST_MIN_COUNT` | 8 | 连续轮询失败达到该次数后才允许弹 toast |
| `POLLING_FAILURE_TOAST_MIN_DURATION_MS` | 10000 | 与失败次数共同判断，避免短时间连续失败过早打扰用户 |
| `COMPLETION_PROGRESS_BRIDGE_MIN_PERCENT` | 0 | 完成态进度补桥起始阈值 |
| `COMPLETION_PROGRESS_BRIDGE_STEP` | 2 | 补桥每次递增百分比 |
| `COMPLETION_PROGRESS_BRIDGE_INTERVAL` | 80 | 补桥定时器刷新间隔（毫秒） |

轮询行为要点：

- 创建任务后 `startPolling` 用 `setInterval(refreshTask, 800)` 启动，并立即先 `refreshTask()` 一次。
- 成功拿到 `pending`/`processing` 时只更新任务状态，继续轮询；拿到终态（success/failed/canceled）时 `clearPolling` 停轮询并清持久化任务 ID。
- 失败次数累计到达门槛会弹一次 toast，但**不停止轮询、不清任务**，保留恢复能力，避免单次网络抖动误判任务失败。
- 完成态进度补桥：后端从 processing 直接跳到 success 时，若上一次 processing 进度未到 100，用 `COMPLETION_PROGRESS_BRIDGE_STEP=2` 每 80ms 递增到 100 再切完成态，消除视觉跳变。
- 任务恢复：页面重新进入时读持久化存储（如 `Taro.getStorageSync`），若存在前缀匹配的任务 ID 且当前无轮询，就继续查询后端状态。

### 去静音 no-op 分支

`remove_silence` 完成但 `removedDuration <= 0` 或 `noSilenceDetected=true` 时，进入"未检测到可去除的静音片段"空态，不进入成功保存流程。工具函数可判定此类特殊完成态。

## 波形渲染

波形用 **View div 柱状**渲染，不用 canvas。公共渲染器做成可复用组件：

- 每根柱子是一个 `<View className={barClassName} style={{ height: '${height}px' }} />`。
- 柱宽、柱间距定义在常量文件，例如柱宽 `3`、柱间距 `4`。
- 归一化：`normalizeWavePeak(peak, maxPeak) = Math.min(1, peak / max(0.01, maxPeak))`，再用 `minHeight + normalizedPeak * (maxHeight - minHeight)` 算实际高度。低振幅音频柱也有最小高度（如 `14px`）兜底，避免完全不可见。
- 空数据占位：无可见波形时渲染固定数量（如 96）根骨架柱，高度固定（如 `4px`），不坍塌。

主波形双层结构：

| 层 | className | 作用 |
| --- | --- | --- |
| 未播放层 | `.remainingWaveLayer` + `.remainingBar` | 渲染完整波形，灰色 |
| 已播放层 | `.playedWaveLayer` + `.playedBar` | `width` 跟随播放进度动态扩展，品牌色；`hasPlayedProgress`（currentTime>0 或 progress>0）为 false 时不渲染，避免空宽度遮挡 |
| 裁剪选区层 | `.manualSelectedWaveLayer` | 手动裁剪态，按 trimRange 的 start/end 百分比定位，`translateX(-start%)` 反向偏移让选区内波形对齐 |

入口态用居中线模式：播放头固定在视口中央（如 `50%` 位置），波形和时间刻度通过 `contentLeft`/`contentWidth` 相对平移。手动裁剪态用百分比游标（`cursorLeft` 跟进度走）。

拖动换算：`pixelsPerSecond = VIEWPORT_WIDTH / windowSeconds`，拖动时音频时间随手势前进或后退。轻触阈值（如 `4px`），避免点击误触发 seek。

波形形态用统一入口组件按 `variant` 分发，不每种形态新建平级组件：

| variant | 分发目标 | 用途 |
| --- | --- | --- |
| `progress` | 进度波形组件 | 常规播放底部进度条，触摸 seek |
| `editableTrim` | 时间轴波形组件 | 手动裁剪时间轴，左/右把手 + 整段选区拖动 |
| `resultPreview` | 时间轴波形组件 | 处理中/完成态结果预览，含静音片段标记 |
| `sheetPreview` | 弹窗预览波形组件 | 弹窗只读轻量预览 |

四种形态共用柱状渲染组件做 peaks 归一化与柱高换算，避免重复实现。新增波形形态优先扩 `variant`，不新建平级组件。

## waveformCache

Zustand store 维护 `waveformCache`，按 `cacheKey` 缓存波形数据：

| 字段 | 用途 |
| --- | --- |
| `waveformCache` | 跨页面运行时重置保留，避免多处理入口切换时重复请求波形接口 |
| `getCachedWaveform(cacheKey)` | 命中直接返回缓存波形 |
| `cacheWaveform(cacheKey, waveform)` | 写入缓存 |
| `setWaveform` | 同时更新 `waveform` 和 `silenceRanges` |

`cacheKey` 当前优先由 `audioId + points` 组合。缺少 `audioId` 时才回退历史 ID、源 URL。首屏波形默认 512 个采样点（`DEFAULT_WAVEFORM_POINTS = 512`），缩略波形 64 个采样点（`THUMB_WAVEFORM_POINTS = 64`）。

## H5 还原两期

UI 还原分两期推进，两期都不用 `px2vw750()` 承载结构宽度。

| 期 | 状态 | 布局口径 |
| --- | --- | --- |
| 期一 | 已提交 | 750px 设计稿 + top/left 绝对定位（pxtransform 转 rpx/rem），固定宽度 |
| 期二 | 规划/推进中 | `left/right + width: auto + 100vw + flex`，响应式铺满当前 WebView |

期二当前统一口径：

| 场景 | 当前口径 | 避免写法 |
| --- | --- | --- |
| 页面根容器 | `width: 100vw` | `width: 750px` |
| 主波形和大区域 | 父容器宽度或 `width: 100%` | 固定 750 设计稿宽度 |
| 播放进度条 | flex 行布局 | 绝对定位整条再写死 left |
| 手动裁剪底部轨道 | `left/right: 40px; width: auto` | `calc(100vw - px2vw750(...))` |
| 居中元素 | flex 居中，或 `left: 50%` + `transform: translateX(-50%)` | `left: 302px`/`left: 315px` 这类设计稿内部坐标 |
| 固定尺寸（图标/按钮/圆环/旋钮/把手/触摸热区） | 继续保留静态 px | 套进 `px2vw750(...)` |

### 百分百布局和盒子模型铁律

音频编辑页面的样式问题反复集中在主波形、底部进度条、手动裁剪轨道、处理中态和完成态。写 CSS 前先把页面拆成稳定盒子，再写百分比。

| 规则 | 正确口径 | 典型风险 |
| --- | --- | --- |
| 全链路盒模型 | 页面根、状态容器、波形外壳、底部操作区统一 `box-sizing: border-box` | `width: 100%` 加 padding 后横向溢出 |
| 百分百宽度 | 主内容外层 `width: 100%`，内部用 `max-width` 或左右 padding 控制视觉宽度 | 固定 750px 导致平板和横屏错位 |
| 百分比高度 | 只有父链路有确定高度时才写 `height: 100%` | 父级 auto height 时子元素百分比无效 |
| Flex 压缩 | 可压缩区块显式 `min-height: 0`、`overflow: hidden` | 子元素默认最小高度把底部按钮挤出屏幕 |
| 固定控件 | 按钮、把手、圆环、触摸热区保留静态 px 和最小尺寸 | 把控件也按百分比缩放会不可点 |
| 波形定位 | 播放进度和 trim 区间用业务比例算百分比 | 用设计稿 left/top 硬套会导致红线越界和抖动 |
| 同类状态扫描 | 首页播放态、手动裁剪态、处理中态、去静音态、智能分段完成态一起扫 | 修好一个状态后污染另一个状态 |

写法优先级：

1. 页面结构先用文档流和 flex 盒子承接，绝对定位只用于播放头、选区遮罩、浮层这类局部覆盖。
2. `width: 100%` 与 padding 同时出现时必须确认 `box-sizing: border-box`。
3. 避免大量小数百分比表达高度压缩；高度适配优先用 `flex: grow shrink basis` 和清晰整数基准。
4. 低版本 Android WebView 的核心布局不要依赖 `gap`、`inset` 和未兜底的 CSS 变量。
5. 改样式后优先跑响应式布局与波形相关的契约测试，再做真机人工验收。

## Contract test

契约测试用 `node:assert/strict` + `fs.readFileSync` 静态扫源码字符串/正则，不启动运行时。用 `.cjs` 后缀，若默认忽略 `*.test.cjs`，需要版本化时调整提交策略。

### 设计稿契约

以设计工具（如 Figma）导出的设计数据（节点 JSON + manifest）为数据源，逐页面状态建立设计稿契约。契约测试直接读设计 JSON，用相对画板坐标做断言：

```js
const root = readJson(...manifestPath).node.document;
const rootBox = root.absoluteBoundingBox;
const relativeBox = node => ({
  x: Math.round(node.absoluteBoundingBox.x - rootBox.x),
  y: Math.round(node.absoluteBoundingBox.y - rootBox.y)
});
```

精度规则：画板宽高必须完全等于设计稿基准尺寸，整数坐标完全匹配，小数 `Math.round` 后匹配，字号/字重/行高来自 `node.style`，颜色来自 `node.fills`（透明度一起断言）。波形小柱不逐个手写，从设计节点集合或本地 waveform 常量生成后做数量/容器/颜色/边界断言。

每个页面状态（如初始播放、智能分段提示、处理中、去静音提示、未检测到静音、完成态、已播放）都映射到一个设计稿节点，契约测试逐一锁定其坐标与样式。

## 关键常量速查

波形几何常量（集中在波形常量文件）：

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `DEFAULT_WAVEFORM_POINTS` | 512 | 首屏波形采样点数 |
| `THUMB_WAVEFORM_POINTS` | 64 | 缩略波形采样点数 |
| `MAIN_WAVEFORM_BAR_WIDTH` | 3 | 单根柱宽（px） |
| `MAIN_WAVEFORM_BAR_GAP` | 4 | 相邻柱间距（px） |
| `MAIN_WAVEFORM_VIEWPORT_WIDTH` | 750 | 设计稿视口宽度 |
| `MAIN_WAVEFORM_CENTER_CURSOR_PERCENT` | 50 | 居中线位置百分比 |
| `MAIN_WAVEFORM_HEIGHT` | 540 | 常规主波形最大柱高 |
| `MAIN_WAVEFORM_MIN_BAR_HEIGHT` | 14 | 最小柱高兜底 |
| `COMPACT_MAIN_WAVEFORM_HEIGHT` | 440 | 手动裁剪 compact 柱高 |
| `TIMELINE_SIDE_RAIL_WIDTH` | 40 | 结果波形条蓝把手宽度（统一 40px） |
| `TIMELINE_INNER_WIDTH` | 590/598 | 结果波形条内部有效宽度 |
| `TIMELINE_TRIM_LEFT_INSET` / `TIMELINE_TRIM_RIGHT_INSET` | 40 / 40 | 手动裁剪条左右内边距（已统一 40px） |

请求常量：

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `AUDIO_EDIT_API_BASE` 默认值 | 业务网关的 `/audio-edit` 路径 | H5 同源代理或生产网关路径 |
| `AUDIO_EDIT_API_BASE` 联调覆盖 | 本地业务网关地址 | 本地 mock 网关调试 |
| `AUDIO_EDIT_REQUEST_TIMEOUT` | 15000 | 通用请求超时（毫秒） |
| `AUDIO_EDIT_WAVEFORM_REQUEST_TIMEOUT` | 600000 | 波形接口超时（长音频缓存生成需更久） |
| `AUDIO_EDIT_WAVEFORM_POLL_INTERVAL` | 3000 | 波形 queued/running 轮询间隔 |
| 请求头 | `content-type: application/json`，按需追加隧道跳过警告头 | 通过隧道代理调试时可能需要额外跳过头 |

品牌 token 集中在 scss token 文件（品牌色、根背景、蒙层背景等）。contract test 优先锁 token，避免把硬编码色值 + 固定 top/left 当主断言。

## 前端访问接口清单

前端只调业务网关暴露的 `/audio-edit/*` 路由，本地由 mock 网关提供同名路由，核心 5 条：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/waveform` | 获取波形（duration/points/peaks） |
| POST | `/tasks/add` | 创建任务（trim/remove_silence/smart_clip） |
| GET | `/tasks/detail?jobId=` | 查询任务详情（轮询） |
| GET | `/tasks/cancel?jobId=` | 取消任务 |
| GET | `/tasks/confirm?jobId=&targetName=` | 确认另存（completed→confirmed） |

返回体统一要求 `{ code: 0, data, msg }`，service 层统一校验 `code === 0`，否则抛统一请求错误（带 method/path/statusCode/responseMsg）。

处理引擎的内部接口（如 `/api/audio-edit/*`、内部 callback）只对业务网关开放，不作为前端主契约。

## 反复出现的重复问题

长时音频异步系统里，重复 Bug 通常集中在这些区域：

| 区域 | 反复修复信号 | 下次开发先查 |
| --- | --- | --- |
| 智能分段与产物切段 | 长音频超阈值分段回归、以成品音频时长回填结果 | 任务执行器、切段策略、feature flag、最终 ffprobe 产物时长 |
| 任务状态和回调 | 终态被进度覆盖、回调状态回退、回调补偿队列、任务停滞检测 | 网关侧任务存储、引擎侧 callback outbox、progress 单调保护、terminal 状态保护 |
| 波形和任务恢复 | 波形 GET 后台生成状态、波形缓存主键、跨设备恢复任务详情 | `audioId + points` 缓存键、queued/running 轮询、按 jobId/audioId 查详情 |
| 结果文件字段 | 补齐结果文件时长元数据、以媒体信息校准结果时长、收敛异步结果输出路径命名 | `result.files[].url/storageKey/duration/size/name/published`，相对 URL 必须拼引擎 baseUrl |
| 前端布局和交互 | 主波形高度和时间刻度布局、平板主波形渲染宽度错位、手动裁剪红线越界回跳 | 百分百盒子模型、波形比例换算、时间刻度和手动裁剪轨道同源 |

### 切段策略避坑口径

复杂音频处理常见「多层分段」逻辑，容易踩坑，通用口径：

1. 切段策略只改变产物生成方式，不改变静音判定参数。静音判定仍来自 `silencedetect` 的 `thresholdDb` 和 `minDurationSec`。
2. 产品分段、计算分块、切段拼接是三层独立逻辑：产品分段决定前端看到几个「音频 1、音频 2」；计算分块是处理引擎内部提速；切段拼接是 chunk 内非静音片段 concat 策略。三者要分别验收，不能用一个长音频结果时长覆盖全部判断。
3. 切段拼接类优化默认关闭，通过显式 feature flag 开启。
4. 漂移容忍度（百分比 + 秒级绝对值）用配置项控制；实验样本得出的复测建议值不要直接写成默认值。
5. 高密度静音场景常有片段数门槛，超过后回退到滤镜方案（如 `silenceremove_filter`）。业务若要求严格按检测区间删除，需单独评估该门槛。
6. `removedDuration` 不能只信静音检测预估删除量，完成态应以最终发布文件 ffprobe 时长回填。
7. 预估产品段数为 1 时仍要对最终单文件做 ffprobe 兜底；真实产物超过阈值时长必须再走后置 `ffmpeg segment`。

## 排查与踩坑

### 异步任务失败（WORKER_RESTARTED）

去静音/智能分段中途失败，根因常是处理引擎 worker 在任务未完成时重启，快照中未完成任务被恢复为 `failed`（错误码如 `NODE_WORKER_RESTARTED`），回调业务网关后前端轮询到 failed 弹 toast。排查路径：

```powershell
rg "WORKER_RESTARTED|task.detail.sync_failed|callback.received|status=failed" <业务网关日志目录>
rg "WORKER_RESTARTED|job.recoveredFailed|callback sent|status=failed" <处理引擎日志目录>
```

前端已把 `errorCode`/`errorMsg` 映射进任务状态，failed 时输出到 console，用户 toast 走统一文案。本地联调避免对处理引擎用 watch 模式（监听日志/临时目录/结果目录会触发 worker 重启）。

### 结果文件播放失败

处理引擎本地存储返回相对路径（如 `/audio-edit/results/...`），小程序播放器需要完整 URL。service 层的 `normalizeResultUrl` 把相对路径拼上 `workerBaseUrl`，无 baseUrl 时返回空串触发加载失败提示，避免把 key/相对路径直接交给播放器。

### H5 增量构建不生效

改常量或 CSS Module 后 H5 增量构建未生效时，先硬重启 dev 命令再验证。webpack-dev-server WS RSV1 崩溃需单独排查。

### import 排序与格式化

若某模块 VSCode 无法格式化、import 排序异常，需单独排查，不为 UI 还原扩大修复范围。

### 部署与联调

- 处理引擎部署可用 PM2 守护。
- 内网穿透联调时，隧道地址需加跳过浏览器警告头。

## 验证命令

契约测试（按需选跑）：

```powershell
node <模块目录>\test\responsiveLayout.contract.test.cjs
node <模块目录>\test\playbackControls.contract.test.cjs
node <模块目录>\test\trimInteraction.test.cjs
node <模块目录>\test\removeSilenceFlow.contract.test.cjs
node <模块目录>\test\loading.contract.test.cjs
node <模块目录>\test\mainWaveform.contract.test.cjs
node <模块目录>\test\timelineWaveform.contract.test.cjs
node <模块目录>\test\taskPolling.contract.test.cjs
node <模块目录>\test\activeTaskScope.contract.test.cjs
node <模块目录>\test\entry-context.contract.test.cjs
```

样式与 TS 改动后：

```powershell
.\node_modules\.bin\prettier.cmd --write <changed files>
.\node_modules\.bin\stylelint.cmd --fix <changed scss files>
.\node_modules\.bin\eslint.cmd --fix <changed tsx files>
```

服务健康检查：

```powershell
Invoke-RestMethod -Uri <业务网关地址>/tasks/detail?jobId=<jobId> -Method GET
Invoke-RestMethod -Uri <处理引擎地址>/capacity -Method GET
```

## 自检清单

修改音频编辑模块前先核对：

1. 改波形几何：同步波形常量文件和对应 scss 高度，避免柱高/容器不匹配。
2. 改任务状态：检查后端状态到页面状态映射和任务 hook 轮询分支是否覆盖新状态。
3. 改横向布局：按"同类状态扫描清单"同时检查首页播放态/手动裁剪态/处理中态/去静音态/智能分段态，不能只改当前投诉的一个组件。
4. 改接口：前端只动业务网关的 `/audio-edit/*` 核心接口，不要新增对处理引擎的直连。
5. 改设计稿还原：先让 contract test 失败指向设计稿数值差异，再改组件，不扩大到无关弹窗或任务状态模块。
6. 改把手宽度：全模块统一一个常量（如 40px 的 `TIMELINE_SIDE_RAIL_WIDTH`、`TIMELINE_TRIM_LEFT_INSET`、`TIMELINE_TRIM_RIGHT_INSET`），把手不对称时先核对这几个常量。
