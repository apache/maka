Re-based onto `9b0f4861`. Upstream's four redact commits since the last base — `88119d4f` (#3143, #3144: keys kept as written, snake_case words), `b855cfee` (#3029: file names that read as addresses), `62a3e79b` (more of those, and scale-prefixed ones) and `d3db461b` (the model's secrets leave UUIDs, digests and paths; client_metadata kept) — all rework *what* a rule or the model takes for a value. None of them touches *where* a match may start: on the new base `takes` still has its old signature, `rules.go` has no diff, and the false match this fix refuses (`n@mcp.tool`) is no file name either — `tool` is in no extension list. So the defect and the fix carry over as they were, and nothing of this patch is narrowed: the added and removed lines of all four files are byte-for-byte what the last patch had. Git's auto-merge took the rebase on its own — upstream's additions (fileExt/scaleExt in `realEmail`, the kept/defKeys entries, modelTakes' namesThing) all stand above the lines this fix edits, so every hunk applied with an offset and no manual conflict markers; the merged result was then read hunk by hunk against the last patch.

| Check | Command | Result |
| --- | --- | --- |
| Defect alive on the new base | `go test ./internal/redact -run TestMaskJSONKeepsArgumentsJSON` with only the test carried, the three product files left at `9b0f4861` | FAIL "2 masked, want 1", the arguments carrying `\{{EMAIL_…}}` (below) — the `jsonText` guard is still needed |
| With the fix | `go test ./internal/redact -run TestMaskJSONKeepsArgumentsJSON -count=1 -v` | ok; the arguments still parse, the command reads as it was, the real address still goes |
| Windows path in a plain string | the same test's second half (`"cwd":"C:\\Users\\rkato\\proj"`, home on) | masked as before — a plain string is read after one unescaping, and `asJSON("cwd")` is false, so the guard never applies to it (it also passes with the guard refusing *every* backslash) |
| Parity keeps a path inside arguments masked | probe (a throwaway test, not in the patch): `C:\Users\rkato\proj` as a pwsh call's command, home on — there the backslashes ride doubled, an even run; then the guard's `c%2 == 1` replaced by `c > 0` (the first draft's flaw), rerun, restored | masked (`{{USERNAME_…}}`) with the fix; **0 masked** without the parity; restored to a zero diff |
| The refusal is what carries the fix | the guard's `c%2 == 1` replaced by `c%2 == 2` (never refuses), the guard test rerun, restored | FAIL "2 masked, want 1" again; restored with a zero diff, ok |
| Upstream's own new tests beside the fix | `go test -tags nogui ./internal/redact/... -count=1` (includes upstream's new filename, vendorchecks and modelids tests) | ok |
| Consumers | `go test -tags nogui ./internal/gateway/ -run 'Redact\|redact\|Mask' -count=1` | ok |
| Race | `go test -tags nogui ./internal/redact -race -count=1` | ok |
| Format, vet | `gofmt -l internal/redact`; `go vet -tags nogui ./...` on darwin, `GOOS=linux` and `GOOS=windows` | empty / clean — darwin's vet prints a pre-existing cgo warning in `internal/gui/trayimage_darwin.go`, a file this patch never touches |
| Builds | `go build ./...` on darwin/arm64; `GOOS=linux GOARCH=amd64 go build -tags nogui ./...`; `GOOS=windows GOARCH=amd64 go build -tags nogui ./...` | all ok |
| The patch applies | `git am` of the patch below on a fresh `9b0f4861` worktree | applies; the resulting tree is identical to the branch's |

---

**Source**: reported in #3022 (xiaobaifly7, with a standard-library reproduction script); the mechanism is pinned by a unit test on the redact package, not by the real upstream.

**Red without the fix** (base `9b0f4861`, the test taken alone from the last patch): `go test ./internal/redact -run TestMaskJSONKeepsArgumentsJSON` fails:
```
--- FAIL: TestMaskJSONKeepsArgumentsJSON (0.00s)
    escape_test.go:31: 2 masked, want 1: {"messages":[{"role":"user","content":"write {{EMAIL_to7fddfp}} about the demo"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"pwsh","arguments":"{\"command\":\"print('before')\\{{EMAIL_ing3bono}}()\\ndef demo():\\n    return 1\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"done"}]}
FAIL
FAIL	github.com/yetone/magpie/internal/redact	1.089s
```
With the fix: `ok`.

**Siblings**: `rules.go` has no diff between the last base and `9b0f4861`, so the bounds and patterns the list below leans on carry over unchanged, and it stands as written. Of the rules' bounds, a match can start on an escape's second character (`n t r b f u`) for EMAIL (this report's `n@mcp.tool`), API_KEY's `npm_…` after `\n`, API_KEY's `…_sk_…` after `\n \t \r \b \f \u`, MAC after `\b`, IPv6 after `\b \f`, and — in the home, userhost and bucket categories, off until turned on — a home-folder name, a user@host or a bucket whose pattern lets a `\` stand before the match; all refused the same way now. Unreachable: matches that start at a digit (ID_CARD, PHONE, BANK_CARD, SSN, IBAN, IPv4 — no legal escape ends before a digit), at an upper-case letter (IBAN, AKIA — escapes take lower case), or with a quote, a colon or a label between the match and what precedes it (SECRET, PASSWORD, PASSPORT, BIRTHDAY, SERIAL, the HostName/User line rules, the `s3://` buckets). A number after `\t` still masks (PHONE, BANK_CARD): the tab escape survives the replacement, and the JSON stays legal. `knownSpans` still re-masks a value masked before wherever it stands and does not go through `takes` (it goes to `apply` directly); the fix keeps the rules from making such a value in the first place, and one an older magpie holds leaves with the restart. Upstream's `fileHost` check in `realEmail` (a host whose last label is a file extension) does not reach this case: `mcp.tool` ends in `tool`, which is in neither `fileExt` nor `scaleExt`.

**When the read fails**: the shape to look for is a mask's match whose first character is an escape's second one — the `\n` of the arguments, not the newline it stands for. In the code the guard lives in `takes` (internal/redact/redact.go, the odd run of backslashes before the match), reached from `mask` with `jsonText` true only where `MaskJSON` walks a string whose `asJSON(key, "")` says the vendor reads it after another unescaping.

**Not verified**: the real Ollama Cloud round trip, Windows end to end, the report's wider regression wishlist (`\r\n@decorator`, several decorators, addresses mixed with decorators), and a history an older magpie already broke. The even-run probe (a path inside a tool call's arguments) is evidence in the table above only — the landed test's second half covers a path in a plain string, not one inside `arguments`.

Branch with the commit: [hunt53-f-redact-json-escape](https://github.com/ggbdpq/magpie/tree/hunt53-f-redact-json-escape) (head `2bf5b3dc386f5b91366c93d8142c781d8ae73519`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

<details><summary>patch: redact: a mask match in tool arguments never starts at an escape (#3022) — git am applies it as is; SHA-256 first 16: def438a52df86359</summary>

```patch
From 2bf5b3dc386f5b91366c93d8142c781d8ae73519 Mon Sep 17 00:00:00 2001
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
Windows path in a plain string still masks. Rebased onto 9b0f4861:
upstream's 88119d4f, b855cfee, d3db461b and 62a3e79b reworked what
the rules and the model take for a value (file names that read as
addresses, UUIDs, digests, paths; keys left as written) and none of
it touches where a match may start, so the fix and the defect carry
over as they were — on the new base the test fails the same way,
mcp.tool is no file extension either, and a match after an even run
of backslashes in a jsonText string is still masked. go test -tags
nogui ./internal/redact/... -count=1, ./internal/gateway/ -run
'Redact|redact|Mask' -count=1, -race on the redact package, gofmt,
go vet -tags nogui on darwin, linux and windows, and go build on
darwin/arm64, linux/amd64 -tags nogui and windows/amd64 -tags nogui
pass.

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
index df00352e..3c164da6 100644
--- a/internal/redact/json.go
+++ b/internal/redact/json.go
@@ -396,7 +396,7 @@ func MaskJSON(body []byte, o Options) ([]byte, int) {
 		if !masked(path, key, s) {
 			return s
 		}
-		t, n := mask(s, o, put)
+		t, n := mask(s, o, put, asJSON(key, ""))
 		total += n
 		return t
 	})
diff --git a/internal/redact/redact.go b/internal/redact/redact.go
index 9beb7191..5321450b 100644
--- a/internal/redact/redact.go
+++ b/internal/redact/redact.go
@@ -433,11 +433,14 @@ func Hint(kind, v string) (head string, n int) {
 
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
@@ -485,7 +488,7 @@ func mask(s string, o Options, put func(kind, v string) string) (string, int) {
 			if len(r.groups) > 0 {
 				took := false
 				for g, kind := range r.groups {
-					if a, b := m[2*g+2], m[2*g+3]; a >= 0 && r.takes(s, a, b, r.groupOK[g]) {
+					if a, b := m[2*g+2], m[2*g+3]; a >= 0 && r.takes(s, a, b, r.groupOK[g], jsonText) {
 						found = append(found, span{a, b, kind, r.by()})
 						took = true
 					}
@@ -513,7 +516,7 @@ func mask(s string, o Options, put func(kind, v string) string) (string, int) {
 				}
 				ok = nil
 			}
-			if r.takes(s, a, b, ok) {
+			if r.takes(s, a, b, ok, jsonText) {
 				found = append(found, span{a, b, r.kind, r.by()})
 			}
 		}
@@ -603,14 +606,29 @@ func lowerASCII(s string) string {
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
