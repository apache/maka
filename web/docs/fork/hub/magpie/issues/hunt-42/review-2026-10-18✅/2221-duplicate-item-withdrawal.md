# #2221 复查报告（rev/a-gw 路，2026-10-18）——已撤回单的处置定性

审计基线：upstream/main `d783df46`。

## ① 现状复核

- issue 仍 **open**；我方 10-17 04:17 UTC 撤回评论在案（`issuecomment` 时间线核实），此后无维护者回合。
- 10-14 后该区域上游动态（`git log --since=2026-10-14` passthrough/responses/codex 相关）：
  - `f348025c` — #2222（孤儿 call 缺 output）已合并关单；
  - `919c8b93` — #2262（同一 call 的第二个 answer 在 Gemini/Responses 构建路径丢弃，`dropSecondAnswers`，与 Chat/Messages 既有 pairToolMessages 对齐）已合并，commit message 明说 "This differs from the issue's patch"：按 id 去重会误伤同 id 重呼、按 name 去重会丢真实答案，故只在协议真正拒绝的构建路径收窄处理；
  - 同 message 还确认 "pairToolItems (relayed Codex bodies) already keeps one answer per call and is unchanged"——即直通（relay）路径本来就有每 call 单答案的机制。
- `git log -E --grep '#2221' upstream/main` 零命中：没有任何提交引用本单，撤回无人跟进，也无第三方修复。

## ② 对抗检查（"若要提孤儿 call 新形状"的七问过筛）

维护者 10-14 探针已把「缺 output 的孤立 call」钉为真形状且**已经修掉**（#2222 → f348025c 合并）。用户侧再提即重复占坑。原始 400 证据源（vercel/ai#13307）被维护者定性为 `store: true`/`previous_response_id` 重放形状，与 magpie relay 的无状态 input 不同形；我方无 api.openai.com key，无法补真实失败——**新形状提案不满足"真实失败证据"，不发**。

## ⑤ 收益三句话（对撤回本身的核验）

撤回是正确处置：真实上游证据（维护者亲手探针，全 200）压过构造失败；继续挂着只会占坑并暗示还有一个待修缺陷。附近真正成立的两个形状（孤儿 call、协议拒绝路径的重复 answer）已分别在合并的 #2222/#2262 里以更窄的机制处理。

## ⑥ Verdict：WITHDRAW-CLOSE

撤回在案、前提被维护者实测否定、邻近形状已被合并工作覆盖（#2222 f348025c、#2262 919c8b93，且 relay 侧 pairToolItems 本就每 call 保一答）、无任何在途修复依赖本单。issue 由我方（报告者本人）开设，可自行关闭。**下一步最小动作**：发下方英文收尾稿并关单（正文无需再改）。

## 不自信清单

1. "pairToolItems keeps one answer per call" 取自 919c8b93 的 commit message，未重读该函数源码核实其确切作用范围。
2. 关单方式（报告者自行 close vs 请维护者 close）是礼节判断；若维护者有关单偏好（如等 triage），自行 close 无害但可能显得急。
3. 未排查 #2221 是否被其它 issue 以 "Duplicate item found" 关键词引用（只查了 commit 与 PR）。

## 英文收尾稿（发帖后 close）

```markdown
Closing as withdrawn. Your probes against the real upstream settled it:
on `chatgpt.com/backend-api/codex/responses` (gpt-5.6-luna, `store:
false`), every shape this patch defended against — a repeated
`call_id`, two `function_call_output` items for one call adjacent or
apart, duplicated `id`s — answers 200, so the "Duplicate item found"
the report built on has no failure behind it on the upstream magpie
relays to. The patch stands withdrawn (Oct 17).

The shapes nearby are covered by merged work since: the orphan call
missing its output in `f348025c` (#2222), and a second answer to one
call dropped where the protocol refuses it in `919c8b93` (#2262) — the
latter deliberately narrower than this issue's patch, and a relayed
Codex body keeps one answer per call (`pairToolItems`) as before.

Nothing left to hold this open for.
```
