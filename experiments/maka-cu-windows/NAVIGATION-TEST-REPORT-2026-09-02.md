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

# 授权输入 / Enter / 导航：基线阻塞与 pilot 新证据

## 第一轮结论（不包含随后 pilot）

本轮 **未进入实际输入或 Enter 阶段**，没有新增功能通过/失败证据。
`browser-results-navigation-v1.json`（07:37:04–07:41:08 UTC）记录：

- C#/Rust × default/complete × 3 轮，共 12 个窗口。
- 12 个页面都上报 ready，但 12 轮 `SetForegroundWindow` 均返回 false，实际前台 HWND
  不是所绑定测试窗口（记录值为 463516 或 65818）。目标窗口未最小化。
- 所有 subject 为 `environment_foreground_not_acquired`，observe/input/Enter 共 36 个
  task 为 blocked/not_tested。**act 请求为 0，authorize_compat 请求为 0**。
- 这不证明输入、Enter、导航有问题，也不证明它们成功；不是 URL 校验失败。
  具体为何 Windows 未允许此次前台切换，尚未单独证明。

helpers 未修改或重编，仍是上一轮通过滚动和安全回归的构建：

- C# DLL：`3620D0D70A9472182F3BD7290A352FC648174ABE2F5183E94AC682A6832E3C2D`
- Rust EXE：`36AC2546CB285E21A0FD4576A749DD6A23D95F497FDAE8006ADDB341D7C18C0E`

当前会话无法切换 Luna/high，已告知；没有子代理。保留无关工作区改动。

## 本轮改进的测试证据

- 页面 oracle 增加事件 sourceId 与实际 location.href。
- 导航要求恰好一个 page-A Enter、原输入内容、page-B-load **和** page-B-ready。
- 强绑定同一 run、compat-input 控件、源 URL 和目标 URL。不能用另一输入框、另一页面、
  另一 run 或只有 load 尚未 ready 的事件证明完成；乱序 POST 仍可正常合并。
- Enter 前必须既有页面输入证据，又有指定 RuntimeId 对应输入框的期望文本。
  未满足则 `navigation_input_prerequisite_not_met`，不发送 Enter。
- 输入阶段记录同一目标/RuntimeId 的三次事后只读值；每种操作独立 observe/authorize，
  只派发一次。保留 requestEvidence 与原始 RPC；page completion 不覆盖 helper outcome。
- 新旧 oracle 单测共 **15/15 通过**，脚本通过 `node --check`。

代码核对：两边早已包含 SetFocus 和派发前焦点复核；不能预先归因为缺少聚焦。
两边 compat 文本确认仍为一次即时读取，是否需要有界读回必须由后续实测决定。
通用 Enter 按现有合同本来就返回 unknown，不能通过“SendInput 返回成功”改成导航 verified。
若以后页面确已导航而 helper unknown，应保留两个结果，再明确是否增加共享宿主的任务级
导航确认合同；不把本地 oracle 当成可部署的浏览器 URL 安全校验器。

## 下一轮需要手动激活测试窗口

在阻塞批次之后，脚本新增显式 `--foreground-wait-ms 30000`（默认仍为 0，范围 0–30000）。
第一次正常激活失败后，输出 WAIT_FOR_FOREGROUND，留出有界时间让用户点击测试 Chrome
标题栏；等待期间只读取前台 HWND，不模拟键鼠、不使用 AttachThreadInput、不解除前台限制。
到期或 HWND 不匹配仍然 blocked。helper 自身授权/焦点校验仍会继续执行。

此新等待分支目前只做了语法检查，**尚未做有人协助的 GUI 验证**。下一轮先 pilot，
不要立即重跑 12 个窗口；确认前台可取得后再做各三轮矩阵：

