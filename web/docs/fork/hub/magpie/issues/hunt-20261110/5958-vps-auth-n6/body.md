AI-written patch (GLM-5.3-Flash via ZCode, committed as ggbdpq) — take claimed above.

## What's wrong

On a headless Linux VPS (`magpie serve --web=127.0.0.1:3430`), signing in to `agy-cli` from the web page was seen to call the server's own browser, which came up and went away, and the Google authorization could not be finished from the reporter's machine (#5958). The reporter could not pin what exactly closed — no log or recording — and their own verified way out was running `agy acp --login` on the VPS, copying the link to their device and pasting the code back, after which `magpie plugin login agy-cli` reported signed in.

## Root cause

Tracing every browser-opening surface on current main (`d2a80b31731`):

- **The web page opens no server browser.** `webHost.OpenURL` is a deliberate no-op — "the page opens links itself" — and has been since `magpie web` was introduced (59e4f417b, #102). `openSignIn` answers `openError: ""` in web mode; the page itself `window.open`s the sign-in link in the browser the user is at, shows the link with a copy button, and shows the code / callback-paste fields (`pasteCode`, `pasteCallback`). So the doomed server browser the reporter saw cannot come from current main's web path.
- **The current community plugin opens no browser either.** `@magpie-community/opencode-agy-cli-auth` on the plugins repo main (package 0.1.2) runs agy's own terminal sign-in: `login.mjs` spawns `agy acp --login`, captures Google's link, and takes the code or the landed page's address back through the code field — "Nothing opens a browser here: magpie opens the link, on the machine the user is at". The reporter's dist cache held a 0.1.3 build and the exact loaded version went unverified, so the observed launch most likely came from that older build (or an older agy flow). With the current plugin + current main, the web flow already does what the issue asks for: link shown and copyable, code pasted back, callback address pasted when the page lands on a port the remote browser can't reach (`PluginPastesCallback`/`loopbackPorts`).
- **The live gap: every surface that *does* open a browser goes through `proc.OpenBrowser`, which started the launcher wherever magpie runs, display or not.** `openURLInBrowser` only reports the launcher failing to *start*; `xdg-open` that starts and dies with no display reports nothing. Concretely, on a headless box: `magpie plugin login agy-cli` over SSH (`plugins_cli.go`) printed the link and then started a browser with nothing to show it on; `magpie web` without `--no-open` (`web_cli.go`) did the same with the page's own link; CLI built-in sign-ins (`accounts_cli.go`) likewise. That is the "server browser called and gone" shape, and it is magpie's to fix.

## The fix

`internal/proc/browser.go`: `OpenBrowser` now refuses where there is nothing to open a browser on — the `xdg-open` family with neither `DISPLAY` nor `WAYLAND_DISPLAY` set returns an error ("there is no display on this machine to open a browser on") instead of starting a browser that can only come up and go away. The callers already print the link beside the error (`openURLInBrowser` has done so since #2043), so on a VPS the link is the output, for a browser on the machine the user is at — exactly the issue's ask.

- **WSL is spared**: its `xdg-open` is `wslview`, which opens Windows' own browser with no Linux display; `inWSL` reads the kernel's name (`/proc/sys/kernel/osrelease` contains "microsoft", WSL1 and WSL2 both). WSL is an explicitly supported platform (#2043 came from one).
- **darwin / windows / android are untouched**: `open`, `rundll32` and `termux-open-url` reach a screen of their own without a display here.
- **The desktop window's fallback** (gui `host.OpenURL`) sits behind a Wails window, so no no-display machine runs it.
- `SignInLinkOnly` (Settings › Privacy) remains the manual opt-out; this makes the default correct on headless machines without it.

## Verification

| Element | Result |
| --- | --- |
| Repro (red before) | `TestBrowserWithoutDisplayStartsNoneAndSaysWhy` drives the new seam `openBrowserOn`; before the fix the seam didn't exist — compile-red — and pins both branches: no display → no browser started + error names it; WSL / `DISPLAY` / `WAYLAND_DISPLAY` / darwin / windows / android → browser starts. `TestInWSL` pins the kernel-name detection (WSL1, WSL2, generic, unreadable). |
| Fix | `d97311932a64c84e`, branch [`fix-5958-headless-auth`](https://github.com/ggbdpq/magpie/tree/fix-5958-headless-auth) on ggbdpq/magpie, base `d2a80b31731` (current main tip). |
| Green | proc package whole (`go test -tags nogui ./internal/proc/`), new tests under `-race`, and the sign-in-open surface in gui: `TestPluginSignInPageOpensOnce`, `TestSignInLinkOnlyOpensNothing`, `TestMCPSignInSaysTheBrowserDidntOpen`, `TestOpenSaysTheBrowserDidntOpen`, `TestSignInAlertOpensItsProvider`, `TestSignInText`, plus `TestBrowserNamesRundll32ByItsPath` and a nogui build of `./...`. |
| Ablation | guard condition held `false` (semantics fork on the decision line, compiles) → `git diff --stat` confirmed the mutation → the no-display case started a browser and gave no error ("no display: err <nil>, started 2") → restored → green. |
| Sibling scan | every caller of `proc.OpenBrowser`/`openInBrowser` checked: gui host fallback (behind Wails — unreachable headless), `accounts_cli.go:509` and `plugins_cli.go:669` (link printed first, error now lands beside it), `web_cli.go:61/72/100` (startup link — same), `main.go:672` deep links (opener is `openInBrowser`; a scheme link couldn't land an app headless anyway — message improves, semantics unchanged). Not the same family, left alone: `folder_linux.go` (folder openers, own candidate chain and tests), `agent/lody.go`+`applink_other.go` (scheme handlers, not URL browsers), `gateway/browser.go` (the extension channel, same word different thing). |
| am | `git am` of the `--zero-commit` patch on a clean checkout of `d2a80b31731`: zero conflicts, applies as `50ae1a0969423615`. sha256[:16] of the patch: `2dc4030ad379b1df`. |
| NOT-RUNNABLE | A real headless Linux box (none here) — the fixtures stand in for the display's variables and the kernel's name; the reporter's VPS observation is cited as reported, their own uncertainty noted. |

## For the reporter

With the current community plugin (0.1.2+) and current magpie, the web sign-in for `agy-cli` should already show the Google link with a copy button and a code field — worth re-testing after `magpie plugin update` (the loaded plugin version was unverified on your side). If you'd rather magpie never open sign-in pages at all, Settings › Privacy's "sign-in pages open in a browser of your own" already does that. This patch hardens the rest: no more silent doomed browser starts on a display-less machine — CLI sign-ins and `magpie web` now say "there is no display on this machine to open a browser on" with the link beside it.

Fresh `git am`-ready patch: sha256[:16] `2dc4030ad379b1df`; branch: [`fix-5958-headless-auth`](https://github.com/ggbdpq/magpie/tree/fix-5958-headless-auth) (commit `d97311932a64c84e`).

Generated-by: GLM-5.3-Flash (ZCode)
