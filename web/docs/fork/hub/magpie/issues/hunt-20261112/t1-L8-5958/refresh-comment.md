Status check on the patch above — nothing has moved on either side, and it re-verifies clean on today's main.

**Not adopted, no drift**: `d97311932` is not in `upstream/main`, and `internal/proc/browser.go` has not changed since the patch's base (`d2a80b31731`) — the sign-in surfaces it serves (`internal/cli/web_cli.go`, `accounts_cli.go`, `plugins_cli.go`) only gained small additive bits (a LazyCat box's sign-in env, a library note), nothing on the browser path.

**Re-verified today** on current tip `9c33839de`, the commit re-based as `6b626e39c` on [hunt-20261112-t1-5958](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5958) (the branch [`fix-5958-headless-auth`](https://github.com/ggbdpq/magpie/tree/fix-5958-headless-auth) above stays as delivered):

- cherry-pick clean, the emitted patch is **byte-identical** to the one above (sha256[:16] `2dc4030ad379b1df` unchanged — the touched files didn't drift);
- `go test -tags nogui ./internal/proc/` ok; `TestBrowserWithoutDisplayStartsNoneAndSaysWhy` and `TestInWSL` green under `-race`;
- the gui sign-in surfaces green (`TestPluginSignInPageOpensOnce`, `TestSignInLinkOnlyOpensNothing`, `TestMCPSignInSaysTheBrowserDidntOpen`, `TestOpenSaysTheBrowserDidntOpen`, `TestSignInAlertOpensItsProvider`, `TestSignInText`, `TestBrowserNamesRundll32ByItsPath`);
- `gofmt -l internal/proc/`, `go vet` clean; `GOOS=windows` / darwin / linux (`-tags nogui`) builds pass;
- `internal/cli`'s three healthcheck/record tests (`TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr`, `TestUpdateRestartsTheGatewayItFindsWithoutMagpieAddr`, `TestUpdateFindsAMagpieThatWroteNoRecord`) fail **the same on the parent commit** — they find this machine's own gateway record at 127.0.0.1:3425 instead of the test's port, an environment face of the box they run on, not this patch's (the patch touches `proc/browser.go` alone).

The asks stand as written above: the sign-in dialog's screenshot right after clicking 登录 (its message line tells which state you got), the loaded plugin version from the Plugins page, and the minute's log lines — with the current plugin (0.1.2+) and current magpie the web dialog should already show the copyable link and the code field, and this patch makes the CLI paths say "there is no display on this machine to open a browser on" with the link beside it instead of starting a doomed browser.

**Not verified**: a real headless Linux box (none here — the fixtures stand in for the display's variables and the kernel's name); your retest with the current plugin.

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`
