@yetone — the report's own replay pins it: a Chat Completions client asking magpie for a MiniMax-M3 turn received the model's thinking as ordinary `content`, a leading `<think>…</think>` the client cannot fold, while the same reply's usage row still counted the reasoning tokens (`first_text_ms == ttft_ms` on both rows: the first token the client could see was text, not a separate reasoning channel). Thank you @ArmedHelicopter for the two `usage.jsonl` rows and the client replay — "no `reasoning`, `reasoning_content`, or `reasoning_text` field in the completion" is the observation that decides between the two places this could break.

**Root cause**: the reply was relayed, not translated. `relayable` is true for a Chat client against MiniMax's Chat endpoint (the client's own API is among `usable`), and nothing on the relay chain turned it off for MiniMax — so `passthrough` forwarded the upstream's bytes as they came. The `<think>` lift lives in `chatDecoder.text`, which only the translated path runs (`translate` always asks the upstream streamed and reads it through the decoder, streamed or whole); `chatEncoder` and `renderChat` do say `reasoning_content`, but a relayed reply never reaches them. #1267's lift and `buildChat`'s write-back were built as a pair for exactly this provider; the relayed route broke the pair's receiving end. The #2634 shortcut is not it: MiniMax sends no reasoning field, and had it sent one, the client would have received one — the report's rows say it did not.

**The fix** (nine lines on the relay chain, beside its siblings): a Chat API that thinks in its text is asked translated even by a Chat client — `relay, ownAPI = false, true`, the same shape the DashScope branch (a thinking model gives one JSON body only with thinking off) and the Claude-on-Messages branch (cache billing) already use. The client keeps its own endpoint, the translation takes the block out as `reasoning_content`, and `buildChat` keeps writing it back between the tags on the turns after — the pair restored. The judgment is `inlineThinkChat`: MiniMax's presets (`minimax`, `minimax-cn`) or its own hosts (api.minimax.io, api.minimaxi.com, api.minimax.cn — the host set `buildChat` already judges for the write-back, now one shared `inlineThinkHost`), never the model's name.

Sibling-face scan of the same family, each point left or changed with its reason:

- `anthropicDecoder`'s thinking blocks, `responsesDecoder`'s reasoning items, `codeAssistDecoder`'s and Claude subscription's thought parts: structured blocks and items of their own protocols, which a relay hands a same-API client as they are — nothing in text to strip. Left.
- `afterThought` (`codex_titles.go`): a title's own whole-text strip, not a reply's delivery. Left.
- the plugin decoder's `past: true` (`decoderOf`, #2634): a plugin's text `<think>` is the model's own words by design — and the reason this fix judges by provider, not by tag: a blanket strip of every Chat→Chat relay is what #2634 forbids. Left.
- other Chat→Chat relays that may think in their text (a Grok reverse proxy's `\r\n<think>` was fixed on the translated path, `TestGrokRelayThinkAfterLineEnd`): no report of a relayed one, and no host to judge one by; the chain's judgment stays with the providers known to think in text. Left.
- the chain's other `relay = false` siblings (searchedForIt, Copilot's sealing, OpenCodeFree, a Gemini body asked whole, DashScope's one-body, Codex's custom tools): same shape, different reasons, untouched.

Failure-read semantics of the new judgment: a provider with no URL (empty host) and no preset reads false — relayed as before; a preset misspelled reads false the same way. Nothing the judgment cannot read turns a MiniMax reply into a stripped one or a relayed one beyond what it was.

<details><summary>patch: gateway: MiniMax's thinking reaches a Chat client as reasoning, not as the answer's text (#5805) — git am applies it as is; SHA-256 first 16: 9f1cffc62aef5039</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 9 Nov 2026 22:17:58 +0800
Subject: [PATCH] gateway: MiniMax's thinking reaches a Chat client as
 reasoning, not as the answer's text (#5805)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A Chat client asking MiniMax's Chat API through magpie had the reply
relayed as it came, which skips the Chat decoder: the leading
<think>…</think> reached the client as the answer's text, with no
reasoning field to fold it by — the same reply's usage row still counted
the reasoning tokens. The reply is now asked translated on the client's
own Chat API all the same, where the decoder takes the block out as
thinking and the encoder says reasoning_content; buildChat still writes
it back between the tags on the turns after. MiniMax's presets (minimax,
minimax-cn) and its own hosts (api.minimax.io, api.minimaxi.com,
api.minimax.cn) are matched, not the model's name.

