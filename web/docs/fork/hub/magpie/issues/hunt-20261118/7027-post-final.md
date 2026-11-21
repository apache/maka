Verification of @Singrun's fix — the patch attached in this issue (`patches/magpie-large-history.patch` on their fork, base `2c748531a68167c14b1a08c24edd83660e0627b4`). The gateway's shared plugin host refused a rewritten request larger than the 32 MiB wire line, the host died, `GatewayBegin` returned nil, and the original request — with the foreign encrypted reasoning the hook had just removed — went to the native backend as `invalid_encrypted_content`. Targeted checks, the complete plugin package tests and the cross-platform matrix passed. I independently applied and rebased their patch; its author is unchanged.

**What I verified independently** (not trusting the write-up)
- Current carrier: their patch applies cleanly on `upstream/main` `2ab2f6913` (no conflicts), carrier commit `e9744fbfae25718e31f96750f4ab892b5b79ca16`. The commit author remains `Singrun <16163621+Singrun@users.noreply.github.com>`; the committer is me.
- Red without the fix: with the product changes in `host.go` and `gateway.go` reverted and their test kept, `TestGatewayHookLargeHistoryKeepsImagesAndFiltersReasoning` fails with `large history lost its accepted hook result; original foreign reasoning would be forwarded`. Restoring the product changes turns it green, and it passes under `-race`.
- The reserve is bounded by construction, as the patch's comment claims: the gateway caps one request body at 32 MB on the affected routes and keeps a 64 MB room floor (`internal/gateway/body_room.go`, `body_cap_test.go`), so `allowGatewayLine`'s per-host room (largest accepted body + the normal allowance) cannot grow without limit; `maxWireLine` stays the control-line allowance and a child that never ends a line still fails at its bound.
- Siblings: the stdout reader (`host.go` `read`) is the only consumer of child lines at the dynamic bound; every other `readLine` caller keeps the fixed bound through the wrapper, the frame path is untouched, and the existing oversized-result fallback from #5699 still bounds the worst case — a rewrite that grows the body beyond its request plus the reserved room still falls back to the original request.
- Formatting and tools: `gofmt -l` on the changed files produced no output; `git diff --check` passed. `go vet ./…` passed on darwin; `GOOS=linux go vet -tags nogui ./…` and the Windows equivalent passed. Darwin build and Linux/Windows `nogui` builds passed.
- Full-suite status (carrier `e9744fbfa`): `go test -tags nogui -timeout=45m -count=1 ./internal/plugin/` completed in 159.5s, **exit 1** with `TestHostToldTheGatewayAddress` alone — `after the port moved to 3592 the plugin was told MAGPIE_ADDR=127.0.0.1:3591`. A bare-base control (`2ab2f6913`, detached worktree) fails the same single test the same way: this is the documented macOS system-proxy environment failure ([#5370](https://github.com/yetone/magpie/issues/5370), pointing at #2562's patch; the host's start log in this run shows the machine's real proxy variables). The new 36 MiB test passes inside the package run. The full suite did not pass on either tree.
- Real native replay: **not verified independently.** The reporter's measured replay (38,035,723 bytes against the real native upstream, HTTP 200) and the production `invalid_encrypted_content` are their evidence, not mine.

**Found along the way**
- None beyond the tree above. `rg` found no other reader of child lines that the dynamic bound could surprise, and no collection of this fix upstream as of `2ab2f6913`.

**Not verified**: the reporter's real chat and upstream; Windows/Linux plugin-host runtime behavior (cross-platform vet/build only); a hook that grows the body past its request plus the reserved room (it still falls back, as before).

**Attribution**: The fix, implementation and test are @Singrun's. The carrier branch preserves the original commit author; it is not my patch. Verification was AI-assisted (GLM-5.3-Flash via ZCode).

**Branch with the commit**: [`verify/7027-gateway-large-history`](https://github.com/ggbdpq/magpie/tree/verify/7027-gateway-large-history), head `e9744fbfae25718e31f96750f4ab892b5b79ca16`.

<details><summary>patch: gateway: a gateway hook's result as large as the request it accepted comes back (#7027) — git am applies it as is; SHA-256 first 16: 9f8d4ff5c75785b4</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Singrun <16163621+Singrun@users.noreply.github.com>
Date: Thu, 19 Nov 2026 00:57:41 +0800
Subject: [PATCH] gateway: a gateway hook's result as large as the request it
 accepted comes back (#7027)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: the shared host refused a rewritten gateway request larger
than the 32 MiB wire line as one line, failed the host, and GatewayBegin
returned nil; the gateway then sent the original request, and the
foreign encrypted reasoning the hook had removed reached the native
backend as invalid_encrypted_content (#7027: a Codex chat of 283 input
items with 30 inline images, its filtered body 36.8 MB against the
33,554,432-byte limit).

maxWireLine stays the control-line allowance: a child that never ends a
line still fails at its bound. A gateway result reserves room for the
largest request body this host has accepted — the gateway bounds that
body — plus the normal allowance, and the stdout reader takes the
current bound as each piece arrives, so a reservation made while a line
is already being read still applies.

Run: TestGatewayHookLargeHistoryKeepsImagesAndFiltersReasoning (new)
fails without the fix and passes with it; the full matrix is on the
issue post.
---
 internal/plugin/gateway.go                    |  1 +
 internal/plugin/gateway_large_history_test.go | 56 +++++++++++++++++++
 internal/plugin/host.go                       | 31 ++++++++--
 3 files changed, 82 insertions(+), 6 deletions(-)
 create mode 100644 internal/plugin/gateway_large_history_test.go

diff --git a/internal/plugin/gateway.go b/internal/plugin/gateway.go
index e32dcfe0e..e32425d24 100644
--- a/internal/plugin/gateway.go
+++ b/internal/plugin/gateway.go
@@ -264,6 +264,7 @@ func GatewayBegin(ctx context.Context, body []byte, info GatewayContext) *Gatewa
 		Token string          `json:"token"`
 		Body  json.RawMessage `json:"body"`
 	}
+	h.allowGatewayLine(len(body))
 	err = h.call(total, "gatewayRequest", map[string]any{"operation": "begin", "body": json.RawMessage(body), "context": info}, &out)
 	if err != nil || out.ID == "" || out.Token == "" || len(out.Body) == 0 || out.Body[0] != '{' || !json.Valid(out.Body) {
 		return nil
diff --git a/internal/plugin/gateway_large_history_test.go b/internal/plugin/gateway_large_history_test.go
new file mode 100644
index 000000000..d6d090664
--- /dev/null
+++ b/internal/plugin/gateway_large_history_test.go
@@ -0,0 +1,56 @@
+package plugin
+
+import (
+	"encoding/json"
+	"strings"
+	"testing"
+)
+
+func TestGatewayHookLargeHistoryKeepsImagesAndFiltersReasoning(t *testing.T) {
+	sandbox(t)
+	gatewayFixture(t, `export async function onRequest(body) {
+  return {...body, input: body.input.filter(item => item.type !== "reasoning")};
+}`)
+	image := "data:image/png;base64," + strings.Repeat("A", 36<<20)
+	body, err := json.Marshal(map[string]any{
+		"model":  "gpt-example",
+		"stream": true,
+		"input": []any{
+			map[string]any{"type": "message", "role": "user", "content": []any{
+				map[string]any{"type": "input_text", "text": "Keep this image and conversation."},
+				map[string]any{"type": "input_image", "image_url": image},
+			}},
+			map[string]any{"type": "reasoning", "id": "rs_foreign", "encrypted_content": "synthetic-foreign-seal"},
+		},
+	})
+	if err != nil {
+		t.Fatal(err)
+	}
+	run := GatewayBegin(t.Context(), body, GatewayContext{
+		Protocol: "responses", Path: "/backend-api/codex/responses", Model: "gpt-example", Agent: "codex",
+	})
+	if run == nil {
+		t.Fatal("large history lost its accepted hook result; original foreign reasoning would be forwarded")
+	}
+	defer run.Close()
+	var result struct {
+		Input []struct {
+			Type    string `json:"type"`
+			Content []struct {
+				Image string `json:"image_url"`
+				Text  string `json:"text"`
+			} `json:"content"`
+		} `json:"input"`
+	}
+	if err := json.Unmarshal(run.Body, &result); err != nil {
+		t.Fatal(err)
+	}
+	if len(result.Input) != 1 || result.Input[0].Type != "message" {
+		t.Fatal("foreign reasoning was not removed")
+	}
+	if len(result.Input[0].Content) != 2 ||
+		result.Input[0].Content[0].Text != "Keep this image and conversation." ||
+		result.Input[0].Content[1].Image != image {
+		t.Fatal("large image or readable message changed")
+	}
+}
diff --git a/internal/plugin/host.go b/internal/plugin/host.go
index f18398252..fe6e107e3 100644
--- a/internal/plugin/host.go
+++ b/internal/plugin/host.go
@@ -176,9 +176,9 @@ var (
 	// sides count one number.
 	frameOverhead = 2048
 	rpcReserve    = 64
-	// maxWireLine bounds one line the child writes: a frame's base64 is well
-	// under it, and so is any RPC result, so a child that never ends a line
-	// fails the host rather than making it allocate without bound.
+	// maxWireLine is the normal control-line allowance. Gateway results
+	// also carry their already-bounded input body and reserve its room
+	// separately. A child that never ends a line still fails at its bound.
 	maxWireLine = 32 << 20
 	// streamWait is how long a fetch waits for a stream's window to come
 	// free when the budget's are all held, while its request lives. Past
@@ -483,6 +483,10 @@ type host struct {
 	cancel context.CancelFunc
 	// maxLine overrides maxWireLine for this host; tests lower it.
 	maxLine int
+	// A gateway result includes the whole request it accepted. Its body is
+	// already bounded by the gateway; retain room for the largest one this
+	// host has received plus the normal RPC allowance.
+	gatewayLine atomic.Int64
 	// failOnce makes the one failure that ends the host run once, whatever
 	// noticed it (the stdout reader or the stdin writer).
 	failOnce sync.Once
@@ -580,7 +584,16 @@ func (h *host) lineLimit() int {
 	if h.maxLine > 0 {
 		return h.maxLine
 	}
-	return maxWireLine
+	return max(maxWireLine, int(h.gatewayLine.Load()))
+}
+
+func (h *host) allowGatewayLine(bodyBytes int) {
+	room := int64(bodyBytes) + int64(maxWireLine)
+	for previous := h.gatewayLine.Load(); previous < room; previous = h.gatewayLine.Load() {
+		if h.gatewayLine.CompareAndSwap(previous, room) {
+			return
+		}
+	}
 }
 
 // headCost is a head's header cost: the UTF-8 bytes of every name and value,
@@ -1351,7 +1364,7 @@ func drainStderr(r io.Reader) {
 func (h *host) read(out io.Reader) {
 	r := bufio.NewReaderSize(out, 1<<20)
 	for {
-		line, err := readLine(r, h.lineLimit())
+		line, err := readLineBound(r, h.lineLimit)
 		if len(line) > 0 {
 			if m, ok := chunkFrame(line); ok {
 				h.dispatch(m)
@@ -1418,10 +1431,16 @@ func chunkFrame(line []byte) (message, bool) {
 // never ends a line cannot make the host allocate without bound. It is
 // errLineTooLong once max is passed.
 func readLine(r *bufio.Reader, max int) ([]byte, error) {
+	return readLineBound(r, func() int { return max })
+}
+
+// The stdout reader may already be waiting when a gateway request reserves
+// its reply room. Read the current bound as each piece arrives.
+func readLineBound(r *bufio.Reader, bound func() int) ([]byte, error) {
 	var line []byte
 	for {
 		part, err := r.ReadSlice('\n')
-		if len(line)+len(part) > max {
+		if len(line)+len(part) > bound() {
 			return nil, errLineTooLong
 		}
 		line = append(line, part...)
-- 
2.50.1 (Apple Git-155)

```

</details>
