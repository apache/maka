The loop in the report is real and I could reproduce it exactly: a routing group (`order`) whose first member is ModelScope answers the client's request with the vendor's own 400 — `Model id : deepseek-ai/DeepSeek-V4.1-Flash , has no provider supported`, straight out of the reporter's `usage.jsonl` — and the route ends there. The client's retries are new group requests, each landing on the same first seat: 28 hits in a row, members 2/3/4 never asked.

The design tension is the poison pill: a plain 400 ("invalid parameter", "field required") is the request's own fault, it would fail on every member, so `retryable()` says no and the route ends — right for a bad request, wrong here. What separates the two is vendor-locality: "this model is not served HERE" is a fact about the member, not the request, and a different member can answer the very same bytes. That is the class the gateway already has — `unservedWords`, the words behind `model_not_found` and "The model gpt-x does not exist", which a 400 fails a group over on today (`TestGroupFailsOverAnUnservedModel`). The gap is only that ModelScope's and Azure's wordings for the same fact were missing from the list.

The wordings added, and where each comes from:

- `has no provider supported` — ModelScope's 400 for a model id none of its instances serves, as quoted in this issue's `usage.jsonl` (the report).
- `deployment not found` / `DeploymentNotFound`, and "The API deployment for this resource does not exist" — Azure OpenAI's error for a deployment its resource has none of ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/1189176/how-do-i-resolve-error-deploymentnotfound-for-azur), [Stack Overflow](https://stackoverflow.com/questions/77278712/azure-openai-the-api-deployment-for-this-resource-does-not-exist)). Azure answers it with a 404, which fails over by status already; a relay in front passes it on as a 400, which is what the wording now catches. OpenAI-style `model_not_found` was already in the list, unchanged.

