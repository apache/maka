---
doc_id: computer-use-cursor-provenance
title: "Computer Use 光标来源与独立替换"
language: zh-CN
source_language: en
counterpart: ./computer-use-cursor-provenance.md
implementation_status: current
document_status: current
translation_status: synced
last_verified: 2026-09-11
owners:
  - maka-backend
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Computer Use 光标来源与独立替换

[English](./computer-use-cursor-provenance.md)

本文记录 Maka agent 光标覆盖层的精确来源边界，以及为 Apache Maka issue #3293
完成的独立替换。该历史记录更正了 pull request #2676 的首个修订版，同时并未把整个
Computer Use 实现归类为源自所检查的二进制文件。

## 当前状态

当前光标不再保留后文所述专有二进制中转录的字形几何、热点位置、运动数值、
close-enough 阈值、路径度量常量、核心评分或终端朝向行为。这些输入仅属于历史。

该替换在贡献者检查其所替换的数值之前就已推导完成。完整的公开推导记录见：

https://github.com/apache/maka/issues/3293#issuecomment-5371901326

该推导使用了四项 Maka 产品需求：

1. 在任意应用内容之上，保持 agent 光标在 1x 下清晰可辨；
2. 在原生 click dispatch 被释放之前，让动作热点就位；
3. 长距离移动时优先选择最直的可行路径；以及
4. 让位置与朝向在收敛时没有可见过冲。

## 独立替换值

### 字形与动作热点

替换结果是一个绘制在归一化单位正方形内的圆角镖形。它的尖端既是路径起点，
也是动作热点。`CursorEngine.pos` 仍是唯一的动作坐标，渲染在绘制尖端之前会把该坐标
直接平移至画布局部的 `(0, 0)`。

- `size = 20` CSS px；
- `shadowBlur = 3` CSS px；
- 尖端到绘制边缘的最大允许量，以及 `boundsMargin = 20 + 3 = 23` CSS px；
- 起点 `(0.00, 0.00)`；
- 三次曲线控制点 `(0.03, 0.23)`、`(0.11, 0.51)`，终点 `(0.20, 0.83)`；
- 直线 `(0.43, 0.63)`；
- 三次曲线控制点 `(0.49, 0.57)`、`(0.57, 0.60)`，终点 `(0.63, 0.69)`；
- 直线 `(0.80, 1.00)`；
- 直线 `(1.00, 0.89)`；
- 三次曲线控制点 `(0.86, 0.63)`、`(0.69, 0.40)`，终点 `(0.00, 0.00)`。

`CURSOR_GLYPH` 保留其公开的元组形状：每条曲线先存端点，随后是两个控制点。
PiP SVG 使用同一条路径，并具有相同的局部原点热点。状态项 PNG 由该几何确定性地
栅格化生成，使用 Maka 既有的蓝色渐变与透明背景。可在仓库根目录用
`node scripts/generate-cu-status-icons.mjs` 重新生成。

### 运动配置

`CURSOR_MOTION` 保留 30 个字段的配置形状。其当前取值与独立依据如下：

