Two seams in this report — one is a real relay gap, patched below; the other is capability metadata, where what you are seeing is #6135's own design and the fix belongs to the data, not the filter.

**Seam 1 — the Qwen 400, patched.** Your group trace shows the filter working: it read the MP4 out of your `file` part (the same read the build has used since `b4fc29a6e`, v0.1.3754, which your 0.1.3802 carries) and kept only the member whose list takes video. What that member was asked with was the problem: a request relayed as the client sent it goes to the Chat upstream as it came, and your `file.file_data` block is not a shape Qwen reads as a video — DashScope answered it as a document, "The current model does not support PDF file input". The build gives a video a `video_url` on Chat (`chatVideo`, #6135); the relayed body now gets the same shape. `forwardOnce`'s Chat body rewrites a file part whose `file_data` names a video — by its data: URL's type, else the filename's extension, the same test the parse applies — into the `video_url` part DashScope's Qwen, Kimi, Zhipu, OpenRouter and vLLM read, in place, every other byte of the body as sent. A file of another type (your PDF case, #5452), or one held by its OpenAI file id, stays as it came. With your exact shape: the member that took the video was asked with `{"type":"file","file":{"filename":"sample.mp4","file_data":...}}` before and is asked with `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,..."}}` now — the encoding your own middleware produces, without the middleware.

**Seam 2 — Gemini (and MiMo) left out of the group: capability metadata, maintainer's call.** The filter is not dropping them as unsupported-in-fact. Your direct Gemini call answers 200, which on a model whose entry said text/image only could not happen: a latest-turn video to a model the list says takes no video is a 400 before any upstream is asked (I probed exactly your file shape against an entry listing `[text,image]` — 400 "does not support video input", nothing sent). Your Gemini going through means magpie's entry for it says nothing about video at all. In a group, #6135 asks a video only of the members that take one, else of those magpie knows nothing of — an unknown member is the fallback, and your Qwen Omni's entry does say video, so Qwen is asked first and Gemini never is, for any video request, until its entry says video. That is the entry's data, not the filter's logic: the filter already distinguishes unknown from explicitly unsupported (an unknown member is never turned away, it is just asked last). Where an entry's inputs come from — a plugin's capabilities, a vendor model list's input_modalities, models.dev — and whether a user can override them (your suggestion 3: today `model spec` exposes vision only) are exactly the mechanism that would let Gemini and MiMo into the taking bucket without waiting on the data; that call is the maintainer's.

Verification, all at base `9c33839de` / head `3e28fb74fe8fce66`, on mote:
- Red: both new tests fail at the base — the member whose list takes video is asked with the `file` block as sent, no `video_url` (TestChatVideoFileGoesAsVideoURL, TestGroupChatVideoFileGoesAsVideoURL).
- Green with the fix: the same file part reaches the taking member as `video_url` with the MP4 data; the group asks the taking member alone; a PDF file and a file-by-id relay as they came; `go test ./internal/gateway -run 'TestChatVideoFileGoesAsVideoURL|TestGroupChatVideoFileGoesAsVideoURL|TestVideo|TestGroup'` — ok.
- Ablation: the `chatVideoFileAsURL` call reverted out of `forwardOnce`'s Chat body, both tests red again, byte-shape as at the base; restored, green.
- Full package: `go test -timeout 25m -count=1 ./internal/gateway` — ok (1031.9s).
- Race: `go test -race -run 'TestChatVideoFileGoesAsVideoURL|TestGroupChatVideoFileGoesAsVideoURL'` — ok.
- gofmt -l clean; go vet ./internal/gateway; GOOS=linux -tags nogui, GOOS=windows, GOOS=darwin builds — ok.
- `git am` replay of the patch on the base tree gives a tree identical to the branch's (`13c0a37cedad3fd9`).

Not verified: a real Qwen (DashScope) or Gemini account, so the 400's disappearance on your gateway is argued from the shapes, not watched on the vendors; your Windows-less macOS setup was not reproduced here either — no GUI involved; the audio seams in your follow-up (streaming/non-streaming audio encoding per candidate) are #4101's and are untouched by this patch.

Siblings: `chatVideoFileAsURL` has one caller (`forwardOnce`'s Chat body). The parse-side read (`chatFile`, `internal/gateway/chat.go`) is what the group filter already uses and is unchanged; Responses' `input_file` of a video keeps its own handling (`videoFileType`, untouched); plugin providers are always sent a translated request (build-shaped, no `file_data` — the rewrite's pre-check passes them through untouched).

**When the read fails**: the rewrite reads only JSON already in the request body; a body without `"file_data"` comes back as it was, and a malformed one is left for the parse to answer as it always has.

**Source**: reported in #6210 (double2tea's reproductions on 0.1.3801/0.1.3802); the relayed-shape gap confirmed by probe on current main.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch**: [`hunt-20261112-t1-6210`](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-6210) @ `3e28fb74fe8fce66` — one commit on current upstream main.

**Patch**: <details><summary>patch: gateway: a Chat file of a video relayed goes as the video_url a Chat API reads (#6210) — git am applies it as is; SHA-256 first 16: 492c144c1ce34cce</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 13 Nov 2026 03:30:48 +0800
Subject: [PATCH] gateway: a Chat file of a video relayed goes as the video_url
 a Chat API reads (#6210)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

double2tea sent a Chat Completions request whose attachment was a file
part of an MP4 (file.file_data, a data:video/mp4 URI) to a routing
group. The group's filter read the video and picked the member whose
list takes one, but that member was asked with the body as the client
sent it, file block and all, and Qwen answered 400 "The current model
does not support PDF file input": the build gives a video a video_url
on Chat (#6135), a request relayed as it came kept the file block, and
the vendor read it as a document.

forwardOnce's Chat body now takes the same shape the build gives: a
file part whose file_data names a video — by its data: URL's type,
else the filename's extension, as the parse reads the part — is
rewritten in place to the video_url part DashScope's Qwen, Kimi,
Zhipu, OpenRouter and vLLM read. A file of another type, or one held
by its OpenAI file id, stays as it came, and so does every other byte
of the body.

Run (mote):
- go test ./internal/gateway -run 'TestChatVideoFileGoesAsVideoURL|TestGroupChatVideoFileGoesAsVideoURL|TestVideo|TestGroup': ok
- gofmt -l clean; go vet ./internal/gateway: ok

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go          |  5 ++
 internal/gateway/video_input.go      | 76 ++++++++++++++++++++++++++++
 internal/gateway/video_input_test.go | 74 +++++++++++++++++++++++++++
 3 files changed, 155 insertions(+)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index f14bf99a7..e73857602 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -6576,6 +6576,11 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 		// a content of text parts, which a vendor's server that takes a
 		// string alone turns the whole request away for (Atria on Discord)
 		body = textPartsAsString(body)
+		// a file part of a video, which the Chat APIs that take a video
+		// read as the video_url the build gives one (#6135); relayed as it
+		// came, the vendor read the file block as a document — Qwen
+		// answered an MP4 with "does not support PDF file input" (#6210)
+		body = chatVideoFileAsURL(body)
 		// a turn the client cut off before it said anything, which
 		// DeepSeek and Kimi turn every later request away for (#2599)
 		body = silentAssistantsOut(body)
diff --git a/internal/gateway/video_input.go b/internal/gateway/video_input.go
index 7761202b4..f90340e79 100644
--- a/internal/gateway/video_input.go
+++ b/internal/gateway/video_input.go
@@ -9,6 +9,7 @@ import (
 	"slices"
 	"strings"
 
+	"github.com/tidwall/gjson"
 	"github.com/yetone/magpie/internal/provider"
 )
 
@@ -130,6 +131,81 @@ func chatVideo(p Part) map[string]any {
 	return map[string]any{"type": "video_url", "video_url": map[string]any{"url": dataURL(p)}}
 }
 
+// chatVideoFileAsURL turns a Chat request relayed as the client sent it a
+// file part of a video into the video_url part the Chat APIs that take a
+// video read (DashScope's Qwen, Kimi, Zhipu, OpenRouter, vLLM). The build
+// gives a video a video_url on Chat (#6135); a relayed one kept the file
+// block, and the vendor read it as a document — Qwen answered an MP4 with
+// "The current model does not support PDF file input" (#6210).
+//
+// Only a file part whose file_data names a video becomes one, by the data:
+// URL's type, else by the filename's extension, as the parse reads the
+// part (videoFileType). A file of another type, or one held by its OpenAI
+// file id, stays as it came. Every other byte of the body stays as sent,
+// and a body with no file part comes back as it was.
+func chatVideoFileAsURL(body []byte) []byte {
+	if !bytes.Contains(body, []byte(`"file_data"`)) {
+		return body
+	}
+	msgs := gjson.GetBytes(body, "messages")
+	if !msgs.IsArray() {
+		return body
+	}
+	type edit struct {
+		at, n int
+		s     []byte
+	}
+	var edits []edit
+	msgs.ForEach(func(_, m gjson.Result) bool {
+		if !m.IsObject() {
+			return true
+		}
+		c := m.Get("content")
+		if !c.IsArray() || c.Index <= 0 || c.Index+len(c.Raw) > len(body) || string(body[c.Index:c.Index+len(c.Raw)]) != c.Raw {
+			return true
+		}
+		c.ForEach(func(_, p gjson.Result) bool {
+			if p.Get("type").Str != "file" || p.Index <= 0 || p.Index+len(p.Raw) > len(body) || string(body[p.Index:p.Index+len(p.Raw)]) != p.Raw {
+				return true
+			}
+			f := p.Get("file")
+			data := f.Get("file_data").Str
+			if data == "" {
+				return true
+			}
+			name := f.Get("filename").Str
+			mt := videoFileType(data, name)
+			if mt == "" {
+				return true
+			}
+			url := data
+			if !strings.HasPrefix(data, "data:") && !strings.Contains(data, "://") {
+				// bare base64, as some clients send it: named as the parse
+				// names it (chatFile's cmp.Or of the type from the name)
+				url = "data:" + mt + ";base64," + data
+			}
+			s, err := marshalPlain(map[string]any{"type": "video_url", "video_url": map[string]any{"url": url}})
+			if err != nil {
+				return true
+			}
+			edits = append(edits, edit{p.Index, len(p.Raw), s})
+			return true
+		})
+		return true
+	})
+	if len(edits) == 0 {
+		return body
+	}
+	out := make([]byte, 0, len(body))
+	last := 0
+	for _, e := range edits {
+		out = append(out, body[last:e.at]...)
+		out = append(out, e.s...)
+		last = e.at + e.n
+	}
+	return append(out, body[last:]...)
+}
+
 // videoBlock is a video as a Messages video block, the image block's shape
 // under another type: MiniMax's Anthropic endpoint reads it.
 func videoBlock(p Part) aBlock {
diff --git a/internal/gateway/video_input_test.go b/internal/gateway/video_input_test.go
index b7976395b..b941e5c3b 100644
--- a/internal/gateway/video_input_test.go
+++ b/internal/gateway/video_input_test.go
@@ -293,3 +293,77 @@ func TestGroupVideoGoesToMembersThatTakeIt(t *testing.T) {
 		t.Errorf("group with no member that takes video: %d %s; upstream %v", rec.Code, rec.Body.String(), bodies)
 	}
 }
+
+// A Chat file of a video (#6210: the reporter's `file.file_data` data:
+// video/mp4 URI) relayed as the client sent it reaches a Chat upstream
+// that reads video_url as the file block it is — Qwen answered the MP4
+// with "The current model does not support PDF file input". It goes as
+// the video_url the build gives a video on Chat (#6135); a file of
+// another type, or one held by its OpenAI file id, stays as it came.
+func TestChatVideoFileGoesAsVideoURL(t *testing.T) {
+	fresh(t)
+	noVision(t)
+	up, upServer := videoUp(t)
+	p := provider.Provider{ID: "qv", Name: "QV", Chat: upServer.URL + "/v1", Key: "k", Models: []string{"v"}}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive(p.ID, upServer.URL, []catalog.Model{
+		{ID: "v", Images: true, ImageInput: imageInputBool(true), InputModalities: videoKinds, OutputModalities: []string{"text"}},
+	}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+
+	rec := serveVideo(s, "/v1/chat/completions", `{"model":"qv/v","max_tokens":64,"messages":[{"role":"user","content":[`+
+		`{"type":"file","file":{"filename":"sample.mp4","file_data":"data:video/mp4;base64,`+videoData+`"}},`+
+		`{"type":"text","text":"Analyze this video."}]}]}`)
+	bodies, _ := up.sent()
+	if rec.Code != 200 || len(bodies) != 1 || !strings.Contains(bodies[0], `"video_url"`) || !strings.Contains(bodies[0], videoData) ||
+		strings.Contains(bodies[0], "file_data") {
+		t.Errorf("a Chat file of a video relayed: %d %q", rec.Code, bodies)
+	}
+
+	up.reset()
+	rec = serveVideo(s, "/v1/chat/completions", `{"model":"qv/v","max_tokens":64,"messages":[{"role":"user","content":[`+
+		`{"type":"file","file":{"filename":"notes.pdf","file_data":"data:application/pdf;base64,AAAA"}},`+
+		`{"type":"file","file":{"file_id":"file-1"}},`+
+		`{"type":"text","text":"Read these."}]}]}`)
+	bodies, _ = up.sent()
+	if rec.Code != 200 || len(bodies) != 1 || strings.Contains(bodies[0], "video_url") ||
+		!strings.Contains(bodies[0], "data:application/pdf") || !strings.Contains(bodies[0], `"file_id":"file-1"`) {
+		t.Errorf("a PDF file and one by id relayed: %d %q", rec.Code, bodies)
+	}
+}
+
+// The same file of a video through a routing group: the member whose list
+// takes video is the one asked, and it is asked with the video_url, not
+// the file block the vendor reads as a document (#6210).
+func TestGroupChatVideoFileGoesAsVideoURL(t *testing.T) {
+	fresh(t)
+	noVision(t)
+	up, upServer := videoUp(t)
+	p := provider.Provider{ID: "qg", Name: "QG", Chat: upServer.URL + "/v1", Key: "k", Models: []string{"v", "t"}}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive(p.ID, upServer.URL, []catalog.Model{
+		{ID: "v", Images: true, ImageInput: imageInputBool(true), InputModalities: videoKinds, OutputModalities: []string{"text"}},
+		{ID: "t", Images: true, ImageInput: imageInputBool(true), InputModalities: []string{"text", "image"}, OutputModalities: []string{"text"}},
+	}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SaveGroup(provider.Group{Name: "vf", Members: []string{"qg/t", "qg/v"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+
+	rec := serveVideo(s, "/v1/chat/completions", `{"model":"group/vf","max_tokens":64,"messages":[{"role":"user","content":[`+
+		`{"type":"file","file":{"filename":"sample.mp4","file_data":"data:video/mp4;base64,`+videoData+`"}},`+
+		`{"type":"text","text":"Analyze this video."}]}]}`)
+	bodies, models := up.sent()
+	if rec.Code != 200 || len(bodies) != 1 || len(models) != 1 || models[0] != "v" ||
+		!strings.Contains(bodies[0], `"video_url"`) || strings.Contains(bodies[0], "file_data") {
+		t.Errorf("group file-of-video: %d bodies=%v models=%v", rec.Code, bodies, models)
+	}
+}
-- 
2.50.1 (Apple Git-155)


```

</details>
