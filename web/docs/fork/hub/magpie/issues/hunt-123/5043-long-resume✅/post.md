I checked this against current main (`1e1068c86`) and it is already fixed there: **commit `40a287b21` — "gateway: a quiet Claude Code run begins the reply and pings its client (#5043)" — first released in v0.1.2838**, landed 2026-11-03. 0.1.2738 predates it, so the reported loop is what that build still does.

Each observation in this issue maps to one link of the chain, read from the bridge code:

| Observation in this issue | What it is |
| --- | --- |
| 599.290s / 599.332s, `499 / the agent canceled the request` | Not a magpie cap. The held stream's 200 and comments stop at 5 min (`keepaliveLongest`), and Claude Code 2.1.316's byte watchdog (`no bytes for 300000ms`) ends the request 300s later — 599s. The fix commit reproduces 598.4s with a real claude 2.1.316 against a fake server. |
| Inner CLI ends after a cancel, then a new CLI + session file + `--resume` | A cancelled turn can't be taken back in the interactive mode: `letGo` rewinds only non-TUI runs, and the TUI shim answers only the `initialize` control request (`internal/claudetui/tui.go`), so any mid-reply cancel aborts the run. The next request is then served by `replaySession`: a fresh transcript of the conversation plus `--resume`, only the last turn typed. |
| `cache_write=221350` / `cache_read=21280` on a resumed request | The replay path's expected signature. The transcript carries the whole history as one user message — a wire prefix Anthropic has never cached — so only Claude Code's own system+tools (~21k) reads, and the ~221k of history is written again on every retry. |
| First response after ~527s / ~385s on retries | Uncached prefill of that ~242k replay prefix (201 messages, 27 images, effort high). The retries whose first byte came inside the watchdog window succeeded. |
| Same route, same model, standalone short request ~38s | Consistent with a healthy route and outbound proxy; the minutes-long waits are the replay prefill, not the proxy path. |

The fix (`keepBridgeHeard`): after 1 min of a quiet run (`bridgeHeardAfter`) the client's stream begins, `message_start` goes out when the hold lets it (~4 min, `holdLead`), and pings continue while the run still says nothing — so Claude Code's watchdogs measure from the reply's start, and the run now has until ~14 min for its first event, where it had 599s. The first bytes you observed (385s, 527s) fit inside that.

Upgrading to v0.1.2838 or newer should stop the cancel-and-replay loop as reported.

What remains, for the maintainer's consideration if anything still shows after the upgrade:

1. Any turn the client still gives up on (a manual stop, or a first byte past ~14 min) still ends the TUI run, and the retry writes the whole conversation to the cache again — the prefix mismatch behind that (#3808) is not fixed on main yet (the `pastUnanswered` branch and the TUI-helper port in its comments are pending there). That is a quota cost per cancelled turn, not the loop.
2. A first byte beyond ~14 min still ends the stream; that bound is Claude Code 2.1.316's own "600s after the last non-ping event", not something magpie holds.

Not verified: no Claude Max account or 27-image session was run for this post — the table reads this issue's log against main's code, and the watchdog figures quote the fix commit's own real-client repro. Nothing was measured on 0.1.2738, and no minimal repro was attempted. No code was changed.

AI use: written by a coding agent (GLM, via ZCode) from the repository and this issue's text, posted by ggbdpq.
