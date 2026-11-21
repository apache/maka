# hunt80-g：#1475 patch nameless drop + ids.mend 复活 RED 核验（H7）

## 结论
- **RED 坐实**（断言级失败，非编译错/跳过）。
- **关键事实修正**：该 bug **不在 upstream/main**，而在我们挂在 issue #1475 的未合并 patch（分支 `hunt61-a-1475-unnamed-call`，head `474f0e5fd8ec1a3574497e1168e3580f0379f26c` = b97e0aa2 + patch）。主线程简报"读现行 main chattidy.go"的前提不成立：upstream main 无任何 nameless-call 处理（`git grep -i nameless 7b1faf99 -- internal/gateway/` 零命中；b97e0aa2..7b1faf99 零提交触及 chattidy.go/chat_call_ids.go）。
- 因简报预定的动作（upstream 开新 issue）基于被证伪的前提，公共动作前先问主线程，未擅自发帖。

## 机理链（worktree /tmp/magpie-hunt80-g，= patch head 474f0e5f）
- `internal/gateway/chattidy.go:205-212`：`t.nameless(choice, calls)` 返回 `kept==nil`（整段 calls 全 nameless 被丢）时只 `delete(delta, "tool_calls")`，**局部 `calls` 仍持原始字节**。
- `internal/gateway/chattidy.go:213-225`：`if calls != nil` 为真 → `t.ids.mend(choice, calls)`（chat_call_ids.go:89）对首片段无 id 的 call 补 `"call_"+newID()` 并 `delta["tool_calls"] = mended` 写回 → **复活**。
- manifest 必要条件：被丢 call **无 id**（带 id 时 mend 无改动、不重写 delta，保持已丢——现有测试全带 `"id":"call_up"`，故覆盖面内不触发，与 hunt79-c NOTES 遗留疑点一致）。
- 复活形态：`{"function":{"name":null,"arguments":""},"id":"call_18e189bf2aa880c800000001","index":0,"type":"function"}` —— `name:null` 原样随行（`withoutEmptyNames` 只删 `"name":""` 字符串，不删 null），正是严格客户端拒帧的形状（AI_InvalidResponseDataError: Expected 'function.name' to be a string，#1475 原报）。finish_reason 不受影响（`t.named[choice]` 仍 false，`"tool_calls"`→`"stop"` 翻转照常）→ "没有 call" 变 "坏 call"，比丢弃更糟。

## RED 证据
- 测试：`TestNamelessCallWithoutAnIDStaysDropped`（internal/gateway/chat_call_name_test.go，镜像 TestNamelessCallStreamDropped 但去掉首片段 id；流式 + name:null + 无 id + 后续 args 片段 + finish tool_calls）。
- RED 输出（修前）：
  `data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":null,"arguments":""},"id":"call_18e189bf2aa880c800000001","index":0,"type":"function"}]},"finish_reason":null,"index":0}],...}`
  断言失败行：`the call dropped for naming no function came back with an id`
- 一行修法验证：`chattidy.go:206` kept==nil 分支加 `calls = nil` → 新测试 + 守卫（TestNamelessCall*、TestNameAbsent*、TestChatCallsEndToolCalls、TestEmptyCallID*、TestStreamedCallGivenAnID、TestChatTidyGivesCallsAnIndex）全绿 → checkout 回退。
- 消融回红：回退后 RED 复现。全套定向跑唯此一败，无附带破坏。gofmt -l 干净。

## 分支留证
- 分支 `hunt80-g-chattidy-audit`（/tmp/magpie-hunt80-g，基座 474f0e5f）
- head `7d4b1a7b`（仅测试文件，+20 行；身份 ggbdpq <ggbdpq@gmail.com>；未推 fork）
- 修法一行未提交（按"先报告"原则，等主线程定去向）

## 待决
- 去向三选一：A) 按简报字面在 upstream 开新 issue——不推荐，repro 依赖未合并 patch，维护者在 main 上无法复现，形态错位；B) 修订我方 #1475 patch（一行修法 + 本红转绿测试并入，更新分支 hunt61-a-1475-unnamed-call + #1475 补更新帖）——NOTES 原注"值得单开 follow-up"的自然归宿，bug 在我方交付物内；C) 零动作回报。
