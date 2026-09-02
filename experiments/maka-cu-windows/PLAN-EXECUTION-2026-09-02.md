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

# 本轮最小计划执行记录

日期：2026-09-02。`distributionReady=false`，未进行语言选型。
本轮会话无法切换 Luna/high，已向用户说明；未声称使用了该模型。

## 结论

代码与纯协议验证已推进，但桌面验收被锁屏阻塞。
Windows 当前前台 HWND `1446640` 对应 PID `36820`、进程 `LockApp`。
本轮旧版/新版 helper 的浏览器测试均没有派发 SetValue。
这些锁屏/未取得前台的观测不能推翻此前其他 agent 的等待实验，
也不能用于证明默认或 `=complete` 模式的前台能力。

## 已完成

- 核对并复用其他 agent 的 per-page oracle 修复；未重写其状态合并。
- oracle 测试从 8 扩充到 11，新增 24 种关键 POST 到达顺序、
  跨运行隔离、无关事件中出现目标文本的负例，11/11 通过。
- harness 新增 `--pre-uia-ms` 与 `--repetitions`；先等本地页面 ready，
  再等待指定时间，之后才首次对新 Chrome 进行目标发现。
  `list_windows` 自身可能接触 UIA，因此记录 firstTargetDiscoveryAt；
  不声称控制了外部辅助技术客户端。
- observe RPC 记录发送/接收时间；页面控件匹配同时要求 AutomationId 和能力，
  不把同名 label 当作输入框。
- SetValue 测试仍只发送一次动作；增加最多三次后续 observe，分别记录目标身份、
  RuntimeId 与值匹配，不改写原 helper outcome。
- 修复 harness 前台探测：原来忽略 SetForegroundWindow 的布尔结果并返回 `ok`；
  现在记录真实返回值、实际前台 HWND、是否最小化，未获得前台即阻塞该运行。
- 增加只读 LockApp/LogonUI 检查，在确认锁屏时不启动测试 Chrome、不激活窗口。
  若运行中发生异常，保留已完成 subjects 并关闭本地 oracle 服务。
- 测试清理不再全局杀掉所有 `maka-cu-*` Chrome；仅清理当前 profile 的进程。
  发现其他测试 profile 时停止而不是清除；进程查询失败时不盲目清理。

## C# 滚动区问题：代码原因已定位，修复待桌面验证

已有 `browser-task-results-handoff-observe-settle.json` 和
`browser-task-results-handoff-csharp-scroll.json` 中，滚动区为：

- name：`Web scroll region`
- automationId：`scroll`
- controlType：`ControlType.Group`
- 旧输出只有 cached-properties 节点，patterns 为空。

旧 actionable 类型列表不含 Group，因此这个节点虽被渲染出来，
却未进入 live Pattern 探测。这不能据以认定 provider 不支持 Scroll。

本轮增加 Group/Custom/Document 的 Pattern 探测；没有对祖先偷偷执行操作，
没有改变 scroll、焦点或 SetValue 执行逻辑。
增加 runtimeId、parentRuntimeId、rawDepth、observationSource 等诊断字段。
所有实际访问节点（含无名/被过滤节点及第二遍重复访问）计入共享节点预算；
新增 visitedNodeCount、maxRawDepthVisited，并修正叶节点深度边界的误报。
单次 COM 调用仍不能被这些调用间预算强行中断。

## Rust 诊断修正

输出真实探测到的 Value/Invoke/SelectionItem/Toggle/Scroll/ScrollItem，
不再从 actions 反推 Pattern（原来会把 ScrollItem 误报为 Scroll）。
输出已用于身份验证的 RuntimeId。
原有 scroll 动作词汇和执行行为未修改；消费者必须区分 Scroll 与 ScrollItem。
rawDescendantCount/elapsedMs 已由其他 agent 实现，本轮保留；
原始数量恰好等于 512 时不再误报截断。
整树 FindAll 的阻塞风险仍未解决，未提高 512 上限。

## 本轮验证

| 验证 | 结果 |
|---|---|
| Node oracle 测试 | 11/11 |
| Rust cargo test | 6 单元 + 3 协议通过 |
| Rust clippy --all-targets -- -D warnings | 通过 |
| 两种 helper Release 构建 | 通过，C# 0 警告/错误 |
| browser harness node --check | 通过 |
| 锁屏 gate | blocked/environment_desktop_locked；未启动测试应用 |
| 当前 C# 深层/预算 GUI 回归 | 未运行，等待解锁 |
| 当前生命周期 74 检查 | 未重跑，不能沿用旧结果 |
| 当前 Group 的真实 ScrollPattern | 未验证，等待解锁 |
| SetValue + 页面证据 + 同元素读回 | 未派发，等待解锁 |

当前 helper 指纹：

- C# `src/bin/Release/net8.0-windows10.0.22621.0/maka-cu-windows.dll`：
  `BECEBC5C4F05C3203B04840046EF7F0BB623D3FE4E5EFF3BA595A3A1D80B83B9`
- Rust `../maka-cu-windows-rust/target/release/maka-cu-windows-rust.exe`：
  `15E2A84D90C965DC8D3403ADFFD1A97F482D73B65FF803FA4712FF8FED90E0DA`

