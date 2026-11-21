## Summary

With masking on, a historical tool call whose `function.arguments` carries a newline followed by a Python decorator (`\n@mcp.tool()`) makes the vendor answer 400 `invalid tool call arguments`. The built-in EMAIL rule reads the escape's `n` as the first letter of an address (`n@mcp.tool`), and the placeholder it puts in leaves the backslash before it — the arguments are no longer JSON. The call sits in the history, so every later turn of the conversation fails with it. The fix refuses a mask's match that starts on an escape's backslash, in the strings the vendor reads after another round of unescaping.

## Cause

`messages[].tool_calls[].function.arguments` is a string that holds JSON of its own. In the request bytes the command's newline is the two characters `\` and `n` — the inner JSON's own escape.

`MaskJSON` hands every string value, decoded once, to `mask` (internal/redact/json.go:385-392; the one decoding at json.go:313). For `arguments` that decoded string is still the inner JSON text: `{"command":"print('before')\n@mcp.tool()\ndef demo():\n    return 1"}`, where every `\n` is two characters.

The EMAIL rule (internal/redact/redact.go:133) matches `[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+…`, and its bound — the characters that may not touch a match on either side (`takes`, internal/redact/redact.go:505) — is `alnum + "._%+-"`. Starting at the escape's `n`, the match `n@mcp.tool` has `\` on its left, which is not in the bound, and `(` on its right; `realEmail("n@mcp.tool")` passes (`mcp.tool` is no example or noreply host). So the value goes out as `{{EMAIL_…}}`:

```
{"command":"print('before')\{{EMAIL_gclnmmco}}()\ndef demo():\n    return 1"}
```

The backslash now precedes `{{` — `\{` is no legal JSON escape — and the inner JSON no longer parses. The outer JSON does (the walker re-escapes what it rewrites, json.go:319), so the breakage lands one layer down, where only the vendor looks: its `invalid tool call arguments`. Writing the `@` as `\u0040` removes the literal `@` the rule needs before it can match at all, which is why the reporter's escaped variant went through — a workaround, not a cure.

A probe on base pins the jump: in the decoded arguments the rule matches `n@mcp.tool` at [28:38], the character before it is `\`, not in the bound; `realEmail` passes; `takes` is true; and after `MaskJSON` the arguments fail `json.Valid` while the body as a whole still passes.

## Fix

`mask` and `takes` now say whether the string they read holds JSON of its own — a tool call's `arguments`, a stream's `partial_json` — by the same `asJSON` the restore side already reads (internal/redact/json.go:450). There, a match may not start at a backslash that opens an escape: an odd run of backslashes before the match says the last one is an escape's, and the value goes as it is. An even run — the `\\` of a Windows path — escapes itself, and what follows is masked as before. Everywhere else (plain text, and strings the vendor reads after one unescaping) nothing changes, and the rules' patterns, bounds, `ok` checks and kinds are untouched.

The parity check is exact for legal JSON: inside a string that is itself JSON, a `\` is always the head of an escape, and the escapes take only `" \ / b f n r t u` — so a match that starts right after a lone `\` starts on an escape's second character, and masking it would break the JSON; a match after `\\` stands behind a complete escape. A real address right after an escape's letter (`\njo@quill.dev`) is now left as it is where before it went out as the wrong value `njo@quill.dev` and broke the arguments — left alone, it at least parses.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| New test on base | `go test ./internal/redact -run TestMaskJSONKeepsArgumentsJSON` with internal/redact's redact.go, json.go and scrub.go reverted and the test kept | FAIL "2 masked, want 1", the arguments carrying `\{{EMAIL_…}}` |
| New test with the fix | `go test ./internal/redact -run TestMaskJSONKeepsArgumentsJSON -count=1 -v` | ok; the arguments still parse, the command reads as it was, and the real address in the same request (`mara@quill.dev`) still goes |
| Whole package | `go test ./internal/redact/... -count=1` | ok |
| Consumers | `go test ./internal/gateway/ -run 'Redact|redact|Mask' -count=1` | ok |
| Race | `go test ./internal/redact -race -run 'TestMaskJSONKeepsArgumentsJSON\|TestMaskJSON\|TestMoreKinds'` | ok |
| Format, vet | `gofmt -l internal/redact` / `go vet ./internal/redact` | empty / clean |
| Builds | `go build ./...` on darwin/arm64; `GOOS=linux GOARCH=amd64 go build -tags nogui ./...`; `GOOS=windows GOARCH=amd64 go build ./...` | all ok |
| Stack | `git am` of the #2946 patch on `318697dc`, then this one; `go test ./internal/redact/...` | applies cleanly on top of the #2946 patch as well; ok |