Branch: [`hunt47-d-shape-failover`](https://github.com/ggbdpq/magpie/tree/hunt47-d-shape-failover), one commit on top of upstream `ef655acb`; the patch below applies with `git am`.

## What changed

`internal/gateway/fallback.go`: `unservedWords` takes the two vendor wordings above (and nothing else). Everything the reporter asked for then falls out of the existing machinery, no new mechanism:

- a 400 with these words is `retryable`, so `hw.failed()` is true and the group's routing loop asks the next member;
- `restAfterMarked`'s unserved branch (the #1235 mechanism) rests the seat on the model's own key alone — the reporter's point 2 comes free: the key's other models stay live, and the client's next group request passes the dead seat (my test asserts the second request is answered by member 2 without member 1 asked first);
- `shapeRefused` still excludes `unservedWords`, so this travels the resting path, not the shape path, and decision groups (`/v1/systemone`) fail over the same way, both reading the same `retryable()`.

The poison pill keeps its line: a generic 400 still ends the route, and the mutation check below proves the list didn't over-reach.

## Red before the fix

`TestGroupFailsOverAModelWithNoProvider` (new, in `internal/gateway/unserved_fallback_test.go`): a group `ms/m` → `b/m`, `ms` scripted to answer ModelScope's 400, `b` to answer 200. On upstream `ef655acb` with the test in place:

```
--- FAIL: TestGroupFailsOverAModelWithNoProvider (0.18s)
    unserved_fallback_test.go:32: 400 {"error":{"code":null,"message":"MS: Model id : deepseek-ai/DeepSeek-V4.1-Flash , has no provider supported","param":null,"type":"invalid_request_error"}}
         (ms 1, b 0)
```

The group ended on the 400 and `b` was never asked — the report's loop, in one line. Green with the fix: 200 from `b`, the first try resting on `ms/m` alone.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| New test, red first | `go test ./internal/gateway/ -run TestGroupFailsOverAModelWithNoProvider` on `ef655acb` + test | FAIL `(ms 1, b 0)`, then green with the fix |
| Refusal / failover family | `go test -run 'TestGroupFailsOverAModelWithNoProvider\|TestGroupFailsOverAnUnservedModel\|TestLastOneLeftIsTriedAgain\|TestGroupFailsOverARequestShape\|TestGroupFailsOverASchemaTooDeep\|TestGroupFailsOverCommandCodesBare400\|TestEscapedWordsReadByTheOtherDeciders\|TestEscapedWordsReadByEveryDecider\|TestModelNotInPlanRestsTheModelNotTheKey\|TestNoFallbackForOtherErrors\|TestLastFallbackErrorReachesTheAgent\|TestFallbackRestsTheFailedProvider'` | 12/12 PASS |
| Full gateway package | `go test ./internal/gateway/ -count=1` | ok 339.974s |
| Race | `-race` on the new test + `TestGroupFailsOverAnUnservedModel` + `TestLastOneLeftIsTriedAgain` | ok |
| gofmt | `gofmt -l internal/gateway/` | empty |
| vet | `go vet ./internal/gateway/` darwin / linux / windows | clean |
| Builds | darwin (`go build .`); linux, windows (`CGO_ENABLED=0 go build -tags nogui .`, the Makefile's own cross-compile target); `./internal/gateway/` on all three | OK |
| Ablation | upstream `fallback.go` restored, tests kept | RED again (same `(ms 1, b 0)`); restored → green |
| Mutation | `invalid parameter` added to `unservedWords` | guard row red: `retryable(400, {"error":{"message":"Invalid parameter: messages.3.content"}}) = true`; restored → green |

The guards in the family table are the poison pill's own tests: `TestLastOneLeftIsTriedAgain` ends on a plain 400 after exactly one try, and the `retryable` tables in `TestGroupFailsOverAnUnservedModel` keep "messages: field required" and a context-length overflow non-retryable.

## Siblings

The other refusal lists a vendor 400 can land in, left untouched: `shapeWords`/`unsaidWords`/`customToolRefusal`/`wrongEndpoint` (the shape class — no rest, next member, and the reason `shapeRefused` excludes `unservedWords`), `refusedWords` (a provider refusal like WorkBuddy's unapproved-channel), `regionWords`, `retiredWords`/`modelRetired` (which also leaves the provider's model lists), `zenModelGone`, `quotaWords` (which still wins over `unservedWords` when both match, so a quota refusal rests the account as before), and `zdrCoded`. ModelScope's images API has its own error shape in `draw.go` (`errors[].message`); I left it alone — this issue is about chat groups. Decision groups reuse the same deciders through `decideFailed`, so they inherit the fix without a change of their own; I only tested chat groups end to end.

## Not verified

- No real ModelScope account here: the `has no provider supported` wording is sourced from the report's `usage.jsonl` quote, not from a live 400; same for the Azure wordings (Microsoft Q&A / Stack Overflow, not a live Azure call).
- The seat resting is the existing model-keyed backoff (`restAfterMarked`'s unserved branch), not a new isolation mechanism: the seat comes back after the cooldown ladder, by design. A persistent "known-bad seat" ledger beyond that would be a behavior addition I left for the maintainer to weigh.
- The full GUI cross-build for linux from macOS fails inside the `wails v3` dependency (`undefined: pointer` in its linux menu files), before and after this change; the builds above use the project's own `-tags nogui` target, which the Makefile documents as the way to cross-compile.

<details><summary>patch 0001-gateway-a-vendor-s-model-not-served-here-refusal-fails-a-group-over-to-its-next-member-2887.patch</summary>

```patch
From 90401beeac7c6de72b82bdca93612ae69e65fc46 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 00:08:21 +0800
Subject: [PATCH] gateway: a vendor's "model not served here" refusal fails a
 group over to its next member (#2887)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A routing group's first member answering ModelScope's 400 "Model id :
deepseek-ai/DeepSeek-V4.1-Flash , has no provider supported" ended the
group request: the words matched none of the refusal classes that make
a 400 retryable, so the client got the 400 and its own retries landed
on the same dead seat — the reporter watched 28 in a row, the later
members never asked.

What changed: unservedWords takes the vendor wordings that say the
model is served nowhere on this member — ModelScope's "has no provider
supported" (the report's usage.jsonl), and Azure OpenAI's for a
deployment its resource has none of, code DeploymentNotFound ("The API
deployment for this resource does not exist"; Microsoft Q&A, Stack
Overflow — its 404 fails over by status already, the wording covers the
400s a relay passes on). An unserved refusal keeps the poison pill's
line: a plain bad request ("Invalid parameter", "field required")
still ends the route, as it would fail on every member, and
shapeRefused still excludes these words — the seat rests on its
model's own key (restAfterMarked's unserved branch, the #1235
mechanism), so the key's other models stay live and the group's next
request passes the dead seat.

Run: go test ./internal/gateway/ (TestGroupFailsOverAModelWithNoProvider
red on upstream/main, green here; the family and the plain-400 guards
green); -race targeted; gofmt; vet darwin/linux/windows; builds
darwin, linux and windows (-tags nogui).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/fallback.go               | 10 ++-
 internal/gateway/unserved_fallback_test.go | 81 ++++++++++++++++++++++
 2 files changed, 89 insertions(+), 2 deletions(-)
 create mode 100644 internal/gateway/unserved_fallback_test.go

diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 2eef2d36..dc439421 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -1044,8 +1044,14 @@ func quotaSaid(msg string) bool {
 }
 
 // unservedWords are how a vendor says the model isn't one it serves this
-// key, or this way — words another provider, or key, may not answer with.
-var unservedWords = regexp.MustCompile(`(?i)model.{0,80}(not (supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(no such|unknown|invalid|unsupported) model|model_not_found|模型.{0,12}(不存在|不支持|无权|未开通)`)
+// key, or this way — words another provider, or key, may not answer with:
+// ModelScope's 400 for a model id none of its instances serves, "Model id
+// : deepseek-ai/DeepSeek-V4.1-Flash , has no provider supported" (#2887),
+// and Azure OpenAI's for a deployment its resource has none of, its code
+// DeploymentNotFound, whose message "The API deployment for this resource
+// does not exist" a relay passes on as a 400 (its 404 fails over by its
+// status already).
+var unservedWords = regexp.MustCompile(`(?i)model.{0,80}(not (supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(no such|unknown|invalid|unsupported) model|model_not_found|has no provider supported|deployment[ _]?not[ _]?found|deployment.{0,60}does ?n[o']t exist|模型.{0,12}(不存在|不支持|无权|未开通)`)
 
 // modelRefused says the vendor turned the request away over its model
 // alone — not one this key's plan, or this key, may use: SenseNova's 403
diff --git a/internal/gateway/unserved_fallback_test.go b/internal/gateway/unserved_fallback_test.go
new file mode 100644
index 00000000..6b08bca2
--- /dev/null
+++ b/internal/gateway/unserved_fallback_test.go
@@ -0,0 +1,81 @@
+package gateway
+
+import (
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// modelscopeNoProvider400 is ModelScope's answer to a model id none of its
+// instances serves, as the reporter of #2887's usage.jsonl has it: the
+// request itself is fine, and a member that serves the model may answer it.
+const modelscopeNoProvider400 = `{"error":{"message":"Model id : deepseek-ai/DeepSeek-V4.1-Flash , has no provider supported"}}`
+
+// A member whose vendor serves the model nowhere hands the request to the
+// group's next one, and the model rests on that key alone, as any unserved
+// model's does — so the client's own retry, landing on the group again, is
+// no longer sent to the dead seat first (#2887: 28 requests in a row hit
+// the first member and the later ones were never asked).
+func TestGroupFailsOverAModelWithNoProvider(t *testing.T) {
+	fresh(t)
+	a := &scripted{replies: []reply{{400, "", modelscopeNoProvider400}}}
+	b := &scripted{replies: []reply{{200, "", chatOK}}}
+	scriptedOn(t, "ms", provider.Chat, a)
+	scriptedOn(t, "b", provider.Chat, b)
+	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"ms/m", "b/m"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	code, body := postAs(t, s, "", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 || !strings.Contains(body, "hello") || a.n != 1 || b.n != 1 {
+		t.Fatalf("%d %s (ms %d, b %d)", code, body, a.n, b.n)
+	}
+	r := s.trace.routes[len(s.trace.routes)-1]
+	if len(r.Tries) != 2 || r.Tries[0].Status != 400 || r.Tries[0].Fail != failOther {
+		t.Fatalf("tries %+v", r.Tries)
+	}
+	if rest := r.Tries[0].Rest; rest == nil || rest.Key != "ms/m" {
+		t.Fatalf("the model alone was to rest: %+v", r.Tries[0].Rest)
+	}
+
+	// the rested seat is passed over: the next group request, as the
+	// client's retry is, is answered by the second member alone
+	code, body = postAs(t, s, "", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 || !strings.Contains(body, "hello") || a.n != 1 || b.n != 2 {
+		t.Fatalf("next: %d %s (ms %d, b %d)", code, body, a.n, b.n)
+	}
+
+	for _, x := range []struct {
+		status int
+		body   string
+		want   bool
+	}{
+		{400, modelscopeNoProvider400, true},
+		// as magpie tells it on, with the provider's name before, and
+		// ModelScope's own invalid_request_error type around it
+		{400, `ModelScope: ` + modelscopeNoProvider400, true},
+		{400, `{"error":{"message":"Model id : deepseek-ai/DeepSeek-V4.1-Flash , has no provider supported","type":"invalid_request_error"}}`, true},
+		// Azure OpenAI's error for a deployment its resource has none of
+		// (DeploymentNotFound, "The API deployment for this resource does
+		// not exist"): a 404 fails over by its status already, a relay's
+		// 400 says the words
+		{400, `{"error":{"code":"DeploymentNotFound","message":"The API deployment for this resource does not exist. If you created the deployment recently, please wait a few minutes and try again."}}`, true},
+		{400, `{"error":{"message":"Deployment not found for ModelName: gpt-4o"}}`, true},
+		// model_not_found fails over as it did
+		{400, `{"error":{"message":"The model gpt-x does not exist","code":"model_not_found"}}`, true},
+		// a request at fault stays the agent's: no member is asked after
+		{400, `{"error":{"message":"Invalid parameter: messages.3.content"}}`, false},
+		{400, `{"error":{"message":"messages: field required"}}`, false},
+	} {
+		if got := retryable(x.status, []byte(x.body)); got != x.want {
+			t.Errorf("retryable(%d, %s) = %v", x.status, x.body, got)
+		}
+		if got := shapeRefused(x.status, []byte(x.body)); got {
+			t.Errorf("shapeRefused(%d, %s) = %v; an unserved model rests, it is not a shape", x.status, x.body, got)
+		}
+	}
+	if !modelRefused(400, []byte(modelscopeNoProvider400)) {
+		t.Errorf("modelRefused false: the model wouldn't rest alone on its key")
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.
