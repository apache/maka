Status: fixed on main in 67b12956 — every line the port rewrites keeps its length, so the persisted byte offsets stay valid.

**What the fix does (67b12956, "sessions: a Codex rollout magpie rewrites keeps every line where it was"):**

- `fitLine` (`internal/sessions/codex_portable.go:497`): a rewritten line that comes out shorter than the original is padded with spaces after its JSON (which Codex's reader skips), so the line — and therefore every byte offset after it — keeps its place. A rewritten line that comes out *longer* than the original is left as it was in a paginated rollout, so a port never shifts where a line starts.
- `repairLineages` (`internal/sessions/codex_portable.go:521`): forks whose `history_base.end_byte_offset` was already pushed past the shrunken parent by earlier builds get that offset set again from the parent's line ordinals, once per Codex home — this repairs history already broken by the pre-fix builds.
- The sibling `MoveCodexProvider` pass pads the same way and refuses a longer provider id for a paginated rollout.
- Guard tests on the current tip: `TestPortCodexRolloutsKeepsBytePlaces`, `TestPortCodexRolloutsLongerLine`, `TestPortCodexRolloutsRepairsForks` (`internal/sessions/codex_portable_test.go`) and `TestMoveCodexProviderKeepsBytePlaces` (`internal/sessions/codex_provider_test.go`) — all four present and passing on tip `e17b6cef` (`go test -count=1 -run 'TestPortCodexRollouts...' ./internal/sessions/` → ok).

**Version situation / upgrade path:**

- The fix first shipped in **v0.1.1742** (that tag points at 67b12956 itself, 2026-10-27).
- The report was filed on magpie **0.1.1545**, which predates the fix — @ianchenx please upgrade to **≥ v0.1.1742**; the current latest release is **v0.1.2891**. Build from `main` (tip `e17b6cef`) also includes it, plus any later hardening (e.g. #3751's move-open work).
- Note for anyone already affected: upgrade first, then reopen the thread — `repairLineages` runs as part of the port pass and should mend forks whose lineage was recorded against an already-shrunken parent.

Thanks @ianchenx for the detailed report (the byte-accounting in the issue is exactly right) and @yinwu01 for the analysis and the fix pointer.

Not verified: I did not re-run paginated history resume against a real Codex rollout fixture; the verification above is the fix commit's own test suite on tip plus code reads. The commit message itself notes the Codex desktop app was not exercised end-to-end.

AI use: analysis performed with AI assistance; all code reads above were run locally at tip e17b6cef.
