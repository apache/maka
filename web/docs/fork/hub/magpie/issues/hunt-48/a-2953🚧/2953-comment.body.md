Verified the maintainer's repro on upstream `e4ac5e87` before touching anything: `SetJSON` with `customModels.1` on `{"customModels":[{"model":"mine"}]}` produces `{"customModels":{"1":{…}}}` — the array is replaced and the user's entry is gone. The spec implemented here is the maintainer's, exactly: a numeric key under an array replaces at an index that exists, appends at `len`, refuses past it; the array never becomes an object and no element is dropped.

Branch: [`hunt48-a-edit-array`](https://github.com/ggbdpq/magpie/tree/hunt48-a-edit-array), one commit on top of upstream `e4ac5e87`; the patch below applies with `git am`.

## What changed

All in `internal/edit/json.go`:

- `setJSONBytes` (json.go:124): when the deepest existing prefix on the key path is an array and the next key is numeric, the write goes to `setArrayElem` instead of falling into the scalar branch that replaced the array. An exact path that *names* the array still replaces it wholesale, as before.
- `setArrayElem` (json.go:154): the index semantics. `idx < len` reaching this function is refused (an existing element is normally resolved earlier in the walk — only a key gjson can't read as an index, like a leading zero, lands here), `idx == len` appends via `insertElem`, `idx > len` returns an error and the file is left untouched. A non-numeric key under an array is refused the same way — today's code silently turns the array into an object for that case too.
- `insertElem` (json.go:274): appends one element before the closing `]`, matching the file's indentation (and its compact style when there is none), reusing the machinery `insertKey` uses for objects.
- `nest` (json.go:192): keys created from scratch now build an array for a numeric part instead of `{"0":…}` — index `0` only, since the array starts empty; anything else is refused as past its end. A numeric key under an object stays an object key.
- `matchBrace` was parameterized into `matchPair` so the `]` of an array can be matched too; `matchBracket` (json.go:350) is the array form. Behavior for existing callers is unchanged.

## Red before the fix

New table test `TestJSONSetArrayIndex` (`internal/edit/json_array_set_test.go`) on the base commit: 8 of 12 rows fail — all three append rows (including into `[]` and a compact file), the missing-key row (produces `{"customModels":{"0":{…}}}`), and all three refusal rows (no error, plus the corruption). The 4 green rows lock in what already worked: replacing an element at its index, writing deeper into one, and a numeric key under an object staying a key.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Package | `go test -tags nogui -count=1 ./internal/edit/` | ok |
| Callers of edit | `go test -tags nogui -count=1 ./internal/settings/ ./internal/provider/` | ok, ok |
| Format | `gofmt -l internal/edit/` | empty |
| Vet | `GOOS=darwin/linux/windows go vet -tags nogui ./internal/edit/` | clean ×3 |
| Build | `GOOS=darwin/linux/windows go build -tags nogui -o /dev/null .` | ok ×3 (darwin prints a pre-existing cgo `-Wenum-conversion` warning from `internal/gui/trayimage_darwin.go`) |

Ablation: with the test kept and only `internal/edit/json.go` restored from upstream, the same 8 rows fail again with the array→object corruption; restore the fix and the package is green. Mutations: dropping the past-len check (growing the array with zero values instead) turns `refuse past the length` red; widening the new array branch to objects turns `a numeric key under an object stays a key` red. Both reverted.

## Siblings

I looked for existing callers that write numeric keys; none do, so no in-repo behavior changes:

- `internal/agent/droid.go:181` writes the whole `customModels` array under its exact path — that stays a wholesale replace, untouched by the new branch.
- `internal/agent/agy.go` (`customModelsConfig.customModels`) and `internal/library/pimcp.go` (`mcpServers.<name>`), `internal/library/mcp_tools_off.go` (`tools.<k>`), `internal/library/hooks.go` (`hooks.<event>`), `internal/provider/claude_proxy_env.go` (`env.<KEY>`), `internal/agent/claude.go` (`env.<NAME>`) — all string keys under objects; unchanged.
- The reader side already handles arrays: `internal/sessions/droid.go:301` walks `customModels` with `gjson.ForEach` — which is exactly what breaks today once a write has mangled the array into an object.

## Not verified

- No real Tuanjie Cowork plugin was run; the `settings.json` `customModels[]` shape comes from the linked plugin issue (magpie-community/plugins#239).
- `SetJSONItem` (top-level array files like VS Code's chatLanguageModels.json) is a separate where-matched mechanism and is not exercised by this change beyond the package's existing tests.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (git am-able, also attached as 0001-edit-a-numeric-key-under-a-JSON-array-indexes-it-ins.patch)</summary>

```patch
From 2dc57469a7ac0fe74927d1031b164f7dcf823e8d Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 01:06:19 +0800
Subject: [PATCH] edit: a numeric key under a JSON array indexes it instead of
 replacing it (#2953)

What changed: setJSONBytes walks a key path by its longest existing
prefix; when that prefix is a JSON array and the next key is numeric,
the array is now indexed instead of being replaced outright. An index
the array has replaces that element (deeper keys keep landing inside
it, as they already did), an index equal to its length appends, and
anything past the length is refused with an error that leaves the file
unchanged. A non-numeric key under an array is refused the same way.
Keys created from scratch build an array for a numeric part (index 0
only, since the array starts empty); a numeric key under an object
stays an object key. Appends reuse the file's indentation, comments
and the other elements as they are.

Why: an array met on the key path fell into the scalar branch and was
replaced with a nested object: setting customModels.1 on
{"customModels":[{"model":"mine"}]} produced
{"customModels":{"1":{...}}}, dropping the user's entry and leaving
the field unreadable (a missing or empty array turned into {"0":{...}}
the same way). Found in magpie-community/plugins#239: the Tuanjie
Cowork plugin keeps its models in settings.json customModels[].

Run: go test -tags nogui -count=1 ./internal/edit/ (new table
TestJSONSetArrayIndex red on the base for the append, missing-key,
refusal and compact rows, green after); ./internal/settings/ and
./internal/provider/ pass; gofmt clean; go vet -tags nogui on
darwin/linux/windows clean; GOOS=darwin/linux/windows go build clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/edit/json.go                | 129 +++++++++++++++++++++++++--
 internal/edit/json_array_set_test.go | 125 ++++++++++++++++++++++++++
 2 files changed, 246 insertions(+), 8 deletions(-)
 create mode 100644 internal/edit/json_array_set_test.go

diff --git a/internal/edit/json.go b/internal/edit/json.go
index 79a71d5f..a1c57be5 100644
--- a/internal/edit/json.go
+++ b/internal/edit/json.go
@@ -4,6 +4,7 @@ import (
 	"bytes"
 	"encoding/json"
 	"fmt"
+	"strconv"
 	"strings"
 
 	"github.com/tidwall/gjson"
@@ -120,21 +121,88 @@ func setJSONBytes(raw []byte, keyPath string, value any) ([]byte, error) {
 		if !r.Exists() {
 			continue
 		}
+		if i < len(parts) && r.IsArray() {
+			// A numeric key under an array indexes it.
+			return setArrayElem(raw, stripped, r, keyPath, parts[i:], value)
+		}
 		if i == len(parts) || !r.IsObject() {
 			// Exact key exists (replace value), or an ancestor exists but is a
 			// scalar (replace it with the nested object we need).
-			return splice(raw, r.Index, len(r.Raw), marshalAt(raw, r.Index, nest(parts[i:], value)))
+			v, err := nest(parts[i:], value, keyPath)
+			if err != nil {
+				return nil, err
+			}
+			return splice(raw, r.Index, len(r.Raw), marshalAt(raw, r.Index, v))
+		}
+		v, err := nest(parts[i+1:], value, keyPath)
+		if err != nil {
+			return nil, err
 		}
-		return insertKey(raw, stripped, r.Index, unescapeKey(parts[i]), nest(parts[i+1:], value))
+		return insertKey(raw, stripped, r.Index, unescapeKey(parts[i]), v)
+	}
+	v, err := nest(parts[1:], value, keyPath)
+	if err != nil {
+		return nil, err
+	}
+	return insertKey(raw, stripped, 0, unescapeKey(parts[0]), v)
+}
+
+// setArrayElem writes into the array r at the numeric key that heads parts:
+// the element at an index the array has is replaced (a longer key path would
+// have matched it above), one at its length is appended, anything past that
+// is refused.
+func setArrayElem(raw, stripped []byte, r gjson.Result, keyPath string, parts []string, value any) ([]byte, error) {
+	idx, ok := arrayIndex(parts[0])
+	if !ok {
+		return nil, fmt.Errorf("key %q in %q addresses an array: want a numeric index", unescapeKey(parts[0]), keyPath)
+	}
+	n := len(r.Array())
+	if idx < n {
+		// An existing element would have matched a longer prefix above; only
+		// a key gjson cannot read as an index (a leading zero) lands here.
+		return nil, fmt.Errorf("cannot address element %d in %q", idx, keyPath)
+	}
+	if idx > n {
+		return nil, fmt.Errorf("index %d in %q is past the end of the array (length %d)", idx, keyPath, n)
+	}
+	v, err := nest(parts[1:], value, keyPath)
+	if err != nil {
+		return nil, err
 	}
-	return insertKey(raw, stripped, 0, unescapeKey(parts[0]), nest(parts[1:], value))
+	return insertElem(raw, stripped, r.Index, v)
 }
 
-func nest(parts []string, value any) any {
+// arrayIndex is a key path's part as an array index: a plain decimal number.
+func arrayIndex(part string) (int, bool) {
+	if part == "" {
+		return 0, false
+	}
+	for i := 0; i < len(part); i++ {
+		if part[i] < '0' || part[i] > '9' {
+			return 0, false
+		}
+	}
+	n, err := strconv.Atoi(part)
+	if err != nil {
+		return 0, false
+	}
+	return n, true
+}
+
+func nest(parts []string, value any, keyPath string) (any, error) {
 	for i := len(parts) - 1; i >= 0; i-- {
+		if idx, ok := arrayIndex(parts[i]); ok {
+			// A numeric part builds an array. Every container here is being
+			// created empty, so an index other than 0 is past its end.
+			if idx != 0 {
+				return nil, fmt.Errorf("index %d in %q is past the end of the array being created (length 0)", idx, keyPath)
+			}
+			value = []any{value}
+			continue
+		}
 		value = map[string]any{unescapeKey(parts[i]): value}
 	}
-	return value
+	return value, nil
 }
 
 // splitPath splits a key path at its dots, as gjson does: a dot escaped
@@ -201,6 +269,44 @@ func insertKey(raw, stripped []byte, from int, key string, value any) ([]byte, e
 	return splice(raw, open+1, 0, []byte("\n"+kv+","))
 }
 
+// insertElem appends value as the last element of the array that starts at
+// or after position from.
+func insertElem(raw, stripped []byte, from int, value any) ([]byte, error) {
+	open := from
+	for open < len(raw) && stripped[open] != '[' {
+		open++
+	}
+	close := matchBracket(stripped, open)
+	if open >= len(raw) || close < 0 {
+		return nil, fmt.Errorf("cannot locate array")
+	}
+	pretty := bytes.IndexByte(raw, '\n') >= 0
+	empty := len(bytes.TrimSpace(raw[open+1:close])) == 0
+
+	if !pretty {
+		v, _ := json.Marshal(value)
+		ins := string(v)
+		if !empty {
+			ins = "," + ins
+		}
+		return splice(raw, close, 0, []byte(ins))
+	}
+
+	base := lineIndent(raw, open)
+	unit := indentUnit(raw, open, base)
+	child := base + unit
+	v, _ := json.MarshalIndent(value, child, unit)
+	if empty {
+		return splice(raw, open, close-open+1, []byte("[\n"+child+string(v)+"\n"+base+"]"))
+	}
+	// after the last element, before the line break that leads to the bracket
+	at := close
+	for at > open && isSpace(raw[at-1]) {
+		at--
+	}
+	return splice(raw, at, 0, []byte(",\n"+child+string(v)))
+}
+
 // marshalAt renders value with indentation matching the line that holds pos.
 func marshalAt(raw []byte, pos int, value any) []byte {
 	if bytes.IndexByte(raw, '\n') < 0 {
@@ -238,7 +344,14 @@ func indentUnit(raw []byte, pos int, base string) string {
 
 // matchBrace returns the index of the '}' closing the '{' at open, skipping
 // over string literals. It expects comment-free input.
-func matchBrace(b []byte, open int) int {
+func matchBrace(b []byte, open int) int { return matchPair(b, open, '{', '}') }
+
+// matchBracket returns the index of the ']' closing the '[' at open.
+func matchBracket(b []byte, open int) int { return matchPair(b, open, '[', ']') }
+
+// matchPair returns the index of cb closing ob at open, skipping over string
+// literals. It expects comment-free input.
+func matchPair(b []byte, open int, ob, cb byte) int {
 	depth := 0
 	inStr := false
 	for i := open; i < len(b); i++ {
@@ -252,9 +365,9 @@ func matchBrace(b []byte, open int) int {
 			}
 		case c == '"':
 			inStr = true
-		case c == '{':
+		case c == ob:
 			depth++
-		case c == '}':
+		case c == cb:
 			depth--
 			if depth == 0 {
 				return i
diff --git a/internal/edit/json_array_set_test.go b/internal/edit/json_array_set_test.go
new file mode 100644
index 00000000..63794488
--- /dev/null
+++ b/internal/edit/json_array_set_test.go
@@ -0,0 +1,125 @@
+package edit
+
+import "testing"
+
+// A numeric key under a JSON array indexes it: the element at an index the
+// array has is replaced, one at its length is appended, anything past that
+// is refused. The array never becomes an object and no element is dropped.
+func TestJSONSetArrayIndex(t *testing.T) {
+	one := "{\n  \"customModels\": [\n    {\"model\": \"mine\"}\n  ]\n}\n"
+	two := "{\n  \"customModels\": [\n    {\"model\": \"mine\"},\n    {\"model\": \"old\"}\n  ]\n}\n"
+	tests := []struct {
+		name    string
+		in      string
+		path    string
+		value   any
+		want    string // the file after SetJSON
+		wantErr bool
+	}{
+		{
+			name:  "replace the element at its index",
+			in:    two,
+			path:  "customModels.1",
+			value: map[string]any{"model": "new"},
+			want:  "{\n  \"customModels\": [\n    {\"model\": \"mine\"},\n    {\n      \"model\": \"new\"\n    }\n  ]\n}\n",
+		},
+		{
+			name:  "replace a member of an element",
+			in:    two,
+			path:  "customModels.1.model",
+			value: "new",
+			want:  "{\n  \"customModels\": [\n    {\"model\": \"mine\"},\n    {\"model\": \"new\"}\n  ]\n}\n",
+		},
+		{
+			name:  "insert a member into an element",
+			in:    "{\n  \"customModels\": [\n    {\n      \"name\": \"mine\"\n    }\n  ]\n}\n",
+			path:  "customModels.0.model",
+			value: "x",
+			want:  "{\n  \"customModels\": [\n    {\n      \"model\": \"x\",\n      \"name\": \"mine\"\n    }\n  ]\n}\n",
+		},
+		{
+			name:  "append at the length",
+			in:    one,
+			path:  "customModels.1",
+			value: map[string]any{"model": "other"},
+			want:  "{\n  \"customModels\": [\n    {\"model\": \"mine\"},\n    {\n      \"model\": \"other\"\n    }\n  ]\n}\n",
+		},
+		{
+			name:  "append at the length through a deeper key",
+			in:    one,
+			path:  "customModels.1.model",
+			value: "new",
+			want:  "{\n  \"customModels\": [\n    {\"model\": \"mine\"},\n    {\n      \"model\": \"new\"\n    }\n  ]\n}\n",
+		},
+		{
+			name:  "append into an empty array",
+			in:    "{\n  \"customModels\": []\n}\n",
+			path:  "customModels.0",
+			value: map[string]any{"model": "mine"},
+			want:  "{\n  \"customModels\": [\n    {\n      \"model\": \"mine\"\n    }\n  ]\n}\n",
+		},
+		{
+			name:  "create the array when the key is missing",
+			in:    "{\n  \"a\": 1\n}\n",
+			path:  "customModels.0.model",
+			value: "x",
+			want:  "{\n  \"customModels\": [\n    {\n      \"model\": \"x\"\n    }\n  ],\n  \"a\": 1\n}\n",
+		},
+		{
+			name:    "refuse past the length",
+			in:      one,
+			path:    "customModels.2",
+			value:   map[string]any{"model": "other"},
+			wantErr: true,
+		},
+		{
+			name:    "refuse a non-numeric key under an array",
+			in:      one,
+			path:    "customModels.model",
+			value:   "x",
+			wantErr: true,
+		},
+		{
+			name:    "refuse creating past the array that is missing",
+			in:      "{\n  \"a\": 1\n}\n",
+			path:    "customModels.1.model",
+			value:   "x",
+			wantErr: true,
+		},
+		{
+			name:  "a numeric key under an object stays a key",
+			in:    "{\n  \"settings\": {}\n}\n",
+			path:  "settings.0.model",
+			value: "x",
+			want:  "{\n  \"settings\": {\n    \"0\": {\n      \"model\": \"x\"\n    }\n  }\n}\n",
+		},
+		{
+			name:  "append into a compact file",
+			in:    `{"customModels":[{"model":"mine"}]}`,
+			path:  "customModels.1",
+			value: map[string]any{"model": "other"},
+			want:  `{"customModels":[{"model":"mine"},{"model":"other"}]}`,
+		},
+	}
+	for _, tt := range tests {
+		t.Run(tt.name, func(t *testing.T) {
+			p := tmpFile(t, "settings.json", tt.in)
+			err := SetJSON(p, KV{Path: tt.path, Value: tt.value})
+			if tt.wantErr {
+				if err == nil {
+					t.Fatalf("SetJSON(%q): want an error, got nil; file:\n%s", tt.path, read(t, p))
+				}
+				if got := read(t, p); got != tt.in {
+					t.Fatalf("a refused set changed the file:\n%s\nwas:\n%s", got, tt.in)
+				}
+				return
+			}
+			if err != nil {
+				t.Fatal(err)
+			}
+			if got := read(t, p); got != tt.want {
+				t.Fatalf("got:\n%s\nwant:\n%s", got, tt.want)
+			}
+		})
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
