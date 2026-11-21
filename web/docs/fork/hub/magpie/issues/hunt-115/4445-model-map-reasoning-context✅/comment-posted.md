## Summary

A Codex Desktop turn on one of Codex's own Responses Lite models (`gpt-6.1-sol`), routed through the Model Map plugin to a Remote Magpie provider, answered 400 on every turn and on `thread_sample` too:

```
Remote magpie: Codex: X-OpenAI-Internal-Codex-Responses-Lite requires `reasoning.context` to be `all_turns`.
```

## Cause

`liteKept` decides which Responses upstreams get Codex's Lite request as it was sent (the `additional_tools` input item, `reasoning.context: "all_turns"`, the `X-OpenAI-Internal-Codex-Responses-Lite` header). A Remote Magpie provider matched none of its cases, so the outgoing request went through `fromLite`: the tools lifted into `tools`, the reasoning context taken off, and `forwardOnce` dropped the header. The remote serves `codex/gpt-6.1-sol` through **its** ChatGPT account, which passes a Responses request on as it received it — and the ChatGPT backend refuses a request for one of its Lite models without `reasoning.context` `all_turns` (the same requirement #534 records). The request arrived stripped of exactly what that model demands. That the reporter's `codex=as-sent` setting (which puts `Provider.CodexAsSent` into `liteKept`) led to 200s points the same way.

## Fix

`liteKept` now also keeps the shape, with the model it is asked for, when the upstream is a Remote Magpie and the model is its codex one — named `codex/<model>`, the ChatGPT account's namespace in every magpie's catalog, so a remote lists such a model only when that account is there to serve it. The shape and the header then survive to the remote, whose account path already keeps them (its `x-openai-*` relay carries the header on to the backend). Every other model of a remote magpie still gets what Codex sends a model that isn't Lite (#350): the lift is unchanged.

## Verification

| Check | Result |
| --- | --- |
| `TestRemoteMagpieCodexModelKeepsLite` (new): a Lite request routed to a remote magpie's codex model, the fake upstream refusing exactly this 400 | failed before the change with the issue's error, passes after |
| `TestRemoteMagpieOtherModelLeavesLite` (new): the same request to the remote's other model | tools lifted, reasoning context and header still taken off |
| `go test -tags nogui ./internal/gateway/` (changed package, full) | ok (532s) |
| `gofmt -l internal/gateway/` | clean |
| `go vet -tags nogui` on the package, darwin / GOOS=linux / GOOS=windows | clean |
| `go build -tags nogui` darwin / linux / windows | pass (a pre-existing cgo `-Wenum-conversion` warning in `internal/gui` on darwin, present on main) |
| Ablation: product files reverted, tests kept | the codex-model test returns red with the same 400 |

## Not verified

