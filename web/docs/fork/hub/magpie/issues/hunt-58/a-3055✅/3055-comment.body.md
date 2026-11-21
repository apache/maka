## Source & environment

From #3055 (ArakawaHenri, 2026-10-20): through magpie's `magpie-responses` route in DeepSeek Harness (DSH 0.2.1-rc.2, its `@earendil-works/pi-ai` 1.1.0, protocol `openai-responses`), a tool whose schema requires only `goal_id`, `revision` and `action` came back with all six of its parameters filled; the executor rejected the extra ones (`GOAL_TOOL_INVALID_UPDATE`) and the task could not end. Setting `compat: {supportsStrictMode: true}` on that provider in DSH's config restored normal omission of optional parameters in the same session. The reporter says plainly there is no evidence magpie's gateway rewrites `required`, and points at the config magpie generates for the route (`dshPiRoute`/`dshPiCompat`/`dshKindConfig` in `internal/agent/dsh.go`). This fix stays on that side; the gateway is not touched.

## Minimal repro

A tool with a subset of required properties, on a session asked on the Responses protocol:

```json
{
  "type": "function",
  "name": "update_goal",
  "parameters": {
    "type": "object",
    "properties": {
      "goal_id": { "type": "string" },
      "revision": { "type": "number" },
      "action": { "type": "string", "enum": ["edit", "pause", "resume", "complete", "blocked"] },
      "objective": { "type": "string" },
      "max_goal_rounds": { "type": "number" },
      "blocked_reason": { "type": "string" }
    },
    "required": ["goal_id", "revision", "action"]
  }
}
```

The model fills the three optional fields too (`"objective": "", "max_goal_rounds": 10, "blocked_reason": ""`), the executor answers `objective and max_goal_rounds are valid only with action edit`, and repeated asks to leave the fields out do not help. With `supportsStrictMode: true` in the provider's compat, later calls in the same session omit the optional fields again.

## Root cause

Three facts line up:

1. magpie writes no compat at all for a route that speaks Responses. `dshPiCompat` (`internal/agent/dsh.go`) holds only `forceAdaptiveThinking`, set on `anthropic-messages` routes; `dshKindConfig` gave an `openai-responses` route nothing.
2. pi-ai omits `strict` from an ordinary tool unless the model's compat says `supportsStrictMode`: `getCompat()` in its Responses API reads `supportsStrictMode: model.compat?.supportsStrictMode ?? false`, and `convertResponsesTools()` writes `strict` into the tool object only `if (supportsStrictMode)` — so with the flag unset the field is left out, and with it set an ordinary tool is sent as `strict: false` (verified in pi-ai's own source, `src/api/openai-responses.ts` and `src/api/openai-responses-shared.ts`, and by its `openai-responses-compat.test.ts`, which expects `{name: "ordinary", strict: false}` for a tool with an optional property).
3. OpenAI's Responses API takes a function tool whose `strict` is left out as a strict-mode one and normalizes its schema, where all fields in `properties` must be marked `required` (their function-calling guide: omitting `strict` in Responses "will attempt to normalize your schema into strict mode when possible"; Chat Completions stays non-strict by default). That is the filling the report saw.

So the optional parameters were filled not by the gateway and not by the schema, but by the upstream's strict-mode normalization of a tool that could not say "non-strict" — because the config magpie wrote gave pi-ai no way to say it.

## Fix

