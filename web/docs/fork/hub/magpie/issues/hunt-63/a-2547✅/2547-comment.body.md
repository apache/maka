Summary

`TestSearchQueueKeepsCodexAlive/silent` went red under load with `silent upstream covered indefinitely: pings=0 complete=false` (twice on this issue, at load ~250 and ~330-420, always green alone). The subtest stands for: a silent upstream is covered finitely, then the client's idle ends the wait. What it actually measured under load was the machine, not the state.

Why it went red

The client armed its 300ms idle deadline at the response headers (the old search_queue_test.go:104), before a single byte of the body. Under load, the path from headers to the first translated event — queue handoff, upstream dial, SSE decode, translation — is exactly what a busy machine stretches, so the deadline fired with `pings=0` and cancel cut the stream before the first ping: an upstream being covered looked like one covered forever.

What changed

- The idle window now starts at the first data line, the same state line its resets already followed. 300ms still bounds every gap the stream leaves, so the covered-finitely semantics are untouched; the 5s hard cap still ends a stream that never speaks, and a truly covered-forever upstream still fails the same `pings>12` / never-completes checks.
- The silent subtest holds the fake queue's first event back 500ms past the headers. With the old headers-armed window that reds deterministically (`pings=0`, the load red without the load), so the regression stays locked; with the new window the test passes with the stream's real gap timing.

Verification
| Check | Result |
| --- | --- |
| `go test -tags nogui ./internal/gateway -run TestSearchQueueKeepsCodexAlive -count=3` | ok (3/3, all four subtests) |
| Ablation: window re-armed at headers, hold kept | silent red `search_queue_test.go:148: silent upstream covered indefinitely: pings=0 complete=false`, other subtests green |
| `go test -tags nogui ./internal/gateway -count=1` (full package) | ok, 338.6s |
| `go test -tags nogui -race ... -run 'TestSearchQueueKeepsCodexAlive|TestTranslatedStreamKeepsClientAlive|TestTranslatedSilenceStillTimesOut' -count=2` | ok, 14.5s |
| `gofmt -l internal/gateway` | clean |
| `go vet ./...` | exit 0 (two pre-existing cgo `-Wenum-conversion` warnings in internal/gui, untouched by this patch) |
| `GOOS=linux go vet -tags nogui ./...` / `GOOS=windows go vet -tags nogui ./...` | both exit 0 |
| `go build -tags nogui ./...` on darwin/linux/windows | all ok |

Not verified

- Not rerun under real machine load (~300): the deterministic 500ms hold stands in for it, which is the same failure the load produced (first data later than the old fixed window). A true silent-upstream regression (covered indefinitely) still fails via `pings>12` or the 5s hard cap, so the guard the subtest exists for is intact.
- `-race` covers the three idle-window tests, not the whole package, proportionate to a timing change confined to one test.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
<details><summary>patch: tests: the search queue's idle client times the state, not the headers (#2547) — git am applies it as is; SHA-256 first 16: 89dd3cbbf021c3db</summary>

```patch
From 9700d630a4bfa7a9f6730907c46b2564b1e4ded7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 22:25:57 +0800
Subject: [PATCH] tests: the search queue's idle client times the state, not
 the headers (#2547)

TestSearchQueueKeepsCodexAlive/silent went red under load (yetone's
runs at load ~250 and ~330-420, passing alone): pings=0, complete=false
at search_queue_test.go:139. The client's 300ms idle was armed at the
response headers, so the loaded path from headers to the first
translated event counted against the window, cancel cut the stream
before the first ping, and a covered-while-speaking upstream looked
like a covered-forever one.

What changed
- The idle window now starts at the first data line, the same state
  line its resets already followed: 300ms still bounds every gap the
  stream leaves, the 5s hard cap still ends a stream that never speaks,
  and a truly covered-forever upstream still fails the pings>12 check.
- The silent subtest holds the fake queue's first event back 500ms
  past the headers, which deterministically reds the old headers-armed
  window (pings=0) without any real load.

Run at ba1dc7f97 (upstream/main), -tags nogui ./internal/gateway:
- Old window, held first event: silent red,
  "silent upstream covered indefinitely: pings=0 complete=false",
  comments/progress/cancel green.
- New window, -run TestSearchQueueKeepsCodexAlive -count=3: ok.

Fixes #2547
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/search_queue_test.go | 27 ++++++++++++++++++++++++---
 1 file changed, 24 insertions(+), 3 deletions(-)

diff --git a/internal/gateway/search_queue_test.go b/internal/gateway/search_queue_test.go
index b2195ddb..7d03dfb7 100644
--- a/internal/gateway/search_queue_test.go
+++ b/internal/gateway/search_queue_test.go
@@ -28,6 +28,7 @@ func TestSearchQueueKeepsCodexAlive(t *testing.T) {
 		t.Run(mode, func(t *testing.T) {
 			fresh(t)
 			release, stopped := make(chan struct{}), make(chan struct{})
+			proceed := make(chan struct{})
 			var once sync.Once
 			finish := func() { once.Do(func() { close(release) }) }
 			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
@@ -47,6 +48,7 @@ func TestSearchQueueKeepsCodexAlive(t *testing.T) {
 					http.Error(w, "missing tools", 400)
 					return
 				}
+				<-proceed
 				w.Header().Set("Content-Type", "text/event-stream")
 				io.WriteString(w, "data: "+`{"type":"response.created","response":{"id":"queued","model":"m1","status":"in_progress"}}`+"\n\n")
 				w.(http.Flusher).Flush()
@@ -101,8 +103,23 @@ func TestSearchQueueKeepsCodexAlive(t *testing.T) {
 				t.Fatal(err)
 			}
 			defer res.Body.Close()
-			idle := time.AfterFunc(300*time.Millisecond, cancel)
-			defer idle.Stop()
+			// #2547: the idle window starts at the first data line, not at
+			// the headers: a loaded machine's path to the first translated
+			// event is not the client's idle, and the hard cap still ends a
+			// stream that never speaks.
+			var idle *time.Timer
+			defer func() {
+				if idle != nil {
+					idle.Stop()
+				}
+			}()
+			// Hold the queue's first event back past the fixed window the
+			// idle once started at headers with, so silent keeps a red if
+			// the window ever starts ahead of the state again.
+			if mode == "silent" {
+				time.Sleep(500 * time.Millisecond)
+			}
+			close(proceed)
 			var body strings.Builder
 			pings, completed := 0, false
 			sc := bufio.NewScanner(res.Body)
@@ -110,7 +127,11 @@ func TestSearchQueueKeepsCodexAlive(t *testing.T) {
 				line := sc.Text()
 				body.WriteString(line + "\n")
 				if strings.HasPrefix(line, "data:") {
-					idle.Reset(300 * time.Millisecond)
+					if idle == nil {
+						idle = time.AfterFunc(300*time.Millisecond, cancel)
+					} else {
+						idle.Reset(300 * time.Millisecond)
+					}
 				}
 				if strings.Contains(line, `"type":"response.in_progress"`) {
 					pings++
-- 
2.50.1 (Apple Git-155)

```
</details>

Branch with the commit: [hunt63-a-2547-search-queue](https://github.com/ggbdpq/magpie/tree/hunt63-a-2547-search-queue) (head `9700d630a4bfa7a9f6730907c46b2564b1e4ded7`).
