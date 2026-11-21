PATCHED #5882 (new-run batch 2, lane 1)
head: 33cf8271f5989a11c0927008a136874b3194f691 (branch fix-5882-think-level on ggbdpq/magpie)
base: upstream/main ca7a39291 (v0.1.3604, fetched live at start)
sha256[:16]: d5e035cc86594ec6
am: clean checkout ca7a39291, zero-conflict
take: https://github.com/yetone/magpie/issues/5882#issuecomment-6769039154
post: https://github.com/yetone/magpie/issues/5882#issuecomment-6769854804 (read back via list endpoint: 14510 bytes, sha + footer verified)

Fix: thinkingConfig (internal/gateway/codeassist.go) medium arm — a later Gemini asked medium goes to high where its id names no level (gen > 3 && at != ""); Flash any generation keeps medium; tiered variants keep their own level; 3 Pro unchanged.

Red before (reporter byte shapes): TestGeminiLaterGenerationsToldALevel Argon medium (thinkingLevel medium, want high); TestCodeAssistAntigravityLevels new row (plain argon on antigravity account, the report's own surface); TestOpenCodeGoGeminiModelOnGeminiAPI argon-contributor medium. All red pre-fix, red again with arm ablated, green after.

Green: 24 named effort-neighborhood tests; full gateway package ok 844.7s; gofmt/vet/GOOS linux+windows builds clean.

Sibling rulings: withGeminiEffort/aiStudioThinking/vertexThinking untouched (relay/Chat/Vertex policies, #2083 left Vertex unchanged); AntigravitySentID family path already folds medium to -high (argon has -high/-low only, no -medium).

Root cause 2 (silent 200 on reasoning-only filter/length): analyzed in post, not patched — its own change on the empty-retry/refusal machinery; this fix removes its main feeder per the report's own table.
