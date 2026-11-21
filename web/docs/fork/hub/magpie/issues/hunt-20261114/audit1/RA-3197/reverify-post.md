Re-verified at current main (`eb1b83000`): rebased again after upstream moved mid-verification, and every element of the evidence below re-ran on that tip.

| Element | Status / evidence at `eb1b83000` |
| --- | --- |
| Rebase | clean (upstream moved `f53c4a1a1`→`eb1b83000` during the run; rebased twice), range-diff `=` both times — zero semantic drift |
| git am | the patch below applies to a clean `eb1b83000` tree; result tree-identical to the branch (`3d38703b9f`) |
| Tests | full `internal/gateway` package ok (1077.2s); `TestPassthroughResponsesSeveredAfterEventName` + `TestPassthroughResponsesSeveredMidData` ok, and ok under `-race`; gofmt/vet clean; nogui build ok for linux/darwin/windows |
| Ablation (red without the fix) | `gateway.go` product hunk reverted, the two tests kept: both FAIL — `an event went out with a name and no data: "event: response.output_text.delta"`; restored, green |
| Siblings | the hold-back lives only in the passthrough writer (gateway.go); every other `event:`-aware site (sniff.go, fallback.go, member.go, prev_response.go, responses_enum.go, responses_ws.go) is read-side; upstream's newest commits (prev-response share, Cindy model names) touch neither the writer nor those readers' conclusions |
| Field evidence | carried from the post below: the fix is @skygunner's, verified by me locally; the live-Codex gap stands as declared |

New branch head: `53f761c184554ecc` — branch: https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-3197
Patch below rebuilt at the new head — SHA-256 first 16: `876c9fc95e77f8d6`

