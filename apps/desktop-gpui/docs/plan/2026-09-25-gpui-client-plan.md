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

# Maka GPUI 客户端：总体计划

日期：2026-09-25。状态：草案，待用户拍板后按阶段执行。

## 0. 结论先行

「把 maka 用 GPUI 重做」不等于把 126 万行 TypeScript 全部翻成 Rust。Maka 的架构已经把
执行权收在 Runtime Host 里，Desktop、TUI、CLI 都只是 Host 的瘦客户端。因此正确的切法是：

**用 GPUI 写一个新的 Runtime Host 瘦客户端，替代 Electron 壳（`apps/desktop`，约 17 万行）。
Runtime、Runtime Host、Storage、Eval、CLI 全部保留在 TypeScript 里，不动。**

这样做的依据：

- Host 有公开协议，本地走 Unix Domain Socket / Windows 命名管道，远程走 WebSocket。帧是
  「一行一个 JSON」（`\n` 分隔，单帧上限 768 KiB），Rust 侧实现成本很低。
- 握手是 `hello` → `accepted | incompatible`，之后是 `{requestId, operation, input}` 请求与
  `{requestId, operation, ok, result|error}` 响应，加上以 `subscription.*` 开头的推送帧。
  共 155 个 operation，MVP 只需要其中十几个。
- Host 可以独立拉起：TUI 就是 spawn `node packages/runtime-host/dist/execution-candidate-main.js --root … --expected-root-id … --startup-attempt-id …`，
  然后读控制目录里的 `registration.json` 拿到 socket 路径。GPUI 客户端照做即可。

代价与风险：

- 协议类型目前是手写 TS 校验器（无 zod、无 JSON Schema），Rust 侧需要手写 serde 类型，
  并且协议带 `compatibilityEpoch`（当前 177），Host 升级时客户端要跟着改。
- Desktop 有一批「桌面独有」能力（原生对话框、自动更新、系统通知、浮层宠物、Computer Use
  覆盖层、浏览器面板等）。它们不在 Host 协议里，要在 Rust 里重做，属于长尾。
- gpui-kit 0.6.6 是 longbridge 自己的组件库，API 还在快速演进；waku 作者的做法是不用第三方
  组件库、直接读 Zed 源码。我们按用户要求用 gpui-kit，但要把「不要凭印象发明 API」当铁律。

## 1. 未拍板、需要用户决定的事

1. **仓库位置。** 本计划先落在独立仓库 `~/code/maka-gpui`。理由：apache/maka 处于瘦身期，
   ASF 流程慢，且这是探索性工程。等 MVP 跑通再决定是否搬进 `apache/maka` 作为 `apps/desktop-gpui`。
2. **目标平台顺序。** 先 macOS（本机可验证），Windows/Linux 只保证能编译。
3. **要不要替换 Electron Desktop。** 本计划只做「可用的第二客户端」，不承诺功能对齐。

## 2. 参照工程 waku 给我们的东西

waku（egoist/waku，GPL-3，只借鉴做法不抄代码）结构与我们要做的高度一致：

| waku | 我们 |
|---|---|
| `crates/waku-protocol` 线协议类型 | `crates/maka-host-protocol` |
| `crates/waku-client` RPC 客户端，桌面端只链它 | `crates/maka-host-client` |
| `crates/waku-daemon` 独立守护进程 | maka 的 Runtime Host（已有，TS） |
| 根 `src/` GPUI 桌面端，`src/app/*` 按功能分文件 | `crates/app` + 按能力拆的 feature crates |

值得照搬的工程实践（详见 `AGENTS.md`）：

- 性能是产品需求：`render` 里禁止任何 I/O、子进程、阻塞锁；后台算完 `cx.notify()`；
  整批解析加 generation 计数防旧结果覆盖新状态；流式提交 ≤ 8 Hz，spinner ≤ 60 Hz。
- 可访问性是产品需求：所有鼠标能点的控件键盘都能到；不用颜色单独表意；尊重 reduce motion。
- 版本号单一来源（`Cargo.toml`），CHANGELOG 即更新说明来源。
- `docs/*.md` 是带源码行号引用的设计笔记，不是用户文档。
- CI 矩阵三平台 + `cargo test --locked` + 协议漂移检查。
- PR 必须披露 AI 使用范围。