| 字段 | 替换值 | 推导依据 |
| --- | ---: | --- |
| `clickAngle` | `-π/4` | 规范的对角静止方向 |
| `candidateCount` | `9` | 奇数对称网格，且保证存在零弧候选 |
| `boundsMargin` | `23` | 字形尺寸加阴影余量 |
| `startHandle` | `1/3` | 规范的直线三次曲线控制柄 |
| `endpointHandle` | `1/3` | 到达端采用相同构造 |
| `arcSize` | `0.30` | 用于避让的候选，但不鼓励大范围桌面扫掠 |
| `arcFlow` | `0.50` | 对称的垂直位移 |
| `straightPathDistanceThreshold` | `60` | 三个字形宽度 |
| `springResponseScaler` | `1/2400 s/px` | 按距离缩放的响应，单位为秒每像素 |
| `springResponseMin` | `0.18 s` | 响应下界 |
| `springResponseMax` | `0.72 s` | 响应上界 |
| `springDampingFraction` | `1.0` | 临界阻尼；无位置过冲 |
| `scootDistanceThreshold` | `60 px` | 三个字形宽度 |
| `scootPositionResponse` | `0.16 s` | 形变跟随主运动 |
| `scootPositionDampingFraction` | `1.0` | 无位置回弹 |
| `scootPositionSettleVelocity` | `2 px/s` | 每秒为字形尺寸的十分之一 |
| `scootAxisResponse` | `0.12 s` | 轴的响应快于位置响应 |
| `scootAxisDampingFraction` | `1.0` | 无轴过冲 |
| `scootBaseRotationResponse` | `0.18 s` | 与最短的主响应一致 |
| `scootBaseRotationDampingFraction` | `1.0` | 无基准旋转回弹 |
| `scootStretchResponse` | `0.14 s` | 细微的形状响应 |
| `scootStretchDampingFraction` | `1.0` | 无拉伸回弹 |
| `scootStretchMin` | `0.92` | `1 - 0.08`，与最大 Y 向压扁一致 |
| `scootStretchPivotX` | `0.25` | 使前端四分之一保持在热点附近 |
| `scootStretchXAmount` | `0.16` | 最大 16% 纵向拉伸 |
| `scootSquashYAmount` | `0.08` | X 向形变的一半 |
| `scootRotationResponse` | `0.16 s` | 跟踪形变响应 |
| `scootRotationDampingFraction` | `1.0` | 无旋转过冲 |
| `scootRotationMax` | `π/8` | 22.5 度，静止对角线的一半 |
| `terminalTangentBlendStart` | `0.80` | 最后五分之一过渡到点击朝向 |

位置响应的计算方式为：

```text
response = clamp(distanceInPixels * (1 / 2400 secondsPerPixel), 0.18, 0.72)
```

### 路径度量与评分

`SCORE_SAMPLES = 33` 表示 33 个点（含两个端点），以及 32 个等长的参数区间。
独立的核心度量为：

```text
detour      = max(0, measuredLength / directDistance - 1)
angleEnergy = mean(deltaHeading²)
maxAngle    = max(abs(deltaHeading)) / π
totalTurn   = sum(abs(deltaHeading)) / π
outOfBounds = 0 or 1
```

对于退化弦（degenerate chord），实测长度为零时其绕行量为零；实测长度为正而直接距离为零时，
以无穷大评分判定为拒绝。

独立的核心评分是：

```text
8 * detour
+ 1.5 * angleEnergy
+ 2 * maxAngle
+ 0.5 * totalTurn
+ 1,000,000 * outOfBounds
```

这些项均无量纲且为正。因此，只要存在有效直线路径，它就会胜出；而离开视口属于
字典序意义上的拒绝，而非外观偏好。按 issue #3293 的要求，Maka 更早的原始路径长度
加项与反向到达惩罚仍围绕该核心评分保留。

独立推导出的评分器继续评估 Maka 既有的单段三次曲线候选族。它不从历史制品中
引入任何候选生成器。

作为本次替换中 Maka 新增的集成选择，九个候选的预算按选取得出，而非笛卡尔积。
这样就把独立的“九”这一数量与 Maka 保留的五路出发扇（departure fan）调和起来。
全新运动在直接出发时使用九个对称弧值。被中断的运动保留全部五个
`DEPARTURE_FAN` 权重：直接出发处的五个对称弧（含零弧），再加上其余四个出发
权重处各一个零弧候选。该分配是针对独立推导出的奇数对称预算所做的实现选择，
不属于该推导本身。

### 终端朝向

全新运动开始时朝向路径目标。在进度 `[0.80, 1.00]` 区间内，引擎计算从路径切线到
`clickAngle` 的最短带符号角差，并用下式插值：

```text
phase = clamp((progress - 0.80) / 0.20, 0, 1)
weight = phase² * (3 - 2 * phase)
heading = tangentAngle + shortestSignedDifference * weight
```

在插值前对差值做环绕处理，可避免跨越 `-π`/`π` 边界时发生绕远旋转。

### close-enough 阈值与呈现截止时间

