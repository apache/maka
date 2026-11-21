Re-verified at current main (`eb1b83000`): every element below re-ran on that tip — and one cleanup: the rebased commit **drops a stray file** the delivered branch had been carrying, `internal/agent/zz_t1l1_6142_probe_test.go` (a probe for #6142, another issue's face, unexplained in the commit message or the patch below). #5252's own diff — `internal/gateway/routing.go` + `internal/gateway/midreply_cut_rest_test.go` — is unchanged.

| Element | Status / evidence at `eb1b83000` |
| --- | --- |
| Rebase | clean, range-diff `=` on #5252's own hunks (the stray probe file, present in the old branch, removed on purpose and stated here) |
| git am | the patch below applies to a clean `eb1b83000` tree; result tree-identical to the branch (`7b7482f03e`) |
| Tests | full `internal/gateway` package ok (1052.1s); `TestMidReplyCutRestsNobody` ok, and ok under `-race`; gofmt/vet clean; nogui build ok for linux/darwin/windows |
| Ablation (red without the fix) | `routing.go` product hunk reverted, test kept: `TestMidReplyCutRestsNobody` FAIL (`a mid-reply cut rested the account`); restored, green |
| Siblings | `transportWords` at this tip: definition + its `errEndedShort` reader in `fallback.go` unchanged by upstream; the rest decisions still all converge on `restAfterMarked`, the face this patch changes; upstream's newest commits touch neither |
| Field evidence | carried from the post below: fixture-level red/green on the report's shape; the live gaps stand as declared |

New branch head: `a7d3ff5d3e54ab3f` — branch: https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5252
Patch below rebuilt at the new head — SHA-256 first 16: `09728f4d60077221`

**Not verified** (carried over): a real upstream that severs a 12-minute reply (the report's own shape), the reporter's LAN-proxy path, and whether the 499 cancellations before the cut also counted toward the backoff ladder.

**Attribution**: AI-written (this re-verification comment, written with GLM-5.3-Flash (ZCode)); I've read the whole diff. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Patch: <details><summary>patch: gateway: a stream severed mid-reply rests nobody (#5252) — git am applies it as is; SHA-256 first 16: 09728f4d60077221</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 12 Nov 2026 19:49:03 +0800
Subject: [PATCH] gateway: a stream severed mid-reply rests nobody (#5252)

roywongx's group sat on codex/gpt-6.1-sol:max when the reply died at
12m26s with "connection lost mid-reply (unexpected EOF)", and the account
was rested for it: by backoff, a minute doubling each time it met the
same end. The vendor had already said 200, so the cut went out as
magpie's own words under that 200, and every exemption restAfter knows
passed it by: offlineFailure wants a 502 and a network that reaches
nothing, and lateRests, the mid-reply path's own gate, has no transport
words among its exemptions. A 502 whose body is the read that failed
went the same way: transportWords knows "unexpected EOF", but only
tooLongUnsaid read it, and that is about a prompt's length.

A connection the stack dropped is no fault of the account: transportWords
in the failure's words now rests nobody, whatever status carried them.
An answer the vendor did give rests as it did.

Run: go test ./internal/gateway -run TestMidReplyCutRestsNobody (red on
the parent at f6c882ad7: "a mid-reply cut rested the account: 1m0s by
backoff", green with the fix); siblings: transportWords' only other
reader is tooLongUnsaid (unchanged), restAfterMarked's callers are
decideFailed and the four serve/routing paths (all rest nobody for a
severed read now, each of them an account's rest). Not run: a real
upstream that severs a 12-minute reply.

(#5252, ggbdpq)
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/midreply_cut_rest_test.go | 56 ++++++++++++++++++++++
 internal/gateway/routing.go                | 13 +++++
 2 files changed, 69 insertions(+)
 create mode 100644 internal/gateway/midreply_cut_rest_test.go

diff --git a/internal/gateway/midreply_cut_rest_test.go b/internal/gateway/midreply_cut_rest_test.go
new file mode 100644
index 000000000..041e1e1a9
--- /dev/null
+++ b/internal/gateway/midreply_cut_rest_test.go
@@ -0,0 +1,56 @@
+package gateway
+
+import (
+	"net/http"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A reply whose stream the upstream severed mid-answer ends as magpie's
+// own words for it, under the 200 the vendor had already sent (#5252): a
+// Codex reply ran 12m26s, died with "connection lost mid-reply
+// (unexpected EOF)", and the account was rested for it — though the
+// connection dropping is no fault of the account, and the same request is
+// asked again. A 502 whose body is the read that failed was rested too:
+// transportWords knew the words, but only offlineFailure read them, and it
+// wants a down network. Neither rests now; an answer the vendor did give
+// still rests as it did.
+func TestMidReplyCutRestsNobody(t *testing.T) {
+	fresh(t)
+	s := New()
+	acct := candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{Agent: "codex", User: "me@example.com"}}, model: "gpt-6.1-sol", rest: "codex@me@example.com"}
+
+	cut := "codex: connection lost mid-reply (unexpected EOF)"
+	if r := s.restAfter(acct, http.StatusOK, http.Header{}, []byte(cut)); r.By == "off" && r.Until.Before(time.Now()) {
+		// said off, nothing kept — checked again below through restOf
+		_ = r
+	}
+	if r, ok := restOf(acct.restKey()); ok {
+		t.Fatalf("a mid-reply cut rested the account: %v by %s (%s)", time.Until(r.Until).Round(time.Second), r.By, r.Error)
+	}
+
+	// the same for a 502 whose body is the read that failed, magpie's
+	// wrapper around a stream severed before it said anything
+	if _, ok := restOf(acct.restKey()); ok {
+		t.Fatal("still resting before the next try")
+	}
+	r := s.restAfter(acct, http.StatusBadGateway, http.Header{}, []byte("up: connection lost mid-reply (unexpected EOF)"))
+	if r.By == "backoff" || r.By == "cooldown" {
+		t.Fatalf("a severed read rested the account: %v by %s", time.Until(r.Until).Round(time.Second), r.By)
+	}
+	if _, ok := restOf(acct.restKey()); ok {
+		t.Fatalf("a severed read left a rest behind: %v by %s", time.Until(r.Until).Round(time.Second), r.By)
+	}
+
+	// an answer the vendor did give rests as it did: a 502 with nothing
+	// of the transport in it is the vendor failing, and the cooldown stands
+	r = s.restAfter(acct, http.StatusBadGateway, http.Header{}, []byte(`{"error":{"message":"the model had an internal error"}}`))
+	if r.By == "off" {
+		t.Fatalf("a vendor's own 502 no longer rests: %v by %s", time.Until(r.Until).Round(time.Second), r.By)
+	}
+	if _, ok := restOf(acct.restKey()); !ok {
+		t.Fatal("a vendor's own 502 rests nobody now")
+	}
+}
diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index 2b8564d84..b993f8f2e 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -1432,6 +1432,19 @@ func (s *Server) restAfterMarked(c candidate, status int, header http.Header, bo
 		// was, and is asked again once the network is back (offline.go)
 		return Rest{Why: failOffline, Status: status, By: "off", Until: now}
 	}
+	if transportWords.Match(wordsOf(body)) && !connFailed.Match(wordsOf(body)) {
+		// a connection that came up and then dropped, in the words the
+		// stack says it, whatever status carried it: a stream severed
+		// mid-reply ends under the 200 the vendor had already sent, as
+		// magpie's own words for it ("connection lost mid-reply
+		// (unexpected EOF)", #5252), and a read that failed ends a 502
+		// with them. No vendor answer was read; the account is as good
+		// as it was, and the request is asked again. A failure to
+		// connect at all (connFailed) is left to offlineFailure above:
+		// with every other provider unreachable too it is the network's,
+		// and with one reachable it is this provider's to rest
+		return Rest{Why: why, Status: status, By: "off", Until: now}
+	}
 	if regionRefused(status, wordsOf(body)) {
 		// the vendor refused where the request came from (regionWords):
 		// the network's doing, and the edge's the connection reached, not
-- 
2.50.1 (Apple Git-155)

````
</details>
