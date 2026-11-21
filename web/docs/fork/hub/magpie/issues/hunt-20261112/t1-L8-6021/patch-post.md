All four gaps, patched — your forensics made this a straight implementation; the field paths and the literal bytes you posted are the tests.

## What changed (`internal/sessions/antigravity_app.go` only — no pricing-layer change)

1. **Effort** — `agAppModel` now returns the model **and** its effort: field 19's own suffix is the effort when it carries one (`claude-opus-5-5-high`, `claude-opus-4-6-thinking` — `catalog.Unsuffixed`'s words), and where field 19 says nothing the field 21 label's parentheses say it ("Gemini 4 Carbon (High)" is gemini-4-carbon **at high**), which is the only place those rows record the level. `Call.Effort` is set; the 思考档位 column fills.
2. **-tiered / -trial** — named as their base (`gemini-3.8-flash-tiered` → gemini-3.8-flash, `gemini-4-argon-trial` → gemini-4-argon), which is how the gateway already names them (`collapseAntigravityModels` cuts `-tiered`), so the rows price as the base instead of showing `—`. Your 17,678 tiered rows price.
3. **Requested** — `executor_metadata` is read: its field 9 is the turn's execution id (the same id the step's field 20.4 carries) and its field 10.1.28 the requested slug ("gemini-4-carbon-high"); the call shows it as `Requested`, as Claude Code's rows do. Silent tiering becomes visible.
4. **Reasoning** — the usage message's field 9 is read into `Call.Reasoning`; the page already renders it ("{n} reasoning, inside output"). Your sample row reads 176 of 356.

