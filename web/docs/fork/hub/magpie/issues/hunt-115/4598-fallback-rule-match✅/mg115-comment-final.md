Diagnosed with a test on a group whose seventh rule is a fallback kind ("not any of the above") next to six topic rules — two findings, one patched.

**The matching has no defect.** With a seventh rule whose intent is the fallback text, a classifier that answers 7 routes by rule 7: `TestClassifierChoosingTheFallbackKindMatchesItsRule` (in the branch below) passes on the unchanged matching, trace saying rule 7 matched and what the classifier named.

**The trace couldn't say why nothing matched.** A classifier that picks no rule's intent leaves `n=0` for three different reasons, and the trace showed the same "said none" for all of them:

- a chat classifier answering 0, as the prompt tells it to ("Answer 0 only when the message is plainly none of the kinds") — a user-written fallback kind competes with that 0, and a classifier that means "none of the six" has no reason to pick kind 7 over 0;
- a decision model (Jev) choosing its own "none of these" option, which `jevBody` puts beside the group's kinds — again ahead of a user-written fallback kind saying the same thing;
- a decision model naming the fallback kind but under the sure-enough bar (0.4), where the answer is dropped.

Whichever it was, no rule matched, so the group's own order routed the request — which is why a turn can land on a model "no rule matched" for (your follow-up: the log was right that no rule matched, it just couldn't show what the classifier had said). The patch records the answer as the classifier said it: `classified.said` in the trace — a chat model's number ("0", "7"), or the choice a decision model named ("none of these", the fallback kind) — kept when no intent came of it, so the three cases read differently at a glance.

| Check | Result |
| --- | --- |
| `go test -tags nogui -run 'TestClassifiedSaysTheClassifiersAnswer|TestClassifiedSaysWhatJevChose|TestClassifierChoosingTheFallbackKindMatchesItsRule' ./internal/gateway` | 3 pass; without the change the two said tests fail — `the classifier said 0, the trace says ""` and `Jev chose "none of these", the trace says ""` |
| `go test -tags nogui ./internal/gateway` | pass |
| `gofmt -l internal/gateway` | prints nothing |
| `go vet ./internal/gateway`, `GOOS=linux go vet -tags nogui ./internal/gateway`, `GOOS=windows go vet ./internal/gateway` | pass |
| `go build` (darwin), `GOOS=linux go build -tags nogui`, `GOOS=windows go build` | pass |

Not verified: nothing in the Routing page's rendering changed, so its words still read "said none" — the said value is in the trace JSON each request already carries (`rule.classified.said`), and no GUI suite was run. Two things this patch deliberately leaves for you to decide, as they change what the page says rather than what routing does:

1. Have `classWhy` say the answer when it says none — e.g. append `it answered "0"` / `it chose "none of these"` / `it named "<kind>" unsure` from `c.said` when `c.said && c.said !== c.intent`.
2. A rule has no "else" condition: an intent rule matches only when the classifier's answer equals its text, and a kind that reads "not any of the above" competes with the classifier's own 0/"none of these" rather than catching their answers. Whether a fallback kind should catch those, or the rule editor should say so, is a design call — happy to work it up if you want it.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a group's trace says what its classifier said, as it said it (#4598) — git am applies it as is; SHA-256 first 16: dfaff4841816005a</summary>

