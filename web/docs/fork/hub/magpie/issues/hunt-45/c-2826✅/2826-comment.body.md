Claude Code sends `ArtifactData`'s `query.where` as an array of arrays, with the inner array's members said in JSON Schema 2020-12 `prefixItems` and no `items` of its own. `plainSchema` drops `prefixItems` (it is outside the OpenAPI subset Antigravity takes), which leaves `{"type":"array"}` with no `items` at any depth — and Google turns the whole request away with the reporter's 400:

```
Antigravity: * GenerateContentRequest.tools[0].function_declarations[3].parameters.properties[query].properties[where].items.items: missing field.
```

I reproduced this as a schema-level assertion: on base `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`, feeding the reporter's exact `where` shape through the public seam `plainSchema` fails the new test with exactly that shape (`where.items` = `{"type":"array"}`, no `items` inside). I did not run a real Antigravity request.

Branch: [`hunt45-c-antigravity-array-items`](https://github.com/ggbdpq/magpie/tree/hunt45-c-antigravity-array-items), one commit on top of upstream `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`; the patch below applies with `git am`.

## What changed

All inside `plainSchema`, `internal/gateway/codeassist.go` (plus a helper `firstSays` at :652):

- **:807-812 — a tuple collapses to one schema.** If a node's `items` is an array (draft 07 tuple notation), it is replaced by its first member that is a non-empty schema object. Gemini takes an `items` object and nothing else.
- **:813-820 — `prefixItems` is recovered before it is lost.** If `type` is `array` and `items` ended up absent while the original node had `prefixItems`, the first meaningful member (skipping `{}` empties) is walked and installed as `items`.
- **:821-826 — an array always says its items.** If `items` is still absent, the default `{"type":"string"}` is injected, so no `type:"array"` node goes out without an `items` object — the field Google's 400 names.

The walk itself is unchanged: the new block sits where the existing code already recurses (into `items` and `properties`), and recovered members go through the same `walk`.

## Red before the fix

Base `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`, test `TestPlainSchemaArrayAlwaysHasItems` (`internal/gateway/plain_schema_test.go`), product code restored to upstream, test kept:

```
--- FAIL: TestPlainSchemaArrayAlwaysHasItems (0.00s)
    --- FAIL: TestPlainSchemaArrayAlwaysHasItems/recovers_a_tuple's_first_member (0.00s)
        plain_schema_test.go:71: got {"properties":{"query":{"properties":{"where":{"items":{"type":"array"},"maxItems":10,"type":"array"}},"type":"object"}},"required":["query"],"type":"object"}
    --- FAIL: TestPlainSchemaArrayAlwaysHasItems/an_array_that_never_said_items (0.00s)
        plain_schema_test.go:71: got {"maxItems":3,"type":"array"}
    --- FAIL: TestPlainSchemaArrayAlwaysHasItems/a_tuple_items_collapses_to_one (0.00s)
        plain_schema_test.go:71: got {"items":[{"type":"number"},{"type":"boolean"},{}],"type":"array"}
    --- FAIL: TestPlainSchemaArrayAlwaysHasItems/a_tuple_of_nothing_gets_the_default (0.00s)
        plain_schema_test.go:71: got {"type":"array"}
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.019s
```

The first `got` is the reporter's 400 as a schema: `where.items` has `type` array and no `items` of its own.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Target tests | `go test -tags nogui -count=1 -run 'TestPlainSchema\|TestCodeAssist\|TestAntigravity' ./internal/gateway/` | ok 1.017s |
| Full package | `go test -tags nogui -count=1 ./internal/gateway/` | ok 327.237s, exit 0 |
| Race | `go test -race -tags nogui -count=1 -run 'TestPlainSchema' ./internal/gateway/` | ok 2.143s |
| Format | `gofmt -l internal/gateway/` | empty |
| Vet | `go vet -tags nogui ./internal/gateway/` (darwin, GOOS=linux, GOOS=windows) | clean on all three |
| Build | `go build -tags nogui ./...`; `GOOS=linux …`; `GOOS=windows go build -o /dev/null .` | ok on all three (darwin prints a pre-existing cgo `-Wenum-conversion` warning from `internal/gui/trayimage_darwin.go`, untouched by this patch) |
| Ablation | upstream `codeassist.go` + new test | the four reds above; restore → green |
| Mutation (a) | default injection removed | `an_array_that_never_said_items` (and the all-empty-tuple case, which also falls through to the default) red; others green |
| Mutation (b) | tuple collapse removed | only `a_tuple_items_collapses_to_one` red (`items` stays an array) |

## Siblings

Where else array/tuple schemas reach other vendors (`rg -n "prefixItems|additionalItems" internal/gateway/`, `rg -n "plainSchema" internal/`) — all left unchanged:

- `buildCodeAssistSent`'s non-Antigravity branch, `internal/gateway/codeassist.go:358` (`parametersJsonSchema`), reached by Gemini CLI (`gemini.go:114` via `geminiRequest`) and Vertex AI (`vertex.go:23`): the client's schema goes out as it came, tuples included — those endpoints take full JSON Schema 2020-12, so there is nothing to sanitize.
- `responseJsonSchema`, `internal/gateway/codeassist.go:411` (structured output): also passed through raw. It is not a function declaration and the report does not cover it; if Google ever 400s on tuples there, it would be a separate report.
- `deepseek_schema.go:101`, `kimi_schema.go:104`, `oneof_schema.go:74`: these only walk *through* `prefixItems` while looking for their own fixes (escaped `\0` in patterns, `oneOf` flags, untyped enums); they keep the keyword, and DeepSeek/Kimi take full JSON Schema.

## Not verified

- No real Google/Antigravity request was run — the reproduction is at the schema level, and the 400 wording is quoted from the report.
- The recovery choice itself — first meaningful `prefixItems` member as `items`, and `{"type":"string"}` as the default — is the suggestion from the report (OmniRoute's `ensureArrayItems` does the same); the first member can lose the tuple's later members' constraints (e.g. the second member's `enum`). If a maintainer prefers a different stand-in (e.g. `{}`-free merge, or `{"type":"object"}` as the default), it is a two-line change in the same block.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch — <code>git am 0001-*.patch</code> (sha256 b8605f312d27867a…)</summary>

```patch
From d79961fbbc3041d2165178df3128d0ca43cb40c1 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 19 Oct 2026 06:52:23 +0800
Subject: [PATCH] gateway: an Antigravity schema's array always says its items,
 tuple or not (#2826)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
- plainSchema (internal/gateway/codeassist.go) now leaves every array
  schema with an items object, at any depth:
  - a tuple's items (an array, draft 07) collapses to its first member
    that says anything;
  - an array whose members were said in prefixItems — dropped by the
    subset — takes that tuple's first meaningful member as its items;
  - an array that still has none gets items {"type":"string"}.

Why
- Google requires items on every schema of type array. Claude Code's
  tools (ArtifactData's query.where) say an array of arrays in JSON
  Schema 2020-12 tuples, and stripping prefixItems left the inner array
  with none, so Antigravity turned the whole request away with 400
  "tools[0].function_declarations[3].parameters.properties[query].
  properties[where].items.items: missing field". plainSchema is the
  Antigravity path only: Gemini CLI and Vertex take the schema as it
  came, and no other vendor path strips tuples.

Run
- go test -tags nogui -count=1 -run 'TestPlainSchema|TestCodeAssist|TestAntigravity' ./internal/gateway/: ok (TestPlainSchemaArrayAlwaysHasItems red on 1a3b9268 before the fix, green after)
- go test -tags nogui -count=1 ./internal/gateway/: ok 327.237s
- go test -race -tags nogui -count=1 -run 'TestPlainSchema' ./internal/gateway/: ok 2.143s
- gofmt -l internal/gateway/: empty; go vet -tags nogui on darwin/linux/windows: clean
- go build -tags nogui ./..., GOOS=linux, GOOS=windows: ok

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codeassist.go        | 32 ++++++++++++++++++++++++
 internal/gateway/plain_schema_test.go | 36 +++++++++++++++++++++++++++
 2 files changed, 68 insertions(+)

diff --git a/internal/gateway/codeassist.go b/internal/gateway/codeassist.go
index 82a77969..3d225b84 100644
--- a/internal/gateway/codeassist.go
+++ b/internal/gateway/codeassist.go
@@ -649,6 +649,16 @@ func plainSchema(raw json.RawMessage) json.RawMessage {
 		}
 	}
 	var walk func(v any, depth int) any
+	firstSays := func(members []any) any {
+		// the first schema of a tuple that says anything of its members:
+		// {} and whatever isn't an object says nothing
+		for _, m := range members {
+			if s, ok := m.(map[string]any); ok && len(s) > 0 {
+				return s
+			}
+		}
+		return nil
+	}
 	walk = func(v any, depth int) any {
 		switch x := v.(type) {
 		case []any:
@@ -794,6 +804,28 @@ func plainSchema(raw json.RawMessage) json.RawMessage {
 					out["type"] = "array"
 				}
 			}
+			if out["type"] == "array" {
+				if t, ok := out["items"].([]any); ok {
+					// a tuple (draft 07's items as an array) stands as one
+					// schema: Gemini takes an items object and nothing else
+					out["items"] = firstSays(t)
+				}
+				if out["items"] == nil {
+					// the members prefixItems said are gone from the subset;
+					// the first one that says something stands in for them
+					if pfx, _ := x["prefixItems"].([]any); len(pfx) > 0 {
+						if s := firstSays(pfx); s != nil {
+							out["items"] = walk(s, depth+1)
+						}
+					}
+					if out["items"] == nil {
+						// an array says what its members are, or Google
+						// turns the whole request away over the missing
+						// field (#2826)
+						out["items"] = map[string]any{"type": "string"}
+					}
+				}
+			}
 			if req, ok := out["required"].([]any); ok {
 				// required names only the properties there are
 				props, _ := out["properties"].(map[string]any)
diff --git a/internal/gateway/plain_schema_test.go b/internal/gateway/plain_schema_test.go
index b160c668..4b0b4fd2 100644
--- a/internal/gateway/plain_schema_test.go
+++ b/internal/gateway/plain_schema_test.go
@@ -37,3 +37,39 @@ func TestPlainSchemaKeepsOnlyWhatAntigravityTakes(t *testing.T) {
 		t.Errorf("got %s", b)
 	}
 }
+
+// Google refuses a whole request over an array schema that says no items,
+// at any depth ("...properties[where].items.items: missing field", #2826).
+// Claude Code's tools (ArtifactData's query.where) say an array of arrays
+// in JSON Schema 2020-12 tuples — prefixItems, or items as an array — and
+// both are outside what Antigravity's subset takes: once dropped, an array
+// is left with no items, and an items has to be one object, not a tuple.
+func TestPlainSchemaArrayAlwaysHasItems(t *testing.T) {
+	tests := []struct {
+		name, in, want string
+	}{
+		{"recovers a tuple's first member", `{"type":"object","properties":{"query":{"type":"object","properties":{"where":{"type":"array","maxItems":10,
+			"items":{"type":"array","prefixItems":[{"type":"string"},{"type":"string","enum":["eq","ne","in"]},{}]}}}}},"required":["query"]}`,
+			`{"type":"object","properties":{"query":{"type":"object","properties":{"where":{"type":"array","maxItems":10,
+			"items":{"type":"array","items":{"type":"string"}}}}}},"required":["query"]}`},
+		{"an array that never said items", `{"type":"array","maxItems":3}`,
+			`{"type":"array","maxItems":3,"items":{"type":"string"}}`},
+		{"a tuple items collapses to one", `{"type":"array","items":[{"type":"number"},{"type":"boolean"},{}]}`,
+			`{"type":"array","items":{"type":"number"}}`},
+		{"a tuple of nothing gets the default", `{"type":"array","prefixItems":[{},{}]}`,
+			`{"type":"array","items":{"type":"string"}}`},
+	}
+	for _, tc := range tests {
+		t.Run(tc.name, func(t *testing.T) {
+			var got, exp any
+			if err := json.Unmarshal(plainSchema(json.RawMessage(tc.in)), &got); err != nil {
+				t.Fatal(err)
+			}
+			json.Unmarshal([]byte(tc.want), &exp)
+			if !reflect.DeepEqual(got, exp) {
+				b, _ := json.Marshal(got)
+				t.Errorf("got %s", b)
+			}
+		})
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
