# gateway/antigravity: a tool schema's `items` left on a type that folds off array reaches Gemini and the turn dies with `$type == Type.ARRAY` (#3173)

## Summary

Reported in #3173: a Codex → magpie → Antigravity (`gemini-3.8-flash`) turn fails before generation, deterministically, whenever a tool's parameter schema carries an `items` Antigravity won't take. The upstream's 400, word for word:

```text
400: Antigravity: * GenerateContentRequest.tools[0].function_declarations[67].parameters.properties[functions].items.items: field predicate failed: $type == Type.ARRAY
* GenerateContentRequest.tools[0].function_declarations[68].parameters.properties[reviewed_obligations].items.items: field predicate failed: $type == Type.ARRAY
...
```

20+ properties in one turn fail the same predicate; the same tool set through the OpenAI-compatible and DeepSeek routes is fine. The reporter's minimal forms put a bare `oneOf`/`anyOf` (no `type`) on `items`.

## Cause

`plainSchema` (`internal/gateway/codeassist.go:638`) cuts a tool schema down to Antigravity's OpenAPI-style subset. Its walk already folds a union to its first member that isn't null (`codeassist.go:699`) — I verified at base `f5b01574` that the reporter's minimal union-on-`items` shapes come out typed, no union key left. What the walk does not survive is the list form of `type`: it folds `type` to its first non-null entry (`codeassist.go:743`) but copies `items` along regardless, so a parameter declared `["string","array"]` reaches Antigravity as a **string still wearing `items`** — exactly the node the `$type == Type.ARRAY` predicate rejects. Nested under an array property the failing node is named twice over, `items.items`, which is the path in the reporter's 400. #3121 is the one-level form of the same leak, still open. The reporter's real REA schemas are abridged in the issue, so their exact entry shape can't be confirmed; what is confirmed is that this is the one `items`-bearing node `plainSchema` can still emit on a non-array type, and its predicate failure reproduces the report's signature.

## Fix

One rule at the spot every branch of the walk funnels through (`codeassist.go:797`): after type inference, if a node carries `items` and its type isn't `array`, the `items` is stray — drop it. A typeless node that has only `items` still infers `array` first and keeps it, so nothing that was legal is touched. The alternative — preferring `array` when folding a `type` list that contains it — would change what the model is told (array instead of string) and re-litigate the fold's first-member choice; dropping a keyword the folded type can't carry is strictly subtractive and is the same direction the cut-down function already takes everywhere else.

## Verification

