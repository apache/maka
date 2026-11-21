# L16 车道笔记（rebase 轮 2026-11-14，TIP=a8fa771a63d1b337d52c5376544c4ea11236da76）

工作区 /tmp/mg-rbL16-wt 每单重建，GOCACHE=/tmp/mg-rbL16-gocache。每单 build 绿 + gofmt 空 + push 后 ls-remote 回读核对。

## #4863 fix/4863-replay-cache-diagnose（堆叠 2 提交：#5455 底 + #4863 顶）→ RESOLVED-PUSHED f76e80bb1

- **结论**：两提交均语义重建成功，回读 f76e80bb14ac7f1e；build 绿、gofmt 空。
- **上游侧改动摘要**：
  - continuation.go：63c91cae5+a8fa771a6 引入 bodyHas/bodyIndex（rarest-byte 优化，`bytes.Contains` 的语义等价替换，body_has.go 注释自证）。
  - claude_subscription.go：36c5ee1e6（#6528）removeRun 加 `keep := run.keepable()` + keepEnded 保留机制，尾部条件 `if !shelved {` → `if !shelved && !keep {`（keepEnded 保留的 run 不删 session 文件）。
- **解法**：
  - #5455（geminiEnds）：保留我方解析逻辑（有 candidates 无 finishReason 时：候选有 parts→cut；全无 parts→空回复结束），首行字节匹配改 bodyHas。
  - #4863（removeRun）：保留我方 parkKey 读取行 + shelveParked 分支，尾部条件合并为 `if !shelved && !keep { removeSession }`——shelveParked 与 keepEnded 两机制都保留 session，互不冲突。
- **不自信点**：keep=true 且 parkKey!="" 的 run 会先 shelveParked 再被 keepEnded 保留（session 双份保留形态），两机制生命周期无显式交互测试；属可辩护合并而非实测行为。

## #5455 fix/5455-antigravity-0token-turn（单提交）→ RESOLVED-PUSHED a2b2ff600

- **结论**：与 #4863 堆叠分支中同一提交同一冲突，同解法；回读 a2b2ff6008c511e；build 绿、gofmt 空。
- **解法**：geminiEnds bodyHas 替换（同上）。
- **不自信点**：无新增。

## #5480 fix/5480-codex-handback-unknown-reading（堆叠 3 提交）→ RESOLVED-PUSHED 9601d6120

- **结论**：前两提交冲突与上同（复用解法），#5480 本体（internal/agent/codex.go 等）上游 1eebd1ff3..a8fa771a6 无提交、自动合并干净；回读 9601d612071ef1e。
- **解法**：同 #5455/#4863 两处。
- **不自信点**：任务书说上轮冲突在 continuation.go，本轮实测 #5480 本体无冲突——以实测为准。

## #4324 fix/4324-muse-phase-verify → RESOLVED-PUSHED 8e653a3c7

- **结论**：回读 8e653a3c76a4ad；author=MRQC-st（第三方 cherry-pick）自然保留。
- **上游侧改动摘要**：a4cd61f77（#6292）把 relay 拆成薄壳 + relayFailing（abort 签名改 `func(code int, msg string)`，bridgeFailed 用）。
- **解法**：我方 `req.phaseClient = codexPhase(r)` 重锚到 relayFailing 体开头（参数与原 relay 一致，r/req 都在；所有 relay 调用都经 relayFailing，语义等同）。
- **不自信点**：phaseClient 设置点从 relay 移到 relayFailing，若未来有直接调 relayFailing 绕过 relay 的调用方则行为不变、但注释里"set in streamTranslated and relay"的措辞不再字面准确（提交正文未改，语义不受影响）。

## #5445 fix/5445-library-instructions-arrival → RESOLVED-PUSHED bacc89b75

- **结论**：回读 bacc89b751a4ec。
- **上游侧改动摘要**：18c932385 在同一插入点（leanSystem 之后）新增 claudeKnownLong/claudeGenRe/claudeRunName 块——纯相邻插入冲突。
- **解法**：两块都保留（上游 claudeRunName 系在前、我方 claudeLibraryInstructions 在后）。附带：我方新测试文件 claude_library_instructions_test.go 原提交就不 gofmt-clean（import 空行），按门禁 gofmt -w 修正（纯格式）。
- **不自信点**：无。

## #5478 fix/5478-discovery-rest-suspended → RESOLVED-PUSHED 0852af616

- **结论**：回读 0852af616032f2。
- **上游侧改动摘要**：TIP 上 googleSuspended 仍用 gateway 内 googleToS 正则 + status 门（2e58f85e4 引入，基线祖先）；0d99261dc..a8fa771a6 该区域无上游改动。冲突仅因我方删除 googleToS（判定挪进 provider.GoogleSuspended）与 HEAD 保留它。
- **解法**：接受我方删除——TIP 上 googleToS 唯一使用点 googleSuspended 已被 auto-merge 换成 provider.GoogleSuspended，删除无残留引用（rg 验证）。
- **不自信点**：方向鲜度查过：上游无 discoveryRefused/DiscoveryHeld 等价物（git log -S 空），discovery 轮询侧 rest 仍是我方独有，patch 价值成立。

## #5876 fix/5876-kimi-quota-400-empty → RESOLVED-PUSHED b1dd66962

- **结论**：回读 b1dd66962eba82。
- **上游侧改动摘要**：
  - fallback.go retryable：上游在 400/422 case 前加 `case status >= 400 && status < 500 && refusedWords.Match(body)`（plugins#1094）。
  - routing.go failure：402 case 的 `!bytes.Contains(body, []byte("insufficient_quota"))` 改 `!bodyHas(...)`。
