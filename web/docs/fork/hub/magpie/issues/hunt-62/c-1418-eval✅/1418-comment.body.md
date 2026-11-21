I read the patch (`c6dbabe2`) against current `main` (`87d703c5`) and verified it independently. It fixes a facet that is still live there, it matches the Oct 15 trace, and it composes with everything that has already landed for this issue. Two review questions at the end.

## The facet is still open on `main`

The frames-only fix keeps unknown framing from committing a held stream — `streamEvent` returns `eventLead` for items that don't `said()` — but a hosted search still does: `streamPart.said()` answers true for any item type containing "call" (`web_search_call`), and `replyEvent` matches both the `output_item.` prefix and the `response.web_search_call.*` progress events, so search lands in `eventContent`, `scan()` flows on the first of it, and a `response.failed` after the search is a late failure with the remaining candidates never asked. That is the Oct 15 shape: reasoning, a completed `web_search_call`, then `server_is_overloaded`.

It reproduces: on a tree at `87d703c5` with this patch's test file and the classification reverted to `eventContent` (main's behavior), `TestResponsesHostedSearchFailsOver` fails in all nine subtests because the next candidate is never asked.

The patch covers the real trace, not just the repro: reasoning from a GPT-family candidate that is not the last one is held anyway on `main` (`thinkingShown` is false there), so with search held too, the try has committed nothing when `response.failed` arrives, and the existing next-candidate and Patience paths take over. Reasoning released by the existing policy (a vendor that never refuses after thinking, or the last candidate) still commits the stream — the patch's stated boundary, and the remaining facet of this issue, unchanged.

## Rebase surface onto `87d703c5`

The branch is based 272 commits back. `gateway.go`, `routing.go`, `overload_test.go` and `routing-went-on.test.cjs` merge clean. Three conflicts, all mechanical, all both-sides-added-adjacent-lines: the `holdWriter` struct fields (main added `thoughtThrough` where the patch adds `searchHeld`/`heldLimit` — keep both; the merged `scan()` is exactly the patch's shape with main's `thoughtThrough` assignment preserved), the `FAIL` map in `client.js` (main added `room:`), and four dictionary blocks in `i18n.js`. No semantic conflicts.

## Verification (merged tree)

| Check | Result |
| --- | --- |
| The new tests (`TestResponsesHostedSearch*`, `TestResponsesSearchAPIFollowupFailsOver`, `TestHeldSearch*`, ~30 subtests) | pass — including that a success with only search output is delivered whole, and a 400 after search does not fail over |
| Ablation: classification reverted to `eventContent`, tests kept | `TestResponsesHostedSearchFailsOver` 9/9 subtests FAIL, `TestHeldSearchLimitsDoNotRelease` FAIL; restored, green |
| Already-landed #1418 family (`TestGroupWaitsOutEveryMemberOverloaded`, `TestCodexStreamWaitsOutOverloadedGroup`, `TestFramesThenOverloadedGoesToTheNext`, `TestPatienceIsUsedUp`, `TestAgentGoneInTheRetryPause`, `TestSafetyBufferedStreamHeldLonger`) | pass |
| `go build` / `go vet` / `gofmt` | clean |

Not run: the full gateway suite, `-race`, the GUI suites, and any real overloaded upstream.

## Two review questions

1. **Scope.** Only `web_search_call` is held. On `main`, `said()` still answers true for other hosted-tool items — `server_tool_use`, `mcp_tool_use`, anything with "call"/"tool" in the type — so the same late failure remains reachable after those. If holding them is deliberate follow-up staging, fine; worth a line saying so.

2. **The wait-time bound.** `limitSearchHold` reuses `holdLead`, which is 4 minutes on `main`. Before this change a search that ran longer than that still completed, since the stream passed at the first search event; now it becomes a local 504 plus a retry on the next candidate, or the error to the agent when none is left. Rare, but on a single-member provider a very long search used to succeed and now fails. Would it be worth relaxing the bound once `response.web_search_call.completed` has arrived, and keeping the tight bound only while the search is still running?

The `held_limit` try not resting, not replanning, and never releasing the abandoned search matches the local-limit direction discussed on #1421, and the routing copy reads right.
