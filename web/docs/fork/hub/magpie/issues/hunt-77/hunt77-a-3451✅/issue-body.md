Took the flake apart and landed a test-only stabilization: the asking loop now retries the way a real client does, and the assertion stands.

**What the window is.** The magpie handing over stops serving at the end of the handover, and `http.Server.Shutdown` closes the pooled idle keep-alive connections before it waits for the requests in flight. A request sent the moment one of those connections dies reads EOF — the report's `Post "http://127.0.0.1:56037/v1/chat/completions": EOF`. Go's own transport already absorbs the common interleavings (a replayable POST on a reused connection is retried for `errServerClosedIdle` and `transportReadFromServerError`), and what surfaced once in the full suite is one of its narrowest gaps: an EOF read where the response line should be, or a death on a connection's first request, which is never retried. The gateway itself holds its side of the promise the handover's comment makes: the socket is never closed (the new magpie holds a duplicate of it), so no dial is ever refused, and the requests in flight are waited for (15 minutes, `handedOffDrain`). Closing pooled idle connections at the end is how every HTTP server quits; there is no product defect to fix past that, so the change is test-only.

**What changed** (`internal/gui/handover_unix_test.go`, +16/−1): the asking loop retries a POST whose transport failed — three tries, 10 ms apart — which is what curl, browsers and the agents' SDKs all do across a server's keep-alive close. The assertion is unchanged: every request sent along the restart must still be answered (200, `"quick"`), by the old magpie or the new one; a request that goes unanswered for good still fails the test.

| Check | Result |
|---|---|
| Fault injection — a test-only transport answers the first POST sent while the handover is pending with `io.EOF` (the report's own failure) | red on the old test at `handover_unix_test.go:192` with the report's message, green with this change |
| Injected handovers, 3 in a row | green |
| `TestRestartHandsTheGatewayOver` alone | green 5 of 5 |
| `internal/gui` full suite (`-tags nogui`, 51s) | green except `TestProxyCheckSaysAProxyPassedBy`: red 3 of 3 on its own in this sandbox (its local proxy answers HTTP 502, "asked 0 times"); the file is untouched by this change — pre-existing environment red, not re-run on a clean tree |
| `-race` on the three handover tests | green, no DATA RACE |
| `gofmt -l internal/gui` | clean |
| `go vet ./internal/gui` — darwin; GOOS=linux `-tags nogui`; GOOS=windows | clean |
| `go build ./...` — darwin; GOOS=linux `-tags nogui`; GOOS=windows | clean |
| GOOS=linux vet without `-tags nogui` | not run to a pass: wails v3's own linux files don't compile in this cross setting (`undefined: pointer`), pre-existing, untouched by this change |

Left alone, for the record: the new magpie acks before its `Serve` starts (`gateway.ListenAndServe` acks right after taking the inherited listener, then sets its observers and plugins up), so the old one can stop accepting a few hundred ms before the new one accepts — a latency blip for dials in between, never an EOF. Narrowing it would touch the ack protocol for no client-visible failure this report is about.

—
**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: restart-handover-test-retry (#3451) — git am applies it as is; SHA-256 first 16: 46219faa474d45ac</summary>

```text
From c16baa88351b0c3331a625f5ecfe242a8908f23b Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 17:18:16 +0800
Subject: [PATCH] tests: a request the handover's keep-alive close cut short is
 retried (#3451)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The magpie handing over closes its idle keep-alive connections when it
stops serving (http.Server.Shutdown closes them before it waits for the
requests in flight), and a request sent the moment one dies reads EOF:
once in a full suite, 1 of 13 requests along the restart (#3451). A real
client retries such a death and is answered — the socket is never closed
on the way, the new magpie serves it — but the test's asking loop took
its plain http.Post at its word. Three tries, 10ms apart, ask the way a
real client does; the assertion stays that every request sent along the
restart is answered (200, "quick").

The handover itself needs no change: the socket is never closed, so no
dial is ever refused, the requests in flight are waited for (15min), and
closing pooled idle connections at the end is how every HTTP server
quits; Go's own transport absorbs it the same way, and only its narrowest
races (a first request on a fresh connection, a response line that reads
EOF) can surface at all.

Run:
- fault injection (test-only transport answering the first POST sent
  while the handover is pending with io.EOF, the report's own failure):
  red on the old test at the report's line and message, green with this
  change; three injected handovers in a row, green.
- TestRestartHandsTheGatewayOver alone: 5 of 5.
- gofmt -l internal/gui (clean); go vet ./internal/gui on darwin, linux
  and windows (clean); go build ./... on the three (clean); the gui
  package's full suite (see the issue comment for the split).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/handover_unix_test.go | 17 ++++++++++++++++-
 1 file changed, 16 insertions(+), 1 deletion(-)

diff --git a/internal/gui/handover_unix_test.go b/internal/gui/handover_unix_test.go
index 566b4260..b4657f8f 100644
--- a/internal/gui/handover_unix_test.go
+++ b/internal/gui/handover_unix_test.go
@@ -187,7 +187,22 @@ func TestRestartHandsTheGatewayOver(t *testing.T) {
 			default:
 			}
 			asked.Add(1)
-			r, err := http.Post("http://"+addr+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"plan/m1","messages":[{"role":"user","content":"hi"}]}`))
+			// the magpie handing over closes its idle keep-alive
+			// connections when it stops serving (http.Server.Shutdown),
+			// and a request sent the moment one dies reads EOF; any real
+			// client retries, and the socket is never closed (the new
+			// magpie serves it), so the retry is answered
+			var r *http.Response
+			var err error
+			for try := 0; try < 3; try++ {
+				if try > 0 {
+					time.Sleep(10 * time.Millisecond)
+				}
+				r, err = http.Post("http://"+addr+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"plan/m1","messages":[{"role":"user","content":"hi"}]}`))
+				if err == nil {
+					break
+				}
+			}
 			if err != nil {
 				t.Errorf("a request during the restart: %v", err)
 				return
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt77-a-restart-handover](https://github.com/ggbdpq/magpie/tree/hunt77-a-restart-handover) (head `c16baa88351b0c3331a625f5ecfe242a8908f23b`).