## Not verified

The real Ollama Cloud round trip — the report's script needs a live gateway and key, and this is pinned by a unit test on the redact package, not by the real upstream. Windows end to end (written on macOS arm64; the Windows build compiles). The report's wider regression wishlist (`\r\n@decorator`, several decorators, addresses mixed with decorators) beyond the one shape the test locks. A conversation an older magpie already broke: the broken arguments are in the history the client holds, and nothing here rewrites it.

---
**Source**: reported in #3022 (xiaobaifly7, with a standard-library reproduction script); the mechanism is pinned by a unit test on the redact package, not by the real upstream.

**Red without the fix** (base `318697dc`): with `internal/redact/redact.go` reverted and the new test kept, `go test ./internal/redact -run TestMaskJSONKeepsArgumentsJSON` fails:
```
    escape_test.go:31: 2 masked, want 1: {"messages":[{"role":"user","content":"write {{EMAIL_y22z2iun}} about the demo"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"pwsh","arguments":"{\"command\":\"print('before')\\{{EMAIL_fbpoezfb}}()\\ndef demo():\\n    return 1\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"done"}]}
--- FAIL: TestMaskJSONKeepsArgumentsJSON (0.00s)
FAIL
FAIL	github.com/yetone/magpie/internal/redact	0.944s
```
With the fix: `ok`.

