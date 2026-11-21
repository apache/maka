Re-verified at current main (`eb1b83000`): every element below re-ran on that tip.

| Element | Status / evidence at `eb1b83000` |
| --- | --- |
| Rebase | clean, range-diff `=` — zero semantic drift |
| git am | the patch below applies to a clean `eb1b83000` tree; result tree-identical to the branch (`fcb83bc62f`) |
| Tests | full `internal/gateway` package ok (1299.0s); `TestResponsesInputFileSurvivesTranslation`, `TestResponsesInputFilePartSurvivesTranslation` (flat + nested), `TestAnthropicDocumentSurvivesTranslation`, `TestChatFileRidesToResponsesAndAnthropic` ok, and ok under `-race -count=2`; gofmt/vet clean; nogui build ok for linux/darwin/windows |
| Ablation (red without the fix) | `responses.go` + `anthropic.go` + `chat.go` product hunks reverted, tests kept: all four file tests FAIL (`the input_file was dropped` / `the document block was dropped` shapes); restored, green |
| Siblings | the pre-existing nested-only `case "input_file"` reader in `responsesParts` at this tip is exactly the face the patch extends to the flat shape; Chat's `file_data` mirror and Gemini's inline/`fileUri` split, the video machinery (#6135) — untouched by upstream's newest commits, conclusions hold |
| Field evidence | carried from the post below: fake-level harness replays the shapes; the report's own vendor probe (400 `invalid_file`) stands for the field taking it |

New branch head: `6d29c05880a96f63` — branch: https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5452
Patch below rebuilt at the new head — SHA-256 first 16: `23ac5613840d94a8`

**Not verified** (carried over): the reporter's live ChatGPT API account; a real Messages/Responses upstream taking the PDF.

**Attribution**: AI-written (this re-verification comment, written with GLM-5.3-Flash (ZCode)); I've read the whole diff. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Patch: <details><summary>patch: gateway: a PDF survives translation (#5452) — git am applies it as is; SHA-256 first 16: 23ac5613840d94a8</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 07:25:53 +0800
Subject: [PATCH] gateway: a PDF survives translation (#5452)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A PDF reached the model only when the request was relayed as sent; the
moment magpie translated it, the file was lost — the Responses
input_file and the Messages document were dropped whole, and the Chat
file became the placeholder text "[attachment application/pdf]"
(#5452, ProgramerLiang: three paths located line by line; a ChatGPT API
account speaks only Responses and only streams, so a Chat request to it
always translated and its file always became the note, and a
non-streaming Responses request to a stream-only account lost its
input_file while the same request streamed arrived whole).

The parts parse into file parts now — the Responses input_file (a
standalone item, its file_data and filename flat on the item, and a
message block, flat as the OpenAI shape has it or nested as a Chat
client sends) and the Messages document — and the Responses and
Messages encoders write inline data in their own tongue (input_file /
document), where Gemini's inline data already rode. A file only
referenced — a Gemini fileUri on the vendor's storage, or another
host's file id — is still told of: Responses' file_id is OpenAI's own,
Anthropic's url source takes http(s) and not a cloud-storage scheme,
and the Chat encoder keeps telling of the file rather than carrying it,
Chat upstreams' file support being uneven and a 400 there losing the
whole turn (#934). The Claude subscription line renders text to its
CLI, which carries no PDF either way.

Rebased onto the video work (#6135), which reads an input_file of a
video alone and left this face standing: a video rides the video
machinery still, and every other file — a PDF, say — is a file part.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/anthropic.go            |  28 +++++-
 internal/gateway/chat.go                 |   3 +
 internal/gateway/image_input_test.go     |  13 ++-
 internal/gateway/pdf_translation_test.go | 114 +++++++++++++++++++++++
 internal/gateway/responses.go            |  48 ++++++++--
 5 files changed, 198 insertions(+), 8 deletions(-)
 create mode 100644 internal/gateway/pdf_translation_test.go

diff --git a/internal/gateway/anthropic.go b/internal/gateway/anthropic.go
index 72bc6743b..84d3b838b 100644
--- a/internal/gateway/anthropic.go
+++ b/internal/gateway/anthropic.go
@@ -225,6 +225,13 @@ func readAdvised(body []byte, clientMarks, facts, advised bool) (*Request, error
 							msg.Parts = append(msg.Parts, v)
 						}
 					}
+				case "document":
+					// a PDF, say, as the client sent it: dropped whole
+					// before, it reached the model only when the request
+					// was relayed as sent (#5452)
+					if b.Source != nil {
+						msg.Parts = append(msg.Parts, Part{Kind: File, MediaType: b.Source.MediaType, Data: b.Source.Data, URL: b.Source.URL, block: true})
+					}
 				case "tool_use":
 					msg.Parts = append(msg.Parts, Part{Kind: ToolCall, ID: anthropicInID(b.ID), Name: b.Name, Args: b.Input, block: true})
 				case "tool_result":
@@ -1015,7 +1022,26 @@ func anthropicBody(r *Request, model, host string, replay bool) []byte {
 					rest = append(rest, b)
 					break
 				}
-				rest = append(rest, aBlock{Type: "text", Text: attachmentText(p)})
+				if p.Data != "" {
+					// the file itself, in Messages' own tongue (#5452)
+					rest = append(rest, aBlock{Type: "document", Source: &struct {
+						Type      string `json:"type"`
+						MediaType string `json:"media_type,omitempty"`
+						Data      string `json:"data,omitempty"`
+						URL       string `json:"url,omitempty"`
+					}{Type: "base64", MediaType: p.MediaType, Data: p.Data}})
+				} else if strings.HasPrefix(p.URL, "http") {
+					// a document by its URL — Anthropic's url source takes
+					// http(s), not a cloud-storage scheme (#5452)
+					rest = append(rest, aBlock{Type: "document", Source: &struct {
+						Type      string `json:"type"`
+						MediaType string `json:"media_type,omitempty"`
+						Data      string `json:"data,omitempty"`
+						URL       string `json:"url,omitempty"`
+					}{Type: "url", URL: p.URL}})
+				} else {
+					rest = append(rest, aBlock{Type: "text", Text: attachmentText(p)})
+				}
 			case Image:
 				b := imageBlock(p)
 				b.CacheControl = partMark(p.cache)
diff --git a/internal/gateway/chat.go b/internal/gateway/chat.go
index 760779b9d..e83d8708d 100644
--- a/internal/gateway/chat.go
+++ b/internal/gateway/chat.go
@@ -548,6 +548,9 @@ func buildChat(r *Request, model, host string, rejectTemp bool) []byte {
 					content = append(content, chatVideo(p))
 					break
 				}
+				// told of, not carried: Chat upstreams' file support is
+				// uneven, and a 400 here loses the whole turn (#934) — the
+				// Responses and Messages tongues carry it whole (#5452)
 				content = append(content, map[string]any{"type": "text", "text": attachmentText(p)})
 			case Image:
 				plain = false
diff --git a/internal/gateway/image_input_test.go b/internal/gateway/image_input_test.go
index 12068928d..6eaae2067 100644
--- a/internal/gateway/image_input_test.go
+++ b/internal/gateway/image_input_test.go
@@ -482,8 +482,19 @@ func TestGeminiNonImageFileTranslation(t *testing.T) {
 			}
 			responses := buildResponses(r, "text", "", false)
 			anthropic := buildAnthropic(r, "text")
+			// inline data rides whole in both tongues (#5452); a file
+			// only referenced (a fileUri on the vendor's storage) is told
+			// of, Responses' file_id and Anthropic's url source being
+			// someone else's
+			rides := tc.field == "inlineData"
 			for protocol, out := range map[string][]byte{"Responses": responses, "Anthropic": anthropic} {
-				if strings.Contains(string(out), `"image_url"`) || strings.Contains(string(out), `"type":"image"`) || !strings.Contains(string(out), "[attachment "+tc.mime) {
+				if strings.Contains(string(out), `"image_url"`) || strings.Contains(string(out), `"type":"image"`) {
+					t.Errorf("%s mislabeled file as image: %s", protocol, out)
+				}
+				if rides && !strings.Contains(string(out), tc.mime) {
+					t.Errorf("%s lost the file: %s", protocol, out)
+				}
+				if !rides && !strings.Contains(string(out), "[attachment "+tc.mime) {
 					t.Errorf("%s lost or mislabeled file: %s", protocol, out)
 				}
 			}
diff --git a/internal/gateway/pdf_translation_test.go b/internal/gateway/pdf_translation_test.go
new file mode 100644
index 000000000..e12ce9444
--- /dev/null
+++ b/internal/gateway/pdf_translation_test.go
@@ -0,0 +1,114 @@
+package gateway
+
+import (
+	"strings"
+	"testing"
+)
+
+// A PDF only reaches the model when the request is relayed as sent; the
+// moment magpie translates it, the file is lost — the Responses input_file
+// and the Messages document are dropped whole, and the Chat file becomes
+// the placeholder text "[attachment application/pdf]" (#5452). Each shape
+// survives its translation now: the parts parse into file parts, and every
+// protocol's encoder writes them in its own tongue.
+
+const pdfB64 = "JVBERi0xLjQK" // "%PDF-1.4"
+
+func TestResponsesInputFileSurvivesTranslation(t *testing.T) {
+	r, err := parseResponses([]byte(`{"model":"m","input":[{"type":"input_file","filename":"doc.pdf","file_data":"data:application/pdf;base64,` + pdfB64 + `"}]}`))
+	if err != nil {
+		t.Fatal(err)
+	}
+	var file *Part
+	for i, m := range r.Messages {
+		for j := range m.Parts {
+			if r.Messages[i].Parts[j].Kind == File {
+				file = &r.Messages[i].Parts[j]
+			}
+		}
+	}
+	if file == nil {
+		t.Fatalf("the input_file was dropped: %+v", r.Messages)
+	}
+	if file.MediaType != "application/pdf" || file.Data != pdfB64 {
+		t.Fatalf("file part %+v, want application/pdf %s", *file, pdfB64)
+	}
+}
+
+// A content part carries the fields flat, as the OpenAI shape has them
+// and the report's case C sends them; a Chat-style client nests them under
+// "file". Both ride.
+func TestResponsesInputFilePartSurvivesTranslation(t *testing.T) {
+	for _, tc := range []struct{ name, part string }{
+		{"flat", `{"type":"input_file","filename":"doc.pdf","file_data":"data:application/pdf;base64,` + pdfB64 + `"}`},
+		{"nested", `{"type":"input_file","file":{"filename":"doc.pdf","file_data":"data:application/pdf;base64,` + pdfB64 + `"}}`},
+	} {
+		t.Run(tc.name, func(t *testing.T) {
+			r, err := parseResponses([]byte(`{"model":"m","input":[{"role":"user","content":[{"type":"input_text","text":"read it"},` + tc.part + `]}]}`))
+			if err != nil {
+				t.Fatal(err)
+			}
+			var file *Part
+			for i, m := range r.Messages {
+				for j := range m.Parts {
+					if r.Messages[i].Parts[j].Kind == File {
+						file = &r.Messages[i].Parts[j]
+					}
+				}
+			}
+			if file == nil {
+				t.Fatalf("the input_file was dropped: %+v", r.Messages)
+			}
+			if file.MediaType != "application/pdf" || file.Data != pdfB64 {
+				t.Fatalf("file part %+v, want application/pdf %s", *file, pdfB64)
+			}
+		})
+	}
+}
+
+func TestAnthropicDocumentSurvivesTranslation(t *testing.T) {
+	r, err := readAnthropic([]byte(`{"model":"m","max_tokens":64,"messages":[{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"`+pdfB64+`"}}]}]}`), false, false)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var file *Part
+	for i, m := range r.Messages {
+		for j := range m.Parts {
+			if r.Messages[i].Parts[j].Kind == File {
+				file = &r.Messages[i].Parts[j]
+			}
+		}
+	}
+	if file == nil {
+		t.Fatalf("the document block was dropped: %+v", r.Messages)
+	}
+	if file.MediaType != "application/pdf" || file.Data != pdfB64 {
+		t.Fatalf("file part %+v, want application/pdf %s", *file, pdfB64)
+	}
+}
+
+func TestChatFileRidesToResponsesAndAnthropic(t *testing.T) {
+	req := []byte(`{"model":"m","messages":[{"role":"user","content":[{"type":"file","file":{"filename":"doc.pdf","file_data":"data:application/pdf;base64,` + pdfB64 + `"}}]}]}`)
+	r, err := parseChat(req)
+	if err != nil {
+		t.Fatal(err)
+	}
+
+	// to a Responses upstream: an input_file, not the placeholder text
+	out := buildResponses(r, "m", "upstream.test", false)
+	if !strings.Contains(string(out), `"input_file"`) || !strings.Contains(string(out), pdfB64) {
+		t.Fatalf("responses body lost the file:\n%s", out)
+	}
+	if strings.Contains(string(out), "[attachment") {
+		t.Fatalf("responses body carries the placeholder text:\n%s", out)
+	}
+
+	// to an Anthropic upstream: a document block, not the placeholder text
+	out = buildAnthropic(r, "m")
+	if !strings.Contains(string(out), `"document"`) || !strings.Contains(string(out), pdfB64) {
+		t.Fatalf("anthropic body lost the file:\n%s", out)
+	}
+	if strings.Contains(string(out), "[attachment") {
+		t.Fatalf("anthropic body carries the placeholder text:\n%s", out)
+	}
+}
diff --git a/internal/gateway/responses.go b/internal/gateway/responses.go
index 7a5a230d5..c31be592e 100644
--- a/internal/gateway/responses.go
+++ b/internal/gateway/responses.go
@@ -32,6 +32,12 @@ type rItem struct {
 	// tool_search_output: the tools Codex's search found, which the model
 	// may call from then on
 	Tools []rTool `json:"tools,omitempty"`
+	// input_file as a standalone item: its file_data and filename sit on
+	// the item itself, flat (a PDF the client drops straight into the
+	// input array, #5452)
+	FileData string `json:"file_data,omitempty"`
+	FileID   string `json:"file_id,omitempty"`
+	Filename string `json:"filename,omitempty"`
 	// configuration_update's: an effort changed mid-thread
 	Reasoning *struct {
 		Effort string `json:"effort"`
@@ -381,6 +387,17 @@ func readResponsesFor(body []byte, facts, keepInstructions bool) (*Request, erro
 				replied = true
 			}
 			switch {
+			case it.Type == "input_file":
+				// a file part as its own item: dropped whole before, it
+				// reached the model only when the request was relayed as
+				// sent (#5452). A video rides the video machinery (#6135)
+				if mt := videoFileType(it.FileData, it.Filename); mt != "" {
+					if v, ok := videoPart(it.FileData, mt, it.Filename); ok {
+						r.Messages = append(r.Messages, Message{Role: "user", Parts: []Part{v}})
+					}
+				} else if p, ok := chatFile(it.FileData, it.FileID, it.Filename); ok {
+					r.Messages = append(r.Messages, Message{Role: "user", Parts: []Part{p}})
+				}
 			case it.Type == "message" || (it.Type == "" && it.Role != ""):
 				role := "user"
 				if it.Role == "assistant" {
@@ -1106,7 +1123,13 @@ func responsesParts(raw json.RawMessage) []Part {
 		Detail   string `json:"detail"`
 		FileData string `json:"file_data"`
 		FileURL  string `json:"file_url"`
+		FileID   string `json:"file_id"`
 		Filename string `json:"filename"`
+		File     struct {
+			FileData string `json:"file_data"`
+			FileID   string `json:"file_id"`
+			Filename string `json:"filename"`
+		} `json:"file"`
 	}
 	decodeJSON(raw, &items)
 	var out []Part
@@ -1121,12 +1144,17 @@ func responsesParts(raw json.RawMessage) []Part {
 				out = append(out, im)
 			}
 		case "input_file":
-			// a video alone (#6135); another file is still left out (#5452)
-			src := cmp.Or(it.FileData, it.FileURL)
+			// a video rides the video machinery (#6135); every other file,
+			// a PDF say, is a file part, which the encoders write in their
+			// own tongue (#5452) — dropped whole before, it reached the
+			// model only when the request was relayed as sent
+			src := cmp.Or(it.FileData, it.FileURL, it.File.FileData)
 			if mt := videoFileType(src, it.Filename); mt != "" {
 				if v, ok := videoPart(src, mt, it.Filename); ok {
 					out = append(out, v)
 				}
+			} else if p, ok := chatFile(src, cmp.Or(it.FileID, it.File.FileID), cmp.Or(it.Filename, it.File.Filename)); ok {
+				out = append(out, p)
 			}
 		}
 	}
@@ -1395,11 +1423,19 @@ func buildResponses(r *Request, model, host string, rejectTemp bool) []byte {
 				}
 				content = append(content, map[string]any{"type": t, "text": p.Text})
 			case File:
-				t := "input_text"
-				if m.Role == "assistant" {
-					t = "output_text"
+				if m.Role != "assistant" && p.Data != "" {
+					// the file itself, in Responses' own tongue (#5452)
+					content = append(content, map[string]any{"type": "input_file", "file_data": "data:" + p.MediaType + ";base64," + p.Data})
+				} else {
+					// a file only referenced (a Gemini fileUri, another
+					// host's file id) is told of: Responses' file_id is
+					// OpenAI's own, not that reference (#5452)
+					t := "input_text"
+					if m.Role == "assistant" {
+						t = "output_text"
+					}
+					content = append(content, map[string]any{"type": t, "text": attachmentText(p)})
 				}
-				content = append(content, map[string]any{"type": t, "text": attachmentText(p)})
 			case Image:
 				if m.Role != "assistant" {
 					content = append(content, map[string]any{"type": "input_image", "detail": responsesDetail(p.Detail), "image_url": dataURL(p)})
-- 
2.50.1 (Apple Git-155)

````
</details>

