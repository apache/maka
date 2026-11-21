The largest Codex turns count as 0 tokens because `usageSniffer` held an SSE event to a megabyte in two places (`internal/gateway/sniff.go`), both dating from the usage page itself (30c489a0): a data line pushing the event past 1 MiB dropped it, and a line still arriving past 1 MiB dropped the buf — while `event: response.completed` still set `ended`, so the stream read as finished and only the numbers went missing. `sse.go`'s readers already take a 32 MiB line, so the sniffer takes the same room now; an event past the room is still let go whole, and what the client receives is unchanged. One commit: head `f73f75258` on tip `dbaeaec12`, branch [`fix/5505-oversize-event`](https://github.com/ggbdpq/magpie/tree/fix/5505-oversize-event). Patch below, `git am` applies it as is; SHA-256 first 16: `a9f70212e7091d89`.

**What changed**

- `internal/gateway/sniff.go`: both caps are `sniffEventMost` (32 MiB) now, the line `sse.go`'s scanner takes; `write` searches only what came new for the line's end (`scanned`), so a line of megabytes isn't searched from its start on each 32 KiB write.
- `internal/gateway/sse.go`: the scanner's max token is `sniffEventMost` — the same 32 MiB it already took, one name now.
- `internal/gateway/sniff_test.go`: `TestSniffUsagePastOneMiB`, `TestSniffEventPastTheCapIsLetGo`.

**Tests** (provider.Responses, `text/event-stream`, written in 32 KiB chunks as both copy loops — the pass-through's and the ChatGPT backend's — feed the sniffer)

| Test | on main `dbaeaec12` | here `f73f75258` |
| --- | --- | --- |
| `TestSniffUsagePastOneMiB` (a `response.completed` of 1 MiB + 126 bytes echoing the request's tools, usage 313000 in / 9000 out, `resp_big`) | FAIL: usage `in: 0, out: 0` and no `response_id` — the record the issue shows | PASS, and the stream still reads as ended |
| `TestSniffEventPastTheCapIsLetGo` (a whole event past the cap let go, a never-ending line dropped, what follows still counted) | PASS (the old cap let it go too) | PASS |
| every other `TestSniff*` | PASS | PASS |

Ablation, each caught by a FAIL: the data-line cap back at 1 MiB → the first test reads usage 0 again; both caps off → the giant event's own counts (999999/888888) read over the first reply's; the buf cap back at 1 MiB alone stays green — with a line just past the cap, the crossing 32 KiB write carries its end, so that cap bites only a line that stays runaway, which the never-ending subtest holds. `Usage.add` is later-wins, which is why the giant event is told last.

**Siblings** (compared, none touched)

- the two `sniff.write` callers — the pass-through copy loop (`gateway.go`) and the ChatGPT backend's (`codex_backend.go`) — hand the sniffer every byte in 32 KiB chunks; nothing between them drops the event first.
- `sse.go`'s scanner: the same limit it already had, one name now.
- the plain-JSON body cap (`8<<20`, `over`) is untouched: the issue is the SSE path.
- the other line accumulators (`chattidy` and its family, `claude_warmup`, `ollama_chat`, `sse_bare`, …) hold event-level buffers behind a reader's own line cap, or small working buffers; none drops usage on an oversized event.

**Verified** (head `f73f75258`, darwin/arm64, go1.25.5): `go test -tags nogui -count=1 -run TestSniff ./internal/gateway` ok; `go test -tags nogui -count=1 -timeout 25m -race ./internal/gateway` 23m47s with one FAIL, `TestBrowserKeyOffClosesItsBrowser`, a data race that `dbaeaec12` fails the same way (checked on a clean worktree) — every `TestSniff*` green under `-race`. `gofmt -l` clean on the changed files; `go vet -tags nogui ./internal/gateway` clean on GOOS=darwin, linux and windows; `go build -tags nogui ./...` ok on the three. Not run: the GUI suite (no GUI change), run time on Linux or Windows, and the live ChatGPT backend — the echo-tools shape is the report's own finding, replayed here, not re-confirmed against the real one.

Thanks @R1cK-ChaN for the report, the cause, and the branch — the diagnosis and the cap design are theirs; this patch is an independent implementation of the same idea (their 88c97cfb2 says it too, write-path scan included), and either applies.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a stream event over a megabyte keeps its usage — git am applies it as is; SHA-256 first 16: a9f70212e7091d89</summary>