我们额外加上 waku 没做的：`clippy -D warnings`、`cargo deny`、`cargo nextest`。

## 3. 目标架构

```
crates/
├── app/                    # 壳：main、窗口、菜单、组合 feature crates
├── host-protocol/          # 纯类型 + 帧编解码；无 GPUI、无 I/O
├── host-client/            # 传输(UDS/WS)、握手、请求复用、订阅流、重连、Host 拉起
├── shared/                 # 主题 token、稳定 ElementId 派生、文案(i18n)、时间格式
├── workspace/              # 项目目录选择、State Root 管理、Host 连接状态
├── session/                # 会话目录、创建、切换、元数据
├── transcript-model/       # 纯逻辑：订阅帧 → 转写状态机（移植 packages/ui 的 live-turn-projection / materialize / stream-*）；无 GPUI
├── conversation/           # 转写渲染、流式 assistant、工具调用卡片、权限交互、composer
└── settings/               # 模型连接、偏好
```

依赖只往下指：`app → features → shared/host-client → host-protocol`。feature 之间通过事件或
小的共享服务通信，不互相 import 视图。

### 3.1 host-protocol

- serde 类型逐一对照 `packages/runtime-host/src/protocol/*.ts`，字段名保持 camelCase
  （`#[serde(rename_all = "camelCase")]`）。未知字段先容忍（`deny_unknown_fields` 只在测试
  fixture 上开），因为 TS 侧用 `requireExactRecord` 但那是 Host 校验客户端，不是反过来。
- 常量：`RUNTIME_HOST_COMPATIBILITY_EPOCH = 177`、`compositionId = "maka.interactive"`、
  `MAX_MESSAGE_BYTES = 768 * 1024`。协议版本范围从 `packages/runtime-host/src/protocol/index.ts` 抄。
- 测试：golden fixtures。从真实 Host 抓一批帧（hello/accepted、session.catalog.query、
  subscription 帧、tool 事件、interaction）存成 JSON，roundtrip 解码。fixture 的抓取脚本进仓库。
- 漂移检查：脚本对比 maka 仓库里的 epoch 常量与我们的常量，不一致 CI 直接红。

### 3.2 host-client

- 传输层用 GPUI 自带的 executor（smol 系）。UDS 用 `async-net`/`async-io`；WebSocket 二期再做。
  不引 tokio，避免双 runtime。
- 连接对象持有：`rootId/hostEpoch/connectionId/selectedProtocol`，一个 in-flight 请求表
  （requestId → oneshot），一个订阅表（subscriptionId → channel）。读泵独立于处理器。
- Host 拉起：先只做「连接已在运行的 Host」（读 `~/Library/Caches/Maka/runtime-hosts/<rootId>/registration.json`
  拿 `endpoint`；`state-root-owners/` 里只有锁文件。Phase 0 实测纠正）；第二步实现 spawn 候选进程 + 轮询注册文件（对照 `client/connect-or-spawn.ts`
  和 `candidate-cli.ts`）。**开发期一律用独立的 dev State Root，不碰用户正在用的 Maka 数据。**
- 重连策略与 `hostEpoch` 变化处理：epoch 变了必须重开订阅、重读快照。

### 3.3 transcript-model（最容易被低估的部分）

Electron 端约 8.8K 行 TS 不是 UI，而是把 `subscription.*` 帧折叠成可渲染转写的逻辑：
`packages/ui/src/live-turn-projection.ts`、`materialize.ts`、`stream-*.ts`（含流式脱敏）。
Rust 侧必须重写这一层，并且它决定了转写显示是否与 Electron 一致。做法：

- 独立 crate，只依赖 `host-protocol` 与 serde，不依赖 GPUI。输入是帧序列，输出是
  `Transcript` 状态；UI 只读它。
- 测试用录制回放：从真实 Host 录一段完整回合（含工具调用、权限、打断）的帧序列做 fixture，
  断言最终状态；同一 fixture 在 TS 端也能跑，用来对齐两边行为。
- 先移植 MVP 需要的子集（assistant 文本流、工具事件、交互、回合结束），reasoning、
  脱敏、分页拼接放 Phase 2。

