# SetValue 同身份有界读回：实现与验证

日期：2026-09-02。范围仅限 SetValue 结果确认及其回归；没有修改 click、scroll、
键盘/Enter 或浏览器接入。当前会话不能切换到 Luna/high，已向用户说明，未使用子代理。

## 实现

两边共同策略：

1. 使用已授权 snapshot/token，并在写入前消费 snapshot；SetValue 只执行一次。
2. 写入返回后启动 1000 ms 单调时钟预算，失配后间隔 50 ms（不超过剩余预算），
   另有 21 次探测硬上限。计时包含每次探测的身份校验和 Value 读取。
3. 每次检查原窗口 HWND/PID/进程启动时间/windowGeneration 和原元素 RuntimeId；
   对保留的同一元素重新获取 Current ValuePattern，读前/读后再确认身份与密码状态。
   不按名称换目标，不读 Cached.Value，不搜索 Document 文本。
4. 匹配且未超时才 verified；超时、取消、读取异常、密码保护、身份失效均停止确认，
   保留 unknown。迟到的匹配不能覆盖截止时间。取消不表示撤销已发出的写入。
5. `outcome.readback` 记录次数、耗时、预算、来源及验证阶段结果，不包含实际文本。
   外层 outcome 仍是最终结果，后置目标校验可以将验证阶段的匹配降为 unknown。

相关文件：

- C#：`src/Program.cs`、`src/ValueReadback.cs`。
- Rust：`../maka-cu-windows-rust/src/main.rs`、`src/readback.rs`（后者相对 Rust 项目）。
- 文档：`PROTOCOL_CONTRACT.md` 新增 SetValue readback 说明。

额外边界修正：C# SetValue 输入现在与 Rust 对齐到 1024 个 Unicode scalar 值；
两边拒绝超长读回。Rust 在 SetValue 返回错误后不再把“可能已写入”作为普通 RPC 拒绝，
而是 unknown；C# 对 COM 写入异常也明确保留 unknown。没有改变其他语义动作的执行路径。

单次 COM 调用仍可能阻塞，1000 ms 是调用之间的验证预算，不是 provider 硬超时。
原有控制线程、宿主取消宽限期、终止和重启边界继续负责兜底。
Window generation 仍包含可变窗口属性；名称变化触发保守失效的现有行为未放宽。

## 构建指纹

此轮测试使用以下产物，不与此前构建混合：

- C# `src/bin/Release/net8.0-windows10.0.22621.0/maka-cu-windows.dll`：
  `3FB923ADD243F2EE679AC9B68185C59C84799C66EB5DE73746CD8C69C09E22EE`
- Rust `target/release/maka-cu-windows-rust.exe`：
  `E798F809C9562211ABEC3DD6AFF1E450493042A44580E6FC15C89C1299303C8B`

两边 Release 构建通过，C# 0 警告/错误；Rust cargo test 7 单元测试（含下面 12 项
共享向量）+ 3 协议测试通过，clippy `--all-targets -- -D warnings` 通过。

## 策略与真实 provider 验证

`value-readback-cases.json` 的同一份 **12 项**向量分别由 C# console tests 和 Rust
unit tests 读取：立即匹配、两次失配后匹配、永久失配、读错误、身份变化、密码保护、
超长值、取消、探测期间取消、迟到匹配、剩余预算和时钟不前进时的次数上限。两边均通过。
这类纯策略测试不等于 UIA 本身已通过，所以另外新增真实 WPF ValuePattern provider。

`fixture/ValueReadbackFixture` 立即改变可见内容并输出独立 mutation 计数，但按场景让
UIA Value 延迟 350 ms、永久旧值、读取报错或密码保护。测试工具为
`value-readback-harness.mjs`，结果为 `value-readback-results-v2.json`：**18/18 通过**。

每边九个场景：

- 延迟值：C# 6 次探测、Rust 7 次探测，均约 395 ms 确认；实际写入各一次。
- 永久失配：约 1 秒后 unknown，没有重复写入。
- 写入后取消：unknown，保留原始 mutation 证据。
- 写入后密码保护 / 读取报错 / provider 写完抛错：unknown。
- 写入后关闭窗口 / 窗口名称使 generation 失效：unknown。
- 写入前密码保护：拒绝，零 mutation。
- 每个场景还显式尝试重放已消费 token，均拒绝且不增加 mutation。