## 结果文件如何解释

- `browser-results-plan-immediate.json`：修改 helper 前，每种 3 次，立即访问后等 2 秒再观察。
- `browser-results-plan-delayed-first.json`：相同 helper，每种 3 次，页面 ready 后先等 2 秒，首次访问后再等 2 秒。
- 以上两份均只有外壳，且当时前台检查仍是假 `ok`；前台条件没有证据，不作为有效延迟对照。
- `browser-results-plan-complete-setvalue.json`：新 helper，显式 `=complete`；两边真实记录
  `activated=false`、`targetIsForeground=false`，目标输入框未发现，SetValue 未派发。
- 随后只读 Win32 检查确认该前台 HWND 是 LockApp。
- `browser-results-plan-desktop-gate.json`：新增锁屏 gate 的初次验证。
- `browser-results-plan-desktop-gate-final.json`：最终 harness 的只读 gate 验证。

保留上述原始记录，不把它们改成成功，也不将其与其他 agent 的解锁状态结果合并。

## 解锁后的顺序

1. 用当前产物重跑 observe-tree-harness 与 comparison-harness，输出新文件。
2. 重新跑 default 的立即访问/先等 2 秒两个组，要求前台检查为 true；各 3 次。
3. 单独跑 `force-renderer-accessibility-complete` 的 observe + SetValue。
4. 验证 C# `scroll` Group 有 live-patterns、真实 Scroll Pattern、自己的 token。
5. 查 SetValue 的原始 outcome、页面 input 事件、后续同身份元素读回，分别报告。
6. 此后才进入 click/scroll/授权输入/Enter/导航；本轮没有扩展到这些动作。

没有加入 CDP，没有调整 anti-occlusion，没有重试独立 computer-use，
没有修改 Windows 安全设置或绕过锁屏/前台限制。

## 2026-09-02 解锁后续跑：实际结果

桌面前台只读检查不再是 LockApp，随后顺序运行 GUI 测试，没有并发抢前台。
Chrome 版本为 `152.0.7977.64`；沿用上文两个 helper 的构建，DLL/EXE SHA256
重新核对一致。本次没有修改或重编 helper；仅补充并纠正观察测试的诊断和断言。
当前会话无法切换到用户指定的 Luna/high，不声称本轮测试代码修改使用了该模型。

### #4318 基线与测试本身的缺口

- `comparison-results-plan-unlocked.json`：两边 lifecycle 各 34/34，protocol 各 3/3，合计 **74/74**。
  包含目标截图像素/遮挡隔离、取消、阻塞后终止与恢复、旧 snapshot/token 拒绝、父进程死亡/EOF。
- `oracle-state.test.mjs`：**11/11**，没有修改页面完成判定来抬高成功率。
- `observe-tree-results-plan-unlocked.json`：最初 C# 4 pass / 1 fail；Rust 3 pass / 2 not_tested。
- `observe-tree-results-plan-unlocked-depth-diagnostic.json`：补充 RuntimeId/rawDepth 后确认，
  fixture 的 Deep/Mid nested input 实际均在 UIA **深度 1**，整树最大深度 **3**。
  WPF 中 16 层 Border/StackPanel 的布局嵌套没有形成对应的深层 UIA 链。
  原来的“找到名称即深层遍历成功”是假覆盖；深度阈值 4/3 又没有真正截断任何节点，
  所以不应该要求 `truncated=true`。不能把旧 5/5 当作有效深度证明。
- 修正测试而非 helper：深层前置条件不成立标记 not_tested；边界测试改为实际能跨越的
  actionable=2/render=1，并检查具体截断原因、最大访问深度和返回节点深度。
- `observe-tree-results-plan-unlocked-corrected.json`：C# **4 pass / 1 not_tested**；
  Rust **2 pass / 3 not_tested**；合计 6 pass / 4 not_tested，无失败。
  C# 浅层深度边界和共享节点预算有效；真正的深层 UIA fixture 仍待补齐。
  Rust 缺少 rawDepth 证据，并且忽略 debugLimits，不能宣称对应预算/深度测试通过。

上述三份 observe 原始文件全部保留，没有覆盖最初失败记录。

### 普通 Chrome：12 个独立窗口，只观察，不派发动作

每一组、每一种语言各重复三次，均在开始观察前确认
`targetIsForeground=true`、`minimized=false`；没有订阅事件。
“找到控件”要求目标 name + automationId + 对应 action，不只查 Document 或标签。

| 条件 | C# 首次 / 等 2 秒后 | Rust 首次 / 等 2 秒后 |
|---|---|---|
| ready 后不额外等待，开始窗口识别 | 三次均 0/4 → 4/4 | 三次均 0/4 → 4/4 |
| ready 后额外等 2 秒，再开始窗口识别 | 三次均 0/4 → 4/4 | 三次均 0/4 → 4/4 |

原始证据：

- `browser-results-plan-unlocked-immediate.json`
- `browser-results-plan-unlocked-delayed-first.json`

