**What's wrong**

A field whose name says a token's lifetime is masked as a secret. With masking on, the line from this issue

```json
"access_token_expires_at": "2026-08-30T11:44:31.312645+08:00",
```

goes out as

```json
"access_token_expires_at": "{{SECRET_…}}:44:31.312645+08:00",
```

— the head of the timestamp to the hour replaced by a placeholder, the minutes left as written. The value is a moment, not a secret; a model that needs to know when the token expires can no longer read it. In a tool call's arguments or a tool's structured result the whole moment goes: `"access_token_expires_at": "2026-08-30T11:44:31.312645+08:00"` masks entire, by the field's name alone.

**Root cause**

The SECRET rule takes, after a name with token/secret/password/key in it, a run of its secret's characters `[A-Za-z0-9_\-./+=~!@#%^&*]{8,}`. A time's colons are none of those characters, so of `2026-08-30T11:44:31.312645+08:00` the rule reads only the head to the hour, `2026-08-30T11` — a letter (the T) and digits both, which the value-side checks keep as written when they name a path, a line, a version, code or a skill; a moment they did not know. The same head masked after 令牌是, 密钥为, token 是, apikey 为, SERVER_KEY and DB_PASS (the CJK key rules and the `_KEY`/`_PASS` rule read values through the same checks), and in a tool call's arguments `namedSecret` takes the whole value by the field's name whatever it looks like (#2946), the timestamp included.

**The fix**

`timestampValue` (internal/redact/fieldvalue.go) says a moment as RFC 3339 writes one — whole, or the head to the hour, which is all of it the rules' characters hold — is no secret, beside the version and the path, in `fieldAt` (the SECRET rules' value check), `keyAt` (the CJK key rules') and `namedSecret` (a tool call's arguments). A value that only starts as a moment still masks: what follows the hour is the key's (`"token": "2026-08-30T11x9k2abc:def"` masks as before). What the CJK password rule takes after 密码 it still takes, as it takes digits only.

Patch (`git am`), SHA-256 `66f704707e03192a` (first 16):

<details>
<summary>Patch (git am)</summary>