纯策略测试覆盖探测中取消；实际 fixture 的取消由 mutation 事件触发，可能落在
第一次探测之前（Rust 此轮 attempts=0）或探测中（C# attempts=1），不声称覆盖了所有竞态。

## 首轮测试失败及修正

保留 `value-readback-results-v1.json`、`value-readback-results-fixture-diagnostic.json`
和 `value-readback-results-identity-diagnostic.json`。
首轮失败不是输入未发生：独立 mutation 计数为 1，但目标校验失效。
补查前后观察确认，同一 HWND 的 UIA Window Name 从 fixture 名称变为输入文本。
WPF 的单 TextBox 内容布局使 Window 的 UIA 名称随文本改变，触发了现有 generation 边界。

普通验证场景现在明确设置 Window 的 AutomationProperties.Name，使本次实验只控制
Value 的延迟；另保留 name-change 场景验证名称失效时不继续确认。没有修改 helper
身份规则来让测试通过，初始失败文件没有覆盖。

## 原有安全与生命周期回归

`comparison-results-readback-v1.json`：**74/74 通过**，两边各 34 lifecycle + 3 protocol。
覆盖目标 WGC 截图与遮挡隔离、取消前后语义、卡住后的终止/恢复、旧 token/snapshot、
窗口重建、宿主死亡/EOF 退出等已有检查。不是所有可能的安全性质的穷尽证明。
页面 oracle 测试重新运行 **11/11 通过**，未修改其任务完成判定。

## Chrome 对照

`browser-results-readback-v1.json`，2026-09-02 06:01:42–06:06:23 UTC，
Chrome `152.0.7977.64`，同一 browser-task-harness：default 与
`force-renderer-accessibility-complete`，observe + SetValue，每种语言每模式
3 轮独立窗口。所有窗口在观察前均记录 `targetIsForeground=true`。

| 当前新构建 | 普通 Chrome SetValue | `=complete` SetValue |
|---|---|---|
| C# | 3/3 verified + 页面完成 | 3/3 verified + 页面完成 |
| Rust | 3/3 verified + 页面完成 | 3/3 verified + 页面完成 |

合计 **12/12 输入任务 verified**，每轮独立页面恰好一个 input 事件；后续三次
同窗口/同 RuntimeId/正确值读回合计 **36/36**。加上 12 个 observe 任务，harness
共 24/24 pass，没有 blocked/unknown。测试结束后未发现本轮匹配的遗留测试进程。

普通模式首次观察仍为 0/4 可操作控件，等待 2 秒后 4/4；`=complete` 首次即 4/4。
因此没有修复“普通 Chrome 首次观察未准备好”这一独立问题。

这些 Chrome 样本的 `readback.attempts` **全部为 1**，验证阶段耗时 24–39 ms。
新鲜 Pattern 获取和新增身份检查本身也改变了读回时序，不能说这些样本证明了
“50 ms 等待”或第二次探测是唯一修复原因。真实 WPF 延迟 provider 的 6/7 次探测
才直接验证了重试路径确实能生效且没有重发 SetValue。

修复前另一次 `=complete` 对照中，两边各 1 verified / 2 unknown；此轮两边都为
3 verified / 0 unknown。构建指纹与原始结果分开保存，属于小样本回归改善，
不代表所有真实页面、机器和后台状态下的长期成功率。

## 复现入口

在仓库根目录运行（路径均在本实验内）：

```powershell
dotnet run --project experiments/maka-cu-windows/tests/ReadbackPolicyTests -c Release
node experiments/maka-cu-windows/value-readback-harness.mjs <csharp.exe> <rust.exe> <ValueReadbackFixture.exe> <new-result.json>
node experiments/maka-cu-windows/comparison-harness.mjs <csharp.exe> <rust.exe> <HangWindowFixture.exe> --out <new-result.json>
node experiments/maka-cu-windows/browser-task-harness.mjs <csharp.exe> <rust.exe> --modes default,force-renderer-accessibility-complete --tasks chromium_observe_page_controls,chromium_set_text_and_readback --settle-ms 2000 --repetitions 3 --out <new-result.json>
```

本轮没有加入 CDP、订阅事件、anti-occlusion 或聚焦技巧；没有重跑独立 computer-use。
仍未验证完整网页导航、其他真实应用矩阵、深层 UIA fixture、干净机器与性能基准。