### 3.4 conversation（最重的 feature）

- 订阅 `subscription.open` 得到快照 + `nextSeq`，随后接收 `session_projection / delta / event /
  transcript_advanced / domain_changed / closed` 帧。
- 流式文本：用 gpui-kit `TextView::markdown`；先按整段重渲染，测过性能再决定要不要增量。
- 工具调用：一条工具事件一张卡片，`ElementId` 用 `toolCallId` 派生，不用下标。
- 权限交互：`interaction.query` + `interaction.answer`，用 Dialog 或内嵌卡片，Escape 不等于拒绝。
- 长转写：`VirtualList`，历史用 `session.transcript.page` 向上翻页。

## 4. 阶段与验收

### Phase 0：协议打通（先跑通，再固化）

产出：`host-protocol` + `host-client` 两个 crate，一个 CLI 例子 `cargo run -p host-client --example status`
连上本机真实 Host，完成握手，调 `host.status` 与 `session.catalog.query` 打印结果。

验收：对着 `npm run build` 后用 TUI 拉起的 dev root 的 Host 跑通；golden fixture 测试通过。

### Phase 1：MVP 聊天闭环

产出：一个能用的窗口。左侧会话列表（`session.catalog.query`，监听 `session_catalog_changed`），
项目选择（`project.catalog.query/mutate`），新建会话（`session.create`），composer 发消息
（`turn.start`），流式渲染（`subscription.open`），工具调用卡片，权限弹窗（`interaction.*`），
停止（`turn.stop`），断线重连提示。

验收：在 dev root 上完整跑一轮「提问 → 模型调用工具 → 弹权限 → 批准 → 拿到结果 → 结束」，
与 Electron Desktop 上同一会话的转写一致。UI 集成测试用 `#[gpui_kit::test]` 覆盖
composer 提交、权限回答、停止三条路径。

### Phase 2：日常可用

模型/连接设置（`configuration.*`、`connection.*`）、消息队列（`queue.*`）、转写翻页、
会话重命名/归档、todo、命令面板、快捷键、主题跟随系统、i18n（中英）。

### Phase 3：长尾

Agent Graph 面板、WorkHub/Work Board、Plan 模式、Skills 目录、外部会话导入、远程 Host
（WebSocket/SSH）、自动更新、系统通知、PTY 终端、Git review、Computer Use 覆盖层。
逐项评估要不要做，不承诺对齐。

功能分级的依据见 §6（来自对 `apps/desktop/src/renderer` 的清单）。

## 5. 工程规范（落在仓库里的文件）

- `AGENTS.md`（`CLAUDE.md` 软链到它）：性能、可访问性、gpui-kit 铁律、协议纪律、验证要求。
- `rustfmt.toml`、`clippy.toml`、`deny.toml`、`rust-toolchain.toml`（stable，含 clippy/rustfmt）。
- `justfile`：`just check`（fmt + clippy + test）、`just run`、`just fixtures`（抓协议帧）、`just drift`。
- `.github/workflows/ci.yml`：macOS 为主，Linux/Windows 只 `cargo check`。
- `docs/`：设计笔记（带源码引用），`docs/plan/` 放本文与后续阶段计划，`docs/adr/` 放决策。
- 提交信息：命令式短句，不带 conventional-commits 前缀（与 waku 一致，与 maka 不同；
  这是独立仓库，先这样，搬进 maka 时再改）。

## 6. Desktop 功能清单与分级

来源：对 `apps/desktop/src/renderer`（约 98.8K 行 TS，其中 11.8K 是三语文案）与 `packages/ui/src`
（37.2K 行）的清单。行数是今天 TS 的规模，用来估相对工作量，不是 Rust 的目标行数。

组件库是 Astryx（`@astryxdesign/core`），Markdown/代码高亮来自它，数学用 KaTeX，图表用 Mermaid，
虚拟列表用 virtua，终端用 xterm。Rust 侧对应：gpui-kit `TextView::markdown`、`VirtualList`；
KaTeX/Mermaid/xterm 没有现成替代，进长尾。

