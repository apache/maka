What's wrong
---

Thanks @yinwu01 for the report (found while fixing #3766): `magpie provider test <id>` with no model picks each endpoint's test model off the provider's list and stays on the first — a relay whose first model is served on `/v1/responses` alone showed its chat endpoint red, though chat serves its other models fine. The reporter's stand-in made it exact: gpt-5.6-sol turned away on chat with the vendor's own wording, glm-4.6 answering there, and the endpoint still read ✗.

Root cause
---

The endpoint test asked one model and took the answer as the endpoint's: the vendor's word that the model is served elsewhere (the `otherAPI` mark #3766 already reads on the result) never sent the test down the provider's own list, so a list whose first entry lives on another API left the endpoint red for no fault of the endpoint's.

The fix
---

The endpoint test now walks its list: on that word it asks the next model on the same endpoint, up to three in all. A model the vendor refuses by name on a list that serves it alone stays the endpoint's answer — there is no next model to try, so no red is papered over.

```diff
From 0f5273a8557a7d0f96db484e0a1438c1bb6198f8 Mon Sep 17 00:00:00 2001
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
#3766 reads) now sends the endpoint test down its own list: the next
model is asked on the same endpoint, up to three in all. A model the
vendor refuses by name on a list it serves alone stays the endpoint's
answer — no list to walk, so no red is papered over.

Fixes #3844

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/test.go      | 26 +++++++++++--
 internal/provider/test_test.go | 67 ++++++++++++++++++++++++++++++++++
 2 files changed, 90 insertions(+), 3 deletions(-)

diff --git a/internal/provider/test.go b/internal/provider/test.go
index a29178747..5f9eb3ed1 100644
--- a/internal/provider/test.go
+++ b/internal/provider/test.go
@@ -93,7 +93,22 @@ func (p Provider) Test(ctx context.Context) []Result {
 		}
 		url, body := tiny(q, proto, UpstreamName(p, model))
 		ctx, b := q.tested(ctx, body)
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
+			ctx, b := q.tested(ctx, body)
+			r = probe(ctx, q, proto, url, b, next, testWait)
+		}
+		out = append(out, r)
 	}
 	if len(out) == 0 && p.zenPublic() {
 		out = append(out, Result{Protocol: Chat, Error: zenPublicNone})
@@ -525,13 +540,15 @@ const zenPublicNone = "no free model of OpenCode Zen is listed for this API: the
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
 	public := q.zenPublic()
 	off := disabledNow() // a model the user disabled is never asked (#1867)
@@ -561,6 +578,9 @@ func (p Provider) testModel(q Provider, proto Protocol) string {
 				if public && !p.OpenCodeFree(m.ID) {
 					continue
 				}
+				if slices.Contains(except, m.ID) {
+					continue
+				}
 				if !p.DecidesModel(m.ID) && !off(p.ID, m.ID) && want(m.ID) && (k.Key == "" || p.Serves(k, m.ID)) {
 					return m.ID
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

git am applies it as is; SHA-256 first 16: `710f2c7183111cc5`

Verification
---

| check | result |
| --- | --- |
| RED on parent | `TestTestTriesTheNextModelOnTheEndpoint` fails: `chat stayed red ... otherAPI:true (asked [gpt-5.6-sol /v1/chat/completions gpt-5.6-sol /v1/responses])` — one model asked, endpoint red |
| GREEN | the same test ok: chat asked gpt-5.6-sol, then glm-4.6 on the same endpoint, and reads ✓; responses asked gpt-5.6-sol as before |
| the refusals stay | a list serving the turned-away model alone stays red, asked once — the vendor's word remains the answer (second half of the same test) |
| siblings | the #3766 tests (`TestTestModelsMovesToTheAPIServingIt` and the rest of the `TestTestModels*` family, `TestTestUsesEachEndpointsKey`, `TestModelTest`) all pass unchanged — the model-list path keeps its own move-to-the-serving-API shape, this only fills the no-model endpoint path |
| ablation | reverting `internal/provider/test.go` to the parent commit turns the new test red again |
| package full | `go test -tags nogui ./internal/provider/` ok |
| gofmt / vet / build | clean (`tr -d '\r'` judgement) |
| am gate | `git am -3` onto a clean tree at the current `upstream/main` applies as is |
| cost | at most three models per endpoint per test run, each on the vendor's own word that the one before is served elsewhere |

Not verified
---

No real relay was asked (the stand-in vendor speaks the report's own wording); `client`-scoped tests (`TestAs`) keep their model-list path and were not combined with this one.

AI use: the patch and its test were written with AI assistance; I've read the whole diff and the tests pass.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq ggbdpq@gmail.com.

Branch with the commit: fix/3844-endpoint-next-model (head 0f5273a8557a7d0f96db484e0a1438c1bb6198f8)