| Check | Command | Result |
|---|---|---|
| Red without the fix, base `f5b01574` | `go test ./internal/gateway/ -run TestPlainSchemaDropsItemsOffAnArray -count=1 -v` | FAIL, stray `items` in `got` |
| Green with the fix | `go test ./internal/gateway/ -run TestPlainSchema -count=1 -v` | 3/3 PASS (existing, new red, union guard) |
| Union-on-`items` guard (reporter's minimal forms) | same run, `TestPlainSchemaFoldsAUnionOnItems` | PASS at base and with the fix |
| Race | `go test -race ./internal/gateway/ -run TestPlainSchema -count=1` | ok |
| Vet / fmt | `go vet ./internal/gateway/`; `gofmt -l` on touched files | clean, no output |
| Builds | `go build ./...` darwin/arm64; `GOOS=linux GOARCH=amd64 go build -tags nogui ./...`; `GOOS=windows GOARCH=amd64 go build -tags nogui ./...` | all ok |
| Package | `go test ./internal/gateway/ -p 1 -timeout 30m -count=1` | ok (329.97s) |
| Degenerate inputs | `oneOf: []`, non-array `oneOf`, boolean/`null`/empty-object `items`, garbage `type`, malformed JSON | no panic; stray items dropped; malformed JSON returned unchanged |

## Not verified

- No end-to-end turn against a real Antigravity account — the verification above is schema-level, through `plainSchema` and the gateway package.
- The reporter's full REA tool set (309 tools, 32 affected) is not public in the issue, so the exact schemas that entered the failing request were not replayed; the repro uses the 400's path shape (`items.items`) and the reporter's abridged JSON.

---

**Source**: reported in #3173 (huaiqing-afk, with the upstream's 400 word for word).

**Red without the fix** (base `f5b01574`):

```text
=== RUN   TestPlainSchemaDropsItemsOffAnArray
    plain_schema_test.go:63: got {"properties":{"actions":{"items":{"items":{"type":"string"},"type":"string"},"type":"array"},"disease":{"items":{"minLength":1,"type":"string"},"type":"string"},"functions":{"items":{"items":{"type":"string"},"type":"string"},"minItems":1,"type":"array"}},"required":["disease"],"type":"object"}
--- FAIL: TestPlainSchemaDropsItemsOffAnArray (0.00s)
```

The inner node `{"items":{"type":"string"},"type":"string"}` is a string wearing `items` — the node Gemini's `$type == Type.ARRAY` predicate rejects, and `functions` wraps it in an array, giving the reported two-level `items.items` path.

**Siblings**: #3121 (open) is the same leak one level up, `properties[disease].items: field predicate failed: $type == Type.ARRAY`; this patch covers it and says so in the code comment. #2784 and #2826 (both open) are the other half — an array with **no** `items` at all, rejected with a different predicate ("missing field"); fixing that means *adding* an `items`, which this patch deliberately does not do.

**When the read fails**: the 400 is quoted in full in #3173's opening post and again in the Summary here; the reporter's abridged schemas are in the same post. If the branch link below rots, the patch at the bottom applies to `f5b01574` of yetone/magpie with `git am`.

**Not verified**: end-to-end against a real Antigravity account; a replay of the reporter's 309-tool REA set.

Branch with the commit: [hunt57-b-antigravity-items](https://github.com/ggbdpq/magpie/tree/hunt57-b-antigravity-items) (head `b7a4095176e1501a8f24931f26de63cecebff810`).

**Attribution**: AI-written; an AI coding agent read the issue, reproduced the failure as a test against base `f5b01574`, and verified the fix per the table above. The patch is committed locally as `ggbdpq <ggbdpq@gmail.com>` and is not pushed.

**Patch**: SHA-256 first 16 `450898304acc4437`

```patch
From b7a4095176e1501a8f24931f26de63cecebff810 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 20:40:29 +0800
Subject: [PATCH] gateway: a type that folds off array leaves a tool schema's
 items behind, so Antigravity takes the turn (#3173)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

plainSchema folds a schema's list of types to its first one that isn't
null but carried the items keyword along: a tool whose parameter said
["string","array"] reached Antigravity as a string still wearing items,
and Gemini's check that items rides on an array turned the whole turn
away with "field predicate failed: $type == Type.ARRAY" — under an
array property that failure names the node twice over, items.items.
#3121 is the one-level form of the same leak. A union on items folds to
its first member already; what leaked was the keyword a non-array type
had no business carrying. plainSchema now drops items wherever the type
it survives with isn't array — the one spot every branch of the walk
(refs, allOf, unions, plain nodes) funnels through.

What changed
- internal/gateway/codeassist.go: plainSchema deletes items off a node
  whose folded type isn't array.
- internal/gateway/plain_schema_test.go: a schema of #3173's reported
  shape — items over items under an array, the type list folding to
  string — comes out with no stray items; unions on items, #3173's
  minimal forms, are pinned folding to their first member.

Run
- go test ./internal/gateway/ -run TestPlainSchema -count=1 -v: 3/3,
  red at base f5b01574 before the fix
- go test -race ./internal/gateway/ -run TestPlainSchema -count=1
- go vet ./internal/gateway/, gofmt clean
- go build ./... on darwin/arm64; GOOS=linux GOARCH=amd64 and
  GOOS=windows GOARCH=amd64, both -tags nogui
- go test ./internal/gateway/ -p 1 -timeout 30m

Fixes #3173

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codeassist.go        |  7 ++++
 internal/gateway/plain_schema_test.go | 52 +++++++++++++++++++++++++++
 2 files changed, 59 insertions(+)

diff --git a/internal/gateway/codeassist.go b/internal/gateway/codeassist.go
index 82a77969..43fd993a 100644
--- a/internal/gateway/codeassist.go
+++ b/internal/gateway/codeassist.go
@@ -794,6 +794,13 @@ func plainSchema(raw json.RawMessage) json.RawMessage {
 					out["type"] = "array"
 				}
 			}
+			if out["items"] != nil && out["type"] != "array" {
+				// items rides on an array only: a type that folds to
+				// something else, as ["string","array"] does to string,
+				// leaves it stray and Antigravity turns the turn away
+				// over it (#3121, #3173)
+				delete(out, "items")
+			}
 			if req, ok := out["required"].([]any); ok {
 				// required names only the properties there are
 				props, _ := out["properties"].(map[string]any)
diff --git a/internal/gateway/plain_schema_test.go b/internal/gateway/plain_schema_test.go
index b160c668..862306fb 100644
--- a/internal/gateway/plain_schema_test.go
+++ b/internal/gateway/plain_schema_test.go
@@ -37,3 +37,55 @@ func TestPlainSchemaKeepsOnlyWhatAntigravityTakes(t *testing.T) {
 		t.Errorf("got %s", b)
 	}
 }
+
+// Antigravity takes items only on an array: a type that folds to something
+// else, as ["string","array"] does to string, has to leave it behind or the
+// schema reaches Gemini with an items on a string and the turn is turned
+// away with "field predicate failed: $type == Type.ARRAY" (#3121, #3173).
+func TestPlainSchemaDropsItemsOffAnArray(t *testing.T) {
+	in := `{"type":"object","properties":{
+		"disease":{"type":["string","array"],"items":{"type":"string","minLength":1}},
+		"functions":{"type":"array","minItems":1,"items":{"type":["string","array"],"items":{"type":"string"}}},
+		"actions":{"type":"array","items":{"oneOf":[{"type":["string","array"],"items":{"type":"string"}},{"type":"number"}]}}
+	},"required":["disease"]}`
+	want := `{"type":"object","properties":{
+		"disease":{"type":"string"},
+		"functions":{"type":"array","minItems":1,"items":{"type":"string"}},
+		"actions":{"type":"array","items":{"type":"string"}}
+	},"required":["disease"]}`
+	var got, exp any
+	if err := json.Unmarshal(plainSchema(json.RawMessage(in)), &got); err != nil {
+		t.Fatal(err)
+	}
+	json.Unmarshal([]byte(want), &exp)
+	if !reflect.DeepEqual(got, exp) {
+		b, _ := json.Marshal(got)
+		t.Errorf("got %s", b)
+	}
+}
+
+// a union folds to its first member that isn't null, on items as anywhere
+// else (#3173): items under a oneOf come out as that member, typed.
+func TestPlainSchemaFoldsAUnionOnItems(t *testing.T) {
+	in := `{"type":"object","properties":{
+		"tags":{"type":"array","items":{"oneOf":[{"type":"string"},{"type":"number"}]}},
+		"actions":{"minItems":1,"type":"array","items":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string"}},"required":["kind","gone"]},{"type":"object","properties":{"op":{"type":"string"}}}]}},
+		"subject":{"anyOf":[{"oneOf":[{"type":"object","properties":{"path":{"type":"string"}}}]},{"type":"string"}]},
+		"limbo":{"type":"array","items":{"oneOf":[]}}
+	}}`
+	want := `{"type":"object","properties":{
+		"tags":{"type":"array","items":{"type":"string"}},
+		"actions":{"type":"array","minItems":1,"items":{"type":"object","properties":{"kind":{"type":"string"}},"required":["kind"]}},
+		"subject":{"type":"object","properties":{"path":{"type":"string"}}},
+		"limbo":{"type":"array","items":{"type":"string"}}
+	}}`
+	var got, exp any
+	if err := json.Unmarshal(plainSchema(json.RawMessage(in)), &got); err != nil {
+		t.Fatal(err)
+	}
+	json.Unmarshal([]byte(want), &exp)
+	if !reflect.DeepEqual(got, exp) {
+		b, _ := json.Marshal(got)
+		t.Errorf("got %s", b)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```
