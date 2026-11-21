Your read of the gateway matches main: the key is built at `forwardOnce` — `p.WithExtraBody(body, cmp.Or(sessionOf(in), conversationID(in, body)))` (internal/gateway/gateway.go:3899) — and `sessionOf` reads the session headers (`session_id`, `x-claude-code-session-id`, …), which a Claude Code subagent sends with its parent's id. But the request does carry a per-subagent identity the gateway already parses: `x-claude-code-agent-id` (`subagentOf`/`subOf`, internal/gateway/gateway.go:6360), which subagent turns send and the conversation's own turns never do — the gateway reads it today for Desktop's subagent model and effort picks and for the Routing page's tag. So your option 1 needs no new plumbing, and I've built it as a patch.

## What changed

`${subagentId}` joins `${sessionId}` in extraBody values (internal/provider/extrabody.go), substituted at any depth the same way, with `subOf(in)` taken at the same call site:

```json
{"prompt_cache_key": "${sessionId}:${subagentId}"}
```

gives the lead `sess-1:` and each subagent `sess-1:<agent-id>` — one shard per subagent, the lead's own traffic untouched. Your option 2 (folding the subagent into the session passed to `WithExtraBody`) would move the keys of every existing `${sessionId}` user without their asking, so the placeholder is opt-in and nothing else changes. A value without `${subagentId}` goes out byte-for-byte as before; Test and Detect fill it with `""` as they fill `${sessionId}` with a session of their own; `""` (not the literal) is what non-Claude-Code agents get, as they never send the header.

## Red

`TestExtraBodySubagentId` (internal/gateway/extrabody_test.go) posts to a Responses relay three times with the same `x-claude-code-session-id` — no agent id, then `worker-a`, then `worker-b` — and wants three distinct keys. On the parent commit (test added, product files untouched) all three took the same value, the placeholder left as written:

```
--- FAIL: TestExtraBodySubagentId (0.03s)
    extrabody_test.go:120: the lead's key "sess-1:${subagentId}"
    extrabody_test.go:123: a subagent's key "sess-1:${subagentId}"
FAIL
```

With the change: `sess-1:`, `sess-1:worker-a`, `sess-1:worker-b`.

## Verification

Base upstream/main `7916045591c318c84fa894022516a7ebffc9a91e`, patch `74a4562e`, macOS arm64. The gateway and provider packages isolate themselves in their `TestMain` (temp HOME, XDG dirs), so nothing touches a live config.

