I verified the fix branch this issue ships with — `pawamamama:fix/keepalive-client-counted` (head `81186494d7cf0370e7843df21338681c446f6c71`, 2 commits on `internal/gateway/fallback.go` + a new test file) — and it does what the issue asks, in the right place. This is the reporter's own work; I only verified it, so the authorship is theirs (please keep `pawamamama` as the author, or add `Co-authored-by: pawamamama` if it lands any other way).

**What the branch does.** Both places a held stream keeps its client alive with a byte (`holdWriter.keepAlive`, `holdWriter.keepQuiet` — the only two `: keepalive` writers for a waiting client; every caller of either, `patience.go` and `fallback.go`, funnels through them) now go through one seam, `clientHeartbeat(proto)`: a `provider.Chat` client is kept with a chunk it parses — the same envelope `chatEncoder.chunk` writes (`id`/`object`/`created`/`model`/`choices`/`usage`) with an empty delta, precomputed once as a package-level byte slice so the hot path pays nothing — and every other protocol returns nil, keeping the comment exactly as before. Gemini is already excluded upstream of the write (`keepAlive` returns early for `provider.Gemini`, #934), so it keeps nothing, as the issue says. The Responses enum's own `: keepalive` passthrough (`responses_enum.go`) is a different path — an upstream's keepalive relayed to a Responses client, not a waiting client held by the gateway — and leaving it alone matches the issue's "Responses keeps the comment on purpose".

**Verification.**

| Check | Result |
| --- | --- |
| `go build ./internal/gateway/` | pass |
| `gofmt -l` (both touched files) | clean |
| `go vet ./internal/gateway/` | clean |
| `TestClientCountedKeepalive` + `TestHeartbeatCarriesNoWord` on the branch | PASS (chat / anthropic / responses subtests) |
| Same tests on `main` (`db0f2f20d`) with only the test file carried over | FAIL — chat: "the chat client was kept alive with nothing it counts"; heartbeat: "no heartbeat chunk was parsed"; anthropic/responses subtests PASS (comment kept, as intended) |
| Branch base vs current `main` | 5 commits behind; the only `fallback.go` commit in between (`72e804d2b`) touches `planPaused`/`planGroup` (~line 537-680), the heartbeat seam sits at ~3246-3780 — no overlap |

**What I did not run.** A real DeepSeek Harness through llm-pi-ai (the issue's client) — the Chat parse in the test mirrors the OpenAI SDK's line-by-line decoding, but the client itself is outside this repo; and the maintainer's own acceptance. `go test ./internal/gateway/...` full-suite result is pending in my run and will be appended as a follow-up comment if it surprises (the reporter reports green except the pre-existing `TestAdvisorModelAsTheUpstreamNamesIt`).

The direction is right for the same reason #436 was: a client that drops the comment counts nothing, so the heartbeat has to be an event that client parses — and only where its parser tolerates one before the reply begins. The tests pin both halves: the Chat client must hear a parsed chunk, and Anthropic/Responses must hear nothing but the comment (their parsers fail on an event before `message_start` / would carry a `sequence_number` out of step with the encoder). The heartbeat's empty delta is pinned to carry no word (`TestHeartbeatCarriesNoWord`), which is the plugins#738 hazard the issue also names.

**Source**: branch https://github.com/pawamamama/magpie/tree/fix/keepalive-client-counted (head `81186494d7cf0370e7843df21338681c446f6c71`); verified in a clean worktree at `upstream/main` `db0f2f20d`.
**Red without the fix** (base `db0f2f20d`): `--- FAIL: TestClientCountedKeepalive/chat client_counted_keepalive_test.go:159: the chat client was kept alive with nothing it counts` / `--- FAIL: TestHeartbeatCarriesNoWord client_counted_keepalive_test.go:242: no heartbeat chunk was parsed`.
**Siblings**: the only two waiting-client keepalive writers are `fallback.go` `keepAlive`/`keepQuiet` — both covered; `responses_enum.go:105` is the upstream-keepalive relay path, out of scope by the issue's own terms.
**When the read fails**: unchanged — a client that cannot be read from keeps the old comment path (non-Chat `clientHeartbeat` returns nil, and a provider that sends nothing at all stays uncovered, as in #436).
**Not verified**: a live llm-pi-ai/DeepSeek Harness client end to end; maintainer acceptance.
**Attribution**: this is pawamamama's fix; I verified the branch (build, tests, red-on-main ablation, sibling write-points, direction) and wrote this comment. AI-written verification note; I've read the whole diff and can answer questions on it myself. Please keep the author (`pawamamama`) or add `Co-authored-by: pawamamama <pawamamama@users.noreply.github.com>`.
