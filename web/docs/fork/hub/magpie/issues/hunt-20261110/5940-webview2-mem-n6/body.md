Diagnosed this from the code and from the numbers in your screenshot. Verdict: the memory sits in the one place magpie has no dial for — the shared WebView2 browser process — and the parts magpie *can* trim are already trimmed in your build. What the screenshot says, what is already tunable, and what numbers would pin the rest down.

**What your screenshot says** (Task Manager, WebView2 管理器 (6), 1,803.7 MB for the group):

| process | memory |
| --- | --- |
| WebView2: magpie — the shared browser process | 1,732.2 MB |
| GPU 进程 | 48.1 MB |
| 渲染器 (renderer) | 18.8 MB |
| 实用工具: Network Service | 3.2 MB |
| 实用工具: Storage Service | 1.1 MB |
| Crashpad | 0.4 MB |

96% of the tree is the browser process. The renderer (18.8 MB) and GPU process (48.1 MB) are already at roughly the levels a *hidden* window gets — the automatic low memory target shipped in v0.1.2313 (d159314e3) is visibly working here: on our Windows measurement box, one minute after the main window closes, the GPU process drops 85 → 2.6 MB, the main renderer 70 → 7.3 MB, panel renderer ~50 → 1.3 MB, browser-side caches ~30 → 6.2 MB, and a fresh tray start holds ~81 MB private working set for the whole tree. So the pages are not your problem: your tree reads ~22x our fresh-start number, and the mass grew inside the browser process itself — memory that belongs to no window's page, which is why the pages being trimmed didn't move it.

**Why magpie has no dial for that part** (checked at main `d2a80b317`):

- `internal/gui/memtarget_windows.go` — `lowWhileHidden` puts each hidden window's WebView2 on `ICoreWebView2_19::put_MemoryUsageTargetLevel` LOW (wired for both windows, internal/gui/lightweight.go:60 and :132). That API sets a target for the window's *content* — it is why your renderer and GPU rows are small — but a browser process grown to 1.7 GB is not holding any window's pages, so the target has nothing of theirs to trim. You have this since v0.1.2313, and your screenshot shows it active.
- Wails v3.0.0-beta.24's `WindowsOptions` (application_options.go:266) exposes: WndClass, WndProcInterceptor, DisableQuitOnLastWindowClosed, WebviewUserDataPath, WebviewBrowserPath, EnabledFeatures / DisabledFeatures / AdditionalBrowserArgs, UseVisualHosting. None caps or trims the browser process.
- Chromium switches reach the browser process too — everything in `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is merged into Wails' options since v0.1.1291 (#2753; `windowsOptions`, internal/gui/app.go:318) — but no switch reclaims browser-process growth: `--disk-cache-size` caps disk, not working set; `--disable-gpu` moves rendering work around without shrinking it. A switch cannot address this shape.
- Settings → Lightweight mode (#580) is the one lever that tears the whole instance down: 30–60 s after both windows have stayed closed, their webviews are let go, and the runtime exits the browser process once an instance has no webviews left. It is opt-in (default off, because reopening then reloads the page), and it trades that reload for the memory.

**Where this lands.** Your build (v0.1.3078) already contains every shipped mitigation, and the shape — pages trimmed, browser process ballooned — is the same still-open question as #2515 (a 5.2 GB WebView2 tree over ~28 h on v0.1.1265; the growth since its fixes shipped was never re-measured, which is why it stays open), and kin to #909 / #1956 / #2459. Nothing merged after v0.1.3078 changes this picture (checked `v0.1.3078..upstream/main` over the webview2 / memtarget / lightweight files — nothing memory-related).

**What would pin it down** — from your machine, any of these would help:

1. Does restarting magpie reset it? A fresh start should read ~200 MB for the group; if your 1.7 GB built up over days of uptime, that is the growth class #2515 tracks.
2. A few samples over time: the group's memory at start, +1 h, +4 h, +1 day.
3. The WebView2 Runtime version (`edge://version` in a magpie window, or the file version of msedgewebview2.exe) — browser-process growth is often runtime-side, fixed in Edge updates; 1.7 GB in the browser process alone is not a shape a fresh magpie start produces.
4. Whether Lightweight mode is on, and whether the remote window (made and destroyed per use, internal/gui/remote_app.go) gets used a lot — repeated webview create/destroy cycles are a known churn vector for browser-process memory.

Meanwhile, two levers that work today on your build: restarting magpie resets the browser process, and Lightweight mode reclaims everything about a minute after both windows close.

Tests on this tree (`d2a80b317`, macOS — no Windows here, so the WebView2 numbers above are your screenshot plus the Windows measurements recorded in d159314e3, NOT-RUNNABLE to re-measure on this machine): TestWebView2ArgsMergeTheUsers, TestWebView2KeepsCodeIntegrityByDefault, TestWebView2ArgsSurviveWailsInit, TestLightStep, TestWebView2Missing, TestWebView2Notice — all green. TestWebView2Child and TestWebView2MissingFromWails are windows-tagged, NOT-RUNNABLE here.

---
**Source**: reported here by zerger (v0.1.3078, Windows 11); analysis anchored in the code and commits cited, no live WebView2 on this machine.

**Attribution**: AI-written; written with GLM-5.3-Flash (ZCode). I've checked every claim above against the code and commits cited and can answer questions on them.

Generated-by: GLM-5.3-Flash (ZCode)