| Check | Command | Result |
| --- | --- | --- |
| Targeted | `go test -run 'TestExtraBody\|TestWithExtraBody' ./internal/gateway ./internal/provider` | `ok` both |
| Race | same with `-race` | `ok` both |
| Full gateway package | `go test -timeout 45m ./internal/gateway` | `ok` 383s |
| Format | `gofmt -l` on the five changed files | clean |
| Vet | `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | `ok`, three targets |
| Builds | `go build ./...`; `GOOS=linux GOARCH=amd64 go build -tags nogui ./...`; `GOOS=windows go build -tags nogui .` | `ok`, three targets |

Docs: the Extra body row of docs/subsystems/providers-accounts.md now names `${subagentId}` beside `${sessionId}`.

## Siblings

`rg -n "SessionPlaceholder|WithExtraBody" internal/` → the placeholder lives only in extrabody.go; `WithExtraBody` has two production callers, the gateway's `forwardOnce` (which now passes `subOf(in)`) and `tested` (Test/Detect, which passes `""`). No other substitution site exists — headers and other features don't read `${…}` — and the GUI has no placeholder hint list to update (nothing under the editor's assets names `sessionId`).

## Not verified

A real relay end to end — the shape is your measured one (Responses relay, `prompt_cache_key` from extraBody), and the fake-upstream test pins the merged body bytes, but only your routing log can say whether a pool-backed relay actually splits warm keys per subagent suffix. Also not run: the full repo suite beyond internal/gateway (untouched packages) and the GUI Playwright suites.

Patch is on my fork, branch [`hunt50-e-sessionid-cache`](https://github.com/ggbdpq/magpie/tree/hunt50-e-sessionid-cache) (one commit on upstream/main `79160455`):

<details>
<summary>format-patch (74a4562e)</summary>

````text
From 74a4562ed89083fbf184bf1d7e466ec4a330a2c2 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 08:00:19 +0800
Subject: [PATCH] gateway: extraBody takes ${subagentId}, so one conversation's
 cache key isn't every subagent's (#2937)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

extraBody (#1604) merges the user's fields into every body magpie sends
a provider, and ${sessionId} in a value becomes the conversation's id,
so a relay that wants a prompt_cache_key gets one per conversation:
{"prompt_cache_key": "${sessionId}"}. Claude Code's subagents send the
conversation's own session header, so every subagent's turns take that
one key, and a pool-backed relay keeps one key warmer than it has room
for: with several subagents at once, turns land on machines that have
seen other subagents' openings but not this one's history, and hits
become hit-or-miss (yetone/magpie#2937, measured).

But a subagent's request also names itself: x-claude-code-agent-id,
which the conversation's own turns never send. The gateway already
reads it (subagentOf, subOf) for Desktop's subagent model and effort
picks and for the Routing page's tag.

Now ${subagentId} in an extraBody value, at any depth like
${sessionId}, is that id, "" on the conversation's own turns:

  {"prompt_cache_key": "${sessionId}:${subagentId}"}

gives the lead one shard and each subagent its own. A value without the
placeholder goes out exactly as it did; nothing else about ${sessionId}
changes. Folding the subagent into the session passed to WithExtraBody
(the issue's other option) would move existing users' keys without their
asking, so it is the placeholder or nothing. Test and Detect fill it
with "" as they fill ${sessionId} with a session of their own.

Docs: docs/subsystems/providers-accounts.md.

Tests: TestExtraBodySubagentId (a Responses relay, the issue's shape:
one x-claude-code-session-id, no agent id, then two). On the parent of
this change all three requests took "sess-1:${subagentId}" — the
placeholder went out as written — and the test failed on all three
assertions; with the change the lead keeps "sess-1:" and the two
subagents take "sess-1:worker-a" and "sess-1:worker-b".
TestWithExtraBody covers both placeholders at the unit level, filled
and empty.

Fixes #2937

Run (this tree, darwin arm64):
- go test -run 'TestExtraBody|TestWithExtraBody' ./internal/gateway
  ./internal/provider: ok
- go test -race -run 'TestExtraBody|TestWithExtraBody'
  ./internal/gateway ./internal/provider: ok
- go test -timeout 45m ./internal/gateway: ok, 383s, the whole package
  (a comment-only edit to the new test landed after this run began;
  the targeted tests were rerun green after it)
- gofmt -l on the five changed files: clean
- go vet ./... on darwin, GOOS=linux GOARCH=amd64 -tags nogui and
  GOOS=windows: ok, whole repo, three targets
- go build ./... (darwin), CGO_ENABLED=0 GOOS=linux GOARCH=amd64
  go build -tags nogui ./... and CGO_ENABLED=0 GOOS=windows go build
  -tags nogui .: ok

Not run: go test ./... beyond internal/gateway (untouched packages;
internal/provider's own suite ran targeted above), the gui Playwright
suites.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/providers-accounts.md |  2 +-
 internal/gateway/extrabody_test.go    | 34 +++++++++++++++++++++++++++
 internal/gateway/gateway.go           |  2 +-
 internal/provider/extrabody.go        | 30 +++++++++++++++--------
 internal/provider/extrabody_test.go   | 16 ++++++++-----
 5 files changed, 66 insertions(+), 18 deletions(-)

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index f95a3eda..2233763f 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -21,7 +21,7 @@ keys and accounts per request is in [Gateway routing and fallback](gateway-routi
 | Anthropic key header | A provider of the user's own on a third-party Anthropic API is sent its key as both `x-api-key` and `Authorization: Bearer` (`AuthHeaders`); Anthropic's own API, Bedrock, Azure, Vertex and every subscription account have their own and never this choice (`BothAuth` is false). Some services refuse the two together with a 401 (Aloha on Discord: "鉴权 header， x-api-key 和 Authorization 不可以同时存在"), so `Provider.AuthHeader` (`authHeader`: empty for both, `x-api-key` or `bearer`; anything else is read as empty) sends one alone, picked in the editor's Key header row (shown while `bothAuth` is true, or a custom provider's Anthropic URL is a third party's). Left at both, a 401 whose body `catalog.BothAuthRefused` tells as that refusal (it names both headers and says they can't be together, in Chinese or English) is asked once more with x-api-key alone, then Bearer alone (`RetryOneAuth`, in the gateway's `forwardOnce` and the provider test's `probe`; `catalog.fetchOne` for the model list through `listAuth`); the first not answered 401 or 403 is kept with `LearnAuthHeader`, which never changes a pick the user made. A request carrying the user's own `Authorization` or `x-api-key` header is never retried. | [`authheader.go`](../../internal/provider/authheader.go), [`test.go`](../../internal/provider/test.go), [`catalog/authheader.go`](../../internal/catalog/authheader.go), [`catalog/live.go`](../../internal/catalog/live.go) |
 | GLM Coding Plan key at pay as you go | Zhipu's and Z.ai's presets offer Pay as you go first (`/api/paas/v4`) and the Coding Plan (`/api/coding/paas/v4`, Responses at `/api/v1`); both share `/api/anthropic`, which bills the plan, so a plan's key left at Pay as you go worked in Claude Code and was refused 429 code 1113 "余额不足或无可用资源包" in Codex (@cleverpigo on X). Nothing in the key tells the two apart, so a Chat request to `open.bigmodel.cn` or `api.z.ai` at `/api/paas/v4` refused 1113 is asked once more at `/api/coding/paas/v4` (`RetryZhipuCoding`, in the gateway's `forwardOnce` and the provider test's `probe`). Served there, `LearnZhipuCoding` moves a saved provider with that one key, still at that URL, to the plan's OpenAI URL (and the preset's plan Responses URL when it has none); one with other keys stays and is asked again each time. Refused there too, the 1113 body keeps its code and gets both URLs and what to change in its message (`ZhipuNoBalanceHint`). A pay-as-you-go key with a balance is never answered 1113 and never sent to the plan's endpoint. | [`zhipu_coding.go`](../../internal/provider/zhipu_coding.go), [`test.go`](../../internal/provider/test.go) |
 | Zhipu's 200 refusals | Zhipu's and Z.ai's `/api/v1` (the GLM Coding Plan's Responses API, from their Codex pages) and `/api/monitor` answer a refusal 200 in the platform's envelope, `{"code":1000,"msg":"身份验证失败。","success":false}`, where their OpenAI and Anthropic endpoints answer the same key 401 (@xanahopper on X: a refused key tested green on the Responses row only). `ZhipuEnveloped` turns a 2xx JSON body from `open.bigmodel.cn` or `api.z.ai` with `success: false` into `{"error":{"code","message"}}` at the status Zhipu's error-code table gives (1000–1005 → 401, 1113 and 1302–1399 → 429, 1220 → 403, 1210–1229, 1261 and 1301 → 400, anything else → 502), in the provider test's `probe` (endpoint tests, model tests, Detect APIs) and the gateway's `forwardOnce`. A stream, a compressed body, a body over 64 KB and every other host pass as they came. The plan's quota card for a key refused there (1000–1005, or a 401) says `<Zhipu or Z.ai> didn't take this key (<their words>): …` with the vendor's API-keys page (`zhipuRefused`), not asked again as a team's key, and the GUI shows it as that (`quotaError`) rather than "Allowance unavailable". | [`zhipu_envelope.go`](../../internal/provider/zhipu_envelope.go), [`planquota.go`](../../internal/provider/planquota.go), [`test.go`](../../internal/provider/test.go) |
