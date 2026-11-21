The leg that fails is magpie's own to chatgpt.com. Since a2e98cd7 a streamed Codex turn goes to the backend over its WebSocket (`internal/gateway/codex_socket.go`), as Codex's own client sends it — the client-facing route stays HTTP. The ceiling is not magpie's: the socket's read limit is off (`c.SetReadLimit(-1)`) and the write side has none, so the `StatusMessageTooBig` close frame is the backend's answer to a turn message over what its socket takes. Your A/B is exactly that: the same 18.2 MB request that dies on the socket clears over the HTTP route, and the native client's log names the same remedy (`falling back to HTTP`).

Until now that close frame was fatal. It arrives while the transport reads ahead for the reply's head, and the error — `codex websocket: failed to get reader: received close frame: status = StatusMessageTooBig` — was not the kind of failure the socket retries over HTTP (`errCodexSocketFallBack`): it fell through to the gateway's "OpenAI can't be reached" 502, which reads as a network or sign-in fault. The fix reads the frame for what it is: a close `StatusMessageTooBig` before the reply began means the backend took nothing of the turn, so the turn goes over HTTP as it was — the fallback a refused handshake already takes. The host is not shunned for it (a message size is not the host refusing sockets), so the next, small turn is on the socket again. A close after the reply began stays a cut stream, as before — nothing replays once events have gone out.

Independent work, same fix: skygunner's patch posted above ([b834f286](https://github.com/skygunner/magpie/commit/b834f286), first) classifies the frame the same way and stands as the earlier one; the patch below is my own take, kept as a second, independent one for the maintainer to pick from. The deltas: theirs also guards the socket's write leg, which the library's writer cannot see a close frame on (the frame arrives on the read-ahead leg, in both); their test has the fake refuse every message, so it proves two consecutive fallbacks, mine refuses only big ones, so it also pins a small turn going whole over the socket right after a big one was refused — either stands.

## What changed

- `internal/gateway/codex_socket.go` (+7): in the prelude read for the reply's head, a close frame with `websocket.StatusMessageTooBig` returns `errCodexSocketFallBack`, the fallback the RoundTrip already takes for a refused handshake. No setting, no shun, no retry loop.
- `internal/gateway/codex_socket_test.go` (+37): the fake backend learns `tooBig` — which turns it answers with a close `StatusMessageTooBig` instead of a reply — and `TestCodexSocketTooBigGoesOverHTTP` pins the behavior: a turn whose message is over 1 MiB is answered over HTTP after its socket try (200, the SSE events, no `MessageTooBig` reaching Codex), and the next, small turn is on the socket again (1 HTTP post, 2 sockets).

## Verification

(darwin/arm64, Go 1.26, base dd1e8822 + the commit below)

| Check | Result |
| --- | --- |
| RED, product hunk reverted (test kept), fake backend closes the socket with `StatusMessageTooBig` after a >1 MiB turn message | FAIL: `the big turn: 502 ... OpenAI can't be reached (Post ...: codex websocket: failed to get reader: received close frame: status = StatusMessageTooBig and reason = "")` — the reported signature |
| GREEN, fix in | pass: the big turn over HTTP (200, the SSE events, no `MessageTooBig` in the reply), then the small turn whole over the socket — 1 post, 2 sockets |
| ablation on the committed tree (revert: red again; restore: green) | red and green as above; working tree clean after |
| `go test -tags nogui ./internal/gateway/` (whole package) | ok 357.6s |
| `go test -tags nogui -race` over the six codex-socket tests | pass (2.4s) |
| `gofmt -l` on the two touched files | clean |
| `go vet -tags nogui ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | pass (darwin vet prints a pre-existing cgo `-Wenum-conversion` warning in `internal/gui/trayimage_darwin.go`, untouched here, exit 0) |
| `go build`, `GOOS=linux go build -tags nogui`, `GOOS=windows go build` | pass |

## Not verified

- The backend's exact socket ceiling: not probed live (no real ChatGPT calls from here). The fake keys the close to a 1 MiB turn message — the frame is what the fix reads, not any threshold; your probes put the real one between 13 and 18 MB and the reported session hit it there.
- A mid-stream close 1009, after events have gone out, is not covered by a test: it stays a cut stream as before, and nothing replays it. Not observed in either report.
- zstd-encoded turn bodies take the same socket path (the message is decoded before the socket, so the prelude read and this fix see it the same); not separately tested with the close frame.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: hunt76-b-ws-message-too-big (#3444) — git am applies it as is; SHA-256 first 16: 6defde704d4fe1b3</summary>

```text
From dd8ee62c4731b6c19ac41d9606ff1ea36b9d47b0 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 14:30:19 +0800
Subject: [PATCH] gateway: a turn the Codex socket refuses as too big goes over
 HTTP

