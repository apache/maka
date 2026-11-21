Thanks for the report — and sorry it sat. I re-checked it against current main first: the mechanism below is as you described, and the error text still appears nowhere in magpie, so it comes from Cline's API as you concluded.

## What happens, re-checked on main

Muse sends its tools as one Responses namespace, `muse`. magpie translates a Responses client's tools for every upstream it doesn't relay to, and it offered a namespace's tools flat: `muse__read_file`, `muse__bash`, … (`parseResponses` in `internal/gateway/responses.go`, `provider.FlatName`). The call came back by that flat name alone and was given its namespace again on the way out (`callTo`), so magpie was self-consistent — but the list Cline's API received was the flat one, and Muse Spark, trained on Muse's own tool names, answers with the plain ones. The call never matches what was declared, and Cline rejects it before magpie sees anything. Your sandbox repro pinned this down; I could not re-run it (no Muse binary or Cline account here), so I pinned the same shape at the assertion level instead: at the parent of my commit, the declaration list a fake chat upstream receives reads `muse__read_file`-style, and a plain-name call comes back to the client with its namespace lost — both red exactly as the report says.

## Why only the declaration can fix it

Accepting the plain name on the way back cannot help here: Cline validates the model's call against the request's `tools` and refuses inside its API, so whatever magpie would do with a plain call never happens. The declaration has to carry the names the model will say.

## What changed

