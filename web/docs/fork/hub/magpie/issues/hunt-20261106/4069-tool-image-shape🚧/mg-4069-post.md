Rework per @yetone's review

Both points taken:

1. *"`endsWithToolImages` 实际上等于「请求里有图就算」"* — the predicate had an image-only disjunct, so a user's own picture (Lxiny-zy's shape D, a 200) got a "Continue." turn appended.
2. *"测试用的 fixture 不是真实的形状"* — the tests hand-built a `Kind: Image` part, where Codex's `view_image` image really arrives as `ToolResult.Images` (`function_call_output`'s `input_image`, as `responses.go`'s `toolOutput` parses it).

**The rework** (same 2 files, +110/−3)

- The predicate is now exactly Lxiny-zy's option 1: the last turn must hold **both** a `functionResponse` and an `inlineData` beside it — the mixed turn Google answers with its "ending with a model turn" words however the roles say (#1533's refusal wearing that message, #4069). The image-only disjunct is gone: a user's own picture carries no `functionResponse` and goes as it came. The Antigravity carve-out stays (`!ag`): a Claude model's `tool_result` turn keeps a tool's images on purpose, and `TestCodeAssistToolImagesAfterEveryResponse` still says so.
- The fixtures come in the way the reporters' did, at the gateway's own doors. `TestGeminiToolImageLastTurnGetsAUserTurn` posts Lxiny-zy's table A as a raw Responses `input` (a `function_call` for `view_image`, then a `function_call_output` whose `output` is an `input_image`, the request's last item) to `/v1/responses`, and zhangyang-crazy-one's Claude Code case (a `tool_result` whose content is an image block) to `/v1/messages` — the entry your closing paragraph asked for. Both are red on the parent with the tests alone, and both assert the outbound contents end on the guard's own `"Continue."` user turn with the tool-image turn kept whole before it. `TestGeminiUserImageLastTurnStaysAsItIs` asserts shape D keeps its contents as they are, one turn, at both entries.
- `endsWithToolImages` moved after `hasResponse`, whose doc comment is whole again.

<details><summary>patch: gateway: a tool's image can't be the last turn Google is asked (#4069) — git am applies it as is; SHA-256 first 16: d6b0793b28d446c1</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 21:10:36 +0800
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
 internal/gateway/codeassist.go             | 32 ++++++++-
 internal/gateway/gemini_model_last_test.go | 81 ++++++++++++++++++++++
 2 files changed, 110 insertions(+), 3 deletions(-)

diff --git a/internal/gateway/codeassist.go b/internal/gateway/codeassist.go
index 808923ff0..c997859f4 100644
--- a/internal/gateway/codeassist.go
+++ b/internal/gateway/codeassist.go
@@ -495,11 +495,18 @@ func buildCodeAssistSent(r *Request, sent, agent string) []byte {
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
+		// alike (yycsyu: Codex compacting on gemini-3.8-flash) — nor one
+		// whose last turn mixes a functionResponse with a tool's image
+		// beside it, Google's words for a turn it can't answer however
+		// the roles say (#1533's mixed-turn refusal, #4069: Codex's
+		// view_image as the request's last item; no Claude model's on
+		// Antigravity, whose tool_result turn holds the images on
+		// purpose). A user turn goes after it, as Gemini CLI keeps its
+		// history ending
 		contents = append(contents, map[string]any{"role": "user", "parts": []map[string]any{{"text": modelLastAsk(r)}}})
 	}
 	req := map[string]any{"contents": contents}
@@ -1747,6 +1754,25 @@ func hasResponse(parts []map[string]any) bool {
 	return false
 }
 
+// endsWithToolImages says whether a turn mixes a tool's functionResponse
+// with an image beside it: Google answers a request ending on that shape
+// with its "ending with a model turn" words however the roles say (#4069,
+// as #1533's mixed turn). A user's own picture carries no functionResponse
+// and is not the shape.
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
index ffe4958c3..5dfb88899 100644
--- a/internal/gateway/gemini_model_last_test.go
+++ b/internal/gateway/gemini_model_last_test.go
@@ -255,3 +255,84 @@ func TestGeminiToolResponseTurnHoldsNoText(t *testing.T) {
 		}
 	}
 }
+
+// A tool's image as the request's last item — Codex's view_image, its
+// input_image the last Responses item, or an Anthropic client's
+// tool_result holding an image block (#4069, zhangyang-crazy-one's Claude
+// Code case): Google answers the mixed last turn, a functionResponse with
+// an inlineData beside it, with its "ending with a model turn" words
+// however the roles say, and the turn died with it. A user turn goes
+// after it, as for a model turn. The requests come in the way their
+// reporters' did, at the gateway's own doors.
+func TestGeminiToolImageLastTurnGetsAUserTurn(t *testing.T) {
+	v := &vertexUp{}
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

**Branch with the commit**: [fix/4069-tool-image-shape](https://github.com/ggbdpq/magpie/tree/fix/4069-tool-image-shape) (head `7aac551d6e4787d8c94fcf946122dab61cc6ca86`, based on upstream/main `06c4582cc`; `git am` takes the patch above as is — verified on that tip and on today's `2000ae439`).

**Verification**

| Check | Result |
| --- | --- |
| **Not verified:** no Vertex AI account here | the fix is proven at the builder seam, the gateway's own doors, with the reporters' request shapes as fixtures; the real endpoint's answer to the new trailing user turn is shape B's (200, image read), which Lxiny-zy's A/B table already measured |
| RED on the parent (`06c4582cc` + the tests alone) | `TestGeminiToolImageLastTurnGetsAUserTurn` red at both entries, the captured Vertex-bound contents ending `user[text] model[functionCall] user[functionResponse, inlineData]` — table A's dump verbatim |
| GREEN with the fix | both entries 4 turns: the tool-image turn kept whole (`functionResponse` + `inlineData`), then the guard's own user turn (`Continue.`); `TestGeminiUserImageLastTurnStaysAsItIs` green on parent and fix — contents stay one turn, unchanged |
| Ablation (shipping tree `7aac551d6`, the guard's disjunct out, tests kept) | red, same test; restored (`git status` clean), green |
| The mixed-turn family (`TestGeminiContentsNeverEndWithModel`, `TestGeminiToolResponseTurnHoldsNoText`, `TestCodeAssistToolImagesAfterEveryResponse`, `TestVertexNeverAskedEndingWithModel`) | green `-count=1`; green with the new pair under `-race` |
| `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1`, the shipping tree | ok, 775.4s, 0 failures (the same content one commit earlier, `4477cb077`: ok, 784.4s) |
| `gofmt -l` / `go vet -tags nogui` (darwin, GOOS=linux) / `go build -tags nogui ./...` | clean / clean (the dockflap cgo warning is #4821's, as on main) / ok; GOOS=linux without nogui still fails in wails (`undefined: pointer`), pre-existing |
| Rebase | `4477cb077` → `7aac551d6` on `06c4582cc`, `git range-diff` `=` — zero drift |
| Sibling rg | `endsWithToolImages`: the one caller is the guard; `hasResponse`'s other callers (the per-turn split, the turn merge, `pairFunctionTurns`) all run before the tail guard and are unchanged; `modelLastAsk`'s only caller is the guard's own append; the head guard (`contents[0]`) and the Chat-wire tail checks (`chattidy.go`, `chat.go`) don't read Gemini contents — untouched |

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