```diff
From 4009e8f9b840af59ab14dbd293128559bb78abc2 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 02:35:51 +0800
Subject: [PATCH] redact: a moment a token's field names is no secret (#5002)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

dchaofei's report: "access_token_expires_at":
"2026-08-30T11:44:31.312645+08:00" went out as
"access_token_expires_at": "{{SECRET_…}}:44:31.312645+08:00". The
field's name has token in it, and the head of the moment to its hour is
all of it a secret's characters hold — the time's colons are none of
theirs — so 2026-08-30T11 masked and the minutes went to the vendor as
written. The same head masked after 令牌是, 密钥为, token 是, apikey 为
and SERVER_KEY, DB_PASS: the value-side checks (fieldAt, keyAt) keep a
version and a path as written, a moment they did not know. In a tool
call's arguments the whole moment masked (namedSecret), where a field
named for a secret takes its value whatever it looks like.

timestampValue keeps a moment as RFC 3339 writes one, whole or its head
to the hour, as written beside the version and the path (fieldAt,
keyAt, namedSecret). A value that only starts as a moment still masks:
what follows the hour is the key's. What the CJK password rule takes
after 密码 it still takes, as it takes digits only.

Run: go test -tags nogui -count=1 ./internal/redact/...
./internal/pii/... ./internal/settings/...: ok; -race ./internal/redact:
ok; go build ./...: ok; go vet, gofmt clean.
Broken by hand: timestampValue gone, TestTimestampIsNoSecret red on all
twelve lines (the reporter's among them) and on the tool call's input
the whole moment masked; TestTimestampHeadAndMoreIsASecret green still.

Not tried: the real local masking model on the reporter's whole request
(their line is all the evidence there is).

Co-authored-by: ggbdpq <ggbdpq@gmail.com>
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/redact/fieldvalue.go      | 30 ++++++++++++------
 internal/redact/fieldvalue_test.go | 49 ++++++++++++++++++++++++++++++
 internal/redact/json.go            | 16 +++++-----
 internal/redact/redact.go          |  7 +++--
 4 files changed, 82 insertions(+), 20 deletions(-)

diff --git a/internal/redact/fieldvalue.go b/internal/redact/fieldvalue.go
index 9ba078024..a18ce52cc 100644
--- a/internal/redact/fieldvalue.go
+++ b/internal/redact/fieldvalue.go
@@ -32,15 +32,11 @@ import (
 //     "2.4.0-beta02" (dniray on Discord, v0.1.1917: package names and
 //     their versions were replaced). A release's version is published for
 //     anyone to read (versionValue).
-//   - the next field, when the one named has no value: a command line
-//     sets UI_PASSWORD to nothing in env -i UI_PASSWORD= UI_ADDR=127.0.0.1:39117
-//     ./syncer serve, and the SECRET rule, which lets a space stand after
-//     = (password = hunter2 in a config), took UI_ADDR=127.0.0.1 for
-//     UI_PASSWORD's value (mx_albert on Discord). A value that starts as
-//     an assignment of its own, after a space, is the next field
-//     (nextField), and that field is read on its own: UI_ADDR's address
-//     goes as written, and UI_PASSWORD= UI_TOKEN=t0k3nValue2 still masks
-//     the token.
+//   - a moment: "access_token_expires_at": "2026-08-30T11:44:31.312645+08:00"
+//     says when a token expires, and no secret does (dchaofei, #5002). The
+//     time's colons are no secret's characters, so what the rule took was
+//     the head to the hour, 2026-08-30T11, the minutes after it as written
+//     (timestampValue).
 //
 // A secret written down still masks: password=hunter2pass9,
 // API_KEY=AbC123dEf456GhI789, token: t0k3nValue2, a password of one word
@@ -56,7 +52,7 @@ func fieldAt(s string, a, b int) bool {
 	if v[0] == '=' {
 		return false // Go's := with no space after it: secretKey:=base64Encode(raw)
 	}
-	return !fileField(s, a) && !lineRef(v) && !pathValue(v) && !namesASecret(v) && !skillName(s, a, b) && !versionValue(v)
+	return !fileField(s, a) && !lineRef(v) && !pathValue(v) && !namesASecret(v) && !skillName(s, a, b) && !versionValue(v) && !timestampValue(v)
 }
 
 // versionRangeRe is a release's version as a manifest or a lock file
@@ -74,6 +70,20 @@ var versionRangeRe = regexp.MustCompile(`^(?:[~^]|[<>=!~]=?|==)?[vV]?\d+(?:\.\d+
 // it, the local model in a manifest.
 func versionValue(v string) bool { return versionRangeRe.MatchString(v) }
 
+// stampRe is a moment as RFC 3339 writes one, whole or the head of one to
+// the hour. Whole is what a tool call's argument carries
+// (namedSecret, json.go); the head is all of it the SECRET rules'
+// characters hold, the time's colons none of theirs, so
+// access_token_expires_at: "2026-08-30T11:44:31.312645+08:00" was read to
+// 2026-08-30T11 and the minutes went out as written (dchaofei, #5002). A
+// date alone has no letter in it and secretValue keeps it already; the T
+// and the hour are what read as a key's letters.
+var stampRe = regexp.MustCompile(`^\d{4}-\d{1,2}-\d{1,2}[Tt]\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?$`)
+
+// timestampValue says v is a moment's writing, which no secret is: an
+// expiry, a renewal, an update (fieldAt, keyAt, namedSecret).
+func timestampValue(v string) bool { return stampRe.MatchString(v) }
+
 // skillName says s[a:b] is the second half of plugin:skill, as Claude
 // Code names a plugin's skill and command (design-tokens:generate-v2,
 // secret-scan:audit-x7k2p9q1): words in lower case joined by hyphens on
diff --git a/internal/redact/fieldvalue_test.go b/internal/redact/fieldvalue_test.go
index afb950f54..84e2ba163 100644
--- a/internal/redact/fieldvalue_test.go
+++ b/internal/redact/fieldvalue_test.go
@@ -76,6 +76,55 @@ func TestPathAndSkillAreNoSecret(t *testing.T) {
 	}
 }
 