A namespace's tools are now offered under their own names when no other tool in the request claims that name — none at the top level, none in another namespace, no flat name, none of the tool search served — and keep the flat form otherwise, which also still cuts a longer name to fit. This is the way Responses Lite already ships Codex's own functions bare (`liftAdditionalTools`), and the spirit of the Kiro long-name fix (#1393): the name the other side will say is the name declared, with the original mapped back on return. The conversation's earlier calls and an `allowed_tools` list read the same names, so a tool goes by one name the whole request through; the flat name is answered too, since a model may say it anyway (a Grok subscription's does, whose request is relayed reshaped, not translated).

You were right to flag the blast radius: this is how every Responses client's namespaced tools reach translated upstreams, Codex's included. The collision rule keeps two tools from ever sharing a name, and a call under either form lands on the client's tool with its namespace — the existing tests for Grok's reshaped relay, Codex's custom tools, the image tool and tool search all pass unchanged or with only their expected names updated.

## Verification

| Check | Result |
|---|---|
| `go test -tags nogui ./internal/gateway` (whole package) | ok |
| `go test -tags nogui ./internal/provider` | ok |
| New tests at the parent of the commit | 11 fail, as they should |
| Same tests with the commit | ok |
| `gofmt -l internal/gateway` | clean |
| `go vet ./...` (darwin) | ok |
| `GOOS=linux go vet -tags nogui ./...` | ok |
| `GOOS=windows go vet -tags nogui ./...` | ok |
| `go build` (darwin, linux, windows) | ok |

## Not verified

Nothing tried against Cline or Muse itself: no Muse Code install and no Cline account on this machine, so the repro stays your sandbox's. `TestMothX` and `TestProxyCheckSaysAProxyPassedBy` fail in `internal/agent` and `internal/gui` on the parent commit as well — pre-existing, untouched by this.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a Responses client's namespace tools go to the model under their own names when no other tool claims them (#1448) — git am applies it as is; SHA-256 first 16: 681ad982b2d30912</summary>

```patch
From 9e3ed461a5f8649bdbeab5e1774a6a99d4755ff6 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 07:51:02 +0800
Subject: [PATCH] gateway: a Responses client's namespace tools go to the model
 under their own names when no other tool claims them (#1448)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A Responses client's tools in a namespace reached every translated
upstream flat, muse__read_file and the like, and the call came back by
that flat name alone to be given its namespace again. Muse Code's are:
Muse Spark 1.3 free on Cline answers a muse__-flat list with
"undeclared_tool: Upstream called a tool not declared by the client" —
the model knows Muse's tools by their own names and calls them so, the
call never matches what was declared, and Cline's API turns it away
before magpie sees anything.

So a namespace tool is now offered under its own name when that name is
unclaimed — none at the top level, none in another namespace, no flat
name, none of the tool search served — and keeps the flat form
otherwise, which also still cuts a longer one to fit. This is the way
Responses Lite already ships Codex's own functions bare
(liftAdditionalTools), and the way the Kiro mover's short names work
(#1393): the name the other side will say is the name declared, and the
call comes back to the client under its namespace either way, the
conversation's earlier calls and an allowed_tools list reading the same
names. The flat name is answered too, as a model may say it anyway — a
Grok subscription's does, whose request is relayed reshaped (grokBody),
not translated.

Run: go test -tags nogui ./internal/gateway ./internal/provider (ok);
go vet (darwin, linux, windows, nogui) and gofmt -l on
./internal/gateway (clean); go build (darwin, linux, windows). Not tried
against Cline: no Muse Code or Cline account on this machine.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/additional_tools_test.go     |   9 +-
 internal/gateway/codex_custom_tools_test.go   |  17 ++-
 internal/gateway/codex_ultra_test.go          |   2 +-
 internal/gateway/image_tool_test.go           |   5 +-
 internal/gateway/namespace_search_test.go     |   6 +-
 internal/gateway/namespace_test.go            | 130 ++++++++++++++++--
 internal/gateway/responses.go                 |  90 ++++++++++--
 .../gateway/responses_allowed_tools_test.go   |   2 +-
 8 files changed, 222 insertions(+), 39 deletions(-)

diff --git a/internal/gateway/additional_tools_test.go b/internal/gateway/additional_tools_test.go
index 1c9524da..af5b113c 100644
--- a/internal/gateway/additional_tools_test.go
+++ b/internal/gateway/additional_tools_test.go
@@ -79,15 +79,20 @@ func TestAdditionalToolsTranslated(t *testing.T) {
 		names = append(names, tl.Name)
 	}
 	// apply_patch, a custom tool, is offered as a function taking its input
-	if want := "tool_search shell apply_patch mcp__probe__read"; strings.Join(names, " ") != want {
+	if want := "tool_search shell apply_patch read"; strings.Join(names, " ") != want {
 		t.Fatalf("tools %v, want %s", names, want)
 	}
 	if !r.Namespaced["apply_patch"].Custom {
 		t.Fatalf("apply_patch not custom: %+v", r.Namespaced)
 	}
-	if r.Namespaced["mcp__probe__read"] != (nsTool{Namespace: "mcp__probe", Name: "read"}) {
+	if r.Namespaced["read"] != (nsTool{Namespace: "mcp__probe", Name: "read"}) {
 		t.Fatalf("namespace lost: %+v", r.Namespaced)
 	}
+	// the flat name is answered too, so a call under it comes back by the
+	// namespace all the same
+	if r.Namespaced["mcp__probe__read"] != (nsTool{Namespace: "mcp__probe", Name: "read"}) {
+		t.Fatalf("flat name lost: %+v", r.Namespaced)
+	}
 	if r.System != "You are Codex." {
 		t.Fatalf("system %q", r.System)
 	}
diff --git a/internal/gateway/codex_custom_tools_test.go b/internal/gateway/codex_custom_tools_test.go
index daa24520..bfa1f85c 100644
--- a/internal/gateway/codex_custom_tools_test.go
+++ b/internal/gateway/codex_custom_tools_test.go
@@ -77,7 +77,7 @@ func TestCodexCustomToolsTranslated(t *testing.T) {
 	for _, tl := range up.Tools {
 		names = append(names, tl.Function.Name)
 	}
-	if want := "exec wait collaboration__spawn_agent"; strings.Join(names, " ") != want {
+	if want := "exec wait spawn_agent"; strings.Join(names, " ") != want {
 		t.Fatalf("tools %v, want %s\n%s", names, want, f.got)
 	}
 	exec := up.Tools[0].Function
@@ -133,14 +133,19 @@ func TestCodexCustomToolNamespaced(t *testing.T) {
 	if err != nil {
 		t.Fatal(err)
 	}
-	if len(r.Tools) != 2 || r.Tools[0].Name != "mcp__pad__write" || r.Tools[1].Name != "apply_patch" || strings.Contains(r.Tools[0].Description, "grammar") {
+	// a custom tool in a namespace of its own goes to the model under its
+	// own name (#1448), and its call comes back under the namespace by
+	// either name it may be called
+	if len(r.Tools) != 2 || r.Tools[0].Name != "write" || r.Tools[1].Name != "apply_patch" || strings.Contains(r.Tools[0].Description, "grammar") {
 		t.Fatalf("tools: %+v", r.Tools)
 	}
-	item := callTo(map[string]any{"type": "function_call", "call_id": "c", "arguments": `{"input":"x"}`}, "mcp__pad__write", r.Namespaced)
-	if item["type"] != "custom_tool_call" || item["name"] != "write" || item["namespace"] != "mcp__pad" || item["input"] != "x" {
-		t.Fatalf("namespaced call: %v", item)
+	for _, called := range []string{"write", "mcp__pad__write"} {
+		item := callTo(map[string]any{"type": "function_call", "call_id": "c", "arguments": `{"input":"x"}`}, called, r.Namespaced)
+		if item["type"] != "custom_tool_call" || item["name"] != "write" || item["namespace"] != "mcp__pad" || item["input"] != "x" {
+			t.Fatalf("namespaced call by %q: %v", called, item)
+		}
 	}
-	item = callTo(map[string]any{"type": "function_call", "call_id": "c", "arguments": `*** Begin Patch`}, "apply_patch", r.Namespaced)
+	item := callTo(map[string]any{"type": "function_call", "call_id": "c", "arguments": `*** Begin Patch`}, "apply_patch", r.Namespaced)
 	if item["type"] != "custom_tool_call" || item["input"] != "*** Begin Patch" || item["namespace"] != nil {
 		t.Fatalf("plain call: %v", item)
 	}
diff --git a/internal/gateway/codex_ultra_test.go b/internal/gateway/codex_ultra_test.go
index 925cb483..ed5c280f 100644
--- a/internal/gateway/codex_ultra_test.go
+++ b/internal/gateway/codex_ultra_test.go
@@ -208,7 +208,7 @@ func TestCopilotUltraSubagentWithWebSearch(t *testing.T) {
 	}
 	// made again for Copilot, not relayed: its tools flat, the search
 	// magpie's
-	if lead, _ := json.Marshal(c.last(t)["tools"]); !strings.Contains(string(lead), `"collaboration__spawn_agent"`) || strings.Contains(string(lead), `"encrypted"`) {
+	if lead, _ := json.Marshal(c.last(t)["tools"]); !strings.Contains(string(lead), `"spawn_agent"`) || strings.Contains(string(lead), `"encrypted"`) {
 		t.Fatalf("lead's tools to Copilot: %s", lead)
 	}
 	var call map[string]any
diff --git a/internal/gateway/image_tool_test.go b/internal/gateway/image_tool_test.go
index c50d3076..b8f889ca 100644
--- a/internal/gateway/image_tool_test.go
+++ b/internal/gateway/image_tool_test.go
@@ -36,9 +36,10 @@ func noNamespaces(got *[]string, refuse bool) http.HandlerFunc {
 }
 
 // hasImageTool reports whether a request offers Codex's image tool, in its
-// namespace or flat as magpie translates it.
+// namespace, or under the name magpie offers it to the model by (its own
+// when no other tool claims it, the flat one otherwise).
 func hasImageTool(body string) bool {
-	return strings.Contains(body, `"type":"namespace"`) || strings.Contains(body, `"image_gen__imagegen"`)
+	return strings.Contains(body, `"type":"namespace"`) || strings.Contains(body, `"image_gen__imagegen"`) || strings.Contains(body, `"name":"imagegen"`)
 }
 
 // Codex on a magpie model offers its image tool, as #870 has it, in the
diff --git a/internal/gateway/namespace_search_test.go b/internal/gateway/namespace_search_test.go
index 8386afe5..108cedf0 100644
--- a/internal/gateway/namespace_search_test.go
+++ b/internal/gateway/namespace_search_test.go
@@ -25,7 +25,7 @@ func TestNamespacedCallKeepsArgsWhenSearchTakesOver(t *testing.T) {
 			return
 		}
 		b, _ := io.ReadAll(r.Body)
-		if !strings.Contains(string(b), `"collaboration__spawn_agent"`) {
+		if !strings.Contains(string(b), `"spawn_agent"`) {
 			http.Error(w, `{"error":{"message":"no spawn_agent: `+strings.ReplaceAll(string(b), `"`, `'`)+`"}}`, 400)
 			return
 		}
@@ -38,10 +38,10 @@ func TestNamespacedCallKeepsArgsWhenSearchTakesOver(t *testing.T) {
 		w.Header().Set("Content-Type", "text/event-stream")
 		io.WriteString(w, sse(
 			`data: {"type":"response.created","response":{"id":"r1","model":"m"}}`,
-			`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"collaboration__spawn_agent","arguments":""}}`,
+			`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"spawn_agent","arguments":""}}`,
 			`data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":""}`,
 			`data: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","arguments":`+string(quoted)+`}`,
-			`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"collaboration__spawn_agent","arguments":`+string(quoted)+`,"status":"completed"}}`,
+			`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"spawn_agent","arguments":`+string(quoted)+`,"status":"completed"}}`,
 			`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":5}}}`,
 		))
 	}))
diff --git a/internal/gateway/namespace_test.go b/internal/gateway/namespace_test.go
index 45a8275c..3aed5bdb 100644
--- a/internal/gateway/namespace_test.go
+++ b/internal/gateway/namespace_test.go
@@ -28,20 +28,114 @@ func TestNamespacedToolsOffered(t *testing.T) {
 	for _, tl := range r.Tools {
 		names = append(names, tl.Name)
 	}
-	if got := strings.Join(names, ","); got != "exec_command,collaboration__spawn_agent,collaboration__freeform" {
+	// a namespace tool no other tool claims by its own name goes to the
+	// model under it (#1448), and still comes back by its namespace
+	if got := strings.Join(names, ","); got != "exec_command,spawn_agent,freeform" {
 		t.Fatalf("tools = %s", got)
 	}
 	if r.Tools[1].Description != "Spawns an agent." || !strings.Contains(string(r.Tools[1].Schema), "message") {
 		t.Fatalf("spawn_agent lost its description or schema: %+v", r.Tools[1])
 	}
-	if q := r.Namespaced["collaboration__spawn_agent"]; q != (nsTool{Namespace: "collaboration", Name: "spawn_agent"}) {
+	if q := r.Namespaced["spawn_agent"]; q != (nsTool{Namespace: "collaboration", Name: "spawn_agent"}) {
 		t.Fatalf("namespaced = %+v", r.Namespaced)
 	}
+	if !r.Namespaced["freeform"].Custom {
+		t.Fatalf("freeform not custom: %+v", r.Namespaced)
+	}
 	if _, ok := r.Namespaced["exec_command"]; ok {
 		t.Fatal("a top-level tool was put in a namespace")
 	}
 }
 
+func TestNamespacedBareNameClaimed(t *testing.T) {
+	// a name a top-level tool has, or that two namespaces share, keeps the
+	// flat form: one name, one tool (#1448)
+	body := `{"model":"m","input":"hi","tools":[
+		{"type":"function","name":"read_file","parameters":{"type":"object"}},
+		{"type":"namespace","name":"muse","tools":[
+			{"type":"function","name":"read_file","parameters":{"type":"object"}},
+			{"type":"function","name":"bash","parameters":{"type":"object"}},
+			{"type":"function","name":"list_dir","parameters":{"type":"object"}}]},
+		{"type":"namespace","name":"other","tools":[
+			{"type":"function","name":"bash","parameters":{"type":"object"}}]}],
+		"input":[
+		{"type":"message","role":"user","content":"go"},
+		{"type":"function_call","call_id":"c1","name":"list_dir","namespace":"muse","arguments":"{}"},
+		{"type":"function_call_output","call_id":"c1","output":"a.txt"},
+		{"type":"function_call","call_id":"c2","name":"read_file","namespace":"muse","arguments":"{}"},
+		{"type":"function_call_output","call_id":"c2","output":"x"}]}`
+	r, err := parseResponses([]byte(body))
+	if err != nil {
+		t.Fatal(err)
+	}
+	var names []string
+	for _, tl := range r.Tools {
+		names = append(names, tl.Name)
+	}
+	if got := strings.Join(names, ","); got != "read_file,muse__read_file,muse__bash,list_dir,other__bash" {
+		t.Fatalf("tools = %s", got)
+	}
+	if q := r.Namespaced["list_dir"]; q != (nsTool{Namespace: "muse", Name: "list_dir"}) {
+		t.Fatalf("namespaced = %+v", r.Namespaced)
+	}
+	// the conversation reads the same map: an unclaimed name's earlier call
+	// goes under it, a claimed one's keeps the flat name
+	var calls []string
+	for i := range r.Messages {
+		for j := range r.Messages[i].Parts {
+			if p := &r.Messages[i].Parts[j]; p.Kind == ToolCall {
+				calls = append(calls, p.Name)
+			}
+		}
+	}
+	if got := strings.Join(calls, ","); got != "list_dir,muse__read_file" {
+		t.Fatalf("history calls = %s", got)
+	}
+}
+
+func TestNamespacedToolsForwardedBare(t *testing.T) {
+	// a chat upstream reads the tools list: Muse Spark, trained on Muse's
+	// own tool names, answered a muse__-flat one "undeclared_tool" (#1448)
+	r, err := parseResponses([]byte(`{"model":"m","input":"hi",` + namespacedTools + `}`))
+	if err != nil {
+		t.Fatal(err)
+	}
+	var raw struct {
+		Tools []struct {
+			Function struct {
+				Name string `json:"name"`
+			} `json:"function"`
+		} `json:"tools"`
+	}
+	if err := json.Unmarshal(buildChat(r, "upstream", "example.com", false), &raw); err != nil {
+		t.Fatal(err)
+	}
+	var names []string
+	for _, tl := range raw.Tools {
+		names = append(names, tl.Function.Name)
+	}
+	if got := strings.Join(names, ","); got != "exec_command,spawn_agent,freeform" {
+		t.Fatalf("forwarded = %s", got)
+	}
+}
+
+func TestNamespacedBareCallBack(t *testing.T) {
+	r, err := parseResponses([]byte(`{"model":"m","input":"hi",` + namespacedTools + `}`))
+	if err != nil {
+		t.Fatal(err)
+	}
+	res := Result{Parts: []Part{{Kind: ToolCall, ID: "c1", Name: "spawn_agent", Args: json.RawMessage(`{}`)}}}
+	var out struct {
+		Output []map[string]any `json:"output"`
+	}
+	if err := json.Unmarshal(render(provider.Responses, res, r), &out); err != nil {
+		t.Fatal(err)
+	}
+	if len(out.Output) != 1 || out.Output[0]["name"] != "spawn_agent" || out.Output[0]["namespace"] != "collaboration" {
+		t.Fatalf("output = %v", out.Output)
+	}
+}
+
 func TestNamespacedCallInHistory(t *testing.T) {
 	r, err := parseResponses([]byte(`{"model":"m",` + namespacedTools + `,"input":[
 		{"type":"message","role":"user","content":"go"},
@@ -58,30 +152,38 @@ func TestNamespacedCallInHistory(t *testing.T) {
 			}
 		}
 	}
-	if call == nil || call.Name != "collaboration__spawn_agent" {
+	if call == nil || call.Name != "spawn_agent" {
 		t.Fatalf("history call = %+v", call)
 	}
 }
 
 func TestLongNamespacedNamesFit(t *testing.T) {
 	ns := "mcp__" + strings.Repeat("a", 60)
-	body := `{"model":"m","input":"hi","tools":[{"type":"namespace","name":"` + ns + `","tools":[
-		{"type":"function","name":"` + strings.Repeat("b", 40) + `1"},
-		{"type":"function","name":"` + strings.Repeat("b", 40) + `2"}]}]}`
+	short := strings.Repeat("b", 40) + "1"
+	long := strings.Repeat("b", 40) + "2"
+	body := `{"model":"m","input":"hi","tools":[
+		{"type":"function","name":"` + short + `","parameters":{"type":"object"}},
+		{"type":"namespace","name":"` + ns + `","tools":[
+			{"type":"function","name":"` + short + `"},
+			{"type":"function","name":"` + long + `"}]}]}`
 	r, err := parseResponses([]byte(body))
 	if err != nil {
 		t.Fatal(err)
 	}
-	if len(r.Tools) != 2 || r.Tools[0].Name == r.Tools[1].Name {
+	if len(r.Tools) != 3 || r.Tools[0].Name != short {
 		t.Fatalf("tools = %+v", r.Tools)
 	}
-	for i, tl := range r.Tools {
-		if len(tl.Name) > 64 {
-			t.Fatalf("%q is longer than 64", tl.Name)
-		}
-		if q := r.Namespaced[tl.Name]; q.Namespace != ns || !strings.HasSuffix(q.Name, string(rune('1'+i))) {
-			t.Fatalf("%q maps to %+v", tl.Name, q)
-		}
+	// the namespace's short, claimed by the top-level tool, goes flat and
+	// is cut to fit; its sibling keeps its own name as it is
+	flat, bare := r.Tools[1], r.Tools[2]
+	if flat.Name == bare.Name || flat.Name == short || len(flat.Name) > 64 || bare.Name != long {
+		t.Fatalf("names = %q, %q", flat.Name, bare.Name)
+	}
+	if q := r.Namespaced[flat.Name]; q.Namespace != ns || q.Name != short {
+		t.Fatalf("%q maps to %+v", flat.Name, q)
+	}
+	if q := r.Namespaced[bare.Name]; q.Namespace != ns || q.Name != long {
+		t.Fatalf("%q maps to %+v", bare.Name, q)
 	}
 }
 
diff --git a/internal/gateway/responses.go b/internal/gateway/responses.go
index 1dab20b8..7fbdfb3e 100644
--- a/internal/gateway/responses.go
+++ b/internal/gateway/responses.go
@@ -256,6 +256,59 @@ func flatName(namespace, name string) string {
 	return provider.FlatName(namespace, name)
 }
 
+// offeredNames says what name each of a request's namespace tools goes to
+// the model under: its own, when no other tool in the request claims that
+// name — none at the top level, none in another namespace, no flat name,
+// none of the tool search served — and the flat namespace__name otherwise.
+// A model that knows a namespace's tools by their own names calls them so
+// (Muse Spark behind Cline turned a muse__-flat list away with
+// "undeclared_tool", #1448), the way Responses Lite already ships Codex's
+// own functions bare (liftAdditionalTools); a name two tools would fight
+// over keeps the flat form, which cuts a longer one to fit. The
+// conversation's earlier calls and an allowed_tools list read the same map
+// (offeredName), so a tool goes by one name the whole request through.
+func offeredNames(tools []rTool) map[string]string {
+	claimed := map[string]bool{} // a top-level tool's name, or a flat one
+	own := map[string]int{}      // namespace tools by their own name
+	names := map[string]string{} // namespace\x00name → the name offered
+	for _, t := range tools {
+		switch t.Type {
+		case "function", "custom":
+			claimed[t.Name] = true
+		case toolSearch:
+			if t.Execution == "client" {
+				claimed[t.Name] = true
+			}
+		case "namespace":
+			for _, nt := range t.Tools {
+				if nt.Type != "function" && nt.Type != "custom" {
+					continue
+				}
+				claimed[flatName(t.Name, nt.Name)] = true
+				own[nt.Name]++
+				names[t.Name+"\x00"+nt.Name] = nt.Name
+			}
+		}
+	}
+	for key, name := range names {
+		if !claimed[name] && own[name] == 1 && len(name) <= 64 {
+			continue
+		}
+		names[key] = flatName(key[:strings.IndexByte(key, 0)], name)
+	}
+	return names
+}
+
+// offeredName is a namespace tool's name as the model is offered it: by
+// offeredNames' word when the request carries the tool, the flat name it
+// always was when it doesn't (an earlier call for one since dropped).
+func offeredName(offered map[string]string, namespace, name string) string {
+	if n, ok := offered[namespace+"\x00"+name]; ok {
+		return n
+	}
+	return flatName(namespace, name)
+}
+
 type rRequest struct {
 	Model             string          `json:"model"`
 	Instructions      string          `json:"instructions,omitempty"`
@@ -318,6 +371,7 @@ func parseResponses(body []byte) (*Request, error) {
 		TopP: q.TopP, Stream: q.Stream, Parallel: q.ParallelToolCalls, Fast: q.ServiceTier == "priority" || q.ServiceTier == "ultrafast", Ultrafast: q.ServiceTier == "ultrafast", Tier: q.ServiceTier, CacheKey: q.PromptCacheKey, Include: q.Include,
 		ClientMetadata: sentRaw(q.ClientMetadata), AccessPrograms: q.AccessPrograms}
 	r.Text, r.Format = textFormat(sentRaw(q.Text))
+	offered := offeredNames(q.Tools)
 	if q.Reasoning != nil {
 		r.Effort = effortOf(q.Reasoning.Effort)
 		r.Thinking = true
@@ -378,13 +432,13 @@ func parseResponses(body []byte) (*Request, error) {
 			case it.Type == "function_call":
 				name := it.Name
 				if it.Namespace != "" {
-					name = flatName(it.Namespace, it.Name)
+					name = offeredName(offered, it.Namespace, it.Name)
 				}
 				r.Messages = append(r.Messages, Message{Role: "assistant", Parts: []Part{{Kind: ToolCall, ID: it.CallID, Name: name, Args: parseArgs(string(it.Arguments))}}})
 			case it.Type == "custom_tool_call":
 				name := it.Name
 				if it.Namespace != "" {
-					name = flatName(it.Namespace, it.Name)
+					name = offeredName(offered, it.Namespace, it.Name)
 				}
 				args, _ := json.Marshal(map[string]string{"input": it.Input})
 				r.Messages = append(r.Messages, Message{Role: "assistant", Parts: []Part{{Kind: ToolCall, ID: it.CallID, Name: name, Args: args}}})
@@ -466,15 +520,25 @@ func parseResponses(body []byte) (*Request, error) {
 		case "custom":
 			offer(i, Tool{Name: t.Name, Description: customDescription(t), Schema: customSchema}, nsTool{Name: t.Name, Custom: true})
 		case "namespace":
-			// offered flat, as few models know namespaces; a call is given
-			// its namespace back on the way out
+			// offered under each tool's own name when no other tool claims
+			// it, the flat namespace__name otherwise (offeredNames); a call
+			// is given its namespace back on the way out by either name
 			for _, nt := range t.Tools {
-				flat := flatName(t.Name, nt.Name)
+				name, ns := offeredName(offered, t.Name, nt.Name), nsTool{Namespace: t.Name, Name: nt.Name}
 				switch nt.Type {
 				case "function":
-					offer(i, Tool{Name: flat, Description: nt.Description, Schema: unsealed(nt.Parameters), Strict: nt.Strict != nil && *nt.Strict}, nsTool{Namespace: t.Name, Name: nt.Name})
+					offer(i, Tool{Name: name, Description: nt.Description, Schema: unsealed(nt.Parameters), Strict: nt.Strict != nil && *nt.Strict}, ns)
 				case "custom":
-					offer(i, Tool{Name: flat, Description: customDescription(nt), Schema: customSchema}, nsTool{Namespace: t.Name, Name: nt.Name, Custom: true})
+					ns.Custom = true
+					offer(i, Tool{Name: name, Description: customDescription(nt), Schema: customSchema}, ns)
+				default:
+					continue
+				}
+				if flat := flatName(t.Name, nt.Name); name != flat {
+					// the flat name is answered too: a model may say it
+					// anyway, as one behind a request relayed reshaped does
+					// (a Grok subscription's, grokBody)
+					r.Namespaced[flat] = ns
 				}
 			}
 		case toolSearch:
@@ -510,7 +574,7 @@ func parseResponses(body []byte) (*Request, error) {
 					switch {
 					case (tool.Type == "function" || tool.Type == "custom") && tool.Name != "":
 						if tool.Namespace != "" {
-							allowed[flatName(tool.Namespace, tool.Name)] = true
+							allowed[offeredName(offered, tool.Namespace, tool.Name)] = true
 						} else {
 							allowed[tool.Name] = true
 						}
@@ -526,8 +590,14 @@ func parseResponses(body []byte) (*Request, error) {
 					}
 				}
 				r.Tools = tools
-				for name := range r.Namespaced {
-					if !allowed[name] {
+				kept := map[string]bool{}
+				for _, tool := range r.Tools {
+					kept[tool.Name] = true
+				}
+				for name, ns := range r.Namespaced {
+					// a kept namespace tool stays answerable by its flat
+					// name too, as it was offered under its own (offeredNames)
+					if !allowed[name] && !(ns.Namespace != "" && kept[ns.Name]) {
 						delete(r.Namespaced, name)
 					}
 				}
diff --git a/internal/gateway/responses_allowed_tools_test.go b/internal/gateway/responses_allowed_tools_test.go
index 76f2cabf..90254d2a 100644
--- a/internal/gateway/responses_allowed_tools_test.go
+++ b/internal/gateway/responses_allowed_tools_test.go
@@ -98,7 +98,7 @@ func TestParseResponsesAllowedNamespacedTool(t *testing.T) {
 	if err != nil {
 		t.Fatal(err)
 	}
-	if len(r.Tools) != 1 || r.Tools[0].Name != "collaboration__spawn_agent" || len(r.Namespaced) != 1 {
+	if len(r.Tools) != 1 || r.Tools[0].Name != "spawn_agent" || len(r.Namespaced) != 2 {
 		t.Fatalf("tools = %v, namespaced = %v", r.Tools, r.Namespaced)
 	}
 }
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt61-b-1448-namespace-tools](https://github.com/ggbdpq/magpie/tree/hunt61-b-1448-namespace-tools) (head `9e3ed461a5f8649bdbeab5e1774a6a99d4755ff6`).
