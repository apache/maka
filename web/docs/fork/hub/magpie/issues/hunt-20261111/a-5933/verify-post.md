I verified the branch this issue ships with — `pawamamama:fix/keepalive-client-counted` (head `81186494d7cf0370e7843df21338681c446f6c71`) — before anyone builds on it. The direction is right and the new tests genuinely pin the issue's ask, but the branch as it stands fails 15 existing tests in `internal/gateway`, so it is not ready to land as is.

**What the branch gets right.** Both places a held stream keeps its client alive with bytes (`holdWriter.keepAlive`, `holdWriter.keepQuiet` — the only two `: keepalive` writers for a waiting client; every caller of either funnels through them) go through one seam, `clientHeartbeat(proto)`: a Chat client is kept with a chunk it parses, the same envelope `chatEncoder.chunk` writes with an empty delta (precomputed once, so the hot path pays nothing), and every other protocol returns nil and keeps the comment. Gemini stays excluded upstream of the write (`keepAlive` returns early for `provider.Gemini`, #934), and the Responses enum's own `: keepalive` passthrough (`responses_enum.go`) is a different path — an upstream's keepalive relayed, not a waiting client held — so leaving it alone matches the issue's own terms.

**The blocker.** On the branch, `go test ./internal/gateway/` fails 15 tests that pass on `main` (`db0f2f20d`) — all of them pin the contract this fix intentionally changes, that a held Chat stream is kept alive with the comment:

```
TestGroupLastFailureInStreamSaysItPasses
TestHeldGeminiStreamSendsNoComment
TestHeldUnsureKeptAlive
TestKeptAliveChatErrorNamesTheModel
TestKeptAliveChatOnCodexErrorNamesTheModel
TestQueuedStreamFailureIsTheStreamsError
TestQueuedStreamKeptAliveForASlot
TestQueuedStreamKeptAliveForTheMinute
TestQueuedStreamKeptAliveOnceSentToItsVendor
TestQuietNotAReplyLastFails
TestQuietStreamsKeptAliveEveryProtocol
TestQuietWholeReplyStreamed
TestSilentHeldStreamKeptAlive
TestSilentHeldStreamStillFailsOver
TestStreamedByteCapSaysRequestTooLargeToPi
```

For example `TestHeldGeminiStreamSendsNoComment` (attachments_test.go:113) asserts for `{Gemini: false, Anthropic: true, Chat: true}` that the held stream's body contains `: keepalive` — the Chat case now finds the heartbeat chunk instead. These files are unchanged between the branch's base (`401187300`) and current `main`, so this is not drift: the branch fails them on its own base too, and the "Ready" note's "go test ./internal/gateway/... green except a pre-existing TestAdvisorModelAsTheUpstreamNamesIt" does not reproduce here. Updating those 15 to the new contract (and keeping them pinning Gemini-sends-nothing and Anthropic-keeps-the-comment) belongs in this change, the same way the branch's own two tests pin the new one.

**Verification.**

| Check | Result |
| --- | --- |
| `go build ./internal/gateway/`, `gofmt -l`, `go vet` (branch) | pass / clean / clean |
| `TestClientCountedKeepalive` + `TestHeartbeatCarriesNoWord` on the branch | PASS |
| Same two tests on `main`, only the test file carried over | FAIL — chat: "the chat client was kept alive with nothing it counts"; heartbeat: "no heartbeat chunk was parsed" (anthropic/responses subtests PASS, comment kept as intended) |
| The 5 fast tests of the 15 above, on pristine `main` | PASS (1.2s) |
| Full `go test ./internal/gateway/` on the branch | FAIL — the 15 listed (22.6 min run) |

**Source**: branch https://github.com/pawamamama/magpie/tree/fix/keepalive-client-counted (head `81186494d7cf0370e7843df21338681c446f6c71`); verified in a clean worktree at `upstream/main` `db0f2f20d` (no keepalive-domain commit has landed since; upstream is now `025123431`, library/GUI only).
**Red without the fix** (base `db0f2f20d`): `--- FAIL: TestClientCountedKeepalive/chat client_counted_keepalive_test.go:159: the chat client was kept alive with nothing it counts` / `--- FAIL: TestHeartbeatCarriesNoWord client_counted_keepalive_test.go:242: no heartbeat chunk was parsed`.
**Siblings**: the two waiting-client writers are the only ones — both covered; `responses_enum.go:105` is the upstream-keepalive relay path, out of scope by the issue's own terms.
**When the read fails**: unchanged on the branch — non-Chat `clientHeartbeat` returns nil and the old comment path stands; a provider that sends nothing at all stays uncovered, as in #436.
**Not verified**: a live llm-pi-ai/DeepSeek Harness client end to end; the maintainer's acceptance.
**Attribution**: the branch is pawamamama's work; I verified it (build, tests, red-on-main ablation, sibling write-points, direction) and wrote this comment. AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`pawamamama`) or add `Co-authored-by: pawamamama <pawamamama@users.noreply.github.com>` when it lands.