**Left out, on purpose**: the subagent tier face (trajectory_metadata_blob's 8.12 caller tier and the 10.15.{1,2,3}.1 tier→model map) — another table's mapping, and its rows already carry a served model in field 19; left as a follow-up for the maintainer to weigh. And one honest caveat the patch carries in its comment: a field-19-less label of another maker slugs to the id form but keeps its version spelling — "Claude Opus 4.6" slugs to `claude-opus-4.6` where the id spells it `claude-opus-4-6` — so those few rows may still sit unpriced (they were, in full, before).

## Red without the fix (parent `9c33839de`), and the mutations

- `TestAntigravityAppModelEffort` — your literal field bytes: the label-alone row kept "Gemini 4 Argon (High)" as the model verbatim; tiered/trial kept their suffixes; efforts all `""`.
- `TestAntigravityAppReasoningTokens` — your usage row's bytes: reasoning read 0 of the 176 (output 356 = 176+180, input 26094, cache read 16781).
- `TestAntigravityAppRequestedModel` — fixture conversation with an executor row joined by the execution id: no call carried a Requested.
- Each face's own mutation, red on its decision line with the build passing: the field-19 effort/label fallback held back → the effort rows red; the `-tiered`/`-trial` branch removed → `tiered: model "gemini-3.8-flash-tiered" …, trial: "gemini-4-argon-trial" …` red; `case 9` dropped → `reasoning 0, want 176` red twice; the executor map unfilled → `requested "", want gemini-4-carbon-high` red. Restored, all green.

| check | result |
| --- | --- |
| `go test ./internal/sessions -run TestAntigravityApp -count=1` (rebased head) | ok — and the older AppCalls/Deployment/Title/Folder tests green throughout (deployment names, `-lite`, a capital `-D` keep their behavior) |
| `go test ./internal/sessions` (whole, `-count=1`) | ok 118.6s |
| `-run TestAntigravityApp -race` | ok |
| `go test ./internal/usage -count=1` | ok 32.8s |
| `go test -tags nogui ./internal/gui -run 'Usage|Antigravity'` | ok |
| `gofmt -l internal/sessions`, `go vet` | clean |
| `GOOS=windows` / darwin / linux (`-tags nogui`) builds | pass |
| `git am` on `f0571d7da` | tree identical (2 files, +291/−19) |

**Siblings**: `agAppModel` has one caller (the reader); `executor_metadata` is read nowhere else; `catalog.Unsuffixed` is consumed as-is, unchanged. The Sessions page's model aggregates pick the normalized ids up too (a label stopped being a model there).

**When the read fails**: an executor table that can't be read leaves Requested blank as before; a label whose parentheses hold no word, or a long one, is slugged whole with no effort — nothing new is read for any of this beyond the table's rows.

**Not verified**: a real Antigravity desktop database against the new read (your 322 databases and wire bytes are the fixtures here, reconstructed; the app isn't installed on any machine magpie is tried on); the pricing of `gemini-4-argon` / `claude-opus-4-6` on your machine's catalog (models.dev-driven); the subagent tier face (declared follow-up).

Branch with the commit: [hunt-20261112-t1-6021](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-6021) (head `5a6e9d1468bbe058`).

---
**Source**: reported in #6021; the fixtures are your literal wire bytes and field paths, checked against `main` at `f0571d7da`.

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`

**Patch**: <details><summary>patch: sessions: the Antigravity app's calls keep their effort, requested model and thinking tokens, and name Google's -tiered and -trial servings as their base (#6021) — git am applies it as is; SHA-256 first 16: b546dd125ed271cb</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 13 Nov 2026 03:28:00 +0800
Subject: [PATCH] sessions: the Antigravity app's calls keep their effort,
 requested model and thinking tokens, and name Google's -tiered and -trial
 servings as their base (#6021)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Reading the Antigravity desktop's conversations (YOUYUDAWANG's real
databases, #6021, 322 of them, 38172 generator rows):

- The effort was always blank, and a generator whose field 19 is absent
  put the picker's whole label in the model column: "Gemini 4 Argon
  (High)" as a model name, at no price. Field 19's own effort suffix
  (-high, -thinking) is the effort now, and where it says nothing the
  field 21 label's parentheses say it ("Gemini 4 Carbon (High)" is
  gemini-4-carbon at high). A label with field 19 absent slugs to the id
  form; a label of another maker keeps its version spelling (Claude Opus
  4.6 slugs to claude-opus-4.6, the id spells it 4-6) and may then sit
  unpriced, as it did.
- gemini-3.8-flash-tiered (17678 of those rows) and gemini-4-argon-trial
  are Google's servings of their base, named and priced as the gateway
  names them (collapseAntigravityModels).
- Requested was always blank: executor_metadata names the model the turn
  asked for (field 10.1.28), keyed by the execution id the step's field
  20.4 carries; the call shows it as Requested, as Claude Code's do.
- The thinking tokens (usage field 9, inside the output — on the report's
  rows, field 3 == field 9 + field 10) were unread; they are Reasoning
  now, as the Usage page renders them.

The subagent tier request the report also describes (a caller's pro or
flash tier out of trajectory_metadata_blob) is not read here: its tier
to model map is another table's face, left as it was.

Run:
- go test ./internal/sessions -run TestAntigravityApp -count=1: the three
  new tests (ModelEffort, ReasoningTokens, RequestedModel) were red on
  the old code — the model/effort table's "label alone" returned
  "Gemini 4 Argon (High)" verbatim, reasoning read 0 of the report's
  176, and no executor row was read — and green with this; the older
  AppCalls/Deployment/Title/Folder tests green throughout (deployment
  names, gemini-3.8-flash-lite, and a capital -D keep their behavior).
- go test ./internal/sessions (whole, -count=1): ok.
- gofmt -l, go vet: clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/sessions/antigravity_app.go      | 164 +++++++++++++++++++---
 internal/sessions/antigravity_app_test.go | 146 ++++++++++++++++++-
 2 files changed, 291 insertions(+), 19 deletions(-)

diff --git a/internal/sessions/antigravity_app.go b/internal/sessions/antigravity_app.go
index 81726bd9b..a100a9c6d 100644
--- a/internal/sessions/antigravity_app.go
+++ b/internal/sessions/antigravity_app.go
@@ -11,6 +11,7 @@ import (
 	"strings"
 	"time"
 
+	"github.com/yetone/magpie/internal/catalog"
 	"github.com/yetone/magpie/internal/dirent"
 	"github.com/yetone/magpie/internal/provider"
 )
@@ -133,11 +134,15 @@ func antigravityCallFiles() []file { return antigravityFiles() }
 
 // agAppCall is one model call of a conversation.
 type agAppCall struct {
-	step     int64
-	at       time.Time
-	model    string
-	tokens   Tokens
-	response string
+	step      int64
+	at        time.Time
+	model     string
+	effort    string
+	requested string
+	tokens    Tokens
+	reasoning int
+	response  string
+	execution string
 }
 
 // errAgApp is a protobuf that can't be read.
@@ -158,19 +163,52 @@ func antigravityRead(path string) ([]agAppCall, error) {
 		return nil, err
 	}
 	defer tx.Rollback()
-	models := map[int64]string{}
+	models := map[int64]agGen{}
 	if rows, err := tx.Query("SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL"); err == nil {
 		for rows.Next() {
 			var idx int64
 			var b []byte
 			if rows.Scan(&idx, &b) == nil {
-				if m := agAppModel(b); m != "" {
-					models[idx] = m
+				if m, e := agAppModel(b); m != "" {
+					models[idx] = agGen{model: m, effort: e}
 				}
 			}
 		}
 		rows.Close()
 	}
+	// executor_metadata names the model each turn asked for (#6021): its
+	// field 9 is the turn's execution id, the same id the step's field
+	// 20.4 carries, and its field 10.1.28 the requested model's slug.
+	requested := map[string]string{}
+	if rows, err := tx.Query("SELECT data FROM executor_metadata WHERE data IS NOT NULL"); err == nil {
+		for rows.Next() {
+			var b []byte
+			if rows.Scan(&b) != nil {
+				continue
+			}
+			var exec, slug string
+			_ = pbWalk(b, func(num int, v uint64, d []byte) {
+				if num == 9 && d != nil {
+					exec = string(d)
+				}
+				if num == 10 && d != nil {
+					_ = pbWalk(d, func(n int, v uint64, d2 []byte) {
+						if n == 1 && d2 != nil {
+							_ = pbWalk(d2, func(n2 int, v2 uint64, d3 []byte) {
+								if n2 == 28 && d3 != nil {
+									slug = string(d3)
+								}
+							})
+						}
+					})
+				}
+			})
+			if exec != "" && slug != "" {
+				requested[exec] = slug
+			}
+		}
+		rows.Close()
+	}
 	rows, err := tx.Query("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx")
 	if err != nil {
 		return nil, err
@@ -188,7 +226,11 @@ func antigravityRead(path string) ([]agAppCall, error) {
 		if !ok {
 			continue
 		}
-		c.step, c.model = idx, models[gen]
+		c.step = idx
+		if g := models[gen]; g.model != "" {
+			c.model, c.effort = g.model, g.effort
+		}
+		c.requested = requested[c.execution]
 		if i, seen := byResponse[c.response]; seen && c.response != "" {
 			out[i] = c
 			continue
@@ -217,6 +259,8 @@ func agAppStep(b []byte) (c agAppCall, gen int64, ok bool) {
 			_ = pbWalk(d, func(n int, v uint64, d []byte) {
 				if n == 3 && d == nil {
 					gen = int64(v)
+				} else if n == 4 && d != nil {
+					c.execution = string(d)
 				}
 			})
 		}
@@ -235,6 +279,8 @@ func agAppStep(b []byte) (c agAppCall, gen int64, ok bool) {
 				c.tokens.CacheWrite = int(v)
 			case 5:
 				c.tokens.CacheRead = int(v)
+			case 9:
+				c.reasoning = int(v)
 			}
 		} else if num == 11 {
 			c.response = string(d)
@@ -245,9 +291,27 @@ func agAppStep(b []byte) (c agAppCall, gen int64, ok bool) {
 	return c, gen, true
 }
 
-// agAppModel is the model a generator's message names: its field 19, else
-// 21, else 22.
-func agAppModel(b []byte) string {
+// agGen is the model a generator names, with the thinking effort its
+// picker label or id carries.
+type agGen struct {
+	model, effort string
+}
+
+// agAppModel is the model a generator's message names, and the effort it
+// was asked for (#6021): field 19, else 21, else 22. Field 19 is the
+// served model's id, which may carry its effort as a suffix
+// (claude-opus-5-5-high, claude-opus-4-6-thinking — catalog.Unsuffixed's
+// words) or Google's serving of a base (gemini-3.8-flash-tiered,
+// gemini-4-argon-trial, which the gateway names and prices as their base,
+// collapseAntigravityModels). Field 21 is the picker's label, whose
+// parentheses hold the level ("Gemini 4 Carbon (High)") — the level rows
+// with a field 19 say nowhere else, so a bare 19 takes it from there. A
+// label with no field 19 slugs to the id form ("Gemini 4 Argon (High)" is
+// gemini-4-argon at high); a label of another maker keeps the version
+// spelling its label has, which may differ from the id's (Claude Opus 4.6
+// slugs to claude-opus-4.6, the id is claude-opus-4-6) and may then sit
+// unpriced.
+func agAppModel(b []byte) (string, string) {
 	var named [3]string
 	_ = pbWalk(b, func(num int, v uint64, d []byte) {
 		if num != 1 || d == nil {
@@ -267,15 +331,78 @@ func agAppModel(b []byte) string {
 			}
 		})
 	})
-	for _, m := range named {
-		if m != "" && len(m) <= 200 {
-			if base, ok := GeminiDeployment(m); ok {
-				return base
+	if m := named[0]; m != "" && len(m) <= 200 {
+		model, effort := agAppModelID(m)
+		if effort == "" {
+			if _, level, ok := agAppLabel(named[1]); ok {
+				effort = level
+			}
+		}
+		return model, effort
+	}
+	for _, m := range named[1:] {
+		if m == "" || len(m) > 200 {
+			continue
+		}
+		if strings.ContainsRune(m, ' ') {
+			if base, level, ok := agAppLabel(m); ok {
+				return agAppSlug(base), level
 			}
-			return m
+			return agAppSlug(m), ""
 		}
+		model, effort := agAppModelID(m)
+		return model, effort
+	}
+	return "", ""
+}
+
+// agAppModelID is m as a model id: its effort suffix taken off as the
+// effort (catalog.Unsuffixed's words), Google's -tiered and -trial
+// servings named as their base, and a deployment's lone letter off
+// (GeminiDeployment), in that order.
+func agAppModelID(m string) (string, string) {
+	if base, ok := catalog.Unsuffixed(m); ok {
+		return agAppDeployment(base), m[len(base)+1:]
+	}
+	for _, w := range []string{"-tiered", "-trial"} {
+		if b, ok := strings.CutSuffix(m, w); ok && strings.HasPrefix(b, "gemini-") {
+			return agAppDeployment(b), ""
+		}
+	}
+	return agAppDeployment(m), ""
+}
+
+// agAppDeployment is m with a deployment's lone letter off, when it is one.
+func agAppDeployment(m string) string {
+	if b, ok := GeminiDeployment(m); ok {
+		return b
 	}
-	return ""
+	return m
+}
+
+// agAppLabel is a picker label's words and the level its parentheses hold:
+// "Gemini 4 Carbon (High)" is "Gemini 4 Carbon" at high. False when m
+// carries no parenthesized level of a word's length.
+func agAppLabel(m string) (base, level string, ok bool) {
+	i := strings.LastIndex(m, " (")
+	if i < 0 || !strings.HasSuffix(m, ")") || len(m)-i < 4 {
+		return m, "", false
+	}
+	level = strings.ToLower(m[i+2 : len(m)-1])
+	for _, c := range level {
+		if c < 'a' || c > 'z' {
+			return m, "", false
+		}
+	}
+	return m[:i], level, true
+}
+
+// agAppSlug is a label's words as an id: lower case, hyphenated ("Gemini
+// 3.5 Flash" is gemini-3.5-flash). A label of the same words the id has,
+// spelled as the picker shows it; another maker's version spelling may
+// differ from its id's.
+func agAppSlug(m string) string {
+	return strings.ToLower(strings.Join(strings.Fields(m), "-"))
 }
 
 // GeminiDeployment is the Gemini model a Google deployment's name stands
@@ -399,6 +526,7 @@ func readAntigravityCalls(f file) (*callFile, bool) {
 	for _, c := range calls {
 		st.Calls = append(st.Calls, Call{
 			Agent: "antigravity", Time: c.at, Session: st.Session, Model: c.model, Tokens: c.tokens,
+			Requested: c.requested, Effort: c.effort, Reasoning: c.reasoning,
 			Msg: st.str("antigravity:" + st.Session + ":" + strconv.FormatInt(c.step, 10)),
 		})
 	}
diff --git a/internal/sessions/antigravity_app_test.go b/internal/sessions/antigravity_app_test.go
index 24be275b9..7cf795b76 100644
--- a/internal/sessions/antigravity_app_test.go
+++ b/internal/sessions/antigravity_app_test.go
@@ -210,13 +210,157 @@ func TestAntigravityAppDeploymentName(t *testing.T) {
 		"gemini-4-argon-D":      "gemini-4-argon-D",
 	} {
 		for _, field := range []int{19, 21, 22} {
-			if got := agAppModel(gen(field, in)); got != want {
+			if got, _ := agAppModel(gen(field, in)); got != want {
 				t.Errorf("field %d %q: %q, want %q", field, in, got, want)
 			}
 		}
 	}
 }
 
+// agPBVarint is a protobuf field of a varint value; agPBBytes one of bytes.
+func agPBVarint(num int, v uint64) []byte {
+	return binary.AppendUvarint(binary.AppendUvarint(nil, uint64(num)<<3), v)
+}
+
+func agPBBytes(num int, b []byte) []byte {
+	out := binary.AppendUvarint(nil, uint64(num)<<3|2)
+	out = binary.AppendUvarint(out, uint64(len(b)))
+	return append(out, b...)
+}
+
+// #6021 (YOUYUDAWANG): the generator's field 19 names the served model and
+// its effort word, and field 21 names the picker's label with the level in
+// parentheses — the level the effort column shows. A -tiered or -trial id
+// is Google's serving of the base model, as the gateway names it
+// (collapseAntigravityModels), and it prices as the base. An id whose last
+// word is an effort, or "thinking", is that model at that effort
+// (catalog.Unsuffixed's words). Without field 19 the label stands alone:
+// its parentheses still say the effort, and its words slug to the id form.
+// The literal bytes are the report's, read out of real desktop databases.
+func TestAntigravityAppModelEffort(t *testing.T) {
+	type gf struct {
+		field int
+		m     string
+	}
+	for _, c := range []struct {
+		name        string
+		gen         []gf
+		model, want string
+		effort      string
+	}{
+		{"19 and the label's level", []gf{{19, "gemini-4-carbon"}, {21, "Gemini 4 Carbon (High)"}},
+			"gemini-4-carbon", "gemini-4-carbon", "high"},
+		{"thinking id and label", []gf{{19, "claude-opus-4-6-thinking"}, {21, "Claude Opus 4.6 (Thinking)"}},
+			"claude-opus-4-6", "claude-opus-4-6", "thinking"},
+		{"tiered", []gf{{19, "gemini-3.8-flash-tiered"}},
+			"gemini-3.8-flash", "gemini-3.8-flash", ""},
+		{"trial", []gf{{19, "gemini-4-argon-trial"}},
+			"gemini-4-argon", "gemini-4-argon", ""},
+		{"label alone", []gf{{21, "Gemini 4 Argon (High)"}},
+			"gemini-4-argon", "gemini-4-argon", "high"},
+		{"label alone, no level", []gf{{21, "Gemini 3.5 Flash"}},
+			"gemini-3.5-flash", "gemini-3.5-flash", ""},
+		{"effort id alone", []gf{{19, "claude-opus-5-5-high"}},
+			"claude-opus-5-5", "claude-opus-5-5", "high"},
+		{"deployment still first", []gf{{19, "gemini-3.8-flash-n"}},
+			"gemini-3.8-flash", "gemini-3.8-flash", ""},
+		{"lite is no suffix", []gf{{19, "gemini-3.8-flash-lite"}},
+			"gemini-3.8-flash-lite", "gemini-3.8-flash-lite", ""},
+		{"a capital letter is no deployment", []gf{{19, "gemini-4-argon-D"}},
+			"gemini-4-argon-D", "gemini-4-argon-D", ""},
+	} {
+		var b []byte
+		for _, p := range c.gen {
+			inner := append(binary.AppendUvarint(nil, uint64(p.field)<<3|2), byte(len(p.m)))
+			inner = append(inner, p.m...)
+			b = append(b, append([]byte{1<<3 | 2, byte(len(inner))}, inner...)...)
+		}
+		model, effort := agAppModel(b)
+		if model != c.model || effort != c.effort {
+			t.Errorf("%s: model %q effort %q, want %q %q", c.name, model, effort, c.model, c.effort)
+		}
+	}
+}
+
+// #6021: the usage message's field 9 is the thinking tokens, inside the
+// output — the report's real row reads 176 thinking of 356 output, 26094
+// in, 16781 read from the cache.
+func TestAntigravityAppReasoningTokens(t *testing.T) {
+	usage, _ := hex.DecodeString("08930B10EECB0118E402288D8301301848B00150B401")
+	b := agPBBytes(1, agPBVarint(1, 1791860318))
+	b = append(b, agPBBytes(9, usage)...)
+	c, _, ok := agAppStep(b)
+	if !ok {
+		t.Fatal("no call")
+	}
+	if c.reasoning != 176 {
+		t.Errorf("reasoning %d, want 176 (inside the output 356)", c.reasoning)
+	}
+	if c.tokens.Input != 26094 || c.tokens.Output != 356 || c.tokens.CacheRead != 16781 {
+		t.Errorf("tokens %+v", c.tokens)
+	}
+}
+
+// #6021: executor_metadata names the model the turn asked for
+// (field 10.1.28, "gemini-4-carbon-high"), keyed by its execution id
+// (field 9), which the step's field 20.4 carries. The call shows it as
+// Requested, as Claude Code's rows show theirs.
+func TestAntigravityAppRequestedModel(t *testing.T) {
+	claude, _ := setup(t)
+	home := filepath.Join(filepath.Dir(claude), "home")
+	const id = "5e7b1c2a-3d40-4e58-8a19-6b0c9d2e3f40"
+	path := antigravityFixture(t, home, id)
+	db, err := sql.Open("sqlite", path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer db.Close()
+	gen := func(field int, m string) []byte {
+		inner := append(binary.AppendUvarint(nil, uint64(field)<<3|2), byte(len(m)))
+		inner = append(inner, m...)
+		return append([]byte{1<<3 | 2, byte(len(inner))}, inner...)
+	}
+	genData := append(gen(19, "gemini-4-carbon"), gen(21, "Gemini 4 Carbon (High)")...)
+	if _, err := db.Exec("INSERT INTO gen_metadata (idx, data, size) VALUES (10, ?, ?)", genData, len(genData)); err != nil {
+		t.Fatal(err)
+	}
+	asked := append(agPBVarint(1, 1427), agPBBytes(28, []byte("gemini-4-carbon-high"))...)
+	exRow := append(agPBVarint(3, 21), agPBBytes(9, []byte("exec-1"))...)
+	exRow = append(exRow, agPBBytes(10, agPBBytes(1, asked))...)
+	if _, err := db.Exec("INSERT INTO executor_metadata (idx, data) VALUES (0, ?)", exRow); err != nil {
+		t.Fatal(err)
+	}
+	usage, _ := hex.DecodeString("08930B10EECB0118E402288D8301301848B00150B401")
+	ts := agPBBytes(1, agPBVarint(1, 1791860400))
+	step := append(ts, agPBBytes(9, usage)...)
+	step = append(step, agPBBytes(20, append(agPBVarint(3, 10), agPBBytes(4, []byte("exec-1"))...))...)
+	if _, err := db.Exec("INSERT INTO steps (idx, step_type, metadata) VALUES (21, 15, ?)", step); err != nil {
+		t.Fatal(err)
+	}
+	calls, err := antigravityRead(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var c *agAppCall
+	for i := range calls {
+		if calls[i].step == 21 {
+			c = &calls[i]
+		}
+	}
+	if c == nil {
+		t.Fatalf("no call at step 21 in %+v", calls)
+	}
+	if c.model != "gemini-4-carbon" || c.effort != "high" {
+		t.Errorf("model %q effort %q, want gemini-4-carbon high", c.model, c.effort)
+	}
+	if c.requested != "gemini-4-carbon-high" {
+		t.Errorf("requested %q, want gemini-4-carbon-high", c.requested)
+	}
+	if c.reasoning != 176 {
+		t.Errorf("reasoning %d, want 176", c.reasoning)
+	}
+}
+
 // antigravitySummariesSchema is conversation_summaries.db as Antigravity
 // 2.29.0's language_server makes it in ~/.gemini/antigravity on its first
 // start (run in a sandbox HOME, 11-07): agy's table, in the app's folder.
-- 
2.50.1 (Apple Git-155)

```

</details>
