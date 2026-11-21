Rebased onto `318697dc` after upstream `c0dad80d` (redact, pii: a local model finds what the masking rules can't, #1977) reshaped `internal/redact/json.go`; the rule changes are unchanged. The one conflict was `MaskJSON`'s walk callback, which now goes through the `masked` closure that commit added: the named-secret checks sit before `!masked(path, key, s)` in that callback, and the model pre-pass is untouched.

On `318697dc` without the patch the four new tests fail at their rows — `TestMaskArkKey`, `TestMaskUpperEnvNames`, `TestMaskAuthHeaders`, `TestMaskJSONNamedSecrets`; with it `go test ./internal/redact` is `ok`.

| Check | Command | Result |
|---|---|---|
| Red on the new base (tests only) | `git checkout 6be8e04c -- internal/redact/redact_test.go internal/redact/rules_test.go && go test ./internal/redact -count=1` | the 4 tests FAIL at the rows quoted below |
| Package | `go test ./internal/redact -count=1 -v \| tail -40` | `ok  github.com/yetone/magpie/internal/redact 0.934s` |
| Sub-packages | `go test ./internal/redact/... -count=1` | `ok` |
| Race | `go test -race ./internal/redact -count=1` | `ok` (3.7s) |
| Consumers | `go test ./internal/gateway ./internal/usage ./internal/sessions ./internal/otlp ./internal/settings ./plugins/redact ./internal/masking ./internal/gui -count=1` | gateway 349s, usage, sessions, otlp, settings, plugins/redact all `ok`; internal/masking has no test files; internal/gui fails `TestProxyCheckSaysAProxyPassedBy` — it fails the same on clean `318697dc` |
| gofmt | `gofmt -l $(git diff --name-only upstream/main -- '*.go')` | empty |
| vet | `go vet ./internal/redact` | clean |
| build darwin/arm64 | `GOOS=darwin GOARCH=arm64 go build ./...` | ok |
| build linux/amd64 | `GOOS=linux GOARCH=amd64 go build ./...` | fails inside wails v3.0.0-beta.24's own `webview_window_linux.go` (`undefined: pointer`), before and after this change; `go build ./internal/redact/... ./internal/masking/...` for linux is ok |
| build windows/amd64 | `GOOS=windows GOARCH=amd64 go build ./...` | ok |
| Ablation: `json.go` back to upstream, tests kept | `git checkout upstream/main -- internal/redact/json.go && go test ./internal/redact -count=1` | `TestMaskJSONNamedSecrets`'s 7 rows red |
| Ablation: `redact.go` back, tests kept | same with `internal/redact/redact.go` | `TestMaskArkKey` 3 + `TestMaskUpperEnvNames` 4 + `TestMaskAuthHeaders` 5 rows red |
| Ablation: `scrub.go` back, tests kept | same with `internal/redact/scrub.go` | the `db_pass` row red |
| Mutation: ark rule broken | pattern `ark-` → `arkz-` | the prose and body rows red; `ARK_KEY=` survives on the upper-case rule |
| Mutation: KEY branch broken | `(?:KEY\|PASS)` → `(?:KEYX\|PASS)` | `SERVICE_X_KEY=`/`FOO_KEY=` rows red, the `DB_PASS=` rows green |
| Mutation: PASS branch broken | `(?:KEY\|PASS)` → `(?:KEY\|PASSX)` | both `DB_PASS=` rows red, the KEY rows green |
| Mutation: header rule broken | `authorization\|cookie` → `xuthorization\|cooxie` | the 5 opaque rows red; the JWT row survives on TOKEN |
| Mutation: `namedSecret` off | `key != ""` → `key == ""` | all 7 JSON rows red |
| Mutation: `notAPlainKey` always yes | its `return` → `return true` | `SORT_KEY=`/`PUBLIC_KEY=`/`PROMPT_CACHE_KEY=` red and nothing else |

Throughout the ablations and mutations, every must-stay-unmasked row (`sort_key`, `cache_key`, `public_key`, lower-case `db_pass=`, `signature`, `data`) stays green.

---
**Source**: reported in #2946; this comment re-bases the earlier patch after an upstream refactor.

**Red without the fix** (base `318697dc`): with the product files reverted and the new tests kept, `go test ./internal/redact` fails:
```
rules_test.go:109: "ARK_KEY=ark-6f2a9d47-1c3b-8e5f-a7d9-0b4c2e6f8a1d": 0 masked: "ARK_KEY=ark-6f2a9d47-1c3b-8e5f-a7d9-0b4c2e6f8a1d"
rules_test.go:153: "SERVICE_X_KEY=Vt57wQx2mLp9kNr4Zc8b": 0 masked: "SERVICE_X_KEY=Vt57wQx2mLp9kNr4Zc8b"
rules_test.go:182: "Authorization: Bearer mfa_9x2kQ7wLr4Tz": 0 masked, want 1: "Authorization: Bearer mfa_9x2kQ7wLr4Tz"
redact_test.go:245: api_key: not masked as a secret: {"api_key":"Qm27wVb9nLx4tRk8Ps3d"}
```
With the fix: `ok`.

**Siblings**: `rg 'redact\.[A-Z]' internal/ --type go -l` finds the callers in internal/gateway (the outbound mask and the archive — its 349s suite is green above), internal/masking (the settings→Options wiring — this patch changes no option), internal/gui (the settings UI — no new kind here, SECRET and API_KEY existed), internal/otlp and internal/sessions (the `Scrub*` consumers — the `_pass` name addition is what makes the archive judge this issue's names the same as the request mask), internal/pii and internal/settings (the local model (#1977) and its switch — orthogonal, untouched), plugins/redact (the user's own rules — orthogonal). `internal/routing` does not exist in this tree. The fifth area of the issue (the archive and session records not receiving the user's custom rules) stays with #1074 / PR #1078, as before.

**When the read fails**: a body that isn't JSON is masked as text, where the new rules apply as anywhere else; a value that isn't a string (a number, a boolean) is not text and goes as written.

**Not verified**: no real Volcano Ark or relay traffic went through a live gateway; the `ark-` samples are synthetic (the shape follows the repo's own Volcengine Ark tests). The `./...` build for linux stops inside the wails dependency's own file, so only the touched packages were built for linux. The local PII model (#1977) was not exercised end to end; it is off by default and this patch does not touch it. `TestProxyCheckSaysAProxyPassedBy` in internal/gui fails on clean `318697dc` with the same HTTP 502 / "the proxy asked 0 times" signature — pre-existing, not touched here.

Branch with the commit: [hunt48-b-redact-gaps](https://github.com/ggbdpq/magpie/tree/hunt48-b-redact-gaps) (head `cc7cf36bd`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: redact: the mask covers ark- keys, _KEY/_PASS names, auth headers, and JSON field names (#2946) — git am applies it as is; SHA-256 first 16: 8982602d692e9648</summary>

```patch
From cc7cf36bd387ba00b69df34a6b58688584d82cfc Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 01:36:53 +0800
Subject: [PATCH] redact: the mask covers ark- keys, _KEY/_PASS names, auth
 headers, and JSON field names (#2946)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed (one per gap the reporter reproduced on main):

- API_KEY gains the ark- value shape (#2946): Volcano Ark and the relays
  in front of it issue keys with an ark- prefix, and no value rule knew
  one. ARK_API_KEY=<ark key> was masked already (its name has api_key in
  it); ARK_KEY=<ark key>, a key in prose and one in a request body went
  as they were.
- A new SECRET rule takes an upper-case env var whose name only ends in
  KEY or PASS: SERVICE_X_KEY=…, FOO_KEY=…, DB_PASS=… — quoted or not.
  Upper case is the boundary: in the lower case a name that ends in key
  is code's (a sort_key:, a cache_key:, a public key =), so nothing of
  TestMaskGatewayKey's rows moves; notAPlainKey turns the upper-case
  SORT_KEY/PUBLIC_KEY/PROMPT_CACHE_KEY/CACHE_KEY away too.
- A new SECRET rule takes the value of an Authorization: or Cookie:
  header line, whatever it looks like — the opaque bearer tokens and
  session values the shape rules had no eye for (#2946).
- MaskJSON masks the value of a field named for a secret by its name,
  before the ids and names that would keep it: {"api_key": "…"} with a
  value no rule knows, {"db_pass": "…"}, an AKIA under access_key_id
  (its _id kept it from the value's own AKIA rule), {"Authorization":
  "Bearer …"} and {"Cookie": "…"} (#2946). signature,
  encrypted_content and data: values still go as written (#1911), and
  the tools' definitions are untouched. SecretName now says a name
  ending in pass is a secret's name too, so the archive (ScrubJSON) and
  MaskJSON judge a field by the same names.

Why: the reporter's five examples each leak a credential whose value has
no key's shape; the rules judged values by shape alone and field names
only ever kept a value. The boundary the reporter warned about —
sort_key, cache_key, prompt_cache_key, public_key must stay unmasked —
is held by case (lower-case names never enter the new rules) and by
notAPlainKey for the upper-case ones.

Run: go test -count=1 ./internal/redact/ ./internal/gateway/
./internal/sessions/ ./internal/otlp/ ./internal/settings/
./plugins/redact/ — all ok; internal/gui has one pre-existing failure
(TestProxyCheckSaysAProxyPassedBy, fails the same on upstream
e4ac5e87). gofmt clean; go vet clean on darwin/linux/windows for the
touched packages; the tree builds on darwin and windows (the linux
build fails inside wails v3.0.0-beta.24's own menu_linux.go, before and
after this change).

Fixes #2946

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/redact/json.go        |  22 +++++-
 internal/redact/redact.go      |  32 ++++++++
 internal/redact/redact_test.go |  45 ++++++++++++
 internal/redact/rules_test.go  | 130 +++++++++++++++++++++++++++++++++
 internal/redact/scrub.go       |   4 +-
 5 files changed, 231 insertions(+), 2 deletions(-)

diff --git a/internal/redact/json.go b/internal/redact/json.go
index 25b647dd..5f8993be 100644
--- a/internal/redact/json.go
+++ b/internal/redact/json.go
@@ -343,10 +343,22 @@ func jsonEscape(s string) string {
 	return string(out[1 : len(out)-2]) // the quotes and the newline
 }
 
+// namedSecret says a string under a field named for a secret holds one,
+// whatever the value looks like: the rules judge a value by its shape, the
+// name by what a field so called carries (#2946) — {"api_key": "…"} with a
+// value no rule knows, an AKIA under access_key_id, a bearer token under
+// "Authorization". A short value, and one that stands for a variable
+// (${PASS}, <token>, ****), are left alone.
+func namedSecret(key, s string) bool {
+	return key != "" && len(s) >= 8 && notAVariable(s) && SecretName(key)
+}
+
 // MaskJSON masks the strings of a request body, and says how many values
 // it masked. A body that isn't JSON is masked as text.
 //
-// What a vendor sealed with a signature (a thinking block, Gemini's
+// A field named for a secret has its value masked by its name, before the
+// ids and names that would keep it: secret names come first (#2946). What
+// a vendor sealed with a signature (a thinking block, Gemini's
 // thoughts, Responses' encrypted reasoning) is checked by the vendor
 // against the text it wrote, so it goes back as written: the values
 // masked elsewhere in the request become their placeholders again, which
@@ -383,6 +395,14 @@ func MaskJSON(body []byte, o Options) ([]byte, int) {
 		return p
 	}
 	out, ok := walk(body, func(path, key, s string) string {
+		if strings.HasPrefix(s, "data:") || signed != nil && under(path, signed) {
+			return s
+		}
+		if !under(path, defs) && namedSecret(key, s) {
+			p := put("SECRET", s)
+			total++
+			return p
+		}
 		if !masked(path, key, s) {
 			return s
 		}
diff --git a/internal/redact/redact.go b/internal/redact/redact.go
index d21c256e..d2e0289f 100644
--- a/internal/redact/redact.go
+++ b/internal/redact/redact.go
@@ -111,6 +111,9 @@ var rules = append([]rule{
 	{kind: "API_KEY", re: regexp.MustCompile(`sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`), markers: []string{"sk-"}, bound: tokenCh},
 	// a gateway's or a relay's own: oc_sk_…, or_sk_… (#195)
 	{kind: "API_KEY", re: regexp.MustCompile(`[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}`), markers: []string{"_sk_"}, bound: tokenCh, ok: secretValue},
+	// Volcano Ark and the relays in front of it issue keys with an ark-
+	// prefix (#2946)
+	{kind: "API_KEY", re: regexp.MustCompile(`ark-[A-Za-z0-9][A-Za-z0-9_-]{15,}`), markers: []string{"ark-"}, bound: tokenCh, ok: secretValue},
 	{kind: "API_KEY", re: regexp.MustCompile(`(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})`), markers: []string{"gh", "github_pat_", "glpat-"}, bound: tokenCh},
 	{kind: "API_KEY", re: regexp.MustCompile(`AIza[0-9A-Za-z_-]{35}`), markers: []string{"AIza"}, bound: tokenCh},
 	{kind: "API_KEY", re: regexp.MustCompile(`xox[abposr]-[0-9A-Za-z-]{10,}`), markers: []string{"xox"}, bound: tokenCh},
@@ -124,6 +127,18 @@ var rules = append([]rule{
 	// password = …, API_KEY: "…", as .env files and configs have them
 	{kind: "SECRET", re: regexp.MustCompile(`(?i)[A-Za-z0-9_.-]*(?:` + secretNames.pattern() + `)[A-Za-z0-9_.-]*` + quote + `[ \t]*[:=][ \t]*` + quote + `(` + secretCh + `{8,})`),
 		markers: secretNames.markers(), ok: secretValue},
+	// an env var's name says what it holds in the upper case: a
+	// SERVICE_X_KEY, a DB_PASS (#2946). The names above have a word for the
+	// secret in them; these only end in one, and only in the upper case is
+	// that a secret's name — in the lower case a name that ends in key is
+	// code's: a sort key, a cache key, a public key (notAPlainKey turns the
+	// upper-case ones of those away too).
+	{kind: "SECRET", re: regexp.MustCompile(`(?:^|[^A-Za-z0-9_.-])[A-Za-z0-9_.-]*_(?:KEY|PASS)` + quote + `[ \t]*[:=][ \t]*` + quote + `(` + secretCh + `{8,})`),
+		markers: fieldNames{{"key", "key"}, {"pass", "pass"}}.markers(), ok: secretValue, at: notAPlainKey},
+	// an Authorization or Cookie header's value is a secret whatever it
+	// looks like: an opaque bearer token, a session value (#2946)
+	{kind: "SECRET", re: regexp.MustCompile(`(?im)^[ \t]*(?:authorization|cookie)[ \t]*:[ \t]*(\S[^\r\n]{7,})`),
+		markers: fieldNames{{"authorization", "authorization"}, {"cookie", "cookie"}}.markers()},
 	// a field called key and nothing more, as providers.json has one: "key":
 	// "oc_sk_…" (#195). Only a long value of letters and digits both, since
 	// code calls anything a key: a map's "key": "value", sort_key, keyboard.
@@ -201,6 +216,23 @@ func secretValue(v string) bool {
 	return strings.ContainsAny(v, digits) && strings.IndexFunc(v, func(r rune) bool { return r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' }) >= 0
 }
 
+// notAPlainKey turns away the upper-case name before the value at s[:a]
+// when it only ends in key and holds no secret: a sort key, a cache key, a
+// prompt cache key, a public key (#2946).
+func notAPlainKey(s string, a, b int) bool {
+	i := a
+	for i > 0 && strings.IndexByte(`"' `+"\t:=", s[i-1]) >= 0 {
+		i--
+	}
+	end := i
+	for i > 0 && strings.IndexByte(alnum+"_.-", s[i-1]) >= 0 {
+		i--
+	}
+	name := strings.ToLower(s[i:end])
+	return !strings.HasSuffix(name, "sort_key") && !strings.HasSuffix(name, "cache_key") &&
+		!strings.HasSuffix(name, "prompt_cache_key") && !strings.HasSuffix(name, "public_key")
+}
+
 func realEmail(v string) bool {
 	host := strings.ToLower(v[strings.LastIndexByte(v, '@')+1:])
 	for _, fake := range []string{"example.com", "example.org", "example.net", "localhost", ".test", ".invalid", ".example"} {
diff --git a/internal/redact/redact_test.go b/internal/redact/redact_test.go
index 1379f36a..3c81912d 100644
--- a/internal/redact/redact_test.go
+++ b/internal/redact/redact_test.go
@@ -207,6 +207,51 @@ func TestMaskJSONSignedGoesBackAsWritten(t *testing.T) {
 	}
 }
 
+// A field named for a secret holds one, whatever its value looks like
+// (#2946): the rules judge a value by its shape, so {"api_key": "…"} with a
+// value no rule knows went out as it was, and access_key_id's _id kept even
+// an AKIA from the value's own rule. A name that only ends in key is no
+// secret: a sort key, a cache key, a public key stay, and so do a
+// signature and a data value the vendor reads.
+func TestMaskJSONNamedSecrets(t *testing.T) {
+	o := Options{Secrets: true}
+	for _, c := range []struct {
+		key, value string
+		gone       bool
+	}{
+		{"api_key", "Qm27wVb9nLx4tRk8Ps3d", true},
+		{"client_secret", "randomvalue42x", true},
+		{"db_pass", "Hr7jTm2qwXz94", true},
+		{"access_key_id", "AKIAIOSFODNN7EXAMPLE", true},
+		{"Authorization", "Bearer zq83Mw2vNx7kRt5", true},
+		{"Cookie", "sid=Yn41Pc8wLd2mQs6", true},
+		{"apiKey", "plainrandomvalue1", true},
+		{"sort_key", "created_at_2024", false},
+		{"cache_key", "lru_items_01", false},
+		{"prompt_cache_key", "conv_12345678", false},
+		{"public_key", "04a1b2c3d4e5f6a7", false},
+		{"signature", "sigofvendor42", false},
+		{"data", "rawbytes12345", false},
+	} {
+		body := `{"` + c.key + `":"` + c.value + `"}`
+		out, n := MaskJSON([]byte(body), o)
+		if !c.gone {
+			if n != 0 || string(out) != body {
+				t.Errorf("%s: %d masked: %s", c.key, n, out)
+				continue
+			}
+		} else {
+			if strings.Contains(string(out), c.value) || !strings.Contains(string(out), "{{SECRET_") {
+				t.Errorf("%s: not masked as a secret: %s", c.key, out)
+				continue
+			}
+		}
+		if back := RestoreJSON(out); string(back) != body {
+			t.Errorf("%s: restored %s", c.key, back)
+		}
+	}
+}
+
 // An id goes as the vendor gave it, on both sides of what it matches.
 func TestMaskJSONKeepsIDs(t *testing.T) {
 	o := Options{Secrets: true, Personal: true}
diff --git a/internal/redact/rules_test.go b/internal/redact/rules_test.go
index 2329df7b..f063ae7f 100644
--- a/internal/redact/rules_test.go
+++ b/internal/redact/rules_test.go
@@ -64,6 +64,136 @@ func TestMaskGatewayKey(t *testing.T) {
 	}
 }
 
+// Volcano Ark and the relays in front of it issue keys with an ark- prefix
+// (#2946); no value rule knew one. A name that has api_key in it (ARK_API_KEY)
+// masks its value by the name already; a key on its own, under another name
+// or in a request body, went as it was. A word that only has ark- in it is
+// no key. Each row has a value of its own, so no row's masking is the work
+// of a value another row made known.
+func TestMaskArkKey(t *testing.T) {
+	const (
+		inEnvName = "ark-c8b7e5a9-4f3d-4e2a-9b1c-7d6e5f4a3b2c"
+		underArk  = "ark-6f2a9d47-1c3b-8e5f-a7d9-0b4c2e6f8a1d"
+		inProse   = "ark-93be1f6c-7a2d-4b8e-9c0f-5d3a7e1b9c2a"
+		inBody    = "ark-2e7c4a19-8d3f-6b5a-1e9c-7f4b2d8a3c6e"
+		noKey     = "the dark-4a1c8f2e-9b3d-7e6a-0c5f-1d8b4a2e9f7b code"
+	)
+	for _, c := range []struct {
+		in   string
+		json bool
+		gone bool
+	}{
+		{in: "ARK_API_KEY=" + inEnvName, gone: true},
+		{in: "ARK_KEY=" + underArk, gone: true},
+		{in: "the ark key is " + inProse, gone: true},
+		{in: `{"notes":"relay key ` + inBody + ` for the plan"}`, json: true, gone: true},
+		{in: noKey},
+		{in: "ark-key"},
+	} {
+		var out string
+		var n int
+		if c.json {
+			var b []byte
+			b, n = MaskJSON([]byte(c.in), Options{Secrets: true})
+			out = string(b)
+		} else {
+			out, n = Mask(c.in, Options{Secrets: true})
+		}
+		if !c.gone {
+			if n != 0 || out != c.in {
+				t.Errorf("%q masked: %q", c.in, out)
+			}
+			continue
+		}
+		if n != 1 || strings.Contains(out, "ark-") {
+			t.Errorf("%q: %d masked: %q", c.in, n, out)
+			continue
+		}
+		var back string
+		if c.json {
+			back = string(RestoreJSON([]byte(out)))
+		} else {
+			back = Restore(out, false)
+		}
+		if back != c.in {
+			t.Errorf("round trip: %q → %q → %q", c.in, out, back)
+		}
+	}
+}
+
+// An env var's name says what it holds in the upper case: a SERVICE_X_KEY,
+// a DB_PASS (#2946). In the lower case a name that only ends in key holds
+// no secret: a sort key, a cache key, a public key.
+func TestMaskUpperEnvNames(t *testing.T) {
+	for _, c := range []struct {
+		in   string
+		gone bool
+	}{
+		{in: "SERVICE_X_KEY=Vt57wQx2mLp9kNr4Zc8b", gone: true},
+		{in: "FOO_KEY=Jw83hT6yQv2nRs9Xd5ke", gone: true},
+		{in: `DB_PASS="Mr4tQw9xZb7n"`, gone: true},
+		{in: "DB_PASS=Kp8vHs3wTn6j", gone: true},
+		{in: "sort_key: created_at_2024_rows"},
+		{in: "cache_key: lru_items_01"},
+		{in: "public_key = 04a1b2c3d4e5f6a7b8"},
+		{in: "db_pass=zz52Qx9vwR3n"},
+		{in: "SORT_KEY=created_at_2024"},
+		{in: "PUBLIC_KEY=04a1b2c3d4e5f6a7b8"},
+		{in: "PROMPT_CACHE_KEY=conv_12345678"},
+	} {
+		out, n := Mask(c.in, Options{Secrets: true})
+		if !c.gone {
+			if n != 0 || out != c.in {
+				t.Errorf("%q masked: %q", c.in, out)
+			}
+			continue
+		}
+		if n != 1 || strings.Contains(out, "Vt57wQx2") || strings.Contains(out, "Jw83hT6y") ||
+			strings.Contains(out, "Mr4tQw9x") || strings.Contains(out, "Kp8vHs3w") {
+			t.Errorf("%q: %d masked: %q", c.in, n, out)
+			continue
+		}
+		if back := Restore(out, false); back != c.in {
+			t.Errorf("round trip: %q → %q → %q", c.in, out, back)
+		}
+	}
+}
+
+// An Authorization or Cookie header's value is a secret whatever it looks
+// like: an opaque bearer token, a session value (#2946). Prose about them,
+// and a header of another name, are not.
+func TestMaskAuthHeaders(t *testing.T) {
+	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl"
+	for _, c := range []struct {
+		in string
+		n  int
+	}{
+		{"Authorization: Bearer mfa_9x2kQ7wLr4Tz", 1},
+		{"authorization: Basic Zm9vYmFyYmF6", 1},
+		{"Cookie: sid=8f3kz9a1x2c4", 1},
+		{"cookie: session=deadbeef42", 1},
+		{"POST /v1 HTTP/1.1\nAuthorization: Bearer tt5Za8wQ3nR7kLmx\nCookie: sid=pq93Xm2vB8n4Rk\n", 2},
+		{"Authorization: Bearer " + jwt, 1},
+		{"the authorization is required", 0},
+		{"cookies: 3", 0},
+	} {
+		out, n := Mask(c.in, Options{Secrets: true})
+		if n != c.n {
+			t.Errorf("%q: %d masked, want %d: %q", c.in, n, c.n, out)
+			continue
+		}
+		if strings.Contains(out, "mfa_9x2kQ7wLr4Tz") || strings.Contains(out, "8f3kz9a1x2c4") ||
+			strings.Contains(out, "Zm9vYmFyYmF6") || strings.Contains(out, "deadbeef42") ||
+			strings.Contains(out, "tt5Za8wQ3nR7kLmx") || strings.Contains(out, "pq93Xm2vB8n4Rk") {
+			t.Errorf("%q: a value went out: %q", c.in, out)
+			continue
+		}
+		if back := Restore(out, false); back != c.in {
+			t.Errorf("round trip: %q → %q → %q", c.in, out, back)
+		}
+	}
+}
+
 // the markers of a rule's names, made from its list, are in any name it takes
 func TestSecretMarkers(t *testing.T) {
 	for _, name := range []string{"DB_PASSWORD", "passwd", "client_secret", "Token", "apiKey", "API-KEY", "AccessKey", "private_key", "CREDENTIAL", "Credentials"} {
diff --git a/internal/redact/scrub.go b/internal/redact/scrub.go
index 1737b4d6..cb3c175e 100644
--- a/internal/redact/scrub.go
+++ b/internal/redact/scrub.go
@@ -20,7 +20,9 @@ const Scrubbed = "[REDACTED]"
 func scrubbed(kind, _ string) string { return "[REDACTED:" + kind + "]" }
 
 // secretName is a field's or header's name that says its value is a secret.
-var secretName = regexp.MustCompile(`(?i)` + secretNames.pattern() + `|authori[sz]ation|cookie|^key$`)
+// A name that ends in pass (a db_pass) is one too (#2946); a name that only
+// ends in key is not — a sort key, a cache key, a public key hold no secret.
+var secretName = regexp.MustCompile(`(?i)` + secretNames.pattern() + `|authori[sz]ation|cookie|^key$|^pass$|_pass$`)
 
 // SecretName says a field or header called name holds a secret: a token,
 // key, password or cookie — not a count of tokens (max_tokens).
-- 
2.50.1 (Apple Git-155)

```

</details>
