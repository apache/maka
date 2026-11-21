**What's wrong**

Your four shapes and the `buildVertex` dumps are the whole case: the guard that adds a user turn (`codeassist.go`) read only the **role** of the last turn, and a tool's image turn ends the request as a `user` — so no guard fired, and Google answered with its words for a turn it can't answer. Credit @Lxiny-zy for the A/B table, the dump, and the #1533 connection — that link is what made the fix one line deep.

**Root cause**

Two refusals wear the same message. #1533's is a turn **mixing** a functionResponse with text; yours is the request **ending** on a turn that mixes a functionResponse with an image (`inlineData` beside it) — and after the mixed-turn split puts the image in its own turn, it's the request ending on that image-only turn. Both are shapes Google answers with "Requests ending with a model turn are not supported", whatever the roles say. The existing guard caught only `role == "model"`.

**The fix** (2 files, +69/−2)

`endsWithToolImages` joins the guard: a turn mixing a functionResponse with an image, **or** an image-only turn (what the split leaves behind), gets the same user turn after it (`modelLastAsk`) — the reply the guard's own ask makes. The Antigravity Claude path is carved out (`!ag`): it keeps a tool's images in its response turn on purpose (the tool_result turn Anthropic reads them as, the branch's own comment), and its tests say so.

**Verification**

| Check | Result |
| --- | --- |
| New `TestGeminiToolImageLastTurnGetsAUserTurn` (your shape A: function_call → function_call_output with an image, nothing after) | red on the parent `df7c94bdf` — `the tool-image turn is still the last: [inlineData] role:user`; ok with the fix (the last turn is the guard's text ask) |
| The mixed-turn family (`TestGeminiContentsNeverEndWithModel`, `TestGeminiFunctionResponseImage*` ×3, `TestCodeAssistToolImagesAfterEveryResponse` — the Antigravity carve-out's own test) | ok |
| Ablation (codeassist.go back at the parent, tests kept) | red, same message |
| `go test -tags nogui ./internal/gateway/` full package | **ok, 615.3s, 0 failures** — this after the first cut had 3 reds (the un-narrowed guard broke the Antigravity expectations), fixed by the carve-out |
| `-race`, `gofmt -l`, `go vet -tags nogui`, `go build ./...` | ok / clean / clean (the dockflap cgo warning is #4821's, as on main) / ok |

<details><summary>patch: gateway: a tool's image can't be the last turn Google is asked (#4069) — git am applies it as is; SHA-256 first 16: 2bdfd48f1c822ea3</summary>

```patch
From f10443d26abaeec2686f66eb0d458b5d33be8b35 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 08:54:01 +0800
Subject: [PATCH] gateway: a tool's image can't be the last turn Google is
 asked (#4069)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Codex's view_image put the tool's picture in the request's last turn —
a functionResponse with an inlineData beside it — and Vertex AI answered
every retry with "Requests ending with a model turn are not supported":
Google's words for a turn it can't answer, its #1533 mixed-turn refusal
wearing that message. The guard that adds a user turn read only the
role, and the role said user.

endsWithToolImages joins it: a turn carrying a functionResponse and an
image beside it gets the same user turn after it, the guard's own ask —
a shape Gemini CLI never makes (its tool results keep text and images
apart), a Codex one that can.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codeassist.go             | 33 +++++++++++++++++--
 internal/gateway/gemini_model_last_test.go | 38 ++++++++++++++++++++++
 2 files changed, 69 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/codeassist.go b/internal/gateway/codeassist.go
index 82102026b..dc2c4011a 100644
--- a/internal/gateway/codeassist.go
+++ b/internal/gateway/codeassist.go
@@ -489,10 +489,20 @@ func buildCodeAssistSent(r *Request, sent, agent string) []byte {
 		// this user turn before it, and so does this.
 		contents = append([]map[string]any{{"role": "user", "parts": []map[string]any{{"text": "[Continuing from previous AI thoughts...]"}}}}, contents...)
 	}
-	if n := len(contents); n > 0 && contents[n-1]["role"] == "model" {
+	// an Antigravity Claude keeps a tool's images in its response turn
+	// (the tool_result turn Anthropic reads them as) and answers it; the
+	// mixed-turn refusal is the Gemini-API readers' (Vertex AI, Gemini's
+	// own, Code Assist for a Gemini model).
+	n := len(contents)
+	mixedLast := !ag && n > 0 && endsWithToolImages(contents[n-1])
+	if n > 0 && (contents[n-1]["role"] == "model" || mixedLast) {
 		// nor one that ends with it: "Requests ending with a model turn
 		// are not supported" on Vertex AI, Code Assist and Antigravity
-		// alike (yycsyu: Codex compacting on gemini-3.8-flash). A user
+		// alike (yycsyu: Codex compacting on gemini-3.8-flash) — and
+		// Google answers a request whose last turn mixes a
+		// functionResponse with an image the same words, its own text
+		// for "this isn't a turn it can answer" (#1533's mixed-turn
+		// refusal, #4069: Codex's view_image as the last item). A user
 		// turn goes after it, as Gemini CLI keeps its history ending
 		contents = append(contents, map[string]any{"role": "user", "parts": []map[string]any{{"text": modelLastAsk(r)}}})
 	}
@@ -1719,6 +1729,25 @@ func stopFromGemini(s string) string {
 }
 
 // hasResponse says whether a Gemini turn's parts hold a tool's response.
+// endsWithToolImages says whether the turn is one Google answers with its
+// "ending with a model turn" words however the request ends: a turn
+// mixing a functionResponse with an image (#1533's refusal), or one that
+// is an image alone — what a tool's picture becomes once the mixed turn
+// is split (#4069: Codex's view_image as the last item).
+func endsWithToolImages(turn map[string]any) bool {
+	ps, _ := turn["parts"].([]map[string]any)
+	resp, image := false, false
+	for _, p := range ps {
+		if p["functionResponse"] != nil {
+			resp = true
+		}
+		if p["inlineData"] != nil {
+			image = true
+		}
+	}
+	return resp && image || image && !resp
+}
+
 func hasResponse(parts []map[string]any) bool {
 	for _, p := range parts {
 		if p["functionResponse"] != nil {
diff --git a/internal/gateway/gemini_model_last_test.go b/internal/gateway/gemini_model_last_test.go
index ffe4958c3..d086ce416 100644
--- a/internal/gateway/gemini_model_last_test.go
+++ b/internal/gateway/gemini_model_last_test.go
@@ -255,3 +255,41 @@ func TestGeminiToolResponseTurnHoldsNoText(t *testing.T) {
 		}
 	}
 }
+
+// An image a tool returned, as the request's last item: Google answers
+// the mixed last turn (a functionResponse with an inlineData beside it)
+// with its "ending with a model turn" words — #1533's mixed-turn refusal
+// wearing that message — so Codex's view_image died five tries in a row
+// and the turn with it (#4069). A user turn goes after it, as for a model
+// turn; a text tool result needs none (its turn is one Google answers).
+func TestGeminiToolImageLastTurnGetsAUserTurn(t *testing.T) {
+	r := &Request{
+		System: "test",
+		Messages: []Message{
+			{Role: "user", Parts: []Part{{Kind: Text, Text: "look at it"}}},
+			{Role: "assistant", Parts: []Part{{Kind: ToolCall, CallID: "call_1", Name: "view_image", Text: `{"path":"x.png"}`}}},
+			{Role: "user", Parts: []Part{
+				{Kind: ToolResult, CallID: "call_1", Text: "image result"},
+				{Kind: Image, MediaType: "image/png", Data: "pngbytes"},
+			}},
+		},
+	}
+	b, err := buildVertex(r, "gemini-4-argon")
+	if err != nil {
+		t.Fatal(err)
+	}
+	var q map[string]any
+	json.Unmarshal(b, &q)
+	cs := q["contents"].([]any)
+	last := cs[len(cs)-1].(map[string]any)
+	if last["role"] != "user" {
+		t.Fatalf("last turn %v", last["role"])
+	}
+	for _, p := range last["parts"].([]any) {
+		part := p.(map[string]any)
+		if txt, _ := part["text"].(string); txt != "" {
+			return // the guard's own ask, nothing of the tool's turn
+		}
+	}
+	t.Fatalf("the tool-image turn is still the last: %s", cs[len(cs)-1])
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [fix/4166-thinking-stream-group](https://github.com/ggbdpq/magpie/tree/fix/4166-thinking-stream-group) (head `f10443d26abaeec2686f66eb0d458b5d33be8b35` — carries this and the #4166 prototype/revert pair; `git am` takes the patch above as is).

**Not verified:** no Vertex AI account here — the fix is proven at the builder seam with your four shapes as fixtures; the real endpoint's answer to the new trailing user turn is your shape B's (200, image read), which your table already measured.

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

