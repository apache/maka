Nesting is a declared, tested feature here — and the log you pasted shows the documented contracts firing around it, not a mix-up nesting causes. What decides each piece:

**Nested groups are supported, and the hard case you describe was built deliberately.** A group's members can be `group/<id>` (`internal/provider/group.go:205`), groups among members are tested (`TestGroupsInGroups`, `internal/provider/groupnest_test.go:8` — each routed as it says, a loop refused when saved), and a rule can name a nested subgroup (the test's own rule does). The exact sharp edge you point at — the same model living in two subgroups, a rule naming the later one — was handled twice: #2361 (`fa725d47c`, v0.1.1258: "a rule naming a group in the group that shares its models with one ahead of it sends the turn there, in that group's own order, not unready") and #2407's refinement (`43fef0697`, v0.1.1259). A model reachable through two subgroups is met once and keeps both places; a rule naming either finds it there (`internal/provider/group.go:1376`: "a rule naming this group still finds it here (#2361)"; `Member.In` covers the other places, `group.go:437`). Your 0.1.3749 is far past both.

**What your log shows, line by line, is the contracts:**

- "第 7 轮开始时命中规则 4（意图是"Coding"），先发给 路由组 【AGENT集群】SUB2" — the rule fired at the turn's start and SUB2's members were put first (`internal/gateway/rules.go:4`: a rule is looked at when a user's turn begins, and what it decided holds for the rest of the turn).
- The wall of exclusions — accounts 已用 100% kept 仅在其他都无法响应时使用, accounts and keys resting on 429, members excluded for context windows — is the ranking around them.
- "留在 账号A：…正在第 7 轮内回传工具结果，此时换账号会丢掉厂商为它缓存的内容" — the within-turn stay: a conversation stays put while the agent sends tool results back, until you speak again (`internal/gateway/affinity.go:11`; the Agents page says the same: 「一轮之内（Agent 回传工具结果时）不换；你再次发言时，路由重新决定。」).
- "Unready: the member the rule names has nobody to take it now, and the group routes the request as it would without the rule" (`internal/gateway/rules.go:49`) — when SUB2 can't take the turn, the fall-back is the group's own order, and whoever holds the turn's cache takes it. That is how a Coding request answered from SUB1's account A.

And your own log answers the "same model in both subgroups" hypothesis: the turn ended on 模型H, not the shared 模型甲 — the name collision is not what routed it; the stay and the fall-back order did.

**One thing in the paste stops a real misroute from being read:** the block cannot be one request's trace — it has account A both "正在休息（429 · 限流…），排在最后" and "正在回答…" — so it is several traces merged, and per-request correctness can't be judged from it yet.

**What decides it:** one request's route detail from the Requests page — the rule section (`n`, `use`, `unready`, `instead` are the trace's own fields) and its try list. If a trace shows the rule naming SUB2 while SUB2 had a ready member, and the turn went elsewhere with no `unready`/`instead` mark — that is a bug, and I'll take it as one with that trace. Otherwise what you saw is the recorded trade: an intent rule ranks its subgroup first when the turn begins; a subgroup nobody can take right now falls through to the group's order; and a turn mid-tool-results stays on whoever holds the vendor's cache until you speak again.

**For the maintainer, the design question behind it** (policy on the current contracts, not patch-sized without a say): should a rule's subgroup outrank the within-turn stay — moving a mid-turn conversation to satisfy the intent and paying a fresh cache — or should the fall-back prefer a sibling subgroup that serves the same model before the group's plain order?

Not verified: your real accounts and a single request's unredacted route detail (everything above is your pasted log plus the code at `6acf5ee5c`); a live reproduction (no Windows Server and no DeepSeek accounts here); whether the merged traces hide one real misroute — the route detail decides.

Attribution: written with GLM-5.3-Flash (ZCode); I've read every path cited above. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
