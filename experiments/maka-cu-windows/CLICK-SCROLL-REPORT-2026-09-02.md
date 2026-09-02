# Chromium 语义点击与方向滚动对照

日期：2026-09-02。范围仅为本地测试页的 Invoke 点击与容器向下大步滚动。
本轮没有修改、重编 helper，没有运行键盘、Enter、选择或导航。
当前会话不能切换到 Luna/high，已说明；仅修改测试断言与证据记录，未启动子代理。

## 公平性与安全边界

- C# 与 Rust 使用同一页面、脚本、等待和判定。default 与显式 `=complete` 分组。
- 每种语言每种模式各 3 轮；点击与滚动使用不同的新窗口/独立临时 profile。
- 先 observe，再等 2 秒 observe；只在准确目标出现且具有所需 Pattern 时授权动作。
- 点击要求 `web-button` / `Apply semantic click` / Invoke，滚动要求
  `scroll` / `Web scroll region` / **ScrollPattern**，两者均保留 RuntimeId。
- 保存原窗口身份、snapshotId、实际元素 token、Pattern 和完整 RPC 请求/结果。
- 滚动只用容器自己的 token；不拿输入框 token 向祖先派发。
- helper 中原有 ScrollItem fallback 没有删除，但测试不接受仅有 ScrollItem 的目标；
  若结果显示 `scroll_item_dispatched`，也不计为方向滚动成功。
- 不把安全拒绝或 unknown 计为任务成功；页面完成和 helper outcome 分开保留。

当前构建仍是上一轮已完成 74/74 基线回归的产物（本轮没有重复运行该基线）：

- C# DLL SHA256：`3FB923ADD243F2EE679AC9B68185C59C84799C66EB5DE73746CD8C69C09E22EE`
- Rust EXE SHA256：`E798F809C9562211ABEC3DD6AFF1E450493042A44580E6FC15C89C1299303C8B`

## 本轮修正的测试判定

旧 `pageAScrolled` 使用“发生 scroll 事件 **或** 位置增加”，可能将位置未变或反向的
scroll 事件误判为成功。现要求 page A 的 scroll 事件存在，且实际 scrollTop 大于
动作前值。本轮仅测试 vertical / large_increment，不推广到其他方向或边界。

点击原来只要求 count >= 1，现要求 page A 的点击计数恰好增加 1，并额外等待
250 ms 再确认；乱序到达的较小计数不会掩盖已经出现的较大计数。
该有限观察窗口不是对未来永不重复的保证。

文件：`browser-task-harness.mjs`、`oracle-state.mjs`、`oracle-state.test.mjs`。
oracle 测试为 **13/13 通过**，新增无位移/反向滚动和重复/乱序点击的反例。
未修改页面 fixture；未改变先前输入与导航 oracle 的判断规则。

## 语义点击：完成

证据：`browser-results-click-v1.json`，06:11:59–06:15:59 UTC。

| 语言 | 普通 Chrome | `=complete` |
|---|---|---|
| C# | 3/3 pass | 3/3 pass |
| Rust | 3/3 pass | 3/3 pass |

共 **12/12 点击任务 pass**，每窗 act 请求数=1、页面 click 事件数=1、计数 0→1，
观察前均 `targetIsForeground=true`。包括 observe 的任务数为 24/24。

helper 的 verified 不是按钮业务状态的独立证明：C# 的 verification 为
`invoke_dispatched_no_state_readback`，Rust 为 `invoke_action_result`。
本轮任务成功是结合页面独立事件/计数确认的，没有将 Invoke 返回成功本身当成页面完成。

## 方向滚动：页面已完成，helper 全部 unknown

证据：`browser-results-scroll-v1.json`，06:16:26–06:20:41 UTC。

| 语言/模式 | 页面方向位移 | helper outcome / 任务结果 |
|---|---|---|
| C# default | 3/3 完成 | 3 unknown |
| C# `=complete` | 3/3 完成 | 3 unknown |
| Rust default | 3/3 完成 | 3 unknown |
| Rust `=complete` | 3/3 完成 | 3 unknown |

所有 12 轮：

- 观察前 `targetIsForeground=true`。
- 唯一 act 请求使用目标 `automationId=scroll` 的自身 token，与 requestEvidence 一致。
- 候选确实具有 Scroll 和 ScrollItem 两种 Pattern，但均未返回 `scroll_item_dispatched`，
  `usedScrollItemFallback=false`。
- 请求为 vertical / large_increment；每轮一个 scroll 事件，容器 scrollTop 均从
  **0 增加到 122.4000015258789**。这不是仅有事件、没有位移。
- C# reason 为 `scroll_position_unchanged_after_action`、verification 为 `readback_mismatch`；
  Rust verification 为 `scroll_position_unchanged_after_action`。
- 两边均 status=unknown、snapshotSpent=true、applicationCompleted=true。
  包括 observe 的 24 项中，12 observe pass、12 scroll unknown；没有把页面完成改写成
  helper verified，也没有重发滚动请求。

源代码核对：C# `ScrollVerified` 与 Rust scroll 分支都在 Scroll 调用返回后立即比较
前后 UIA 滚动百分比，目前没有 SetValue 那样的有界读回。
因此现有证据不支持“滚动未执行”或“只缺聚焦”，而支持优先排查确认时序/新鲜度。
本轮没有采样随后同一容器的 UIA 滚动百分比，尚不能证明具体缓存或延迟机制，
也不能直接保证照搬 SetValue 的等待参数就一定解决。

## 下一步建议

只进入滚动确认修复，不同时修改键盘或导航：

1. 对同一已验证容器、同一 RuntimeId 重新获取 Current ScrollPattern，先记录动作前
   滚动百分比，再单次派发，之后有界只读重试；保存方向、前后数值与尝试次数。
2. 验证方向与位移，处理不可滚动、已到边界、无效百分比、身份变化与取消；
   不把任意数值不同都当成正确方向，不重复派发动作。
3. 用真实延迟 provider 验证重试/超时，再跑本轮两个模式各三轮，保留页面独立证据。
4. 方向滚动不能静默回退为 ScrollIntoView；若要修改现有兼容分支合同，应单独明确
   `scroll` 与 `scroll_into_view` 的行为和兼容策略。

本轮测试结束后未发现匹配的遗留测试进程；helper 构建指纹与开测前一致。

## 复现

```powershell
node experiments/maka-cu-windows/browser-task-harness.mjs <csharp.exe> <rust.exe> --modes default,force-renderer-accessibility-complete --tasks chromium_observe_page_controls,chromium_semantic_click_and_status_readback --settle-ms 2000 --repetitions 3 --out <new-click-results.json>
node experiments/maka-cu-windows/browser-task-harness.mjs <csharp.exe> <rust.exe> --modes default,force-renderer-accessibility-complete --tasks chromium_observe_page_controls,chromium_scroll_capability --settle-ms 2000 --repetitions 3 --out <new-scroll-results.json>
```

## 后续范围

本轮结论限于本地页面、前台窗口和当前构建。不能据此宣布完整网页导航或真实应用矩阵
全部打通；窗口首次 UIA 就绪、ScrollItem 合同歧义、真实深层树、干净机器与性能选型
仍是独立事项。未添加 CDP、anti-occlusion、事件订阅或聚焦技巧，未重跑独立 computer-use。