- **解法**：两侧 case 谓词不同且都 return true，两个 case 都保留（refusedWords 宽 4xx 在前、我方 emptyContent 400 在后）；routing.go 我方新 case 插入 + 402 行取上游 bodyHas 版。
- **不自信点**：emptyContentWords 与 refusedWords 若有措辞交集，case 顺序决定命中先后（现顺序=先 refusedWords 后 emptyContent）——两者都 return true 且 failure 侧 failQuota 判定独立，行为无差。

## #3106 fix/3106-compaction-silent-assistant → RESOLVED-PUSHED 1910b41da

- **结论**：回读 1910b41da92aaf。
- **上游侧改动摘要**：1ad9d157f（#5067）引入 roleRefused(rec, err) 取代大条件里的 upstreamFailed(rec)——roleRefused 首项即 upstreamFailed(rec)，完全覆盖；3835 行上游还加了 roleRefused 的 askAsSent 先行重问。
- **解法**：大条件 = 上游版（roleRefused）+ 我方 refusesMessages(rec)，去掉我方侧冗余的 upstreamFailed(rec)。附带编译修复：上游 59d9f5c7d 已把 codex_backend.go 的 regexp 迁到 lazyre，我方 messagesRefusedWords 改 lazyre.New。
- **不自信点**：refusesMessages 与 roleRefused 的 askAsSent 先行重问的交互——refusesMessages 措辞不匹配 systemRefusedWords/upstreamFailedWords，不会被 roleRefused 先行重问拦截，直接落 plain-text ask，语义与我方原意一致；未跑该场景定向测试（本轮只 build+gofmt）。

## #5065 fix/5065-omp-remote-compaction2 → RESOLVED-PUSHED 4df401735

- **结论**：回读 4df4017354a7b5。
- **上游侧改动摘要**：`bytes.Contains(body, []byte(`"compaction`))` → `bodyHas(body, `"compaction`)`。
- **解法**：保留我方注释块与函数体 omp 分支（auto-merge 已在），条件行取上游 bodyHas。
- **不自信点**：无。

## #6288 hunt-20261112-t1-6288 → RESOLVED-PUSHED c6a924d12

- **结论**：回读 c6a924d128a95a；author=HKTPlay（第三方）自然保留。
- **上游侧改动摘要**：upstreamStop 守卫行 bytes.Contains → bodyHas（3 needle）。
- **解法**：守卫行合并为我方 4 needle（加 `"finishReason"`）× 上游 bodyHas 写法；geminiFinish 解析区（Candidates/Response.Candidates/tail loop）auto-merge 完整。
- **不自信点**：无。

## #6320 hunt-20261112-t1-6320 → RESOLVED-PUSHED d347540cc

- **结论**：回读 d347540ccc8120。
- **上游侧改动摘要**：prevElsewhere 守卫 `!bytes.Contains(body, []byte(`"id"`))` → `!bodyHas(body, `"id"`)`。
- **解法**：守卫行合并为我方 `!a.clientWhole && n <= 0 ||` 门 + 上游 bodyHas。
- **不自信点**：无。

## #4668 fix/4668-socket-rebuild-memory → RESOLVED-PUSHED 2c91121c2

- **结论**：回读 2c91121c237a93。
- **上游侧改动摘要**：上游在我方基线后在文件尾追加 TestResponsesSocketChatDoneTurn（#5936，doneHold），与我方追加的 TestResponsesSocketLogsLongestTurn+#4668 在同一位置——纯尾部追加冲突，两个测试互不相干。
- **解法**：两个测试完整保留（HEAD 测试在前、我方在后，lockedLogs 类型随我方测试）；从 git 对象提取两侧完整块拼接（heredoc 反引号陷阱改用 python 脚本文件）。sockClient.turn harness 是 #4058 既有的，两侧共用。
- **不自信点**：拼接后的 TestResponsesSocketLogsLongestTurn 依赖 "the longest turn" 日志行格式——我方 request_bounds.go/responses_ws.go 的产品改动区 auto-merge 成功，格式字符串未受上游影响（build 绿佐证编译层一致；行为层未跑测试）。

## #4069 hunt-20261111-r5-4069 → SUPERSEDED（分支原样保留 6af80e41a，rebase --abort）

- **结论**：上游 7b5c069c3（2026-11-12 07:50，yetone）"gateway: Vertex AI gets a tool's image in a user turn of its own, no \"Requests ending with a model turn\" after view_image (Voo_Ler on X)" 已实现同一修复。我方交付 2026-11-11 22:17（6af80e41a），上游 9 小时后自修（Voo_Ler on X 独立报告）。
- **SUPERSEDED 证据**：
  - 同一问题域：Vertex AI 对 functionResponse+image 混合末 turn 回 "Requests ending with a model turn are not supported"（#1533 措辞，我方提交正文同述）。
  - 同一修法：buildCodeAssistSent 对 Vertex（vx）把 toolImage 的 part 拆进 functionResponse 之后的 user turn（`said = append(images, said...)`）；Gemini CLI/Code Assist 豁免与 Claude/Antigravity carve-out（`!(ag && claude)`、`toolImage[i] && !vx`）与我方 patch 的适用面与豁免一致。
  - 同一测试区：7b5c069c3 改了同一 fixture vertexTurnsAway（inlineData/fileData 算进混合 turn 拒绝判定），正是本轮冲突点；另加 gemini_view_image_test.go 端到端。
- **不自信点**：上游对 Gemini CLI 的豁免理由是"no refusal is known there"，我方 patch 对该面补 user turn 的行为与上游豁免不同——但上游是维护者裁决方，其豁免为准，我方 patch 不再推进。
