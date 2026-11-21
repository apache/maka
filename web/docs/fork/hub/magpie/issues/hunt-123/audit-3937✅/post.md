Taken — here is a patch carrying a Gemini client's generationConfig fields magpie doesn't read through to an upstream that speaks Gemini's own API.

## Summary

- `parseGemini` read only `maxOutputTokens`, `temperature`, `topP`, `stopSequences`, the structured-output fields, `thinkingConfig` and `imageConfig` (#3820), and `buildCodeAssistSent` built a `generationConfig` of those same keys — so a translated request (a Gemini client's `generateContent` asked of a Gemini API in one body, and every request to Code Assist or Antigravity) reached its upstream without the rest of what the client asked: `topK`, `seed`, `candidateCount`, `presencePenalty`, `frequencyPenalty`, `responseModalities`, `mediaResolution`, `speechConfig`, `responseFormat`.
- The request now carries the keys magpie doesn't read or write (`Request.GenConfig`), and one built for the Gemini API or Vertex AI is sent them beside what magpie rebuilt, as they were sent — camelCase and all, since `geminiCamel` ran on the way in.
- A field magpie sets itself stands: a draw model is still asked for `["TEXT","IMAGE"]` whatever the client's own `responseModalities` said, and the rebuilt fields (`thinkingConfig`, `temperature`, …) are never sent twice.
- Code Assist's and Antigravity's envelope is sent none of them: their spelling of these fields isn't documented (the reporter's own word), and no other API takes Gemini's names. `safetySettings` and `cachedContent` — top-level, not `generationConfig` — are left for a follow-up; this patch keeps to the fields the issue's title names.

## Verification

