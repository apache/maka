#2763 评论草稿（英文发帖；本地记录）

【事故记录 2026-10-18】首帖误用本文件直接 --body-file，中文内部记录头随正文公开（comment 6242594379）。
已 PATCH 为纯英文正文（/tmp/hunt42b-2763-comment.md），回读核验无中文残留。教训：草稿文件含内部记录时，
发帖正文必须单独落盘，绝不直接 --body-file 草稿原件。

判定：不发 patch。提案会推翻 #2247 的维护者裁决（8ef14be3e，10-14，来自我方交付），该裁决有锁定测试
（TestJevLeavesReasoningOff，decide_test.go:437）和产品 help 文案（groups_cli.go:108 "never one it
turned off (none)"），且 10-17 刚被第三方复验。属七问 #5 维护者已裁决事项。发跨链评论供分诊。

---

This is the behavior as decided in #2247, not an accident. There, the pick
was logged while the wire kept carrying what the agent asked, and turns
that turned reasoning off still spent a classifier call whose answer could
never go out — so the ruling (merged in 8ef14be3e) was: an `effort=auto`
group asks its classifier only for a turn the agent asked to reason in,
"never one it turned off (none)" — that sentence is now in `magpie group
--help` itself.

Each row of this report's table matches the code at today's main
(`5380114d`):

- `reasoning_effort: "none"` — parsed as reasoning off (`Request.ThinkOff`,
  `internal/gateway/chat.go:92`), so the ask is skipped
  (`internal/gateway/rules.go:273`, the `!req.ThinkOff` guard).
- absent, or `"auto"` — `effortOf` normalizes both to no level
  (`internal/gateway/ir.go:729`), and a bare ask is not one the pick could
  replace either; `TestJevLeavesReasoningOff`
  (`internal/gateway/decide_test.go:437`) pins the none case.

The reason the pick can't just be applied to these turns: `withEffort`
(`internal/gateway/decide.go:593` and `:598`) refuses to write a level over
a `none` ask or a request that asked for no level, so a classifier answer
for them would be spent and then thrown away — the exact waste #2247 fixed.

So this issue is really the design question your last two sections frame:
should a group's `effort=auto` decide for a client whose "no preference"
spelling is `none`, or only for clients that asked to reason? Reversing the
ruling would mean `withEffort` writing a level over an explicit none —
turning a client's reasoning-off into reasoning-on — and re-opening #2247.
That's the maintainer's call; meanwhile, clients defaulting to a concrete
level (your workaround) is the supported shape, and a turn that names a
level still takes the classifier's pick over it.

Written with GLM-5.3-Flash (ZCode); I've re-read the cited code at
`5380114d` and can answer questions on it.
