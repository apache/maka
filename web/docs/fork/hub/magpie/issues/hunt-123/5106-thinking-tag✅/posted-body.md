@neighbads's analysis and patch here are correct — I verified them independently and confirm. One property worth stating for review, and a branch with two extra table cases below.

## What's wrong

As reported: a Chat reply whose reasoning arrives wrapped in the text as `<thinking>…</thinking>` is handed to the agent as the answer's own text, with no thinking block. Over one recorded day on one OpenAI-compatible host, 47 of 2832 turns carried a literal `<thinking` in the answer's text blocks, 44 of them at offset 0 — the leading position the decoder does read (neighbads's data).

## Root cause

`thoughtTags` in `internal/gateway/chat.go` held only `<thought>` and `<think>`, so `chatDecoder.text` matched neither tag and took the whole block for the answer. `chatDecoder.markedThought` reads the same map, so it is fixed by the same entry.

The property worth stating: a reviewer may ask whether a lead of `<thinking>` could be misread as `<think>` depending on Go's randomized map iteration in `text`'s opening-tag loop. It cannot. `<think>` is seven bytes ending in `>`; `<thinking>` has `i` there, so `strings.HasPrefix(lead, o)` names at most one opening tag for any lead of seven bytes or more. Shorter leads are all held back by the existing wait (`len(lead) < len(open) && strings.HasPrefix(open, lead)`), `<think>` itself included, since it is a prefix of `<thinking>`. So the one-line map entry alone is deterministic — confirmed below with 20 consecutive runs of the new table cases. neighbads's patch on their fork and mine below are the same change; either can land.

## The fix

`<thinking>` added beside the two, closed by `</thinking>`; the doc comment follows; four table cases in `TestChatThoughtTags` (neighbads's whole and split-tag cases, plus the open tag alone as a chunk, and a never-closed one).

Sibling surface, changed or not:

- changed: `thoughtTags` — the one map, read by both `chatDecoder.text` (streaming) and `chatDecoder.markedThought` (Gemini-marked chunks, #2098), so one entry covers both paths
- not changed: `afterThought` (chat.go, called from codex_titles.go) — strips a leading block for titles and descriptions with its own literal `<think>`; a `<thinking>`-led reply would keep the block in a generated title. Out of this patch's scope (the streaming path); worth its own issue if that path matters in practice
- not changed: `decoderFor`'s plugin path (gateway.go) — a plugin's Chat text is read as it came (`past: true`, Qoder #2634), so no tag stripping happens there by design
- not changed: the plugins repo's think-tags middleware — separate repository, as neighbads noted

```diff
diff --git a/internal/gateway/aistudio_thinking_test.go b/internal/gateway/aistudio_thinking_test.go
index 5841158ab..58cdc892e 100644
--- a/internal/gateway/aistudio_thinking_test.go
+++ b/internal/gateway/aistudio_thinking_test.go
@@ -103,6 +103,10 @@ func TestChatThoughtTags(t *testing.T) {
 		think, text string
 	}{
 		{"whole", []string{"<thought>Greeting.</thought>Hello"}, "Greeting.", "Hello"},
+		{"<thinking> whole", []string{"<thinking>Let me think</thinking>Hi"}, "Let me think", "Hi"},
+		{"<thinking> split tags", []string{"<thin", "king>Let me", " think</thin", "king>Hi"}, "Let me think", "Hi"},
+		{"<thinking> the open tag a chunk alone", []string{"<thinking>", "Let me think", "</thinking>", "Hi"}, "Let me think", "Hi"},
+		{"<thinking> never closed", []string{"<thinking>half", " a thought</thi"}, "half a thought</thi", ""},
 		{"split tags", []string{"<tho", "ught>Let me", " think</tho", "ught>\n\nHello", " there"}, "Let me think", "Hello there"},
 		{"one byte a chunk", strings.Split("<thought>ab</thought>cd", ""), "ab", "cd"},
 		{"leading newline", []string{"\n", "<thought>x</thought>", "y"}, "x", "y"},
diff --git a/internal/gateway/chat.go b/internal/gateway/chat.go
index b269ff43d..3d5dae8b4 100644
--- a/internal/gateway/chat.go
+++ b/internal/gateway/chat.go
@@ -1126,10 +1126,10 @@ const leadSpace = " \t\r\n"
 
 // thoughtTags are the tags a leading block of thinking comes between in a
 // Chat reply's text, by its opening tag.
-var thoughtTags = map[string]string{"<thought>": "</thought>", "<think>": "</think>"}
+var thoughtTags = map[string]string{"<thought>": "</thought>", "<thinking>": "</thinking>", "<think>": "</think>"}
 
-// text sends a piece of the reply's text, a leading <thought> or <think>
-// block of it as thinking.
+// text sends a piece of the reply's text, a leading <thought>, <thinking> or
+// <think> block of it as thinking.
 func (d *chatDecoder) text(s string, emit func(Event)) {
 	if !d.past && !d.thought {
 		d.lead += s
-- 
2.50.1 (Apple Git-155)
```

SHA-256 (first 16): 81f87e8e39b03ef2

## Verification

| Check | Result |
| --- | --- |
| RED on the parent (1e1068c86, tests only, fix withheld) | `TestChatThoughtTags/<thinking>_whole`, `/<thinking>_split_tags`, `/<thinking>_the_open_tag_a_chunk_alone`, `/<thinking>_never_closed` all FAIL: `think "" text "<thinking>Let me think</thinking>Hi", want "Let me think" "Hi"` |
| Ablation, fix reverted to parent with tests kept | `--- FAIL: TestChatThoughtTags`, exit 1 |
| Ablation restored | `ok` |
| Determinism | `go test -tags nogui -count=20 -run TestChatThoughtTags ./internal/gateway` → `ok`, 20 runs in a row |
| Streaming under race | `go test -tags nogui -race -run 'TestChatThoughtTags\|TestChatThoughtTagsToAnthropic\|TestAIStudioThinking' ./internal/gateway` → `ok` |
| Full package | `go test -tags nogui -timeout 25m ./internal/gateway/...` → see below |
| `gofmt -l` on both files | nothing |
| `go vet -tags nogui ./internal/gateway` | nothing |
| `go build -tags nogui ./...` | ok (only the preexisting cgo `-Wenum-conversion` warnings in internal/gui) |

Full package: `ok github.com/yetone/magpie/internal/gateway 603.148s`, exit 0 — no failures, including none of the tests previously known to flake red here.

## Not verified

- The reported host's behavior itself: not reproducible on demand (neighbads: 8 direct asks with `reasoning_effort: "max"` produced no tag), so coverage is decoder-level tests only.
- `afterThought`'s title path with a `<thinking>`-led reply has no test in this patch (left for a possible follow-up, see above).

AI use: written by GLM-5.3-Flash (ZCode), verified as shown above.
Attribution: AI-written; please keep the author (ggbdpq) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: https://github.com/ggbdpq/magpie/tree/fix/5106-thinking-tag (head 7e3f194b2025f37452457da506fd81886145598c)

