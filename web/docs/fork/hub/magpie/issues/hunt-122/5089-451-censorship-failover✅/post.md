In an In-order routing group, StepFun's safety filter answers HTTP 451 with an error object saying `{"type":"censorship_blocked"}` — and magpie passed the 451 to the agent as it came, the group's next member unasked, the try standing as a plain failure.

**Symptom**: on a `/v1/chat/completions` request to a group whose first member is StepFun, the agent gets the 451 and its `censorship_blocked` body itself. The routing trace reads `451 · censorship_blocked`, fail "other", with a minute's rest on the candidate — while the same request answered by the group's next member is fine.

**Root cause**: two gaps team up in `internal/gateway`. `retryable()`'s status whitelist has no 451 (its word checks only run at 400/422), so `holdWriter.failed()` reads false and no one is handed the request. And `filterReasons` — the map `policyRefusal` reads vendor refusals out of an error object with — didn't know `censorship_blocked`, so `settle()` never marked the 451 as the filter's refusal, and the #248 failRefused path (the next member asked, nobody rests) was never reached. The same refusal arriving as an in-200 stream refusal *would* have been read — the error-status shape was the odd one out.

**Fix**: `censorship_blocked` joins `filterReasons` (4 lines). `settle()` now reads it from StepFun's error object, the refusal goes to the group's next member, and nobody rests — as for any refusal the vendor names machine-readably, the filter refusing being about the request, not the account. This stacks cleanly with #5075's fix (a refusal said with a 200's body, where `mayAskAgain()` closed early): that one sits deeper in the same chain, and this one is the error-status shape, where nothing passes at all — neither patch touches the other's lines.

**Verification** (base `94d0fbfcd`, head `042a0fd27e20b525c6c3ca30336612488f9802e1`):

| Check | Result |
| --- | --- |
| Red without the fix (`TestCensorshipBlocked451FailsOver`, fake upstream answering the reporter's body verbatim, whole and stream) | `--- FAIL`: the 451 handed to the agent, member b unasked |
| Green with the fix | `ok` |
| `TestCensorshipBlockedIsAPolicyRefusal` | ok |
| Full gateway suite, `go test ./internal/gateway/ -tags nogui -timeout 25m` | `ok` 602.117s, 0 failed |
| `gofmt -l internal/gateway`, `go vet -tags nogui` (gateway, root, internal/...), `go build -tags nogui` and default | clean / clean / ok |

**Not verified**: a real StepFun endpoint — the fake upstream answers the reporter's response body verbatim; the trace shape (`451 · censorship_blocked`, fail "other") is the reporter's own.

---
**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

**Patch**: <details><summary>patch: gateway: a 451 censorship_blocked refusal asks the group's next member (#5089) — git am applies it as is; SHA-256 first 16: 5457ec7fc5f10653</summary>

```patch
From 042a0fd27e20b525c6c3ca30336612488f9802e1 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 22:13:08 +0800
Subject: [PATCH] gateway: a 451 censorship_blocked refusal asks the group's
 next member (#5089)

StepFun's safety filter refuses a request with HTTP 451 and an error
object saying {"type":"censorship_blocked"}. filterReasons, the map of
the words a vendor says its filter stopped the reply with, didn't know
the type, so policyRefusal didn't read the 451 as a refusal and
retryable has no 451 of its own: the status went to the agent as it
came, the group's next member unasked, and the try stood as a plain
failure of the account.

The same refusal said in a 200 stream's finish_reason would have been
one, as content_filter is. Now the type is in the map, and the refusal
goes to the next member the way any refusal the vendor names does:
nobody rests, as the filter refusing is about the request, not the
account.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/censorship_451_test.go | 56 +++++++++++++++++++++++++
 internal/gateway/fallback.go            |  4 ++
 2 files changed, 60 insertions(+)
 create mode 100644 internal/gateway/censorship_451_test.go

diff --git a/internal/gateway/censorship_451_test.go b/internal/gateway/censorship_451_test.go
new file mode 100644
index 000000000..59cf1ecb6
--- /dev/null
+++ b/internal/gateway/censorship_451_test.go
@@ -0,0 +1,56 @@
+package gateway
+
+import (
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// StepFun's safety filter refuses with HTTP 451 and the type
+// "censorship_blocked" (#5089): the vendor names the refusal in its error
+// object, machine-readable, as the ones policyRefusal reads — the group's
+// next member is asked, and nobody rests, as for any refusal of the same
+// family. Before, the 451 went to the agent as it came, the next member
+// unasked, and the try stood as a plain failure.
+func TestCensorshipBlocked451FailsOver(t *testing.T) {
+	const blocked = `{"error":{"type":"censorship_blocked","message":"The content you provided or machine outputted is blocked."}}`
+	for _, ask := range []struct {
+		name string
+		body string
+	}{
+		{"whole", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`},
+		{"stream", `{"model":"group/g","stream":true,"messages":[{"role":"user","content":"hi"}]}`},
+	} {
+		t.Run(ask.name, func(t *testing.T) {
+			fresh(t)
+			a := &scripted{replies: []reply{{451, "", blocked}}}
+			b := &scripted{replies: []reply{{200, "", chatOK}}}
+			scriptedOn(t, "a", provider.Chat, a)
+			scriptedOn(t, "b", provider.Chat, b)
+			if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"a/m", "b/m"}, Routing: provider.Ordered}); err != nil {
+				t.Fatal(err)
+			}
+			s := New()
+			code, body := sendTo(s, "/v1/chat/completions", ask.body)
+			if code != 200 || !strings.Contains(body, "hello") || strings.Contains(body, "censorship") || a.n != 1 || b.n != 1 {
+				t.Fatalf("%s: %d %s (a %d, b %d)", ask.name, code, body, a.n, b.n)
+			}
+			r := s.trace.routes[len(s.trace.routes)-1]
+			if len(r.Tries) != 2 || r.Tries[0].Fail != failRefused || r.Tries[0].Rest != nil || r.Status != 200 {
+				t.Fatalf("%s: tries: %+v", ask.name, r.Tries)
+			}
+			if s.resting("a") {
+				t.Fatal("a censorship refusal set the member aside")
+			}
+		})
+	}
+}
+
+// The refusal read from the error object itself, as settle reads it.
+func TestCensorshipBlockedIsAPolicyRefusal(t *testing.T) {
+	note, ok := policyRefusal([]byte(`{"error":{"type":"censorship_blocked","message":"The content you provided or machine outputted is blocked."}}`))
+	if !ok || !strings.Contains(note, "censorship_blocked") {
+		t.Fatalf("policyRefusal: %q, %v", note, ok)
+	}
+}
diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 639324457..9a1096005 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -3388,6 +3388,10 @@ var filterReasons = map[string]string{
 	// agent took it for a failed sign-in (sweanng on Discord, ZCode:
 	// "Provider authentication failed", reason=auth_failed status=403)
 	"content_policy_rejected": "content_policy_rejected",
+	// StepFun's error type, its filter refusing with an HTTP 451 (#5089):
+	// read from the error object, the refusal is the request's, and the
+	// group's next member is asked rather than the 451 handed on
+	"censorship_blocked": "censorship_blocked",
 	// Zhipu's finish_reason when its filter stops GLM's reply, and
 	// DashScope's error code when Alibaba's stops Qwen's: both after the
 	// reasoning went to the agent, which had it end there (yhwangl on X)
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [fix/5089-451-censorship-failover](https://github.com/ggbdpq/magpie/tree/fix/5089-451-censorship-failover) (head `042a0fd27e20b525c6c3ca30336612488f9802e1`).