**Siblings**: of the rules' bounds, a match can start on an escape's second character (`n t r b f u`) for EMAIL (this report's `n@mcp.tool`), API_KEY's `npm_…` after `\n`, API_KEY's `…_sk_…` after `\n \t \r \b \f \u`, MAC after `\b`, IPv6 after `\b \f`, and — in the home, userhost and bucket categories, off until turned on — a home-folder name, a user@host or a bucket whose pattern lets a `\` stand before the match; all refused the same way now. Unreachable: matches that start at a digit (ID_CARD, PHONE, BANK_CARD, SSN, IBAN, IPv4 — no legal escape ends before a digit), at an upper-case letter (IBAN, AKIA — escapes take lower case), or with a quote, a colon or a label between the match and what precedes it (SECRET, PASSWORD, PASSPORT, BIRTHDAY, SERIAL, the HostName/User line rules, the `s3://` buckets). A number after `\t` still masks (PHONE, BANK_CARD): the tab escape survives the replacement, and the JSON stays legal. `knownSpans` re-masks a value masked before wherever it stands and does not go through `takes`; the fix keeps the rules from making such a value in the first place, and one an older magpie holds leaves with the restart.

**When the read fails**: the shape to look for is a mask's match whose first character is an escape's second one — the `\n` of the arguments, not the newline it stands for.

**Not verified**: the real Ollama Cloud round trip, Windows end to end, the report's wider regression wishlist, and a history an older magpie already broke.

Branch with the commit: [hunt53-f-redact-json-escape](https://github.com/ggbdpq/magpie/tree/hunt53-f-redact-json-escape) (head `d6a8df9c`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: redact: a mask match in tool arguments never starts at an escape (#3022) — git am applies it as is; SHA-256 first 16: b95c245b76fbf05f</summary>

```patch
From d6a8df9c8c1ce4905a9f78591e936d491448b19a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 23:49:44 +0800
Subject: [PATCH] redact: a mask match in tool arguments never starts at an
 escape (#3022)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Why: a tool call's arguments ride in the request as a string that
holds JSON of its own, and the newline in the command it carries is
the two characters \ and n. The EMAIL rule read the n@mcp.tool after
one — the escape's n taken for the first letter of an address — and
the placeholder went in where the n had been:
{"command":"print('before')\{{EMAIL_…}}()…"}. The outer JSON still
parsed, the arguments no longer did, and Ollama Cloud turned the
request away with 400 "invalid tool call arguments"; the call sat in
the history, so every later turn failed with it. The same shape
reaches other rules where a mask's match can start at an escape's
second character: an npm_ key after \n, a MAC address after \b, an
IPv6 address after \f, a user@host after \n.

What changed: mask and takes now say whether the string holds JSON of
its own (a tool call's arguments, a stream's partial_json — the same
asJSON the restore side reads). There, a match may not start at a
backslash that opens an escape: an odd run of backslashes before the
match says the last one is an escape's, and the value goes as it is.
An even run (a \\ of a Windows path) escapes itself, and what follows
is masked as before — C:\Users\rkato keeps going in a system string,
where one unescaping is all the vendor does. Everywhere else (plain
text, a field the vendor reads as its own string) nothing changes;
the rules' patterns, bounds, ok checks and kinds are untouched.

Test: TestMaskJSONKeepsArgumentsJSON sends the report's history — an
assistant turn whose pwsh call carries print('before')\n@mcp.tool()
and a user turn that really has mara@quill.dev in it. On the base
internal/redact it fails "2 masked, want 1" with the arguments
carrying \{{EMAIL_…}}; with the change the arguments still parse, the
command reads as it was, and the address goes. It also checks a
Windows path in a plain string still masks. go test
./internal/redact/... -count=1, ./internal/gateway/ -run
'Redact|redact|Mask' -count=1, -race on the redact package, gofmt,
go vet, and go build ./... on darwin/arm64, linux/amd64 -tags nogui
and windows/amd64 pass.

Fixes #3022

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/redact/escape_test.go | 70 ++++++++++++++++++++++++++++++++++
 internal/redact/json.go        |  2 +-
 internal/redact/redact.go      | 32 ++++++++++++----
 internal/redact/scrub.go       |  2 +-
 4 files changed, 97 insertions(+), 9 deletions(-)
 create mode 100644 internal/redact/escape_test.go

diff --git a/internal/redact/escape_test.go b/internal/redact/escape_test.go
new file mode 100644
index 00000000..206971ba
--- /dev/null
+++ b/internal/redact/escape_test.go
@@ -0,0 +1,70 @@
+package redact
+
+import (
+	"encoding/json"
+	"strings"
+	"testing"
+)
+
+// A tool call's arguments ride in the request as a string that holds JSON
+// of its own: the newline in the command in it is the two characters \
+// and n, and what follows reads with the n for the start of a word. The
+// EMAIL rule took n@mcp.tool for an address, and the placeholder went in
+// where the n had been, the backslash left before it — \{{EMAIL_…}}, and
+// the arguments no longer parsed. The vendor turned the whole request away
+// with 400 "invalid tool call arguments", the history replayed, and the
+// conversation stayed broken (#3022).
+func TestMaskJSONKeepsArgumentsJSON(t *testing.T) {
+	command := "print('before')\n@mcp.tool()\ndef demo():\n    return 1"
+	inner, _ := json.Marshal(map[string]string{"command": command})
+	args, _ := json.Marshal(string(inner)) // the string that carries the arguments
+	body := `{"messages":[` +
+		`{"role":"user","content":"write mara@quill.dev about the demo"},` +
+		`{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function",` +
+		`"function":{"name":"pwsh","arguments":` + string(args) + `}}]},` +
+		`{"role":"tool","tool_call_id":"call_1","content":"done"}]}`
+	out, n := MaskJSON([]byte(body), Options{Personal: true})
+	if !json.Valid(out) {
+		t.Fatalf("body no longer JSON: %s", out)
+	}
+	if n != 1 { // the real email in the user's words, not the decorator
+		t.Fatalf("%d masked, want 1: %s", n, out)
+	}
+	var v struct {
+		Messages []struct {
+			ToolCalls []struct {
+				Function struct {
+					Arguments string `json:"arguments"`
+				} `json:"function"`
+			} `json:"tool_calls"`
+		} `json:"messages"`
+	}
+	if err := json.Unmarshal(out, &v); err != nil {
+		t.Fatalf("body: %v", err)
+	}
+	arguments := v.Messages[1].ToolCalls[0].Function.Arguments
+	if !json.Valid([]byte(arguments)) {
+		t.Fatalf("arguments no longer JSON: %s", arguments)
+	}
+	var got struct {
+		Command string
+	}
+	if err := json.Unmarshal([]byte(arguments), &got); err != nil {
+		t.Fatalf("arguments: %v", err)
+	}
+	if got.Command != command {
+		t.Fatalf("command changed: %q", got.Command)
+	}
+	// and the email the same request really has still goes
+	if !strings.Contains(string(out), "{{EMAIL_") || strings.Contains(unmarked(string(out)), "mara@quill.dev") {
+		t.Fatalf("the address went through: %s", out)
+	}
+
+	// a string that is no JSON of its own is read after one unescaping, so
+	// a Windows path in it goes as before
+	body2 := `{"cwd":"C:\\Users\\rkato\\proj"}`
+	out2, n2 := MaskJSON([]byte(body2), Options{Personal: true, Kinds: map[string]bool{"home": true}})
+	if n2 != 1 || !strings.Contains(string(out2), `C:\\Users\\{{USERNAME_`) {
+		t.Fatalf("%d: %s", n2, out2)
+	}
+}
diff --git a/internal/redact/json.go b/internal/redact/json.go
index 25b647dd..df3741b4 100644
--- a/internal/redact/json.go
+++ b/internal/redact/json.go
@@ -386,7 +386,7 @@ func MaskJSON(body []byte, o Options) ([]byte, int) {
 		if !masked(path, key, s) {
 			return s
 		}
-		t, n := mask(s, o, put)
+		t, n := mask(s, o, put, asJSON(key, ""))
 		total += n
 		return t
 	})
diff --git a/internal/redact/redact.go b/internal/redact/redact.go
index d21c256e..a18f063c 100644
--- a/internal/redact/redact.go
+++ b/internal/redact/redact.go
@@ -335,11 +335,14 @@ type span struct {
 
 // Mask swaps what o covers in s for placeholders, and says how many.
 func Mask(s string, o Options) (string, int) {
-	return mask(s, withModel(o, []string{s}), placeholder)
+	return mask(s, withModel(o, []string{s}), placeholder, false)
 }
 
-// mask swaps what o covers in s for what put makes of each value.
-func mask(s string, o Options, put func(kind, v string) string) (string, int) {
+// mask swaps what o covers in s for what put makes of each value. jsonText
+// is for a string that holds JSON of its own (a tool call's arguments): it
+// is read by the vendor after another round of unescaping, so there a value
+// may not start at a backslash.
+func mask(s string, o Options, put func(kind, v string) string, jsonText bool) (string, int) {
 	if len(s) < 3 {
 		return s, 0
 	}
@@ -387,7 +390,7 @@ func mask(s string, o Options, put func(kind, v string) string) (string, int) {
 			if len(r.groups) > 0 {
 				took := false
 				for g, kind := range r.groups {
-					if a, b := m[2*g+2], m[2*g+3]; a >= 0 && r.takes(s, a, b, r.groupOK[g]) {
+					if a, b := m[2*g+2], m[2*g+3]; a >= 0 && r.takes(s, a, b, r.groupOK[g], jsonText) {
 						found = append(found, span{a, b, kind})
 						took = true
 					}
@@ -415,7 +418,7 @@ func mask(s string, o Options, put func(kind, v string) string) (string, int) {
 				}
 				ok = nil
 			}
-			if r.takes(s, a, b, ok) {
+			if r.takes(s, a, b, ok, jsonText) {
 				found = append(found, span{a, b, r.kind})
 			}
 		}
@@ -497,14 +500,29 @@ func lowerASCII(s string) string {
 }
 
 // takes says s[a:b] is a value r masks: nothing it may not touch beside
-// it, and its checks pass.
-func (r rule) takes(s string, a, b int, ok func(string) bool) bool {
+// it, and its checks pass. jsonText is for a string that holds JSON of its
+// own, read after another round of unescaping.
+func (r rule) takes(s string, a, b int, ok func(string) bool, jsonText bool) bool {
 	if b <= a {
 		return false
 	}
 	if r.bound != "" && (a > 0 && strings.IndexByte(r.bound, s[a-1]) >= 0 || b < len(s) && strings.IndexByte(r.bound, s[b]) >= 0) {
 		return false
 	}
+	// nor, there, a backslash: a match that starts at one starts inside an
+	// escape (a string's \n, its n read as the match's first letter), and
+	// masked, that backslash would stand before the placeholder, and the
+	// JSON would no longer parse (#3022). An even run of them (a \\ of a
+	// Windows path) escapes itself, and what follows goes as before.
+	if jsonText {
+		c := 0
+		for i := a - 1; i >= 0 && s[i] == '\\'; i-- {
+			c++
+		}
+		if c%2 == 1 {
+			return false
+		}
+	}
 	if ok != nil && !ok(s[a:b]) {
 		return false
 	}
diff --git a/internal/redact/scrub.go b/internal/redact/scrub.go
index 1737b4d6..f4597483 100644
--- a/internal/redact/scrub.go
+++ b/internal/redact/scrub.go
@@ -51,7 +51,7 @@ func scrub(s string) string {
 	if len(s) >= 256 {
 		scrubRuns.Add(1)
 	}
-	out, _ := mask(s, Options{Secrets: true}, scrubbed)
+	out, _ := mask(s, Options{Secrets: true}, scrubbed, false)
 	return out
 }
 
-- 
2.50.1 (Apple Git-155)

```

</details>
