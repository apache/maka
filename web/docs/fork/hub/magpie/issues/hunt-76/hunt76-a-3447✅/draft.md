## Summary

`/v1/messages` with the `web_search_20250305` tool answered with its `web_search_tool_result` and the text that read it, but the text carried no `citations[]` — so every client that reads `citations[].cited_text` for its snippets (dsh's `mapAnthropicResponse`) got urls alone and showed "searched, nothing in it" (#3447). Where magpie searches for the model, the blocks are magpie's own making, and a `Hit` kept no excerpt at all: the search's quotes were dropped where the searcher's reply was read, so there was nothing to cite. The fix keeps what was quoted of each page and carries those quotes as the citations of the text that read it.

## What changed

Two upstream shapes behind the issue, traced on `dd1e8822`:

- **`auto/deepseek-v4.1-flash` → the raccoon relay**: the model searches by itself on no API (`searchHosts`, `searchModels`), so magpie searches for it (`searchedForIt`) and the reply is translated — `server_tool_use` / `web_search_tool_result` are magpie's own blocks (`anthropicEncoder`, `renderAnthropic`). This is where the citations were lost: `searchWith` read the searcher's `web_search_tool_result` keeping only title/url/page_age, a search API's page text was dropped in `pagesSaid`, and no code path ever wrote a `web_search_result_location` (none existed in the repo before this patch).
- **`deepseek/deepseek-flash` → api.deepseek.com**: the host is in `searchHosts[Anthropic]`, so the model searches by itself, `searchedForIt` is false and the reply is relayed by `passthrough` byte for byte. Its `web_search_tool_result` entries (`type/title/url/encrypted_content/page_age`, no excerpt) and citation-less text are DeepSeek's own shape; magpie does not touch them and cannot — there is no excerpt to cite, and none is invented. (The two routers' identical entry shape in the issue's matrix is DeepSeek's own; magpie's synthesized entries also carry those five fields, with `encrypted_content` always empty.)

Changes (product diff +58/-9, one commit):

- `Hit` keeps `CitedText` — what the search quoted of the page (`""` when it gave none).
- `searchWith` keeps a searcher entry's `cited_text` when it has one; `pagesSaid` clips a search API's page text to `citedTextMost` (150, as much as Anthropic's own search quotes). A Claude-subscription search result unmarshals into `Hit` and picks `cited_text` up by itself.
- The text that read a search carries its quotes as `citations[]`, each a `web_search_result_location` (`type/url/title/cited_text`): streamed as `citations_delta` ahead of the text (the same shape `whole_stream.go` already replays a text's citations with), whole beside it. `web_search_tool_result` entries carry the excerpt too, as Anthropic's own do.
- A page nothing was quoted of gives no citation — none is invented — and a searcher's sealed content stays sealed (`encrypted_content` still always empty; sealed `encrypted_index` is not relayed either).

Sibling faces checked, left alone: `anthropicWholeEvents`'s citations replay (already correct, untouched); `decodeAnthropic` drops an upstream's `citations_delta` on the translated stream path — real, but no path in this issue goes through it (the relay relays, the search-for path parses whole replies) and carrying citations through the IR is a separate, larger change; `responsesSearchItem` is the `/v1/responses` shape, another protocol; Gemini Code Assist and Responses `web_search_call` hits have no excerpt to keep.

Cost on the hot path: one pass over a search's hits (≤10) when a search event arrives; a reply with no search writes no `citations` key and is byte-identical to before.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -run 'TestWebSearchCitationsCarriedToText\|TestWebSearchCitationsWholeReply' ./internal/gateway/` on baseline | FAIL — "the text block carries no citations" / "citations []" |
| same after the fix | ok (3 tests, guard included) |
| same-domain: `TestDeepSeekNativeSearchResults`, `TestSearchFallbackSkipsARelaySaidToSearch`, `TestSearcherAskedWhereItSearches`, `TestSearcherFindingNothingGivesWay`, `TestWholeAsStream*`, `TestClaudeCodeWebSearchKeepsMetadata` | ok |
| ablation: product files back to `dd1e8822`, tests kept | FAIL — "the text block carries no citations" / "citations []"; restored: ok (`-count=1`) |
| `go test -tags nogui -count=1 ./internal/gateway/` (full, 356.7s) | ok |
| `gofmt -l` on the five touched files | clean |
| `go vet -tags nogui ./...` | clean (pre-existing darwin cgo warning in `internal/gui/trayimage_darwin.go` only) |
| `GOOS=linux go vet -tags nogui ./...` | clean |
| `GOOS=windows go vet ./...` | clean |
| `CGO_ENABLED=0 go build -tags nogui` darwin / linux / windows | ok / ok / ok |
| plain `go build` (no nogui) linux | FAIL — pre-existing: wails v3.0.0-beta.24 `webview_window_linux.go` `undefined: pointer` (fails on baseline too, GUI dep, not this patch's files) |

## Notes

- skygunner's comment above says both routers in the issue's matrix go through magpie's search-for pipeline. On `dd1e8822` the deepseek official host is in `searchHosts[Anthropic]` (`search.go`), `searchesItself` is true for it (`TestDeepSeekNativeSearchResults` asserts it), so `deepseek/deepseek-flash` is relayed, not searched for. Its entries reach the client as DeepSeek wrote them — which is why both routers showed the same five-field shape. The two upstreams' failures have different seats; this patch fixes magpie's own making, and leaves the relayed shape as the vendor wrote it.
- The excerpts carried are the searcher's own quotes or a search API's text of the page, clipped to 150. Where an upstream gives no excerpt (DeepSeek's sealed entries), no citation is written: a `cited_text` is not made up.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: [hunt76-a-websearch-citations](https://github.com/ggbdpq/magpie/tree/hunt76-a-websearch-citations) (head `69068eadfd60b98bb4f98b190243df6791759b8e`).

<details><summary>patch: hunt76-a-websearch-citations (#3447) — git am applies it as is; SHA-256 first 16: 71018acd4ddf6dd3</summary>

```text
From 69068eadfd60b98bb4f98b190243df6791759b8e Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 14:30:35 +0800
Subject: [PATCH] gateway: carry a web search's excerpts as the citations of
 the text that read it

A web search asked of /v1/messages answered with its web_search_tool_result
and the text that read it, but the text carried no citations[], so a client
that reads citations[].cited_text for its snippets (dsh's
web-search-deepseek) was left with urls alone, its search "found nothing"
(#3447).

Where magpie searches for the model, the blocks are magpie's own making,
and a Hit kept no excerpt: a searcher's citation of a page was dropped
where its reply was read, and a search API's text of a page beside it. A
Hit now keeps what was quoted of its page, and the text that read the
search carries those quotes as its citations, each a
web_search_result_location, streamed as citations_delta ahead of its text
and whole beside it, as Anthropic's own web search says it. A page nothing
was quoted of gives no citation, as none is invented, and a searcher's
sealed content stays sealed. Where the model searches by itself, the reply
is relayed as it came and is not touched.

Run: go test -tags nogui ./internal/gateway/

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/anthropic.go                |  52 ++++-
 internal/gateway/ir.go                       |   5 +
 internal/gateway/search.go                   |   9 +-
 internal/gateway/search_api.go               |   4 +-
 internal/gateway/websearch_citations_test.go | 233 +++++++++++++++++++
 5 files changed, 294 insertions(+), 9 deletions(-)
 create mode 100644 internal/gateway/websearch_citations_test.go

diff --git a/internal/gateway/anthropic.go b/internal/gateway/anthropic.go
index 1135c9b0..eacb619a 100644
--- a/internal/gateway/anthropic.go
+++ b/internal/gateway/anthropic.go
@@ -1371,6 +1371,9 @@ type anthropicEncoder struct {
 	fresh   bool
 	started bool
 	col     collector
+	// cites: what the reply's searches quoted of their pages, which the
+	// text that read them carries as its citations (#3447)
+	cites []any
 }
 
 // anthropicID is a reply's id as Anthropic's API gives one, msg_…: an
@@ -1498,7 +1501,16 @@ func (e *anthropicEncoder) event(ev Event) {
 		if ev.Text == "" {
 			return
 		}
-		e.openBlock(Text, map[string]any{"text": ""})
+		block := map[string]any{"text": ""}
+		if len(e.cites) > 0 {
+			// what the searches before it quoted, said of the block as
+			// Anthropic's own web search says it (#3447)
+			block["citations"] = []any{}
+		}
+		e.openBlock(Text, block)
+		for _, c := range e.cites {
+			e.delta(map[string]any{"type": "citations_delta", "citation": c})
+		}
 		e.delta(map[string]any{"type": "text_delta", "text": ev.Text})
 	case KThinkStart:
 		// opened with what it says first: one that says nothing isn't
@@ -1541,6 +1553,7 @@ func (e *anthropicEncoder) event(ev Event) {
 		// as Anthropic's own web search tells it, which Claude Code's
 		// WebSearch counts and takes its links from
 		e.close()
+		e.cites = append(e.cites, citationsOf(ev.Hits)...)
 		id := "srvtoolu_" + newID()
 		query, _ := json.Marshal(map[string]string{"query": ev.Text})
 		e.w.event("content_block_start", map[string]any{"type": "content_block_start", "index": e.index,
@@ -1597,13 +1610,19 @@ func (e *anthropicEncoder) finish() {
 // renderAnthropic is the non-streaming reply.
 func renderAnthropic(res Result, model string) []byte {
 	content := []any{}
+	var cites []any
 	for _, p := range res.Parts {
 		switch p.Kind {
 		case Text:
 			if p.Text == "" && p.Signature != "" {
 				continue // only Gemini's signature, which is Gemini's
 			}
-			content = append(content, map[string]any{"type": "text", "text": p.Text})
+			block := map[string]any{"type": "text", "text": p.Text}
+			if len(cites) > 0 {
+				// what the searches before it quoted (#3447)
+				block["citations"] = cites
+			}
+			content = append(content, block)
 		case Thinking:
 			switch {
 			case p.sealedBy(sealAnthropic):
@@ -1621,6 +1640,7 @@ func renderAnthropic(res Result, model string) []byte {
 			content = append(content, map[string]any{"type": "tool_use", "id": anthropicOutID(id), "name": p.Name, "input": argsOf(p)})
 		case Search:
 			id := "srvtoolu_" + newID()
+			cites = append(cites, citationsOf(p.Hits)...)
 			content = append(content,
 				map[string]any{"type": "server_tool_use", "id": id, "name": "web_search", "input": map[string]any{"query": p.Text}},
 				searchResultBlock(id, p.Hits))
@@ -1653,12 +1673,36 @@ func searchResultBlock(id string, hits []Hit) map[string]any {
 		if h.PageAge != "" {
 			age = h.PageAge
 		}
-		results = append(results, map[string]any{"type": "web_search_result", "title": h.Title, "url": h.URL,
-			"encrypted_content": "", "page_age": age})
+		page := map[string]any{"type": "web_search_result", "title": h.Title, "url": h.URL,
+			"encrypted_content": "", "page_age": age}
+		if h.CitedText != "" {
+			page["cited_text"] = h.CitedText
+		}
+		results = append(results, page)
 	}
 	return map[string]any{"type": "web_search_tool_result", "tool_use_id": id, "content": results}
 }
 
+// citedTextMost is the most of a page a citation quotes, as much as
+// Anthropic's own web search says of one.
+const citedTextMost = 150
+
+// citationsOf is the citations the text that read a search's pages
+// carries: each page the search quoted something of, with where it is and
+// what was quoted of it (#3447). A page nothing was quoted of gives no
+// citation, as none is invented.
+func citationsOf(hits []Hit) []any {
+	var cites []any
+	for _, h := range hits {
+		if h.CitedText == "" {
+			continue
+		}
+		cites = append(cites, map[string]any{"type": "web_search_result_location",
+			"url": h.URL, "title": h.Title, "cited_text": h.CitedText})
+	}
+	return cites
+}
+
 // idSeq keeps ids made within one tick of the clock apart: Windows'
 // clock moves in steps of up to 15.6ms and macOS's in microseconds, so
 // the parallel calls of one Gemini chunk all got the same id.
diff --git a/internal/gateway/ir.go b/internal/gateway/ir.go
index 2426c2ed..7dde2ffb 100644
--- a/internal/gateway/ir.go
+++ b/internal/gateway/ir.go
@@ -92,6 +92,11 @@ type Hit struct {
 	URL   string `json:"url"`
 	// PageAge is how old the search said the page is, "" when it didn't
 	PageAge string `json:"page_age,omitempty"`
+	// CitedText is what the search quoted of the page: the excerpt a
+	// client reads as the page's snippet, Anthropic's citations'
+	// cited_text (#3447). "" when the search gave none, which no citation
+	// of the page is made for.
+	CitedText string `json:"cited_text,omitempty"`
 }
 
 // attachmentText is the fallback when a protocol cannot carry a Gemini file.
diff --git a/internal/gateway/search.go b/internal/gateway/search.go
index 74482345..90bc5c22 100644
--- a/internal/gateway/search.go
+++ b/internal/gateway/search.go
@@ -963,16 +963,17 @@ func (s *Server) searchWith(ctx context.Context, p provider.Provider, model, que
 			json.Unmarshal(b.Content, &results)
 			for _, raw := range results {
 				var h struct {
-					Title   string `json:"title"`
-					URL     string `json:"url"`
-					PageAge any    `json:"page_age"`
+					Title     string `json:"title"`
+					URL       string `json:"url"`
+					PageAge   any    `json:"page_age"`
+					CitedText string `json:"cited_text"`
 				}
 				if json.Unmarshal(raw, &h) != nil || h.URL == "" {
 					continue
 				}
 				age, _ := h.PageAge.(string)
 				sources = append(sources, "- "+h.Title+" — "+h.URL)
-				found = append(found, Hit{Title: h.Title, URL: h.URL, PageAge: age})
+				found = append(found, Hit{Title: h.Title, URL: h.URL, PageAge: age, CitedText: h.CitedText})
 			}
 		}
 	}
diff --git a/internal/gateway/search_api.go b/internal/gateway/search_api.go
index b58cfcd0..d926f398 100644
--- a/internal/gateway/search_api.go
+++ b/internal/gateway/search_api.go
@@ -195,7 +195,9 @@ func pagesSaid(pages []foundPage) (string, []Hit) {
 			b.WriteString(p.Text + "\n")
 		}
 		b.WriteString("\n")
-		hits = append(hits, Hit{Title: p.Title, URL: p.URL, PageAge: p.Age})
+		// what the page says, clipped as much as a citation quotes of it
+		// (#3447)
+		hits = append(hits, Hit{Title: p.Title, URL: p.URL, PageAge: p.Age, CitedText: clipText(p.Text, citedTextMost)})
 	}
 	return strings.TrimSpace(b.String()), hits
 }
diff --git a/internal/gateway/websearch_citations_test.go b/internal/gateway/websearch_citations_test.go
new file mode 100644
index 00000000..ed6fe567
--- /dev/null
+++ b/internal/gateway/websearch_citations_test.go
@@ -0,0 +1,233 @@
+package gateway
+
+import (
+	"encoding/json"
+	"fmt"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// #3447: a web search's text block carries no citations[], so a client
+// that reads citations[].cited_text for its snippets (dsh's
+// web-search-deepseek) is left with urls alone. Where magpie searches for
+// the model, the blocks are magpie's own making: an excerpt a searcher
+// quoted of a page, or a search API's text of it, is carried as the
+// citations of the text that read it. A search that quoted nothing gives
+// no citation, as none is invented.
+
+// citationSearcher serves as a searcher's Anthropic API, answering the
+// search with the pages it found, each with the excerpt quoted of it when
+// quoted, else sealed as DeepSeek's are, with nothing quoted.
+func citationSearcher(t *testing.T, quoted bool) {
+	t.Helper()
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if strings.HasSuffix(r.URL.Path, "/models") {
+			io.WriteString(w, `{"data":[{"id":"m1"}]}`)
+			return
+		}
+		b, _ := io.ReadAll(r.Body)
+		if !strings.HasSuffix(r.URL.Path, "/v1/messages") || !strings.Contains(string(b), `"web_search_20250305"`) {
+			http.NotFound(w, r)
+			return
+		}
+		quote := func(cited, sealed string) string {
+			if quoted {
+				return `,"cited_text":"` + cited + `"`
+			}
+			return `,"encrypted_content":"` + sealed + `"`
+		}
+		w.Header().Set("Content-Type", "application/json")
+		io.WriteString(w, `{"id":"m","type":"message","role":"assistant","model":"m1","content":[
+			{"type":"server_tool_use","id":"call_1","name":"web_search","input":{"query":"今天上海天气"}},
+			{"type":"web_search_tool_result","tool_use_id":"call_1","content":[
+				{"type":"web_search_result","title":"上海天气预报","url":"https://www.weather.com.cn/weather/101020100.shtml","page_age":null`+quote("上海今天小雨，22/17℃。", "SEALED")+`},
+				{"type":"web_search_result","title":"上海当前天气","url":"http://pc.weathercn.com/weather/106577/","page_age":"October 3, 2026"`+quote("多云转晴，风力三到四级。", "SEALED-2")+`}]},
+			{"type":"text","text":"上海今天小雨。"}],
+			"stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50}}`)
+	}))
+	t.Cleanup(srv.Close)
+	glm, _ := newBlindModel(t)
+	searchesOn(t, provider.Anthropic, srv.URL)
+	save(t,
+		provider.Provider{ID: "searcher", Name: "Searcher", Key: "k", Anthropic: srv.URL + "/anthropic", Models: []string{"m1"}},
+		provider.Provider{ID: "glm", Name: "GLM", Key: "k", Chat: glm.URL, Models: []string{"glm-flash"}})
+}
+
+const citationQuery = `{"model":"glm/glm-flash","max_tokens":3000,"stream":%t,"messages":[{"role":"user","content":"用 web_search 工具搜索：今天上海天气"}],"tools":[{"type":"web_search_20250305","name":"web_search"}]}`
+
+// searchEvents reads a streamed reply: the block each start began, the
+// deltas in order.
+func searchEvents(t *testing.T, body string) (starts map[string]map[string]any, deltas []map[string]any, results []map[string]any) {
+	t.Helper()
+	starts = map[string]map[string]any{}
+	for _, line := range strings.Split(body, "\n") {
+		data, ok := strings.CutPrefix(line, "data: ")
+		if !ok {
+			continue
+		}
+		var ev struct {
+			Type         string         `json:"type"`
+			ContentBlock map[string]any `json:"content_block"`
+			Delta        map[string]any `json:"delta"`
+		}
+		if json.Unmarshal([]byte(data), &ev) != nil {
+			continue
+		}
+		switch ev.Type {
+		case "content_block_start":
+			starts[ev.ContentBlock["type"].(string)] = ev.ContentBlock
+			if ev.ContentBlock["type"] == "web_search_tool_result" {
+				results = append(results, ev.ContentBlock)
+			}
+		case "content_block_delta":
+			deltas = append(deltas, ev.Delta)
+		}
+	}
+	return starts, deltas, results
+}
+
+func citationOf(t *testing.T, v any) map[string]any {
+	t.Helper()
+	b, err := json.Marshal(v)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var c map[string]any
+	if json.Unmarshal(b, &c) != nil {
+		t.Fatalf("citation %v", v)
+	}
+	return c
+}
+
+// The searcher's excerpts reach the client as the citations of the text
+// that read it, streamed: each a web_search_result_location naming the
+// page and what was quoted of it, ahead of the text itself.
+func TestWebSearchCitationsCarriedToText(t *testing.T) {
+	searchSandbox(t)
+	citationSearcher(t, true)
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages",
+		strings.NewReader(fmt.Sprintf(citationQuery, true))))
+	if rec.Code != 200 {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	starts, deltas, results := searchEvents(t, rec.Body.String())
+	text := starts["text"]
+	if text == nil {
+		t.Fatal("no text block")
+	}
+	if _, ok := text["citations"]; !ok {
+		t.Fatalf("the text block carries no citations: %v", text)
+	}
+	var textSeen bool
+	var cites []map[string]any
+	for _, d := range deltas {
+		switch d["type"] {
+		case "citations_delta":
+			if textSeen {
+				t.Fatalf("a citation after its text: %v", d)
+			}
+			cites = append(cites, citationOf(t, d["citation"]))
+		case "text_delta":
+			textSeen = true
+		}
+	}
+	if len(cites) != 2 {
+		t.Fatalf("citations %v", cites)
+	}
+	for i, want := range []map[string]string{
+		{"url": "https://www.weather.com.cn/weather/101020100.shtml", "title": "上海天气预报", "cited_text": "上海今天小雨，22/17℃。"},
+		{"url": "http://pc.weathercn.com/weather/106577/", "title": "上海当前天气", "cited_text": "多云转晴，风力三到四级。"},
+	} {
+		c := cites[i]
+		if c["type"] != "web_search_result_location" || c["url"] != want["url"] ||
+			c["title"] != want["title"] || c["cited_text"] != want["cited_text"] {
+			t.Fatalf("citation %d: %v", i, c)
+		}
+	}
+	if len(results) == 0 {
+		t.Fatal("no web_search_tool_result block")
+	}
+	content, _ := results[0]["content"].([]any)
+	first, _ := content[0].(map[string]any)
+	if first["cited_text"] != "上海今天小雨，22/17℃。" {
+		t.Fatalf("the result carries no excerpt: %v", first)
+	}
+	if first["encrypted_content"] != "" {
+		t.Fatalf("the searcher's sealed content reached the client: %v", first)
+	}
+}
+
+// The same on a reply asked whole.
+func TestWebSearchCitationsWholeReply(t *testing.T) {
+	searchSandbox(t)
+	citationSearcher(t, true)
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages",
+		strings.NewReader(fmt.Sprintf(citationQuery, false))))
+	if rec.Code != 200 {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	var out struct {
+		Content []map[string]any `json:"content"`
+	}
+	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
+		t.Fatal(err)
+	}
+	var cites []any
+	for _, b := range out.Content {
+		if b["type"] == "text" {
+			c, _ := b["citations"].([]any)
+			cites = c
+		}
+	}
+	if len(cites) != 2 {
+		t.Fatalf("citations %v", cites)
+	}
+	c := citationOf(t, cites[0])
+	if c["type"] != "web_search_result_location" || c["url"] != "https://www.weather.com.cn/weather/101020100.shtml" ||
+		c["cited_text"] != "上海今天小雨，22/17℃。" {
+		t.Fatalf("citation %v", c)
+	}
+}
+
+// A search that quoted nothing of its pages gives no citation: none is
+// invented, and the sealed content of the searcher's pages stays sealed.
+func TestWebSearchWithoutExcerptsGivesNoCitations(t *testing.T) {
+	searchSandbox(t)
+	citationSearcher(t, false)
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages",
+		strings.NewReader(fmt.Sprintf(citationQuery, true))))
+	if rec.Code != 200 {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	starts, deltas, results := searchEvents(t, rec.Body.String())
+	if starts["text"] == nil {
+		t.Fatal("no text block")
+	}
+	if _, ok := starts["text"]["citations"]; ok {
+		t.Fatalf("citations invented: %v", starts["text"])
+	}
+	for _, d := range deltas {
+		if d["type"] == "citations_delta" {
+			t.Fatalf("a citation invented: %v", d)
+		}
+	}
+	if len(results) == 0 {
+		t.Fatal("no web_search_tool_result block")
+	}
+	content, _ := results[0]["content"].([]any)
+	first, _ := content[0].(map[string]any)
+	if _, ok := first["cited_text"]; ok {
+		t.Fatalf("an excerpt invented: %v", first)
+	}
+	if first["encrypted_content"] != "" {
+		t.Fatalf("the searcher's sealed content reached the client: %v", first)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
