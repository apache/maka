**Endorsed** — I verified this branch independently and it does what it says; the fix should land from `pr/3-key-limit-side-asks`, with the authorship handled per the maintainer's usual practice (the commit in the fork carries a machine-local identity, `yanjie@5466053088715162.onaliyun.com`).

Branch: https://github.com/qiqll/magpie/tree/pr/3-key-limit-side-asks (head `5d15c4df8`, one commit on `2219fdd49`, itself an ancestor of today's upstream/main `db0f2f20d`)

## What I verified, on this machine (darwin, arm64, Go via GOCACHE sandbox)

| Check | Result |
| --- | --- |
| Fork branch exists | `qiqll/magpie` `pr/3-key-limit-side-asks` = `5d15c4df8f4f78c6cb5ef9879ab2972eb8a4c6a5` |
| Independent red | On the branch's parent `2219fdd49` with only the two test files checked out (no fix): `TestKeyLimitHoldsTheTurnsImageDescription` — "the describer was asked 1 times for a key with nothing left"; `TestKeyLimitHoldsTheTurnsWebSearch` — "the searcher was asked 1 times for a key with nothing left". Both assertion-level, matching the report's output. |
| Green | The report's own family run, rerun here: `go test -run 'KeyLimit|Search|Vision|Describe|Sight|Image|MCP' ./internal/gateway` → ok (41.7s) |
| Applies to today's main | `git cherry-pick 5d15c4df8` onto `db0f2f20d` applies clean (9 files, +299/−8), and the same family run passes on the result |
| gofmt | clean on internal/gateway |

## Why the direction is right

- **The choke point, not the callers.** Side asks all funnel through `serve` after `keyLimited`; reserving there (`reserveSide` → the existing `reserveFor`) covers them where they are made, instead of each searcher or describer remembering to check. I walked every `serve` call site: turn bodies and their forwards (`middleware.go`, `codex_backend.go`) are already inside `keyLimited`; the MCP entries reserve where they come in (`search_mcp.go:286`, `image_mcp.go:323,505`, `hub_mcp.go:738`), and the patch correctly skips a second reservation for them (`searchFor(ctx).MCP` / `f.call.MCP` guards); `codexTitle`/`codexDescription` are turn-level requests that arrive through `keyLimited` themselves, not derivatives. The one derivative left out is the routing group's classifier (`classify.go:618`) — honestly declared here and filed separately as #5912.
- **Fail-closed, and quiet about it.** A held search stops where the refusal is seen — no next searcher is tried, no Settings-named searcher is marked failed — and the tool result the model sees says only "web search is unavailable for this request" (`sideSaid`), never the key's name or magpie's, since that text goes on to the vendor. The image path drops the picture with the existing omission text and lets the turn continue instead of failing it.
- **The in-flight grace is bounded and tested.** `roomFor` lets an ask through only while the key's spent-alone usage leaves room, so a turn's large image isn't dropped on a key with most of its limit left (`TestKeyLimitDescribesALargeImageWithRoomLeft`); the cost of the grace is at most the ask's own estimate, and the ask is released without holding a reservation.
- **Kimis's and WorkBuddy's search services** bypassing `serve` are declared out, not silently forgotten.

## What I did not verify

- No real key against a real searcher or describer (the report says the same).
- The full `internal/gateway` package does not finish inside a test run's time on this machine; I ran the report's family (above) rather than the whole package.
- The re-ask for another key's waiter on a shared image (`describeKeyed`) has no test — the report says so too; I read that path and it holds together (the waiter retries past the shared look only when the held key is not its own), but it is untested.
- The 1600-token figure for an image reservation is a judgement call, defended by the large-image test; whether it matches every describer's real counting is vendor-side and untestable here.

**Attribution**: verification by me, written AI-assisted; the fix is the reporter's — keep the authorship of `pr/3-key-limit-side-asks` (and add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` only if the verification patch, if any, is wanted).
