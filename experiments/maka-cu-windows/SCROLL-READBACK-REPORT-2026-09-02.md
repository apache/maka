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

# Directional scroll confirmation repair / 方向滚动确认修复

结论：本地 Chrome 滚动确认问题已修复。两边 default/complete 各三轮，滚动 **12/12 pass**；
最终真实滚动 provider **48/48**、安全/截图/生命周期 **74/74**、既有 Value provider **18/18**
回归均通过。只代表本文范围，不代表全部真实应用/网页任务通过。

日期：2026-09-02。范围只包括滚动位置证据、单次 Scroll 后的有界读回、对应合同与测试。
未加入 CDP、浏览器扩展、坐标操作，也未修改键盘、Enter、选择或导航实现。
当前会话无法切换到用户指定的 Luna/high，已明确说明；本轮未启动子代理。

## 修复前证据

- `browser-results-scroll-v1.json`：旧版 C#/Rust × default/complete × 3 轮，页面都滚动，
  helper 都 unknown，完整任务 **0/12 pass**。不能追溯改写成成功。
- `browser-results-scroll-diagnostic-v1.json`：这次初次诊断两边均未取得前台；无滚动派发，
  不计执行失败或成功。旧 harness 的占位 task reason 写成 deadline，subject 的实际原因
  是 `environment_foreground_not_acquired`。新版 harness 已保留实际阻塞原因和 desktop 证据。
- `browser-results-scroll-diagnostic-v2.json`：保持旧滚动判定，仅增添 observe 的 Current
  百分比。两边 default 各 1 轮，都返回位置未变/unknown；随后三次读同一目标和 RuntimeId，
  位置均为 **31.224489795918366%**，动作前为 **0%**。页面 scrollTop 为
  **122.4000015258789**，每轮一个 act。

这证明旧即时确认与随后可读状态不一致，支持修复读回新鲜度/时序；不证明 Chromium
内部的具体调度机制。诊断中的 delayMs=0 是等待页面 oracle 后立即 observe，**不是**
Scroll 返回瞬间，不能拿它估计浏览器缓存延迟。C# 旧代码还可能选 cached pattern 属性，
Rust 原已读 Current；不能把两者都归因为 C# 的 Cached 路径。

## 实现与明确的合同变化

- 两边 preflight 均使用 Current ScrollPattern；只操作授权元素自身，不找祖先容器。
- 不可滚动轴、百分比非法、所请求方向已经到边界，均在派发前 refused。
- no_amount 仍接受语法，但结果为 `refused/scroll_no_amount`，不宣称发生滚动。
- Scroll **只调用一次**。之后重新获取 Current pattern，检查同一窗口身份和 RuntimeId，
  最多 1000 ms / 21 次，只对未变化的位置做间隔最多 50 ms 的只读重试。
- 仅接受有限、范围 [0,100]、沿请求方向变化的位置。反方向、异常数值、丢失可滚动轴、
  身份变化、读取错误、取消、超时均 unknown；派发抛错也 unknown，因为可能已经发生副作用。
- `outcome.readback` 增加滚动来源、方向、幅度、beforePercent 和有限长度 samples。
  非有限或无效读取证据序列化为 null，不伪造为 0。
- 保留外层最终窗口复核；内层匹配不能覆盖外层 unknown。后续 observe/page oracle
  不改写原 outcome。
- **合同确实收紧了**：private contractVersion 0.1.0 → 0.1.1；ScrollItem-only 不再提供
  directional scroll action，也不能由 act 悄悄调用 ScrollIntoView。两边都删除该 fallback，
  没有新增 scroll_into_view 操作。wire name 仍为 `maka.cu.windows/0`。

主要文件：

- C#：`src/Program.cs`, `src/ScrollReadback.cs`
- Rust：`../maka-cu-windows-rust/src/main.rs`, `../maka-cu-windows-rust/src/scroll_readback.rs`
- 公共合同：`protocol-contract.json`, `PROTOCOL_CONTRACT.md`
- 测试：`scroll-readback-cases.json`, `tests/ScrollPolicyTests`,
  `fixture/ScrollReadbackFixture`, `scroll-readback-harness.mjs`, `browser-task-harness.mjs`