```powershell
node experiments/maka-cu-windows/browser-task-harness.mjs `
  experiments/maka-cu-windows/src/bin/Release/net8.0-windows10.0.22621.0/maka-cu-windows.exe `
  experiments/maka-cu-windows-rust/target/release/maka-cu-windows-rust.exe `
  --modes default --foreground-wait-ms 30000 `
  --tasks chromium_observe_page_controls,chromium_compat_type_text_authorized,chromium_compat_press_enter_authorized_navigation `
  --settle-ms 2000 --repetitions 1 `
  --out experiments/maka-cu-windows/browser-results-navigation-pilot-v2.json
```

测试结束时未发现遗留测试 helper 或测试 profile Chrome。未重跑旧安全矩阵，因为 helper
未改变且本次没有动作派发。没有对未执行的导航步骤给出根因结论。

## 随后有人配合的 pilot v2（07:44:11–07:45:25 UTC）

证据：`browser-results-navigation-pilot-v2.json`。default 模式，每 helper 1 轮。
两轮前台均成功、observe 均通过，finally 清理后未发现遗留测试进程。
两轮最初激活均 `activated=true`，没有触发新增的等待分支；因此该分支的成功等待/超时
路径仍不能算已经完成 GUI 覆盖。不能确定是否正是用户点击促成了最初激活成功。

| 项目 | C# | Rust |
|---|---|---|
| 授权输入 | unknown / send_input_partial_or_failed | unknown / readback_unavailable |
| 页面输入事件 | 无，三次同身份读回均为空 | 已有，三次同身份读回均为期望文本 |
| Enter | 前提不足，未授权或派发 | 一次独立授权、一次 act |
| 目标页 | 未导航 | 精确 URL / 同 run 的 pageB-load 与 ready 均满足 |
| helper 导航结果 | blocked / navigation_input_prerequisite_not_met | unknown / enter_readback_unavailable |

每一实际操作均一个授权、一个 act；没有重放输入或 Enter。
Rust 页面记录的 Enter 来源为 compat-input，计数恰好 1，事件对应原输入内容、源 URL
和目标 URL，并经过额外 250 ms 检查。页面完成证据成立，但 **helper unknown 未被升级**。
完整“输入+Enter 导航”合同任务两边均未全通过；1/3 是每窗只有 observe 任务 pass。
本轮只有一个 default 样本/语言，不能外推稳定任务成功率或 complete 模式。

### C#：已确认 INPUT 布局错误，尚未修复

`src/Program.cs` 的 INPUTUNION 仅含 KEYBDINPUT，遗漏决定 union 大小的 MOUSEINPUT。
只读诊断 `input-layout-diagnostic-v1.json`：

- 对实际受测 DLL 做反射并调用 Marshal.SizeOf(INPUT)，x64 返回 **32** 字节。
- 原始源码的内存编译结果也为 32；按本机 WinUser.h 的完整 union 布局为 **40**。
- SendUnicodeText / SendReturnKey 将 `Marshal.SizeOf<INPUT>()` 传入 cbSize，因此当前
  受测 C# 会传入错误的 32。没有为该诊断再发送任何输入。

