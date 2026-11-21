**What happens.** Copilot's Gemini turns a tool-bearing request away 400 `invalid_request_body` when a tool's property schema is an `anyOf` of overlapping scalar branches (#5952, qinezh) — `{"anyOf":[{"type":"string","enum":["a","b"]},{"type":"string"}]}` and the nested-integer-intervals pair both 400, while each union's widest branch alone answers 200. The gateway has translated Copilot Gemini unions since #4374, but only object unions: `copilotGeminiToolUnions` renames a provably disjoint anyOf-of-object-branches to oneOf and leaves everything else — the scalar unions among them — an anyOf, which Copilot's Gemini refuses.

**Minimal reproduction.** The issue's four-fixture A/B, as a test against a fake Copilot that refuses any body carrying `"anyOf"` (the observed contract of #4374's comparisons and this issue's fixtures alike): `TestCopilotGeminiTakesOverlappingScalarUnionsAsTheirWidest` sends both unions through `/v1/chat/completions` and expects 200 with the collapsed schemas reaching Copilot; `TestCopilotGeminiKeepsUnprovenScalarUnions` pins that an unprovable one — two integer intervals with a gap — still 400s through to the client rather than being widened.

**Root cause.** The rename-only rewrite can't touch overlapping unions: `oneOf` says *at most one branch*, which an overlapping union doesn't say (the issue's own warning), and leaving the anyOf is the refusal. What Copilot demonstrably takes (the reporter's A/B) is the single typed schema, so a scalar union goes whole only when one branch provably takes every value the others do. Two proofs carry the reporter's fixtures and stay airtight: the pure type (`{"type":"string"}` beside nothing binding) takes every value any same-type branch admits, and the wider of two numeric-bound intervals takes the narrower (each bound compared; a bound the wider names where the narrower names none refuses the proof, which is exactly the gap case). A branch carrying a `$ref`, `not`, nested `allOf` or any other unreadable key proves nothing and leaves the union as it came.

**The fix.** `copilotGeminiToolUnions`'s walk collects, beside the oneOf renames, the spans of anyOf nodes a branch takes whole — the node must hold the union alone, a description beside it going nowhere — and splices them from the last backward, each at its place in the body the renames left (the renames are the same length they came in). The replacement is the branch's own bytes, so nothing is re-encoded. Unproven unions — gap intervals, two patterns, nullable ones — stay an anyOf with their refusal reaching the client, as `TestCopilotGeminiKeepsUnprovenUnions` already pinned for objects.

**Verification.**

| Check | Result |
| --- | --- |
| `go build ./internal/gateway/`, `gofmt -l`, `go vet` | pass / clean / clean |
| `TestCopilotGeminiTakesOverlappingScalarUnionsAsTheirWidest`, `TestCopilotGeminiKeepsUnprovenScalarUnions` | PASS (the issue's four fixtures) |
| `TestCopilotGeminiTakesCodexUnionsAsOneOf`, `TestCopilotGeminiKeepsUnprovenUnions` (the #4374 behavior) | PASS — the object path is untouched |
| Ablation (product file reverted to `025123431`, tests kept) | the first test fails with the issue's exact shape: `400 {"error":{"message":"Copilot: invalid request body",...}}` |
| `go test ./internal/gateway/` full (14.3 min) | green except `TestClientPathCoversHandler`, `TestReadOnlyKeyEveryRoute` — both fail on pristine `main` too (the new `/magpie-ca.crt` route's coverage, landed after my base; nothing of this change's) |
| `go test -race` | not run — the change is byte manipulation on one request body, no shared state, no goroutines touched |

Branch https://github.com/ggbdpq/magpie/tree/hunt-20261111-a-5952-copilot-gemini-anyof (head `8b5318fd63a84b0f11c10b081d655eec61344e65`), based on `025123431`; nothing since touches `copilot_gemini_schema.go` or its test file.

**Source**: the reporter's four fixtures (the two 400 unions and their two 200 simplifications) stand in the issue; the fake Copilot's refusal contract is the one #4374's live comparisons established (`anyOf` → 400, whatever else the request says).
**Red without the fix** (base `025123431`): `copilot_gemini_grok_test.go:305: 400 {"error":{"code":null,"message":"Copilot: invalid request body","param":null,"type":"invalid_request_error"}}`.
**Siblings**: `toolOneOfAsAnyOf` bails for a Copilot account (`IsCline`/`IsKilo`/openrouter only) — no interaction; the native Gemini faces (Google, Vertex, Antigravity, Code Assist) accept an anyOf in their own shapes (#5374 documents the anyOf-alone rule) and `geminiToolTypes` only adds types to untyped nodes — untouched, as are the Kimi, DeepSeek and Anthropic schema walks, each keyed to its own vendor. Within this file, the rename path's proof (object disjointness) and the new collapse are mutually exclusive by shape.
**When the read fails**: every guard fails closed to the old behavior — a span whose bytes don't match at apply time is skipped, a node with a key beside the union isn't collected, a branch with an unreadable key isn't proved, and a request whose body gjson couldn't see (`node.Index` 0) is left alone. A request that 400s today 400s the same; only the provable unions change what goes out.
**Not verified**: against Copilot itself — I have no Copilot account; the fix's output forms (`{"type":"string"}`, `{"type":"integer","minimum":1,"maximum":20}`) are exactly the reporter's proven-200 schemas, but the live acceptance of the collapsed request is the reporter's A/B, not my run. Nullable scalar unions (`{"type":"string"},{"type":"null"}`) are unproven here and stay refused — whether Copilot takes them needs its own evidence.
**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
**Patch**: <details><summary>patch: gateway: a Copilot Gemini tool union one branch takes goes as that branch (#5952) — git am applies it as is; SHA-256 first 16: 7873884d507713aa</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 00:58:59 +0800
Subject: [PATCH] gateway: a Copilot Gemini tool union one branch takes goes as
 that branch (#5952)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Copilot's Gemini turns a tool schema's anyOf away 400 invalid request
body — the object unions went as oneOf since #4374, and the scalar ones
stayed anyOf, refused all the same (#5952, qinezh: an anyOf of two
overlapping string branches, and one of two nested integer intervals,
each turned away where the union's widest branch alone came back 200).
An overlapping union must not go as oneOf, which says at most one
branch, so a scalar union of one type now goes as the branch that
provably takes the others' values: the pure type takes every value the
enum'd branch of its type does, and the wider of two nested numeric
intervals takes the narrower. A union no branch takes the rest of — a
gap between two intervals — stays an anyOf, refusal and all.

TestCopilotGeminiTakesOverlappingScalarUnionsAsTheirWidest is the
issue's two fixtures against a Copilot that refuses any anyOf, and
TestCopilotGeminiKeepsUnprovenScalarUnions pins the gap union's refusal
reaching the client.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/copilot_gemini_grok_test.go |  89 +++++++++
 internal/gateway/copilot_gemini_schema.go    | 192 ++++++++++++++++++-
 2 files changed, 271 insertions(+), 10 deletions(-)

diff --git a/internal/gateway/copilot_gemini_grok_test.go b/internal/gateway/copilot_gemini_grok_test.go
index 7758163cb..861396b1c 100644
--- a/internal/gateway/copilot_gemini_grok_test.go
+++ b/internal/gateway/copilot_gemini_grok_test.go
@@ -270,3 +270,92 @@ func copilotTurnFake(t *testing.T, models map[string]string, refuse func(model s
 	provider.CopilotTokenURL, provider.CopilotUserURL = ghSrv.URL+"/token", ghSrv.URL+"/user"
 	t.Cleanup(func() { provider.CopilotTokenURL, provider.CopilotUserURL = oldTok, oldUser })
 }
+
+// copilotScalarUnionsRequest is the issue's repro (#5952, qinezh): one tool
+// whose single property is an anyOf of two overlapping string branches, and
+// one whose single property is an anyOf of two nested integer intervals —
+// both turned away 400 "invalid request body" by Copilot's Gemini, while
+// each union's widest branch alone came back 200.
+const copilotScalarUnionsRequest = `{"model":"copilot/gemini-4-argon","stream":true,
+  "messages":[{"role":"user","content":"Reply with exactly OK. Do not call tools."}],
+  "tools":[{"type":"function","function":{"name":"test_tool","description":"Synthetic schema test.",
+    "parameters":{"type":"object","properties":{"value":{"anyOf":[{"type":"string","enum":["a","b"]},{"type":"string"}]}},"required":["value"]}}},
+            {"type":"function","function":{"name":"test_count","description":"Synthetic schema test.",
+    "parameters":{"type":"object","properties":{"value":{"anyOf":[{"type":"integer","minimum":1,"maximum":10},{"type":"integer","minimum":1,"maximum":20}]}},"required":["value"]}}}],
+  "tool_choice":"auto","max_tokens":64}`
+
+// TestCopilotGeminiTakesOverlappingScalarUnionsAsTheirWidest: what Copilot's
+// Gemini turns away is the anyOf (#4374's comparisons, now on scalar unions
+// too), and a union of overlapping branches must not go as oneOf, which says
+// at most one branch — so a branch every other branch provably admits nothing
+// beside goes alone: the pure type takes every string the enum'd branch does,
+// and the wider of two nested intervals takes both.
+func TestCopilotGeminiTakesOverlappingScalarUnionsAsTheirWidest(t *testing.T) {
+	var mu sync.Mutex
+	var sent []string
+	copilotTurnFake(t, map[string]string{
+		"gemini-4-argon": `["/chat/completions"]`,
+	}, nil, func(m string, b []byte) bool {
+		return bytes.Contains(b, []byte(`"anyOf"`))
+	}, "invalid request body", http.StatusBadRequest, &sent)
+
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(copilotScalarUnionsRequest)))
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "hi") {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(sent) != 1 {
+		t.Fatalf("Copilot was asked %d times", len(sent))
+	}
+	if strings.Contains(sent[0], `"anyOf"`) {
+		t.Errorf("the overlapping scalar unions went to Copilot's Gemini as anyOf, which it turns away: %s", sent[0])
+	}
+	if !strings.Contains(sent[0], `"value":{"type":"string"}`) {
+		t.Errorf("the string union did not go as its pure branch: %s", sent[0])
+	}
+	if strings.Contains(sent[0], `"enum":["a","b"]`) {
+		t.Errorf("the branch the pure type takes in did not go away: %s", sent[0])
+	}
+	if !strings.Contains(sent[0], `"value":{"type":"integer","minimum":1,"maximum":20}`) {
+		t.Errorf("the integer union did not go as its widest interval: %s", sent[0])
+	}
+	if strings.Contains(sent[0], `"maximum":10`) {
+		t.Errorf("the narrower interval went beside the wider one: %s", sent[0])
+	}
+}
+
+// copilotScalarGapRequest carries the union the collapse must not make: two
+// integer intervals with a gap between them, whose envelope [1,20] would
+// admit 6..9 that neither branch does.
+const copilotScalarGapRequest = `{"model":"copilot/gemini-4-argon","stream":true,
+  "messages":[{"role":"user","content":"Reply with exactly OK. Do not call tools."}],
+  "tools":[{"type":"function","function":{"name":"test_count","description":"Synthetic schema test.",
+    "parameters":{"type":"object","properties":{"value":{"anyOf":[{"type":"integer","minimum":1,"maximum":5},{"type":"integer","minimum":10,"maximum":20}]}},"required":["value"]}}}],
+  "tool_choice":"auto","max_tokens":64}`
+
+// TestCopilotGeminiKeepsUnprovenScalarUnions: only a branch that provably
+// takes the others' values goes alone. A union with a gap between its
+// branches stays an anyOf, and Copilot's refusal of it still reaches the
+// client, as TestCopilotGeminiKeepsUnprovenUnions pins for objects.
+func TestCopilotGeminiKeepsUnprovenScalarUnions(t *testing.T) {
+	var mu sync.Mutex
+	var sent []string
+	copilotTurnFake(t, map[string]string{
+		"gemini-4-argon": `["/chat/completions"]`,
+	}, nil, func(m string, b []byte) bool {
+		return bytes.Contains(b, []byte(`"anyOf"`))
+	}, "invalid request body", http.StatusBadRequest, &sent)
+
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(copilotScalarGapRequest)))
+	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid request body") {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(sent) != 0 {
+		t.Errorf("a refused turn was recorded as taken: %q", sent)
+	}
+}
diff --git a/internal/gateway/copilot_gemini_schema.go b/internal/gateway/copilot_gemini_schema.go
index 9ece2788b..c8b70f7c4 100644
--- a/internal/gateway/copilot_gemini_schema.go
+++ b/internal/gateway/copilot_gemini_schema.go
@@ -2,6 +2,7 @@ package gateway
 
 import (
 	"bytes"
+	"slices"
 
 	"github.com/tidwall/gjson"
 	"github.com/yetone/magpie/internal/provider"
@@ -24,6 +25,18 @@ import (
 // requires a field the other forbids through additionalProperties: false
 // (with no patternProperties beside it, which would admit the name). A
 // union that can't be proved — nullable ones among them — stays an anyOf.
+//
+// The refusal is not the object unions' alone: Copilot's Gemini turns a
+// scalar union away the same way (#5952, qinezh — an anyOf of two
+// overlapping string branches, and one of two nested integer intervals,
+// each 400 "invalid request body" where the union's widest branch alone
+// came back 200). An overlapping union must not go as oneOf, which says at
+// most one branch, so a scalar union goes as the one branch every other
+// branch provably admits nothing beside: the pure type takes every value
+// the enum'd branch of its type does, and the wider of two nested numeric
+// intervals takes the narrower. A union no branch takes the rest of — a
+// gap between two intervals, two patterns — stays an anyOf, refusal and
+// all, rather than say something the schema doesn't.
 func copilotGeminiToolUnions(p provider.Provider, to provider.Protocol, body []byte) []byte {
 	if to != provider.Chat || p.Account == nil || p.Account.Agent != "copilot" ||
 		!geminiNamed(gjson.GetBytes(body, "model").String()) {
@@ -33,13 +46,14 @@ func copilotGeminiToolUnions(p provider.Provider, to provider.Protocol, body []b
 		return body
 	}
 	var at []int
+	var spans []copilotUnionSpan
 	gjson.GetBytes(body, "tools").ForEach(func(_, tool gjson.Result) bool {
 		for _, path := range []string{"function.parameters", "parameters", "input_schema"} {
-			collectCopilotUnions(body, tool.Get(path), &at)
+			collectCopilotUnions(body, tool.Get(path), &at, &spans)
 		}
 		return true
 	})
-	if len(at) == 0 {
+	if len(at) == 0 && len(spans) == 0 {
 		return body
 	}
 	// renamed in place, the same length, so nothing else of the body moves
@@ -48,40 +62,198 @@ func copilotGeminiToolUnions(p provider.Provider, to provider.Protocol, body []b
 	for _, i := range at {
 		copy(out[i:], `"oneOf"`)
 	}
+	// a collapse moves what follows it, so the spans go in from the last
+	// backward, each at its place in the body the renames left (the same
+	// length it came in)
+	slices.SortFunc(spans, func(a, b copilotUnionSpan) int { return b.at - a.at })
+	for _, s := range spans {
+		if s.at < 0 || s.at+len(s.raw) > len(out) || string(out[s.at:s.at+len(s.raw)]) != s.raw {
+			continue
+		}
+		out = append(out[:s.at], append([]byte(s.goes), out[s.at+len(s.raw):]...)...)
+	}
 	return out
 }
 
+// copilotUnionSpan is a tool schema's anyOf node replaced whole by the one
+// branch that takes the others' values: where the node opens in the body,
+// the node as it came, and the branch as the client wrote it.
+type copilotUnionSpan struct {
+	at   int
+	raw  string
+	goes string
+}
+
 // collectCopilotUnions adds where each anyOf of provably disjoint object
 // branches under node, a tool's schema, starts in body: a key, not a
-// property of that name.
-func collectCopilotUnions(body []byte, node gjson.Result, at *[]int) {
+// property of that name. It adds, beside each anyOf a branch takes the
+// rest of, the span of the node that holds it — which must hold the union
+// alone, a description beside it going nowhere.
+func collectCopilotUnions(body []byte, node gjson.Result, at *[]int, spans *[]copilotUnionSpan) {
 	switch {
 	case node.IsArray():
 		node.ForEach(func(_, v gjson.Result) bool {
-			collectCopilotUnions(body, v, at)
+			collectCopilotUnions(body, v, at, spans)
 			return true
 		})
 	case node.IsObject():
-		if union := node.Get("anyOf"); union.Exists() && !node.Get("oneOf").Exists() && disjointObjectBranches(union) {
-			if i := keyBefore(body, union.Index, `"anyOf"`); i >= 0 {
-				*at = append(*at, i)
+		if union := node.Get("anyOf"); union.Exists() && !node.Get("oneOf").Exists() {
+			if disjointObjectBranches(union) {
+				if i := keyBefore(body, union.Index, `"anyOf"`); i >= 0 {
+					*at = append(*at, i)
+				}
+			} else if branch := collapsedScalarBranch(union); branch.Raw != "" && node.Index > 0 &&
+				node.Index < len(body) && body[node.Index] == '{' && nodeKeys(node) == 1 {
+				*spans = append(*spans, copilotUnionSpan{at: node.Index, raw: node.Raw, goes: branch.Raw})
 			}
 		}
 		node.ForEach(func(key, v gjson.Result) bool {
 			switch key.String() {
 			case "properties", "$defs", "definitions", "dependentSchemas", "patternProperties":
 				v.ForEach(func(_, s gjson.Result) bool {
-					collectCopilotUnions(body, s, at)
+					collectCopilotUnions(body, s, at, spans)
 					return true
 				})
 			case "items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf", "prefixItems", "unevaluatedProperties", "unevaluatedItems", "contentSchema":
-				collectCopilotUnions(body, v, at)
+				collectCopilotUnions(body, v, at, spans)
 			}
 			return true
 		})
 	}
 }
 
+// nodeKeys counts the keys node, an object, has.
+func nodeKeys(node gjson.Result) int {
+	n := 0
+	node.ForEach(func(_, _ gjson.Result) bool { n++; return true })
+	return n
+}
+
+// collapsedScalarBranch is the branch of union, an anyOf, that takes every
+// value the other branches do — the one the union says the same thing as —
+// or none: a scalar union of one type whose branches but for descriptions
+// say only what they take, where one branch's bounds take the rest's.
+// Object branches have their own proof, the disjoint one, and a branch
+// that carries a $ref, a not, a nested allOf or anything else that can't
+// be read whole proves nothing.
+func collapsedScalarBranch(union gjson.Result) gjson.Result {
+	if !union.IsArray() {
+		return gjson.Result{}
+	}
+	branches := union.Array()
+	if len(branches) < 2 {
+		return gjson.Result{}
+	}
+	for _, b := range branches {
+		if !scalarBranchReadable(b) {
+			return gjson.Result{}
+		}
+	}
+	for _, b := range branches {
+		takes := true
+		for _, a := range branches {
+			if a.Index != b.Index && !scalarBranchImplied(a, b) {
+				takes = false
+				break
+			}
+		}
+		if takes {
+			return b
+		}
+	}
+	return gjson.Result{}
+}
+
+// scalarBranchReadable is whether branch is a schema of one scalar type
+// whose remaining keys say only what it takes: no $ref, no not, no
+// combination, no shape of an object or an array.
+func scalarBranchReadable(branch gjson.Result) bool {
+	if !branch.IsObject() {
+		return false
+	}
+	switch t := branch.Get("type").String(); t {
+	case "string", "number", "integer", "boolean":
+	default:
+		return false
+	}
+	ok := true
+	branch.ForEach(func(k, _ gjson.Result) bool {
+		switch k.String() {
+		case "type", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
+			"minLength", "maxLength", "pattern", "format", "multipleOf", "description":
+		default:
+			ok = false
+		}
+		return ok
+	})
+	return ok
+}
+
+// scalarBranchImplied is whether b, a scalar branch, takes every value a
+// does: outright when b is its type alone, and between two branches that
+// say only numeric bounds, when each bound b says takes what a says and b
+// says no multipleOf a doesn't. A bound b says where a says none keeps a's
+// values out, so b takes nothing there.
+func scalarBranchImplied(a, b gjson.Result) bool {
+	if bPure := pureScalarBranch(b); bPure {
+		return true
+	}
+	t := b.Get("type").String()
+	if t != "number" && t != "integer" {
+		return false
+	}
+	for _, k := range []string{"enum", "const", "minLength", "maxLength", "pattern", "format"} {
+		if a.Get(k).Exists() || b.Get(k).Exists() {
+			return false
+		}
+	}
+	for _, k := range []string{"minimum", "exclusiveMinimum"} {
+		av, bv := a.Get(k), b.Get(k)
+		switch {
+		case av.Exists() && bv.Exists():
+			if bv.Float() > av.Float() {
+				return false
+			}
+		case bv.Exists():
+			return false
+		}
+	}
+	for _, k := range []string{"maximum", "exclusiveMaximum"} {
+		av, bv := a.Get(k), b.Get(k)
+		switch {
+		case av.Exists() && bv.Exists():
+			if bv.Float() < av.Float() {
+				return false
+			}
+		case bv.Exists():
+			return false
+		}
+	}
+	if bv := b.Get("multipleOf"); bv.Exists() {
+		av := a.Get("multipleOf")
+		if !av.Exists() || bv.Float() != av.Float() {
+			return false
+		}
+	}
+	return true
+}
+
+// pureScalarBranch is whether branch says its type and nothing else that
+// binds: the type takes every value of its own, whatever the branch beside
+// it in the union asks for.
+func pureScalarBranch(branch gjson.Result) bool {
+	ok := true
+	branch.ForEach(func(k, _ gjson.Result) bool {
+		switch k.String() {
+		case "type", "description":
+		default:
+			ok = false
+		}
+		return ok
+	})
+	return ok
+}
+
 // disjointObjectBranches is whether union, an anyOf, is of object branches
 // only and every two of them are proved apart.
 func disjointObjectBranches(union gjson.Result) bool {
-- 
2.50.1 (Apple Git-155)

```

</details>
