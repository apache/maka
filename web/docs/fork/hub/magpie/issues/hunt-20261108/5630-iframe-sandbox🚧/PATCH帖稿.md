@yetone Plugin pages and panels are dead in the window: the reader sees "This page stopped working" the moment a page loads, because its scripts die on the `sessionStorage` a framework touches as it starts (Chromium: "The document is sandboxed and lacks the 'allow-same-origin' flag"). Reported by @zyi07 with the full analysis below — it hits `?view=plugin-usage`, the WorkBuddy tasks page, and every page and panel served under `/_magpie/plugin/`, in `magpie web` and in the desktop window alike.

**Root cause**: A document's sandboxing flags are the stricter of the frame's `sandbox` attribute and the response's CSP `sandbox` directive. Magpie shuts a page in twice, and both times to `allow-scripts` only: the frame attribute in `internal/gui/assets/pluginpages.js` (one per page frame, one per panel frame) and the `sandbox` directive in `pagePolicy`'s Content-Security-Policy (`internal/gui/pluginpage.go:234`). Either alone would already keep the page on an opaque origin — a null origin with no storage APIs at all, where `sessionStorage`, `localStorage` and `document.cookie` throw. The error the reporter screenshotted is that throw, caught by the page's own error handling.

**The fix**: Following the reporter's own analysis, `sandbox` now names `allow-scripts allow-same-origin`, and the patch adds the half their diff was missing: the frame attribute in `pluginpages.js` must change too, or the intersection stays `allow-scripts` and nothing improves (that is why the CSP-only change alone wouldn't fix it — both sides of the intersection had to move, and the tests now pin both). With an origin of its own the page's storage APIs work, and what it may load and reach stays exactly as it was: its own folder only (`script-src`), nothing over the network (`connect-src 'none'`), and no way to magpie's `/api` (`apiFramed` still turns away what a framed document sends). Two boundaries I deliberately did **not** move:

- **A page's local service** (`pageservice.go`) keeps its opaque-origin policy. Its proxy answers only requests whose `Origin` is `null` (`servePageService`, a hard 403 otherwise) — a same-origin document would no longer send `null` and would break its own service, and on this server's origin the service's scripts would hold the window's cookie and its `/api`, which is exactly what `pageServicePolicy` exists to prevent. The reporter's failing pages don't use the service face.
- **The error mask lifts, on purpose.** An opaque origin made even a page's own files "another origin's", so its uncaught errors reached the window as a bare "Script error." and the card said "The page hit an error". Same origin now, `pagebridge.js` reports the real message and the card says what actually broke ("fixture: the page broke" in the tests). The window still translates the masked kind; diagnostics get strictly better. The docs' "what the page can't do" now says what is true.

<details><summary>patch: plugin pages: a page's frame has the site's own origin, so its storage APIs work (#5630) — git am applies it as is; SHA-256 first 16: 61d943c9c6757576</summary>

```text
PLACEHOLDER_PATCH
```

</details>

**Branch with the commit**: [`fix/5630-iframe-sandbox`](https://github.com/ggbdpq/magpie/tree/fix/5630-iframe-sandbox) (head `7e5da31275a195946ab612972ba98b2982aaef4b`), rebased onto current `upstream/main` (`c736906b1`); on a fresh checkout `git am` applies clean — verified by replaying it onto a fresh checkout of `c736906b1` and comparing trees (`fac5b99fc77b7a206985eff0e76c47d40336c298` both sides).

| Check | Result |
| --- | --- |
| `TestPluginPageServedShutIn`, `TestPluginPanelsServedShutIn`, `TestPluginPageWindowPolicy` (assertions updated first) | red before the fix (policy lacks `allow-same-origin`), pass after |
| `TestPluginPageLoadsItsFilesInTheWindow` (real WKWebView window, `darwin && cgo`) | pass |
| `go test ./internal/gui/... -tags nogui -timeout 30m -count=1` | every test passes except `TestProxyCheckSaysAProxyPassedBy`, which fails the same on origin/main `c736906b1` on this machine (`proxycheck_test.go:100`, the local proxy answers HTTP 502 — pre-existing environment failure, not a baseline) |
| targeted `-race` (`TestPluginPage*`, `TestPluginPanel*`, `TestWindowPage*`) | pass |
| Playwright, real Chromium + WebKit, 5 languages × 2 widths: `plugin-page.test.cjs`, `plugin-panels.test.cjs`, `plugin-actions.test.cjs` | 16/16 pass; the probe in `plugin-page.test.cjs` asserts the reporter's own shape — `typeof localStorage.length` is a number in the frame now, `/api` fetch still refused, no cookie readable |
| `gofmt -l <changed files>` | prints nothing |
| `go vet -tags nogui ./...`; `GOOS=linux`; `GOOS=windows` | clean |
| `go build`; `GOOS=windows go build` | clean |
| `GOOS=linux go build ./...` | fails, same as origin/main: wails v3.0.0-beta.24 `undefined: pointer` (`pkg/application/webview_window_linux.go`), pre-existing, reproduced on a fresh checkout of `c736906b1` |
| Ablation | removing `allow-same-origin` from `pagePolicy`'s sandbox turns the three policy tests red again (22 failed assertions); restored, green |
| Re-verified on upstream/main `c736906b1` | branched from it; nothing to rebase |

**Not verified**: the reporter's own plugins (`@magpie-community/page-usage`, `magpie-workbuddy-tasks`) and their Docker + domain setup — the shape is covered by the Playwright probe (a real frame, real storage APIs, the CSP the server sends); `TestPluginPageServiceProxied` and friends cover the service face I left untouched. No NOT-RUNNABLE engine left on this machine.

One test was made honest along the way: `plugin-panels.test.cjs`'s "cleared" check raced the clear's save (the panel's first paint already reads "0 notes", so its wait proved nothing); the timing change here surfaced it on Chromium, and it now waits for the save to reach the (fake) server. On `c736906b1` that file passed twice by luck; with the fix, 16/16.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