The ChatGPT backend closes its WebSocket with a StatusMessageTooBig
close frame when a turn's message is over what the socket takes, and
magpie turned that into a 502 that read as OpenAI being down (#3444).
A turn the backend refuses so, before its reply begins, goes over HTTP
as it was, as Codex's own client makes it; the host isn't shunned for
it, so the next, small turn is on the socket again.

Run: go test -tags nogui ./internal/gateway/ (TestCodexSocketTooBigGoesOverHTTP red before the fix, green after; the package green, -race on the codex socket tests green)

Fixes #3444

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_socket.go      |  7 +++++
 internal/gateway/codex_socket_test.go | 37 +++++++++++++++++++++++++++
 2 files changed, 44 insertions(+)

diff --git a/internal/gateway/codex_socket.go b/internal/gateway/codex_socket.go
index 4a926389..2616c0fd 100644
--- a/internal/gateway/codex_socket.go
+++ b/internal/gateway/codex_socket.go
@@ -288,6 +288,13 @@ func (t codexSocket) socket(req *http.Request, msg []byte) (*http.Response, erro
 			if errors.Is(err, io.EOF) && len(body.pending) == 0 {
 				return nil, errors.New("codex websocket: closed before the reply began")
 			}
+			if websocket.CloseStatus(err) == websocket.StatusMessageTooBig {
+				// the backend refused the turn's message as more than
+				// its socket takes, before the reply began: nothing of
+				// it was taken, and the same turn clears over HTTP, as
+				// Codex's own client makes it (#3444)
+				return nil, errCodexSocketFallBack
+			}
 			return nil, err
 		}
 		if frame == nil { // dropped
diff --git a/internal/gateway/codex_socket_test.go b/internal/gateway/codex_socket_test.go
index b9102727..5cd90889 100644
--- a/internal/gateway/codex_socket_test.go
+++ b/internal/gateway/codex_socket_test.go
@@ -33,6 +33,10 @@ type fakeSocketBackend struct {
 	posts   int
 	refuse  int
 	frames  func(socketTurn) []string
+	// tooBig says which turns the backend refuses with a close
+	// StatusMessageTooBig, as it does a message over its socket's
+	// ceiling (#3444)
+	tooBig func(socketTurn) bool
 }
 
 func (f *fakeSocketBackend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
@@ -59,6 +63,10 @@ func (f *fakeSocketBackend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 		f.mu.Lock()
 		f.sockets = append(f.sockets, turn)
 		f.mu.Unlock()
+		if f.tooBig != nil && f.tooBig(turn) {
+			c.Close(websocket.StatusMessageTooBig, "")
+			return
+		}
 		for _, fr := range f.frames(turn) {
 			if c.Write(r.Context(), websocket.MessageText, []byte(fr)) != nil {
 				return
@@ -282,6 +290,35 @@ func TestCodexSocketClosedEarlyIsCut(t *testing.T) {
 	}
 }
 
+// A turn whose message the backend refuses with a close
+// StatusMessageTooBig — a large one, over the socket's ceiling, which the
+// same request clears over HTTP — goes over HTTP as it was, as Codex's own
+// client makes it, and the host isn't shunned for it: the next, small turn
+// is on the socket again (#3444).
+func TestCodexSocketTooBigGoesOverHTTP(t *testing.T) {
+	socketOn(t)
+	f := &fakeSocketBackend{frames: wholeReply, tooBig: func(turn socketTurn) bool {
+		return len(turn.msg) > 1<<20
+	}}
+	chatgpt(t, f.ServeHTTP)
+
+	big := `{"model":"gpt-5.5","stream":true,"input":"` + strings.Repeat("x", 2<<20) + `"}`
+	code, body := codexPost(t, big)
+	if code != 200 || !strings.Contains(body, `"delta":"po"`) {
+		t.Fatalf("the big turn: %d %s", code, body[:min(len(body), 400)])
+	}
+	if strings.Contains(body, "MessageTooBig") {
+		t.Errorf("the big turn's size reached Codex: %s", body[:min(len(body), 400)])
+	}
+	code, body = codexPost(t, `{"model":"gpt-5.5","stream":true,"input":"ping"}`)
+	if code != 200 || !strings.Contains(body, "pong") || !strings.Contains(body, "response.completed") {
+		t.Fatalf("the small turn: %d %s", code, body)
+	}
+	if posts, sockets := f.counts(); posts != 1 || sockets != 2 {
+		t.Fatalf("%d posts, %d sockets; want the big turn over HTTP after its socket, the small one on a socket", posts, sockets)
+	}
+}
+
 // A request that isn't a streamed turn goes over HTTP as before.
 func TestCodexSocketOnlyForStreamedTurns(t *testing.T) {
 	socketOn(t)
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt76-b-ws-message-too-big](https://github.com/ggbdpq/magpie/tree/hunt76-b-ws-message-too-big) (head `dd8ee62c4731b6c19ac41d9606ff1ea36b9d47b0`).