Verified: TestMiniMaxChatClientGetsReasoningField (a Chat client,
streamed and whole, through the gateway to a fake Chat upstream with
MiniMax-shaped chunks) fails without it (content "<think>\nThe user
greets me…</think>\n\nHello!", no reasoning field) and passes with it,
with TestMiniMaxThinkTagsReachCodexAsReasoning,
TestMiniMaxThinkingGoesBackInTags, TestChatThinkTags and
TestMiniMaxInlineThinkChat still green. The chunk shape is from MiniMax's
OpenAI-compatible docs; no real MiniMax key was tried.
---
 internal/gateway/chat.go               | 14 ++++-
 internal/gateway/gateway.go            | 22 +++++++
 internal/gateway/minimax_think_test.go | 85 +++++++++++++++++++++++++-
 3 files changed, 118 insertions(+), 3 deletions(-)

diff --git a/internal/gateway/chat.go b/internal/gateway/chat.go
index d87f2c53d..1dedcda44 100644
--- a/internal/gateway/chat.go
+++ b/internal/gateway/chat.go
@@ -339,6 +339,17 @@ func joinTexts(content []map[string]any) string {
 	return b.String()
 }
 
+// inlineThinkHost is whether a Chat API at host gives a model's thinking in
+// the text, between <think> tags, as MiniMax's own Chat API does: the
+// decoder takes it out as thinking (#1267), buildChat writes it back in
+// where it came from on the turns after (its interleaved thinking), and a
+// reply of such an API is asked translated, never relayed as it came, which
+// would hand the tags to the client as the answer's text (#5805).
+// api.minimax.cn is MiniMax China's host beside api.minimaxi.com.
+func inlineThinkHost(host string) bool {
+	return strings.HasSuffix(host, "minimax.io") || strings.HasSuffix(host, "minimaxi.com") || strings.HasSuffix(host, "minimax.cn")
+}
+
 func buildChat(r *Request, model, host string, rejectTemp bool) []byte {
 	r = responseInstructions(r)
 	var msgs []map[string]any
@@ -351,8 +362,7 @@ func buildChat(r *Request, model, host string, rejectTemp bool) []byte {
 	// interleaved thinking): the decoder takes it out as thinking (#1267),
 	// so it goes back in where it came from. A relay serving MiniMax's
 	// models may give the thinking apart and take it back otherwise.
-	// api.minimax.cn is MiniMax China's host beside api.minimaxi.com.
-	inlineThink := strings.HasSuffix(host, "minimax.io") || strings.HasSuffix(host, "minimaxi.com") || strings.HasSuffix(host, "minimax.cn")
+	inlineThink := inlineThinkHost(host)
 	// Gemini wants each step's thought signature back on its first call
 	// (#687), and one it can't check for a step it didn't sign
 	gemini := geminiCompat(host, model)
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 7f0609615..a0ec2eb28 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5401,6 +5401,15 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 	// on every turn, and on a provider serving Responses each went out as
 	// Chat (#997, Xiaomi MiMo)
 	ownAPI := false
+	// A Chat API that thinks in its text (MiniMax's own, #5805) is asked
+	// translated even by a Chat client: relayed as it came, the reply's
+	// leading <think>…</think> reaches the client as the answer's text,
+	// with no reasoning field to fold it by. The translation takes the
+	// block out as thinking, which goes back between the tags only on the
+	// turns after (buildChat).
+	if relay && from == provider.Chat && inlineThinkChat(p) {
+		relay, ownAPI = false, true
+	}
 	// except a subagent's task its lead sealed (#1109): only the server
 	// that sealed it reads it, and a translation would drop it; and Codex's
 	// turn to a relay that takes it as Codex sent it (codexAsSent): the
@@ -9358,6 +9367,19 @@ func dashScope(p provider.Provider) bool {
 		h == "maas.qwencloudapi.com" || strings.HasSuffix(h, ".maas.qwencloudapi.com")
 }
 
+// inlineThinkChat is whether p's Chat API gives a model's thinking in the
+// text, between <think> tags: MiniMax's own does, by preset or by host. Its
+// replies are asked translated (#5805), never relayed as they came, so the
+// tags' block is taken out as thinking for the client and goes back between
+// the tags only on the turns after (inlineThinkHost, buildChat).
+func inlineThinkChat(p provider.Provider) bool {
+	switch p.Preset {
+	case "minimax", "minimax-cn":
+		return true
+	}
+	return inlineThinkHost(p.Host())
+}
+
 func streamOf(body []byte) bool {
 	var v struct {
 		Stream bool `json:"stream"`
diff --git a/internal/gateway/minimax_think_test.go b/internal/gateway/minimax_think_test.go
index 83c1e9ec3..f728888ee 100644
--- a/internal/gateway/minimax_think_test.go
+++ b/internal/gateway/minimax_think_test.go
@@ -32,7 +32,7 @@ func miniMaxSetup(t *testing.T, f *fake) {
 	t.Setenv("XDG_CACHE_HOME", t.TempDir())
 	up := httptest.NewServer(f)
 	t.Cleanup(up.Close)
-	if err := provider.Save(provider.Provider{ID: "minimax", Name: "MiniMax", Key: "k", Models: []string{"MiniMax-M2.7"}, Chat: up.URL + "/v1"}); err != nil {
+	if err := provider.Save(provider.Provider{ID: "minimax", Name: "MiniMax", Key: "k", Models: []string{"MiniMax-M2.7"}, Preset: "minimax", Chat: up.URL + "/v1"}); err != nil {
 		t.Fatal(err)
 	}
 }
@@ -104,6 +104,89 @@ func TestMiniMaxThinkingGoesBackInTags(t *testing.T) {
 	}
 }
 
+// A Chat client asking MiniMax on its Chat API (the preset's own form) has
+// the leading <think> block taken out as reasoning_content and the answer
+// alone in content, streamed or whole (#5805): the reply is translated, not
+// relayed as it came, which handed the tags to the client as the answer's
+// text, with no reasoning field to fold it by.
+func TestMiniMaxChatClientGetsReasoningField(t *testing.T) {
+	for _, c := range []struct{ name, body string }{
+		{"streamed", `{"model":"minimax/MiniMax-M2.7","stream":true,"messages":[{"role":"user","content":"hi"}]}`},
+		{"whole", `{"model":"minimax/MiniMax-M2.7","messages":[{"role":"user","content":"hi"}]}`},
+	} {
+		t.Run(c.name, func(t *testing.T) {
+			f := &fake{t: t, reply: miniMaxStream}
+			miniMaxSetup(t, f)
+			code, body := post(t, "/v1/chat/completions", c.body)
+			if code != 200 {
+				t.Fatalf("code %d: %s", code, body)
+			}
+			var reasoning, text string
+			if c.name == "streamed" {
+				for _, ev := range events(body) {
+					chs, _ := ev["choices"].([]any)
+					for _, raw := range chs {
+						ch, _ := raw.(map[string]any)
+						d, _ := ch["delta"].(map[string]any)
+						if d == nil {
+							continue
+						}
+						if v, _ := d["reasoning_content"].(string); v != "" {
+							reasoning += v
+						}
+						if v, _ := d["content"].(string); v != "" {
+							text += v
+						}
+					}
+				}
+			} else {
+				var out struct {
+					Choices []struct {
+						Message struct {
+							Content          string `json:"content"`
+							ReasoningContent string `json:"reasoning_content"`
+						} `json:"message"`
+					} `json:"choices"`
+				}
+				if err := json.Unmarshal([]byte(body), &out); err != nil || len(out.Choices) != 1 {
+					t.Fatalf("reply %s (%v)", body, err)
+				}
+				reasoning = out.Choices[0].Message.ReasoningContent
+				text = out.Choices[0].Message.Content
+			}
+			if !strings.Contains(reasoning, "The user greets me. Reply briefly.") {
+				t.Errorf("reasoning %q, want the thinking", reasoning)
+			}
+			if text != "Hello!" {
+				t.Errorf("content %q, want the answer alone", text)
+			}
+		})
+	}
+}
+
+// MiniMax's Chat API thinks in its text by preset or by host, its China
+// host and preset beside the international ones; another vendor's does not.
+func TestMiniMaxInlineThinkChat(t *testing.T) {
+	for _, c := range []struct {
+		p    provider.Provider
+		want bool
+	}{
+		{provider.Provider{Preset: "minimax"}, true},
+		{provider.Provider{Preset: "minimax-cn"}, true},
+		{provider.Provider{Chat: "https://api.minimax.io/v1"}, true},
+		{provider.Provider{Chat: "https://api.minimaxi.com/v1"}, true},
+		{provider.Provider{Chat: "https://api.minimax.cn/v1"}, true},
+		{provider.Provider{}, false},
+		{provider.Provider{Preset: "qwen"}, false},
+		{provider.Provider{Chat: "https://api.deepseek.com/v1"}, false},
+		{provider.Provider{Chat: "https://api.minimaxi.com.example.net/v1"}, false},
+	} {
+		if got := inlineThinkChat(c.p); got != c.want {
+			t.Errorf("inlineThinkChat(%+v) %t, want %t", c.p, got, c.want)
+		}
+	}
+}
+
 // A <think> block at the head of a Chat reply is thinking however the tags
 // fall across chunks; one later in the text, or a tag that only starts
 // like it, is the answer as it came.
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/5805-minimax-think-strip`](https://github.com/ggbdpq/magpie/tree/fix/5805-minimax-think-strip) (head `a768f269fa1dc11ca152de4deed71d386d38ee25`), rebased onto current `upstream/main` (`be9dbce02` — fetched again before delivery; eight commits had landed past the lane's base `dae104bfa`, the rebase was clean, and the matrix ran again on it); on a fresh checkout `git am` applies clean. Raw patch: https://github.com/ggbdpq/magpie/commit/a768f269fa1dc11ca152de4deed71d386d38ee25.patch

| Check | Result |
| --- | --- |
| `TestMiniMaxChatClientGetsReasoningField` (new; a Chat client, streamed and whole) | red before the fix — streamed content `"<think>\nThe user greets me. Reply briefly.\n</think>\n\nHello!"` with no reasoning field (the report's symptom), and a whole ask got the upstream's SSE bytes raw; pass after (`reasoning_content` holds the thinking, content `Hello!`) |
| `TestMiniMaxInlineThinkChat` (new) | pass — presets `minimax`/`minimax-cn` and the three MiniMax hosts true; no preset, `qwen`, DeepSeek, a lookalike host false |
| `TestMiniMaxThinkTagsReachCodexAsReasoning`, `TestMiniMaxThinkingGoesBackInTags`, `TestChatThinkTags`, `TestGrokRelayThinkAfterLineEnd`, `TestDashScopeWholeAskedStreamed`, `TestDashScopeHosts` | pass — the translated path and the tags write-back keep their pinned behavior |
| `go test -tags nogui -count=1 -timeout 40m ./internal/gateway/` | ok (1058s), zero failures (`TestProxyCheckSaysAProxyPassedBy`, a known local-proxy red here, passed this run) |
| `go test -tags nogui -count=1 ./...` | the packages this diff does not touch: `TestHostToldTheGatewayAddress` (internal/plugin) red on the clean parent too (rerun against `be9dbce02`, same red); `TestShimEndsAtItsCallersDeadline` (internal/claudetui) green on the parent — a local flake at its own deadline; internal/agent and internal/gui each hit the 10-minute package cap (GUI/timing tests, among them `TestTrayMenuOpenFrameIsWails`) — untouched by this diff |
| `gofmt -l` (the three touched files) | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | clean (the macOS link prints its usual Xcode version warnings, exits 0) |
| Ablation | with the commit in, reverting only the nine relay-chain lines (tests kept, the rest of the diff standing) turns both subtests red again — the tags back in `content`, no reasoning field; restored, green. The chunk shape is from MiniMax's OpenAI-compatible docs, the same shape #1267's test has streamed since |

**Not verified**: a real MiniMax-M3 key — NOT-RUNNABLE here (no key on this machine); the fake streams MiniMax's documented shape, and the report's client-facing rows are the observed half of that shape. The relay-chain placement (translate on the client's own API, not a response rewrite of the relayed stream) is chosen over parsing SSE mid-relay, which would give up the relay's point; if you'd rather MiniMax's replies were never relayed at any client API, that is one line's change of judgment.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)

