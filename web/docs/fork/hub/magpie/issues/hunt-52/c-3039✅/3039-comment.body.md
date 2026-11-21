The code locate in the report is right, and the fix follows it: the wording joins the model-scoped branches in the rest key's choice, so a relay's model-scoped 429 rests the model alone and its siblings still go upstream.

Branch: [`hunt52-c-model429-scope`](https://github.com/ggbdpq/magpie/tree/hunt52-c-model429-scope), one commit on top of upstream `dee5c9d7`; the patch below applies with `git am`.

## What changed

`internal/gateway/routing.go`:

- A new wording in the rest key's model-scoping (beside WorkBuddy's "switch to other models" and Cline's free-model limit): a 429 (out of quota or rate) whose body names the model whose credentials cooled down — gpt-load's `credentials for model … cooling down` — rests `restID()` (the model) instead of `restKey()` (the key).
- The model's own sentence (`r.said`) then rests with the model, so `model-b` and `model-c` are neither locally refused nor shown model-a's sentence.
- An account-level cool-down that names **no** model still rests the key — a negative test pins that the branch is for wordings that name one.

The wording is matched, not parsed for the model name — the same trust the "switch to other models" branch extends to WorkBuddy's wording. Parsing the name and checking it against the requested model would be stricter; left as the maintainer's call.

## Red before the fix

Base `dee5c9d7`, `TestModelCoolingDownRestsTheModelOnly` (`internal/gateway/routing_test.go`), driving `restAfter` with the report's exact body and `Retry-After: 3597`:

```
model-a's cooling-down rested {Why:quota Status:429 Until:…+3597s By:retry-after
 Key:relay Model: said:All credentials for model model-a are cooling down…} (model ""), not the model alone
```

The whole key, for the hour. After the change: `Key: relay/model-a, Model: model-a`, and neither `restOf(relay/model-b)` nor the key's own entry exists — model-b would be asked upstream.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -run TestModelCoolingDownRestsTheModelOnly ./internal/gateway/` | red on base, green with the change |
| ablation (branch dropped, tests kept) | red again; restored, green |
| mutation: rest the key anyway | red |
| mutation: match a bare "cooling down" naming no model | the account-level negative goes red |
| `go test -tags nogui -p 2 ./internal/gateway/` (full) | ok, 325.2s |
| `go test -race` targeted | ok |
| `gofmt -l internal/gateway/` | empty |
| `go vet -tags nogui` darwin / linux / windows | clean |
| builds darwin / linux / windows | ok |

## Not verified

- No real gpt-load relay: the body and `Retry-After` are quoted from the report. Whether every gpt-load wording variant always names the model is the reporter's side to confirm.
- The scoping trusts the wording rather than parsing the named model — same trade the existing branches make; noted for the maintainer.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch: gateway: a relay's model-scoped 429 rests the model, not the whole key (#3039) — git am applies it as is; SHA-256 first 16: 9c69453c8977caed</summary>

```patch
From 6fc9532c9b42742e9db92a9858e6d2b73fff731c Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 21:17:20 +0800
Subject: [PATCH] gateway: a relay's model-scoped 429 rests the model, not the
 whole key (#3039)

A relay that pools credentials per model answers 429 naming the model
whose credentials cooled down - gpt-load's "All credentials for model
model-a are cooling down via provider upstream (last error:
usage_limit_reached: ...)" with a Retry-After of an hour. restAfter read
that as the key out of quota: the whole key sat out the Retry-After, its
sibling models were answered a local 429 carrying model-a's sentence
without one request leaving, and upstream had already recovered (Welkon's
routing log: relay/model-b and /model-c refused locally, no relay-side
hits, until a restart).

What changed: that wording joins the model-scoped branches in the id
choice (beside WorkBuddy's "switch to other models" and Cline's free-model
limit) - a 429 from the key that names the model whose credentials cooled
down rests restID, the model, and its sentence rests with the model
instead of being served to every sibling. An account-level cool-down that
names no model still rests the key.

Run: TestModelCoolingDownRestsTheModelOnly fails on the unfixed tree (the
rest reads Key:relay, Model:"" - the whole key, for the Retry-After) and
passes with the change; ablation (branch dropped, tests kept) red again;
resting the key anyway red; matching a bare "cooling down" with no model
named red (an account-level cool-down still rests the key). Full gateway
package ok 325.2s, targeted -race ok, gofmt clean, vet on
darwin/linux/windows clean, builds on all three.

Not tried against a real gpt-load relay: the body and Retry-After are
quoted from the report. The wording is matched, not parsed for the model
name - the same trust the "switch to other models" branch extends to
WorkBuddy's wording; parsing the name and checking it against the
requested model would be stricter and is left as the maintainer's call.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/routing.go      | 11 +++++++
 internal/gateway/routing_test.go | 49 ++++++++++++++++++++++++++++++++
 2 files changed, 60 insertions(+)

diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index 6929fdd8..e52f25fb 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -222,6 +222,10 @@ var (
 	// answer ("切换其他模型", "switch to the other models"): its limit is
 	// the model's, and the model alone rests
 	otherModels = regexp.MustCompile(`(?i)switch(?:ing)? to (?:the )?other models?|切换(?:到)?其他模型`)
+	// modelCooling is a relay saying the credentials it pools cooled down
+	// for one named model: gpt-load's "All credentials for model model-a
+	// are cooling down via provider upstream" (#3039)
+	modelCooling = regexp.MustCompile(`(?i)credentials for model .{0,200}cooling down`)
 	// clineFreeLimit: Cline's refusal of a free model whose day's allowance
 	// is used up, 429 "Daily free limit reached on model deepseek/deepseek-
 	// v4-flash. Try again in 23h 59m", as its own clients read it (cline/
@@ -975,6 +979,13 @@ func (s *Server) restAfterMarked(c candidate, status int, header http.Header, bo
 	if why == failQuota && clineModelLimited(c, body) {
 		id = c.restID()
 	}
+	// a relay's 429 that names the model whose credentials cooled down is
+	// that model's: its siblings on the same key still answer upstream,
+	// and the model's own sentence rests with the model, not on every
+	// sibling's refusal (#3039)
+	if (why == failQuota || why == failRate) && modelCooling.Match(wordsOf(body)) {
+		id = c.restID()
+	}
 	// out of credit, or of a quota, on a model that costs credits where
 	// the subscription serves other models free is that model's: the free
 	// ones draw on no credits, and the account still serves them (Creat.wu
diff --git a/internal/gateway/routing_test.go b/internal/gateway/routing_test.go
index 9c06fa5f..03d3fd73 100644
--- a/internal/gateway/routing_test.go
+++ b/internal/gateway/routing_test.go
@@ -1,6 +1,7 @@
 package gateway
 
 import (
+	"bytes"
 	"net/http"
 	"strconv"
 	"testing"
@@ -314,3 +315,51 @@ func TestSmartFiveHoursAlone(t *testing.T) {
 		t.Fatalf("a week renewing within the hour first: %s", got)
 	}
 }
+
+// A relay's 429 that names the model whose credentials cooled down is
+// that model's rest: its siblings on the same key still answer upstream,
+// and none of them is told the model's sentence (#3039, gpt-load's "All
+// credentials for model model-a are cooling down via provider upstream",
+// Retry-After an hour). Resting the key benched every sibling for that
+// hour without one being asked.
+func TestModelCoolingDownRestsTheModelOnly(t *testing.T) {
+	old := allowances
+	defer func() { allowances = old }()
+	fresh(t)
+	allowances = func(string) map[string]provider.Allowance {
+		return map[string]provider.Allowance{}
+	}
+	key := func(model string) candidate {
+		return candidate{p: provider.Provider{ID: "relay", Key: "sk-relay"}, model: model, rest: "relay"}
+	}
+	s := &Server{}
+	header := http.Header{}
+	header.Set("Retry-After", "3597")
+	refused := []byte(`{"error":{"message":"All credentials for model model-a are cooling down via provider upstream (last error: usage_limit_reached: The usage limit has been reached)"}}`)
+
+	a := key("model-a")
+	r := s.restAfter(a, 429, header, refused)
+	if r.Key != a.restID() || r.Model != a.model {
+		t.Fatalf("model-a's cooling-down rested %+v (model %q), not the model alone", r, r.Model)
+	}
+	if _, ok := restOf(key("model-b").restID()); ok {
+		t.Fatal("model-a cooling down rested model-b")
+	}
+	if _, ok := restOf(key("model-b").restKey()); ok {
+		t.Fatal("model-a cooling down rested the whole key")
+	}
+	// the model's own sentence is the model's rest's to keep
+	if kept, _ := restOf(a.restID()); !bytes.Contains([]byte(kept.said), []byte("model-a")) {
+		t.Fatalf("model-a's rest keeps %q", kept.said)
+	}
+
+	// an account-level cool-down that names no model rests the key: the
+	// model-scoped branch is for wordings that name one
+	restingUntil.Lock()
+	restingUntil.m, restingUntil.note = map[string]time.Time{}, map[string]Rest{}
+	restingUntil.Unlock()
+	whole := key("model-b")
+	if r := s.restAfter(whole, 429, header, []byte(`{"error":{"message":"All credentials are cooling down via provider upstream"}}`)); r.Key != whole.restKey() {
+		t.Fatalf("an account-level cool-down rested %+v, want the key", r)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
