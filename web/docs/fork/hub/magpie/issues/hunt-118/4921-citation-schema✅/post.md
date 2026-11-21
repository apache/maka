The reporter's thread is a Codex history carrying a citation the backend will not take back, and magpie wrote it there — so magpie takes it out, at both ends, the way the reasoning-item fix did.

**Symptom**: a thread in an auto-routing group was served once by a Responses upstream whose `url_citation` annotations carry no `start_index`/`end_index` (Volcengine's Ark writes them so). Every later turn the group sent to a `codex/*` member failed on the replayed history, five retries each, always the same parameter:

    stream disconnected before completion: Codex: Invalid response.create payload: Missing required parameter: 'input[221].content[0].annotations[0].start_index'.

A new thread worked; this one never did again, on any codex member, through any upgrade.

**Minimal repro**: the smallest poisoned history is one message whose `output_text` part carries `annotations:[{"type":"url_citation","url":"https://example.com","title":"e"}]`. Sent to the codex relay, the backend refuses it with the error above (the reporter's step 4). On the planting side: a whole reply from such a vendor, streamed by magpie as its events, reaches the client with the citation in every place the client reads one, and the client keeps what it is handed.

**Root cause**: the whole reply that magpie streams as the vendor's own events relayed each annotation verbatim — in the `response.output_text.annotation.added` events, in `content_part.done`, in `output_item.done` and in the `response.completed` object, all four places a client reads a citation from. And the turn magpie relays to the ChatGPT backend (`codexInputAs`) sent the stored history back as it came. OpenAI's schema wants both offsets on every annotation kind; a citation without them cannot be re-sent anywhere that schema holds, so the item the client stored poisoned the thread's replay forever. This is #2855's defect with a different field: what magpie hands a client must be something magpie could send again.

**Fix**: take the unsendable citations out, at both seams, as #2855 did (`reasoningTidy` client-bound, `a3ebed20` upstream-bound):

- `responsesWholeEvents` tidies a message item's parts once, before they are streamed, and tidies the reply object the client keeps; a citation whose offsets are absent (or null) goes, the text and a citation that carries its offsets go as the vendor wrote them. One rule covers all four places a client reads.
- `codexInputAs` strips such citations from the replayed history on its way to the ChatGPT backend, so a thread already poisoned heals on its next turn — no new thread needed, which is the reporter's own first ask. The turn scan (`codexInputItemChanges`) sees a citation without decoding the conversation: an item that names no `"annotations"` costs one `bytes.Contains`, and a turn with nothing to change is not decoded at all, as #1532 asks (the undecoded-turn harness still passes, allocations and all).
- Why drop rather than fill: the schema requires both offsets, and a vendor that omits them says nothing about where the citation sits — a filled `0/len` would highlight text the citation is not about. Dropping the annotation keeps the text, which is what the thread needs to keep working.

Siblings, read on the way and left: the translated servings make `annotations: []` themselves (`responses.go`, `gathered.go`, `codex_titles.go`) and cannot plant this; Anthropic's own citations (`search_cite.go`, `anthropic.go`) ride Anthropic's schema to Anthropic clients; MCP tool `annotations` are another member entirely. A streamed vendor reply relayed byte for byte is not touched — no vendor is known to stream offsetless citations, and anything it planted would be stripped at replay by the same rule, so the thread still never 400s; if one shows up, the same rule goes into a tidy beside `reasoningTidy`.

**Verification**:

| What | Command | Result |
|---|---|---|
| The three new tests, fixed tree | `go test -tags nogui -count=1 -run 'TestWholeAsStreamDropsCitationsWithoutOffsets\|TestCodexOwnModelDropsCitationsWithoutOffsets\|TestCodexInputScanSeesCitationsWithoutOffsets' ./internal/gateway/` | ok, 3/3 |
| Red before the fix (ablation: product files restored from `a3768cdd1`, tests kept, tree compiles) | same run | all three fail — the citation relays to the client, to the backend, and the scan misses it, exactly the reporter's shape |
| Scan/rewrite parity over marked and fuzzed sessions | `go test -tags nogui -count=1 -run 'TestCodexRewritesAsBefore\|TestCodexRewritesLeaveTurnUndecoded\|FuzzCodexRewritesAsBefore' ./internal/gateway/` | ok, seed corpus |
| Full gateway suite | `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/` | one failure: `TestCodexPoolSaysTheClientsVersion` — pre-existing, host-dependent, and not this diff's: the pristine `a3768cdd1` suite fails the same single test the same way (it reads the codex CLI installed on this machine through `codexVersion`'s 10-minute cache, so the pinned `0.161.0` comes back `0.165.0` in a full run); green alone on both base and fixed trees |
| vet | `go vet ./internal/gateway/` and `GOOS=linux` / `GOOS=windows` | clean ×3 (`go vet ./...` has the pre-existing gui cgo warnings and the wails linux module errors, none in this diff) |
| build | `go build -tags nogui .` darwin, `GOOS=linux`, `GOOS=windows` | ok ×3 |
| format | `gofmt -l` on the five touched files | clean |
| git am | fresh worktree at `a3768cdd1`, `git am` the posted patch | applies; tree hash `4629d7629` equals the branch head's |

**Not verified**: Volcengine's Ark against a real account (the fix is tested against the annotation shape the reporter captured, through a fake upstream), and Codex desktop replaying a healed thread end to end.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

**Patch**: <details><summary>patch: fix(gateway): drop a relayed citation whose offsets the schema wants (#4921) — git am applies it as is; SHA-256 first 16: 88463b3c761673a2</summary>

```diff
From 57dc7b42051954a9801ed4846357e715dbf10e25 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 22:40:26 +0800
Subject: [PATCH] fix(gateway): drop a relayed citation whose offsets the
 schema wants (#4921)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: a Responses upstream of another vendor can write its
url_citation annotations without start_index/end_index (Volcengine's Ark
does), and the relay handed them to the client as they came. Codex stores
what it is handed and replays it, and where OpenAI's schema holds, the
replay is refused whole — "Missing required parameter:
'input[N].content[0].annotations[0].start_index'" — on every later turn
of the thread. Magpie now takes such a citation out at both seams, as
the reasoning-item fix did (#2855, a3ebed20):

- a whole reply streamed as the vendor's own events (responsesWholeEvents)
  carries no offsetless citation in its annotation events, nor in the
  item and the reply the client keeps;
- the thread history Codex replays (codexInputAs, the relay to the
  ChatGPT backend) loses the citations that cannot be sent there, so a
  thread a vendor's reply already poisoned heals on its next turn.

The text and a citation that carries its offsets go as they came; the
input scan stays off the conversation unless an item names "annotations".

Run: the three new tests fail on a3768cdd1 with the reporter's shape
relaying as it came, and pass on the fixed tree (ablation: product files
restored from the base, tests kept, all three red); go test -tags nogui
-count=1 ./internal/gateway/; go vet ./... and GOOS=linux/windows go vet
./internal/gateway/; go build -tags nogui on darwin, GOOS=linux and
GOOS=windows; gofmt -l clean.

Fixes #4921

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_backend.go           | 77 +++++++++++++++++++++
 internal/gateway/codex_backend_test.go      | 54 +++++++++++++++
 internal/gateway/codex_rewrite_scan_test.go | 19 +++++
 internal/gateway/quiet_whole_test.go        | 52 ++++++++++++++
 internal/gateway/whole_stream.go            | 43 ++++++++++++
 5 files changed, 245 insertions(+)

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 42768883c..ccf8607ce 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -2412,6 +2412,9 @@ func codexInputAs(body []byte, magpieModel, native bool) (_ []byte, compact bool
 			}
 			out = append(out, it)
 		default:
+			if !magpieModel && dropCitationsWithoutOffsets(it) {
+				changed = true
+			}
 			out = append(out, it)
 		}
 	}
@@ -2483,10 +2486,84 @@ func codexInputItemChanges(it []byte, magpieModel, native bool) bool {
 		}
 		enc, _ := stringBytes(memberOrNil(it, "encrypted_content"))
 		return len(enc) == 0 || hasPrefix(enc, claudeseal.Mark)
+	case !magpieModel:
+		// whatever else carries an output_text part — the message items
+		// that do on the wire, any item that carries one off it — a
+		// citation without its offsets goes (#4921)
+		return hasCitationWithoutOffsets(it)
+	}
+	return false
+}
+
+// hasCitationWithoutOffsets reports whether it, an input item, carries an
+// output_text annotation without both of the offsets OpenAI's schema
+// wants: read as the scan reads it, without decoding the conversation.
+func hasCitationWithoutOffsets(it []byte) bool {
+	if !bytes.Contains(it, []byte(`"annotations"`)) {
+		return false
+	}
+	for _, part := range elementsOf(memberOrNil(it, "content")) {
+		if !bytes.Contains(part, []byte(`"annotations"`)) {
+			continue
+		}
+		if typ, _ := stringBytes(memberOrNil(part, "type")); string(typ) != "output_text" {
+			continue
+		}
+		for _, a := range elementsOf(memberOrNil(part, "annotations")) {
+			if citationWithoutOffsets(a) {
+				return true
+			}
+		}
 	}
 	return false
 }
 
+// citationWithoutOffsets is whether an annotation lacks start_index or
+// end_index, as absent or null. OpenAI's schema wants both of every kind,
+// and one without them — a url_citation as another vendor's Responses
+// reply writes it (Volcengine's Ark, #4921) — cannot be sent back there.
+func citationWithoutOffsets(a []byte) bool {
+	for _, k := range []string{"start_index", "end_index"} {
+		v := memberOrNil(a, k)
+		if len(v) == 0 || string(v) == "null" {
+			return true
+		}
+	}
+	return false
+}
+
+// dropCitationsWithoutOffsets takes an input item's output_text
+// annotations that carry no offsets, which the backend refuses the replay
+// of the history whole ("Missing required parameter:
+// 'input[N].content[0].annotations[0].start_index'"), every later turn of
+// the thread with it (#4921). The text and a citation with its offsets
+// stay. It reports whether it took one out.
+func dropCitationsWithoutOffsets(it map[string]any) bool {
+	content, _ := it["content"].([]any)
+	changed := false
+	for _, c := range content {
+		part, ok := c.(map[string]any)
+		if !ok || part["type"] != "output_text" {
+			continue
+		}
+		notes, _ := part["annotations"].([]any)
+		kept := notes[:0]
+		dropped := false
+		for _, n := range notes {
+			a, ok := n.(map[string]any)
+			if !ok || a["start_index"] == nil || a["end_index"] == nil {
+				changed, dropped = true, true
+				continue
+			}
+			kept = append(kept, n)
+		}
+		if dropped {
+			part["annotations"] = kept
+		}
+	}
+	return changed
+}
+
 // turnMetadataHeader is where Codex says what a request is for, as it does
 // in client_metadata's x-codex-turn-metadata too.
 const turnMetadataHeader = "X-Codex-Turn-Metadata"
diff --git a/internal/gateway/codex_backend_test.go b/internal/gateway/codex_backend_test.go
index 45a8d66af..ba33638ce 100644
--- a/internal/gateway/codex_backend_test.go
+++ b/internal/gateway/codex_backend_test.go
@@ -902,6 +902,60 @@ func TestCodexOwnModelKeepsReasoningWithNullContent(t *testing.T) {
 	}
 }
 
+// The thread history Codex replays keeps what another vendor's Responses
+// reply planted in it (#4921): a citation without the offsets OpenAI's
+// schema wants (Volcengine's Ark writes its url_citation so) has the
+// backend refuse the replay whole ("Missing required parameter:
+// 'input[N].content[0].annotations[0].start_index'"), every later turn of
+// the thread with it. It goes before the turn does; the text and a
+// citation with its offsets go as their item comes.
+func TestCodexOwnModelDropsCitationsWithoutOffsets(t *testing.T) {
+	bad := `{"type":"url_citation","title":"V","url":"https://example.com/v","site_name":"Ark","publish_time":"2026-11-02","summary":"s"}`
+	good := `{"type":"url_citation","start_index":90,"end_index":152,"url":"https://example.com/g","title":"G"}`
+	body := `{"model":"gpt-5.5","input":[{"type":"message","role":"assistant","id":"msg_1","content":[{"type":"output_text","text":"Sun.","annotations":[` + good + `,` + bad + `]}]}]}`
+	got, _ := codexInput([]byte(body), false)
+	if strings.Contains(string(got), "site_name") || strings.Contains(string(got), "publish_time") {
+		t.Fatalf("the citation without its offsets went to the backend:\n%s", got)
+	}
+	if !strings.Contains(string(got), `"url":"https://example.com/g"`) || !strings.Contains(string(got), `"text":"Sun."`) {
+		t.Fatalf("the text or the citation with its offsets went with it:\n%s", got)
+	}
+	// a thread whose citations carry their offsets goes as it came
+	clean := `{"model":"gpt-5.5","input":[{"type":"message","role":"assistant","id":"msg_1","content":[{"type":"output_text","text":"Sun.","annotations":[` + good + `]}]}]}`
+	if got, _ := codexInput([]byte(clean), false); string(got) != clean {
+		t.Fatalf("input: %s", got)
+	}
+	// magpie's own models take the history as it came
+	if got, _ := codexInput([]byte(body), true); string(got) != body {
+		t.Fatalf("magpie input: %s", got)
+	}
+}
+
+// The turn scan says what the rewrite does, without decoding the
+// conversation: a citation without its offsets (#4921) on an output_text
+// part of a message, and no change for one with them, for the same
+// annotation on an input_text part, and for a turn without annotations.
+func TestCodexInputScanSeesCitationsWithoutOffsets(t *testing.T) {
+	bad := `{"type":"message","content":[{"type":"output_text","text":"x","annotations":[{"type":"url_citation","url":"u"}]}]}`
+	if !codexInputItemChanges([]byte(bad), false, false) {
+		t.Fatal("the scan missed a citation without its offsets")
+	}
+	if codexInputItemChanges([]byte(bad), true, false) {
+		t.Fatal("the scan has something to do for a magpie model")
+	}
+	good := `{"type":"message","content":[{"type":"output_text","text":"x","annotations":[{"type":"url_citation","start_index":0,"end_index":1,"url":"u"}]}]}`
+	if codexInputItemChanges([]byte(good), false, false) {
+		t.Fatal("the scan has something to do in a turn whose citations carry their offsets")
+	}
+	onInput := `{"type":"message","content":[{"type":"input_text","text":"x","annotations":[{"type":"url_citation","url":"u"}]}]}`
+	if codexInputItemChanges([]byte(onInput), false, false) {
+		t.Fatal("the scan has something to do in a turn whose annotations are not an output's")
+	}
+	if codexInputItemChanges([]byte(`{"type":"message","content":[{"type":"output_text","text":"the \"annotations\" member"}]}`), false, false) {
+		t.Fatal("the scan has something to do in a turn that only names annotations")
+	}
+}
+
 // Codex signed in with an API key OpenAI refuses, asked for one of its own
 // models: the refusal says what happened and what to do.
 func TestCodexOwnModelKeyRefused(t *testing.T) {
diff --git a/internal/gateway/codex_rewrite_scan_test.go b/internal/gateway/codex_rewrite_scan_test.go
index 0dca08039..9e3649ecf 100644
--- a/internal/gateway/codex_rewrite_scan_test.go
+++ b/internal/gateway/codex_rewrite_scan_test.go
@@ -167,6 +167,22 @@ var codexMarks = []func(it map[string]any){
 	func(it map[string]any) { it["encrypted_content"] = nil },
 	func(it map[string]any) { it["type"] = "context_compaction"; it["encrypted_content"] = "gAAAA" },
 	func(it map[string]any) { it["internal_chat_message_metadata_passthrough"] = nil },
+	// a citation another vendor's reply planted without the offsets
+	// OpenAI's schema wants (#4921), beside one with them
+	func(it map[string]any) {
+		it["content"] = []any{map[string]any{"type": "output_text", "text": "t", "annotations": []any{
+			map[string]any{"type": "url_citation", "start_index": 0, "end_index": 1, "url": "https://example.com/g", "title": "G"},
+			map[string]any{"type": "url_citation", "url": "https://example.com/v", "title": "V", "site_name": "Ark", "publish_time": "2026-11-02", "summary": "s"},
+		}}}
+	},
+	func(it map[string]any) {
+		it["content"] = []any{map[string]any{"type": "output_text", "text": "t", "annotations": []any{
+			map[string]any{"type": "url_citation", "start_index": nil, "end_index": 1, "url": "https://example.com/v", "title": "V"},
+		}}}
+	},
+	func(it map[string]any) {
+		it["content"] = []any{map[string]any{"type": "input_text", "text": "t", "annotations": []any{map[string]any{"type": "url_citation", "url": "u"}}}}
+	},
 }
 
 // codexRawMarks are what a map can't say: duplicate and escaped keys,
@@ -340,6 +356,9 @@ func wasCodexInputAs(body []byte, magpieModel, native bool) (_ []byte, compact b
 			}
 			out = append(out, it)
 		default:
+			if !magpieModel && dropCitationsWithoutOffsets(it) {
+				changed = true
+			}
 			out = append(out, it)
 		}
 	}
diff --git a/internal/gateway/quiet_whole_test.go b/internal/gateway/quiet_whole_test.go
index 3742ae134..2239516af 100644
--- a/internal/gateway/quiet_whole_test.go
+++ b/internal/gateway/quiet_whole_test.go
@@ -257,6 +257,58 @@ func TestWholeAsStreamResponsesCitations(t *testing.T) {
 	}
 }
 
+// A citation another vendor's Responses reply wrote without the offsets
+// OpenAI's schema wants (Volcengine's Ark writes its url_citation so,
+// #4921) goes to no one: the client stores what it is handed and replays
+// it where the backend refuses the reply whole ("Missing required
+// parameter: 'input[N].content[0].annotations[0].start_index'"), the
+// thread's every later turn with it. The text and a citation with its
+// offsets stay, in the citation events and in the item and the reply the
+// client keeps.
+func TestWholeAsStreamDropsCitationsWithoutOffsets(t *testing.T) {
+	rec := httptest.NewRecorder()
+	good := `{"type":"url_citation","start_index":0,"end_index":4,"url":"https://example.com/g","title":"G"}`
+	bad := `{"type":"url_citation","title":"V","url":"https://example.com/v","site_name":"Ark","publish_time":"2026-11-02","summary":"s"}`
+	if !wholeAsStream(rec, provider.Responses, []byte(`{"id":"resp_1","object":"response","created_at":1,"status":"completed","model":"m","output":[{"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Sun.","annotations":[`+good+`,`+bad+`]}]}]}`)) {
+		t.Fatal("not streamed")
+	}
+	got := rec.Body.String()
+	if strings.Contains(got, "site_name") || strings.Contains(got, "publish_time") {
+		t.Fatalf("the citation without its offsets went out:\n%s", got)
+	}
+	var added, done, completed int
+	for _, ev := range events(got) {
+		switch ev["type"] {
+		case "response.output_text.annotation.added":
+			added++
+			a, _ := ev["annotation"].(map[string]any)
+			if a["url"] != "https://example.com/g" || a["start_index"] != float64(0) {
+				t.Fatalf("annotation.added: %v", ev)
+			}
+		case "response.output_item.done":
+			done++
+			it, _ := ev["item"].(map[string]any)
+			part, _ := it["content"].([]any)[0].(map[string]any)
+			notes, _ := part["annotations"].([]any)
+			if len(notes) != 1 || notes[0].(map[string]any)["url"] != "https://example.com/g" {
+				t.Fatalf("item done: %v", ev)
+			}
+		case "response.completed":
+			completed++
+			out, _ := ev["response"].(map[string]any)["output"].([]any)
+			it, _ := out[0].(map[string]any)
+			part, _ := it["content"].([]any)[0].(map[string]any)
+			notes, _ := part["annotations"].([]any)
+			if len(notes) != 1 || notes[0].(map[string]any)["url"] != "https://example.com/g" {
+				t.Fatalf("completed: %v", ev)
+			}
+		}
+	}
+	if added != 1 || done != 1 || completed != 1 || !strings.Contains(got, `"text":"Sun."`) {
+		t.Fatalf("added=%d done=%d completed=%d\n%s", added, done, completed, got)
+	}
+}
+
 // A held try's reply under a type that says neither JSON nor a stream,
 // once the agent has a stream's headers: its first bytes decide, however
 // they are split. A stream is held as a stream from there, read event by
diff --git a/internal/gateway/whole_stream.go b/internal/gateway/whole_stream.go
index a7d585dea..e3bd4e4e6 100644
--- a/internal/gateway/whole_stream.go
+++ b/internal/gateway/whole_stream.go
@@ -183,6 +183,7 @@ func responsesWholeEvents(b []byte) []wholeEvent {
 	}
 	send("response.created", obj{"response": raw(begun)})
 	send("response.in_progress", obj{"response": raw(begun)})
+	cleaned := false
 	for i, item := range output {
 		at, id := raw(i), item["id"]
 		added := maps.Clone(item)
@@ -193,6 +194,10 @@ func responsesWholeEvents(b []byte) []wholeEvent {
 		switch str(item, "type") {
 		case "message":
 			json.Unmarshal(item["content"], &parts)
+			if tidyCitations(parts) {
+				cleaned = true
+				item["content"] = raw(parts)
+			}
 			added["content"] = raw([]any{})
 			send("response.output_item.added", obj{"output_index": at, "item": raw(added)})
 			for j, part := range parts {
@@ -255,6 +260,10 @@ func responsesWholeEvents(b []byte) []wholeEvent {
 		}
 		send("response.output_item.done", obj{"output_index": at, "item": raw(item)})
 	}
+	if cleaned {
+		// the reply the client keeps carries the tidied items too
+		v["output"] = raw(output)
+	}
 	end := "response.completed"
 	switch str(v, "status") {
 	case "incomplete":
@@ -266,6 +275,40 @@ func responsesWholeEvents(b []byte) []wholeEvent {
 	return events
 }
 
+// tidyCitations takes a message item's content parts' output_text
+// annotations that carry no offsets, as another vendor's Responses reply
+// writes its citations (Volcengine's Ark, #4921): the client stores what
+// it is handed and replays it where OpenAI's schema holds, and there a
+// reply history carrying one is refused whole ("Missing required
+// parameter: 'input[N].content[0].annotations[0].start_index'"), the
+// thread's every later turn with it. The text and a citation with its
+// offsets stay. It reports whether it took one out.
+func tidyCitations(parts []obj) bool {
+	changed := false
+	for _, part := range parts {
+		if str(part, "type") != "output_text" {
+			continue
+		}
+		var notes []json.RawMessage
+		if json.Unmarshal(part["annotations"], &notes) != nil {
+			continue
+		}
+		kept := notes[:0]
+		dropped := false
+		for _, a := range notes {
+			if citationWithoutOffsets(a) {
+				changed, dropped = true, true
+				continue
+			}
+			kept = append(kept, a)
+		}
+		if dropped {
+			part["annotations"] = raw(kept)
+		}
+	}
+	return changed
+}
+
 // anthropicWholeEvents streams an Anthropic message: started with no
 // content, each block started empty with what it holds as its deltas — a
 // text's citations and text, a thinking's thought and signature, a tool
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [fix/4921-citation-schema](https://github.com/ggbdpq/magpie/tree/fix/4921-citation-schema) (head `57dc7b420`).
