I verified the branch this issue ships with — `frankekn:fix/codex-socket-turn-copies` (head `02e7c039fae92f325daf0abe8755b32c6023fcaa`, one commit on `internal/gateway/codex_socket.go`, `codex_socket_keep.go` and a new `codex_socket_heap_test.go`) — and it does what the issue says, at the right three roots. This is the reporter's own work; I only verified it, so authorship is theirs (please keep `frankekn` as the author, or add `Co-authored-by: frankekn` if it lands any other way).

**What the branch does.** The three holders the issue names are each let go at their root:

- `turn`'s `ended` closure captured the whole `response.create` message only to report its length; it now captures `len(msg)` alone, so the message is garbage once written.
- `codexTurnShape` lived as long as the reply and held every input item for the next turn's delta; it now holds their digests (`itemSum`, as before), with the items handed to `delta` as views of the request body (`decodeJSONView`, the reader `fastjson.go` already has) and gone with it.
- A kept socket's turn built the whole message up front and held it beside the delta in case a new socket must take the turn; it now builds only what it sends, and if the turn does go whole on a new socket, the body is read from the request again (`codexSocketMessage`), falling back to plain HTTP when that read fails.

The delta's bytes and the `codexMessageTooBig` sizes are unchanged by construction: the kept path sizes on `len(codexCreate(send))` exactly as it sized on the pre-built send before.

**Verification.**

| Check | Result |
| --- | --- |
| `go build ./internal/gateway/`, `gofmt -l`, `go vet` (branch) | pass / clean / clean |
| `TestCodexSocketTurnLetsItsBytesGo` on the branch | PASS |
| Same test on `main` (`025123431`), only the test file carried over | FAIL — "a 15 MB turn holds 49 MB awaiting its reply, 3.3 times the turn" (fresh and kept sockets both) |
| Codex socket family + the four tests the reporter saw fail on go1.27.3 (`TestMarshalRawIsEncodingJSON`, `TestMarshalSizedIsJSONMarshal`, `TestMarshalRaw` fuzz aside, `TestServeWSLListensBesideLoopback`) | pass here (go1.26.8, the version go.mod asks for) |
| Branch base vs current `main` | base `59d9f5c7`; no commit since touches `codex_socket.go`/`codex_socket_keep.go` — no drift in the touched files |

The test is a real red: on `main` the held ratio is 3.3x, the branch brings it under the threshold the test pins (1.1-1.3x by the reporter's run), and the reporter's own three one-at-a-time breaks (each fix reverted alone turns the test red) match the three roots above.

**Scope, as the issue says.** This is magpie → ChatGPT backend (`codex_socket.go`); #4668's 2.2 GB was Codex client → magpie (`responses_ws.go` rebuilding the conversation each turn) and stays open — the reporter's own scratch measurement says the patched build still holds ~4.3x during a turn (the request body as read, `rewriteModel`'s copy, the `codexBody` marshal, `previousResponse`'s items), all left serving retries. That is honest scoping, not a claim the whole path is lean.

**Source**: branch https://github.com/frankekn/magpie/tree/fix/codex-socket-turn-copies (head `02e7c039fae92f325daf0abe8755b32c6023fcaa`); verified in a clean worktree at `upstream/main` `025123431`.
**Red without the fix** (base `025123431`, test carried over): `codex_socket_heap_test.go:83: fresh socket: a 15 MB turn holds 49 MB awaiting its reply, 3.3 times the turn` / `kept socket: a 15 MB turn holds 49 MB awaiting its reply, 3.3 times the turn`.
**Siblings**: the three holders are each single-rooted — the `ended` closure in `turn`, the shape's `input` field, and `overSocket`'s kept path; no other reader of `codexTurnShape.input` existed (the field is gone; `delta`'s one caller now hands it the items), and the keep pool's other reads (`codexKeepKey`, `codexKeepTake`) keep their signatures.
**When the read fails**: a kept turn whose request body can't be re-read goes to `t.next.RoundTrip(req)` — the turn still goes, as plain HTTP, rather than dying on the read.
**Not verified**: the reporter's 90 MB-session gateway end to end (no such session here); the ~4.3x remainder is their scratch measurement, not mine.
**Attribution**: frankekn's fix; I verified the branch (build, tests, red-on-main ablation, root coverage, sizes) and wrote this comment. AI-written verification note; I've read the whole diff and can answer questions on it myself. Please keep the author (`frankekn`) or add `Co-authored-by: frankekn <frankekn@users.noreply.github.com>`.
