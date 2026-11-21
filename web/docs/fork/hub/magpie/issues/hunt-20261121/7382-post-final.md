Carrying @eisen0419's fix (`a7963d66`, their branch `fix/7382-bili-configured-port`) — author kept — and verified at the current main (`604f707d2`).

@wxy0626 reported (#7382) that enabling billion-context for a URL-lane agent (Zed, Hermes, dsh) fails whenever something else owns `127.0.0.1:8787` — in their case App Sandbox, whose local API registers that address through Windows `http.sys`, so magpie's probe gets a `401 missing or bad bearer token` instead of bili's health reply, even when `bili start` comes up on the configured port first. Setting `"port": 18787` in `billion-context.json` doesn't help, because magpie probes, starts and writes the prefix at a hardcoded 8787.

**What the fix does** (following the reporter's own analysis of the port mismatch, on top of @eisen0419's patch):

- `biliListenPort` resolves the port the same way `bili start` itself does: `ACP_PORT`, then `PORT`, then `port` in `billion-context.json`, otherwise 8787 — mirroring JS `parseInt` and `??` (`8787.5` is 8787, JSON null is 8787, an empty `ACP_PORT`/`PORT` is an error and does not fall through). One bottleneck (`biliTargetSkip`) feeds the health probe, the start and the `/bili/` prefix, so all three use the same origin.
- A foreign listener on the default 8787 (a 401, not bili's health) is left alone: magpie reuses a registered loopback bili or picks the first free lane port from 18787 (skipping occupied ports). A port the file or the environment sets is never silently replaced — when something else answers there, enabling fails with an explicit error.
- Probing bypasses env proxies on loopback, separates TCP dial failures from post-connect HTTP stalls and non-bili replies, waits out bili's 503 `{"ok":false,"reason":"starting"}`, and reads `BILI_CONFIG_FILE`/`XDG_CONFIG_HOME` through `appdir.LookupEnv`/`appdir.Getenv` so relative paths and bare named configs resolve the way bili's own `src/paths.ts` does.
- When the daemon moves, `MoveBiliPrefix` rewrites only the outer `http://127.0.0.1:<port>/bili/` prefix on magpie's own provider entries in the active URL-lane agents, leaving user-defined providers, custom URLs and comments untouched.

| Check | Result |
| --- | --- |
| `TestBiliUsesConfiguredPortWhen8787Answers401` (new, the reporter's scene) | with the port resolution pinned back to the old hardcoded 8787 and the fallback removed, all 8 subtests fail: `bili_port_test.go:91: bili start didn't answer at http://127.0.0.1:8787: something else is answering there`; with the fix, ok (2.743s) |
| `go test -tags nogui -timeout 25m -count=1 ./internal/library` | ok (166.7s), zero failures |
| `go test -race -tags nogui ./internal/library -run 'TestBili\|Test.*Bili\|TestAlignBili\|TestKeepBili\|TestMoveBili\|TestSetBiliURL'` | ok (9.1s) |
| `go test ./internal/agent -run 'Bili\|MoveBiliPrefix\|ZedThrough\|HermesThrough\|DshThrough'` | ok (3.4s) |
| `go test ./internal/appdir -count=1` | ok (1.0s) |
| `gofmt -l` (the 12 changed files), `git diff --check` | prints nothing / clean |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build ./...`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | clean |
| `git am` gate (the commit's patch on a fresh checkout of `upstream/main` at `604f707d2`) | applies clean; tree identical to `8abc84fc8`; author kept as `eisen0419 <usetoken0419@gmail.com>` |

**Composition with our #7309 carry** (comment 7046273883, branch `fix/7309-bili-keep-busy`): our #7309 carry touches the same `biliStartAt` area. The two patches apply independently to main, but they do not compose as-is either way — `git am` in both orders conflicts in `biliStartAt` and the billion-context docs row — and two scenarios resolve differently: (a) another bili holds the port and answers slowly — #7309 refuses a second start with an error, this fix skips to a free port and starts a daemon; (b) magpie's own bili answers slowly — #7309 keeps waiting on it, this fix waits out `biliWait`, ends it and re-ports. The tradeoff is yours; both carriers stay up as independent evidence.

Patch: [`git am < https://github.com/ggbdpq/magpie/commit/8abc84fc8c5f20f293b7f748b309e3f62f11a58e.patch`](https://github.com/ggbdpq/magpie/commit/8abc84fc8c5f20f293b7f748b309e3f62f11a58e.patch) (110 KB — over the comment size limit; also on the branch); SHA-256 first 16: `188479d0a3430e8a`.

**Branch with the commit**: [`fix/7382-bili-configured-port`](https://github.com/ggbdpq/magpie/tree/fix/7382-bili-configured-port) (head `8abc84fc8c5f20f293b7f748b309e3f62f11a58e`), rebased onto current `upstream/main` (`604f707d2`); on a fresh checkout `git am` applies clean.

**Not verified**: the reporter's Windows `http.sys` scene itself (a kernel registration answering ahead of a socket listener) is not reproducible on darwin; the user-space equivalent — a foreign 401 listener on 8787 — is what the new test injects. `go test` on Windows (no Windows machine here; `GOOS=windows` vet and build pass). End-to-end against a real `billion-context` 0.1.216 binary (the tests use the sandbox's fake CLIs). The verification is bound to `a7963d66` / `8abc84fc8`; if that branch is force-pushed later, re-verify.

**Attribution**: the fix is @eisen0419's (commit `a7963d66`, author kept in the carrier); carrying and verification by AI-written (GLM-5.3-Flash (ZCode)) working for ggbdpq.