渲染进程与主进程之间约 380 个 IPC 通道，其中大部分是 Host 协议的透传（sessions 50、
connections 16、skills 15、projects 12、shell-runs 11、memory 10……），原生客户端可以直接说协议。
桌面独有的部分（不在协议里，Rust 要自己做）：原生文件对话框、自动更新、系统通知、
窗口菜单、内嵌浏览器、宠物、macOS 权限、本地消息 outbox、Host 生命周期管理、WorkHub 浮窗。

| 层级 | 内容 | 今天的 TS 规模 |
|---|---|---|
| (a) MVP 聊天闭环 | 转写与流式（8.8K，含上述纯逻辑）、composer（5.2K）、工具活动卡片（3.4K）、Markdown（2.0K）、交互提示（权限/问题/表单/沙箱边界/客户端能力，1.5K）、模型选择（1.1K）、会话列表与项目选择（约 4K）、app-shell 状态与动作（8K）、任务入口与 onboarding（约 2.7K）、最小「添加模型连接」 | 约 50K |
| (b) 日常可用 | 完整模型/供应商/OAuth 设置（7.6K）、设置框架与通用页（约 7K）、命令面板与搜索（1.9K）、Workbar 框架 + 工件预览 + git review + 终端（5.8K）、会话检查器（2.6K）、Plan 模式/Goals/Agent Graph（2K）、分支/修订/压缩动作、Skills 与 MCP（4.3K）、Memory、Usage、归档 | 约 36K |
| (c) 长尾 | Runtime Host 管理（SSH/WSL/Peer Mesh，6.2K）、定时任务与每日回顾（3.3K）、side chat（3.2K）、WorkHub（2.9K）、协作（2.35K）、客户端插件（2.2K）、Bots（1.9K）、导入、Computer Use 覆盖层、子代理、宠物、Work Board、会话包、web search、外部 agent、浏览器、健康、代理 | 约 29K |

MVP 需要的协议操作：`host.status`、`session.catalog.query`、`session.create`、`session.configuration.update`、
`subscription.open/close`、`session.transcript.page`、`turn.start`、`turn.stop`、`turn.query`、
`interaction.query/answer`、`project.catalog.query/mutate`、连接与模型目录的查询操作（Phase 1 时到
`protocol/connection-effects.ts`、`configuration.ts` 里核实具体名字）。

交互类型（`packages/core/src/interaction.ts`）：`permission`、`question`、`form`、`sandbox_boundary`、
`client_capability`。MVP 做前两个，`form` 与后两个 Phase 2。

## 7. 分工

- 主会话（Fable）：架构决策、接口边界、阶段验收、对抗式审查。
- Opus 子代理：Phase 0/1 的实现。每个任务给完整规格 + 指向 maka 源码的精确路径 + 验收命令，
  要求返回精炼报告（改了什么、怎么验证、哪里不确定）。
- Sonnet 子代理：抓 fixture、批量生成 serde 类型骨架等机械工作，产出必须可独立验证。

## 8. Phase 0 验收后的决策（2026-09-25）

Phase 0 已跑通：Rust 连真实 dev Host，握手、`host.status`、`session.catalog.query` 正确；
host-protocol 73 测、host-client 27 测、clippy/fmt/drift 全绿。代理提出的问题按下面定：

1. `clientInstanceId` 持久化（像 Desktop），存到应用配置目录；GUI 客户端需要稳定身份做接管与交接。
2. 探活（每 2 秒 `host.status`，8 秒无响应判断连）与重连放在 `host-client`，以事件形式暴露；
   UI 层只消费状态，不自己算。
3. 背压在 `host-client`（推送通道有界），8 Hz 合并在 `conversation` 状态层；`transcript-model`
   保持纯函数，不管节奏。
4. 常量改名为 `RUNTIME_HOST_COMPATIBILITY_EPOCH`，与 TS 同名。
5. fixture 抓取往 dev root 累积会话可以接受，补一个 `just dev-root-reset`。
6. Windows 命名管道推到 Phase 2 之后。

## 9. 阶段文档

- Phase 1 规格与验收：`phase-1-mvp.md`。2026-09-25 闭环跑通（605d990）：真实 Host 上完成含 Bash 工具调用的回合。
- Phase 2 规格：`phase-2-daily-use.md`。首要是模型/连接选择与从应用内拉起 Host，其余按日常可用排序。