+// A moment goes as written: dchaofei (#5002) saw a token's expiry masked
+// to the hour, the minutes after it left as written. The field's name has
+// token in it, its value is a time, and the head of it the SECRET rules'
+// characters hold is a date's, not a key's.
+func TestTimestampIsNoSecret(t *testing.T) {
+	for _, in := range []string{
+		`"access_token_expires_at": "2026-08-30T11:44:31.312645+08:00",`,
+		`"access_token": "2026-08-30T11:44:31Z"`,
+		`"token_expiry": "2026-08-30T11:44:31Z"`,
+		`"secret_updated_at": "2026-08-30T11:44:31.312645+08:00"`,
+		`"credential_expires": "2026-08-30T11:44:31Z"`,
+		"token_expiry: 2026-08-30T11:44:31",
+		"SERVER_KEY: 2026-08-30T11:44:31Z",
+		"DB_PASS: 2026-08-30T11:44:31Z",
+		"令牌是 2026-08-30T11:44:31",
+		"密钥为 2026-08-30T11:44:31+08:00",
+		"token 是 2026-08-30T11:44:31",
+		"apikey 为 2026-08-30t11:44:31z",
+	} {
+		if out, n := Mask(in, Options{Secrets: true}); n != 0 {
+			t.Errorf("%q: %d masked: %q", in, n, out)
+		}
+	}
+	// In a tool call's arguments a field named for a secret takes its
+	// value whatever it looks like (json.go); a moment it does not: the
+	// field says when the token ends, and an agent reads that. The token
+	// beside it still masks.
+	body := []byte(`{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"get_status","input":` +
+		`{"access_token_expires_at":"2026-08-30T11:44:31.312645+08:00","access_token":"a1b2c3d4e5f6g7h8"}}]}]}`)
+	out, n := MaskJSON(body, Options{Secrets: true})
+	if n != 1 || !strings.Contains(string(out), "2026-08-30T11:44:31") || strings.Contains(unmarked(string(out)), "a1b2c3d4e5f6g7h8") {
+		t.Errorf("the tool call's expiry masked with its token: %d: %s", n, out)
+	}
+}
+
+// A value that only starts as a timestamp still masks: what follows the
+// hour is the key's, not the moment's.
+func TestTimestampHeadAndMoreIsASecret(t *testing.T) {
+	for in, v := range map[string]string{
+		`"token": "2026-08-30T11x9k2abc:def"`: "2026-08-30T11x9k2abc",
+		"token=a1b2c3d4-2026-08-30T11:44":     "a1b2c3d4-2026-08-30T11",
+		"token=2026-08-30T11-abc:def":         "2026-08-30T11-abc",
+	} {
+		if out, n := Mask(in, Options{Secrets: true}); n != 1 || strings.Contains(unmarked(out), v) {
+			t.Errorf("%q: %d masked: %q", in, n, out)
+		}
+	}
+}
+
 // A secret of the same shape still masks: a value of one word and digits,
 // a random one, one starting with L, a file of secrets' content, a key in
 // a header with no space, a password in a connection string.