```patch
From 905d9e0dd21fa873501cfbd22d78e9befb91ced2 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 20:38:16 +0800
Subject: [PATCH] gateway: a group's trace says what its classifier said, as it
 said it (#4598)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: Classified keeps the classifier's answer as it said it
(said): the number a chat model answered with, 0 for none, or the choice
a decision model named, "none of these" included. readIntent gives the
number back, readJev keeps the choice, and the trace's rule.classified
carries the said on. An answer that named no rule's intent — a chat
classifier's 0, a decision model's own none-of-the-kinds option, a kind
named under the sure-enough bar — all read "said none" in the trace
before, so a group's fallback kind ("not any of the above") that never
matched looked the same as an answer no rule could take.

The matching itself is as it was: a classifier that answers the
fallback kind's number still routes by that rule, which a test now
holds (it passes unchanged); the said is only what the trace tells.

Run: go test -tags nogui ./internal/gateway (pass; without the change
TestClassifiedSaysTheClassifiersAnswer fails "the classifier said 0,
the trace says \"\"" and TestClassifiedSaysWhatJevChose fails "Jev
chose \"none of these\", the trace says \"\""); gofmt -l prints
nothing; go vet and GOOS=linux/windows go vet on the package pass;
go build on darwin, linux (-tags nogui) and windows pass.

Fixes #4598

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/classify.go           |  21 +++--
 internal/gateway/classify_said_test.go | 107 +++++++++++++++++++++++++
 internal/gateway/classify_test.go      |   8 +-
 internal/gateway/decide.go             |   2 +
 internal/gateway/rules.go              |  21 +++--
 5 files changed, 142 insertions(+), 17 deletions(-)
 create mode 100644 internal/gateway/classify_said_test.go

diff --git a/internal/gateway/classify.go b/internal/gateway/classify.go
index 17f807fbe..c46866e18 100644
--- a/internal/gateway/classify.go
+++ b/internal/gateway/classify.go
@@ -68,7 +68,12 @@ type before struct {
 
 // verdict is what a classifier said.
 type verdict struct {
-	Intent string  // "" for none
+	Intent string // "" for none
+	// Said: the answer as it said it — a chat model's number, or the
+	// choice a decision model named — kept even when no intent came of
+	// it, so the trace tells "said none" from an answer the rules
+	// couldn't take (#4598)
+	Said   string
 	Effort string  // the reasoning the turn wants; "" when not asked
 	Score  float64 // how hard the classifier took the turn to be, from 0 (low) to 3 (xhigh)
 	Sure   float64 // how confident Jev was of the intent, from 0 to 1
@@ -387,20 +392,22 @@ func writePrior(b *strings.Builder, prev before) {
 var firstNumber = regexp.MustCompile(`\d+`)
 
 // readIntent is the intent a classifier's answer names: its first number,
-// 0 for none.
-func readIntent(answer string, intents []string) (string, error) {
+// 0 for none. The number is given back as it was said (said), so the
+// trace tells what a classifier that said none answered (#4598).
+func readIntent(answer string, intents []string) (string, string, error) {
 	n, err := strconv.Atoi(firstNumber.FindString(answer))
 	if err != nil || n < 0 || n > len(intents) {
 		a := []rune(strings.TrimSpace(answer))
 		if len(a) > 80 {
 			a = append(a[:80], '…')
 		}
-		return "", answerError{fmt.Errorf("it answered %q, not a number from 0 to %d", string(a), len(intents))}
+		return "", "", answerError{fmt.Errorf("it answered %q, not a number from 0 to %d", string(a), len(intents))}
 	}
+	said := strconv.Itoa(n)
 	if n == 0 {
-		return "", nil
+		return "", said, nil
 	}
-	return intents[n-1], nil
+	return intents[n-1], said, nil
 }
 
 // classifyEffort is the reasoning model is asked to classify at: none,
@@ -514,7 +521,7 @@ func (s *Server) askClassifierIn(wait time.Duration, model string, intents []str
 			defer wg.Done()
 			var a string
 			if a, ierr = s.askLeast(wait, model, func(effort string) []byte { return classifyBody(model, effort, intents, prev, text) }); ierr == nil {
-				v.Intent, ierr = readIntent(a, intents)
+				v.Intent, v.Said, ierr = readIntent(a, intents)
 			}
 		}()
 	}
diff --git a/internal/gateway/classify_said_test.go b/internal/gateway/classify_said_test.go
new file mode 100644
index 000000000..ea78088b6
--- /dev/null
+++ b/internal/gateway/classify_said_test.go
@@ -0,0 +1,107 @@
+package gateway
+
+// What the classifier said, as it said it (#4598): a group's trace told
+// which intent it named, and none when it named no rule's — but not the
+// answer itself, so "said none" was the same whether the classifier took
+// its own none-of-the-kinds option, named a kind it wasn't sure enough
+// of, or answered a number no rule could take. These tests read the
+// said of the trace's classified, as the page's JSON has it.
+
+import (
+	"encoding/json"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// saidOf is the said of a classified, as the trace's JSON spells it: the
+// field read here by what the field is called, so a change that drops it
+// fails these tests rather than the build.
+func saidOf(c *Classified) string {
+	b, err := json.Marshal(c)
+	if err != nil {
+		return ""
+	}
+	var m map[string]any
+	if json.Unmarshal(b, &m) != nil {
+		return ""
+	}
+	s, _ := m["said"].(string)
+	return s
+}
+
+// A group's seventh rule, an intent of its own for everything the first
+// six are not ("不属于以上任意一项"): the classifier answering 7 sends the
+// turn by it — rule 7 matches, and the trace says it did (#4598).
+func TestClassifierChoosingTheFallbackKindMatchesItsRule(t *testing.T) {
+	s, _, _, c := intented(t,
+		provider.Rule{Use: "a/small", Intent: "a quick question"},
+		provider.Rule{Use: "b/big", Intent: "writing or fixing tests"},
+		provider.Rule{Use: "a/small", Intent: "refactoring"},
+		provider.Rule{Use: "b/big", Intent: "debugging a crash"},
+		provider.Rule{Use: "a/small", Intent: "writing docs"},
+		provider.Rule{Use: "b/big", Intent: "a long migration"},
+		provider.Rule{Use: "b/big", Intent: "不属于以上任意一项"},
+	)
+	c.set("7", 0)
+	out, r := postOK(t, s, "s1", chat("hello there", nil, 0, ""))
+	if !strings.Contains(out, "from kb") || r.Rule.N != 7 || r.Rule.Use != "b/big" {
+		t.Fatalf("turn 1: %s %+v", out, r.Rule)
+	}
+	if r.Rule.Classified.Intent != "不属于以上任意一项" {
+		t.Fatalf("classified %+v", r.Rule.Classified)
+	}
+}
+
+// A chat classifier's answer is kept as the number it said: the 0 that
+// matches no rule as much as the 2 that matched one (#4598).
+func TestClassifiedSaysTheClassifiersAnswer(t *testing.T) {
+	s, _, _, c := intented(t,
+		provider.Rule{Use: "a/small", Intent: "a quick question"},
+		provider.Rule{Use: "b/big", Intent: "writing or fixing tests"},
+	)
+	c.set("0", 0)
+	_, r := postOK(t, s, "s1", chat("hello there", nil, 0, ""))
+	if r.Rule.N != 0 || r.Rule.Classified.Intent != "" {
+		t.Fatalf("said none: %+v", r.Rule.Classified)
+	}
+	if said := saidOf(r.Rule.Classified); said != "0" {
+		t.Fatalf("the classifier said 0, the trace says %q", said)
+	}
+	c.set("2", 0)
+	_, r = postOK(t, s, "s2", chat("fix the failing test please", nil, 0, ""))
+	if r.Rule.N != 2 || r.Rule.Classified.Intent != "writing or fixing tests" {
+		t.Fatalf("said 2: %+v", r.Rule.Classified)
+	}
+	if said := saidOf(r.Rule.Classified); said != "2" {
+		t.Fatalf("the classifier said 2, the trace says %q", said)
+	}
+}
+
+// Jev's choice is kept as it said it, too: "none of these" when it took
+// its own none-of-the-kinds option rather than the group's fallback kind,
+// and a kind it named without being sure enough of it — which the trace
+// said nothing of before, so the two were one and the same "none" (#4598).
+func TestClassifiedSaysWhatJevChose(t *testing.T) {
+	s, _, _, j := jevved(t, "",
+		provider.Rule{Use: "a/small", Intent: "a quick question"},
+		provider.Rule{Use: "b/big", Intent: "不属于以上任意一项"},
+	)
+	j.choice, j.sure = noIntent, 0.9
+	_, r := postOK(t, s, "s1", chat("hello there", nil, 0, ""))
+	if r.Rule.N != 0 || r.Rule.Classified.Intent != "" {
+		t.Fatalf("none of these: %+v", r.Rule.Classified)
+	}
+	if said := saidOf(r.Rule.Classified); said != noIntent {
+		t.Fatalf("Jev chose %q, the trace says %q", noIntent, said)
+	}
+	j.choice, j.sure = "不属于以上任意一项", 0.2
+	_, r = postOK(t, s, "s2", chat("something else entirely", nil, 0, ""))
+	if r.Rule.N != 0 || r.Rule.Classified.Intent != "" {
+		t.Fatalf("unsure: %+v", r.Rule.Classified)
+	}
+	if said := saidOf(r.Rule.Classified); said != "不属于以上任意一项" {
+		t.Fatalf("Jev chose the fallback kind unsure, the trace says %q", said)
+	}
+}
diff --git a/internal/gateway/classify_test.go b/internal/gateway/classify_test.go
index 537f4e53a..56038ab2a 100644
--- a/internal/gateway/classify_test.go
+++ b/internal/gateway/classify_test.go
@@ -433,12 +433,16 @@ func TestUserText(t *testing.T) {
 		t.Fatalf("%d", len(got))
 	}
 	for in, want := range map[string]string{"1": "x", "2": "y", " 0 ": "", "2\n": "y"} {
-		if got, err := readIntent(in, []string{"x", "y"}); err != nil || got != want {
+		got, said, err := readIntent(in, []string{"x", "y"})
+		if err != nil || got != want {
 			t.Fatalf("%q: %q %v", in, got, err)
 		}
+		if said != strings.TrimSpace(in) {
+			t.Fatalf("%q: said %q", in, said)
+		}
 	}
 	for _, in := range []string{"3", "-", "none", ""} {
-		if _, err := readIntent(in, []string{"x", "y"}); err == nil {
+		if _, _, err := readIntent(in, []string{"x", "y"}); err == nil {
 			t.Fatalf("%q read", in)
 		}
 	}
diff --git a/internal/gateway/decide.go b/internal/gateway/decide.go
index 26217dfde..fc6c178d8 100644
--- a/internal/gateway/decide.go
+++ b/internal/gateway/decide.go
@@ -255,6 +255,7 @@ func readJev(b []byte, intents []string, levels bool, prev before) (verdict, err
 	var v verdict
 	if a, ok := out.Answers["intent"]; ok && len(intents) > 0 && !levels {
 		v.Sure = sureOf(a.Confidence, a.Probabilities)
+		v.Said = a.Choice // as it said it, no intent come of it or not (#4598)
 		if a.Choice != noIntent && v.Sure >= jevSure {
 			v.Intent = intentNamed(intents, a.Choice)
 		}
@@ -265,6 +266,7 @@ func readJev(b []byte, intents []string, levels bool, prev before) (verdict, err
 		// (继续，再加一个基准测试 after a 复杂任务 came out 0.54 to 0.46),
 		// and a turn with none before takes the likelier
 		v.Sure = sureOf(a.Confidence, a.Probabilities)
+		v.Said = a.Choice
 		v.Intent = intentNamed(intents, a.Choice)
 		if was := intentNamed(intents, prev.Intent); v.Sure < jevSure && was != "" {
 			v.Intent = was
diff --git a/internal/gateway/rules.go b/internal/gateway/rules.go
index ad390b87c..2117b95c2 100644
--- a/internal/gateway/rules.go
+++ b/internal/gateway/rules.go
@@ -85,13 +85,18 @@ type Classified struct {
 	By      string   `json:"by"`               // the classifier model
 	Intents []string `json:"intents"`          // what it chose among
 	Intent  string   `json:"intent,omitempty"` // what it said the message is; "" for none
-	After   string   `json:"after,omitempty"`  // what it said the turn before was, which it was told
-	Effort  string   `json:"effort,omitempty"` // the reasoning it said the turn wants
-	Score   float64  `json:"score,omitempty"`  // how hard it took the turn to be, 0 (low) to 3 (xhigh)
-	Sure    float64  `json:"sure,omitempty"`   // how confident it was of the intent, 0 to 1
-	Cached  bool     `json:"cached,omitempty"` // said before, for the same message
-	Ms      int      `json:"ms,omitempty"`     // how long asking it took
-	Error   string   `json:"error,omitempty"`  // why it couldn't say: no intent matches then, unless Fallback
+	// Said: the answer as it said it — the number a chat model answered
+	// with (0 for none), or the choice a decision model named, its own
+	// "none of these" included — kept when no intent came of it, so
+	// "none" is told from an answer no rule could take (#4598)
+	Said   string  `json:"said,omitempty"`
+	After  string  `json:"after,omitempty"`  // what it said the turn before was, which it was told
+	Effort string  `json:"effort,omitempty"` // the reasoning it said the turn wants
+	Score  float64 `json:"score,omitempty"`  // how hard it took the turn to be, 0 (low) to 3 (xhigh)
+	Sure   float64 `json:"sure,omitempty"`   // how confident it was of the intent, 0 to 1
+	Cached bool    `json:"cached,omitempty"` // said before, for the same message
+	Ms     int     `json:"ms,omitempty"`     // how long asking it took
+	Error  string  `json:"error,omitempty"`  // why it couldn't say: no intent matches then, unless Fallback
 	// Fallback: "previous" when it couldn't say and the turn keeps the
 	// intent the turn before had (After), rather than none
 	Fallback string `json:"fallback,omitempty"`
@@ -313,7 +318,7 @@ func ruleFor(key string, g provider.Group, ms []provider.Member, req *Request, a
 			t0 := time.Now()
 			v, cached, err := classify(ask, g.Classifier, intents, prev, effort, text)
 			classifiedFor(g.ID, g.Classifier, err)
-			c.Intent, c.Cached, c.Ms = v.Intent, cached, int(time.Since(t0).Milliseconds())
+			c.Intent, c.Said, c.Cached, c.Ms = v.Intent, v.Said, cached, int(time.Since(t0).Milliseconds())
 			if effort {
 				c.Effort, c.Score = v.Effort, v.Score
 			}
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [fix/4598-fallback-rule-match](https://github.com/ggbdpq/magpie/tree/fix/4598-fallback-rule-match) (head `905d9e0dd21fa873501cfbd22d78e9befb91ced2`).