## 确定性与真实 provider 测试

- C# / Rust 共用 **30 项策略向量，各全部通过**：11 preflight + 19 readback。
  包含方向、边界、NaN/Infinity/越界、-1 sentinel、取消、迟到匹配和冻结时钟硬次数上限。
- `scroll-readback-results-v1.json`：**48/48 测试断言通过**，每 helper 24 项。
  其中每 helper 8 项是纵/横 × 大/小 × 正/反方向的延迟成功；其余是 negative/control 检查，
  **不能把 48 项都称作成功用户任务**。
- 真实 WPF IScrollProvider 立即修改实际位置并输出独立 mutation 事件，UIA 故意延迟
  350 ms 才呈现新位置。两边首个 probe 都为 40%，随后变为 60% 或 20%，需 **5–7 次**
  probe；读回阶段耗时约 **347–423 ms**。阶段计时晚于 provider 内部 mutation 时间。
- 每个已派发案例恰有一个 Scroll mutation，轴/幅度参数与请求一致。所有案例零
  ScrollIntoView 调用；每个 snapshot 故意重放的安全测试均被拒绝且无第二次副作用。
- cancel-after-mutation 两边均在第一个 probe 期间/之后收到取消并返回 unknown；不宣称
  覆盖所有取消竞态。无效前态/不可滚动/no-op/边界/ScrollItem-only 均零 mutation。
- late-match 两边在约 1122/1128 ms 读到位置 60%，仍返回 timeout/unknown。
  原生 COM 调用不是可中断的：1000 ms 是验证接受预算，不是请求绝对耗时上界。
- 随后加强真实 fixture：只改变所请求轴，另一轴保持原值，并断言 report 的轴、幅度、
  source、before/最终百分比。`scroll-readback-results-v2.json` 再次 **48/48 通过**，
  它是最终 fixture/harness 的匹配证据；v1 原记录保留。此次延迟案例需 4–7 次 probe，
  C# 阶段耗时 383–485 ms，Rust 342–398 ms。两轮均只派发一次实际 Scroll。
- 既有 Value 策略 12 项仍通过；Rust 8 单元 + 3 协议测试通过，clippy `-D warnings` 通过。
  oracle 单测 13/13 通过。

## Chrome 与回归结果

`browser-results-scroll-readback-v1.json`，07:23:08–07:28:48 UTC：

| Helper | default | `=complete` |
|---|---|---|
| C# | 3/3 pass | 3/3 pass |
| Rust | 3/3 pass | 3/3 pass |

**滚动任务 12/12 pass**；连同 observe 为 24/24。每轮 exactly one act / one page scroll
event，helper verified 与页面独立证据同时满足。每轮 Current 百分比 0→31.224489795918366，
页面 scrollTop 0→122.4000015258789。36 次事后 observe 均匹配原目标和 RuntimeId。

这次真实 Chrome 也确实用到了重试，而非首读就成功：

- C# 六轮均 3 次 probe，读回阶段 157–200 ms，先两次 0%，第三次位置改变。
- Rust 一轮 3 次、五轮 4 次 probe，150–224 ms，初次均 0%，随后才出现新位置。

因此，在这些受控案例中，旧即时读回导致未确认的判断已有直接时序证据；单次滚动后的
有界只读确认能够消除该问题。它仍不是 Chromium 内部实现根因的独立证明，也不是固定
等待 150/200 ms 就保证成功的依据。未使用事件订阅“唤醒”、anti-occlusion 参数或 CDP。

同一 helper 构建的最终回归：

- `comparison-results-scroll-readback-v1.json`：**74/74**，其中生命周期/截图 34×2，
  协议 3×2。包括 WGC 遮挡像素、取消前后结算、provider 挂起时控制面响应、grace 后终止/
  重启、旧 token、窗口重建、父进程退出、EOF/背压。
