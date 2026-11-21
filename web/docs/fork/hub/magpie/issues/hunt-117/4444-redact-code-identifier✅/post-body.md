From the reporter's redaction screenshot ([image](https://github.com/user-attachments/assets/e8cb3c85-cede-43e8-83ae-34e926db11f8)): `gctx.GetInt64("user_id")` went out with the method a call is made on replaced by a made-up key (`oawo.DfkYs154`), while `("user_id")` stayed. Fixed in `internal/redact/model.go` — one guard, the same check the rules' own values already ask.

**What was wrong**

The replacement keeps the dot and each character's class (`gctx`→`oawo`, `GetInt64`→`DfkYs154`): that is the stand-in Privacy masking writes for a **secret** when shape is on. No rule can match such a span — every secret rule needs a field name (`password=`, `"api_key":`), a known prefix (`sk-`, `ghp_`, `eyJ`) or an `Authorization:` line around its value. The finder is the local model ("find with a local model"): it labeled the dotted identifier `secret`, and the model's secret filters (`modelTakes`, `modelFits`) had no guard for a dotted identifier that code calls — a `(` follows it directly.

**What changed**

`modelFits` now asks `notCode` — the very check the rules' values ask — of the model's `secret` finds, so a dotted identifier a call is made on stays as written. What the mask covers does not otherwise move: a value with a dash or a space in it fails `identPath` at once and is judged as before; a dotted one that is quoted, or stands in prose, still passes and is masked still (a test of each). Secrets in named fields keep their rule masks regardless of the model.

**Run**

| check | result |
|---|---|
| RED (product file reverted, test kept) | `TestModelMisreadsNotMasked` fails: `gctx.GetInt64` masked as `{{SECRET_…}}` in `rows, err := gctx.GetInt64("user_id")` |
| GREEN + ablation restored | passes; `go test -tags nogui ./internal/redact/` passes |
| a real secret of dotted parts the model alone finds | `the vault phrase is alpha.bravo.charlie9` still masked (new test row) |
| named-field secrets | unchanged: the rules' masks are independent of the model |
| gofmt, go vet, build | clean on darwin/arm64, linux/amd64, windows/amd64 (`-tags nogui`); the only vet note is the pre-existing cgo warning in `internal/gui/trayimage_darwin.go` |

**Not verified**: against the real local model — no model runs in the test environment; the guard is tested at the seam the existing suite uses, a stand-in model whose `secret` finds the filters judge, which is the code path that masked the reporter's span.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

<details><summary>patch: fix(redact): a dotted identifier a call is made on is no secret (#4444) — git am applies it as is; SHA-256 first 16: 970f9af1a45e540d</summary>

```patch
From a840fd88186abe21a55377a5df6743dc397339e6 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 20:37:13 +0800
Subject: [PATCH] fix(redact): a dotted identifier a call is made on is no
 secret (#4444)

The local masking model took gctx.GetInt64, the method a call is made
on, for a secret, and it went as a made-up key in the reporter's
redaction shot. No rule reaches such a span, so the model's SECRET
filters are where it is told apart: modelFits now asks the same
notCode the rules' values ask, and a value code goes on from -- a
dotted identifier a `(` follows, or one unquoted after a colon that
code carries on past -- stays as written. Real secrets keep being
masked: one with a dash or a space fails identPath at once, and a
dotted one quoted or in prose still passes (a test of each).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/redact/model.go          | 6 ++++++
 internal/redact/modelfits_test.go | 5 +++++
 2 files changed, 11 insertions(+)

diff --git a/internal/redact/model.go b/internal/redact/model.go
index 749f01c19..f1fa33237 100644
--- a/internal/redact/model.go
+++ b/internal/redact/model.go
@@ -344,6 +344,12 @@ func modelFits(s string, a, b int, kind string) bool {
 		}
 		return strings.IndexFunc(v, unicode.IsLetter) >= 0
 	case "SECRET":
+		// a name code goes on from is no value: a dotted identifier a call
+		// is made on (gctx.GetInt64 in gctx.GetInt64("user_id") went as a
+		// made-up key, #4444), by the same check the rules' values ask
+		if !notCode(s, a, b) {
+			return false
+		}
 		if !wordByte(v[0]) || patternWords(v) || regexpLike(v) || idAfter(s, a) || strings.ContainsRune(v, ' ') && clockIn.MatchString(v) || uuidIn.MatchString(v) || strings.Contains(v, `": `) || strings.Contains(v, `", "`) || linkRe.MatchString(v) {
 			return false
 		}
diff --git a/internal/redact/modelfits_test.go b/internal/redact/modelfits_test.go
index d2335f3e3..0f3e74ecf 100644
--- a/internal/redact/modelfits_test.go
+++ b/internal/redact/modelfits_test.go
@@ -69,6 +69,9 @@ func TestModelMisreadsNotMasked(t *testing.T) {
 		{"wait until CI is green", "CI", "private_person"},
 		{"CodeRabbit\tpending\t0", "CodeRabbit", "private_person"},
 		{"Greptile Review at https://app.greptile.com/r/1", "Greptile", "private_person"},
+		// the method a call is made on: gctx.GetInt64 went as a made-up key
+		// in the reporter's redaction shot (#4444)
+		{`rows, err := gctx.GetInt64("user_id")`, "gctx.GetInt64", "secret"},
 	} {
 		f := &fakeModel{values: map[string]string{c.value: c.label}}
 		if out, n := Mask(c.text, Options{Secrets: true, Personal: true, Model: f.find}); n != 0 {
@@ -94,6 +97,8 @@ func TestModelFindsStillMasked(t *testing.T) {
 		{"write to rina.k@kowalczyk.pl", "rina.k@kowalczyk.pl", "private_email"},
 		// beside what the checks above leave out
 		{"the stripe one is sk_test_AbCdEfGh_IjKlMn", "sk_test_AbCdEfGh_IjKlMn", "secret"},
+		// a real secret of dotted parts, where no rule reaches it
+		{"the vault phrase is alpha.bravo.charlie9", "alpha.bravo.charlie9", "secret"},
 		{"the token is 9f2c4e1a7b3d5c8e9f2c", "9f2c4e1a7b3d5c8e9f2c", "secret"},
 		{"ask McDonald, he knows", "McDonald", "private_person"},
 		{"write to Rina at rina.lee@kowalczyk.pl", "Rina", "private_person"},
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4444-redact-code-identifier](https://github.com/ggbdpq/magpie/tree/fix/4444-redact-code-identifier) (head `a840fd88186abe21a55377a5df6743dc397339e6`).