首次 0/4 的含义并不相同：C# 的后半段 cached-properties 已出现 Document 和四个目标
控件，但没有可操作 Pattern；Rust 首次只有 38 节点，没有这些网页候选。
C# 节点数三次均 97→104，Rust 均 38→58。两边这些观察均未声明 truncated。

第二次 C# 的 `automationId=scroll` 为 Group，`observationSource=live-patterns`，
真实 patterns 包含 **Scroll 和 ScrollItem**，具有自己的 token/RuntimeId；Rust 同样有
两种 Pattern。由此验证了 C# Group 探测修正，但没有执行滚动。
C# 同时出现两个 `scroll` action 字符串是现有输出去重问题，不等于两次动作。

时间限制：不额外等待组首次 observe 实际在 ready 后 **4335–5845 ms**；
额外等待组为 **5625–6423 ms**。窗口识别/进程查询/前台检查也消耗时间，
`list_windows` 本身可能访问 UIA，外部 accessibility 客户端没有隔离。
结论仅为：本环境中额外启动等待没有消除首轮不可操作状态，首次访问后再观察稳定改善；
不能证明某个唯一唤醒机制，更不能承诺任意 Chrome 都可靠。

### `=complete`：6 个独立窗口，每窗仅一次 SetValue

先运行每边一轮，再在新窗口中各补两轮。没有因 unknown 重发动作，
也没有点击、滚动、键盘或导航。

- `browser-results-plan-unlocked-complete-setvalue.json`：首轮 C# unknown，Rust verified。
- `browser-results-plan-unlocked-complete-setvalue-repeats.json`：补两轮 C# verified/unknown，
  Rust unknown/unknown。不能只选择首次有利于 Rust 的记录。

| 证据 | C#（3 轮） | Rust（3 轮） |
|---|---|---|
| 首次 observe 找齐四个可操作控件 | 3/3 | 3/3 |
| helper 原始 SetValue outcome | 1 verified / 2 unknown | 1 verified / 2 unknown |
| 页面独立 input 事件及目标值 | 3/3，每轮仅一个 input | 3/3，每轮仅一个 input |
| 后续同窗口、同 RuntimeId、值匹配 | 9/9 | 9/9 |

每轮读回三次，在等待页面 oracle 后分别额外延迟 0、250、750 ms，期间只读。
这里的 0 ms 不是动作后瞬时采样；页面 oracle 等待和 observe 自身也有耗时。
三次均校验 hwnd/pid/processStartTimeUtc/windowGeneration 与原窗口一致、RuntimeId
与原输入框一致，并检查该元素的 Value，未使用整个 Document 文本匹配。

unknown 均为立即 readback mismatch；C# 记录当时值为空。之后页面和同元素读回一致，
说明“动作未生效”不符合这些样本，问题聚焦在立即读回时序/新鲜度。
但现有证据尚未细分 provider 缓存、查询路径及线程调度的各自贡献。
保留原始 unknown 与 `applicationCompleted=true` 两列，不事后改成 verified。
两边各三次的样本也不代表大规模任务成功率。

### 接下来应实施与尚未测试

1. 对两边使用同样的有界验证策略：SetValue 仍只发一次；在总时限内重新确认目标身份，
   重新获取同一元素的新鲜 Value，允许只读重试；任何身份变化/密码属性不明/读取失败
   保守处理，超时仍 unknown；同时保留取消和父进程退出边界。
   不通过重复读取旧 Cached.Value 自我证明，不重新使用已消费的 mutation token。
2. 新建明确提供 UIA AutomationPeer 包装层的真正深层 fixture，再验证深度/访问预算；
   Rust 整树 FindAll 的单次调用无界风险仍在，不能用当前浅层测试掩盖。
3. 用新构建复跑本节基线，再逐项进入语义 click、容器自身 token 的方向滚动、选择、
   授权输入、Enter 和完整导航。普通模式与 `=complete` 分开报告。

本轮未测试上述后续动作、anti-occlusion、事件订阅、CDP、独立 computer-use，
也未跑 WinUI/UWP、Electron、LibreOffice、干净机器、内存/冷启动/首帧基准。
此前独立工具 URL 安全校验失败的内部根因没有由本轮证实。
这些结果不构成最终语言选型或“Chromium 完整任务已打通”的结论。

## 后续实现索引

用户批准第 1、2 步后，已实现 SetValue 同身份有界读回并重跑回归。
见 [SETVALUE-READBACK-REPORT-2026-09-02.md](SETVALUE-READBACK-REPORT-2026-09-02.md)。
新构建：共享策略每边 12/12、真实 provider 18/18、原基线 74/74；Chrome 两种模式
各三轮共 12/12 输入 verified 且有独立页面证据。此处是后续构建的结果，
不改写本文件前面旧构建的 unknown、失败或未测试记录。

同一新构建继续测试语义点击与方向滚动：见
[CLICK-SCROLL-REPORT-2026-09-02.md](CLICK-SCROLL-REPORT-2026-09-02.md)。
点击 12/12 pass；滚动页面位移 12/12 完成，但 helper 均 unknown，未计为任务通过。
本轮只收紧测试 oracle，没有修改 helper 滚动逻辑。后续应验证并修复滚动百分比读回。
