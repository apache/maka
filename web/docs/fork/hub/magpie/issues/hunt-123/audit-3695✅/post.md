**Status: fixed — landed in v0.1.1701** (commit `430e3050d`, "gateway: magpie's own searches and image descriptions go without the agent's middleware (#3695)"). The patch is credited to coffemon (**@JoeyWu-tech**) and landed with them as the commit author.

**The fix, checked at current main tip (`e17b6cef`):**

The crash happened because magpie's own sub-requests — per-image descriptions (`seenBody`, up to 4 goroutines) and web searches for models that can't search — were made on a context derived from the agent's request, so they carried its middleware `Run`, and parallel goroutines ran the agent's `onProvider` hooks on the same single-goroutine moejs Realm, dying in `InternGoString` with `fatal error: concurrent map read and map write`.

At tip that path no longer carries the agent's middleware records:

- `internal/gateway/middleware.go:140-142` — `ownAsk` puts an empty `mwRuns{}` over the context's tried-records key (and clears the agent-turn key), so the agent's middleware isn't run on these asks; its comment block cites #3695.
- `internal/gateway/vision.go:696` — the image-description request is built with `ownAsk(magpieChose(ctx))` (path: `seenBody` → `describe` → `describeWith` → `askVisionWith`).
- `internal/gateway/search.go:1109` — the same for search stand-ins.
- Regression tests `TestImagesDescribedWithoutTheAgentsMiddleware` and `TestSearchesWithoutTheAgentsMiddleware` are at `internal/gateway/middleware_test.go:197` and `:237`; both pass at tip on darwin/arm64 with `go test -race -count=2 ./internal/gateway/`.
- Fresh: `git log upstream/main --grep=3695` shows only `430e3050d` (nothing reverted it); it is an ancestor of today's tip and of both the `v0.1.1701` and latest `v0.1.2891` tags.

**Version guide:** reported on **0.1.1476** (the issue notes the same vulnerable code shipped through v0.1.1564 and main at the time) → first fixed in **v0.1.1701** (2026-10-26) → latest release is **v0.1.2891** (2026-11-04). If you hit this crash, upgrade to **v0.1.1701 or newer** — on those builds magpie's own descriptions and searches simply don't run the agent's middleware, so there is no shared-Realm race left. If a gateway exit still shows up on ≥ v0.1.1701, please reply here with your version and a stack.

Thanks @aiirobyte for the detailed report and stack trace, @yinwu01 for the reproduction and patch work, and @JoeyWu-tech (coffemon) for the patch upstreamed into v0.1.1701.

Not verified: I did not re-run a real `magpie serve` under concurrent multi-image load; the above rests on the maintainer's verification in this thread plus the local code reads and test run noted.

AI use: analysis performed with AI assistance; all code reads and the test run above were run locally at tip `e17b6cef`.
