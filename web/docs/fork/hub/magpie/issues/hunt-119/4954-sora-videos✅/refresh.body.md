Rebased onto current main (`50265256b`): the films rule it joins grew an Ark face since — a list's `Domain: "VideoGeneration"` and a video-only `modalities.output` now mark the films too (`92d2ed74f`), which leaves OpenAI's bare sora rows (no kind, no domain, no modalities) still unmarked, so the word rule stands as the increment. Merged as the union; head `252bb200a`, new patch below (SHA-256 first 16: 5239125b7a8adb51). Re-ran on the merged tree: `TestOpenAIKeySoraMakesVideos` and the video family green (Ark's new marks coexist), the re-applied ablation red on the new parent and green again, gofmt/vet/builds clean.

**Patch**: <details><summary>patch: catalog: a list's sora ids are video models, made at its OpenAI-shaped videos API (#4954) — git am applies it as is; SHA-256 first 16: 5239125b7a8adb51</summary>

```patch
From 252bb200a48832579d1a0825b602dbdb4999a61e Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 07:22:11 +0800
Subject: [PATCH] catalog: a list's sora ids are video models, made at its
 OpenAI-shaped videos API (#4954)

What changed: a fetched model list keeps an id naming a video model the
way it keeps one that draws (FilmsID: sora-2, sora-2-pro). OpenAI's list
marks no kind, and textModel counts sora out of the chat models, so a
Sora model was never listed at all: the provider editor could not mark
it a video model, and startVideo answered 400 "can't make videos". A
sora id now reaches the list as Films - a video model of the provider,
asked at its OpenAI-shaped videos API, which the gateway already speaks
- and is still no chat model. The other video families keep the faces
their own APIs are asked on: Ark's Seedance at its tasks, a MiniMax
key's H3, and a model the user says makes videos (#1399).

Run:
- go test ./internal/gateway -run TestOpenAIKeySoraMakesVideos -count=1
  RED before (videomakers [] - the list carried no sora model), green
  after: sora-2 and sora-2-pro are the provider's video models, a video
  is started, polled and fetched at its /v1/videos, and neither id is
  among the chat models.
- TestCustomProviderMakesVideos, TestCustomProviderVideoNeedsTheListsWord,
  TestCustomProviderVideoTheUserMarks green, the last two with the
  fixture's unmarked model renamed to agnes-video-2.5-flash (#1399's own
  case): a name alone still makes no video model, even one with "video"
  in it.
- go test ./internal/catalog, the video family with -race, gofmt,
  go vet -tags nogui, builds (darwin, linux, windows): clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/catalog/catalog.go           | 13 ++++
 internal/catalog/live.go              |  6 +-
 internal/gateway/video_custom_test.go | 22 +++---
 internal/gateway/video_sora_test.go   | 96 +++++++++++++++++++++++++++
 4 files changed, 124 insertions(+), 13 deletions(-)
 create mode 100644 internal/gateway/video_sora_test.go

diff --git a/internal/catalog/catalog.go b/internal/catalog/catalog.go
index 089bb2c09..d870e70b1 100644
--- a/internal/catalog/catalog.go
+++ b/internal/catalog/catalog.go
@@ -1986,6 +1986,19 @@ func ImagesAPI(id string) bool {
 	return false
 }
 
+// FilmsID is whether a model's id names one that makes videos, for a model
+// whose list says nothing of a kind: OpenAI's sora-2 and sora-2-pro are
+// made at its OpenAI-shaped videos API, which the gateway speaks, but
+// textModel counts their ids out of the chat models, and a list that
+// marks no kind left them unlisted at all — never offered to talk to, and
+// never marked a video model in the provider's editor (#4954). The other
+// video families keep the faces their own APIs are asked on: Ark's
+// Seedance at its tasks (gateway arkVideoModel), a MiniMax key's H3
+// (video_minimax.go), and a model the user says makes videos (#1399).
+func FilmsID(id string) bool {
+	return strings.Contains(strings.ToLower(id), "sora")
+}
+
 // PointsToImagesAPI is whether a vendor's refusal of a chat request names
 // its images API as the one the model is asked on: Agnes answers
 // agnes-image-2.5-flash on chat completions with 400 "Model
diff --git a/internal/catalog/live.go b/internal/catalog/live.go
index 230e8d384..dd122d94f 100644
--- a/internal/catalog/live.go
+++ b/internal/catalog/live.go
@@ -647,8 +647,10 @@ func fetchPage(ctx context.Context, url, key string, anthropic bool, headers map
 		// where the list marks no kind, Ark's domain "VideoGeneration" or
 		// an output of video without text (doubao-seedance-*, wan2-1-*),
 		// which is no model to chat with (axelburks on Discord: Ark's
-		// Seedance sat among its chat models, not under Video models)
-		films := r.Kind == "video" || r.Kind == "" && (r.Domain == "VideoGeneration" || slices.Contains(outs, "video") && !slices.Contains(outs, "text"))
+		// Seedance sat among its chat models, not under Video models);
+		// OpenAI's sora ids, whose bare list marks no kind and says no
+		// modalities at all (#4954)
+		films := r.Kind == "video" || r.Kind == "" && (r.Domain == "VideoGeneration" || slices.Contains(outs, "video") && !slices.Contains(outs, "text")) || FilmsID(id)
 		drawer := !films && !decision && (DrawsID(id) && !strings.Contains(strings.ToLower(id), "deep-research") || r.Kind == "image" ||
 			r.Kind == "" && (r.Domain == "ImageGeneration" || slices.Contains(outs, "image") && !slices.Contains(outs, "text")))
 		// and none the list says answers without text (Ark's 3D models)
diff --git a/internal/gateway/video_custom_test.go b/internal/gateway/video_custom_test.go
index 901642aec..57d7465d0 100644
--- a/internal/gateway/video_custom_test.go
+++ b/internal/gateway/video_custom_test.go
@@ -19,9 +19,9 @@ import (
 
 // openAIVideos is an upstream serving OpenAI's Videos API under /v1, as a
 // provider set up with a base URL does (#1446): its model list marks
-// vid-1 "kind": "video" and lists sora-like-2 with no kind, a video takes
-// two polls to be made, and what each request was sent and signed with is
-// kept.
+// vid-1 "kind": "video" and lists agnes-video-2.5-flash with no kind, a
+// video takes two polls to be made, and what each request was sent and
+// signed with is kept.
 type openAIVideos struct {
 	*httptest.Server
 	mu     sync.Mutex
@@ -47,7 +47,7 @@ func newOpenAIVideos(t *testing.T) *openAIVideos {
 		const vid = "video_68d7.abc"
 		switch {
 		case r.Method == "GET" && r.URL.Path == "/v1/models":
-			io.WriteString(w, `{"object":"list","data":[{"id":"gpt-5.5","object":"model"},{"id":"vid-1","object":"model","kind":"video"},{"id":"sora-like-2","object":"model"}]}`)
+			io.WriteString(w, `{"object":"list","data":[{"id":"gpt-5.5","object":"model"},{"id":"vid-1","object":"model","kind":"video"},{"id":"agnes-video-2.5-flash","object":"model"}]}`)
 		case r.Method == "POST" && r.URL.Path == "/v1/videos" && key == u.lacks:
 			w.WriteHeader(404)
 			io.WriteString(w, `{"error":{"message":"Model \"vid-1\" is not supported by any configured account in this group","type":"invalid_request_error"}}`)
@@ -177,7 +177,7 @@ func TestCustomProviderVideoNeedsTheListsWord(t *testing.T) {
 	up := newOpenAIVideos(t)
 	saveFetched(t, provider.Provider{ID: "studio", Name: "Studio", Chat: up.URL + "/v1", Key: "sk-studio"})
 	h := New().Handler()
-	for _, model := range []string{"studio/sora-like-2", "studio/gpt-5.5", "studio/grok-imagine-video"} {
+	for _, model := range []string{"studio/agnes-video-2.5-flash", "studio/gpt-5.5", "studio/grok-imagine-video"} {
 		code, obj, raw := asKey(t, h, "", "POST", "/v1/videos", `{"model":"`+model+`","prompt":"a cat"}`)
 		if code != 400 || !strings.Contains(errorOf(obj), "can't make videos") {
 			t.Fatalf("%s: %d %s", model, code, raw)
@@ -337,8 +337,8 @@ func TestGrokVideoPollHeldByKeyModels(t *testing.T) {
 func TestCustomProviderVideoTheUserMarks(t *testing.T) {
 	fresh(t)
 	up := newOpenAIVideos(t)
-	p := saveFetched(t, provider.Provider{ID: "studio", Name: "Studio", Chat: up.URL + "/v1", Key: "sk-studio", Models: []string{"gpt-5.5", "sora-like-2", "typed-video-1"}})
-	for ref, kind := range map[string]string{"studio/sora-like-2": "video", "studio/typed-video-1": "video", "studio/vid-1": "image", "studio/gpt-5.5": "image"} {
+	p := saveFetched(t, provider.Provider{ID: "studio", Name: "Studio", Chat: up.URL + "/v1", Key: "sk-studio", Models: []string{"gpt-5.5", "agnes-video-2.5-flash", "typed-video-1"}})
+	for ref, kind := range map[string]string{"studio/agnes-video-2.5-flash": "video", "studio/typed-video-1": "video", "studio/vid-1": "image", "studio/gpt-5.5": "image"} {
 		if err := provider.SetModelKind(ref, kind); err != nil {
 			t.Fatalf("%s: %v", ref, err)
 		}
@@ -354,14 +354,14 @@ func TestCustomProviderVideoTheUserMarks(t *testing.T) {
 		slices.Sort(out)
 		return out
 	}
-	if got := ids(Videomakers(p)); !slices.Equal(got, []string{"sora-like-2", "typed-video-1"}) {
+	if got := ids(Videomakers(p)); !slices.Equal(got, []string{"agnes-video-2.5-flash", "typed-video-1"}) {
 		t.Fatalf("videomakers %v", got)
 	}
 	if got := ids(Drawers(p)); !slices.Equal(got, []string{"gpt-5.5", "vid-1"}) {
 		t.Fatalf("drawers %v", got)
 	}
 	h := New().Handler()
-	for i, model := range []string{"sora-like-2", "typed-video-1"} {
+	for i, model := range []string{"agnes-video-2.5-flash", "typed-video-1"} {
 		code, obj, raw := asKey(t, h, "", "POST", "/v1/videos", `{"model":"studio/`+model+`","prompt":"waves on a rock"}`)
 		if id, _ := obj["id"].(string); code != 200 || !strings.HasPrefix(id, "video_studio.") {
 			t.Fatalf("%s: %d %s", model, code, raw)
@@ -379,10 +379,10 @@ func TestCustomProviderVideoTheUserMarks(t *testing.T) {
 	if err := provider.SetModelKind("studio/nope-9", "video"); err == nil {
 		t.Fatal("a model studio doesn't have was marked")
 	}
-	if err := provider.SetModelKind("studio/sora-like-2", "audio"); err == nil {
+	if err := provider.SetModelKind("studio/agnes-video-2.5-flash", "audio"); err == nil {
 		t.Fatal("a kind magpie doesn't know was taken")
 	}
-	for _, ref := range []string{"studio/sora-like-2", "studio/typed-video-1", "studio/vid-1", "studio/gpt-5.5"} {
+	for _, ref := range []string{"studio/agnes-video-2.5-flash", "studio/typed-video-1", "studio/vid-1", "studio/gpt-5.5"} {
 		if err := provider.SetModelKind(ref, ""); err != nil {
 			t.Fatal(err)
 		}
diff --git a/internal/gateway/video_sora_test.go b/internal/gateway/video_sora_test.go
new file mode 100644
index 000000000..97a20e391
--- /dev/null
+++ b/internal/gateway/video_sora_test.go
@@ -0,0 +1,96 @@
+package gateway
+
+import (
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"slices"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// soraVideos is an upstream serving OpenAI's Videos API under /v1 whose
+// model list names sora-2 and sora-2-pro and marks no kind, as OpenAI's
+// does: a video is made in one poll.
+type soraVideos struct {
+	*httptest.Server
+	mu     sync.Mutex
+	bodies []string
+}
+
+func newSoraVideos(t *testing.T) *soraVideos {
+	t.Helper()
+	u := &soraVideos{}
+	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		u.mu.Lock()
+		defer u.mu.Unlock()
+		w.Header().Set("Content-Type", "application/json")
+		switch {
+		case r.Method == "GET" && r.URL.Path == "/v1/models":
+			io.WriteString(w, `{"object":"list","data":[{"id":"gpt-5.5","object":"model"},{"id":"sora-2","object":"model"},{"id":"sora-2-pro","object":"model"}]}`)
+		case r.Method == "POST" && r.URL.Path == "/v1/videos":
+			u.bodies = append(u.bodies, string(b))
+			io.WriteString(w, `{"id":"video_1","object":"video","created_at":1790000000,"status":"queued","progress":0,"model":"sora-2","seconds":"4","size":"1280x720"}`)
+		case r.Method == "GET" && r.URL.Path == "/v1/videos/video_1":
+			io.WriteString(w, `{"id":"video_1","object":"video","status":"completed","progress":100,"model":"sora-2"}`)
+		case r.Method == "GET" && r.URL.Path == "/v1/videos/video_1/content":
+			w.Header().Set("Content-Type", "video/mp4")
+			io.WriteString(w, "\x00\x00\x00\x18ftypmp42fake-mp4")
+		default:
+			w.WriteHeader(404)
+			io.WriteString(w, `{"error":{"message":"no route `+r.Method+" "+r.URL.Path+`","type":"invalid_request_error"}}`)
+		}
+	}))
+	t.Cleanup(u.Close)
+	return u
+}
+
+// An OpenAI API key's Sora models make videos through /v1/videos (#4954):
+// a sora id is a video model its list needs no kind mark for, asked at the
+// OpenAI-shaped videos API the gateway already speaks, and it is no chat
+// model.
+func TestOpenAIKeySoraMakesVideos(t *testing.T) {
+	fresh(t)
+	up := newSoraVideos(t)
+	p := saveFetched(t, provider.Provider{ID: "studio", Name: "Studio", Chat: up.URL + "/v1", Key: "sk-studio"})
+	ids := func(ms []catalog.Model) []string {
+		var out []string
+		for _, m := range ms {
+			out = append(out, m.ID)
+		}
+		return out
+	}
+	if got := ids(Videomakers(p)); !slices.Equal(got, []string{"sora-2", "sora-2-pro"}) {
+		t.Fatalf("videomakers %v", got)
+	}
+	var chat []string
+	for _, m := range p.Available() {
+		chat = append(chat, m.ID)
+	}
+	if slices.Contains(chat, "sora-2") || slices.Contains(chat, "sora-2-pro") {
+		t.Fatalf("the sora models among the chat models: %v", chat)
+	}
+	h := New().Handler()
+	code, obj, raw := asKey(t, h, "", "POST", "/v1/videos", `{"model":"studio/sora-2","prompt":"a cat on a fence","seconds":4,"size":"1280x720"}`)
+	id, _ := obj["id"].(string)
+	if code != 200 || obj["model"] != "studio/sora-2" || obj["status"] != "queued" {
+		t.Fatalf("start: %d %s", code, raw)
+	}
+	var sent map[string]any
+	json.Unmarshal([]byte(up.bodies[0]), &sent)
+	if sent["model"] != "sora-2" || sent["prompt"] != "a cat on a fence" || sent["seconds"] != "4" || sent["size"] != "1280x720" {
+		t.Fatalf("sent %v", sent)
+	}
+	if code, obj, raw = asKey(t, h, "", "GET", "/v1/videos/"+id, ""); code != 200 || obj["status"] != "completed" || obj["model"] != "studio/sora-2" {
+		t.Fatalf("poll: %d %s", code, raw)
+	}
+	if got := ids(Videomakers(p)); strings.Join(got, ",") != "sora-2,sora-2-pro" {
+		t.Fatalf("videomakers changed: %v", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>
