## Summary

`kimiToolRefTypes` (internal/gateway/kimi_schema.go) wrote a `type` into every schema a tool's `$ref`s reach that has none. When the reached target was itself a `$ref` — zod writes one beside what it changed of a reused schema, a `format` and a `description` among them — that `type` landed beside the inner `$ref`, which Moonshot's "moonshot flavored json schema" check refuses with 400 "At path '$defs.__schema14': when using $ref, type should be defined in the referenced schema instead of the parent schema", and the whole request fails. The chain a `$ref` names is now followed to the schema it ends at, and the type, if one is due, is written there — or nowhere when the chain ends at a ref to nowhere or never ends.

## Why this shape of fix

Of the two directions in the issue, resolving the chain to the final target fits what is already there: `schemaTypes` has been resolving `$ref` chains to decide *what* the type is, so only the place the type is *written* moves. Leaving every `$ref` node without a sibling type instead would also leave the chain's final target untyped when nothing else reaches it, which is the "detected infinite recursion without termination condition" refusal this function exists for.

## Verification

Tested with Codex's real `automation_update` tool schema — the captured fixture `internal/provider/testdata/codex_automation_update_schema.json` (ChatGPT.app 26.930's zod output), whose `targetThreadId` reaches `{"format":"uuid","description":"tt","$ref":"#/$defs/__schema1"}`; `__schema1` is `{"type":"string","minLength":1}`. The new test `TestKimiToolRefTypesRefChain` sends it through the gateway to a fake Kimi upstream and asserts Moonshot's rule as an invariant: no schema that goes out may carry a `type` beside a `$ref`.

| Check | Result |
|---|---|
| `go test ./internal/gateway/ -run TestKimiToolRefTypesRefChain` on 9b0f4861 (before the fix) | FAIL — "Kimi was sent a type beside a $ref ... `{"type":"string","format":"uuid","description":"tt","$ref":"#/$defs/__schema1"}`" |
| same after the fix | ok |
| ablation: kimi_schema.go restored to 9b0f4861, test kept | FAIL again, same output |
| fix re-applied | ok |
| `go test ./internal/gateway/ -count=1 -tags nogui` (whole package) | ok |
| `gofmt -l internal/gateway/` | empty |
| `go vet ./...` | exit 0 (only a pre-existing cgo warning in internal/gui/trayimage_darwin.go) |
| `GOOS=linux go vet -tags nogui ./...` | exit 0 |
| `GOOS=windows go vet -tags nogui ./...` | exit 0 |
| `GOOS=darwin go build -tags nogui ./...` | exit 0 |
| `GOOS=linux go build -tags nogui ./...` | exit 0 |
| `GOOS=windows go build -tags nogui ./...` | exit 0 |

After the fix Codex's schema goes through byte for byte: every def in it is notes beside a `$ref` to the typed `__schema1`, which Kimi takes as it is.

## Not verified

- Against the real Moonshot/Kimi API: no credentials on this machine. The 400 wording the assertions encode is the one recorded from a real refusal in kimi-work 0.1.5's tests (magpie-community/plugins#287), the plugin-side fix of the same bug.
- `kimiToolEnumTypes` would also write a type beside a `$ref` for a combined `{$ref, enum}` schema, which JSON Schema allows; no known client sends that shape (zod and Codex do not produce it) and the issue does not report one, so it is left as it was.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: no type beside the $ref a Kimi schema's target is (#3205) — git am applies it as is; SHA-256 first 16: 7e747e4fb761e6e0</summary>