**Not verified** (carried over): a live Codex + openai Node SDK 7.19.0 client (the SDK's empty-data behavior is taken from DDDFXYqiming's report, as in skygunner's post).

**Attribution**: AI-written (this re-verification comment, written with GLM-5.3-Flash (ZCode)); I've read the whole diff; the fix is skygunner's — please keep the author (`vincent` / skygunner) for the commit.

Patch: <details><summary>patch: gateway: an event name whose data has not come is held back until it does (#3197) — git am applies it as is; SHA-256 first 16: 876c9fc95e77f8d6</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: vincent <vincent@users.noreply.github.com>
Date: Sun, 8 Nov 2026 16:03:52 +1000
Subject: [PATCH] gateway: an event name whose data has not come is held back
 until it does (#3197)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

An event: line went out as soon as it completed, so an upstream that
died between the name and its data line left the client an event block
with a name and no data, closed by the blank line the relay's ending
writes. The openai Node SDK parses that empty data as JSON and ends the
turn with "malformed server-sent event JSON" before the relay's error is
reached (DDDFXYqiming on #3197, Codex Responses). Chat was spared — its
SSE has no event: lines — which is why the landed #3197 fix never hit
this.

The held name goes out when the data line completes; a name the upstream
itself never follows with data is relayed as the upstream sent it
(ended-short path, unchanged); on a sever the held name drops with the
half line. Tests for both cuts were red on clean main.
---
 internal/gateway/gateway.go                  | 23 +++++-
 internal/gateway/passthrough_severed_test.go | 85 ++++++++++++++++++++
 2 files changed, 106 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index dcc038e81..93cbd8ad4 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -7492,8 +7492,27 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 		i := bytes.LastIndexByte(pending, '\n')
 		var err error
 		if i >= 0 {
-			_, err = w.Write(pending[:i+1])
-			pending = pending[i+1:]
+			// an event: name whose data has not come is held back: written
+			// at once, an upstream that dies between the name and the data
+			// would leave the client an event with no data, and the openai
+			// Node SDK ends the turn on that empty data before the relay's
+			// error is reached ("malformed server-sent event JSON",
+			// DDDFXYqiming on #3197, Codex Responses). It goes out when its
+			// data does; a name the upstream never follows with data goes
+			// as the upstream sent it (unheld, a stream ended short)
+			end := i + 1
+			if t := bytes.LastIndexByte(pending[:i], '\n'); t >= 0 {
+				t++
+				if bytes.HasPrefix(pending[t:], []byte("event:")) {
+					end = t
+				}
+			} else if bytes.HasPrefix(pending, []byte("event:")) {
+				end = 0
+			}
+			if end > 0 {
+				_, err = w.Write(pending[:end])
+				pending = pending[end:]
+			}
 			atLine = true
 		}
 		return len(b), err
diff --git a/internal/gateway/passthrough_severed_test.go b/internal/gateway/passthrough_severed_test.go
index 9ad7f551f..d9fff48f2 100644
--- a/internal/gateway/passthrough_severed_test.go
+++ b/internal/gateway/passthrough_severed_test.go
@@ -353,3 +353,88 @@ func TestChatStreamCutAfterWholeEventKeepsIt(t *testing.T) {
 		t.Fatalf("the last whole event was dropped: %q", body)
 	}
 }
+
+// severedResponses is severed for an upstream the client speaks Responses
+// to, as Codex does its /responses backend.
+func severedResponses(t *testing.T, events ...string) {
+	t.Helper()
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.ReadAll(r.Body)
+		hj, ok := w.(http.Hijacker)
+		if !ok {
+			panic("no hijacker")
+		}
+		conn, buf, err := hj.Hijack()
+		if err != nil {
+			panic(err)
+		}
+		defer conn.Close()
+		body := strings.Join(events, "")
+		fmt.Fprintf(buf, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: %d\r\n\r\n", len(body)+100)
+		io.WriteString(buf, body)
+		buf.Flush()
+	}))
+	t.Cleanup(up.Close)
+	p := provider.Provider{ID: "up", Name: "UP", Key: "k", Models: []string{"m"}, Responses: up.URL + "/v1"}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+}
+
+// noEmptyEvent fails when the client's stream holds an event block with a
+// name and no data: the openai Node SDK parses that empty data as JSON and
+// ends the turn with "malformed server-sent event JSON" (DDDFXYqiming on
+// #3197, Codex Responses).
+func noEmptyEvent(t *testing.T, body string) {
+	t.Helper()
+	for _, block := range strings.Split(body, "\n\n") {
+		var name, data bool
+		for _, line := range strings.Split(block, "\n") {
+			switch {
+			case strings.HasPrefix(line, "event:"):
+				name = true
+			case strings.HasPrefix(line, "data:"):
+				data = true
+			}
+		}
+		if name && !data {
+			t.Fatalf("an event went out with a name and no data: %q", block)
+		}
+	}
+}
+
+// A Responses stream the upstream severs right after an event name, before
+// its data line began: the name alone used to go out, and the blank line
+// the relay's ending writes closed it as an event with no data, which is
+// where the openai SDK died before the error was reached (#3197).
+func TestPassthroughResponsesSeveredAfterEventName(t *testing.T) {
+	fresh(t)
+	severedResponses(t,
+		`event: response.created`+"\n"+`data: {"type":"response.created","response":{"id":"r1"}}`+"\n\n",
+		`event: response.output_text.delta`+"\n")
+	code, body := post(t, "/v1/responses", `{"model":"up/m","stream":true,"input":"hi"}`)
+	if code != 200 {
+		t.Fatalf("status = %d, want 200; body: %s", code, body)
+	}
+	noEmptyEvent(t, body)
+	if !strings.Contains(body, "connection lost mid-reply") {
+		t.Fatalf("the severed stream ended without the failure said: %s", body)
+	}
+}
+
+// One severed inside the data line after the name went out is the same:
+// the half data is dropped, and the held name goes with it.
+func TestPassthroughResponsesSeveredMidData(t *testing.T) {
+	fresh(t)
+	severedResponses(t,
+		`event: response.created`+"\n"+`data: {"type":"response.created","response":{"id":"r1"}}`+"\n\n",
+		`event: response.output_text.delta`+"\n"+`data: {"type":"response.output_te`)
+	code, body := post(t, "/v1/responses", `{"model":"up/m","stream":true,"input":"hi"}`)
+	if code != 200 {
+		t.Fatalf("status = %d, want 200; body: %s", code, body)
+	}
+	noEmptyEvent(t, body)
+	if !strings.Contains(body, "connection lost mid-reply") {
+		t.Fatalf("the severed stream ended without the failure said: %s", body)
+	}
+}
-- 
2.50.1 (Apple Git-155)

````
</details>
