**Verdict** (analysis; no patch — whether any tokens are actually missing can only be settled on your Windows machine, and the rest is a design call for the maintainer)

## What the two surfaces measure

Your report compares magpie's two data surfaces against each other, and they count different things:

1. **The Usage page** (`/api/usage`, and `GET /v1/magpie/usage`) answers from the usage ledger. The ledger keeps "the token count of every call **the gateway serves**" (`internal/usage/usage.go`, package comment). A session that never sends a request through magpie's gateway has no row there — by design.
2. **The Sessions page / `magpie sessions`** read the agents' own local logs (Codex rollout files and the like), including sessions that went straight to the vendor. Your `magpie sessions --limit 100 --json` hit is this surface: it found the Cindy rollout (agent `codex`, input=345227, cache_read=3249408, output=9998).

So "CLI found it, the Usage page doesn't show it" is the expected shape when that Cindy Codex traffic went **direct** (Cindy → vendor) instead of through magpie. It is not by itself evidence of under-counting — and your report already says the same: the same-window reconciliation between the UI and the logs has not been done yet.

## Where a Cindy Codex session is counted

- **Through the gateway**: magpie's Cindy import link issues Cindy its own gateway key, "keyed so that its requests are counted as Cindy's" (`internal/agent/cindy.go`, `CindyLink`). Requests Cindy sends through magpie land in the Usage page under the **cindy** agent.
- **Local logs**: a Codex rollout is always reported as agent `codex`, keyed `codex:<thread id>` (`internal/sessions/sessions.go`, `codexFilesIn`), with nothing recording which host app launched it. Cindy's **Pi** sessions are the only ones magpie files under "cindy" (`internal/sessions/cindy.go`); Cindy's Claude Code writes `~/.claude`, read as Claude Code's; Cindy's Codex has no host-specific handling. So a Cindy-launched Codex session can never appear under a "Cindy" filter in the Sessions surface — that is the current attribution design. Changing it (label the host app, or group Cindy's Codex under cindy) is a product decision, not something fixable from this report alone.

## One code-level observation worth confirming

`appdir.CodexHomes()` — the heuristic that finds extra Codex folders — scans the home folder and the folder beside the main CODEX_HOME, for directories whose name starts with `codex`/`.codex` (`internal/appdir/codex.go`, `CodexHomesIn`). `%APPDATA%\Cindy\codex-home` is not in that shape. Since your CLI did list the Cindy rollout, something on your machine covers it (a `CODEX_HOME` Cindy sets that magpie's process also sees, a link, or a Cindy 0.166 layout detail). I cannot tell which from here. If it turns out magpie reads that folder only on some machines, a Cindy entry beside `cindySessionDirs()` would be the natural seam for it — but that needs the Windows fact first, so I am not patching it speculatively.

## What would settle the "missing usage" question

1. In Cindy, check whether the Magpie provider is actually added (Cindy's provider list) — i.e. whether that Codex traffic routes through magpie at all.
2. For one same time window, export both: `GET /v1/magpie/usage` (or the Usage page) and `magpie sessions --days <N> --json`, and compare per session. If the Usage page's cindy row covers the same tokens, nothing is missing and the gap is only the Usage page's gateway-only scope.
3. If the traffic went direct, the Usage page having no row for it is the current design; the Sessions page is where a direct session's tokens show.

## Verification

| Check | Result |
| --- | --- |
| Usage ledger scope | `internal/usage/usage.go` package comment: "every call the gateway serves" — gateway-only by design |
| Usage page data source | `internal/usageapi/usageapi.go`: GUI `/api/usage` and gateway `/v1/magpie/usage` answer the same `Summarize` |
| Cindy gateway key attribution | `internal/agent/cindy.go` `CindyLink`: "counted as Cindy's" |
| Local-log attribution | `internal/sessions/sessions.go` `codexFilesIn`: agent `"codex"`, key `"codex:<thread>"`, no host field |
| Cindy Pi-only handling | `internal/sessions/cindy.go`: only `pi-agent-home/sessions` is read as cindy |
| Codex folder heuristic scope | `internal/appdir/codex.go` `CodexHomesIn`: home + beside CODEX_HOME, name starts with codex |
| Windows machine checks | NOT-RUN — needs your machine (no Windows/Cindy here) |

**Source**: internal/usage/usage.go, internal/usageapi/usageapi.go, internal/agent/cindy.go, internal/sessions/cindy.go, internal/sessions/sessions.go (`codexFilesIn`), internal/appdir/codex.go (`CodexHomesIn`) at upstream/main `db0f2f20d4dda003c153922a94932ab8d212d96f`.
**Not verified**: whether your Cindy traffic goes through the gateway or direct; why your `magpie sessions` lists the `%APPDATA%\Cindy\codex-home` rollout when the `CodexHomes` heuristic does not cover that path; whether the Usage page's totals and the sessions' totals differ for the same window. All three need your machine.
**Attribution**: AI-written analysis; I can answer questions on it myself.
