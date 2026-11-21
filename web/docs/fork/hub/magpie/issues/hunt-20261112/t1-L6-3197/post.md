@skygunner's fix is verified on today's main (`7dbfc9f2f`): cherry-picked onto it cleanly (branch [hunt-20261112-t1-3197](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-3197), head `abe40fd1486611f6`, tree identical under `git am` of the patch below), and it does what the follow-up needs: an `event:` name whose data has not come is held back until the data line does, so a severed stream ends the client's read with whole events only, then the relay's error event.

**Red without the fix** (their two tests, the product hunk in gateway.go reverted, tests kept): `TestPassthroughResponsesSeveredAfterEventName` and `TestPassthroughResponsesSeveredMidData` both fail on the unpatched gateway — the name-only event block goes out, closed by the ending's blank line, exactly the shape DDDFXYqiming's client parsed as "malformed server-sent event JSON".

**Green with the fix**: the two tests, the whole severed family around them (`TestPassthroughStreamCutMidLine`, `TestPassthroughStreamEndsOnLineEnd`, the Chat severed cases, `TestLoopCut*`), and the full `./internal/gateway` package — ok, 997 s, zero failures. gofmt and go vet clean.

**Freshness**: nothing in `c736906b1..7dbfc9f2f` covers this window (b68218f43 is Responses events for non-Codex clients, not the severed path), so the fork fix is still the only one; the cherry-pick applies to today's tip as is.

**Boundary kept as posted**: a name the upstream itself never follows with data (a stream that ends short on its own, not severed) still relays as it came — the hold-back is on the severed path only, which is the path the client-side parse error came from.

**Not verified**: a live Codex + openai Node SDK 7.19.0 client (the SDK's empty-data behavior is taken from DDDFXYqiming's report, as in skygunner's post).

---
**Source**: reported in this issue; the fix is @skygunner's ([fix/3197-orphan-event](https://github.com/skygunner/magpie/tree/fix/3197-orphan-event), head `a5fa3228f996808d`, base `c736906b1`), verified by me on macOS.

**Attribution**: AI-written (this verification and the tip-based branch, written with GLM-5.3-Flash (ZCode)); the fix is skygunner's, kept as author verbatim. Please keep the author (`vincent` / skygunner) for the commit.

**Patch**: <details><summary>patch: gateway: an event name whose data has not come is held back until it does (#3197) — git am applies it as is; SHA-256 first 16: 0d4491a1eafb8386</summary>

````From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
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
index f14bf99a7..c8b915549 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -7423,8 +7423,27 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
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
