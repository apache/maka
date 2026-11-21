A routing group's intent threshold is its own — intent-sure, configurable per group (#5101)

**What's wrong**

#5101 (zminds): the confidence an intent rule needs of the classifier's answer was `jevSure`, a compile-time `0.4` fixed for every group. zminds' trace of one day's traffic shows why that's too blunt: of 237 classified turns, 39 — **16.5%** — were refused at 0.4 (sure 0.153–0.395), matched no intent rule, and fell through to the group's default routing, as if the intent rules weren't there. The threshold could not be turned down for a group whose rules you trust.

**Root cause**

The 0.4 threshold is a compile-time constant in `internal/gateway/decide.go` (`jevSure`), applied inside `readJev` before the group is known, and a group's record (`provider.Group`) has no field to ask its own.

**The fix**

A group gets its own threshold, `intentSure`:

- `provider.Group.IntentSure *float64` — `nil` (the default) keeps the 0.4 groups have always asked, so nothing changes for anyone who doesn't touch it; from `0` (take the likeliest intent however unsure the classifier is) to `1` (certain). Out-of-range values are refused by `SaveGroup` and by `magpie group set`.
- `readJev` no longer decides whether an intent came of the answer: it keeps the classifier's likeliest intent as it said it (`Said`, per #4598) with `Sure`, and marks an answer of intents (`Topic`) — a message may be none of those — against an answer of levels (every message is at one of them; a torn pick keeps the turn before's level, as ever).
- The group's own sure is applied where the group is known — `ruleFor`, via the new `intentOf`: an answer unsure at the group's sure is no intent, "none of these" is never an intent at any setting, and levels and effort are as they were. The trace keeps the sure and the said either way, so the turn still tells why it went as it did.
- Set it in the group editor ("Intent sure", under the classifier), or from a terminal: `magpie group set <group> intent-sure=0.25` (empty restores the default 0.4); said in the intents doc.

Patch, `git am` applies it as is (base `upstream/main` `f44fa2ef6`):

<details><summary>patch (git am applies it as is; SHA-256 first 16: <code>c7b5be2597b78e87</code>)</summary>

