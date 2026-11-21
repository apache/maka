Fixed on `fe9688d6b` (patch below). A plugin provider's stream whose bytes stop mid-reply — a proxy left half-alive on a dead network keeps its local socket ESTABLISHED while nothing ever comes again — now ends its read five minutes after the last byte, and the client gets a protocol-valid error event instead of a request that hangs until it cancels.

**What changed**

- `internal/plugin/host.go`: a reply body's `Read` waits with a fresh `bodyIdleWait` (five minutes) every time it has no bytes in hand; when the window closes it gives the fetch up and ends the read with `the plugin sent nothing for 5m0s; that fetch was given up on`. The wait is between bytes, not the reply's whole length: every pass through the loop waits on a fresh window, and any chunk that arrives ends the wait at once — a stream a slow model keeps fed goes on however long it talks. Five minutes is the silence the gateway itself already holds a client through (`keepaliveLongest`, #947) before leaving a stuck stream "for a timeout to end" — on the plugin leg that timeout did not exist, and this is it.
- Why the read had to fail: the gateway's relay (`internal/gateway/gateway.go`) already ends a stream whose read fails mid-reply with a protocol-valid error event (`cutMidReply`, [DONE] for Chat, the usage row's error) — what the plugin leg lacked was any read that ever fails. `body.Read` returned only on a chunk, an answer, a close, a cancelled ctx or the host's death (#4934); a soundless socket answers none of them, so the request stayed open until the client gave up (the reporter's 499 after 4m52s, `input_tokens=0`, no retry).
- `internal/plugin/host_test.go`: the two tests below.

**Red without the fix** (the commit's tests kept, `internal/plugin/host.go` reverted to `a3768cdd1`): `TestHostBodyIdleEndsASilentStream` drives the exact shape of the bug on the package's fake host — a stream that queues one chunk and then nothing, ever, the call staying live as a half-alive proxy's socket does.

| Test | Without the fix | With the fix |
| --- | --- | --- |
| `TestHostBodyIdleEndsASilentStream` | FAIL: `a stream silent past bodyIdleWait held its reader for ever` | PASS (0.16s) |
| `TestHostBodyIdleSparesAFedStream` | PASS | PASS — a chunk every 20ms inside a 500ms window reads the whole stream; pins that the idle wait is between bytes, so a long think never trips it |

**Verified**: `go test -tags nogui -count=1 ./internal/plugin/` with only a pre-existing failure (`TestHostToldTheGatewayAddress`, red 3/3 on a clean `a3768cdd1` checkout with this commit stashed — port-move flake on this machine, untouched files); `./internal/gateway/` (645s, only the known `TestCodexPoolSaysTheClientsVersion` flake, green on a rerun) and `./internal/provider/` (103s, ok); the host tests green under `-race` across repeated runs, `DATA RACE` count 0; `gofmt -l` clean; `go vet -tags nogui` clean on plugin, gateway and provider; `go build -tags nogui ./...` plus the main and update-launcher binaries build (the darwin `internal/gui` cgo warning is pre-existing).

**Other streams, on purpose untouched**: the built-in legs' silence is a transport matter (#2529/#2843/#3197) and their relay read is fed by `http.Client` bodies, not the plugin host — out of this issue's scope (a plugin provider, per the title and the report). The plugin's head wait (`headRead`, before the reply's head arrives) is another deadline-less wait, but this issue is a stream already past its first token (ttft 1.7s), so it stays as it was. The Bun side (`host.js`) needs no timer of its own: the Go body is where every plugin reply byte is read, one watchdog there covers streaming and whole replies alike. Cost on the hot path is one `time.Timer` per `Read` call (one per frame, at most 64KB), stopped on return — nothing shared, nothing per byte.

**Not verified**: no real network was cut — the reproduction is the package's fake host holding a call live with no chunks coming, which stands in for the reporter's half-alive proxy; the five-minute window itself is only exercised shortened (150ms/500ms) in tests.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(plugin): a silent stream's read gives the fetch up after five minutes (#4934) — git am applies it as is; SHA-256 first 16: 361a721ac7da80fe</summary>