独立的阈值条件为：

```text
progress = 0.99999
distance = 2 CSS px
```

五个 9 的进度值在 100,000 CSS px 的路线上至多留下一个 CSS 像素，落在独立的
2px 距离阈值之内。截止时间并非与这些数值分开选取。

对于最慢的临界弹簧，引擎用下列参数重放其半隐式积分：

```text
response = 0.72 s
damping fraction = 1.0
step = 1 / 240 s
progress threshold = 0.99999
```

该阈值在 1725ms 达到。在支持的最慢呈现节奏——每秒一帧——下，释放可在 2000ms 帧上
被观察到。再加上 100ms 的渲染进程/IPC 调度余量，得到：

```text
cursorPresentationReadyDeadlineMs() = 2100 ms
```

覆盖层在运动提交时设定引擎时钟的起点，因此首个 1fps 帧即可推进第一秒。当一次移动
打断另一次移动时，旧路径先对齐到相同的提交时间戳，随后替换路径也在该时间戳处设定
时钟起点，从而防止替换前的时间被重放进新路径。

常驻的透明 `BrowserWindow` 会禁用 Electron 后台节流，使其真实的
`requestAnimationFrame` 路径在失焦时不会进入仅在后台出现的 1fps 相位漂移。
就绪状态只在绘制之后、且只经该帧路径评估与上报。空闲时的 CPU 行为不变，
因为渲染进程在引擎收敛后即停止请求帧。

控制器继续从该函数获取其 ready fence，因此该 fence 不可能悄无声息地低于推导出的
截止时间。结果仍低于独立的 5000ms 死渲染进程（dead-renderer）兜底阈值。

## 历史二进制检查记录

在 issue #3293 之前，Maka 保留了从该制品中恢复出的精确输入：

- 应用程序：`~/.codex/computer-use/Codex Computer Use.app`；
- 可执行文件：`Contents/MacOS/SkyComputerUseService`；
- bundle 标识符：`com.openai.sky.CUAService`；
- 签名构建日期：2026-07-16；
- SHA-256：`44320516c4c400fb5459b203498c78e4af318b0096464f16c4445a47f2b8b8f4`。

pull request #1255 引入了源自二进制的字形、热点与运动数值。pull request #1883
引入了源自二进制的路径度量与评分器数值。pull request #2676 记录了该边界。
该专有制品并未保存在本仓库中，而所记录的本地路径后来存放的是另一个不同的
签名构建。

这些先前的输入仍可见于已公开的 Git 历史中，此处仅作为历史来源加以描述。
当前光标行为不再保留它们。Issue #3293 通过替换而非对先前事实作出法律判定，
来解决当前源码闸门问题。

本仓库及其分发物中均未加入任何 OpenAI 源代码或可执行字节。

## MIT 许可证源码谱系

Maka 最初的光标渲染器是对 `trycua/cua` 的 MIT 许可证 `cursor-overlay` 的
TypeScript 改编，由 Maka 提交 `025d0c628a2162d0a7daf49e97d104c36a4431c6` 引入。
Maka 记录的上游固定提交为 `8c921b2b3bf13494724ead4f0a814d80c56a7e8b`。

后续工作替换了其中大部分运动与字形实现。MIT 谱系对渲染器的引入以及周边覆盖层
设计仍有相关性，但它并不是上文独立取值的来源。

## 保留的 Maka 原创或调整过的行为

issue #3293 有意保留了周边的 Maka 工作：

- `planCursorPath` 中的单段三次曲线候选族；
- `MAX_DESIRED_ARC` 与 `DEPARTURE_FAN`；
- 原始路径长度代价与反向到达评分项；
- 视口加宽与边缘行为；
- 帧时钟归属权与低帧率子步进；
- 目标窗口排序、语义元素中心呈现、取消、完成与呈现 fence；
- Maka 的品牌配色、点击脉冲、阴影处理与宿主集成。

该结果仍是一个混合谱系的 Maka 实现：源自 MIT 的渲染器基础、Maka 原创的产品行为，
以及带有公开独立推导的当前光标取值集合。