- `value-readback-results-scroll-regression-v1.json`：既有真实 Value provider **18/18**。
  没有把 Rust readback 报告容器的类型调整造成 SetValue 输出回归。
- 最终核对 C# DLL / Rust EXE 指纹未变，Scroll/Value native 报告对应同一组 helper。
  结束时没有匹配的遗留测试 helper、fixture 或测试 profile Chrome 进程。

本轮没有重跑 Chromium 点击或完整输入/Enter/导航；前轮这些任务的记录仍应按其原始
构建指纹和结论引用，不能将本次滚动全绿当作它们的新证据。

## 构建指纹

本轮最终 helper（不是旧诊断版）：

- C# code DLL SHA256：`3620D0D70A9472182F3BD7290A352FC648174ABE2F5183E94AC682A6832E3C2D`
- Rust EXE SHA256：`36AC2546CB285E21A0FD4576A749DD6A23D95F497FDAE8006ADDB341D7C18C0E`

机器、Chrome 版本、入口和依赖闭包指纹见 browser JSON。C# apphost EXE 本身的 hash
不代表 DLL 代码；本轮仍是开发机 framework-dependent 构建，未重新发布自包含包。

## 复现

在仓库根目录 PowerShell 执行；各 GUI 批次顺序运行，期间不要切换焦点：

```powershell
$cs = 'experiments/maka-cu-windows/src/bin/Release/net8.0-windows10.0.22621.0/maka-cu-windows.exe'
$rs = 'experiments/maka-cu-windows-rust/target/release/maka-cu-windows-rust.exe'
dotnet run --project experiments/maka-cu-windows/tests/ScrollPolicyTests -c Release
& 'D:\rust\rust\.cargo\bin\bin\cargo.exe' test --manifest-path experiments/maka-cu-windows-rust/Cargo.toml
node experiments/maka-cu-windows/scroll-readback-harness.mjs $cs $rs `
  experiments/maka-cu-windows/fixture/ScrollReadbackFixture/bin/Release/net8.0-windows/ScrollReadbackFixture.exe `
  experiments/maka-cu-windows/scroll-readback-results-retest.json
node experiments/maka-cu-windows/browser-task-harness.mjs $cs $rs `
  --modes default,force-renderer-accessibility-complete `
  --tasks chromium_observe_page_controls,chromium_scroll_capability `
  --settle-ms 2000 --repetitions 3 `
  --out experiments/maka-cu-windows/browser-results-scroll-readback-retest.json
node experiments/maka-cu-windows/comparison-harness.mjs $cs $rs `
  experiments/maka-cu-windows/out/handoff-hang/maka-cu-windows-fixture.exe `
  --out experiments/maka-cu-windows/comparison-results-scroll-readback-retest.json
```

## 未覆盖及下一步

这不是所有 Chromium/真实应用任务全通证明。原生 provider 测了双轴和四种幅度，但真实
Chrome 批次只请求 vertical/large_increment，不能推广到嵌套容器、任意网页或应用。
验证“百分比朝目标方向改变”也不证明业务任务完成、像素距离精确，或排除并发外部滚动。
仍依赖受控目标、单次调用证据和独立页面 oracle。

没有重新证明深度遍历/极端 provider 的硬时间界限：Rust 仍用整树 FindAll，
C# 的节点/深度/时间预算也不能打断单个 COM 调用。没有真实的同窗子元素替换矩阵，
本轮真实身份失效测试是窗口 generation 改变与关闭；RuntimeId 检查保留在代码和策略中。

后续应单独验证授权文本输入、Enter 和完整导航链；然后扩展 Win32/WPF/WinUI-UWP/
Electron/LibreOffice 的真实任务矩阵。干净机器、自包含包、内存/启动/首帧和维护成本仍需
独立评估。本轮不据此选择 Rust 或 C#，`distributionReady` 仍为 false。