- Against a real Remote Magpie and ChatGPT account: the repro here is an httptest upstream standing in for the remote, scripted to refuse with the issue's exact error. The reporter's timeline also mixed the remote's upgrade to 0.1.2212 with `codex=as-sent`, so their recovery can't be attributed to one variable; this patch makes the default path keep the request as Codex sent it, the state that produced 200s there.
- The WebSocket turn path (`responses_ws`) goes through the same two decision sites, but only the HTTP POST path is exercised in the test.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a remote magpie's codex model gets Codex's Responses Lite as it was sent (#4445) — git am applies it as is; SHA-256 first 16: 2bc171eb01238f28</summary>

```patch
From 9acf8d7bae937cc608187e615262cc610e39edc7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 18:20:52 +0800
Subject: [PATCH] gateway: a remote magpie's codex model gets Codex's Responses
 Lite as it was sent (#4445)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: a Codex Desktop turn on one of its own Lite models (gpt-6.1-sol)
routed through Model Map to a Remote Magpie provider answered 400 "Remote
magpie: Codex: X-OpenAI-Internal-Codex-Responses-Lite requires
`reasoning.context` to be `all_turns`". liteKept treats a Remote Magpie like
any plain Responses upstream, so passthrough ran fromLite (the additional_tools
item lifted into tools, reasoning.context taken off) and forwardOnce dropped
the Lite header. The remote serves codex/<model> through its ChatGPT account,
which passes on what it got, and the ChatGPT backend refuses a request for one
of its Lite models without reasoning context "all_turns" (#534): the request
arrived stripped of exactly what that model demands. Had it gone as Codex sent
it, the remote's account path keeps the Lite shape (liteKept true there) and
its answer is 200, as the reporter's codex=as-sent workaround showed.

liteKept now also keeps the shape, with the model it is asked for: a Remote
Magpie's codex model, named codex/<model> — the ChatGPT account's namespace in
every magpie's catalog, so the remote lists one only when that account is there
to serve it. Its other models still get what Codex sends a model that isn't
Lite (#350), header and reasoning context included in the lift (#350, TangForX).

Run: go test -tags nogui -run 'TestRemoteMagpieCodexModelKeepsLite|
TestRemoteMagpieOtherModelLeavesLite' ./internal/gateway/ — the first failed
with the 400 above before the change and passes after; the second keeps the
old behavior. go test -tags nogui ./internal/gateway/ passes.

Fixes #4445

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/additional_tools.go      |  23 ++++-
 internal/gateway/additional_tools_test.go | 103 ++++++++++++++++++++++
 internal/gateway/gateway.go               |   4 +-
 3 files changed, 124 insertions(+), 6 deletions(-)

diff --git a/internal/gateway/additional_tools.go b/internal/gateway/additional_tools.go
index 9f4cf75e2..5022e4daf 100644
--- a/internal/gateway/additional_tools.go
+++ b/internal/gateway/additional_tools.go
@@ -67,15 +67,30 @@ func withoutReasoningContext(body []byte) []byte {
 }
 
 // liteKept says a Responses request to p goes in Codex's Lite shape as it
-// was sent: to OpenAI, to a ChatGPT account, and to a relay that takes
-// Codex's requests as Codex sent them (Provider.CodexAsSent, #1758).
-func liteKept(p provider.Provider, to provider.Protocol, codex bool) bool {
+// was sent: to OpenAI, to a ChatGPT account, to a relay that takes Codex's
+// requests as Codex sent them (Provider.CodexAsSent, #1758), and to another
+// magpie's codex model, which that magpie serves through its ChatGPT
+// account (codexModel, #4445).
+func liteKept(p provider.Provider, to provider.Protocol, codex bool, model string) bool {
 	if to != provider.Responses {
 		return false
 	}
 	return p.Account != nil && p.Account.Agent == "codex" ||
 		strings.HasSuffix(p.Host(), "openai.com") ||
-		p.CodexAsSent && p.Account == nil && codex
+		p.CodexAsSent && p.Account == nil && codex ||
+		p.IsRemoteMagpie() && codexModel(model)
+}
+
+// codexModel is a magpie's ChatGPT account model: one named codex/<model>,
+// the account's namespace in every magpie's catalog, so a remote magpie
+// lists one only when that account is there to serve it. The backend turns
+// a request for one of its Lite models away without reasoning context
+// "all_turns" (#4445), and what a Lite request carries is that account's to
+// pass on, not this magpie's to take off: the shape and header lifted for
+// anyone else leave the account a request its backend refuses.
+func codexModel(model string) bool {
+	name, _, ok := strings.Cut(model, "/")
+	return ok && name == "codex"
 }
 
 // liteNamespace is the namespace Responses Lite groups Codex's own
diff --git a/internal/gateway/additional_tools_test.go b/internal/gateway/additional_tools_test.go
index 1c9524da7..4734d7995 100644
--- a/internal/gateway/additional_tools_test.go
+++ b/internal/gateway/additional_tools_test.go
@@ -3,6 +3,7 @@ package gateway
 import (
 	"encoding/json"
 	"net/http"
+	"net/http/httptest"
 	"strings"
 	"testing"
 
@@ -104,6 +105,108 @@ func TestAdditionalToolsTranslated(t *testing.T) {
 	}
 }
 
+// liteSent is a request POSTed as Codex sends a Lite model's: the Lite
+// header on, and the reasoning context the ChatGPT backend asks of a Lite
+// request (#534).
+func liteSent(body string) *http.Request {
+	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
+	req.Header.Set("User-Agent", "codex/0.165.0 (Mac OS 27.2; arm64) UnknownTerminal")
+	req.Header.Set("originator", "codex_cli_rs")
+	req.Header.Set(liteHeader, "true")
+	return req
+}
+
+// A remote magpie's codex model is served there through its ChatGPT
+// account, which passes on what it got, and the ChatGPT backend refuses a
+// request for one of its Lite models without reasoning context "all_turns"
+// (#4445). So a Lite request routed to it goes as Codex sent it — what the
+// shape lift takes off for anyone else leaves the account a request its
+// backend turns away.
+func TestRemoteMagpieCodexModelKeepsLite(t *testing.T) {
+	f := &fake{t: t, reply: sse(
+		`data: {"type":"response.created","response":{"id":"r1","model":"m1"}}`,
+		`data: {"type":"response.completed","response":{"id":"r1","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}`)}
+	f.refuse = func(body []byte) (int, string) {
+		var q struct {
+			Reasoning struct {
+				Context string `json:"context"`
+			} `json:"reasoning"`
+		}
+		json.Unmarshal(body, &q)
+		if q.Reasoning.Context != "all_turns" {
+			return http.StatusBadRequest, `{"error":{"message":"X-OpenAI-Internal-Codex-Responses-Lite requires ` + "`reasoning.context`" + ` to be ` + "`all_turns`" + `.","type":"invalid_request_error","code":"unsupported_value","param":"reasoning.context"}}`
+		}
+		return 0, ""
+	}
+	fresh(t)
+	up := httptest.NewServer(f)
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "office", Name: "Office", Preset: provider.RemoteMagpiePreset, Key: "sk-office", Responses: up.URL, Models: []string{"codex/m1"}}); err != nil {
+		t.Fatal(err)
+	}
+	body := strings.Replace(liteRequest, `"model":"fake/m1",`,
+		`"model":"office/codex/m1","reasoning":{"effort":"xhigh","context":"all_turns"},`, 1)
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, liteSent(body))
+	if rec.Code != 200 {
+		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
+	}
+	var got struct {
+		Reasoning map[string]any   `json:"reasoning"`
+		Input     []map[string]any `json:"input"`
+	}
+	if err := json.Unmarshal(f.got, &got); err != nil {
+		t.Fatal(err)
+	}
+	if got.Reasoning["context"] != "all_turns" {
+		t.Fatalf("reasoning.context not kept: %s", f.got)
+	}
+	if f.head.Get(liteHeader) != "true" {
+		t.Fatalf("the Lite header was dropped: %v", f.head)
+	}
+	if len(got.Input) == 0 || got.Input[0]["type"] != "additional_tools" {
+		t.Fatalf("the Lite tools were lifted: %s", f.got)
+	}
+}
+
+// Another of the remote magpie's models still gets what Codex sends a model
+// that isn't Lite (#350): its tools lifted, the reasoning context and the
+// Lite header taken off. Only the codex model keeps the shape.
+func TestRemoteMagpieOtherModelLeavesLite(t *testing.T) {
+	f := &fake{t: t, reply: sse(
+		`data: {"type":"response.created","response":{"id":"r1","model":"m1"}}`,
+		`data: {"type":"response.completed","response":{"id":"r1","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}`)}
+	fresh(t)
+	up := httptest.NewServer(f)
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "office", Name: "Office", Preset: provider.RemoteMagpiePreset, Key: "sk-office", Responses: up.URL, Models: []string{"vendor/m"}}); err != nil {
+		t.Fatal(err)
+	}
+	body := strings.Replace(liteRequest, `"model":"fake/m1",`,
+		`"model":"office/vendor/m","reasoning":{"effort":"xhigh","context":"all_turns"},`, 1)
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, liteSent(body))
+	if rec.Code != 200 {
+		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
+	}
+	var got struct {
+		Reasoning map[string]any   `json:"reasoning"`
+		Input     []map[string]any `json:"input"`
+	}
+	if err := json.Unmarshal(f.got, &got); err != nil {
+		t.Fatal(err)
+	}
+	if _, has := got.Reasoning["context"]; has {
+		t.Fatalf("reasoning.context kept on a plain model: %s", f.got)
+	}
+	if f.head.Get(liteHeader) != "" {
+		t.Fatalf("the Lite header was kept on a plain model: %v", f.head)
+	}
+	if len(got.Input) == 0 || got.Input[0]["type"] == "additional_tools" {
+		t.Fatalf("the Lite tools were not lifted: %s", f.got)
+	}
+}
+
 // Lite tools sent beside tools already there are added once, a namespace
 // given again adding the tools it didn't have; an empty additional_tools
 // just goes; a request without one is left as it was.
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index b19da3873..fba4e745e 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4887,7 +4887,7 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 		// magpie never does. A test asked as Codex asks with them
 		// (provider.TestAs)
 		seen := http.Header{}
-		lite := liteKept(p, to, true)
+		lite := liteKept(p, to, true, modelOf(body))
 		for k, vs := range in {
 			if !lite && strings.EqualFold(k, liteHeader) {
 				// the body left Lite (fromLite), so does its header
@@ -5140,7 +5140,7 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 		// Responses Lite's shape, its tools as an input item (#350) and its
 		// reasoning context, goes only to OpenAI; anyone else is sent what
 		// Codex sends a model that isn't Lite
-		if !liteKept(p, proto, fromCodex(r.Header)) {
+		if !liteKept(p, proto, fromCodex(r.Header), modelOf(body)) {
 			body = fromLite(body)
 		}
 		// only the ChatGPT backend runs Codex's tool search as Codex sends it
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt115-b4-4445](https://github.com/ggbdpq/magpie/tree/hunt115-b4-4445) (head `9acf8d7bae937cc608187e615262cc610e39edc7`).
