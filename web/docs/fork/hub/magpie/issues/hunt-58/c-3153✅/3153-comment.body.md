## Source & environment

yetone/magpie#3153, opened and diagnosed by yetone (0 comments at the time of writing): a `tool_choice` object the Grok plugin should read is dropped before its `fetch`, so with the plugin's X search option on (grok 0.2.0) a request goes out with `x_search` over a client's `allowed_tools`. The issue quotes a repro through the real gateway at ba319a758 with a fake Grok upstream. Fixed from f5b0157420a4491f6e707b49a8af8e87ea8050a1 (upstream/main), one commit, on macOS arm64 with the repo's Go toolchain.

## Minimal repro

A Responses request relayed to the Grok plugin in its own protocol, tools present, the client allowing `read_file` alone:

```
POST /v1/responses {"tool_choice":{"type":"allowed_tools","mode":"auto","tools":[{"type":"function","name":"read_file"}]},"tools":[{"type":"function","name":"read_file"}]}
-> plugin's fetch: the body with no tool_choice at all (grokShaped dropped the object)
-> Grok:            {"tools":[{read_file},{"type":"x_search"}]}
```

The plugin can't tell an `allowed_tools` choice from no preference, so it adds `x_search` and a tool outside the client's allowed list goes out. The same drop is pinned by the new test against `grokPluginBody` before the fix: `plugin: tool_choice {Type: Mode: Tools:[]}`.

## Root cause

`grokShaped` (internal/provider/grok.go) shapes every Grok-bound body: `grokBody` for the built-in and `grokPluginBody` for the plugin's accounts (`a.body` in internal/provider/plugins.go, applied at each `forward` through `Provider.Prepare`). With tools present it drops a `tool_choice` object whose `type` isn't in `grokTools` — `allowed_tools` among them. That is right for the built-in, which is Grok's last stop (the backend turns the request away over a tool_choice it doesn't know), and wrong for the plugin: the object holds the client's restriction, and the plugin is the one reader that honors it (its own unit test passes `allowed_tools` and adds nothing; every version since the TOOLS filter leaves an unsupported `tool_choice` object out before Grok, per the issue). #3110 set the shape for the lone `"none"`: magpie hands the plugin what it reads, the plugin decides what Grok sees.

## Fix