diff --git a/internal/redact/json.go b/internal/redact/json.go
index 2fe1ec205..4f299d6e8 100644
--- a/internal/redact/json.go
+++ b/internal/redact/json.go
@@ -367,14 +367,16 @@ func jsonEscape(s string) string {
 // whatever the value looks like: the rules judge a value by its shape, the
 // name by what a field so called carries (#2946) — {"api_key": "…"} with a
 // value no rule knows, an AKIA under access_key_id, a bearer token under
-// "Authorization". A short value, and one that stands for a variable
-// (${PASS}, <token>, ****), are left alone. It is asked only of a tool
-// call's arguments and a tool's structured result (args), whose keys are
-// the tool's: a key the vendor's protocol names (Anthropic's
-// mcp_servers[].authorization_token, a tool's own settings) is the
-// vendor's to read, and masked by its name, it would no longer work.
+// "Authorization". A short value, one that stands for a variable (${PASS},
+// <token>, ****), and a moment (a token's expiry,
+// access_token_expires_at, dchaofei #5002) are left alone. It is asked
+// only of a tool call's arguments and a tool's structured result (args),
+// whose keys are the tool's: a key the vendor's protocol names
+// (Anthropic's mcp_servers[].authorization_token, a tool's own settings)
+// is the vendor's to read, and masked by its name, it would no longer
+// work.
 func namedSecret(key, s string) bool {
-	return key != "" && len(s) >= 8 && notAVariable(s) && SecretName(key)
+	return key != "" && len(s) >= 8 && notAVariable(s) && !timestampValue(s) && SecretName(key)
 }
 
 // MaskJSON masks the strings of a request body, and says how many values
diff --git a/internal/redact/redact.go b/internal/redact/redact.go
index fdfd604dd..f1c659b2f 100644
--- a/internal/redact/redact.go
+++ b/internal/redact/redact.go
@@ -332,9 +332,10 @@ func keyValue(v string) bool {
 // time.
 func keyAt(s string, a, b int) bool {
 	v := s[a:b]
-	if pathValue(v) || versionValue(v) {
-		// where a key is kept: 私钥 ~/.ssh/id_ed25519, or a release's
-		// version: token 是 0.15.0-rc1 (fieldvalue.go)
+	if pathValue(v) || versionValue(v) || timestampValue(v) {
+		// where a key is kept: 私钥 ~/.ssh/id_ed25519, a release's
+		// version: token 是 0.15.0-rc1, or a moment: 令牌是
+		// 2026-08-30T11:44:31 (fieldvalue.go)
 		return false
 	}
 	if keyValue(v) {
-- 
2.50.1 (Apple Git-155)

```

</details>

**Verification**

| Check | Result |
| --- | --- |
| TestTimestampIsNoSecret — 12 lines, the reporter's among them, plus a tool call's input — and TestTimestampHeadAndMoreIsASecret, fix in place | green |
| go test -tags nogui -count=1 ./internal/redact/... | ok |
| go test -race -tags nogui ./internal/redact/ | ok |
| go test -tags nogui -count=1 ./internal/pii/... ./internal/settings/... | ok |
| go build ./... | ok |
| go vet -tags nogui ./internal/redact/, gofmt -l internal/redact/ | clean |
| Ablation: fieldvalue.go, redact.go, json.go back at 7785c4278, tests kept | red: all 12 lines masked, the tool call's input masked whole |
| go test -tags nogui -count=1 ./internal/gateway/... | ok (862.8s, the whole package) |

**Not verified**

- The real local masking model on the reporter's whole request — their line is all the evidence there is; the rules layer alone reproduces both forms.
- A basic-format ISO 8601 stamp with no separators (`20260830T114431Z`) still masks under a field named for a secret; a rare form, left as it is.
- What the request archive scrubs (ScrubJSON) still replaces a secret-named field's value wholly, by design; the fix is on the sent side.

**AI use**

Written by GLM-5.3-Flash (ZCode); author and committer ggbdpq, `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` in the commit.

Attribution: AI-written (GLM-5.3-Flash via ZCode); author ggbdpq, Co-authored-by: ggbdpq <ggbdpq@gmail.com>
Branch: https://github.com/ggbdpq/magpie/tree/fix/5002-redact-rules (head 4009e8f9b840af59ab14dbd293128559bb78abc2)