- `internal/agent/dsh.go`: `dshPiCompat` gains `supportsStrictMode`, and `dshKindConfig` sets it on every model of a route whose api stands as `openai-responses` — by the api the route has now (the one the user picked in dsh's Models page kept, `dshAPI`), not by the route's name, so a route switched to Chat or Messages carries none. It is magpie's own switch, put as magpie has it now, beside the keys the user set by hand, which `dshKeepCompat` keeps as before (#2504).
- `internal/agent/agents.go`: `piModelJSON` — the entries Pi and StepCode carry in their `models.json` — sets the same compat on a model best served on Responses, next to the `api: openai-responses` it already wrote. Pencil's entries go through the same function with `native` false and stay on Chat throughout, so they take none.
- Siblings checked, unchanged: omp is a Pi fork but its `models.yml` is taken or left whole over a field its schema doesn't name (16.3.5 turns a file away over a max), so writing the compat there needs an omp version pinned first, as `promptCacheSessionHeader` needed `ompSessionSince`; lody and Cindy take a link payload of their own, ZCode, droid, OpenCode, Crush and jcode their own clients, so pi-ai's compat is not theirs to read.
- `docs/subsystems/agent-wiring.md`: the dsh paragraph says the new switch and why.
- `internal/agent/responses_strict_test.go`: `TestDshTellsAResponsesToolsStrictIsOff` (the plain routes, a round over what it wrote leaving the file as it is, a user-switched api on both directions, and a hand-set key surviving beside magpie's switch) and `TestPiTellsAResponsesToolsStrictIsOff` (Pi's `models.json` after a catalog sync).

## Verification

| Check | Command | Result |
|---|---|---|
| New tests, base commit | both fix files back at `f5b01574`, tests kept | FAIL (build): `m.Compat.SupportsStrictMode undefined` — the switch the fix adds does not exist there |
| DSH test, dsh case removed only | `go test ./internal/agent/ -run TestDshTellsAResponsesToolsStrictIsOff -count=1` | FAIL: `a model asked on Responses isn't told strict is off: Compat:<nil>` |
| Pi test, piModelJSON compat removed only | `go test ./internal/agent/ -run TestPiTellsAResponsesToolsStrictIsOff -count=1` | FAIL: `resp/gpt-5.5 is asked on Responses and isn't told strict is off` |
| Cross guard | each single removal with the other face in place | the other test stays green (each test holds its own face) |
| New tests, fixed | `go test ./internal/agent/ -run 'TestDshTellsAResponsesToolsStrictIsOff|TestPiTellsAResponsesToolsStrictIsOff' -count=1` | ok |
| Full owning package | `go test ./internal/agent/` | one FAIL: `TestMothX` — fails the same with both fix files back at the baseline on this machine (its detect; not from this change); everything else ok, 164.7s |
| gofmt | `gofmt -l` on the changed files | clean |
| go vet | host `go vet ./...`; `GOOS=linux GOARCH=amd64 go vet -tags nogui ./...`; `GOOS=windows GOARCH=amd64 go vet ./...` | clean |
| Builds | `go build .` (darwin arm64); `CGO_ENABLED=0 GOOS={linux,darwin} GOARCH=amd64 go build -tags nogui .`; `GOOS=windows GOARCH=amd64 go build -o /dev/null .` | ok on all four |

## Not verified

- No real DSH session was run: the failing shape is the reporter's (tool catalog, call log, before/after of their config), and the tests hold magpie's side of the wire — the config magpie writes — not a captured DSH-to-gateway request body.
- pi-ai's strict semantics are read from pi-ai's own open source (the `@earendil-works/pi-ai` the report names; `getCompat`, `convertResponsesTools` and its compat test) and OpenAI's function-calling guide, not from DSH's installed 1.1.0 tree; the report quotes 1.1.0 behaving as the source says.
- The bare `GOOS=linux GOARCH=amd64 go vet ./...` and the bare `GOOS=darwin GOARCH=amd64 go build .` fail inside the `wails/v3` module dependency on this machine, with the fix reverted too; the repo's own cross-platform checks (`-tags nogui`) pass.
- omp is left for a change of its own that pins the first omp whose schema takes the compat (the report is dsh's).

Branch with the commit: [hunt58-a-3055](https://github.com/ggbdpq/magpie/tree/hunt58-a-3055) (head `76a40b013b9c3474efeb570eed75daaca924fb24`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: agent: a tool asked on Responses says strict: false, its optional parameters stay optional (#3055) — git am applies it as is; SHA-256 first 16: 1499c2c813496c83</summary>

```patch
From 76a40b013b9c3474efeb570eed75daaca924fb24 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 23:32:14 +0800
Subject: [PATCH] agent: a tool asked on Responses says strict: false, its
 optional parameters stay optional (#3055)

What changed: OpenAI's Responses API takes a function tool whose strict
is left out as a strict-mode one and normalizes its schema, where every
property is required, so a tool's optional parameters came back filled
(#3055, ArakawaHenri). pi-ai (dsh's llm-pi-ai, Pi and its kin) says
strict: false on an ordinary tool only when the model's compat says
supportsStrictMode, which it takes as false where the compat is left
out. magpie now says it: every model of a dsh route whose api stands as
openai-responses carries compat.supportsStrictMode, by the api the route
has now (the one the user picked in dsh's Models page kept), not by its
name, beside the keys they set there (dshKeepCompat); and piModelJSON
says it for a model best served on Responses, which Pi's and StepCode's
models.json carry (Pencil's entries stay on Chat throughout). omp's
models.yml is left alone: omp turns a models.yml away over a field its
schema doesn't name (16.3.5 over a max), so the compat needs an omp
version of its own pinned first. docs/subsystems/agent-wiring.md says
so.

Run: new TestDshTellsAResponsesToolsStrictIsOff and
TestPiTellsAResponsesToolsStrictIsOff fail without the change (the
first with "a model asked on Responses isn't told strict is off:
Compat:<nil>", the second with "resp/gpt-5.5 is asked on Responses and
isn't told strict is off") and pass with it; removing only the dsh case
turns the first red and only it, removing only the piModelJSON compat
line turns the second red and only it. go test ./internal/agent/
(TestMothX fails the same with both files back at the baseline here, so
not from this change), gofmt -l on the changed files (nothing), go vet
./..., GOOS=linux GOARCH=amd64 go vet -tags nogui ./...,
GOOS=windows GOARCH=amd64 go vet ./..., go build . (darwin arm64),
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -tags nogui .,
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -tags nogui .,
GOOS=windows GOARCH=amd64 go build -o /dev/null .

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/agent-wiring.md         |   2 +-
 internal/agent/agents.go                |   5 +
 internal/agent/dsh.go                   |  18 ++-
 internal/agent/responses_strict_test.go | 159 ++++++++++++++++++++++++
 4 files changed, 181 insertions(+), 3 deletions(-)
 create mode 100644 internal/agent/responses_strict_test.go

diff --git a/docs/subsystems/agent-wiring.md b/docs/subsystems/agent-wiring.md
index 97445d12..d246ed41 100644
--- a/docs/subsystems/agent-wiring.md
+++ b/docs/subsystems/agent-wiring.md
@@ -57,7 +57,7 @@ something else shows up as drift.
   - Each model magpie writes into ZCode's `providerModelRules` has native web search (`properties.supportsNativeWebSearch`, "原生联网搜索") on while the provider's format is Anthropic Messages, the only format ZCode sends it on (`zcodeWebSearch`). The models magpie turned it on for are kept in the stash under `zcode.web_search`, so a model the user unticked in ZCode (which takes the key out of the rule) stays off, a value in the rule stays, a manual rule is left alone, and a stash that can't be read turns nothing on. On another format magpie's own on is taken out. Disconnect forgets the list.
   - The YAML ones go through `yamlKept` and `mergeKept` in [`sync.go`](../../internal/agent/sync.go). Each is tested by a `Test<Agent>KeepsTheUsersSettings`.
 - Copilot in JetBrains IDEs keeps its Bring Your Own Key providers in the Copilot language server's `byok.json`, shared with Xcode's and Eclipse's Copilot (`copilotJetBrains` in [`copilotjetbrains.go`](../../internal/agent/copilotjetbrains.go)). magpie writes its own three keys there, `magpie-provider-config`, `magpie-api-key` and `magpie-models-config`, in the bytes the server itself writes, and only when they differ; the user's providers and keys stay. A magpie model the user hid in Manage Models (`isRegistered: false`) stays hidden through a sync. A new file is made 0600 in a 0700 folder, as the server makes it.
-- dsh (DeepSeek Harness) sets one API per llm-pi-ai route, so magpie writes a route per protocol (`dshKinds` in [`dsh.go`](../../internal/agent/dsh.go); 01huadalang on Discord): `magpie` (Chat Completions) for most models, `magpie-responses` (`openai-responses`) for a model served on Responses, `magpie-anthropic` (`anthropic-messages`, the gateway root, `forceAdaptiveThinking` where `AdaptiveThinking`) for one served on Messages, by the model's `APIs` (`dshRouteOf`). A model's `APIs` is the one its provider serves it on best (`Provider.Native`, in `magpieModels`, [`route.go`](../../internal/agent/route.go)), and Pi, omp and droid read it the same way. A routing group has `responses` when every member is best on Responses (`allResponses`, #1594), so its tool-call arguments are relayed as they stream; any other group has none and stays on Chat, a Messages-only group too, as a Claude member's thinking is known by its own model. A route with no models is taken out. An api the user picked for a route in dsh's Models page is kept, and so are keys they added there. The start (`agent-default-model`) names its model's route, and Sync moves a start on one of magpie's routes to the route its model is now on (`dshStartOnItsRoute`), its effort and marks kept. Check asks the route the start names to list its model. A dsh session resumed on a model that has since moved routes asks for the model to be picked again, since dsh finds a model by route and id.
+- dsh (DeepSeek Harness) sets one API per llm-pi-ai route, so magpie writes a route per protocol (`dshKinds` in [`dsh.go`](../../internal/agent/dsh.go); 01huadalang on Discord): `magpie` (Chat Completions) for most models, `magpie-responses` (`openai-responses`) for a model served on Responses, `magpie-anthropic` (`anthropic-messages`, the gateway root, `forceAdaptiveThinking` where `AdaptiveThinking`) for one served on Messages, by the model's `APIs` (`dshRouteOf`). A model's `APIs` is the one its provider serves it on best (`Provider.Native`, in `magpieModels`, [`route.go`](../../internal/agent/route.go)), and Pi, omp and droid read it the same way. A routing group has `responses` when every member is best on Responses (`allResponses`, #1594), so its tool-call arguments are relayed as they stream; any other group has none and stays on Chat, a Messages-only group too, as a Claude member's thinking is known by its own model. A route with no models is taken out. An api the user picked for a route in dsh's Models page is kept, and so are keys they added there. A model of a route whose api stands as `openai-responses` carries `compat.supportsStrictMode` (#3055): OpenAI's Responses API takes a function tool whose `strict` is left out as a strict-mode one, every property required, so a tool's optional parameters come back filled; pi-ai says `strict: false` on an ordinary tool only when the compat says so, by the api the route has, not by its name. The start (`agent-default-model`) names its model's route, and Sync moves a start on one of magpie's routes to the route its model is now on (`dshStartOnItsRoute`), its effort and marks kept. Check asks the route the start names to list its model. A dsh session resumed on a model that has since moved routes asks for the model to be picked again, since dsh finds a model by route and id.
 - dsh takes a model's listed `maxTokens` as every request's output and reserves it, with 65536 of headroom, out of `contextWindow` before deciding when to compact (compaction-basic's `resolveCompactSpec`: the smaller of 80% of the window and window − maxTokens − 65536). A vendor's reply limit near its window had dsh compact at 41248 of a 500000 group (#2823) or fail with no budget (524288/524288, LoKi on Discord; 131072/65536), so magpie lists it held to a quarter of the window on every route and in the older `llm-deepseek` entry (`dshMaxTokens`), as VS Code and Copilot in JetBrains do. A Max output the user set stays as they set it (`outputOr`), even one that leaves dsh no budget. `TestDshOutputLeavesCompactionRoom`.
 - While magpie serves, `KeepDshWired` writes the routes again every 30 seconds, since dsh writes over its patch list. A round that writes nothing is kept (`dshRounds`), and the next round does nothing when nothing it reads has changed since. It checks the bytes of dsh's files (every profile's `cordis.patch.yml`, the home layer, `settings.yaml`, `.env`, `.credentials.yaml`, `config.yaml`) and the gateway's address. It also checks `provider.StampNow`: no Changed, plugin change or `filememo.Forget`, the same environment, and the providers', settings' and catalog's files unchanged. The models are built again when that stamp moves, and at least every `dshModelsFor` (5 minutes) for what no stamp sees, such as another app's account file or a date-retired model. Building the whole catalog and every route each round allocated 12 GB of a user's 35.7 GB in 48 minutes (`TestDshRoundWithNothingChangedBuildsNothing`, `TestDshRoundAfterAChangeWritesAgain`).
 - DeepSeek Harness Desktop (macOS arm64 and Windows x64; no Linux build) reads the same `$DSH_HOME` or `~/.dsh` as the CLI, as its own profile `profiles/desktop` (`resolveDshHome` and `resolveDesktopPaths` in the app's `lib/main.js`), so it takes magpie's routes with no wiring of its own (#2279, liangjinyuan-sihan). It is found by `/Applications/DeepSeek Harness.app`, by `%LOCALAPPDATA%\Programs\DeepSeek Harness`, or by the folder its current-user installer records under `HKCU\Software\1bf39983-50d0-5fe0-9ef4-cece76f67c5e` (`InstallLocation`), whose Uninstall key gives the version (`registered` in [`desktopapp.go`](../../internal/agent/desktopapp.go)), so a user who picked another folder is found. With the app installed but never opened there is no `~/.dsh`: the row is still listed, and connecting writes `profiles/desktop/cordis.patch.yml` from dsh's own template (`dshProfileTemplate`) with magpie's routes, which the app keeps on its first start, since it writes only the files that are missing. The notice says the app starts on it the first time it opens (`noticeDsh5`). Disconnect before that first start removes the profile magpie made when nothing else is in it (`dshTidyUnopened`); once the app has opened it, the profile stays and only magpie's entries go (`TestDshDesktopNeverOpened`, `TestDshDesktopRegisteredFolder`).
diff --git a/internal/agent/agents.go b/internal/agent/agents.go
index 4a4d1e26..5e04f676 100644
--- a/internal/agent/agents.go
+++ b/internal/agent/agents.go
@@ -537,7 +537,12 @@ func piModelJSON(m catalog.Model, gw string, native bool) map[string]any {
 	switch {
 	case !native:
 	case slices.Contains(m.APIs, string(provider.Responses)):
+		// strict left out of a tool of a turn asked there is taken as a
+		// strict-mode schema, every property required, optional ones
+		// filled (#3055): pi-ai says strict: false on an ordinary tool
+		// only when the model's compat says so
 		e["api"] = "openai-responses"
+		e["compat"] = map[string]any{"supportsStrictMode": true}
 	case slices.Contains(m.APIs, string(provider.Anthropic)):
 		e["api"], e["baseUrl"] = "anthropic-messages", gw
 		if gateway.AdaptiveThinking(m.ID) {
diff --git a/internal/agent/dsh.go b/internal/agent/dsh.go
index a81ad281..d590306d 100644
--- a/internal/agent/dsh.go
+++ b/internal/agent/dsh.go
@@ -1336,9 +1336,14 @@ type dshPiModel struct {
 
 // dshPiCompat is a model's compat switches. On Anthropic's Messages API
 // pi-ai asks a model for a thinking budget unless forceAdaptiveThinking is
-// set, and a Claude that thinks only adaptively turns a budget away.
+// set, and a Claude that thinks only adaptively turns a budget away. On
+// OpenAI's Responses API supportsStrictMode has pi-ai say strict: false on
+// an ordinary tool: with strict left out the API normalizes a tool's
+// schema as a strict-mode one, where every property is required, and a
+// tool's optional parameters come back filled (#3055).
 type dshPiCompat struct {
 	ForceAdaptiveThinking bool `yaml:"forceAdaptiveThinking,omitempty"`
+	SupportsStrictMode    bool `yaml:"supportsStrictMode,omitempty"`
 }
 
 // dshAPIs are the wire protocols of llm-pi-ai's (pi-ai's api names) a route
@@ -1545,8 +1550,17 @@ func dshKindConfig(k dshKind, models []catalog.Model, api, gw string) dshPiRoute
 			e.Input = []string{"text"}
 		}
 		_, e.ReasoningEfforts = dshModelLevels(m.Efforts)
-		if api == "anthropic-messages" && gateway.AdaptiveThinking(m.ID) {
+		// each switch is magpie's own, put as magpie has it now: a user's
+		// hand-set one of the same name says what magpie writes again says
+		switch {
+		case api == "anthropic-messages" && gateway.AdaptiveThinking(m.ID):
 			e.Compat = &dshPiCompat{ForceAdaptiveThinking: true}
+		case api == "openai-responses":
+			// by the api the route stands on (the one the user picked in
+			// dsh's Models page kept), not by its name: a tool of a turn
+			// asked there with strict left out has every property taken as
+			// required, its optional ones filled (#3055)
+			e.Compat = &dshPiCompat{SupportsStrictMode: true}
 		}
 		r.Models = append(r.Models, e)
 	}
diff --git a/internal/agent/responses_strict_test.go b/internal/agent/responses_strict_test.go
new file mode 100644
index 00000000..6694342c
--- /dev/null
+++ b/internal/agent/responses_strict_test.go
@@ -0,0 +1,159 @@
+package agent
+
+import (
+	"encoding/json"
+	"os"
+	"path/filepath"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// dshModelOf is the model id of a route as dshPiProviders parsed it.
+func dshModelOf(t *testing.T, ps map[string]dshPiRoute, key, id string) *dshPiModel {
+	t.Helper()
+	r, ok := ps[key]
+	if !ok {
+		t.Fatalf("no route %s", key)
+	}
+	for i := range r.Models {
+		if r.Models[i].ID == id {
+			return &r.Models[i]
+		}
+	}
+	t.Fatalf("route %s has no %s: %+v", key, id, r.Models)
+	return nil
+}
+
+// #3055 (ArakawaHenri): OpenAI's Responses API takes a function tool whose
+// strict is left out as a strict-mode one and normalizes its schema, where
+// every property is required, so a tool's optional parameters came back
+// filled. pi-ai says strict: false on an ordinary tool only when the
+// model's compat says supportsStrictMode, which it takes as false where
+// the compat is left out — as magpie's routes were. magpie now says it on
+// every model of a route whose api stands as openai-responses (the one a
+// user picked in dsh's Models page kept), and on none of a Chat or
+// Messages route.
+func TestDshTellsAResponsesToolsStrictIsOff(t *testing.T) {
+	home, dir, web := dshProtocolHome(t)
+	dshKeyFixture(dir)
+	os.WriteFile(web, []byte("# Your patch layer for this dsh profile.\n"), 0o644)
+	a := dsh(home)
+	if err := a.Field("model").Set("magpie/resp/gpt-5.5"); err != nil {
+		t.Fatal(err)
+	}
+	ps := dshPiProviders(t, web)
+	if m := dshModelOf(t, ps, "magpie-responses", "resp/gpt-5.5"); m.Compat == nil || !m.Compat.SupportsStrictMode {
+		t.Fatalf("a model asked on Responses isn't told strict is off: %+v", m)
+	}
+	if m := dshModelOf(t, ps, "magpie", "deepseek/pro"); m.Compat != nil && m.Compat.SupportsStrictMode {
+		t.Fatalf("a Chat model was told strict is off: %+v", m)
+	}
+	if dshModelOf(t, ps, "magpie", "deepseek/flash").Compat != nil {
+		t.Fatal("a Chat model took a compat of its own")
+	}
+	if m := dshModelOf(t, ps, "magpie-anthropic", "anth/claude-sonnet-5"); m.Compat == nil || !m.Compat.ForceAdaptiveThinking || m.Compat.SupportsStrictMode {
+		t.Fatalf("a Claude on Messages: %+v", m)
+	}
+
+	// a round over what it wrote leaves it as it is
+	was, _ := os.ReadFile(web)
+	dshWiredOnce()
+	if again, _ := os.ReadFile(web); string(again) != string(was) {
+		t.Fatalf("written again:\n%s", again)
+	}
+
+	// the api a user picked for a route in dsh's Models page decides, not
+	// the route's name: magpie's first route on Responses tells its Chat
+	// models strict is off and keeps a key of theirs beside magpie's; the
+	// responses route on Chat tells its model nothing there
+	os.WriteFile(web, []byte("# Your patch layer for this dsh profile.\n"+
+		"- id: llm-pi-ai # magpie\n  name: \"@deepseek-ai/dsh-llm-pi-ai\"\n  config:\n    providers:\n"+
+		"      magpie:\n        displayName: Magpie\n        apiKeyEnv: "+dshKeyRef+"\n        api: openai-responses\n        baseURL: "+gatewayV1()+"\n        models:\n"+
+		"          - id: deepseek/pro\n            compat:\n              maxTokensField: max_tokens\n"+
+		"      magpie-responses:\n        displayName: Magpie · Responses\n        apiKeyEnv: "+dshKeyRef+"\n        api: openai-completions\n        baseURL: "+gatewayV1()+"\n        models:\n"+
+		"          - id: resp/gpt-5.5\n"), 0o644)
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	b, _ := os.ReadFile(web)
+	_, compat := dshRouteCompat(t, web, "magpie")
+	c := compat["deepseek/pro"]
+	if c["supportsStrictMode"] != true || c["maxTokensField"] != "max_tokens" {
+		t.Fatalf("a Chat model on a route switched to Responses: %v\n%s", c, b)
+	}
+	_, compat = dshRouteCompat(t, web, "magpie-responses")
+	if c = compat["resp/gpt-5.5"]; c != nil && c["supportsStrictMode"] == true {
+		t.Fatalf("a model on a route switched to Chat was told strict is off: %v\n%s", c, b)
+	}
+}
+
+// The same for Pi's and StepCode's model entries (piModelJSON): a model
+// best served on Responses carries compat.supportsStrictMode, a Chat
+// model's entry carries no compat at all. Pencil's entries stay on Chat
+// throughout, so it takes none.
+func TestPiTellsAResponsesToolsStrictIsOff(t *testing.T) {
+	home := syncHome(t)
+	if err := provider.Save(provider.Provider{ID: "resp", Name: "Resp", Key: "k", Responses: "http://127.0.0.1:1/v1", Models: []string{"gpt-5.5"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive("resp", "http://127.0.0.1:1/v1", []catalog.Model{{ID: "gpt-5.5", Efforts: []string{"high"}}}); err != nil {
+		t.Fatal(err)
+	}
+	piModels := filepath.Join(home, ".pi", "agent", "models.json")
+	// the provider block as magpie wrote it before this provider was, with
+	// a key of pi-cache-optimizer's in it
+	writeFile(t, piModels, `{
+  "providers": {
+    "magpie": {
+      "api": "openai-completions",
+      "apiKey": "magpie",
+      "baseUrl": "http://127.0.0.1:3425/v1",
+      "compat": {
+        "sendSessionAffinityHeaders": true
+      },
+      "models": [
+        {
+          "id": "gone/old-model",
+          "name": "Old"
+        }
+      ],
+      "name": "magpie"
+    }
+  }
+}
+`)
+	SyncCatalog()
+	b, err := os.ReadFile(piModels)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var f struct {
+		Providers struct {
+			Magpie struct {
+				Models []struct {
+					ID     string         `json:"id"`
+					API    string         `json:"api"`
+					Compat map[string]any `json:"compat"`
+				} `json:"models"`
+			} `json:"magpie"`
+		} `json:"providers"`
+	}
+	if err := json.Unmarshal(b, &f); err != nil {
+		t.Fatalf("%v:\n%s", err, b)
+	}
+	strict := map[string]bool{}
+	for _, m := range f.Providers.Magpie.Models {
+		if m.API == "openai-responses" && m.Compat["supportsStrictMode"] != true {
+			t.Fatalf("%s is asked on Responses and isn't told strict is off:\n%s", m.ID, b)
+		}
+		strict[m.ID] = m.Compat["supportsStrictMode"] == true
+	}
+	if !strict["resp/gpt-5.5"] {
+		t.Fatalf("no responses model of magpie's carries supportsStrictMode:\n%s", b)
+	}
+	if strict["relay/glm-4.6"] {
+		t.Fatalf("a Chat model was told strict is off:\n%s", b)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