-| Extra body | `ExtraBody` (`extraBody` in providers.json, the editor's *Extra body*, #1604) is a JSON object whose fields `WithExtraBody` adds at the top level of every JSON body sent to the provider: Messages, Chat, Responses and Gemini, relayed as they came or translated, in the gateway's `forwardOnce` and in Test and Detect (`tested`). A field the body has already is kept; a name written `"!name"` replaces it. Values are put in as written, objects whole, not merged. `${sessionId}` in any string, at any depth, becomes the request's session: the agent's session header (`sessionOf`), else the id `conversationID` derives from the first user message (`magpie-` and its hash), so it stays the same through one conversation; Test and Detect send `magpie-test-` and 12 random letters, a new one each time. `model`, `stream` and the conversation (`messages`, `input`, `contents`, `system`, `systemInstruction`, `system_instruction`, `instructions`, `tools`, `ExtraBodyReserved`) are magpie's: Save refuses them with or without `!` (`ExtraBodyOK`), the editor says so as they are typed, and one written into providers.json by hand is dropped on read (`cleanExtraBody`). Not sent with it: `count_tokens`, embeddings, images, video and System One's decision model (other APIs), and a signed-in account's requests, except a ChatGPT (Codex) account's (magpie-releases#18): its requests are built as Codex CLI's (`codexBody`) and take the fields Codex CLI adds by choice, such as `access_programs` (OpenAI's Daybreak), while `store`, `tool_choice` and `include`, which the backend needs as `codexBody` sets them, can't be set (`codexOwned`). Its extraBody is written into providers.json by hand under the account's entry and kept onto the account by `withPicks`; the editor has no box for it. A client's own top-level `access_programs` on Responses or Chat is carried to a Responses build as it came (`Request.AccessPrograms`), so a request translated (a Codex account is streamed, so a whole Responses request is made again) keeps it as a relayed one does. One object goes to every API; fields for one API alone are not a thing yet. A `thinking` budget it puts in on an Anthropic endpoint is fitted to a Claude that thinks only adaptively after the merge, as an agent's is (`adaptiveThinking`, `TestExtraBodyBudgetFittedToAdaptiveModel`). | [`extrabody.go`](../../internal/provider/extrabody.go), [`gateway.go`](../../internal/gateway/gateway.go) |
+| Extra body | `ExtraBody` (`extraBody` in providers.json, the editor's *Extra body*, #1604) is a JSON object whose fields `WithExtraBody` adds at the top level of every JSON body sent to the provider: Messages, Chat, Responses and Gemini, relayed as they came or translated, in the gateway's `forwardOnce` and in Test and Detect (`tested`). A field the body has already is kept; a name written `"!name"` replaces it. Values are put in as written, objects whole, not merged. `${sessionId}` in any string, at any depth, becomes the request's session: the agent's session header (`sessionOf`), else the id `conversationID` derives from the first user message (`magpie-` and its hash), so it stays the same through one conversation; `${subagentId}` becomes the Claude Code subagent the request is of (`x-claude-code-agent-id`, `subOf`), "" on the conversation's own turns, which never send the header, so `${sessionId}:${subagentId}` keeps one prompt_cache_key per subagent where `${sessionId}` alone carries every subagent's turns on one key (#2937); Test and Detect send `magpie-test-` and 12 random letters, a new one each time. `model`, `stream` and the conversation (`messages`, `input`, `contents`, `system`, `systemInstruction`, `system_instruction`, `instructions`, `tools`, `ExtraBodyReserved`) are magpie's: Save refuses them with or without `!` (`ExtraBodyOK`), the editor says so as they are typed, and one written into providers.json by hand is dropped on read (`cleanExtraBody`). Not sent with it: `count_tokens`, embeddings, images, video and System One's decision model (other APIs), and a signed-in account's requests, except a ChatGPT (Codex) account's (magpie-releases#18): its requests are built as Codex CLI's (`codexBody`) and take the fields Codex CLI adds by choice, such as `access_programs` (OpenAI's Daybreak), while `store`, `tool_choice` and `include`, which the backend needs as `codexBody` sets them, can't be set (`codexOwned`). Its extraBody is written into providers.json by hand under the account's entry and kept onto the account by `withPicks`; the editor has no box for it. A client's own top-level `access_programs` on Responses or Chat is carried to a Responses build as it came (`Request.AccessPrograms`), so a request translated (a Codex account is streamed, so a whole Responses request is made again) keeps it as a relayed one does. One object goes to every API; fields for one API alone are not a thing yet. A `thinking` budget it puts in on an Anthropic endpoint is fitted to a Claude that thinks only adaptively after the merge, as an agent's is (`adaptiveThinking`, `TestExtraBodyBudgetFittedToAdaptiveModel`). | [`extrabody.go`](../../internal/provider/extrabody.go), [`gateway.go`](../../internal/gateway/gateway.go) |
 | Native compaction | `NativeCompaction` (`nativeCompaction` in providers.json, the editor's *Compaction* row, `magpie provider set <id> compaction=native\|magpie`; #1099) has Codex's compaction asked of the provider as Codex sent it and its sealed item returned unchanged. Off by default. Only a provider whose wire carries it can be set so (`CarriesCompaction`: a Responses API, a ChatGPT account, GitHub Copilot; not another agent's sign-in or a plugin's), and `CompactsOn(model)` also needs the model asked on Responses. `SetNativeCompaction`, the CLI and the GUI's save refuse it elsewhere. An account keeps it through `Save`'s picks (`withPicks`), and `AddCopy` carries it. The gateway's half is in [gateway-routing](gateway-routing.md). | [`native_compaction.go`](../../internal/provider/native_compaction.go) |
 | providers.json | `Path` is `providers.json` in magpie's config folder. A read that fails returns `ErrUnreadable` and is never treated as empty. `store` writes atomically through a rename and drops the cached catalog (`catalog.Touched`). | [`provider.go`](../../internal/provider/provider.go) |
 | The list | `All` merges stored providers with `Accounts()`. An entry with no URL stores the user's picks for an account. The order is `file.Order`. Reads within one request share one build (`Hold`, #746). | [`provider.go`](../../internal/provider/provider.go) |
diff --git a/internal/gateway/extrabody_test.go b/internal/gateway/extrabody_test.go
index 220dd13f..2d4637de 100644
--- a/internal/gateway/extrabody_test.go
+++ b/internal/gateway/extrabody_test.go
@@ -92,6 +92,40 @@ func TestExtraBodyResponsesRelayed(t *testing.T) {
 	}
 }
 
+// Claude Code's subagents share the conversation's session header, so
+// ${sessionId} alone puts every subagent's turns on one prompt_cache_key
+// (yetone/magpie#2937), more than a relay keeps warm. ${subagentId} is
+// the request's x-claude-code-agent-id, which the conversation's own
+// turns never send: the lead's key stays one shard, each subagent's
+// turns another.
+func TestExtraBodySubagentId(t *testing.T) {
+	f := &fake{t: t, reply: responsesReply, ctype: "application/json"}
+	setup(t, provider.Responses, f)
+	withExtraBody(t, "fake", `{"prompt_cache_key":"${sessionId}:${subagentId}"}`)
+
+	ask := func(agent string) string {
+		t.Helper()
+		head := map[string]string{"x-claude-code-session-id": "sess-1"}
+		if agent != "" {
+			head["x-claude-code-agent-id"] = agent
+		}
+		code, body := postWith(t, "/v1/responses", `{"model":"m1","input":"hi"}`, head)
+		if code != 200 {
+			t.Fatalf("status %d: %s", code, body)
+		}
+		return gjson.GetBytes(f.got, "prompt_cache_key").String()
+	}
+	if got := ask(""); got != "sess-1:" {
+		t.Errorf("the lead's key %q", got)
+	}
+	if got := ask("worker-a"); got != "sess-1:worker-a" {
+		t.Errorf("a subagent's key %q", got)
+	}
+	if got := ask("worker-b"); got == "sess-1:worker-a" || got == "sess-1:" {
+		t.Errorf("another subagent's key %q", got)
+	}
+}
+
 // Without a session header, ${sessionId} is the id magpie derives from the
 // conversation's first user message: never the literal, the same on every
 // turn of one conversation, different for another.
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index dcd6568d..82eef442 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -3896,7 +3896,7 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 		// the user's own fields for the provider (#1604), last, so the
 		// body is as it goes out when they fill in what it lacks, and
 		// before it is signed
-		extra := p.WithExtraBody(body, cmp.Or(sessionOf(in), conversationID(in, body)))
+		extra := p.WithExtraBody(body, cmp.Or(sessionOf(in), conversationID(in, body)), subOf(in))
 		if to == provider.Anthropic && !bytes.Equal(extra, body) {
 			// a thinking budget the user's fields put in is fitted to a
 			// model that thinks only adaptively as the agent's is, its
diff --git a/internal/provider/extrabody.go b/internal/provider/extrabody.go
index ac41082a..c5fcd8a4 100644
--- a/internal/provider/extrabody.go
+++ b/internal/provider/extrabody.go
@@ -16,6 +16,11 @@ package provider
 //     magpie derives from the conversation's first user message — the same
 //     for every turn of it. A fixed string would put every session on one
 //     cache key.
+//   - ${subagentId} in a string value is the Claude Code subagent the
+//     request is of (x-claude-code-agent-id), "" on the conversation's
+//     own turns, which never send the header. "${sessionId}:${subagentId}"
+//     gives a relay one prompt_cache_key per subagent, where ${sessionId}
+//     alone carries every subagent's turns on one key (yetone/magpie#2937).
 //   - The fields that carry the conversation, or that magpie must decide
 //     for routing and streaming to work (ExtraBodyReserved), can't be set:
 //     a save naming one is refused, and one written into the file by hand
@@ -88,6 +93,10 @@ func (p Provider) extraBodyTakes() (owned []string, ok bool) {
 // conversation's id.
 const SessionPlaceholder = "${sessionId}"
 
+// SubagentPlaceholder is what a string value of extraBody writes for the
+// Claude Code subagent a request is of, "" on the conversation's own turns.
+const SubagentPlaceholder = "${subagentId}"
+
 // extraName is a field's name without its "!", and whether it is forced.
 func extraName(k string) (string, bool) {
 	n, forced := strings.CutPrefix(strings.TrimSpace(k), "!")
@@ -140,8 +149,9 @@ func cleanExtraBody(e ExtraBody) ExtraBody {
 
 // WithExtraBody is body with the provider's extra fields merged in, as the
 // package's comment says; session is the conversation's id for
-// ${sessionId}. A body that isn't a JSON object goes as it came.
-func (p Provider) WithExtraBody(body []byte, session string) []byte {
+// ${sessionId}, subagent the Claude Code subagent for ${subagentId}.
+// A body that isn't a JSON object goes as it came.
+func (p Provider) WithExtraBody(body []byte, session, subagent string) []byte {
 	owned, takes := p.extraBodyTakes()
 	if len(p.ExtraBody) == 0 || !takes {
 		return body
@@ -167,7 +177,7 @@ func (p Provider) WithExtraBody(body []byte, session string) []byte {
 		if d.Decode(&v) != nil {
 			continue
 		}
-		m[n], changed = withSession(v, session), true
+		m[n], changed = withSession(v, session, subagent), true
 	}
 	if !changed {
 		return body
@@ -181,19 +191,19 @@ func (p Provider) WithExtraBody(body []byte, session string) []byte {
 	return bytes.TrimSuffix(out.Bytes(), []byte("\n"))
 }
 
-// withSession is v with ${sessionId} in its strings, at any depth, as
-// session.
-func withSession(v any, session string) any {
+// withSession is v with ${sessionId} and ${subagentId} in its strings, at
+// any depth, as session and subagent.
+func withSession(v any, session, subagent string) any {
 	switch x := v.(type) {
 	case string:
-		return strings.ReplaceAll(x, SessionPlaceholder, session)
+		return strings.ReplaceAll(strings.ReplaceAll(x, SessionPlaceholder, session), SubagentPlaceholder, subagent)
 	case map[string]any:
 		for k, e := range x {
-			x[k] = withSession(e, session)
+			x[k] = withSession(e, session, subagent)
 		}
 	case []any:
 		for i, e := range x {
-			x[i] = withSession(e, session)
+			x[i] = withSession(e, session, subagent)
 		}
 	}
 	return v
@@ -203,5 +213,5 @@ func withSession(v any, session string) any {
 // out: the extra fields, on a session of the test's own, then what the
 // backend adjusts.
 func (p Provider) tested(body string) []byte {
-	return p.Prepare(p.WithExtraBody([]byte(body), "magpie-test-"+strings.ToLower(rand.Text()[:12])))
+	return p.Prepare(p.WithExtraBody([]byte(body), "magpie-test-"+strings.ToLower(rand.Text()[:12]), ""))
 }
diff --git a/internal/provider/extrabody_test.go b/internal/provider/extrabody_test.go
index 040d5c82..4daa17b5 100644
--- a/internal/provider/extrabody_test.go
+++ b/internal/provider/extrabody_test.go
@@ -108,8 +108,9 @@ func TestWithExtraBody(t *testing.T) {
 		"!service_tier":    json.RawMessage(`"flex"`),
 		"model":            json.RawMessage(`"never"`),
 		"big":              json.RawMessage(`12345678901234567890`),
+		"sub_key":          json.RawMessage(`"s:${subagentId}"`),
 	}}
-	out := p.WithExtraBody([]byte(`{"model":"m","service_tier":"auto","input":"a<b>&c","prompt_cache_key":"mine"}`), "S1")
+	out := p.WithExtraBody([]byte(`{"model":"m","service_tier":"auto","input":"a<b>&c","prompt_cache_key":"mine"}`), "S1", "worker-a")
 	var m map[string]any
 	if err := json.Unmarshal(out, &m); err != nil {
 		t.Fatalf("%s: %v", out, err)
@@ -120,29 +121,32 @@ func TestWithExtraBody(t *testing.T) {
 	if !strings.Contains(string(out), `"tags":["s-S1"]`) || !strings.Contains(string(out), `"big":12345678901234567890`) {
 		t.Errorf("values %s", out)
 	}
+	if !strings.Contains(string(out), `"sub_key":"s:worker-a"`) {
+		t.Errorf("subagent %s", out)
+	}
 	if !strings.Contains(string(out), `"a<b>&c"`) {
 		t.Errorf("escaped %s", out)
 	}
 
-	out = p.WithExtraBody([]byte(`{"model":"m"}`), "S2")
-	if !strings.Contains(string(out), `"prompt_cache_key":"S2"`) {
+	out = p.WithExtraBody([]byte(`{"model":"m"}`), "S2", "")
+	if !strings.Contains(string(out), `"prompt_cache_key":"S2"`) || !strings.Contains(string(out), `"sub_key":"s:"`) {
 		t.Errorf("filled %s", out)
 	}
 
 	// a body that isn't an object goes as it came
 	for _, b := range []string{`[1]`, `not json`, ``} {
-		if got := string(p.WithExtraBody([]byte(b), "S")); got != b {
+		if got := string(p.WithExtraBody([]byte(b), "S", "")); got != b {
 			t.Errorf("%q became %q", b, got)
 		}
 	}
 	// a signed-in account's body is the agent's own
 	acct := p
 	acct.Account = &Account{}
-	if got := string(acct.WithExtraBody([]byte(`{"model":"m"}`), "S")); got != `{"model":"m"}` {
+	if got := string(acct.WithExtraBody([]byte(`{"model":"m"}`), "S", "")); got != `{"model":"m"}` {
 		t.Errorf("account body %s", got)
 	}
 	// none set: the body's bytes as they were
-	if got := string((Provider{}).WithExtraBody([]byte(`{"b":1, "a":2}`), "S")); got != `{"b":1, "a":2}` {
+	if got := string((Provider{}).WithExtraBody([]byte(`{"b":1, "a":2}`), "S", "")); got != `{"b":1, "a":2}` {
 		t.Errorf("unchanged body %s", got)
 	}
 }
-- 
2.50.1 (Apple Git-155)

````

</details>

---
**AI**: I wrote this patch and its tests and have read the whole diff; I can answer questions on it myself.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.
