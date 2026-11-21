I read the magpie side of this (main at `f3551387c`, `internal/provider`): everything magpie reads and writes around `~/.codex`, and what could and could not make Codex's login die. Short version: magpie does not overwrite Codex's config behind its back, but when magpie's Codex provider is on, magpie and Codex share one OAuth sign-in, and that sharing has one real failure mode that ends exactly like your screenshot — OpenAI revoking the refresh token.

**What magpie does around `~/.codex`** (all verified at `f3551387c`):

- It reads the sign-in (`internal/provider/codex_store.go`, `readCodexLogin`) — `auth.json`, or the macOS keychain item Codex uses — to discover the ChatGPT account, and when its Codex provider is on, serves requests with it.
- When magpie needs a fresh access token, it refreshes through OpenAI and writes the rotated tokens back where it read them (`internal/provider/account.go`, `codexTokenRenewing` → `codexStore.write`). The write is atomic (temp file, rename in, never truncated in place), `auth.json` is read from disk again at each refresh, and the keychain item is re-read fresh before a token is spent — so a rotation Codex just did is picked up, not overwritten.
- The background keep-alive never renews the account Codex itself is signed in to; that one is left to Codex (`internal/provider/keepalive.go`, the active account is skipped).
- `config.toml` is only ever read, never written.

**The one real coupling**: magpie and Codex then share a single refresh token that OpenAI rotates on every trade. Two processes can read the same still-unspent token and both trade it — each side fires when the access token is close to expiry (magpie within 5 minutes of it, on requests and usage reads). The second trade gets `refresh_token_reused`; OpenAI ends the session over it, which is the `401 token_revoked` / "refresh token was revoked" in your screenshot, and codex-rs treats a refused refresh as permanent (its `permanent_refresh_failure`, which magpie's own notes describe in `internal/provider/codex_signin_gone.go`), so Codex asks you to log in again. magpie handles the half of the race where Codex trades first — it re-reads the store, finds a newer token, adopts it and marks nothing (`noteCodexSignInGone`). But there is no lock both processes share, so the collision cannot be fully excluded from magpie's side. It is rare — your login survived two days of use before it fired.

**Two things I ruled out**:

- A crash-corrupted auth file: the Oct 31 errors in your screenshot ("Hosted AppServerManager identity is not ready") come from Codex's own app-server, not magpie (that name does not exist in magpie's tree), and magpie's `auth.json` writes are atomic anyway. A damaged file would also give Codex a local "not signed in", not a server-side `token_revoked`.
- magpie writing stale tokens over fresh ones: before trading a token magpie re-reads the store, its saved copy of the active account is only a bookmark (`rememberLogins`), and switching accounts re-reads fresh credentials first. I found no path that writes an older token over a newer `auth.json`.

One more path fits if you imported account files into magpie: importing a Codex `auth.json` intentionally trades its refresh token for new ones, and the file it came from stops working from then on (the header of `internal/provider/login_import.go` says exactly this). If the imported file was Codex CLI's own current `auth.json`, Codex's copy of the token is spent from then on and Codex's next own refresh is refused. (#4425 is about this import detachment.)

**To pin down which path hit you**, could you say:

1. Did magpie list this ChatGPT account (its Codex provider on), and were requests served through it around Oct 31 – Nov 1?
2. Did you import any account files into magpie, including a copy of `~/.codex/auth.json`?
3. In Codex's logs at Nov 1 ~06:06, what error code does the token endpoint return? The code distinguishes the paths: `refresh_token_reused` says the collision above; `refresh_token_invalidated` says OpenAI invalidated the session on its own.
4. Were Codex (CLI or app) and magpie running at the same time on that machine?

**Meanwhile, if you want magpie to leave that login completely alone**: turn the Codex provider off in magpie — magpie then stops renewing the sign-in and stops asking who is signed in — or Settings → Privacy, turn "Subscription accounts" off (or `magpie accounts discovery off` / `MAGPIE_NO_ACCOUNTS=1`), after which magpie reads no credential file at all. Keeping the ChatGPT account magpie uses separate from the one Codex is signed in to removes the sharing entirely.

---
written with GLM-5.3-Flash (ZCode); I've read the magpie sources cited above. This is an analysis, not a fix — happy to dig further with the logs.
