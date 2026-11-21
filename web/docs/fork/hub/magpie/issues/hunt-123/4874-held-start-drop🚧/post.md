**Verdict: PASS.** @skygunner's fix is complete and correct — no patch from me; the fix is theirs, please take it from their branch. Credit @JJasonSun for the report and the loopback fixture.

**What I verified, independently, on current main (`1e1068c86`):**

| Check | Result |
| --- | --- |
| Cherry-pick of `skygunner/magpie@b20255c62` onto `1e1068c86` | product file and test apply clean; only the `gateway-routing.md` paragraph needed a hand-merge (two newer commits — #4868's whole-events read and the auto-mode relay change — had grown it). Trivially rebasable. |
| `TestOverlapKeepsTheHeldTextStart` with the fix | ok (1.2s) — the reporter's fixture verbatim (thinking → empty text start → tool start → late text stop → tool stop), both the overlap case and the ordered control, all six block marks reach the client |
| Ablation (product file back at the parent, test kept) | red on parent: `overlap: content_block_start 1 never reached the client` — the report's exact symptom; restore, ok again |
| Neighbors (`TestDSMLClose*`, `TestDSMLBlockClosedWithCalls`, `TestInvokeReported*`, `TestTextWritten*`, `TestGLMTextCall*`, `TestPluginTextWrittenCall`, `TestQuietWholeReplyStreamed`) | ok (17.1s) |
| `-race` on the overlap + DSML close tests | ok |
| `gofmt -l`, `go vet -tags nogui ./internal/gateway/`, `go build ./...` | clean / clean / ok |

**On the fix itself** (read at `b20255c62`, 8 lines in `textcalls_anthropic.go`): on a `content_block_start`, after `release()`, a start still held is flushed before the new block's events. The client then sees the upstream's own order — start 1, start 2, stop 1, stop 2 — and the late stop pairs with a start it actually saw. The scope notes hold: ordered replies (stop before the next start) take the same `release()` path as before; a held block whose text went, and a stream that ends with a start still held, send nothing extra, as before.

**Not verified:** no live Claude Code replay here — the verification is the fixture-equivalent gateway test on the Messages relay path plus the reporter's own repro output (which shows the ordered control preserved on the installed binary; my ablation run aborts at the overlap `Fatalf` before reaching the ordered subtest, so I read the ordered-on-parent claim from the reporter's run, not mine).

Branch with the verification cherry-pick (local, for the record — the fix is skygunner's): `fix/4874-held-start-drop` at `62a2a5397` on top of `1e1068c86`.

AI use: verification run and this comment were prepared with GLM-5.3-Flash (ZCode) from my own runs of skygunner's branch; no requests were sent to any upstream.
