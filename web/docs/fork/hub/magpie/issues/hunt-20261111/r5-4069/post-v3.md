Rework again, on today's `main` (`da169135a` — 868 commits past the base the 11-06 patch sat on). The tail guard still reads only the last turn's role, and a request ending on a tool's picture — Codex's `view_image` (Lxiny-zy's shape A), or an Anthropic `tool_result` holding an image block (zhangyang-crazy-one's Claude Code read) — still goes out as `user[functionResponse, inlineData]` and comes back 400. Of the three commits that touched the builder since, the one in this shape's field (`3d8510f32`) sends a tool's picture through `geminiInline` — a PNG still passes as `inlineData`, so the shape, and the refusal, stand.

The review's two points, held point by point:

1. *"`endsWithToolImages` 实际上等于「请求里有图就算」"* — the predicate is exactly option 1 now: the last turn must hold **both** a `functionResponse` and an `inlineData` beside it; the image-only disjunct is gone. A user's own picture carries no `functionResponse` and goes as it came — `TestGeminiUserImageLastTurnStaysAsItIs` locks shape D at both doors: contents stay one turn, unchanged, 200.
2. *"测试用的 fixture 不是真实的形状"* — no hand-built part: the tests post the reporters' own raw requests at the gateway's doors — table A's Responses `input` (a `function_call` for `view_image`, then a `function_call_output` whose `output` is an `input_image`, the request's last item) to `/v1/responses`, and the Claude Code `tool_result` case to `/v1/messages` — and the stub Vertex now refuses the mixed last turn as the A/B table measured, so on `main` both entries die with the reporters' own text; with the fix, the tool-image turn is kept whole and the guard's own `"Continue."` user turn ends the request.
3. The new function sits after `hasResponse`; that comment is whole again.

The Antigravity carve-out stays (`!ag`): a Claude model's `tool_result` turn keeps a tool's images on purpose, and `TestCodeAssistToolImagesAfterEveryResponse` still says so for both Antigravity shapes.

