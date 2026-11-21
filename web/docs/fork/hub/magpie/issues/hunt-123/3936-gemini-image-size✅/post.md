Found by @yinwu01 — thanks for the exact map of the three draw paths. This fixes the two that speak Gemini natively; chat completions is left alone, reason below.

**What's wrong**

An `/v1/images/generations` or `/v1/images/edits` request (and the image MCP tool, which goes through the same entry) for a Gemini image model had its OpenAI `size` folded into an aspect ratio alone, so the model drew at its default 1K and no size above 1K could be asked: `size: "4096x4096"` drew at 1K.

**Root cause** (at upstream/main e17b6cefc)

- `internal/gateway/draw.go:1875` (drawGemini): `cfg["imageConfig"]` carries `aspectRatio` only, never an `imageSize`.
- `internal/gateway/draw.go:1951` (drawCodeAssist): the request carries no `imageConfig` at all — the ratio reaches the model only as words in the prompt (drawPrompt).

**The fix**

Both paths now build the imageConfig an images API size asks a Gemini image model for (`imageConfigOf`, beside `aspectOf` in draw.go): the ratio the size is nearest, with an `imageSize` beside it when the size asks past the model's 1K default — the smallest of Gemini's buckets whose long side covers the size asked (1536x1024 → 2K, 4096x4096 → 4K). The bucket mapping is magpie's choice as the issue says; the proposal here is the smallest covering bucket, floored at the default: only 2K and 4K go out, because a size at or under 1K is drawn at anyway and `imageSize` isn't every image model's (Vertex lists 1K/2K/4K), so nothing is asked for what the default gives — the common 1024x1024 ask keeps today's behavior byte for byte. drawCodeAssist carries it in `Request.ImageConfig`, the field a Gemini client's own imageConfig arrives in, which Code Assist's envelope already forwards (#3820).

```diff
diff --git a/internal/gateway/draw.go b/internal/gateway/draw.go
--- a/internal/gateway/draw.go
+++ b/internal/gateway/draw.go
@@ -1872,8 +1872,8 @@ func (s *Server) drawGemini(ctx context.Context, p provider.Provider, model stri
 		parts = append(parts, map[string]any{"inlineData": map[string]string{"mimeType": pic.Mime, "data": base64.StdEncoding.EncodeToString(pic.Data)}})
 	}
 	cfg := map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}}
-	if r := aspectOf(d.Size); r != "" {
-		cfg["imageConfig"] = map[string]string{"aspectRatio": r}
+	if c := imageConfigOf(d.Size); c != nil {
+		cfg["imageConfig"] = c
 	}
 	body, _ := json.Marshal(map[string]any{"contents": []map[string]any{{"role": "user", "parts": parts}}, "generationConfig": cfg})
@@ -1949,6 +1949,13 @@ func (s *Server) drawCodeAssist(ctx context.Context, p provider.Provider, model
 		parts = append(parts, Part{Kind: Image, MediaType: pic.Mime, Data: base64.StdEncoding.EncodeToString(pic.Data)})
 	}
 	req := &Request{Messages: []Message{{Role: "user", Parts: parts}}, draws: true}
+	if c := imageConfigOf(d.Size); c != nil {
+		// the size and shape the images API asked, in the field a Gemini
+		// client's own imageConfig arrives in, which buildCodeAssistSent
+		// puts in generationConfig
+		b, _ := json.Marshal(c)
+		req.ImageConfig = b
+	}
 	return s.eachDrawing(d.N, func() (drawn, int, error) {
@@ -2031,6 +2038,49 @@ func aspectOf(size string) string {
 	return aspectAmong(size, []string{"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"})
 }
 
+// imageSizeOf is the Gemini imageSize bucket an images API size asks for:
+// the smallest whose long side covers the size asked, and "" when there is
+// nothing to ask. Only 2K and 4K go out: a size at or under the model's 1K
+// default is drawn at anyway, and imageSize isn't every image model's
+// (Vertex lists 1K, 2K, 4K), so the buckets under 1K aren't asked for what
+// the default already gives. A ratio given as one ("16:9") says nothing in
+// pixels, and is "" too.
+func imageSizeOf(size string) string {
+	w, h, ok := strings.Cut(strings.ToLower(strings.TrimSpace(size)), "x")
+	if !ok {
+		return ""
+	}
+	x, err1 := strconv.ParseFloat(w, 64)
+	y, err2 := strconv.ParseFloat(h, 64)
+	if err1 != nil || err2 != nil || x <= 0 || y <= 0 {
+		return ""
+	}
+	switch m := math.Max(x, y); {
+	case m > 2048:
+		return "4K"
+	case m > 1024:
+		return "2K"
+	}
+	return ""
+}
+
+// imageConfigOf is the imageConfig an images API size asks a Gemini image
+// model to draw at: the ratio the size is nearest, with the imageSize
+// beside it when the size asks past the model's 1K default. nil for none.
+func imageConfigOf(size string) map[string]string {
+	c := map[string]string{}
+	if r := aspectOf(size); r != "" {
+		c["aspectRatio"] = r
+	}
+	if s := imageSizeOf(size); s != "" {
+		c["imageSize"] = s
+	}
+	if len(c) == 0 {
+		return nil
+	}
+	return c
+}
```

Sibling faces checked, changed or not: drawGemini and drawCodeAssist changed (the two Gemini-speaking paths); drawChat left as it is — OpenRouter's chat `image_config` documents an `aspect_ratio` only (its API reference types the rest as provider-specific keys; a size field there is still an open feature request), so an undocumented field risks a strict relay's refusal for every chat-drawn model; drawPrompt keeps saying the ratio in words, as it already does for drawGemini alongside its imageConfig; the Grok Imagine path has no size field by design (its test locks that); the video paths' aspectAmong uses are out of scope; the images-API paths (viaImages) already pass `size` through untouched. The MCP image tool is covered without its own change — it draws through the same images API entry.

**Verification**

| Check | Result |
|---|---|
| RED before the fix: both new tests | fail — drawGemini sent `{"aspectRatio":"1:1"}` for 4096x4096, Code Assist sent no imageConfig |
| Ablation: draw.go reverted to the branch parent, tests kept | both red again, each at the missing imageSize |
| Targeted, -count=1: the two new tests + sibling faces (TestGeminiImageConfig*, TestAspectOf, TestAspectAmong, chat-draws, OpenRouter images API, Grok draws, Antigravity draws) | ok |
| Full package: `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/` | ok (631s, zero failures) |
| race on the draw + Code Assist config tests | ok |
| gofmt (CRLF-stripped) / go vet / go build ./... | clean / clean / ok (pre-existing dockflap cgo warning only) |

**Not verified**: the buckets against live Google and Antigravity back-ends — this machine has no credentials for either, so the tests pin what magpie sends (fake upstreams), and the wire shape follows the issue and the field a Gemini client's own imageConfig already takes (#3820). Not verified live, too, whether a model without `imageSize` tolerates the field; that risk is why nothing under 2K is sent. One AI use: written with AI, reviewed and tested by a human, per the Attribution below.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq ggbdpq@gmail.com.

<details>
<summary>Patch (git am)</summary>

```text
From f3afe1720f1d7ff7535178be14fd3300aaa8d234 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 10:51:07 +0800
Subject: [PATCH] gateway: an images API size asks a Gemini image model past
 its 1K

An images API request (and the image MCP tool, which goes through it)
for a Gemini image model had its OpenAI size folded into an aspect
ratio alone, so the model drew at its default 1K and no size above 1K
could be asked (#3936): drawGemini sent generationConfig.imageConfig
without an imageSize, and drawCodeAssist sent no imageConfig at all.

Both now build the imageConfig an images API size asks a Gemini image
model for: the ratio the size is nearest, with an imageSize beside it
when the size asks past the model's 1K default - the smallest of
Gemini's buckets whose long side covers the size asked (2048 -> 2K,
4096x4096 -> 4K). Only 2K and 4K go out: a size at or under the 1K
default is drawn at anyway, and imageSize isn't every image model's
(Vertex lists 1K, 2K, 4K), so nothing is asked for what the default
gives. drawCodeAssist carries it in Request.ImageConfig, the field a
Gemini client's own imageConfig arrives in, which Code Assist's
envelope already forwards.

Chat completions is left as it is: OpenRouter's image_config documents
an aspect_ratio only, and an undocumented field risks a strict relay's
refusal.

Fixes #3936

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/draw.go                   | 54 +++++++++++-
 internal/gateway/gemini_image_size_test.go | 99 ++++++++++++++++++++++
 2 files changed, 151 insertions(+), 2 deletions(-)
 create mode 100644 internal/gateway/gemini_image_size_test.go

diff --git a/internal/gateway/draw.go b/internal/gateway/draw.go
index c116697fb..6069a4530 100644
--- a/internal/gateway/draw.go
+++ b/internal/gateway/draw.go
@@ -1872,8 +1872,8 @@ func (s *Server) drawGemini(ctx context.Context, p provider.Provider, model stri
 		parts = append(parts, map[string]any{"inlineData": map[string]string{"mimeType": pic.Mime, "data": base64.StdEncoding.EncodeToString(pic.Data)}})
 	}
 	cfg := map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}}
-	if r := aspectOf(d.Size); r != "" {
-		cfg["imageConfig"] = map[string]string{"aspectRatio": r}
+	if c := imageConfigOf(d.Size); c != nil {
+		cfg["imageConfig"] = c
 	}
 	body, _ := json.Marshal(map[string]any{"contents": []map[string]any{{"role": "user", "parts": parts}}, "generationConfig": cfg})
 	base := strings.TrimSuffix(strings.TrimRight(p.Base(provider.Chat), "/"), "/openai")
@@ -1949,6 +1949,13 @@ func (s *Server) drawCodeAssist(ctx context.Context, p provider.Provider, model
 		parts = append(parts, Part{Kind: Image, MediaType: pic.Mime, Data: base64.StdEncoding.EncodeToString(pic.Data)})
 	}
 	req := &Request{Messages: []Message{{Role: "user", Parts: parts}}, draws: true}
+	if c := imageConfigOf(d.Size); c != nil {
+		// the size and shape the images API asked, in the field a Gemini
+		// client's own imageConfig arrives in, which buildCodeAssistSent
+		// puts in generationConfig
+		b, _ := json.Marshal(c)
+		req.ImageConfig = b
+	}
 	return s.eachDrawing(d.N, func() (drawn, int, error) {
 		// one each: the drawings are asked for at once
 		ask := s.askTranslated(p, provider.CodeAssist, model, http.Header{}, http.Header{})
@@ -2031,6 +2038,49 @@ func aspectOf(size string) string {
 	return aspectAmong(size, []string{"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"})
 }
 
+// imageSizeOf is the Gemini imageSize bucket an images API size asks for:
+// the smallest whose long side covers the size asked, and "" when there is
+// nothing to ask. Only 2K and 4K go out: a size at or under the model's 1K
+// default is drawn at anyway, and imageSize isn't every image model's
+// (Vertex lists 1K, 2K, 4K), so the buckets under 1K aren't asked for what
+// the default already gives. A ratio given as one ("16:9") says nothing in
+// pixels, and is "" too.
+func imageSizeOf(size string) string {
+	w, h, ok := strings.Cut(strings.ToLower(strings.TrimSpace(size)), "x")
+	if !ok {
+		return ""
+	}
+	x, err1 := strconv.ParseFloat(w, 64)
+	y, err2 := strconv.ParseFloat(h, 64)
+	if err1 != nil || err2 != nil || x <= 0 || y <= 0 {
+		return ""
+	}
+	switch m := math.Max(x, y); {
+	case m > 2048:
+		return "4K"
+	case m > 1024:
+		return "2K"
+	}
+	return ""
+}
+
+// imageConfigOf is the imageConfig an images API size asks a Gemini image
+// model to draw at: the ratio the size is nearest, with the imageSize
+// beside it when the size asks past the model's 1K default. nil for none.
+func imageConfigOf(size string) map[string]string {
+	c := map[string]string{}
+	if r := aspectOf(size); r != "" {
+		c["aspectRatio"] = r
+	}
+	if s := imageSizeOf(size); s != "" {
+		c["imageSize"] = s
+	}
+	if len(c) == 0 {
+		return nil
+	}
+	return c
+}
+
 // grokAspects are the aspect ratios Grok's Imagine API takes.
 var grokAspects = []string{"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"}
 
diff --git a/internal/gateway/gemini_image_size_test.go b/internal/gateway/gemini_image_size_test.go
new file mode 100644
index 000000000..c34f45b3d
--- /dev/null
+++ b/internal/gateway/gemini_image_size_test.go
@@ -0,0 +1,99 @@
+package gateway
+
+import (
+	"fmt"
+	"io"
+	"net/http"
+	"strings"
+	"testing"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// geminiDrawn is a Gemini API's answer with one image drawn.
+const geminiDrawn = `{"candidates":[{"content":{"role":"model","parts":[{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3}}`
+
+// A size an images API client asks for reaches a Gemini image model on
+// Google's own API as an imageSize beside the aspect ratio (#3936): a size
+// asked as pixels only became a ratio, so the model drew at its default 1K
+// and no size above 1K could be asked. A size the 1K default covers is the
+// aspect ratio alone, as before, and a ratio asked as one is no size.
+func TestImagesAPISizeReachesTheGeminiAPI(t *testing.T) {
+	fresh(t)
+	var body []byte
+	if err := provider.Save(provider.Provider{ID: "gg", Name: "Google", Chat: "https://generativelanguage.googleapis.com/v1beta/openai", Key: "key", Models: []string{"gemini-3-pro-image-preview"}}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	s.client = &http.Client{Transport: countTransport(func(r *http.Request) (*http.Response, error) {
+		b, err := io.ReadAll(r.Body)
+		if err != nil {
+			return nil, err
+		}
+		if !strings.HasSuffix(r.URL.Path, ":generateContent") {
+			return nil, fmt.Errorf("unexpected request to %s", r.URL)
+		}
+		body = b
+		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(geminiDrawn))}, nil
+	})}
+	code, a, raw := postImages(t, s, "/v1/images/generations", "application/json", `{"model":"gg/gemini-3-pro-image-preview","prompt":"a magpie","size":"4096x4096"}`)
+	if code != 200 || len(a.Data) != 1 {
+		t.Fatalf("%d %s", code, raw)
+	}
+	if sent := gjson.GetBytes(body, "generationConfig.imageConfig").Raw; !sameConfig(sent, `{"aspectRatio":"1:1","imageSize":"4K"}`) {
+		t.Fatalf("size 4096x4096: imageConfig was %s: %s", sent, body)
+	}
+	code, _, raw = postImages(t, s, "/v1/images/generations", "application/json", `{"model":"gg/gemini-3-pro-image-preview","prompt":"a magpie","size":"1536x1024"}`)
+	if code != 200 {
+		t.Fatalf("%d %s", code, raw)
+	}
+	if sent := gjson.GetBytes(body, "generationConfig.imageConfig").Raw; !sameConfig(sent, `{"aspectRatio":"3:2","imageSize":"2K"}`) {
+		t.Fatalf("size 1536x1024: imageConfig was %s: %s", sent, body)
+	}
+	// a size the model's 1K default draws at is the ratio alone, as before
+	code, _, raw = postImages(t, s, "/v1/images/generations", "application/json", `{"model":"gg/gemini-3-pro-image-preview","prompt":"a magpie","size":"1024x1024"}`)
+	if code != 200 {
+		t.Fatalf("%d %s", code, raw)
+	}
+	if sent := gjson.GetBytes(body, "generationConfig.imageConfig").Raw; !sameConfig(sent, `{"aspectRatio":"1:1"}`) {
+		t.Fatalf("size 1024x1024: imageConfig was %s: %s", sent, body)
+	}
+	// a ratio asked as one is no size
+	code, _, raw = postImages(t, s, "/v1/images/generations", "application/json", `{"model":"gg/gemini-3-pro-image-preview","prompt":"a magpie","size":"16:9"}`)
+	if code != 200 {
+		t.Fatalf("%d %s", code, raw)
+	}
+	if sent := gjson.GetBytes(body, "generationConfig.imageConfig").Raw; !sameConfig(sent, `{"aspectRatio":"16:9"}`) {
+		t.Fatalf("size 16:9: imageConfig was %s: %s", sent, body)
+	}
+}
+
+// The same reaches a Google sign-in's image model (#3936): the images API's
+// size becomes the imageConfig a Gemini client's own arrives in
+// (TestGeminiImageConfigReachesCodeAssist), inside Code Assist's envelope
+// too. None asked, none sent, as before.
+func TestImagesAPISizeReachesCodeAssist(t *testing.T) {
+	rec := &asksKept{}
+	s, _ := antigravityGroupFor(t, []string{"u@example.com"}, agDrawer, func(w http.ResponseWriter, r *http.Request) {
+		rec.keep(r)
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(drawnPNG))
+	})
+	code, a, raw := postImages(t, s, "/v1/images/generations", "application/json", `{"model":"antigravity/`+agDrawer+`","prompt":"a cat","size":"4096x4096"}`)
+	if code != 200 || len(a.Data) != 1 {
+		t.Fatalf("%d %s", code, raw)
+	}
+	got, _ := rec.last()
+	if sent := gjson.GetBytes(got.body, "request.generationConfig.imageConfig").Raw; !sameConfig(sent, `{"aspectRatio":"1:1","imageSize":"4K"}`) {
+		t.Fatalf("size 4096x4096: imageConfig was %s: %s", sent, got.body)
+	}
+	code, _, raw = postImages(t, s, "/v1/images/generations", "application/json", `{"model":"antigravity/`+agDrawer+`","prompt":"a cat"}`)
+	if code != 200 {
+		t.Fatalf("%d %s", code, raw)
+	}
+	got, _ = rec.last()
+	if sent := gjson.GetBytes(got.body, "request.generationConfig.imageConfig").Raw; sent != "" {
+		t.Fatalf("no size asked: imageConfig was %s", sent)
+	}
+}
-- 
2.51.2

```

</details>

`git am` applies it as is; SHA-256 first 16: `65479e3c28e14115`

Branch with the commit: fix/3936-gemini-image-size (head f3afe1720f1d7ff7535178be14fd3300aaa8d234)
