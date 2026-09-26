---
doc_id: computer-use-provenance
title: "Computer Use 来源溯源"
language: zh-CN
source_language: en
counterpart: ./computer-use-provenance.md
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

# Computer Use 来源溯源

[English](./computer-use-provenance.md)

Maka 的 Computer Use surface 建立在他人工作之上，方式有三种本质不同的路径。
之所以在这里分成三类，是因为三者对应的义务不同：按许可证再分发、对许可证源码
的改编或参考使用，以及为兼容性而检查专有实现。

从整体上说，Maka 的 Computer Use 实现参考了以 MIT 许可证授权的 `trycua/cua`
与 `iFurySt/open-codex-computer-use` 项目，并与 Codex Desktop 的实现和外部可见行为
做了对比。Maka 通过自身的测试、安全边界与产品需求整合并调整了这些输入。

上述概览不合并下文的来源类别。许可证源码、行为观察、从二进制中恢复的确切事实，
以及 Maka 自行编写的工作，仍然相互区分，因为它们的证据与发布评审义务各不相同。

文中路径均属于 Maka，除非其带有上游仓库名，例如 `open-codex-computer-use/...`。

每一条记录都说明取用了什么、落地在哪里、证据是什么。当你新增或修改一项借用的设计
时，在此处补一行，并把同样的陈述写进承载它的文件——文件内注释在有人发问的那一刻
回答“这个常量为什么是 200？”，而本文件为整个项目回答“我们构建在什么之上？”。

## 1. 按许可证再分发

随 Maka 制品一同分发。要求许可证文本与版权声明必须随之传递。

| 组件 | 许可证 | 声明文件位置 |
|---|---|---|
| npm 依赖 | 多种 | `apps/desktop/resources/licenses/npm/`，由 `scripts/generate-third-party-notices.mjs` 生成，并在构建时由 `scripts/check-third-party-notices.mjs` 做逐字节校验 |

Maka 只有一个 Computer Use 执行器，`maka-cu`。它由 `scripts/computer-use.mjs` 中的
`prepare` 命令从 Maka 自身源码构建，并在 `apps/desktop/bundled-tools.json` 中按
摘要固定。它未签名，因此不会分发：其 `distributionReady` 为 false，
`scripts/verify-macos-dmg.mjs` 禁止其路径出现在打包构建中。Computer Use 方面没有
任何第三方内容随 Maka 制品分发，这就是上表只有一行的原因。

Maka 过去运行的第三方执行器 cua-driver 已被移除，其随附声明也一并移除。本代码
树中没有任何内容会启动它或链接它。

`maka-cu` 本身是 MIT 许可的 `iFurySt/open-codex-computer-use` 的 fork（§2），因此
当它真正分发时，该声明会随之传递。

## 2. 作为改编来源或参考阅读的许可证源码

MIT 许可的源码既被用作实现的起点，也被用作设计参考。下表中的各行区分了改编
与仅作参考的使用。

### trycua/cua

MIT。Maka 最初的光标渲染器是对公开 `cursor-overlay` crate 的 TypeScript 改编，
由 Maka 提交 `025d0c628a2162d0a7daf49e97d104c36a4431c6` 引入。Maka 内置的
cua-driver manifest 所记录的固定上游源码为提交
`8c921b2b3bf13494724ead4f0a814d80c56a7e8b`。

Maka 后来替换并扩展了规划器、时序、热点、渲染与呈现生命周期。尽管旧的
cua-driver 可执行文件及其随附声明已不再分发，当前源码仍处于这一有据可查的谱系
之中。

### iFurySt/open-codex-computer-use，及其 fork QwenLM/open-computer-use

两者均为 MIT 许可，© 2026 Leo。是以 MCP server 形式对 Codex Computer Use 的
独立重新实现。

就下表中的各行而言，本仓库没有复制任何源代码；所取用的是一种格式、一个决定或一
项归档的测量结果。之所以给出署名，是因为它属于承重信息，而不是因为 MIT
对思想有强制要求。

