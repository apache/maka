Refreshed on current `main` (`a6d84e13a`) — refreshed, not redesigned: same change as before, cherry-picked clean onto today's tip (`32ea16c5a`'s next-API shape for the Claude Code client is in the base; this stays the generic-endpoint face of the same gap).

**Red without the fix** (bare `a6d84e13a`, the test from this branch): `go test ./internal/provider -run TestTestTriesTheNextModelOnTheEndpoint` fails as the report says — the endpoint's row stays red on a model the vendor serves elsewhere:

```
chat stayed red: {Protocol:chat OK:false Status:400 Model:gpt-5.6-sol
Error:模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses… otherAPI:true}
(asked [gpt-5.6-sol /v1/chat/completions gpt-5.6-sol /v1/responses])
```

With the fix: `ok` (1.2s) — the endpoint asks the next model on its list before it stays red.

**Verification** (all on `a6d84e13a`):
| What | Result |
| --- | --- |
| `go test ./internal/provider -run TestTestTriesTheNextModelOnTheEndpoint` | ok 1.2s |
| full `go test ./internal/provider` | zero failures (the four reds of yesterday's main are fixed upstream) |
| `gofmt` / `go vet` | clean |
| `GOOS=linux go build ./internal/provider` | ok |
| ablation (next-model loop dropped, tests kept) | red again verbatim (`chat stayed red … otherAPI:true`); restored, green |
| `git am` on detached `a6d84e13a` | applies as is; tree identical to the branch head |

**Siblings**: `otherAPI` is set in one place (`probe`, `test.go:1044`) and consumed by the loop this adds and by the existing Claude Code-client next-API retry (`test.go:528/546`, from `32ea16c5a`) — that one stays; this covers the same turn-away on every endpoint's row, no client named. `testModel`'s five other callers pass no `except` and behave as before.

**Branch with the commit**: [hunt-20261111-rf-3844](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-3844) (head `458fe32fc72987ff`).

**Not verified**: a real relay answering the report's shape (the fixture serves the vendor's exact word on a second API).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: provider test: an endpoint the vendor turns the first model away from tries its next model (#3844) — git am applies it as is; SHA-256 first 16: 8d1faf4f74a21269</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 11:02:49 +0800
Subject: [PATCH] provider test: an endpoint the vendor turns the first model
 away from tries its next model
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

`magpie provider test <id>` picks each endpoint's model off the
provider's list, and stayed on the first: a relay whose first model is
served on another API alone kept that endpoint red, though the same
endpoint serves its other models fine (#3844, with the reporter's
stand-in: gpt-5.6-sol turned away on chat by the vendor's #3766 wording
while glm-4.6 answers there).

The vendor's word that a model is served elsewhere (the otherAPI mark
model is asked on the same endpoint, up to three in all. A model the
vendor refuses by name on a list it serves alone stays the endpoint's
answer — no list to walk, so no red is papered over.

Fixes #3844

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/test.go      | 28 ++++++++++++--
 internal/provider/test_test.go | 67 ++++++++++++++++++++++++++++++++++
 2 files changed, 91 insertions(+), 4 deletions(-)

diff --git a/internal/provider/test.go b/internal/provider/test.go
index 403d90263..2c2f80f13 100644
--- a/internal/provider/test.go
+++ b/internal/provider/test.go
@@ -104,7 +104,22 @@ func (p Provider) Test(ctx context.Context) []Result {
 		}
 		url, body := tiny(q, proto, UpstreamName(p, model))
 		ctx, b := q.tested(p.loggedAs(ctx, q), url, body)
-		out = append(out, probe(ctx, q, proto, url, b, model, testWait))
+		r := probe(ctx, q, proto, url, b, model, testWait)
+		// the vendor's word that this model is served elsewhere is not
+		// the endpoint's whole answer: the list may serve another model
+		// here — try the next one before the endpoint stays red (#3844)
+		tried := []string{model}
+		for !r.OK && r.otherAPI && len(tried) < 3 {
+			next := p.testModel(q, proto, tried...)
+			if next == "" {
+				break
+			}
+			tried = append(tried, next)
+			url, body := tiny(q, proto, UpstreamName(p, next))
+			ctx, b := q.tested(p.loggedAs(ctx, q), url, body)
+			r = probe(ctx, q, proto, url, b, next, testWait)
+		}
+		out = append(out, r)
 	}
 	if len(out) == 0 && p.zenPublic() {
 		out = append(out, Result{Protocol: Chat, Error: zenPublicNone})
@@ -667,13 +682,15 @@ const zenPublicNone = "no free model of OpenCode Zen is listed for this API: the
 // testModel is the model a probe of proto's endpoint asks for: the first
 // exposed one q's key sees, else the first it sees at all — preferring a
 // Claude model on the Anthropic endpoint, and one that chats to one that
-// draws on an images API. On OpenCode's gateway a model models.dev names
+// draws on an images API. A model in except is passed over (the next one
+// on the list is asked when the vendor said the first is served
+// elsewhere, #3844). On OpenCode's gateway a model models.dev names
 // no API for is served on chat alone, so no other endpoint is tried with
 // it; and with Zen's public key only a free model is tried, on an API it
 // is served on, or none (z'x on Discord: Test asked public for
 // claude-fable-5 on Messages, gemini-3-flash on Gemini and big-pickle on
 // Responses, and every one failed, though big-pickle answers on chat).
-func (p Provider) testModel(q Provider, proto Protocol) string {
+func (p Provider) testModel(q Provider, proto Protocol, except ...string) string {
 	k := q.first()
 	// a model the key's vendor lists it, and the user lets it serve
 	// (AccountModels, #474), as routing has it
@@ -708,6 +725,9 @@ func (p Provider) testModel(q Provider, proto Protocol) string {
 				if public && !p.OpenCodeFree(m.ID) {
 					continue
 				}
+				if slices.Contains(except, m.ID) {
+					continue
+				}
 				if !p.DecidesModel(m.ID) && !off(p.ID, m.ID) && want(m.ID) && sees(m.ID) {
 					return m.ID
 				}
@@ -720,7 +740,7 @@ func (p Provider) testModel(q Provider, proto Protocol) string {
 		// sends it (heatonz on Discord: a provider serving only those)
 		// or one its preset names (Voyage AI, which lists none)
 		for _, m := range append(catalog.LiveServing(p.ID, ""), p.PlanRetrieval("")...) {
-			if retrievalOf(m.ID) != "" && !off(p.ID, m.ID) && sees(m.ID) {
+			if retrievalOf(m.ID) != "" && !slices.Contains(except, m.ID) && !off(p.ID, m.ID) && sees(m.ID) {
 				return m.ID
 			}
 		}
diff --git a/internal/provider/test_test.go b/internal/provider/test_test.go
index 7bc513dcf..449cd464c 100644
--- a/internal/provider/test_test.go
+++ b/internal/provider/test_test.go
@@ -411,3 +411,70 @@ func TestTestModelsAsAClientMovesAsTheGatewayDoes(t *testing.T) {
 		t.Errorf("as Claude Code: results %+v, asked %q", rs, got)
 	}
 }
+
+// #3844: a relay whose first model is served on another API kept its chat
+// endpoint red, though the same endpoint serves its other models fine.
+// The endpoint test now tries the next model on its list before the
+// endpoint stays red, and the vendor's word about the first stays the
+// answer when no other model serves there.
+func TestTestTriesTheNextModelOnTheEndpoint(t *testing.T) {
+	oneHome(t)
+	said := "模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses（OpenAI Responses API）。"
+	var mu sync.Mutex
+	var asked []string
+	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
+		if r.Method == http.MethodGet { // the model list
+			_, _ = rw.Write([]byte(`{}`))
+			return
+		}
+		var in struct{ Model string }
+		_ = json.NewDecoder(r.Body).Decode(&in)
+		mu.Lock()
+		asked = append(asked, in.Model+" "+r.URL.Path)
+		mu.Unlock()
+		if r.URL.Path == "/v1/chat/completions" && in.Model == "gpt-5.6-sol" {
+			rw.WriteHeader(http.StatusBadRequest)
+			_, _ = rw.Write([]byte(`{"error":{"message":"` + said + `","type":"invalid_request_error"}}`))
+			return
+		}
+		_, _ = rw.Write([]byte(`{}`))
+	}))
+	defer srv.Close()
+	p := Provider{ID: "relay", Name: "Relay", Chat: srv.URL + "/v1", Responses: srv.URL + "/v1",
+		Key: "sk-x", Models: []string{"gpt-5.6-sol", "glm-4.6"}}
+	took := func() []string {
+		mu.Lock()
+		defer mu.Unlock()
+		out := asked
+		asked = nil
+		return out
+	}
+	rs := p.Test(context.Background())
+	var chat Result
+	for _, r := range rs {
+		if r.Protocol == Chat {
+			chat = r
+		}
+	}
+	if !chat.OK {
+		t.Fatalf("chat stayed red: %+v (asked %v)", chat, took())
+	}
+	want := []string{"gpt-5.6-sol /v1/chat/completions", "glm-4.6 /v1/chat/completions", "gpt-5.6-sol /v1/responses"}
+	if got := took(); !slices.Equal(got, want) {
+		t.Fatalf("asked %v, want %v", got, want)
+	}
+
+	// a model the vendor refuses by name on its own is its answer: the
+	// endpoint stays red rather than walking the whole list (#3766's word)
+	lone := Provider{ID: "lone", Name: "Lone", Chat: srv.URL + "/v1", Key: "sk-x",
+		Models: []string{"gpt-5.6-sol"}}
+	rs = lone.Test(context.Background())
+	for _, r := range rs {
+		if r.Protocol == Chat && r.OK {
+			t.Fatalf("chat green on a model the vendor turns away: %+v", r)
+		}
+	}
+	if got := took(); len(got) != 1 {
+		t.Fatalf("asked %v, want the one model once", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```
</details>