[微软 INPUT 定义](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-input)
包含 Mouse/Keyboard/Hardware 联合体；[SendInput 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
明确规定 cbSize 不等于 INPUT 大小时调用失败。该声明错误足以导致本轮失败，不应归因于
Chrome 页面树、URL 安全门或缺少 SetFocus。原始结果未记录 GetLastError/实际插入数，
不能额外声称已观测到某个具体 Win32 错误码；修正后仍要确认是否有其他独立问题。

### Rust：输入已发生，确认不足；Enter unknown 符合现有合同

原即时读取返回 readback_unavailable，而随后三次相同目标/RuntimeId 的值都正确。
这支持排查兼容输入的读回时序，但目前错误类别合并了缺 Pattern、读失败和不匹配，
尚不能区分具体是哪一种。不得把它写成已证明的某个 Chromium 缓存机制。
Enter 则本来就没有通用业务结果读回；页面导航已发生也不能直接改写其 helper 状态。

### 下一步（本轮没有执行）

1. 先只修 C# INPUT 布局，加入实际大小/偏移断言和实际插入数/Win32 错误诊断，复测同一
   pilot。补全 union 是满足 ABI，不代表引入鼠标操作能力；授权/焦点/单次派发边界不变。
2. 单独对兼容文本的当前值采样，再对齐同身份、有界、只读确认；不能通过重复输入重试。
3. Enter 保留原 outcome。若要产品任务级“导航已完成”，需要明确共享宿主的目标绑定与
   导航确认合同，不把测试页 oracle 直接当作生产 URL 校验器。
4. 最后再扩展到 default/complete 各三轮，以及安全和兼容授权回归。

本轮没有修改或重编 helper；两个 helper 的构建指纹仍与本文开头一致。

## ABI 修复后的 pilot v3（07:58:05–07:59:18 UTC）

证据：`browser-results-navigation-pilot-v3.json`。使用新构建的 C# 与 Rust，default
模式各 1 轮；前台等待窗口为 30 秒。两端各自完成 observe、兼容文本输入和 Enter，
没有重复派发。

| 项目 | C# | Rust |
|---|---|---|
| observe | execution pass（网页控件已观察到） | execution pass（网页控件已观察到） |
| compat 文本 | execution/contract **pass**；`verified/value_readback_match` | execution/contract **pass**；`verified/value_readback_match` |
| 输入独立证据 | 三次同 RuntimeId 读回均为 `compat-browser-text` | 三次同 RuntimeId 读回均为 `compat-browser-text` |
| Enter 派发 | 1 次；页面 A 恰好 1 次 Enter，page-B load+ready | 1 次；页面 A 恰好 1 次 Enter，page-B load+ready |
| Enter helper | `unknown/readback_unavailable` | `unknown/enter_readback_unavailable` |
| Enter 任务结论 | execution unknown，contract pass | execution unknown，contract pass |

这次证明 C# 之前的 `SendInput` ABI 阻塞已解除：新 helper 初始化报告
`pointerSize=8,inputSize=40,unionSize=32,sendInputCbSize=40`，并通过 `InputAbiTests`
（x64；同时保留 x86 期望断言）。C# 和 Rust 的输入页面结果现在一致；Enter 的
`unknown` 仍是有意保留的 helper 读回合同，不是把页面 oracle 偷换成 helper 成功。

新增/更新的构建指纹：C# EXE
`501DF0A8AA66721065B5747EA8DA16E6211088EAEC16F089A0AD43E28CA09353`；Rust release EXE
`334C3ECEB4A7566C62667BFF3A0BB1569DC4B164ECF11E0F059606E0AD52CA4B`（以实际文件哈希为准）。

### 当前判断

- 已修复：C# x64 `INPUT` union 截断导致的 `SendInput` 失败；两端兼容文本现在都有
  有界、同身份、只读读回，pilot 中均验证通过。
- 仍未闭环：Enter 的 helper 侧没有通用业务结果读回，故仍 unknown；网页独立 oracle
  证明导航发生，但不升级 helper 状态。
- 仍需测试：complete 模式多轮矩阵，以及 Win32/WPF/WinUI/UWP/Electron/Chromium/
  LibreOffice 的完整任务集。default 模式网页树可见性、共享浏览器后端和 URL 安全校验
  也不能仅凭本 pilot 宣布稳定。

下一步应以 v3 新二进制先跑 complete 模式 3 轮，再做安全/生命周期回归；之后再扩展
真实应用任务。若产品需要 Enter 任务最终为 verified，需另行定义并实现共享宿主的目标
绑定与导航确认合同，而不是修改现有 unknown 语义。

## 最终字段修正后的 pilot v4 与基础回归

`browser-results-navigation-pilot-v4.json` 使用最终 `sendInput` 诊断字段构建重新执行；
C#/Rust 的 default 单轮结果与 v3 一致：observe 2/2、compat 文本 execution+contract
4/4，三次同身份读回均为期望文本；Enter 两次各派发一次，页面 A 恰好一次 Enter，
page-B load+ready 均成立，helper 仍为 unknown（C# `readback_unavailable`、Rust
`enter_readback_unavailable`），因此 Enter execution 不升级。

正确 #4318 fixture 的基础回归保存为 `comparison-results-navigation-fix-v2.json`：
Rust lifecycle 34/34、protocol 3/3；C# 首次 lifecycle 33/34 的 C5a 取消竞态随后用
同一最终 EXE 单独重跑为 34/34，protocol 3/3。错误使用 WPF fixture 的那次结果
`comparison-results-navigation-fix-v1.json` 仅作为误用记录，不计入能力结论。

最终 C# apphost SHA256 为
`501DF0A8AA66721065B5747EA8DA16E6211088EAEC16F089A0AD43E28CA09353`，Rust release
SHA256 为 `334C3ECEB4A7566C62667BFF3A0BB1569DC4B164ECF11E0F059606E0AD52CA4B`；
最终 C# DLL 为 `E8A9B9DCD81E77DA0175072EAF1F31FC2A00C255608518445400421BA98E74D5`。

最终完整 #4318 正确 fixture 汇总见 `comparison-results-navigation-fix-final.json`：
C# 与 Rust 均为 lifecycle 34/34、protocol 3/3，合计 74/74 checks；该文件替代前一轮
C5a 取消竞态的中间结果作为最终基础回归证据。

## 发布产物与冷启动测量

使用 `publish.ps1` 生成 self-contained `win-x64` 单文件后，发布版 C# helper/fixture
再次通过完整 lifecycle（0 failures）。C# helper 发布文件为 188,298,703 bytes，Rust
release helper 为 466,944 bytes；Rust 产物的 clean-machine 运行时依赖尚未在另一台
机器确认，不能仅凭文件大小作最终选型结论。三次冷启动到 `initialize` 响应的本机样本为：

| helper | handshake samples |
|---|---|
| C# published single-file | 133.67 ms / 119.81 ms / 157.04 ms |
| Rust release | 83.39 ms / 85.98 ms / 71.88 ms |

这些是开发机交互桌面测量，不包含首帧截图和真实应用动作延迟；下一轮跨电脑测试仍需
记录进程工作集、首帧、原生依赖和无 SDK/.NET 环境结果。

## complete 模式三轮矩阵

`browser-results-navigation-complete-v1.json` 使用最终 C# / Rust release 构建，
`force-renderer-accessibility-complete` 模式各执行 3 轮（共 6 个 subject、18 个 task）：

- observe：6/6 execution pass；
- compat 文本：6/6 execution+contract pass，三次同 RuntimeId 读回均为
  `compat-browser-text`；
- Enter：6/6 一次派发，独立页面 oracle 6/6 确认 page-A 恰好一个 Enter、同 run 的
  page-B load+ready；helper 仍为 C# `unknown/readback_unavailable`、Rust
  `unknown/enter_readback_unavailable`，故 execution 仍按合同记 unknown，不被 oracle
  偷换升级。

该三轮结果没有新的 fail 或 blocked，说明 ABI 修复和文本读回在 complete 模式下可重复；
Enter helper 读回合同仍是当前唯一未闭环项。

## complete 模式语义动作三轮矩阵

`browser-results-semantic-complete-v1.json` 继续使用相同的 6 个 subject（C#/Rust 各 3
轮），执行 `set_value`、语义 scroll、语义 click，共 18 个 task：execution 和
contract 均为 **18/18 pass**，没有 unknown、fail 或 blocked。

- `set_value`：两端均 `verified/value_readback_match`；
- scroll：两端均 `verified/scroll_position_readback_changed`；
- click：C# `verified/invoke_dispatched_no_state_readback`，Rust
  `verified/invoke_action_result`，页面 click oracle 均通过。

至此，测试 fixture 上 complete 模式的 observe、set_value、文本输入、scroll、语义
click 和页面 Enter 导航均已重复验证；Enter helper 侧仍按合同保留 unknown。下一阶段
应转向真实应用矩阵，而不是继续在 fixture 上改 oracle。

## 生命周期/显式 HWND 复核（2026-09-02 追加）

重新构建最终 C# 与 Rust release 后，C# `lifecycle-driver.mjs` 的 C4/C5a/C5b/C5c/C6、
窗口重建（ID）和父进程退出（PD）共 **0 failures**；Rust `rust-driver.mjs` 在同一
WinForms fixture 上的握手、observe、WGC capture、语义动作、取消、shutdown 和重启
快照失效检查也全部通过。

探针第一次出现“Rust observe returned elements=0”，原因不是 Rust 把空树当成功，而是
测试进程传入了旧 fixture 的 HWND；本机同时残留多个同名 fixture，`MainWindowHandle`
在进程重启/窗口重建后不能作为长期缓存身份。改为从 Rust `list_windows` 重新枚举，按
标题和 PID 核对当前 HWND 后，协议检查完整通过。后续测试必须把 HWND 当作一次性选择：
每次动作前沿用快照中的 HWND/PID/进程启动时间/windowGeneration，并在需要时重新枚举；
不能仅按标题或复用旧窗口句柄。

## WPF 桌面任务复测

`app-task-results-final-v1.json` 使用最终 C# / Rust release 构建运行 WPF fixture：
桌面语义 `set_value/click/select/toggle/scroll` 共 **10/10 execution pass**，安全
合同 10/10 pass；typed Enter 两端均为预期 `blocked/refused`。兼容文本两端均为
`unknown/value_readback_timeout`（一次派发、snapshot/authorization 均已消费），
兼容 Enter 两端均为合同规定的 unknown；没有 fail。

这说明下一项应排查 WPF 的 SendInput 后 ValuePattern 提供者读回时序，并补充独立的
控件身份/值证据；不能把 timeout 改成 verified，也不能重复派发输入。Chromium
complete 矩阵已通过，WPF 兼容读回是当前真实桌面路径的下一个待验证点。

随后将兼容任务前置状态修正为空值并复跑：`app-task-results-final-v4.json` 两端均为
6/8 execution pass、8/8 contract pass。两端 `compat_type_text_authorized` 都为
`verified/value_readback_match`；Enter 仍为预期 unknown，typed Enter 仍为安全
blocked。此前 v3 中 Rust 的单次 `comtat-text` 是偶发注入/读回抖动，v4 未复现，暂不
改动 Rust 派发策略；后续真实应用矩阵需保留重复轮次以捕捉此类低频差异。

## Calculator 只读 UIA 探针

使用 Computer Use 选取唯一的系统 Calculator 窗口（HWND `1115970`），只做截图和
UIA observe，未点击最小化/关闭、未写入计算表达式。C# 结果为 24 个节点，但该
绑定未暴露可执行模式；Rust direct-COM 结果为 49 个节点，显示区暴露 `Value`，
标题栏按钮暴露 `Invoke`。原始结果分别保存在
`calculator-observe-csharp.json` 和 `calculator-observe-rust.json`。这进一步说明
真实应用矩阵必须分别记录 provider 能见度和动作结果，不能用一个语言的节点数推断
另一个语言的能力，也不能把只读 observe 当成动作成功。

## 真实应用可用性与 Notepad 探针

只读探测结果保存于 `real-app-probe-latest.json`：Chrome 可用；LibreOffice 未安装；
Calculator/Notepad/Paint UWP 包存在，但尚未对用户文件做任何操作。

对隔离的空白 Windows Notepad 窗口，C# 观察到 79 个节点，但 `Document` 没有
Value/Scroll pattern，故输入任务安全 blocked；Rust 观察到 34 个节点，其中文档节点
暴露 `Value+Scroll`。Rust 的一次 `set_value("maka-notepad")` 实际改变了文档值，随后
因窗口标题变化触发严格代际重验证而返回 `unknown/post_revalidation_failed`；新的
只读 observe 能读到 `maka-notepad`。该结果保留为真实 UWP/Win32 provider 差异证据，
不把未知结果升级为成功，也不放宽 HWND/进程/窗口代际身份边界。