```patch
From 4b3b8083a19bc26b27af746ebc91d208eb53f645 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 04:21:30 +0800
Subject: [PATCH] gateway: no type beside the $ref a Kimi schema's target is
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

kimiToolRefTypes wrote a type into each schema a tool's $refs reach that
has none. When the target was itself a $ref — zod writes one beside what
it changed of a reused schema, a format and a description among them, as
Codex's automation_update's targetThreadId reaches {"format":"uuid",
"description":"tt","$ref":"#/$defs/__schema1"} — the type went beside
that inner $ref, and Moonshot refuses one there, 400 "At path
'$defs.__schema14': when using $ref, type should be defined in the
referenced schema instead of the parent schema" (#3205), so every turn
failed though the tool is never called. The plugin side had the same bug
and fixed it in kimi-work 0.1.5.

The chain a $ref names is now followed to the schema it ends at, and it
is there the type goes, or nowhere when the chain ends at a ref to
nowhere or never ends: schemaTypes already resolved chains to say what
the type is, so only the place it is written moves. Codex's own
automation_update schema (the fixture its tests and magpie's root-union
tests share) goes as it was sent: its defs are notes beside a $ref to a
typed target, which Kimi takes.

Fixes #3205

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/kimi_schema.go      | 39 +++++++++++---
 internal/gateway/kimi_schema_test.go | 78 ++++++++++++++++++++++++++++
 2 files changed, 110 insertions(+), 7 deletions(-)

diff --git a/internal/gateway/kimi_schema.go b/internal/gateway/kimi_schema.go
index 8d698c32..50f27512 100644
--- a/internal/gateway/kimi_schema.go
+++ b/internal/gateway/kimi_schema.go
@@ -258,11 +258,17 @@ func leadingInt(s string) (int, string) {
 // allOf one as it was (chaosy on Discord, Codex on k3). The type is the
 // one the target's keywords or branches say, a type array when they differ,
 // and every type when nothing does, which Kimi takes as "any". A target
-// that is {}, an anyOf (Kimi refuses a type beside one: "type should be
-// defined in anyOf items instead of the parent schema") or only another
-// $ref is left as Kimi takes it, as is an enum whose values no one type
-// array can hold. Written in place, like kimiToolEnumTypes', after which it
-// runs.
+// that is {} or an anyOf (Kimi refuses a type beside one: "type should be
+// defined in anyOf items instead of the parent schema") is left as Kimi
+// takes it, as is an enum whose values no one type array can hold. A
+// target that is itself a $ref — zod writes one beside what it changed of
+// a reused schema, a format and a description among them — has its chain
+// followed to the target it ends at, for a type beside a $ref is refused
+// too, 400 "At path '$defs.__schema14': when using $ref, type should be
+// defined in the referenced schema instead of the parent schema" (#3205),
+// so the type goes to the chain's end or nowhere; a chain that ends at a
+// ref to nowhere, or never ends, leaves its schemas as they were. Written
+// in place, like kimiToolEnumTypes', after which it runs.
 func kimiToolRefTypes(p provider.Provider, to provider.Protocol, body []byte) []byte {
 	if !isKimi(p, to) || !bytes.Contains(body, []byte(`"$ref"`)) {
 		return body
@@ -285,7 +291,9 @@ func kimiToolRefTypes(p provider.Provider, to provider.Protocol, body []byte) []
 
 // collectRefTargets adds, for each local $ref under node (a schema of the
 // tool schema root) whose target Kimi would refuse untyped, where the
-// target opens and the type it is given.
+// target opens and the type it is given. The target is the schema the
+// chain of $refs ends at, the one place a type may go (#3205); a chain
+// that ends at a ref to nowhere, or never ends, adds nothing.
 func collectRefTargets(body []byte, root, node gjson.Result, ins *[]typeInsert) {
 	walkSchema(node, func(s gjson.Result) {
 		ref := s.Get(`\$ref`)
@@ -293,7 +301,24 @@ func collectRefTargets(body []byte, root, node gjson.Result, ins *[]typeInsert)
 			return
 		}
 		t, ok := refTarget(root, ref.String())
-		if !ok || !t.IsObject() || t.Index <= 0 || t.Index >= len(body) || body[t.Index] != '{' || !untypedForKimi(t) {
+		if !ok {
+			return
+		}
+		for i := 0; ; i++ {
+			r := t.Get(`\$ref`)
+			if r.Type != gjson.String {
+				break
+			}
+			if i > 16 {
+				return
+			}
+			n, ok := refTarget(root, r.String())
+			if !ok {
+				return
+			}
+			t = n
+		}
+		if !t.IsObject() || t.Index <= 0 || t.Index >= len(body) || body[t.Index] != '{' || !untypedForKimi(t) {
 			return
 		}
 		if typ := kimiSchemaType(root, t); typ != "" {
diff --git a/internal/gateway/kimi_schema_test.go b/internal/gateway/kimi_schema_test.go
index 56cb9186..5909cc64 100644
--- a/internal/gateway/kimi_schema_test.go
+++ b/internal/gateway/kimi_schema_test.go
@@ -1,10 +1,12 @@
 package gateway
 
 import (
+	"bytes"
 	"encoding/json"
 	"io"
 	"net/http"
 	"net/http/httptest"
+	"os"
 	"strings"
 	"testing"
 
@@ -167,6 +169,82 @@ func TestKimiToolRefTypes(t *testing.T) {
 	}
 }
 
+// A $ref whose target is itself a $ref goes without a type beside it:
+// Moonshot refuses one there, 400 "At path '$defs.__schema14': when using
+// $ref, type should be defined in the referenced schema instead of the
+// parent schema" (#3205), and the whole request fails. Codex writes such
+// defs beside what it changed of a reused one — its automation_update's
+// targetThreadId reaches {"format":"uuid","description":"tt","$ref":
+// "#/$defs/__schema1"} (the fixture is what ChatGPT.app 26.930's zod
+// builds) — so the chain is resolved to the final target and the type, if
+// one is due, is written there; __schema1 has a type, so the def goes as
+// Codex sent it.
+func TestKimiToolRefTypesRefChain(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	kimi, err := provider.FromPreset("kimi-code-cn")
+	if err != nil {
+		t.Fatal(err)
+	}
+	kimi.ID, kimi.Key, kimi.Models = "kimi", "k", []string{"m"}
+	if err := provider.Save(kimi); err != nil {
+		t.Fatal(err)
+	}
+	schema, err := os.ReadFile("../provider/testdata/codex_automation_update_schema.json")
+	if err != nil {
+		t.Fatal(err)
+	}
+	got := map[string]string{}
+	s := New()
+	s.client = &http.Client{Transport: countTransport(func(r *http.Request) (*http.Response, error) {
+		b, _ := io.ReadAll(r.Body)
+		got[r.URL.Host+r.URL.Path] = string(b)
+		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}},
+			Body: io.NopCloser(strings.NewReader(`{"id":"c","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`))}, nil
+	})}
+	body := `{"model":"kimi/m","messages":[{"role":"user","content":"hi"}],` +
+		`"tools":[{"type":"function","function":{"name":"mcp__codex_app__automation_update","parameters":` + string(schema) + `}}]}`
+	rec := httptest.NewRecorder()
+	s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body)))
+	if rec.Code != 200 {
+		t.Fatalf("%d %s", rec.Code, rec.Body)
+	}
+	b := got["api.kimi.com/coding/v1/chat/completions"]
+	if b == "" {
+		t.Fatal("nothing was sent to Kimi")
+	}
+	if !json.Valid([]byte(b)) {
+		t.Fatalf("Kimi was sent invalid JSON:\n%s", b)
+	}
+	sent := gjson.Get(b, "tools.0.function.parameters")
+	if !sent.Exists() {
+		t.Fatalf("no parameters were sent:\n%s", b)
+	}
+	// Moonshot's check, as an assertion: nothing it refuses may be left —
+	// no type beside a $ref anywhere in the schema as it goes.
+	var besideRef []string
+	walkSchema(sent, func(s gjson.Result) {
+		if s.Get("type").Exists() && s.Get(`\$ref`).Type == gjson.String {
+			besideRef = append(besideRef, s.Raw)
+		}
+	})
+	if len(besideRef) > 0 {
+		t.Errorf("Kimi was sent a type beside a $ref, refused 400 \"when using $ref, type should be defined in the referenced schema instead of the parent schema\":\n%s",
+			strings.Join(besideRef, "\n"))
+	}
+	if def := sent.Get(`$defs.__schema14`); !def.Exists() {
+		t.Error("Codex's format-and-$ref def is gone")
+	} else {
+		var buf bytes.Buffer
+		if err := json.Compact(&buf, []byte(def.Raw)); err != nil {
+			t.Fatal(err)
+		}
+		if buf.String() != `{"format":"uuid","description":"tt","$ref":"#/$defs/__schema1"}` {
+			t.Errorf("Codex's format-and-$ref def was rewritten:\n%s", def.Raw)
+		}
+	}
+}
+
 // A request to a model whose server locks temperature and top_p — Kimi
 // Code's kimi-for-coding and k3*, kimi-k2.5 and later on either Kimi
 // platform — goes without them: the whitelist refuses the ones clients
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [hunt59-c-3205-kimi-reftype](https://github.com/ggbdpq/magpie/tree/hunt59-c-3205-kimi-reftype) (head `4b3b8083a19bc26b27af746ebc91d208eb53f645`).
