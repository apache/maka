**What's wrong**

`TestCallbackGoesPastTheAgentsProxy` went red once in a full suite run ("no answer from the helper" at 20s) and green alone `-count=20` — the one 20-second window covers the child's start, its stdin processing, the direct callback, and the reply, and the failure carried no signal of which stage stalled. No timeout is changed and no assertion is weakened here: the test now **says how far the helper got**, so the next red names its stage. Credit @jimmyallinai for the disciplined framing (stages, stderr, reproduce-before-touch) — this delivers exactly that follow-up.

**The change** (test-only, `proxy_test.go`)

- The child's stderr is captured (`cmd.Stderr = errs`) and printed in the fatal — the helper's own account of its failure was dropped on the floor before.
- The callback server records when the helper's callback arrives (`callbackAt`, ms since start).
- The timeout message reports the write instant, the stage (never reached the server / arrived at Nms but no line followed), and the stderr.

**Verification**

| Check | Result |
| --- | --- |
| Healthy path, `-count=3` | ok (10ms a run on this machine — the child is the test binary itself) |
| Broken-callback shape (dead port) | the helper answers with an MCP error line fast; fails on the content assert with the vendor error in the body — a *different*, fast failure, not the timeout |
| Hung-callback shape (blackholed address) | the 20s fatal now renders: `no answer from the helper in 20s (written 1ms): the helper never reached the callback server; helper stderr:` — the stage split the report asked for |
| Load injection (4 spinning loops, `-count=40`) | ok ×40 — the red did not reproduce under CPU pressure here, matching the reporter's own isolation result; their red was a full-suite sandboxed context |
| `go test -tags nogui ./internal/claudebridge/` full package | ok (1.3s) |
| `gofmt -l`, `go vet -tags nogui ./internal/claudebridge/`, `go build ./...` | clean / clean / ok |

<details><summary>patch: claudebridge tests: the proxy test's timeout says how far the helper got, and keeps its stderr (#4782) — git am applies it as is; SHA-256 first 16: 9f9ca283cc8cc3a4</summary>

```patch
From 23a2ae2f8cc367799f3e5f4c54677c0d10d315a0 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 02:40:08 +0800
Subject: [PATCH] claudebridge tests: the proxy test's timeout says how far the
 helper got, and keeps its stderr (#4782)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

One window covers the child's start, its stdin processing, the callback
and the reply, and the red said only "no answer from the helper" — full
run, unreproducible alone, nothing to tell the stages apart. The timeout
now reports the written instant, whether the callback reached the server
and when, and whatever the helper said to its stderr, which is captured
where it wasn't before. No timeout changed, no assertion weakened: the
next red names its stage.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/claudebridge/proxy_test.go | 17 ++++++++++++++++-
 1 file changed, 16 insertions(+), 1 deletion(-)

diff --git a/internal/claudebridge/proxy_test.go b/internal/claudebridge/proxy_test.go
index 7954195f4..2035e5851 100644
--- a/internal/claudebridge/proxy_test.go
+++ b/internal/claudebridge/proxy_test.go
@@ -3,6 +3,7 @@ package claudebridge
 import (
 	"bufio"
 	"encoding/json"
+	"fmt"
 	"net"
 	"net/http"
 	"net/http/httptest"
@@ -10,6 +11,7 @@ import (
 	"os/exec"
 	"path/filepath"
 	"strings"
+	"sync/atomic"
 	"testing"
 	"time"
 )
@@ -48,7 +50,10 @@ func TestCallbackGoesPastTheAgentsProxy(t *testing.T) {
 	if err != nil {
 		t.Skip("can't listen on", ip, err)
 	}
+	started := time.Now()
+	var callbackAt atomic.Int64 // when the helper's callback reached the server, 0 before
 	cb := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		callbackAt.CompareAndSwap(0, time.Since(started).Milliseconds())
 		_ = json.NewEncoder(w).Encode(map[string]any{"content": []map[string]any{{"type": "text", "text": "file body"}}})
 	}))
 	cb.Listener.Close()
@@ -87,10 +92,13 @@ func TestCallbackGoesPastTheAgentsProxy(t *testing.T) {
 		"ALL_PROXY="+p, "all_proxy="+p, "NO_PROXY=localhost,127.0.0.1,::1", "no_proxy=localhost,127.0.0.1,::1")
 	in, _ := cmd.StdinPipe()
 	out, _ := cmd.StdoutPipe()
+	errs := &strings.Builder{}
+	cmd.Stderr = errs // the helper's own account of its failure, kept for the report
 	if err := cmd.Start(); err != nil {
 		t.Fatal(err)
 	}
 	t.Cleanup(func() { in.Close(); cmd.Wait() })
+	written := time.Since(started)
 	in.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read","arguments":{},"_meta":{"claudecode/toolUseId":"toolu_1"}}}` + "\n"))
 	line := make(chan string, 1)
 	go func() {
@@ -105,7 +113,14 @@ func TestCallbackGoesPastTheAgentsProxy(t *testing.T) {
 	select {
 	case got = <-line:
 	case <-time.After(20 * time.Second):
-		t.Fatal("no answer from the helper")
+		// one window covers the child's start, its stdin processing, the
+		// callback and the reply; say how far it got (#4782)
+		stage := "the helper never reached the callback server"
+		if at := callbackAt.Load(); at != 0 {
+			stage = fmt.Sprintf("the callback arrived at %dms but no line followed", at)
+		}
+		t.Fatalf("no answer from the helper in 20s (written %dms): %s; helper stderr:\n%s",
+			written.Milliseconds(), stage, strings.TrimSpace(errs.String()))
 	}
 	if !strings.Contains(got, "file body") {
 		t.Fatalf("the call didn't reach magpie: %s", got)
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [fix/4782-callback-stage-diagnostics](https://github.com/ggbdpq/magpie/tree/fix/4782-callback-stage-diagnostics) (head `23a2ae2f8cc367799f3e5f4c54677c0d10d315a0`).

**Not verified**: the original red is still unreproduced — under 4-core CPU load ×40 it stayed green here, so the stage diagnostics wait for the next real red to name its stage; which stage actually stalled in the reporter's run remains unknown, which is the point of the instrumentation.

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
