The `account/read` table above is the definitive shape of it, and it matches what magpie's own side of this boundary already writes down. What follows is where each piece stands in the current code (`f6c882ad7`), and what your three suggestions meet there.

**The root cause is confirmed, and it is the takeover's contract, not a slip.** magpie writes `requires_openai_auth = true` into `[model_providers.magpie]` only while the ChatGPT sign-in has room — `openaiAuth()` is `signedIn && !codexUsedUp()` (internal/agent/codex.go:627-636) — and takes the key back out at the used-up boundary, which is the moment takeover starts (the log line in the macOS report: "Codex's account is used up, so magpie serves it"). Without the key the app-server answers `account/read` with no account, the renderer parks the account-scoped globals — the sidebar's projects among them — under `inactive` and switches to the anonymous identity. Your probe table, with only the config differing on the same binary and `auth.json`, is that contract measured; the same shapes were measured on macOS (tudou950210-bit's run, summarized in the [status check on #5702](https://github.com/yetone/magpie/issues/5702#issuecomment-6805283767)). Nothing under the parking is lost on either platform — your own inventory (sessions, `state_5.sqlite`, assignments intact) and the macOS one agree.

**The two states being mutually exclusive is the app's own composer gate, not something a config line can split** — and your second-order section found the same wall the takeover exists to get past. With the account kept while its snapshot says blocked, the gate greys Send for every model, magpie's included (#540). When this came up before, the gate was checked in ChatGPT.app 26.1029's bundle: it picks the account's own snapshot whenever it is blocked, *before* any per-model `additional_rate_limits`, so keeping the account during the takeover would still grey Send. Your 26.1103 measurement (`rate_limit_reached` → send disabled with `requires_openai_auth = true`) is that same gate on the newer build. So the alternation your two tables show is the design: with room → the key in, account and projects visible; used up → the key out, Send works through magpie, projects parked; reset → the key goes back in and the projects come back with the account. The comeback leg has its own tests, green here today at `f6c882ad7`: `TestCodexMagpieProviderKeepsChatGPTAccount` and `TestCodexAppRouteFollowsOpenAIAuth` (the takeover → key out → room again → key back cycle). Pakyu's log — "magpie gave Codex back its ChatGPT account after the reset" — is the reset leg live.

**On the three suggestions:**

1. *Emit `requires_openai_auth = true`* — this is exactly what magpie writes for every state where it is safe (the sign-in has room), and what it deliberately drops when the snapshot is used up, for the reason your own section measures. Writing it unconditionally re-creates the blocked-gate state. `openaiAuth()` remains the single write site.
2. *Skip the gate / serve an unlimited snapshot* — the gate reads the **account's** own snapshot whenever it is blocked, before any per-model limits, so a per-provider snapshot cannot lift it; lifting it would mean the gateway answering for the account's real usage state with something other than it. That is the app's trust model and a maintainer's call, not a patch-sized decision.
3. *Merge `config.toml` rather than replace blocks* — the table magpie rewrites is magpie's own `[model_providers.magpie]`, and the user-authored values that have come up are carried through every rewrite: a hand-written `requires_openai_auth = false` stays (a5ba5f23b), `capabilities` are re-attached, and a bearer token the gateway accepts is kept (#2545). If a specific key of yours is being stripped, naming it is the actionable ask — that is the pattern each kept key followed; a blanket merge would also carry back keys magpie has to remove.

**Where the projects side has moved since this was filed** (both reports' forensics show the data intact; the sharing machinery now keeps it that way):

| since | what |
| --- | --- |
| v0.1.3559 (15acba534) | while the Codex app is closed, magpie gives every ChatGPT identity in the state file and every saved login one shared list of projects, so the parked identity loads a full list on the next switch |
| v0.1.3600 (10bef5fe0) | the list is one for all accounts, folders deduped across ids, and a project removed on one account is remembered (`codex-projects.json`) so it does not resurrect from another |
| v0.1.3695 (b39a793c9) | when the open app is left showing fewer projects than its accounts have, magpie's UI says so and asks for a quit-and-reopen |
| takeover off (b3a57b3d8) | the Codex app is restarted with its ChatGPT account, so the projects are back immediately — the manual disconnect Pakyu did, as a supported path |

And when magpie cannot serve the agent past the used-up account at all, it does not take over and the app stays on its sign-in, projects visible (f37742e14) — the takeover only happens where magpie can actually carry the traffic.

No patch here, and none is needed on magpie's side of it: the loss you measured is the trade's cost side, the comeback is tested, and the remaining wall — codex-rs answering "no account" for a third-party provider despite valid `auth.json` tokens — is recorded on #5702 as upstream's to cut.

Not verified on my side: a real used-up-account round-trip on the Windows app (no ChatGPT account here); your `account/read` table and Pakyu's live logs cover both halves of it.

Attribution: AI-written; I've read every line cited and re-ran the two tests named. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)