| Check | Result |
| --- | --- |
| new `TestGeminiGenConfigReachesTheGeminiAPI` (the reporter's nine fields; snake_case `top_k`/`candidate_count`; beside a field magpie reads; none asked, none sent) | RED before, GREEN after |
| new `TestGeminiGenConfigDrawModelKeepsMagpiesModalities` (client's `["TEXT"]` to a draw model, magpie's `["TEXT","IMAGE"]` sent, `topK` beside) | RED before, GREEN after |
| ablation (product files back at d8b3749ef, new tests kept) | red again |
| `go test -tags nogui -timeout 25m ./internal/gateway/` | ok 623s, 0 failures |
| `go test -tags nogui -race -run 'TestGeminiGenConfig|TestGeminiImageConfig|TestGemini'` | ok |
| `gofmt` / `go vet` / `go build ./...` | clean |

## AI use

Patch written by GLM-5.3-Flash (ZCode); author ggbdpq.

<details>
<summary>Patch (git am format) — SHA-256 (first 16): cf9787bbe5254074</summary>

```
From 6df21df128b0ecd4b5d1960712542c57458b9423 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 05:54:00 +0800
Subject: [PATCH] gateway: a Gemini request's generationConfig keeps the fields
 magpie doesn't read (#3937)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

parseGemini read a generationConfig of the fields magpie knows —
maxOutputTokens, temperature, topP, stopSequences, the structured output
ones, thinkingConfig, and, since #3820, imageConfig — and
buildCodeAssistSent built one of the same, so a translated request (a
Gemini client's generateContent asked of a Gemini API in one body, and
every request to Code Assist or Antigravity) went upstream without the
rest of what the client asked: topK, seed, candidateCount,
presencePenalty, frequencyPenalty, responseModalities, mediaResolution,
speechConfig, responseFormat (#3937, yinwu01).

The request now carries the keys magpie doesn't read or write
(Request.GenConfig), and one built for an upstream that speaks Gemini's
own API — the Gemini one, and Vertex AI — is sent them beside what magpie
rebuilt, as they were sent, camelCase and all (geminiCamel). A field
magpie sets itself stands: a draw model is still asked for
["TEXT","IMAGE"] whatever the client's own said. Code Assist's and
Antigravity's envelope is sent none of them: their spelling of these
fields isn't documented, and no other API takes Gemini's names.

Fixes #3937

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gemini.go                 |  42 ++++++
 internal/gateway/gemini_gen_config_test.go | 144 +++++++++++++++++++++
 internal/gateway/ir.go                     |  10 ++
 3 files changed, 196 insertions(+)
 create mode 100644 internal/gateway/gemini_gen_config_test.go

diff --git a/internal/gateway/gemini.go b/internal/gateway/gemini.go
index 46b3402c0..3cb8ea73a 100644
--- a/internal/gateway/gemini.go
+++ b/internal/gateway/gemini.go
@@ -153,6 +153,23 @@ func geminiRequest(r *Request, model, agent string) (map[string]any, error) {
 		delete(si, "role")
 	}
 	delete(wrap.Request, "stream")
+	// the rest of what a Gemini client asked, as it sent it (#3937): the
+	// Gemini API and Vertex AI speak the request's own shape, so their
+	// generationConfig carries what magpie doesn't read beside what it
+	// rebuilt — magpie's word for a field it sets stands (a draw model's
+	// responseModalities).
+	if len(r.GenConfig) > 0 {
+		gen, ok := wrap.Request["generationConfig"].(map[string]any)
+		if !ok {
+			gen = map[string]any{}
+			wrap.Request["generationConfig"] = gen
+		}
+		for k, v := range r.GenConfig {
+			if _, set := gen[k]; !set {
+				gen[k] = json.RawMessage(v)
+			}
+		}
+	}
 	return wrap.Request, nil
 }
 
@@ -229,6 +246,15 @@ func snakeToCamel(s string) string {
 	return strings.Join(parts, "")
 }
 
+// genReadOrBuilt are generationConfig's keys magpie reads itself or writes
+// its own of: they are rebuilt from the request when it is sent on
+// (buildCodeAssistSent), not carried as they came (#3937).
+var genReadOrBuilt = map[string]bool{
+	"maxOutputTokens": true, "temperature": true, "topP": true, "stopSequences": true,
+	"responseMimeType": true, "responseSchema": true, "responseJsonSchema": true,
+	"thinkingConfig": true, "imageConfig": true,
+}
+
 func parseGemini(body []byte) (*Request, error) {
 	body = geminiCamel(body)
 	var g gRequest
@@ -263,6 +289,22 @@ func parseGemini(body []byte) (*Request, error) {
 			}
 			r.System += ask + "."
 		}
+		// the rest of what the client asked, carried for a Gemini upstream
+		// as it was sent (#3937). The body was spelled in camelCase on its
+		// way in (geminiCamel).
+		var raw struct {
+			GenerationConfig map[string]json.RawMessage `json:"generationConfig"`
+		}
+		if json.Unmarshal(body, &raw) == nil {
+			for k, v := range raw.GenerationConfig {
+				if !genReadOrBuilt[k] && len(v) > 0 && string(v) != "null" {
+					if r.GenConfig == nil {
+						r.GenConfig = make(map[string]json.RawMessage, len(raw.GenerationConfig))
+					}
+					r.GenConfig[k] = v
+				}
+			}
+		}
 	}
 	// function results carry the call's id when the client kept it; older
 	// clients send only the name, matched to the first call of that name
diff --git a/internal/gateway/gemini_gen_config_test.go b/internal/gateway/gemini_gen_config_test.go
new file mode 100644
index 000000000..d38d14a9b
--- /dev/null
+++ b/internal/gateway/gemini_gen_config_test.go
@@ -0,0 +1,144 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// genAsks are generationConfigs a Gemini client sends, each with the keys a
+// Gemini upstream should be sent beside what magpie rebuilds, and the keys
+// it must not be sent that the client didn't ask for.
+var genAsks = []struct {
+	name   string
+	gen    string
+	want   map[string]string
+	absent []string
+}{
+	{
+		"the reporter's fields",
+		`{"topK":40,"seed":42,"candidateCount":2,"presencePenalty":0.5,"frequencyPenalty":-0.5,` +
+			`"responseModalities":["TEXT"],"mediaResolution":"MEDIA_RESOLUTION_LOW",` +
+			`"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Aoede"}}},"responseFormat":{"text":{}}}`,
+		map[string]string{
+			"topK": `40`, "seed": `42`, "candidateCount": `2`,
+			"presencePenalty": `0.5`, "frequencyPenalty": `-0.5`,
+			"responseModalities": `["TEXT"]`,
+			"mediaResolution":    `"MEDIA_RESOLUTION_LOW"`,
+			"speechConfig":       `{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Aoede"}}}`,
+			"responseFormat":     `{"text":{}}`,
+		},
+		nil,
+	},
+	{
+		"snake_case, as Google's API also reads it (geminiCamel)",
+		`{"top_k":40,"candidate_count":2}`,
+		map[string]string{"topK": `40`, "candidateCount": `2`},
+		nil,
+	},
+	{
+		"beside what magpie reads",
+		`{"temperature":0.4,"topK":40}`,
+		map[string]string{"topK": `40`, "temperature": `0.4`},
+		nil,
+	},
+	{
+		"none asked, none sent",
+		`{"temperature":0.4}`,
+		map[string]string{},
+		[]string{"topK", "seed", "candidateCount", "presencePenalty", "frequencyPenalty",
+			"responseModalities", "mediaResolution", "speechConfig", "responseFormat"},
+	},
+}
+
+// saysGemini is a Gemini API's stream with a plain text answer.
+const saysGemini = `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}`
+
+// genUpstream is a relay whose only API is a Gemini one that answers saysGemini,
+// with what its upstream was asked kept in rec.
+func genUpstream(t *testing.T, model string) (*asksKept, error) {
+	t.Helper()
+	rec := &asksKept{}
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		rec.keep(r)
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(saysGemini))
+	}))
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Models: []string{model}, Gemini: up.URL + "/v1beta"}); err != nil {
+		return nil, err
+	}
+	return rec, nil
+}
+
+// A Gemini client's generationConfig fields magpie doesn't read — topK,
+// seed, candidateCount, the penalties, responseModalities, mediaResolution,
+// speechConfig, responseFormat — reach a Gemini API as they were sent
+// (#3937, yinwu01): a request asked for one body is translated, and was
+// built again without everything else the client asked. What magpie reads
+// or writes itself goes as magpie builds it.
+func TestGeminiGenConfigReachesTheGeminiAPI(t *testing.T) {
+	const model = "gemini-3-pro"
+	fresh(t)
+	rec, err := genUpstream(t, model)
+	if err != nil {
+		t.Fatal(err)
+	}
+	asked := 0
+	for _, ask := range genAsks {
+		code, body := post(t, "/v1beta/models/relay/"+model+":generateContent", imageAsk(ask.gen))
+		if code != 200 || !strings.Contains(body, "hello") {
+			t.Fatalf("%s: asked %s: %d %s", ask.name, ask.gen, code, body)
+		}
+		got, n := rec.last()
+		if n <= asked {
+			t.Fatalf("%s: asked %s: nothing reached the relay", ask.name, ask.gen)
+		}
+		asked = n
+		for k, want := range ask.want {
+			if sent := gjson.GetBytes(got.body, "generationConfig."+k).Raw; !sameConfig(sent, want) {
+				t.Errorf("%s: asked %s: %s was sent generationConfig.%s = %s, want %s: %s", ask.name, ask.gen, got.path, k, sent, want, got.body)
+			}
+		}
+		for _, k := range ask.absent {
+			if sent := gjson.GetBytes(got.body, "generationConfig."+k).Raw; sent != "" {
+				t.Errorf("%s: asked %s: %s was sent generationConfig.%s = %s, asked for none", ask.name, ask.gen, got.path, k, sent)
+			}
+		}
+	}
+}
+
+// A model whose id says it draws is sent magpie's own responseModalities
+// even when the client asked for its own: magpie's word for a draw model
+// stands (buildCodeAssistSent), and the rest of what the client asked goes
+// beside it.
+func TestGeminiGenConfigDrawModelKeepsMagpiesModalities(t *testing.T) {
+	const model = "gemini-3-pro-image-preview"
+	fresh(t)
+	rec := &asksKept{}
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		rec.keep(r)
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(drawnGemini))
+	}))
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Models: []string{model}, Gemini: up.URL + "/v1beta"}); err != nil {
+		t.Fatal(err)
+	}
+	code, body := post(t, "/v1beta/models/relay/"+model+":generateContent", imageAsk(`{"responseModalities":["TEXT"],"topK":40}`))
+	if code != 200 || !strings.Contains(body, "aGVsbG8=") {
+		t.Fatalf("asked: %d %s", code, body)
+	}
+	got, _ := rec.last()
+	if sent := gjson.GetBytes(got.body, "generationConfig.responseModalities").Raw; !sameConfig(sent, `["TEXT","IMAGE"]`) {
+		t.Errorf("a draw model was sent responseModalities %s, want [\"TEXT\",\"IMAGE\"]: %s", sent, got.body)
+	}
+	if sent := gjson.GetBytes(got.body, "generationConfig.topK").Raw; !sameConfig(sent, `40`) {
+		t.Errorf("a draw model was sent topK %s, want 40: %s", sent, got.body)
+	}
+}
diff --git a/internal/gateway/ir.go b/internal/gateway/ir.go
index 40c311a0d..b88655d1c 100644
--- a/internal/gateway/ir.go
+++ b/internal/gateway/ir.go
@@ -320,6 +320,16 @@ type Request struct {
 	// (buildCodeAssistSent). Left out, the picture came back at the
 	// model's default size (#3820). No other API is known to take it.
 	ImageConfig json.RawMessage
+	// GenConfig holds a Gemini client's generationConfig keys magpie
+	// doesn't read or write itself — topK, seed, candidateCount, the
+	// penalties, responseModalities, mediaResolution, speechConfig,
+	// responseFormat — which go on as they were sent when the request is
+	// built again for an upstream that speaks Gemini's own API (the Gemini
+	// one and Vertex AI, geminiRequest): left out, everything else the
+	// client asked was dropped (#3937). Code Assist's and Antigravity's
+	// envelope has no documented spelling of them, so they are not passed
+	// there.
+	GenConfig map[string]json.RawMessage
 	// Safeguards are the caller's safety context, opaque to the gateway.
 	Safeguards    json.RawMessage
 	SafeguardBeta string
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch: https://github.com/ggbdpq/magpie/tree/fix/3937-gemini-genconfig (head 6df21df128b0ecd4b5d1960712542c57458b9423)
