The checks below were run with AI assistance (GLM-5.3-Flash through ZCode in ggbdpq's session), on this machine, darwin/arm64, against current main. The patch itself is SunflowersLwtech's fix branch, rebased as-is with the author kept, per the community-PR credit rule.

## What's wrong (their analysis, confirmed against current main)

In the interactive mode the bridge learns of a call from the session's transcript, and a call that shows up before the message that made it is told to the client by itself (`r.onCall`), with `awaited[id]` marking that its message is still to be written. The first message written after such a call is taken as that call's late carrier (`lateID`) and left out. `lateID` and `awaited` live for the whole run, and nothing cleared them when the turn ended. On a later turn, the message carrying a call told by itself was then read as "written after calls it didn't have" — the stale check `lateID != "" && len(awaited) > 0` dropped those calls from `awaited` and told the message to the client whole. Before a call already told was skipped there, that told the calls a second time and the client ran them twice.

Their second commit covers the sibling: a call told by itself whose following message doesn't carry it and ends the turn (the attempt was cut and asked again, the answer is words) — no message with that call ever comes, so the message became `lateID` and was left out, the result after it had no case for that, and the reply never ended.

The fix narrows the give-up to the calls the left-out message was to have (`owed`, the snapshot of `awaited` as `lateID` was set), and gives up every call still awaited when a message ends the turn with `end_turn`/`stop_sequence` (444 of 444 end_turn rows in 1,207 real transcripts carry no call, per their count).

## Branch

`fix/late-message-stale-id` in the report is now `fix/tui-stale-late-message` on their fork (force-pushed, the commits renamed). Both commits rebased onto current main, zero conflicts, authors kept:

- `claude: a stale lateID no longer has the next turn's late message told whole`
- `claude: a message that ends the turn gives up every call still awaited`

## Verification (darwin/arm64)

main moved twice under this run, so the bases are exact: red and ablation at `6c3f113ce`; after it gained 3 commits (HTTPS routing and settings — none touching the claude bridge or its tests), rebased again zero-conflict onto `db0f2f20d` and everything below re-checked there.

| Check | Result |
| --- | --- |
| Their 11 tests, unpatched baseline (main at 6c3f113ce + their tests only) | 7 red, failing as the report describes |
| Their 11 tests, patched (re-run at db0f2f20d) | green (`-count=1`) |
| All of `TestClaudeTUI*` (57 with subtests), patched, `-count=1` | ok |
| Same suite with `-race` | ok, no race |
| whole `go test -tags nogui -count=1 ./...` at db0f2f20d | 91 packages ok; 5 red, all reproduced on the unpatched tree (below) |
| `gofmt -l`, `go vet` (darwin, `GOOS=linux -tags nogui`, `GOOS=windows`), `go build -tags nogui` (linux, windows, darwin) | clean, both bases |
| `git am` of both `format-patch --zero-commit` files on a clean tree at upstream/main | zero conflict; resulting tree identical to the rebased branch |

Red on the unpatched baseline (`TestClaudeTUICallsBeforeTheirMessagesTwoTurns` "third reply told toolu_b again", `TestClaudeTUILastMessageStops` "the reply never ended: the client never heard the call (deadlock)", plus `MessageWrittenWhileItsCallWaits`, `ProductionShape`, `FourTurns`, `MessageReallyWithoutItsCall`, `LastMessageWithoutCallFirstTurn`); green with the fix.

The 5 whole-suite reds are environmental, each red on the unpatched parent too: `TestMothX`, `TestProxyCheckSaysAProxyPassedBy`, `TestHostToldTheGatewayAddress`; `TestEveryRouteHasACommandOrIsNamed` (red on the parent with the same full run, and today's `db0f2f20d` lesson note names exactly this guard's blindness under `-run`); `TestSessionReadsRoutes` (green alone on the parent, red when the whole gui package runs on the parent too — in-package ordering).

## Ablation (at 6c3f113ce, product hunks only, tests kept)

- owed narrowed back to the old `clear(awaited)`: `CallsBeforeTheirMessagesTwoTurns`, `MessageWrittenWhileItsCallWaits`, `ProductionShape`, `FourTurns`, `MessageReallyWithoutItsCall` red again. Restored, green.
- end_turn/stop_sequence give-up taken out: `LastMessageWithoutCallFirstTurn`, `LastMessageWithoutCallSecondTurn`, `LastMessageStops` red (the reply never ends). Restored, green.

## Siblings

`rg` for the mechanism (`lateID`, `awaited`, `owed`, `written`, `unheard`, `told by themselves`, `r.onCall`) lands only in `internal/gateway/claude_subscription.go` — `owed` in `internal/plugin/host.go` is a flow-control window, unrelated. The give-up block is byte-identical between their branch point (c360d9d30) and current main, so none of the 31 commits that touched the file since moved its semantics; `ee818e8bc` (#5963's landed fix) touches `asRoot`/`startRun`/the threads-flags block — a different mechanism from this transcript pairing, and doesn't cover this face; `a16da55d3` (#5767's follow-up) touches `turnIn` in `affinity.go` only, which shares no state with the bridge's `lateID`.

## Patch

`git am` ready; branch: https://github.com/ggbdpq/magpie/tree/fix/5934-lateid-turn-end-clear (head `e323c93a520ad941c647fed5567449b99f95f6ae`)

- [`claude: a stale lateID no longer has the next turn's late message told whole`](https://github.com/ggbdpq/magpie/commit/c79d0f5724f8ee4b9d4da68d1a986bf8fb3a884a.patch) — `git am` format, sha256[:16] `c0ad6418541f65e2`
- [`claude: a message that ends the turn gives up every call still awaited`](https://github.com/ggbdpq/magpie/commit/e323c93a520ad941c647fed5567449b99f95f6ae.patch) — `git am` format, sha256[:16] `79da90b104bd7c13`

---

**Source**: reported in this issue by SunflowersLwtech with the fix branch; every check above re-run here on current main.

**Red without the fix** (base `6c3f113ce`, their tests only): the 7 failures listed above, then green with the fix.

**Siblings**: `rg` scan listed above — the pairing state is local to `readOutput` in `claude_subscription.go`; nothing else reads or writes it.

**When the read fails**: not affected — the change reads only the transcript rows already parsed this run; no file reads added.

**Not verified**: a real interactive Claude Code run against a real subscription (the tests drive the bridge through the transcript shape from the report and from `123d72be6`).

**Attribution**: the commits are SunflowersLwtech's (`LiuWei <sunflowers0607@outlook.com>`), rebased and verified with AI assistance (GLM-5.3-Flash through ZCode); I've read the whole diff and the tests pass. Please keep the author (`LiuWei`) or add `Co-authored-by: LiuWei <sunflowers0607@outlook.com>`; rebase and verification by `ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