`grokShaped` keeps an unsupported `tool_choice` object on the plugin path; the built-in still drops it. `grokShaped`'s `keepNone` is `forPlugin` now, since keeping is no longer only about `"none"`. The comments on `grokPluginBody` and at the drop point, the Grok mover's `min` note (internal/provider/migrate_side.go, no bump: the min version's TOOLS filter already drops such an object before Grok) and the Grok plugin paragraph in docs/subsystems/provider-plugins.md say so. One commit, five files, +61 -11; no dependency, no unrelated change.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| New test without the fix (ablation: grok.go back at f5b01574, test kept) | `go test ./internal/provider -run TestGrokPluginBodyKeepsUnsupportedToolChoice` | FAIL `grok_test.go:141: plugin: tool_choice {Type: Mode: Tools:[]}` |
| New test with the fix | same | ok |
| Broken by hand: delete the choice whatever the path | same | FAIL `plugin: tool_choice {Type: Mode: Tools:[]}`, green restored |
| Broken by hand: delete only a supported type | same | FAIL `built-in: tool_choice {Type:allowed_tools}`, green restored |
| Changed package, full | `go test -tags nogui ./internal/provider` | ok 167.3s, no FAIL |
| #3110's pipeline undisturbed | `go test ./internal/gateway -run 'TestToolsOffWithoutTools\|TestGrok'` | ok |
| gofmt | `gofmt -l` on the changed files | nothing printed |
| vet | `go vet ./...` | exit 0 |
| vet | `GOOS=windows GOARCH=amd64 go vet ./...` | exit 0 |
| vet | `GOOS=linux GOARCH=amd64 go vet -tags nogui ./...` | exit 0 |
| build | `go build .` | exit 0 |
| build | `GOOS=linux GOARCH=amd64 go build -tags nogui .` | exit 0 |
| build | `GOOS=windows GOARCH=amd64 go build .` | exit 0 |

## Not verified

- No real Grok upstream and no real plugin fetch were tried: the plugin's own handling (reads `allowed_tools`, adds nothing; drops an unsupported `tool_choice` object before Grok) and the repro through the real gateway at ba319a758 are the issue's account. The fix is verified at the `grokPluginBody` seam every plugin request is shaped through.
- `GOOS=linux GOARCH=amd64 go vet ./...` without `-tags nogui` exits 1 inside the wails dependency (`webview_window_linux.go: undefined: pointer`), code this change doesn't touch; the repo's standard `-tags nogui` run is clean. `go vet ./...` on darwin prints one pre-existing cgo warning (`internal/gui/trayimage_darwin.go`, `-Wenum-conversion`) and exits 0.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: an allowed_tools tool_choice reaches the Grok plugin (#3153) — git am applies it as is; SHA-256 first 16: 5dfc404ba610029f</summary>

```patch
From 099cf6b2a4718eaa6e26caf5df87c287ad1e6129 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 23:23:10 +0800
Subject: [PATCH] gateway: an allowed_tools tool_choice reaches the Grok plugin
 (#3153)

grokShaped dropped a tool_choice object whose type isn't among grokTools
on the plugin's path too, the same as for the built-in: a Responses
request relayed to the Grok plugin in its own protocol reached the
plugin's fetch with no tool_choice, so with the X search option on (grok
0.2.0) the plugin added x_search over a client's allowed_tools and a
tool outside the allowed list went out. The plugin reads the choice and
leaves an unsupported one out before Grok itself (every version since
the TOOLS filter, the mover's min 0.1.18 among them), so grokPluginBody
now keeps such an object, as it keeps the lone "none" (#3110);
grokShaped's keepNone is forPlugin, since keeping is no longer only
about "none". The built-in, which is Grok's last stop, still drops it.

Run:
- gofmt -l on the changed files: clean
- go vet ./...: darwin and GOOS=windows clean; GOOS=linux vet needs
  -tags nogui (the GUI's wails doesn't vet without it), clean with it
- go build: darwin, GOOS=linux -tags nogui and GOOS=windows: ok
- go test -tags nogui ./internal/provider: ok 167.3s, no FAIL
- go test ./internal/gateway -run 'TestToolsOffWithoutTools|TestGrok': ok
- TestGrokPluginBodyKeepsUnsupportedToolChoice fails without the change
  ("plugin: tool_choice {Type: Mode: Tools:[]}"), passes with it; broken
  by hand, each way red then green on restore: deleting the choice
  whatever the path (plugin red), deleting only a supported type
  (built-in red)

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/provider-plugins.md |  2 +-
 internal/provider/grok.go           | 23 ++++++++++------
 internal/provider/grok_test.go      | 41 +++++++++++++++++++++++++++++
 internal/provider/migrate_side.go   |  2 +-
 internal/provider/plugins.go        |  4 ++-
 5 files changed, 61 insertions(+), 11 deletions(-)

diff --git a/docs/subsystems/provider-plugins.md b/docs/subsystems/provider-plugins.md
index 5cf53129..bf8e679e 100644
--- a/docs/subsystems/provider-plugins.md
+++ b/docs/subsystems/provider-plugins.md
@@ -70,7 +70,7 @@ A plugin in front of Anthropic's or OpenAI's own API (a CPA or sub2api relay, sa
 
 A plugin says which service tiers its vendor serves a model at with `serviceTiers` on the model (#2514): ids such as `"priority"` and `"ultrafast"`, or objects with an `id`. The host keeps the ids (`tiersOf` in `host.js`, into `plugin.Model.ServiceTiers`), `pluginCatalog` puts them on the catalog model's `Tiers`, and [`CodexTiers`](../../internal/provider/codex_models.go) offers them to Codex, as `codexcat` names them (`priority` is Fast). In [`forwardTranslated`](../../internal/gateway/gateway.go) a request translated to the plugin's Chat or Responses keeps its `service_tier` (`Request.OwnTier`) only when it is among the model's tiers (`provider.PluginTiers`); a request relayed in its own protocol was sent as the client wrote it before, and still is. A model served at `priority` on its Chat or Responses API has fast mode ([`CanFast`](../../internal/provider/groupfast.go), via `pluginTierOn`), whichever plugin it is: it can be a group's fast member or an agent's fast pick, and it can be picked Ultrafast when it is served at `ultrafast` too (`UltraOn`). Fast mode in Claude's words (speed `"fast"`, or a fast pick from an agent on Claude's API) reaches the plugin as tier `priority`, or as `ultrafast` for an Ultrafast pick, when the model is served at that tier (Lovest on Discord). Cursor's `fast` flag and `-fast` siblings still give Cursor's plugin fast mode as before.
 
-A request translated to the Grok plugin's Responses API that turned tools off with no tools declared (Chat's `tool_choice: "none"`, Anthropic's `{"type":"none"}`, Gemini's `functionCallingConfig.mode` `NONE`) reaches the plugin's `fetch` with `tool_choice: "none"` and no `tools` (#3110). Before, it went without a `tool_choice`, the same as a request with no preference, so a plugin that adds a server-side tool of its own (Grok's `x_search`, magpie-community/plugins#263) couldn't respect it. [`buildResponses`](../../internal/gateway/responses.go) keeps the `"none"`, and [`forwardTranslated`](../../internal/gateway/gateway.go) leaves a lone `tool_choice` out for every other upstream (`keepsLoneNone`): every vendor, xAI and Copilot (`refusesLoneToolChoice`, #378), and every other plugin, whose vendors haven't been tried with a lone `"none"`. So what a vendor is sent is unchanged. Grok's Responses backend doesn't take it either: the Grok plugin's bodies are shaped by `grokPluginBody`, which keeps the lone `"none"` that `grokBody` drops for the built-in, and the plugin leaves it out before its request goes to Grok (0.1.18, the mover's `min`). Chat, Anthropic and Gemini requests still carry no tool choice beside no tools, which OpenAI's Chat refuses ("'tool_choice' is only allowed when 'tools' are specified"). `TestToolsOffWithoutToolsReachesPlugin`, `TestToolsOffWithoutToolsNotSentToOtherPlugins`, `TestToolsOffWithoutToolsNotSentToVendor`, `TestToolsOffWithoutToolsLeftOutForXAI` and `TestToolsOffWithoutToolsPerBuilder` in [`tool_choice_none_test.go`](../../internal/gateway/tool_choice_none_test.go), and `TestGrokPluginBodyKeepsLoneNone`, cover it.
+A request translated to the Grok plugin's Responses API that turned tools off with no tools declared (Chat's `tool_choice: "none"`, Anthropic's `{"type":"none"}`, Gemini's `functionCallingConfig.mode` `NONE`) reaches the plugin's `fetch` with `tool_choice: "none"` and no `tools` (#3110). Before, it went without a `tool_choice`, the same as a request with no preference, so a plugin that adds a server-side tool of its own (Grok's `x_search`, magpie-community/plugins#263) couldn't respect it. [`buildResponses`](../../internal/gateway/responses.go) keeps the `"none"`, and [`forwardTranslated`](../../internal/gateway/gateway.go) leaves a lone `tool_choice` out for every other upstream (`keepsLoneNone`): every vendor, xAI and Copilot (`refusesLoneToolChoice`, #378), and every other plugin, whose vendors haven't been tried with a lone `"none"`. So what a vendor is sent is unchanged. Grok's Responses backend doesn't take it either: the Grok plugin's bodies are shaped by `grokPluginBody`, which keeps the lone `"none"` that `grokBody` drops for the built-in, and the plugin leaves it out before its request goes to Grok (0.1.18, the mover's `min`). A request the plugin serves in its own Responses protocol goes to its `fetch` as the client wrote it, and the client's own `tool_choice` object of a type Grok's backend doesn't take (an `allowed_tools` naming the client's tools) was dropped the same way (`grokShaped`), so the plugin couldn't tell it from no choice and added `x_search` over it: a tool outside the client's allowed list went out. `grokPluginBody` keeps such an object for the plugin to read now, and the plugin leaves it out before Grok as it does the lone `"none"` (#3153); the built-in, which is Grok's last stop, still drops it. Chat, Anthropic and Gemini requests still carry no tool choice beside no tools, which OpenAI's Chat refuses ("'tool_choice' is only allowed when 'tools' are specified"). `TestToolsOffWithoutToolsReachesPlugin`, `TestToolsOffWithoutToolsNotSentToOtherPlugins`, `TestToolsOffWithoutToolsNotSentToVendor`, `TestToolsOffWithoutToolsLeftOutForXAI` and `TestToolsOffWithoutToolsPerBuilder` in [`tool_choice_none_test.go`](../../internal/gateway/tool_choice_none_test.go), `TestGrokPluginBodyKeepsLoneNone` and `TestGrokPluginBodyKeepsUnsupportedToolChoice`, cover it.
 
 ## A plugin's decision API
 
diff --git a/internal/provider/grok.go b/internal/provider/grok.go
index 2923f6c3..4035d4a2 100644
--- a/internal/provider/grok.go
+++ b/internal/provider/grok.go
@@ -182,14 +182,17 @@ var grokTools = map[string]bool{"function": true, "web_search": true, "x_search"
 // user's message, its sender and recipient said first (grokAgentMessage).
 func grokBody(body []byte) []byte { return grokShaped(body, false) }
 
-// grokPluginBody is grokBody for the Grok plugin, but a tool_choice "none"
-// with no tools stays: a request that turned tools off says so to the
-// plugin, which reads it before adding a tool of its own (x_search) and
-// leaves a lone tool_choice out before the request goes to Grok
-// (@magpie-community/opencode-grok-auth 0.1.18, #3110).
+// grokPluginBody is grokBody for the Grok plugin, but the tool_choice the
+// plugin reads stays: a lone "none" (a request that turned tools off says
+// so to the plugin, which reads it before adding a tool of its own
+// (x_search) and leaves a lone tool_choice out before the request goes to
+// Grok; @magpie-community/opencode-grok-auth 0.1.18, #3110), and an object
+// of a type Grok's backend doesn't take, an allowed_tools naming the
+// client's own tools among them, which the plugin reads the same way and
+// leaves out before Grok (#3153).
 func grokPluginBody(body []byte) []byte { return grokShaped(body, true) }
 
-func grokShaped(body []byte, keepNone bool) []byte {
+func grokShaped(body []byte, forPlugin bool) []byte {
 	if !bytes.Contains(body, []byte(`"tools"`)) && !bytes.Contains(body, []byte(`"reasoning"`)) && !bytes.Contains(body, []byte(`"tool_choice"`)) && !bytes.Contains(body, []byte(`"namespace"`)) && !bytes.Contains(body, []byte(`"agent_message"`)) {
 		return body
 	}
@@ -231,13 +234,17 @@ func grokShaped(body []byte, keepNone bool) []byte {
 			if flatCall(tc) {
 				dirty = true
 			}
-			if ty, _ := tc["type"].(string); !grokTools[ty] {
+			// a type the backend turns the request away over goes for the
+			// plugin to read, as the lone "none" does: it leaves an
+			// unsupported one out before Grok instead of adding x_search
+			// over it (#3153). The built-in is Grok's last stop.
+			if ty, _ := tc["type"].(string); !grokTools[ty] && !forPlugin {
 				delete(m, "tool_choice")
 				dirty = true
 			}
 		}
 	}
-	if tools, _ := m["tools"].([]any); len(tools) == 0 && !(keepNone && m["tool_choice"] == "none") {
+	if tools, _ := m["tools"].([]any); len(tools) == 0 && !(forPlugin && m["tool_choice"] == "none") {
 		if _, ok := m["tool_choice"]; ok {
 			delete(m, "tool_choice")
 			dirty = true
diff --git a/internal/provider/grok_test.go b/internal/provider/grok_test.go
index b74619a3..d95daf30 100644
--- a/internal/provider/grok_test.go
+++ b/internal/provider/grok_test.go
@@ -119,6 +119,47 @@ func TestGrokPluginBodyKeepsLoneNone(t *testing.T) {
 	}
 }
 
+// The Grok plugin is handed a tool_choice object of a type Grok's backend
+// doesn't take (#3153), as an allowed_tools naming the client's own tools:
+// it reads it instead of adding x_search over it, and leaves it out before
+// Grok. The built-in, which is Grok's last stop, still drops it: the
+// backend turns the request away over one.
+func TestGrokPluginBodyKeepsUnsupportedToolChoice(t *testing.T) {
+	in := []byte(`{"model":"grok-4.7","tool_choice":{"type":"allowed_tools","mode":"auto","tools":[{"type":"function","name":"read_file"}]},"tools":[{"type":"function","name":"read_file"}]}`)
+	var got struct {
+		Choice struct {
+			Type  string           `json:"type"`
+			Mode  string           `json:"mode"`
+			Tools []map[string]any `json:"tools"`
+		} `json:"tool_choice"`
+		Tools []map[string]any `json:"tools"`
+	}
+	if err := json.Unmarshal(grokPluginBody(in), &got); err != nil {
+		t.Fatal(err)
+	}
+	if got.Choice.Type != "allowed_tools" || got.Choice.Mode != "auto" || len(got.Choice.Tools) != 1 || got.Choice.Tools[0]["name"] != "read_file" {
+		t.Fatalf("plugin: tool_choice %+v", got.Choice)
+	}
+	if len(got.Tools) != 1 || got.Tools[0]["name"] != "read_file" {
+		t.Fatalf("plugin: tools %+v", got.Tools)
+	}
+	var builtin struct {
+		Choice struct {
+			Type string `json:"type"`
+		} `json:"tool_choice"`
+		Tools []map[string]any `json:"tools"`
+	}
+	if err := json.Unmarshal(grokBody(in), &builtin); err != nil {
+		t.Fatal(err)
+	}
+	if builtin.Choice.Type != "" {
+		t.Fatalf("built-in: tool_choice %+v", builtin.Choice)
+	}
+	if len(builtin.Tools) != 1 || builtin.Tools[0]["name"] != "read_file" {
+		t.Fatalf("built-in: tools %+v", builtin.Tools)
+	}
+}
+
 // Codex's reasoning, handed back with a null content, is sent without it.
 func TestGrokBodyDropsNullReasoningContent(t *testing.T) {
 	in := []byte(`{"input":[{"type":"reasoning","id":"rs_1","summary":[],"content":null,"encrypted_content":"a+b/c="},{"type":"message","role":"user","content":"hi"}]}`)
diff --git a/internal/provider/migrate_side.go b/internal/provider/migrate_side.go
index 65918401..5892b44a 100644
--- a/internal/provider/migrate_side.go
+++ b/internal/provider/migrate_side.go
@@ -97,7 +97,7 @@ func init() {
 	// names, as the built-in does: the homes stay where they are.
 	movers["grok"] = &mover{
 		pkg:    "@magpie-community/opencode-grok-auth",
-		min:    "0.1.18", // the sign-in page opens once, where Grok Build opened it and magpie again (andyfmyth on X); a Go key the Provider API refuses is taken as Go's and asked at /alpha/generate (#969); a failure's status and its sign-in mark as the built-in's; grok-4.7's reasoning levels; a token Grok refuses early reads as expired; the sign-in renewed ahead of time through auth.refresh; a 429 shows a spent Rate limit window until it lifts; a login with no link says why; a tool whose parameters are a root union goes as a plain object (#1271); a plain Codex agent_message (a subagent's task or reply) goes as the user's message, not refused with 422 "unknown item type", a sealed one as it came (plugins#61); a model Grok lists at two windows is offered at each, grok-4.7@500k sent with x-grok-context-window (plugins#83); a window offered without a k (grok-4.7@131072) goes as that window, not as a model named so (#1679); a sign-in without Grok Build names GROK_BIN_DIR (#2223); a sign-in with no email (an X account) is kept by its xAI user id, GROK_AUTH_PATH no longer takes it elsewhere, and a login that leaves none says where it looked; a tool_choice with no tools beside it, which magpie hands the plugin as "none" when a client turned tools off (#3110), is left out before Grok
+		min:    "0.1.18", // the sign-in page opens once, where Grok Build opened it and magpie again (andyfmyth on X); a Go key the Provider API refuses is taken as Go's and asked at /alpha/generate (#969); a failure's status and its sign-in mark as the built-in's; grok-4.7's reasoning levels; a token Grok refuses early reads as expired; the sign-in renewed ahead of time through auth.refresh; a 429 shows a spent Rate limit window until it lifts; a login with no link says why; a tool whose parameters are a root union goes as a plain object (#1271); a plain Codex agent_message (a subagent's task or reply) goes as the user's message, not refused with 422 "unknown item type", a sealed one as it came (plugins#61); a model Grok lists at two windows is offered at each, grok-4.7@500k sent with x-grok-context-window (plugins#83); a window offered without a k (grok-4.7@131072) goes as that window, not as a model named so (#1679); a sign-in without Grok Build names GROK_BIN_DIR (#2223); a sign-in with no email (an X account) is kept by its xAI user id, GROK_AUTH_PATH no longer takes it elsewhere, and a login that leaves none says where it looked; a tool_choice with no tools beside it, which magpie hands the plugin as "none" when a client turned tools off (#3110), and a tool_choice object of a type Grok's backend doesn't take, which magpie hands the plugin to read so it adds no x_search over an allowed_tools (#3153), are left out before Grok
 		agents: []string{"grok"},
 		out: func() ([]Moving, error) {
 			var out []Moving
diff --git a/internal/provider/plugins.go b/internal/provider/plugins.go
index 96c6df7e..1514c794 100644
--- a/internal/provider/plugins.go
+++ b/internal/provider/plugins.go
@@ -343,7 +343,9 @@ func pluginProvider(pp plugin.Provider, l pluginLogin) Provider {
 		// them (#404): the plugin's own rewrite would leave them out; and
 		// a plain agent_message goes as the user's message, as the plugin
 		// itself sends it from 0.1.11. A lone tool_choice "none" stays,
-		// for the plugin to read (grokPluginBody, #3110)
+		// and so does a tool_choice object Grok's backend doesn't take (an
+		// allowed_tools names the client's tools), for the plugin to read
+		// (grokPluginBody, #3110, #3153)
 		a.body = grokPluginBody
 	}
 	if pp.ID == "zed" {
-- 
2.50.1 (Apple Git-155)

```
</details>

Branch with the commit: [hunt58-c-3153-grok-toolchoice](https://github.com/ggbdpq/magpie/tree/hunt58-c-3153-grok-toolchoice) (head `099cf6b2a4718eaa6e26caf5df87c287ad1e6129`).
