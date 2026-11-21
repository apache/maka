Triage note — I picked this up to work it and am yielding to @Logic769's patch (`fe270b3` on `fix/gui-state-credentials`): it is correct, minimal, and applies to today's `main` as is. What follows is an independent check of the report and of that patch, so it can be picked up with confidence.

**The report, on current main (`9d08993c`)**

- `state()` builds the `stateJSON` with `Settings: settings.Load()` (`internal/gui/api.go:2595`), and `lastKnown()` puts a fresh `settings.Load()` back for `GET /api/state?last=1`, so both endpoints answer with `settings.githubToken` and `settings.lanKey` in the clear.
- Ablation against unpatched main, keeping the patch's own test: red on all three assertions — `state carried the credentials: token "ghp_secret1519" lanKey "sk-lan-1519"`, `last-known state carried the credentials`, `the page was served the credentials`.

**Review of the patch**

- `git am fe270b3` onto `9d08993c` is clean. Its base (`90518de2`) is 393 commits behind now, but none of the lines it touches moved — including through d307aa648's `/api/state` write-path rework, which left `state()`'s construction unchanged.
- Blanking both fields is the right rule: it is the same one `settingsState()` already applies to `/api/settings` (`s.LANKey = ""` — "the retained credential belongs on disk, not in UI state" — and the token only masked), and the page reads neither value (`app.js` takes `githubTokenMask`, `githubTokenFrom` and `githubTokenRefused` from `/api/settings`).
- Sibling sweep: every other full-settings answer rides on `state()` (`POST /api/profile/{action}` embeds it, `POST /api/sync` returns it), so the one fix point covers them too; the kept disk copy (`keptFile`) already drops `Settings` entirely; `boot.js` picks individual non-secret fields only. `proxy`, `proxyCustom` and `otel.headers` stay: the settings forms read and write them (`app.js`), so they are round-tripped form values, not dead credentials. No other raw-credential serializer found.

**What I ran** (on `9d08993c`, macOS arm64)
Command | Result
--- | ---
`git am fe270b3` | applies clean
`go test ./internal/gui -run TestLastKnownState -count=1 -tags nogui` | ok (1.2s)
ablation: `api.go` + `laststate.go` back to upstream, test kept | red, all three credential assertions fire
`gofmt -l` on the three touched files | clean
`go vet -tags nogui ./internal/gui` | clean
`go test ./internal/gui -count=1 -tags nogui` | 1 fail: `TestProxyCheckSaysAProxyPassedBy` — same fail on unpatched `9d08993c` (the proxy-check endpoint answers 502 on this network), pre-existing, untouched by the patch

**Not verified**: `GOOS=linux` / `GOOS=windows` vet and builds, and suites outside `internal/gui`.