| 取用内容 | 落地位置 | 说明 |
|---|---|---|
| Codex 真实 `get_app_state` 结果的归档捕获 | `packages/runtime/src/computer-use-tools.ts` | 他们的 `open-codex-computer-use/artifacts/tool-comparisons/20260417-focus-behavior/`。正是它把 Maka 对 Codex 观察格式的模型从推断变成了观察到的样本。 |
| 每元素一行的观察形态：用缩进表示包含关系，仅在非默认时才写出状态 | 同一文件 | Maka 的版本在头部保留 `observation_id`（帧绑定在这里属于协议，在那里属于散文），并保留元素几何信息（Codex 没有需要它的坐标动作面；Maka 的坐标动作面是默认禁用而非缺失）。 |
| 只写出状态中有信息量的一半——`disabled`，从不写 `enabled` | 同一文件 | 他们的 `summarizeTraits`。 |
| 从元素对外公布的动作列表中过滤掉 `AXPress`，因为按下正是 `click` 所做的事 | 尚未落地——等待 `trycua/cua#2622` 暴露逐元素的 AX actions | 他们的 `meaningfulActions`。 |
| 权限引导模式：把引导面板锚定到 System Settings 窗口、跟踪它，并区分哪些授权需要重启应用 | 尚未落地——用于 `feat/permission-onboarding` 工作 | 他们的 `open-codex-computer-use/apps/OpenComputerUse/Sources/OpenComputerUse/PermissionOnboardingApp.swift`。 |
| 把并排的工具捕获归档在仓库内作为证据 | 是实践，不是代码 | 值得在 Maka 自己与 Codex 的对比中采用。 |
| 私有的 SkyLight 合成焦点/后台点击配方 | Maka 的 `maka-cu` 执行器，固定于 `apps/desktop/bundled-tools.json` | 独立地从同一份 MIT cua-driver/yabai 配方推导而来；该执行器保留其署名与声明。WebContent 路径使用宿主窗口和单次私有 post，而不是通用的双 post 兼容路径。 |

从本代码树中移除 cua-driver 二进制文件，对该路径毫无影响：所借用的是已公开的
配方，而不是该制品或专有的 Codex 实现。

## 3. 为兼容性而检查的专有实现

已签名的 Codex Desktop Computer Use 可执行文件经过了静态检查。Maka 不包含也不
再分发任何 OpenAI 源代码或可执行文件，但从二进制中恢复的特定几何信息、数值常量
与控制流事实被转写进了光标实现。这是关于所列事实的主张，而不是关于整个 Computer
Use 实现都源自该二进制的主张。

这次检查提供的是证据，而不是许可证授权。Pull request #1255 与 #1883 准确记录
了所列从二进制恢复的输入中的大部分，但 #1883 的“term-for-term”措辞比当前混合评分
器更宽泛。详细制品、保留下来的事实以及 Maka 自行编写的偏离都记录在
`docs/computer-use-cursor-provenance.zh-CN.md` 中。

| 从二进制恢复或观察到的事实 | 影响的区域 |
|---|---|
| 历史性内容（已由 #3293 移除）：光标几何、中心热点、运动配置、close-enough 阈值、路径度量、核心评分权重 | 原为 `apps/desktop/src/renderer/computer-use-overlay/engine/cursor-engine.ts`；#3293 的替换移除了每一个转写值（热点现在是字形尖端，而不是中心） |
| 叠加层层级策略——被遮挡的目标会抬高光标，而不是将其隐藏 | 同一文件，以及 `apps/desktop/src/main/computer-use/cursor-overlay-window.ts` |
| 观察文本形态 | `packages/runtime/src/computer-use-tools.ts`，由 §2 中的归档捕获佐证 |
| OOP WebContent 定位、保留元素的唯一重取，以及渲染器世代隔离 | 在固定的 `maka-cu` 源码中重新实现；本仓库在 `apps/desktop/bundled-tools.json` 中记录确切的源码提交与二进制摘要 |
| 跨修订稳定的 AX 标识、有序的 no-change/remove/insert/update presentation，以及全树回退 | 在固定的 `maka-cu` 源码与 `packages/runtime/src/computer-use-observation-text.ts` 中重新实现；完整的当前树仍是权威，dispatch 仍使用全新的快照令牌 |

凡 Maka 有意偏离之处，偏离都在偏离之处就地说明，而不是在这里说明，这样正在修
改那段代码的人就会读到它。
