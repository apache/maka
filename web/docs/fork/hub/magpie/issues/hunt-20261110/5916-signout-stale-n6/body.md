This post and its patch are written by an AI (GLM-5.3-Flash via ZCode) and authored by ggbdpq. The report's steps pointed straight at the gap; this is the fix, with the tests and the evidence below run here.

**What's wrong**

On v0.1.3536 (GUI, macOS), after removing the Codex subscription and clicking the removed row's Sign out…, the Add provider sheet's "Removed from magpie" section still lists Codex with the "still signed in" hint and its Add it back / Sign out… buttons — the reader can't tell whether Codex is really still signed in or the sign-out only failed to update the view. In the report's own words: clicking 退出登录 leaves 仍处于登录状态 standing.

**Root cause**

That removed row's Sign out… asks `ForgetAccount` (`POST /api/provider/forget`), and its ask says so in plain words: "magpie signs out the accounts it keeps … Codex itself is signed out too, as codex logout does." `forgetLogins` kept that promise only for the sign-ins magpie had **saved**: it walks `Logins(agent)`, which is logins.json — magpie's kept copies. The sign-in Codex itself holds (`~/.codex/auth.json`, its keychain item) is only deleted when it happens to be one of those copies (`forgetLogin`'s live branch). When none of the saved copies names the live sign-in, the forget succeeds and changes nothing on Codex's side:

- removed from magpie before any look saved it — a saving waits for its look (`loginsLookDue`, due once in 30 s; the page reads accounts every few seconds, so at remove time the look is almost never due), and once the provider is hidden magpie saves nothing of the agent at all (`accountRemoved` in `rememberLogins`);
- or Codex was signed in to another account by itself after the removal (`codex login`), which magpie then saves nothing of.

Either way `Accounts()` still finds Codex signed in, `Hidden()` still lists the removed provider, and `Excluded()` keeps the quiet row: "still signed in" was *true* — Codex was still signed in; the Sign out… on it stays a silent no-op forever. The report's ambiguity ("是真正还处于登录状态，还是登出后 UI 未刷新") was the honest reading of a lie the row had no way to stop telling.

**The fix**

`forgetLogins` now signs out the sign-in the agent itself holds when no saved copy named it — Codex only, through the same `ForgetLogin` path the saved flow's last account already goes through (`deleteCodexLogin`, keychain item and auth.json both, #2367). Claude Code is never signed out (`claudeStandIn`), and the other agents' own sign-ins the ask leaves as they are ("The account itself is left as it is"), so the branch is Codex's alone. After a successful forget there is no Codex sign-in left, `Accounts()` drops the provider, and the removed row disappears from every reader of `Excluded()` — the Add sheet's removed section, the Providers page's reminder line, `magpie accounts`. A forget that genuinely fails (keychain refusal, another saved account in the way) still lands in the ask dialog with its error (#874), so success and failure are now distinguishable, as the report asks.

`provider: Sign out… signs Codex itself out, saved copy or not (#5916)`, branch [`fix/5916-signout-stale`](https://github.com/ggbdpq/magpie/commit/bc903d2d8e7e968ddd2ad38ef6d57690a22a953e) on `d2a80b317` (current main):

```sh
git am https://github.com/ggbdpq/magpie/commit/bc903d2d8e7e968ddd2ad38ef6d57690a22a953e.patch
```

sha256[:16] = `1a9b9d5b5b1190c7` · `git am` into a clean tree at `d2a80b317`: zero conflict.

**Verification** (this machine, darwin, `-tags nogui`)

| Check | Result |
| --- | --- |
| `TestForgetAccountSignsOutASignInNoSavedCopyNamed` (new; the report's shape: removed before any look saved it) | red before — `ForgetAccount` returns nil, the excluded row still listed (`{Agent:codex … Quiet:true}`), `auth.json` kept — then green: row gone, `auth.json` gone, nothing saved |
| `TestForgetAccountSignsOutTheSignInItMovedOnTo` (new; removed, then Codex signed in to another account itself, which magpie saves nothing of) | red before (same residue) — then green |
| `TestForgetAccountSignsCodexOut` (kept) and `TestCodexSignOutLastAccount` | green — the saved-copy flow behaves exactly as before |
| Ablation | the new branch taken out (`if false &&`) made both new tests red again, the kept flow green either way; `git diff --stat` confirmed the mutation; restored, all green |
| `./internal/provider` whole | green (131 s), the four sign-out tests green with `-race`, gofmt clean, whole tree builds with `-tags nogui` |
| real macOS GUI click-through | NOT-RUNNABLE here — the fixtures pin the report's data shape (removed row quiet, sign-in live but unsaved); the row's disappearance is served by the same `providersState()` the sheet draws from, and the sheet re-renders on the forget's own response (`renderAdd` inside `renderProviders`) |

**Sibling scan** (every reader of the state, each judged)

- `forgetLogins` — one caller, `ForgetAccount`; the copilot/antigravity forget tests call it directly and stay green (the branch is codex-only).
- `deleteCodexLogin` — one caller it had already (`forgetLogin`'s live branch); the fix adds no new deletion path, it reaches the same one.
- Every `liveLogin("codex")` reader reads fresh, and reads *none* once the forget is done: autoreset, access-only matching, resets, switch, import, export — all correct on a signed-out Codex.
- Readers of `Excluded()`/`signedOut`: the Providers page's reminder line (`renderExcluded`), the Add sheet's removed section (`gone`), `magpie accounts`/`magpie providers` CLI — all heal from the one data face; `savedButSignedOut` (a different family: saved accounts with no live sign-in) and the plugin path (already signs the plugin's own sign-ins out via `plugin.SignOut`) untouched.
- `rememberLogins`' `accountRemoved` and the sign-in that un-hides a removed provider (`signins_carry`) untouched.
- Upstream `d2a80b317..` recent work on `logins.go`/`account.go` (access-only tokens, auth.json parse-once, workspace sign-ins) touches none of these paths' contracts; the patch sits on current main as is.

Generated-by: GLM-5.3-Flash (ZCode)