**Source**: the issue's own measurements — Lxiny-zy's A/B table (shapes A–D) and `buildVertex` dumps, zhangyang-crazy-one's real Vertex A/B through `/v1/messages`, and the review's standing spec (option 1's predicate, the real-shape fixture, shape D untouched, the Claude Code entry).

**Verification**

| Check | Result |
| --- | --- |
| RED on the parent (`da169135a` + the tests alone) | both entries 400 `Google Vertex AI: Requests ending with a model turn are not supported.` — the stub refusing the mixed last turn as the A/B table measured |
| GREEN with the fix | both entries 200, four turns: the tool-image turn kept whole (`functionResponse` + `inlineData`), then the guard's own user turn (`Continue.`) |
| Shape D, a user's own picture (both doors) | 200 on parent and fix alike — contents stay one turn, unchanged |
| Ablation (`codeassist.go` back at the parent, tests kept) | red, the same 400 verbatim; restored (`git status` clean), green |
| The mixed-turn family (`TestGeminiContentsNeverEndWithModel`, `TestVertexNeverAskedEndingWithModel`, `TestGeminiToolResponseTurnHoldsNoText`, `TestCodeAssistToolImagesAfterEveryResponse`) | green `-count=1`; green with the new pair under `-race` |
| `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1`, the shipping tree | 918 s, one failure: `TestKeyLimitReservationsStayInTheirWindow` — red the same on the parent `da169135a` with nothing of this patch in the tree (3/3 runs, its fake-clock window assert), a red `main` already carries |
| `gofmt -l` / `go vet -tags nogui` / `go build -tags nogui ./...` (darwin and GOOS=linux) | clean / clean / ok, both |

**Siblings**

- `buildGemini` (Gemini's own API, Factory) builds through `buildCodeAssistSent`, so the same guard covers that route.
- jiasongji's gcp-ai plugin path (`@ai-sdk/google`) doesn't go through `codeassist.go` — that one is tracked at magpie-community/plugins#734.
- Touched nothing else. Two near shapes left as they are for having no reporter's evidence: since `3d8510f32` a tool image Gemini can't read becomes a text note that keeps its `toolImage` mark, so it stays beside its `functionResponse` (#1533's mixed shape) instead of an `inlineData`; and a tool image named by URL goes as `fileData`, which the predicate doesn't read. The predicate covers exactly the shape the reports measured.

**When the read fails**

Parts that don't read as parts read as none: the guard doesn't fire and the request goes as it does today.

**Not verified:** no Vertex AI account here — the fix is proven at the builder seam with the reporters' request shapes as fixtures; the real endpoint's answer to the new trailing user turn is shape B's (200, image read), which the A/B table already measured.

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch details**: `gateway: a tool's image can't be the last turn Google is asked (#4069)` — one commit on `da169135a`; `git am` takes the patch below as is; SHA-256 (first 16) of the patch file: `f9ea41271c826533`.

**Branch with the commit**: [hunt-20261111-r5-4069](https://github.com/ggbdpq/magpie/tree/hunt-20261111-r5-4069) (head `6af80e41a8cbd8101d1c0ed96e4ec48af59f4f3f`).

<details><summary>patch: gateway: a tool's image can't be the last turn Google is asked (#4069)</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 22:17:02 +0800
Subject: [PATCH] gateway: a tool's image can't be the last turn Google is
 asked (#4069)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Codex's view_image put the tool's picture in the request's last turn —
a functionResponse with an inlineData beside it — and Vertex AI answered
every retry with "Requests ending with a model turn are not supported":
Google's words for a turn it can't answer however the roles say, its
#1533 mixed-turn refusal wearing that message. The guard that adds a
user turn read only the role, and the role said user.

endsWithToolImages joins it: the last turn mixing a functionResponse
with a tool's image gets the same user turn after it, the guard's own
ask — a shape Gemini CLI never makes (its tool results keep text and
images apart), a Codex one that can. A user's own picture carries no
functionResponse and goes as it came; a Claude model's on Antigravity
keeps a tool's images in its tool_result turn on purpose, and is
carved out.

The tests come in the way the reporters' did: Codex's input_image as
the last Responses item, and an Anthropic tool_result holding an image
block, both at the gateway's own doors, red on main; a user's own
picture keeps its contents as they are.

Fixes #4069

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codeassist.go             | 33 +++++++-
 internal/gateway/gemini_model_last_test.go | 95 +++++++++++++++++++++-
 2 files changed, 123 insertions(+), 5 deletions(-)

diff --git a/internal/gateway/codeassist.go b/internal/gateway/codeassist.go
index e535c4512..f8bfa8066 100644
--- a/internal/gateway/codeassist.go
+++ b/internal/gateway/codeassist.go
@@ -528,11 +528,19 @@ func buildCodeAssistSent(r *Request, sent, agent string) []byte {
 		// this user turn before it, and so does this.
 		contents = append([]map[string]any{{"role": "user", "parts": []map[string]any{{"text": "[Continuing from previous AI thoughts...]"}}}}, contents...)
 	}
-	if n := len(contents); n > 0 && contents[n-1]["role"] == "model" {
+	n := len(contents)
+	if n > 0 && (contents[n-1]["role"] == "model" || (!ag && endsWithToolImages(contents[n-1]))) {
 		// nor one that ends with it: "Requests ending with a model turn
 		// are not supported" on Vertex AI, Code Assist and Antigravity
-		// alike (yycsyu: Codex compacting on gemini-3.8-flash). A user
-		// turn goes after it, as Gemini CLI keeps its history ending
+		// alike (yycsyu: Codex compacting on gemini-3.8-flash) — and
+		// Google answers a request whose last turn mixes a
+		// functionResponse with a tool's image beside it the same words,
+		// its own text for a turn it can't answer however the roles say
+		// (#1533's mixed-turn refusal wearing that message, #4069: Codex's
+		// view_image as the request's last item, zhangyang-crazy-one's
+		// Claude Code read; no Claude model's on Antigravity, whose
+		// tool_result turn holds the images on purpose). A user turn goes
+		// after it, as Gemini CLI keeps its history ending
 		contents = append(contents, map[string]any{"role": "user", "parts": []map[string]any{{"text": modelLastAsk(r)}}})
 	}
 	req := map[string]any{"contents": contents}
@@ -1780,6 +1788,25 @@ func hasResponse(parts []map[string]any) bool {
 	return false
 }
 
+// endsWithToolImages says whether a turn mixes a tool's functionResponse
+// with an image beside it: Google answers a request ending on that turn
+// with its "ending with a model turn" words however the roles say (#4069,
+// as #1533's mixed turn). A user's own picture carries no
+// functionResponse and is not the turn.
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
+	return resp && image
+}
+
 // antigravityRound is ask, a round of magpie's own search for p, told as
 // the refusal it is when Antigravity turns the system prompt away: its 429
 // or the reply's own error event gets the hint, and the attempt is marked
diff --git a/internal/gateway/gemini_model_last_test.go b/internal/gateway/gemini_model_last_test.go
index ffe4958c3..c0a190eee 100644
--- a/internal/gateway/gemini_model_last_test.go
+++ b/internal/gateway/gemini_model_last_test.go
@@ -186,7 +186,10 @@ const issue1533 = `{
 
 // vertexTurnsAway answers as Vertex AI answered #1533: 400 vertexModelLast
 // to contents ending with the model's turn, and to a user turn mixing a
-// tool's functionResponse with text, which it takes as two turns.
+// tool's functionResponse with text, which it takes as two turns. A request
+// ending on a turn mixing a functionResponse with an image gets the same
+// words however the role says (#4069: Lxiny-zy's shape A and their A/B
+// table, zhangyang-crazy-one's Claude Code read).
 func vertexTurnsAway(_ int, body map[string]any) (int, string) {
 	contents, _ := body["contents"].([]any)
 	for i, c := range contents {
@@ -195,15 +198,19 @@ func vertexTurnsAway(_ int, body map[string]any) (int, string) {
 			return http.StatusBadRequest, vertexModelLast
 		}
 		parts, _ := turn["parts"].([]any)
-		response, text := false, false
+		response, text, image := false, false, false
 		for _, p := range parts {
 			part, _ := p.(map[string]any)
 			response = response || part["functionResponse"] != nil
 			text = text || part["text"] != nil
+			image = image || part["inlineData"] != nil
 		}
 		if response && text {
 			return http.StatusBadRequest, vertexModelLast
 		}
+		if i == len(contents)-1 && response && image {
+			return http.StatusBadRequest, vertexModelLast
+		}
 	}
 	return http.StatusOK, vertexPong
 }
@@ -255,3 +262,87 @@ func TestGeminiToolResponseTurnHoldsNoText(t *testing.T) {
 		}
 	}
 }
+
+// A tool's image as the request's last item — Codex's view_image, its
+// input_image the last Responses item (Lxiny-zy's shape A), or an
+// Anthropic client's tool_result holding an image block and nothing after
+// (zhangyang-crazy-one's Claude Code read) — reaches Vertex AI as a turn
+// mixing a functionResponse with an inlineData, and Google answers it with
+// its "ending with a model turn" words however the roles say: the turn
+// died five tries in a row (#4069). A user turn goes after it, as for a
+// model turn. The requests come in the way their reporters' did, at the
+// gateway's own doors.
+func TestGeminiToolImageLastTurnGetsAUserTurn(t *testing.T) {
+	v := &vertexUp{}
+	v.reply = vertexTurnsAway
+	s := vertexServe(t, v, vertexLevels)
+	for _, c := range []struct{ name, path, body string }{
+		{"codex's view_image", "/v1/responses", `{"model":"google-vertex/gemini-3.8-flash","stream":true,"input":[
+			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
+			{"type":"function_call","name":"view_image","call_id":"c1","arguments":"{\"path\":\"a.png\"}"},
+			{"type":"function_call_output","call_id":"c1","output":[{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgo="}]}]}`},
+		{"claude code's read", "/v1/messages", `{"model":"google-vertex/gemini-3.8-flash","max_tokens":64,"stream":true,
+			"tools":[{"name":"Read","input_schema":{"type":"object","properties":{"file_path":{"type":"string"}}}}],"messages":[
+			{"role":"user","content":"Look at the image at /tmp/a.png."},
+			{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/tmp/a.png"}}]},
+			{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}]}]}`},
+	} {
+		rec := vertexPost(s, c.path, c.body)
+		if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "model turn") {
+			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body.String())
+			continue
+		}
+		var q struct {
+			Contents []struct {
+				Role  string           `json:"role"`
+				Parts []map[string]any `json:"parts"`
+			} `json:"contents"`
+		}
+		b, _ := json.Marshal(v.last(t).body["contents"])
+		if err := json.Unmarshal(b, &q.Contents); err != nil {
+			t.Fatal(err)
+		}
+		if len(q.Contents) != 4 {
+			t.Errorf("%s: want the tool-image turn answered with a user turn, got %s", c.name, b)
+			continue
+		}
+		tools, ask := q.Contents[2], q.Contents[3]
+		if tools.Role != "user" || len(tools.Parts) != 2 || tools.Parts[0]["functionResponse"] == nil || tools.Parts[1]["inlineData"] == nil {
+			t.Errorf("%s: the tool-image turn is %v", c.name, tools)
+		}
+		if ask.Role != "user" || len(ask.Parts) != 1 || ask.Parts[0]["text"] != continueText {
+			t.Errorf("%s: the turn after the tool's image is %v", c.name, ask)
+		}
+	}
+}
+
+// A user's own picture — a Responses message's input_image, or an
+// Anthropic message's image block, no tool call beside it — is not a
+// tool's image: Google answers it as it is (Lxiny-zy's shape D, a 200),
+// and the request goes to it unchanged, no user turn put after.
+func TestGeminiUserImageLastTurnStaysAsItIs(t *testing.T) {
+	v := &vertexUp{}
+	v.reply = vertexTurnsAway
+	s := vertexServe(t, v, vertexLevels)
+	for _, c := range []struct{ name, path, body string }{
+		{"a responses message's image", "/v1/responses", `{"model":"google-vertex/gemini-3.8-flash","stream":true,"input":[
+			{"type":"message","role":"user","content":[{"type":"input_text","text":"what colour is it"},{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgo="}]}]}`},
+		{"an anthropic message's image", "/v1/messages", `{"model":"google-vertex/gemini-3.8-flash","max_tokens":64,"stream":true,"messages":[
+			{"role":"user","content":[{"type":"text","text":"what colour is it"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}]}`},
+	} {
+		rec := vertexPost(s, c.path, c.body)
+		if rec.Code != http.StatusOK {
+			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body.String())
+			continue
+		}
+		contents, _ := v.last(t).body["contents"].([]any)
+		if len(contents) != 1 {
+			t.Errorf("%s: the user's own picture had the conversation rewritten: %s", c.name, contents)
+			continue
+		}
+		turn, _ := contents[0].(map[string]any)
+		if turn["role"] != "user" {
+			t.Errorf("%s: the picture's turn is %v", c.name, turn)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)


```

</details>