```
From fe9688d6ba8fcafcfed202e8d21f4accfc9ceda6 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 22:47:56 +0800
Subject: [PATCH] fix(plugin): a silent stream's read gives the fetch up after
 five minutes (#4934)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: a reply body's Read now ends bodyIdleWait (five minutes)
after the last byte the plugin sent, gives the fetch up and says so,
when nothing more comes. The wait is between bytes, not the reply's
whole length: every chunk resets it, so a stream a slow model keeps
fed goes on however long it talks.

Why: a network drop mid-stream can leave a local proxy's socket open
but soundless, and a plugin body's read ended only on a chunk, an
answer, a close, a cancelled ctx or the host's death — none ever came,
so the request hung until the client cancelled it, with no error frame
and no retry (#4934). The gateway's relay already ends a stream whose
read fails with a protocol-valid error event; what the plugin leg
lacked was any read that fails. Five minutes is the silence the
gateway itself holds a client through (keepaliveLongest) before
leaving a stuck stream to a timeout; this is that timeout for a
plugin's reply. The wait for the reply's head is another wait and
stays as it was — this issue is a stream already past its first token.

Run: the new TestHostBodyIdleEndsASilentStream failed before the fix
(a read held for ever) and passes after; TestHostBodyIdleSparesAFedStream
locks the between-bytes reading. go test ./internal/plugin/
./internal/gateway/ ./internal/provider/ -tags nogui, the host tests
under -race, gofmt, go vet and go build all pass, with pre-existing
failures on this machine only (TestHostToldTheGatewayAddress, also red
on a clean upstream/main; TestCodexPoolSaysTheClientsVersion, the known
flake, green on a rerun).

Fixes #4934
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/plugin/host.go      | 30 +++++++++++++++
 internal/plugin/host_test.go | 72 ++++++++++++++++++++++++++++++++++++
 2 files changed, 102 insertions(+)

diff --git a/internal/plugin/host.go b/internal/plugin/host.go
index d20ee5c3f..02f189156 100644
--- a/internal/plugin/host.go
+++ b/internal/plugin/host.go
@@ -1875,6 +1875,18 @@ func Fetch(ctx context.Context, r FetchRequest) (*http.Response, error) {
 // errBodyClosed is what a read after the body was closed gets.
 var errBodyClosed = errors.New("the reply's body was closed")
 
+// bodyIdleWait is how long a reply's body may say nothing — no byte between
+// the last and the next — before its read gives the fetch up: a network that
+// died mid-stream can leave a local proxy's socket open but soundless, and a
+// read waiting on the plugin's next chunk then never ends (a stalled read
+// ends only on a chunk, an answer, a close, a cancelled ctx or the host's
+// death). The wait is between bytes, not the reply's whole length: every
+// chunk resets it, so a stream a slow model feeds goes on however long it
+// talks. Five minutes, the silence the gateway itself holds a client
+// through (keepaliveLongest) before leaving a stuck stream to a timeout:
+// this is that timeout for a plugin's reply.
+var bodyIdleWait = 5 * time.Minute
+
 // headRead waits for the call's reply head, giving back the answer it read on
 // the way: the body has to end with that answer too, error and all.
 func (c *call) headRead(ctx context.Context) (head message, answer *message, err error) {
@@ -1934,6 +1946,13 @@ func (b *body) Read(p []byte) (int, error) {
 	if len(p) == 0 {
 		return 0, nil // a read that asks for nothing reads nothing
 	}
+	// the idle watchdog: what waits here with no bytes in hand is ended
+	// bodyIdleWait after the last one came, so a plugin gone silent mid-reply
+	// (its socket half-alive on a dead network, #4934) ends the read instead
+	// of holding it for ever. The wait runs only while this Read is the one
+	// waiting, and every pass through the loop waits on a fresh window.
+	idle := time.NewTimer(bodyIdleWait)
+	defer idle.Stop()
 	for {
 		// the end comes first, every time round: a closed body reads
 		// nothing more, and a cancel is not left behind what is queued
@@ -1994,7 +2013,18 @@ func (b *body) Read(p []byte) (int, error) {
 			return 0, b.ctx.Err()
 		case <-b.h.dead:
 			continue
+		case <-idle.C:
+			b.giveUp()
+			return 0, fmt.Errorf("the plugin sent nothing for %s; that fetch was given up on", bodyIdleWait)
+		}
+		// whatever the wait answered, the silence counts afresh from here
+		if !idle.Stop() {
+			select {
+			case <-idle.C:
+			default:
+			}
 		}
+		idle.Reset(bodyIdleWait)
 	}
 }
 
diff --git a/internal/plugin/host_test.go b/internal/plugin/host_test.go
index bb2669e3f..8da10ec27 100644
--- a/internal/plugin/host_test.go
+++ b/internal/plugin/host_test.go
@@ -1059,6 +1059,78 @@ func TestHostShutdownEndsAStalledRead(t *testing.T) {
 	}
 }
 
+// TestHostBodyIdleEndsASilentStream: a plugin that sent part of a stream and
+// then went silent — a proxy left half-alive on a dead network keeps its
+// socket open while no byte ever comes again (#4934) — ends its reader's wait
+// bodyIdleWait after the last byte, with why, and gives the call up. Before,
+// the read waited for a chunk that was never coming, and the request hung
+// until the client cancelled it.
+func TestHostBodyIdleEndsASilentStream(t *testing.T) {
+	f := newFakeHost(t)
+	oldWait := bodyIdleWait
+	bodyIdleWait = 150 * time.Millisecond
+	t.Cleanup(func() { bodyIdleWait = oldWait })
+	id, c := f.begin(t, true)
+	b := readBody(f, id, c, context.Background())
+	reply(t, f, id, c, func() {
+		f.chunk(id, "one") // the first token arrived, then the network died:
+		// no more chunks and no answer ever come, the call staying
+		// live as a half-alive proxy's socket does
+	})
+	waitFor(t, "the chunk was queued", func() bool { return c.queuedChunks() == 1 })
+	buf := make([]byte, 8)
+	if n, err := b.Read(buf); err != nil || string(buf[:n]) != "one" {
+		t.Fatalf("first read = %q, %v, want one", buf[:n], err)
+	}
+	errs := make(chan error, 1)
+	go func() {
+		_, err := b.Read(make([]byte, 8))
+		errs <- err
+	}()
+	select {
+	case err := <-errs:
+		if err == nil || !strings.Contains(err.Error(), "sent nothing") {
+			t.Fatalf("a silent stream's read = %v, want the idle give-up", err)
+		}
+	case <-time.After(5 * time.Second):
+		t.Fatal("a stream silent past bodyIdleWait held its reader for ever")
+	}
+	waitFor(t, "the silent call was given up on", func() bool { return !f.registered(id) })
+}
+
+// TestHostBodyIdleSparesAFedStream: the idle wait is between bytes, not the
+// reply's whole length — a stream a chunk comes to every few waits goes on
+// however long it talks, and ends at its answer as before.
+func TestHostBodyIdleSparesAFedStream(t *testing.T) {
+	f := newFakeHost(t)
+	oldWait := bodyIdleWait
+	bodyIdleWait = 500 * time.Millisecond // a chunk every 20ms, a window
+	t.Cleanup(func() { bodyIdleWait = oldWait })
+	id, c := f.begin(t, true)
+	b := readBody(f, id, c, context.Background())
+	stop := make(chan struct{})
+	reply(t, f, id, c, func() {
+		for i := 0; ; i++ {
+			f.chunk(id, chunkAt(i))
+			select {
+			case <-stop:
+				f.answer(id, "")
+				return
+			case <-time.After(20 * time.Millisecond):
+			}
+		}
+	})
+	go func() {
+		<-time.After(2 * time.Second)
+		close(stop)
+	}()
+	got, err := io.ReadAll(b)
+	if err != nil || len(got) == 0 {
+		t.Fatalf("a stream fed inside the idle wait = %d bytes, %v, want it whole", len(got), err)
+	}
+	waitFor(t, "the fed call left the host", func() bool { return !f.registered(id) })
+}
+
 // TestHostHeadKeepsTheAnswerWhenItCameWithTheHead: a head read can find the
 // call's answer already there and take the head out of the queue with it. The
 // answer must reach the body all the same, an error staying an error.
-- 
2.50.1 (Apple Git-155)

```
</details>

Branch with the commit: [fix/4934-plugin-stream-hang](https://github.com/ggbdpq/magpie/tree/fix/4934-plugin-stream-hang) (head `fe9688d6ba8fcafcfed202e8d21f4accfc9ceda6`).