```patch
From 96f8821136e59b485f6e14c90f3bd83fd7b31df6 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 18:01:05 +0800
Subject: [PATCH] gateway: a routing group's intent threshold is its own
 (intent-sure configurable)

Jev's sure of an intent an intent rule needed was jevSure, a compile-time
0.4 fixed for every group: an unsure pick matched no rule and the turn went
by the group's routing as if the intent rules weren't there (zminds #5101:
of 237 turns classified one day, 39, 16.5%, were refused at 0.4, sure
0.153 to 0.395, and fell through to the group's default routing). A group
can now ask its own sure of Jev: intentSure in the group's record, from 0,
its likeliest intent taken however unsure Jev is, to 1, certain.

readJev no longer decides whether an intent came of the answer: it keeps
Jev's likeliest intent as it said it (Said, #4598), the sure it was of it,
and Topic marking an answer of intents (a message may be none of those)
against an answer of levels (every message is at one, the torn keeping the
level of the turn before). The group's own sure is applied where the group
is known, ruleFor (intentOf): an answer unsure at its sure is no intent,
"none of these" never one at any setting, and levels and effort are as
they were. The trace keeps the sure and the said either way, so the turn
still tells why it went as it did.

Set in the group editor (Intent sure, under the classifier), from a
terminal (magpie group set <group> intent-sure=0.25; empty for the 0.4
groups have always asked), said in the intents doc; a sure out of 0 to 1
is refused (SaveGroup, groups_cli).

Fixes #5101
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/groups_cli.go                    |  23 ++-
 internal/gateway/classify.go                  |   8 +-
 internal/gateway/decide.go                    |  44 +++++-
 internal/gateway/decide_intentsure_test.go    | 145 ++++++++++++++++++
 internal/gateway/decide_test.go               |  22 ++-
 internal/gateway/rules.go                     |   1 +
 internal/gui/assets/i18n.js                   |  24 +++
 internal/gui/assets/plugins/routing/client.js |  36 ++++-
 internal/provider/group.go                    |   9 ++
 site/public/docs/intent.html                  |   4 +-
 10 files changed, 299 insertions(+), 17 deletions(-)
 create mode 100644 internal/gateway/decide_intentsure_test.go

diff --git a/internal/cli/groups_cli.go b/internal/cli/groups_cli.go
index 739d681c6..8f2fd925f 100644
--- a/internal/cli/groups_cli.go
+++ b/internal/cli/groups_cli.go
@@ -34,6 +34,9 @@ const groupUsage = `usage:
                                           it is in follow; an agent set to the old id needs setting again),
                                           effort=auto (the classifier picks each turn's reasoning; needs classifier=),
                                           effort=agent (the agent's again), classifier=<provider/model>|group/<id>,
+                                          intent-sure=<0…1> (how sure the classifier must be of an intent for it
+                                          to count; 0 takes its likeliest however unsure, "none of these" never
+                                          counting; empty is the 0.4 groups have always asked),
                                           pick=<model> (routing=manual, every request to that one of its models),
                                           fast=<m1>[,m2…] (the models sent in their vendor's fast mode; empty for none),
                                           weight=<m1>=<n>[,m2=<n>…] (each model's share under routing=weight,
@@ -524,6 +527,21 @@ func applyGroupPairs(g *provider.Group, pairs []string, resolve func(string) (st
 			}
 		case "classifier", "classify":
 			g.Classifier = strings.TrimPrefix(strings.TrimSpace(v), "magpie/")
+		case "intent-sure", "intentsure":
+			// how sure the classifier must be of an intent for it to count
+			// (#5101): 0 takes its likeliest however unsure, "none of
+			// these" never counting; empty is 0.4 as groups have always
+			// asked
+			if strings.TrimSpace(v) == "" {
+				g.IntentSure = nil
+				break
+			}
+			sure, perr := strconv.ParseFloat(strings.TrimSpace(v), 64)
+			if perr != nil || sure < 0 || sure > 1 {
+				err = fmt.Errorf("intent-sure is from 0 to 1, as intent-sure=0.25 (empty is the 0.4 groups have always asked), not %q", v)
+				break
+			}
+			g.IntentSure = &sure
 		case "fast":
 			// the members sent in their vendor's fast mode, as they are in
 			// the group
@@ -567,7 +585,7 @@ func applyGroupPairs(g *provider.Group, pairs []string, resolve func(string) (st
 			g.Pick, err = pickMember(g.Members, v)
 			g.Routing = provider.Manual
 		default:
-			return fmt.Errorf("unknown field %q (fields: name, models, models+, models-, routing, pick, stays, context, levels, family, effort, classifier, fast, weight, listed; magpie group help)", k)
+			return fmt.Errorf("unknown field %q (fields: name, models, models+, models-, routing, pick, stays, context, levels, family, effort, classifier, intent-sure, fast, weight, listed; magpie group help)", k)
 		}
 		if err != nil {
 			return err
@@ -1231,6 +1249,9 @@ func showGroup(g provider.Group) error {
 		}
 		kv("classifier", g.Classifier+muted.Render(what))
 	}
+	if g.IntentSure != nil {
+		kv("intent-sure", fmt.Sprintf("%g", *g.IntentSure)+muted.Render("  how sure the classifier must be of an intent for it to count; 0 takes its likeliest"))
+	}
 	if u := groupUses()[g.ID]; len(u) > 0 {
 		kv("used by", green.Render(strings.Join(u, ", ")))
 	}
diff --git a/internal/gateway/classify.go b/internal/gateway/classify.go
index c46866e18..b1937d458 100644
--- a/internal/gateway/classify.go
+++ b/internal/gateway/classify.go
@@ -73,7 +73,13 @@ type verdict struct {
 	// choice a decision model named — kept even when no intent came of
 	// it, so the trace tells "said none" from an answer the rules
 	// couldn't take (#4598)
-	Said   string
+	Said string
+	// Topic: the answer is of topics a message may be none of (a decision
+	// model's intent answer), not levels every message is at. Jev's
+	// likeliest intent is kept in Intent as it said it, and the group's
+	// own sure of it applied where it is known (intentOf): a chat model's
+	// answer is already the one of it that counts.
+	Topic  bool
 	Effort string  // the reasoning the turn wants; "" when not asked
 	Score  float64 // how hard the classifier took the turn to be, from 0 (low) to 3 (xhigh)
 	Sure   float64 // how confident Jev was of the intent, from 0 to 1
diff --git a/internal/gateway/decide.go b/internal/gateway/decide.go
index 7d95ce39b..432dd06b1 100644
--- a/internal/gateway/decide.go
+++ b/internal/gateway/decide.go
@@ -29,10 +29,11 @@ import (
 	"github.com/yetone/magpie/internal/usage"
 )
 
-// jevSure is how confident Jev must be of an intent for it to count.
-// Confidence runs from 0, every option as likely, to 1, one certain, as
-// System One gives it (provider.Confidence), read from the answer's
-// probabilities wherever it has them (sureOf).
+// jevSure is how confident Jev must be of an intent for it to count, a
+// group setting its own (provider.Group.IntentSure). Confidence runs from
+// 0, every option as likely, to 1, one certain, as System One gives it
+// (provider.Confidence), read from the answer's probabilities wherever it
+// has them (sureOf).
 const jevSure = 0.4
 
 // sureOf is how sure an answer is of its choice on jevSure's scale: from
@@ -234,7 +235,13 @@ func effortAsk(prev before) string {
 }
 
 // readJev is the verdict in a System One reply to jevBody, the answer
-// without "none of these" counting when the intents are levels.
+// without "none of these" counting when the intents are levels. The sure
+// an intent needs is the group's own (rulesOf applies it): Jev's likeliest
+// intent is kept as it said it (Said), and the intents' own answer as Said
+// with Topic marking it a topic — a message may be none of those — rather
+// than a level every message is at, whose torn pick holds (the level half
+// below). Whether an intent came of it is decided where the group's own
+// sure is known, so the answer still tells why it went as it did.
 func readJev(b []byte, intents []string, levels bool, prev before) (verdict, error) {
 	var out struct {
 		Model   string `json:"model"`
@@ -256,7 +263,8 @@ func readJev(b []byte, intents []string, levels bool, prev before) (verdict, err
 	if a, ok := out.Answers["intent"]; ok && len(intents) > 0 && !levels {
 		v.Sure = sureOf(a.Confidence, a.Probabilities)
 		v.Said = a.Choice // as it said it, no intent come of it or not (#4598)
-		if a.Choice != noIntent && v.Sure >= jevSure {
+		v.Topic = true
+		if a.Choice != noIntent {
 			v.Intent = intentNamed(intents, a.Choice)
 		}
 	}
@@ -280,6 +288,30 @@ func readJev(b []byte, intents []string, levels bool, prev before) (verdict, err
 	return v, nil
 }
 
+// sureNeeded is how sure a group asks its classifier to be of an intent:
+// the group's own (IntentSure), or 0.4 as groups have always asked.
+func sureNeeded(g provider.Group) float64 {
+	if g.IntentSure != nil {
+		return *g.IntentSure
+	}
+	return jevSure
+}
+
+// intentOf v is the intent of v's answer at the group's own sure
+// (sureNeeded): a topic answer counts once Jev is sure enough of it —
+// "none of these", said or picked, never being an intent — while a level
+// is the level it said, every message being at one. A topic answer unsure
+// at the group's sure is no intent.
+func intentOf(v verdict, g provider.Group) string {
+	if !v.Topic {
+		return v.Intent
+	}
+	if v.Sure < sureNeeded(g) || v.Said == noIntent || v.Intent == "" {
+		return ""
+	}
+	return v.Intent
+}
+
 // intentNamed is the one of intents named, or "".
 func intentNamed(intents []string, name string) string {
 	for _, in := range intents {
diff --git a/internal/gateway/decide_intentsure_test.go b/internal/gateway/decide_intentsure_test.go
new file mode 100644
index 000000000..508853698
--- /dev/null
+++ b/internal/gateway/decide_intentsure_test.go
@@ -0,0 +1,145 @@
+package gateway
+
+import (
+	"fmt"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// #5101: the confidence an intent needs of Jev was fixed at 0.4 for every
+// group. A group may set its own (IntentSure): lower it and Jev's unsure
+// picks count, raise it and fewer do, set it to 0 and every pick but
+// "none of these" counts.
+
+// chatFor is chat for the group named, not group/r.
+func chatFor(group, first string, extra string) string {
+	if extra != "" {
+		extra = "," + extra
+	}
+	return fmt.Sprintf(`{"model":%s%s,"messages":[{"role":"user","content":%s}]}`, quote(group), extra, quote(first))
+}
+
+// ptrSure is the group's IntentSure as a test names it.
+func ptrSure(sure float64) *float64 { return &sure }
+
+// sure 0.3 misses a group's intent rule at the default 0.4, hits it with
+// IntentSure 0.25, and counts again at 0.4 once the field is gone.
+func TestGroupIntentSureThreshold(t *testing.T) {
+	s, _, _, j := jevved(t, "", provider.Rule{Use: "b/big", Intent: "debugging"})
+	j.choice, j.sure = "debugging", 0.3
+	_, r := postOK(t, s, "d0", chat("why does this crash?", nil, 0, ""))
+	if r.Rule.N != 0 || r.Rule.Classified.Intent != "" || r.Rule.Classified.Sure != 0.3 {
+		t.Fatalf("default 0.4: %+v", r.Rule.Classified)
+	}
+	// a torn pick stays none at 0.4 but matches at 0.25
+	g, _, _ := provider.FindGroup("group/r")
+	sure := 0.25
+	g.IntentSure = &sure
+	if err := provider.SaveGroup(g); err != nil {
+		t.Fatal(err)
+	}
+	_, r = postOK(t, s, "d1", chat("why does this crash, again?", nil, 0, ""))
+	if r.Rule.N != 1 || r.Rule.Classified.Intent != "debugging" || r.Rule.Classified.Sure != 0.3 {
+		t.Fatalf("0.25: %+v", r.Rule.Classified)
+	}
+	// the trace keeps the sure and the said with it, whichever way the
+	// threshold went
+	if r.Rule.Classified.Said != "debugging" {
+		t.Fatalf("said: %+v", r.Rule.Classified)
+	}
+	// unset: 0.4 again
+	g.IntentSure = nil
+	if err := provider.SaveGroup(g); err != nil {
+		t.Fatal(err)
+	}
+	_, r = postOK(t, s, "d2", chat("why does this crash, still?", nil, 0, ""))
+	if r.Rule.N != 0 || r.Rule.Classified.Intent != "" {
+		t.Fatalf("unset: %+v", r.Rule.Classified)
+	}
+}
+
+// IntentSure 0 takes Jev's pick whatever its sure, "none of these" still
+// not an intent; the effort is picked as ever.
+func TestGroupIntentSureZeroTakesTheArgmax(t *testing.T) {
+	s, _, _, j := jevved(t, provider.EffortAuto, provider.Rule{Use: "b/big", Intent: "debugging"})
+	j.choice, j.sure = "debugging", 0.01
+	g, _, _ := provider.FindGroup("group/r")
+	zero := 0.0
+	g.IntentSure = &zero
+	if err := provider.SaveGroup(g); err != nil {
+		t.Fatal(err)
+	}
+	out, r := postOK(t, s, "z1", chat("why does this crash?", nil, 0, `,"reasoning_effort":"low"`))
+	if !strings.Contains(out, "from kb") || r.Rule.N != 1 || r.Rule.Classified.Intent != "debugging" || r.Rule.Classified.Sure != 0.01 {
+		t.Fatalf("zero: %s %+v", out, r.Rule.Classified)
+	}
+	// none of these is no intent, not even at 0
+	j.choice = noIntent
+	_, r = postOK(t, s, "z2", chat("what now?", nil, 0, `,"reasoning_effort":"low"`))
+	if r.Rule.N != 0 || r.Rule.Classified.Intent != "" || r.Rule.Classified.Said != noIntent {
+		t.Fatalf("none of these at 0: %+v", r.Rule.Classified)
+	}
+	if r.Rule.Classified.Effort == "" {
+		t.Fatalf("effort not asked: %+v", r.Rule.Classified)
+	}
+}
+
+// A group's IntentSure is of the group's own: another group classifying
+// with the same classifier keeps the default 0.4.
+func TestGroupIntentSureIsPerGroup(t *testing.T) {
+	s, _, _, j := jevved(t, "", provider.Rule{Use: "b/big", Intent: "debugging"})
+	j.choice, j.sure = "debugging", 0.3
+	g, _, _ := provider.FindGroup("group/r")
+	sure := 0.25
+	g.IntentSure = &sure
+	if err := provider.SaveGroup(g); err != nil {
+		t.Fatal(err)
+	}
+	other := provider.Group{ID: "other", Name: "Other", Members: []string{"a/small", "b/big"}, Routing: provider.Rotate, Classifier: "ts/jev-latest",
+		Rules: []provider.Rule{{Use: "a/small", Intent: "debugging"}}}
+	if err := provider.SaveGroup(other); err != nil {
+		t.Fatal(err)
+	}
+	out, r := postOK(t, s, "p1", chatFor("group/other", "why does this crash?", ""))
+	if !strings.Contains(out, "from ka") || r.Rule.N != 0 || r.Rule.Classified.Intent != "" {
+		t.Fatalf("other group at 0.4: %s %+v", out, r.Rule.Classified)
+	}
+	out, r = postOK(t, s, "p2", chat("why does this crash, again?", nil, 0, ""))
+	if !strings.Contains(out, "from kb") || r.Rule.N != 1 || r.Rule.Classified.Intent != "debugging" {
+		t.Fatalf("ruled group at 0.25: %s %+v", out, r.Rule.Classified)
+	}
+}
+
+// The group's IntentSure out of range is refused, 0 through 1 kept.
+func TestGroupIntentSureRange(t *testing.T) {
+	for _, x := range []float64{-0.1, 1.1} {
+		g := provider.Group{ID: "bad", Name: "Bad", Members: []string{"a/small", "b/big"}, Classifier: "c/cls",
+			Rules: []provider.Rule{{Use: "a/small", Intent: "debugging"}}}
+		sure := x
+		g.IntentSure = &sure
+		if err := provider.SaveGroup(g); err == nil {
+			t.Fatalf("%v saved", x)
+		}
+	}
+}
+
+// Levels are another scale (every message at one of them): the torn keep
+// the turn before's level, IntentSure or no IntentSure (#5101 leaves them
+// as they are).
+func TestGroupIntentSureLeavesLevels(t *testing.T) {
+	s, _, _, j := jevved(t, provider.EffortAuto, provider.Rule{Use: "a/small", Intent: "简单任务"}, provider.Rule{Use: "b/big", Intent: "复杂任务"})
+	j.levels, j.sure = 0.9, 0.09
+	g, _, _ := provider.FindGroup("group/r")
+	sure := 0.0
+	g.IntentSure = &sure
+	if err := provider.SaveGroup(g); err != nil {
+		t.Fatal(err)
+	}
+	// torn over the level, the turn before's is kept, as ever
+	_, r := postOK(t, s, "l1", chat("写个纸牌游戏", nil, 0, ""))
+	if r.Rule.N != 0 || r.Rule.Classified.Intent != "" || r.Rule.Classified.Sure != 0.09 {
+		t.Fatalf("torn level, none before: %+v", r.Rule.Classified)
+	}
+}
diff --git a/internal/gateway/decide_test.go b/internal/gateway/decide_test.go
index 4f0dfac3c..50efa8a80 100644
--- a/internal/gateway/decide_test.go
+++ b/internal/gateway/decide_test.go
@@ -606,14 +606,28 @@ func TestJevTornLevel(t *testing.T) {
 	if v, _ := readJev(sure, in, true, before{Intent: "复杂任务"}); v.Intent != "简单任务" {
 		t.Fatalf("sure: %+v", v)
 	}
-	// topics still need Jev sure, and may be none
-	if v, _ := readJev(b, in, false, before{Intent: "复杂任务"}); v.Intent != "复杂任务" {
-		t.Fatalf("topic sure enough: %+v", v)
+	// topics: the sure needed is the group's own now (#5101), readJev
+	// keeping Jev's pick and saying how sure it was — intentOf applies the
+	// group's own at the group
+	if v, _ := readJev(b, in, false, before{Intent: "复杂任务"}); v.Intent != "复杂任务" || v.Sure != 0.43 || !v.Topic {
+		t.Fatalf("topic: %+v", v)
 	}
 	unsure := []byte(`{"answers":{"intent":{"type":"choice","choice":"复杂任务","confidence":0.2}}}`)
-	if v, _ := readJev(unsure, in, false, before{Intent: "复杂任务"}); v.Intent != "" {
+	if v, _ := readJev(unsure, in, false, before{Intent: "复杂任务"}); v.Intent != "复杂任务" || v.Sure != 0.2 {
 		t.Fatalf("topic unsure: %+v", v)
 	}
+	// a group's own sure: the default 0.4 keeps an unsure pick from
+	// matching, 0.25 lets a surer one, "none of these" never counts
+	g0 := provider.Group{}
+	if got := intentOf(verdict{Topic: true, Intent: "复杂任务", Said: "复杂任务", Sure: 0.2}, g0); got != "" {
+		t.Fatalf("default 0.4: %+v", got)
+	}
+	if got := intentOf(verdict{Topic: true, Intent: "复杂任务", Said: "复杂任务", Sure: 0.3}, provider.Group{IntentSure: ptrSure(0.25)}); got != "复杂任务" {
+		t.Fatalf("0.25: %+v", got)
+	}
+	if got := intentOf(verdict{Topic: true, Intent: "", Said: noIntent, Sure: 0.9}, provider.Group{IntentSure: ptrSure(0)}); got != "" {
+		t.Fatalf("none of these at 0: %+v", got)
+	}
 }
 
 // jevAt is ruled's group with the Jev a decision API at decide serves as
diff --git a/internal/gateway/rules.go b/internal/gateway/rules.go
index e010df2c9..2cd98221f 100644
--- a/internal/gateway/rules.go
+++ b/internal/gateway/rules.go
@@ -337,6 +337,7 @@ func ruleFor(key string, g provider.Group, ms []provider.Member, req *Request, a
 			t0 := time.Now()
 			v, cached, err := classify(ask, g.Classifier, intents, prev, effort, text)
 			classifiedFor(g.ID, g.Classifier, err)
+			v.Intent = intentOf(v, g) // the group's own sure of an intent (#5101)
 			c.Intent, c.Said, c.Cached, c.Ms = v.Intent, v.Said, cached, int(time.Since(t0).Milliseconds())
 			if effort {
 				c.Effort, c.Score = v.Effort, v.Score
diff --git a/internal/gui/assets/i18n.js b/internal/gui/assets/i18n.js
index 0052fc5a2..85d0e2136 100644
--- a/internal/gui/assets/i18n.js
+++ b/internal/gui/assets/i18n.js
@@ -3683,6 +3683,12 @@ const I18N = {
     "4 min": "4 分钟",
     "e.g. 200k": "如 200k",
     "e.g. 5": "如 5",
+    "e.g. 0.25": "如 0.25",
+    "Intent sure": "意图把握",
+    "An intent Jev names counts when it is 40% sure of it; empty keeps that. 0 takes its likeliest however unsure it is — “none of these” never counting — and 1 wants it certain.": "Jev 说出意图时把握到 40% 才算数；留空保持 40%。0 表示无论多低都取它最可能的意图（“都不是”除外），1 则要求十拿九稳。",
+    "Jev's likeliest intent counts however unsure it is; “none of these” still matches no rule.": "无论把握多低都取 Jev 最可能的意图；“都不是”仍然不命中任何规则。",
+    "An intent Jev names counts when it is {n}% sure of it. 0 would take its likeliest however unsure it is, and empty the 40% kept before.": "Jev 说出意图时把握到 {n}% 才算数。0 表示无论多低都取它最可能的意图，留空则保持原来的 40%。",
+    "{v} is not a sureness from 0 to 1": "{v} 不是 0 到 1 之间的把握值",
     "Minutes": "分钟数",
     "min": "分钟",
     "slow to start": "迟迟未开始",
@@ -8247,6 +8253,12 @@ const I18N = {
     "4 min": "4 分鐘",
     "e.g. 200k": "如 200k",
     "e.g. 5": "如 5",
+    "e.g. 0.25": "如 0.25",
+    "Intent sure": "意圖把握",
+    "An intent Jev names counts when it is 40% sure of it; empty keeps that. 0 takes its likeliest however unsure it is — “none of these” never counting — and 1 wants it certain.": "Jev 說出意圖時把握到 40% 才算數；留空保持 40%。0 表示無論多低都取它最可能的意圖（「都不是」除外），1 則要求十拿九穩。",
+    "Jev's likeliest intent counts however unsure it is; “none of these” still matches no rule.": "無論把握多低都取 Jev 最可能的意圖；「都不是」仍然不命中任何規則。",
+    "An intent Jev names counts when it is {n}% sure of it. 0 would take its likeliest however unsure it is, and empty the 40% kept before.": "Jev 說出意圖時把握到 {n}% 才算數。0 表示無論多低都取它最可能的意圖，留空則保持原來的 40%。",
+    "{v} is not a sureness from 0 to 1": "{v} 不是 0 到 1 之間的把握值",
     "Minutes": "分鐘數",
     "min": "分鐘",
     "slow to start": "遲遲未開始",
@@ -12824,6 +12836,12 @@ const I18N = {
     "4 min": "4 分",
     "e.g. 200k": "例: 200k",
     "e.g. 5": "例: 5",
+    "e.g. 0.25": "例: 0.25",
+    "Intent sure": "判定の確かさ",
+    "An intent Jev names counts when it is 40% sure of it; empty keeps that. 0 takes its likeliest however unsure it is — “none of these” never counting — and 1 wants it certain.": "Jev が挙げた意図は 40% 確かなら採用されます。空欄なら 40% のまま。0 ならどれだけ低くとも最有力の意図を採用し（「いずれでもない」は除く）、1 は確実なときだけ採用します。",
+    "Jev's likeliest intent counts however unsure it is; “none of these” still matches no rule.": "確かさが低くとも Jev の最有力の意図を採用します。「いずれでもない」はどのルールにも一致しません。",
+    "An intent Jev names counts when it is {n}% sure of it. 0 would take its likeliest however unsure it is, and empty the 40% kept before.": "Jev が挙げた意図は {n}% 確かなら採用されます。0 ならどれだけ低くとも最有力を採用し、空欄なら従来の 40% のままです。",
+    "{v} is not a sureness from 0 to 1": "{v} は 0 から 1 の確かさの値ではありません",
     "Minutes": "分",
     "min": "分",
     "slow to start": "応答開始が遅い",
@@ -17412,6 +17430,12 @@ const I18N = {
     "4 min": "4 Min.",
     "e.g. 200k": "z. B. 200k",
     "e.g. 5": "z. B. 5",
+    "e.g. 0.25": "z. B. 0,25",
+    "Intent sure": "Sicherheit der Absicht",
+    "An intent Jev names counts when it is 40% sure of it; empty keeps that. 0 takes its likeliest however unsure it is — “none of these” never counting — and 1 wants it certain.": "Eine von Jev genannte Absicht zählt, wenn sie sich zu 40% sicher ist; leer lässt das so. 0 nimmt jeweils die wahrscheinlichste, so unsicher auch — „none of these“ zählt nie —, 1 verlangt Gewissheit.",
+    "Jev's likeliest intent counts however unsure it is; “none of these” still matches no rule.": "Die wahrscheinlichste Absicht zählt, so unsicher Jev auch ist; „none of these“ trifft weiter keine Regel.",
+    "An intent Jev names counts when it is {n}% sure of it. 0 would take its likeliest however unsure it is, and empty the 40% kept before.": "Eine von Jev genannte Absicht zählt, wenn sie sich zu {n}% sicher ist. 0 nähme jeweils die wahrscheinlichste, leer ließe die bisherigen 40%.",
+    "{v} is not a sureness from 0 to 1": "{v} ist keine Sicherheit von 0 bis 1",
     "Minutes": "Minuten",
     "min": "Min.",
     "slow to start": "langsamer Start",
diff --git a/internal/gui/assets/plugins/routing/client.js b/internal/gui/assets/plugins/routing/client.js
index b488a4f81..d10fddb96 100644
--- a/internal/gui/assets/plugins/routing/client.js
+++ b/internal/gui/assets/plugins/routing/client.js
@@ -5623,7 +5623,7 @@ function routingPage(part) {
   // there, rather than leaving the slot empty.
   const openGroupEditor = async (g) => {
     if (groupDirty() && !(await confirmDiscard())) return false;
-    gEdit = { id: g.id, draft: { name: g.name, members: [...g.members], match: [...(g.match || [])], matched: [...(g.matched || [])], fast: [...(g.fast || [])], off: [...(g.off || [])], weights: { ...(g.weights || {}) }, accounts: [...(g.accounts || [])], routing: g.routing || "", pick: g.pick || "", affinity: g.affinity || "", sink: !!g.sink, unlists: !!g.unlists, firstToken: g.firstToken || 0, patience: patienceOf(g.patience), context: g.context || 0, classifier: g.classifier || "", effort: g.effort || "", levels: [...(g.levels || [])], rules: (g.rules || []).map((r) => ({ ...r, ...(r.more?.length ? { more: [...r.more] } : {}), intent: r.intent || "", agents: [...(r.agents || [])], folders: [...(r.folders || [])], exceptFolders: [...(r.exceptFolders || [])], time: r.time ? { ...r.time, days: [...(r.time.days || [])] } : null })) } };
+    gEdit = { id: g.id, draft: { name: g.name, members: [...g.members], match: [...(g.match || [])], matched: [...(g.matched || [])], fast: [...(g.fast || [])], off: [...(g.off || [])], weights: { ...(g.weights || {}) }, accounts: [...(g.accounts || [])], routing: g.routing || "", pick: g.pick || "", affinity: g.affinity || "", sink: !!g.sink, unlists: !!g.unlists, firstToken: g.firstToken || 0, patience: patienceOf(g.patience), context: g.context || 0, classifier: g.classifier || "", intentSure: g.intentSure ?? null, effort: g.effort || "", levels: [...(g.levels || [])], rules: (g.rules || []).map((r) => ({ ...r, ...(r.more?.length ? { more: [...r.more] } : {}), intent: r.intent || "", agents: [...(r.agents || [])], folders: [...(r.folders || [])], exceptFolders: [...(r.exceptFolders || [])], time: r.time ? { ...r.time, days: [...(r.time.days || [])] } : null })) } };
     renderGroups();
     return true;
   };
@@ -6368,7 +6368,7 @@ function routingPage(part) {
         closeProtoMenu();
         if (v === cur || (groupDirty() && !(await confirmDiscard()))) return b.focus({ preventScroll: true });
         const n = opts.find(([id]) => id === v)?.[1] || v;
-        await groupAction("save", { id: g.id, name: g.name, members: namedOf(g), match: g.match || [], routing: v, pick: g.pick || "", affinity: g.affinity || "", sink: !!g.sink && sinkable(v), firstToken: g.firstToken || 0, patience: g.patience || 0, rules: g.rules || [], effort: g.effort || "", classifier: g.classifier || "", context: g.context || 0, levels: g.levels || [], family: g.family || "", fast: g.fast || [], off: g.off || [], weights: g.weights || {}, accounts: g.accounts || [], unlists: !!g.unlists },
+        await groupAction("save", { id: g.id, name: g.name, members: namedOf(g), match: g.match || [], routing: v, pick: g.pick || "", affinity: g.affinity || "", sink: !!g.sink && sinkable(v), firstToken: g.firstToken || 0, patience: g.patience || 0, rules: g.rules || [], effort: g.effort || "", classifier: g.classifier || "", intentSure: g.intentSure ?? null, context: g.context || 0, levels: g.levels || [], family: g.family || "", fast: g.fast || [], off: g.off || [], weights: g.weights || {}, accounts: g.accounts || [], unlists: !!g.unlists },
           t("{name}: {routing}", { name: g.name, routing: t(n) }));
         // the rows were drawn anew: the keyboard stays on this one's routing
         gList.querySelector(`.rt-group[data-id="${CSS.escape(g.id)}"] .rt-groute`)?.focus({ preventScroll: true });
@@ -6501,7 +6501,7 @@ function routingPage(part) {
       b.onclick = (e) => {
         e.stopPropagation(); // the card opens the editor; this picks
         if (on) return;
-        groupAction("save", { id: g.id, name: g.name, members: namedOf(g), match: g.match || [], routing: "manual", pick: id, affinity: g.affinity || "", sink: !!g.sink, firstToken: g.firstToken || 0, patience: g.patience || 0, rules: g.rules || [], effort: g.effort || "", classifier: g.classifier || "", context: g.context || 0, levels: g.levels || [], family: g.family || "", fast: g.fast || [], off: g.off || [], weights: g.weights || {}, accounts: g.accounts || [], unlists: !!g.unlists },
+        groupAction("save", { id: g.id, name: g.name, members: namedOf(g), match: g.match || [], routing: "manual", pick: id, affinity: g.affinity || "", sink: !!g.sink, firstToken: g.firstToken || 0, patience: g.patience || 0, rules: g.rules || [], effort: g.effort || "", classifier: g.classifier || "", intentSure: g.intentSure ?? null, context: g.context || 0, levels: g.levels || [], family: g.family || "", fast: g.fast || [], off: g.off || [], weights: g.weights || {}, accounts: g.accounts || [], unlists: !!g.unlists },
           t("{name}: every request to {model}", { name: g.name, model: memberName(id) }));
       };
       box.append(b);
@@ -7687,6 +7687,34 @@ function routingPage(part) {
         more.onclick = addIntentRule;
         cls.append(more);
       }
+      // how sure the classifier must be of an intent for it to count
+      // (#5101), Jev's own asking scale: 0 takes its likeliest however
+      // unsure it is, "none of these" never counting
+      const sureRow = el("div", "rt-pickrow");
+      const sureIn = keys(input(d.intentSure == null ? "" : String(d.intentSure), t("e.g. 0.25")));
+      sureIn.inputMode = "decimal";
+      sureIn.setAttribute("aria-label", t("Intent sure"));
+      let sureErr = "";
+      const sureHint = el("div", "hint");
+      const drawSure = () => {
+        sureIn.setAttribute("aria-invalid", String(!!sureErr));
+        sureHint.textContent = sureErr || (d.intentSure == null
+          ? t("An intent Jev names counts when it is 40% sure of it; empty keeps that. 0 takes its likeliest however unsure it is — “none of these” never counting — and 1 wants it certain.")
+          : d.intentSure === 0
+          ? t("Jev's likeliest intent counts however unsure it is; “none of these” still matches no rule.")
+          : t("An intent Jev names counts when it is {n}% sure of it. 0 would take its likeliest however unsure it is, and empty the 40% kept before.", { n: Math.round(d.intentSure * 100) }));
+      };
+      sureIn.oninput = () => {
+        const v = sureIn.value.trim().replace(",", ".");
+        sureErr = "";
+        if (v === "") d.intentSure = null;
+        else if (/^\d+(?:\.\d+)?$/.test(v) && +v >= 0 && +v <= 1) d.intentSure = +v;
+        else sureErr = t("{v} is not a sureness from 0 to 1", { v: sureIn.value.trim() });
+        drawSure();
+      };
+      sureRow.append(sureIn, sureHint);
+      cls.append(sureRow);
+      drawSure();
     };
     rbox.append(rlist, rAdds);
     const rw2 = el("div");
@@ -7792,7 +7820,7 @@ function routingPage(part) {
       if (own && !d.levels.length) return status(t("Pick a level to offer, or leave them to its models"), "warn");
       saveBtn.classList.add("busy");
       // refused, Add can be pressed again (busy, it takes no clicks)
-      groupAction("save", { id: idOf(), from: g?.id, name: d.name.trim() || idOf(), members: namedOf(d), placed: d.members, match: d.match, routing: d.routing, pick: d.pick || "", affinity: d.affinity, sink: !!d.sink && sinkable(d.routing), firstToken: d.firstToken || 0, patience: d.patience || 0, rules: d.rules, effort: d.effort, classifier: d.rules.some((r) => r.intent) || d.effort === "auto" ? d.classifier : "", context: d.context || 0, levels: own ? d.levels : [], family: g?.family || "", fast: d.fast.filter((x) => d.members.includes(x)), off: d.off.filter((x) => d.members.includes(x)), weights: Object.fromEntries(Object.entries(d.weights).filter(([x, n]) => d.members.includes(x) && n > 1)), accounts: d.accounts.filter((a) => accountPids().includes(a.slice(0, a.indexOf("/")))), unlists: !!d.unlists }, t(g ? "{name} saved" : "{name} added", { name: d.name.trim() || idOf() }))
+      groupAction("save", { id: idOf(), from: g?.id, name: d.name.trim() || idOf(), members: namedOf(d), placed: d.members, match: d.match, routing: d.routing, pick: d.pick || "", affinity: d.affinity, sink: !!d.sink && sinkable(d.routing), firstToken: d.firstToken || 0, patience: d.patience || 0, rules: d.rules, effort: d.effort, classifier: d.rules.some((r) => r.intent) || d.effort === "auto" ? d.classifier : "", intentSure: d.rules.some((r) => r.intent) ? d.intentSure ?? null : null, context: d.context || 0, levels: own ? d.levels : [], family: g?.family || "", fast: d.fast.filter((x) => d.members.includes(x)), off: d.off.filter((x) => d.members.includes(x)), weights: Object.fromEntries(Object.entries(d.weights).filter(([x, n]) => d.members.includes(x) && n > 1)), accounts: d.accounts.filter((a) => accountPids().includes(a.slice(0, a.indexOf("/")))), unlists: !!d.unlists }, t(g ? "{name} saved" : "{name} added", { name: d.name.trim() || idOf() }))
         .then(() => saveBtn.classList.remove("busy"));
     };
     // what goes wrong is said where it is seen, never a click that does nothing
diff --git a/internal/provider/group.go b/internal/provider/group.go
index 0b51c361e..fc2fa19c8 100644
--- a/internal/provider/group.go
+++ b/internal/provider/group.go
@@ -223,6 +223,12 @@ type Group struct {
 	// Rules with an intent need one; a small, fast model without reasoning
 	// does.
 	Classifier string `json:"classifier,omitempty"`
+	// IntentSure is how confident a decision model (Jev, from TypeSafe's
+	// decision API) must be of an intent of this group's for it to count:
+	// from 0, its likeliest intent taken however unsure it is ("none of
+	// these" never counting), to 1, certain. nil asks 0.4, as groups have
+	// always asked (#5101).
+	IntentSure *float64 `json:"intentSure,omitempty"`
 	// Effort "auto" has the classifier — Jev, from TypeSafe's decision API,
 	// or any model, asked in words — judge how hard each turn is to think
 	// about as it begins, and the turn asks its model for that much
@@ -1545,6 +1551,9 @@ func SaveGroup(g Group) error {
 			return fmt.Errorf("magpie knows no model %q to classify with", g.Classifier)
 		}
 	}
+	if g.IntentSure != nil && (*g.IntentSure < 0 || *g.IntentSure > 1) {
+		return fmt.Errorf("a group's intent sure is from 0 to 1, not %g", *g.IntentSure)
+	}
 	g.Auto, g.Hidden = false, false
 	g.Members = own // what the patterns match is found again as it is read
 	g.Disabled = false
diff --git a/site/public/docs/intent.html b/site/public/docs/intent.html
index 56cf4428a..a06fd50b0 100644
--- a/site/public/docs/intent.html
+++ b/site/public/docs/intent.html
@@ -112,6 +112,7 @@
       <li><b>Save, and send a message</b>Changes apply from the next turn, with no restart. The <span class="ui">Routing</span> tab shows what the classifier said and where the turn went.</li>
     </ol>
     <p id="timeout">The timeout is global: in <span class="ui">Settings → Models → Replies → Intent classifier timeout</span>, choose 8, 15, 30 or 60 seconds. It defaults to 8 seconds and applies to the next classifier call, including Jev, with no restart. A slow classifier may need longer, but the turn waits for it before routing. In <code>~/.config/magpie/settings.json</code>, <code>"classifyTimeout"</code> accepts whole seconds from 1 to 60; 0 or a missing field uses 8. A custom value in that range appears as its own choice in Settings.</p>
+    <p id="sure">How sure a Jev classifier must be of an intent for it to match is per group: 40% by default, kept in the group’s record as <code>"intentSure"</code> (a number from 0 to 1). Under it, Jev’s likeliest intent matches no rule and the turn goes by the group’s routing as if the intent rules weren’t there — which is the point: raise the intents’ bar and leave it, or lower it to 0.25 to let an unsure pick match, or to 0 to take Jev’s likeliest however unsure it is. <code>"none of these"</code> is no intent at any setting. Set it in the editor, under the classifier: <span class="ui">Intent sure</span>; from a terminal, <code>magpie group set &lt;group&gt; intent-sure=0.25</code> (empty for 0.4 again). Only a Jev classifier answers with a sureness; a classifier asked in words matches as it answers, and ignores this.</p>
     <p>The same from a terminal:</p>
     <div class="code">
       <span class="lang">Terminal</span>
@@ -135,7 +136,7 @@ magpie group rule rm coder 2</pre>
       <li><b>Which intents could decide?</b>magpie walks the rules top first and ignores intent for now: a rule is a candidate if its other conditions (tokens, images, reasoning, agents) hold for this request. Each candidate’s intent is collected, and duplicates spelled the same apart from case count once. The walk stops at the first candidate <em>without</em> an intent, because that rule matches outright and nothing below it could come first. If no intents were collected, the classifier isn’t asked and costs nothing.</li>
       <li><b>Ask the classifier</b>magpie sends the classifier the collected intents and the text of your message. The exact prompt is shown <a href="#prompt">below</a>. The call goes through magpie’s own gateway, like a request from an agent, so it uses that model’s provider with its keys or accounts and their failover. It has the <a href="#timeout">configured timeout</a> to answer (8 seconds by default).</li>
       <li><b>Read the answer</b>magpie takes the first whole number in the reply. <code>1</code> to <code>n</code> names that intent, and <code>0</code> means none of them. Anything else, such as no number or one out of range, counts as a failure. The answer is kept for 10 minutes for the same message and intents.</li>
-      <li><b>Match the rules</b>The rules are checked top first with the answer. A rule with an intent matches only when the classifier named its intent, compared without case, and all its other conditions hold. The first rule that matches wins. If none matches, the group routes the turn as it always does.</li>
+      <li><b>Match the rules</b>The rules are checked top first with the answer. A rule with an intent matches only when the classifier named its intent, compared without case, and all its other conditions hold. A Jev classifier’s answer counts only when it is sure enough of it (<a href="#sure">the group’s own sure</a>, 40% by default). The first rule that matches wins. If none matches, the group routes the turn as it always does.</li>
       <li><b>Order the models</b>The winning rule’s model goes first, and the group’s other models follow in their usual order as failover. This holds even if another model answered the conversation’s last turn: a rule outranks the <span class="ui">Stays</span> setting as a turn begins. If the rule’s model has nothing ready right now (every key resting, the provider off), the group’s usual order stands and the trace says so.</li>
       <li><b>Remember the decision</b>magpie keeps the decision for this conversation (the group, the agent’s session and the conversation’s first words) with the classifier’s answer, so the rest of the turn follows it.</li>
     </ol>
@@ -256,6 +257,7 @@ The number of its kind (0 for none):</pre>
     <div class="table-wrap"><table class="loose">
       <tr><th>What</th><th>Value</th></tr>
       <tr><td>Classifier timeout</td><td>8 s by default; configurable from 1 to 60 s, including its provider’s failover</td></tr>
+      <tr><td>Sure an intent needs</td><td>0.4 by default; per group from 0 (its likeliest intent, however unsure) to 1</td></tr>
       <tr><td>Rest after a failure</td><td>30 s, per classifier model</td></tr>
       <tr><td>Answer cache</td><td>10 min, per classifier + intents + message; in memory</td></tr>
       <tr><td>Turn decisions kept</td><td>24 h after the conversation’s last request; in memory</td></tr>
-- 
2.50.1 (Apple Git-155)


```
</details>

**Verification**

| Check | Result |
| --- | --- |
| New tests `TestGroupIntentSureThreshold`, `TestGroupIntentSureZeroTakesTheArgmax`, `TestGroupIntentSureIsPerGroup`, `TestGroupIntentSureRange`, `TestGroupIntentSureLeavesLevels` (`internal/gateway/decide_intentsure_test.go`) | ok (5/5) |
| Ablation: `git checkout HEAD~1 -- internal/gateway/rules.go` (threshold application reverted), tests kept | 2 of the new tests red (`TestGroupIntentSureThreshold`, `TestGroupIntentSureIsPerGroup`), restored green after |
| `go test -tags nogui -count=1 ./internal/gateway/` (whole package, at this head `96f882113`) | ok, 0 failures |
| `gofmt -l internal/gateway internal/cli` | empty |
| `go vet -tags nogui ./internal/gateway ./internal/cli` | clean (pre-existing C enum-conversion warnings in `internal/gui` darwin files only, not from this patch) |
| Clean tree `git am` of the patch at `upstream/main` | applies clean, tree clean |

**Not verified**

- The group editor's "Intent sure" field in the running GUI: the patch adds the editor field, the i18n strings and the save-path wiring, but I checked those only as code and by the CLI path (`magpie group set`), not by hand in the app.
- zminds' real 237-turn trace replayed against the new threshold: my checks are the new unit tests with a fake classifier, not the production data.

AI use: analysis and patch by AI (GLM-5.3-Flash via ZCode), posted by ggbdpq.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq ggbdpq@gmail.com

**Branch with the commit**: https://github.com/ggbdpq/magpie/tree/fix/5101-jev-intent-sure (head 96f8821136e59b485f6e14c90f3bd83fd7b31df6)

Thanks zminds for the report and the 237-turn trace data and acceptance bar.

