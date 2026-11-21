# agent: the mover leaves an agent on a gone provider when the same model elsewhere is spelt with spaces

**Source**: found by code audit (AI-assisted) of `1e643ba7e`'s sibling surface ("a model listed by its display name joins the group magpie found for gpt-6-sol"), not from a real failure I hit. The premise — a relay listing a model id under its display name — is the case that commit itself fixed grouping for (Chill on Discord).

## What happens

Since `1e643ba7e`, `sameModel` folds a run of spaces into one dash, so the groups magpie finds hold `gpt-6-sol` and `GPT-6 Sol` together and the gateway serves them as one model. The agent mover (`internal/agent/reseat.go`) matches "the same model from another provider still serving it" with its own spelling, `modelKey`, which still keeps the space: `modelKey("GPT-6 Sol")` is `"gpt-6 sol"`, `modelKey("gpt-6-sol")` is `"gpt-6-sol"` — no match.

So when a provider that served the space-spelled id is removed or switched off, `Reseat` finds no alike option for the agent and falls it back to the agent's own default, while the grouping layer says another provider serves the same model. The agent is rewritten away from a model magpie could still serve; the user's pick is lost until they notice and re-pick by hand.

`Reseat` runs on every provider removal and switch-off (`Reseat(func() error { return provider.Delete(...) })` / `provider.SetOff`), so this hits the mover path only — routing groups keep working; it is the agent settings that silently drop to defaults.

## Reproduction (deterministic, in-repo)

Two providers, one serving the display-name id the way Chill's relay does, one the dashed spelling; Claude Code set on the first; remove the first:

```go
{ID: "relay", Models: []string{"GPT-6 Sol"}},
{ID: "ds", Models: []string{"gpt-6-sol"}},
// claude model = "relay/GPT-6 Sol"
Reseat(func() error { return provider.Delete("relay") })
// want "ds/gpt-6-sol" (the grouping layer's own answer: auto-gpt-6-sol)
```

At `b14784c03` this moves Claude Code to **its default** instead (`moves: [Claude Code model: relay/GPT-6 Sol → its default]`). `TestReseatFollowsTheSameModelSpeltWithSpaces` (in the patch) asserts the move to `ds/gpt-6-sol`.

## Root cause and fix

`1e643ba7e`'s sibling note says reseat "already compare[s] by `Slug(sameModel(..))`" — that holds for the group-ref branch (through `AutoGroupOf`), but the direct-model branch compares with the private `modelKey` (`internal/agent/reseat.go:179`), which the commit did not touch. `modelKey` and `sameModel` have deliberately different rules elsewhere (every dot, not only one between digits, is a dash; a snapshot date in either shape comes off — `TestModelKey` pins those), so the fix keeps those and only adds what the grouping layer now does that the mover doesn't: a run of spaces (a no-break one too) is one dash, trimmed, exactly `sameModel`'s space rule. Fireworks' `p` between digits stays `sameModel`'s alone, as before.

```go
m = strings.NewReplacer(".", "-", "_", "-").Replace(m)
m = strings.Trim(modelGaps.ReplaceAllString(m, "-"), "-") // new
return dated.ReplaceAllString(m, "")
```

Patch (against `b14784c03`):

<details>
<summary>format-patch</summary>

```
From a53d0ce3bc41af58d145ebc83816c84da5f26b83 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 18 Oct 2026 02:37:36 +0800
Subject: [PATCH] agent: the mover follows a model the grouping layer found by
 its display name
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A relay may list a model under its display name ("GPT-6 Sol") where
another provider spells the same id dashed ("gpt-6-sol"). Since
1e643ba7e sameModel folds a run of spaces into one dash, so the groups
magpie finds hold both spellings and the gateway serves them as one
model. The agent mover's own spelling, modelKey, kept the space: an
agent set on relay/"GPT-6 Sol" whose provider is removed or switched
off fell back to the agent's own default while the grouping layer says
another provider serves the same model.

modelKey now spells a run of spaces (a no-break one too) as one dash
and trims it, as sameModel spells its own. Its other two steps are its
own: every dot (not only one between digits) is a dash, and a snapshot
date in either shape (20250929, 2025-06-17) comes off, as TestModelKey
pins them. A "p" between digits (Fireworks' deepseek-v4p1) is left to
sameModel alone, as before.

TestReseatFollowsTheSameModelSpeltWithSpaces: providers relay (GPT-6
Sol) and ds (gpt-6-sol), Claude Code on relay/GPT-6 Sol, relay removed:
it moves to ds/gpt-6-sol. Without the change it read "claude model: \"\",
want ds/gpt-6-sol" and the move was "relay/GPT-6 Sol → its default".
TestModelKey pins the spellings (space, no-break space).

Run:
- go test ./internal/agent -run 'TestReseat|TestModelKey|TestSameModel'
  -count=1: ok, all 9.
- Red without the fix: internal/agent/reseat.go reverted to
  upstream/main b14784c03, tests kept:
  TestReseatFollowsTheSameModelSpeltWithSpaces and TestModelKey red;
  restored: ok. With \p{Zs} dropped from the class, TestModelKey's
  no-break pair is red.
- go test ./internal/agent -count=1 -timeout 60m: ok, 206.7s.
- go test ./internal/provider -run TestSameModel -count=1: ok.
- gofmt -l internal/agent: clean. go vet ./internal/agent on darwin,
  GOOS=linux and GOOS=windows -tags nogui: ok.
- go build on darwin, GOOS=linux and GOOS=windows -tags nogui: ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/reseat.go      | 10 +++++++++-
 internal/agent/reseat_test.go | 33 +++++++++++++++++++++++++++++++++
 2 files changed, 42 insertions(+), 1 deletion(-)

diff --git a/internal/agent/reseat.go b/internal/agent/reseat.go
index e5b12125..c683c197 100644
--- a/internal/agent/reseat.go
+++ b/internal/agent/reseat.go
@@ -175,9 +175,17 @@ func sameModel(opts []Option, ref string) Option {
 var dated = regexp.MustCompile(`-(\d{8}|\d{4}-\d{2}-\d{2})$`)
 
 // modelKey is a model id as providers agree on it: its last part, lower
-// case, with dots and underscores as dashes and no date.
+// case, with dots and underscores as dashes and no date. A run of spaces
+// is one dash, as provider.sameModel spells it since it merged a relay's
+// display name ("GPT-6 Sol") with its dashed id: the grouping layer says
+// the two are one model, so the mover does too.
 func modelKey(m string) string {
 	m = strings.ToLower(m[strings.LastIndex(m, "/")+1:])
 	m = strings.NewReplacer(".", "-", "_", "-").Replace(m)
+	m = strings.Trim(modelGaps.ReplaceAllString(m, "-"), "-")
 	return dated.ReplaceAllString(m, "")
 }
+
+// modelGaps is what modelKey spells as one "-": a run of spaces (a
+// no-break one too), as provider.sameModel spells its own.
+var modelGaps = regexp.MustCompile(`[\s\p{Zs}]+`)
diff --git a/internal/agent/reseat_test.go b/internal/agent/reseat_test.go
index f9af1e13..50b90176 100644
--- a/internal/agent/reseat_test.go
+++ b/internal/agent/reseat_test.go
@@ -148,12 +148,45 @@ func TestReseatDelete(t *testing.T) {
 	}
 }
 
+// A relay may list a model under its display name ("GPT-6 Sol", Chill on
+// Discord) where another provider spells the same id dashed ("gpt-6-sol").
+// The groups magpie finds have merged the two spellings since sameModel
+// began folding a run of spaces into one dash, so a provider removed moves
+// the agent to that model on the provider still serving it, rather than to
+// the agent's own default while the grouping layer says it is the same
+// model.
+func TestReseatFollowsTheSameModelSpeltWithSpaces(t *testing.T) {
+	reseatHome(t)
+	for _, p := range []provider.Provider{
+		{ID: "relay", Name: "Relay", Chat: "https://relay.example/v1", Key: "k", Models: []string{"GPT-6 Sol"}},
+		{ID: "ds", Name: "DS", Chat: "https://ds.example/v1", Key: "k", Models: []string{"gpt-6-sol"}},
+	} {
+		if err := provider.Save(p); err != nil {
+			t.Fatal(err)
+		}
+	}
+	c := mustFind(t, "claude")
+	mustApply(t, c, "model", "relay/GPT-6 Sol")
+	moves, err := Reseat(func() error { return provider.Delete("relay") })
+	if err != nil {
+		t.Fatal(err)
+	}
+	if got := c.Field("model").Get(); got != "ds/gpt-6-sol" {
+		t.Errorf("claude model: %q, want ds/gpt-6-sol", got)
+	}
+	if len(moves) != 1 || moves[0].From != "relay/GPT-6 Sol" || moves[0].To != "ds/gpt-6-sol" {
+		t.Errorf("moves: %+v", moves)
+	}
+}
+
 func TestModelKey(t *testing.T) {
 	for a, b := range map[string]string{
 		"claude-sonnet-4.5":         "claude-sonnet-4-5-20250929",
 		"anthropic/claude-opus-4.6": "claude-opus-4-6",
 		"gpt-5.1-codex":             "GPT-5.1-codex",
 		"gemini-2.5-pro-2025-06-17": "gemini-2.5-pro",
+		"GPT-6 Sol":                 "gpt-6-sol",
+		"gpt-6\u00a0sol":            "GPT-6 Sol",
 	} {
 		if modelKey(a) != modelKey(b) {
 			t.Errorf("%s ≠ %s", a, b)
-- 
2.50.1 (Apple Git-155)
```

</details>

## Verification

| What | Command / how | Result |
| --- | --- | --- |
| Red without the fix (base `b14784c03`) | `go test ./internal/agent -run TestReseatFollowsTheSameModelSpeltWithSpaces` with the fix reverted and the test kept | `claude model: "", want ds/gpt-6-sol` and `moves: [Claude Code model: relay/GPT-6 Sol → its default]` |
| Mutation: product file reverted, tests kept | same, `git checkout upstream/main -- internal/agent/reseat.go` | both new tests red (`TestReseatFollowsTheSameModelSpeltWithSpaces`, `TestModelKey` on the space pairs) |
| Mutation: `\p{Zs}` dropped from the class | no-break space pair in `TestModelKey` | red on the NBSP pair |
| Green | `go test ./internal/agent -run 'TestReseat|TestModelKey|TestSameModel' -count=1` | ok, all 9 |
| Family | `go test ./internal/agent -count=1 -timeout 60m` | ok, 206.7s |
| Sibling package | `go test ./internal/provider -run TestSameModel -count=1` | ok |
| Format / vet | `gofmt -l internal/agent`; `go vet ./internal/agent` on darwin, `GOOS=linux` and `GOOS=windows -tags nogui` | clean; ok ×3 |
| Build | darwin, `GOOS=linux -tags nogui`, `GOOS=windows -tags nogui` | ok ×3 |

**Siblings**: `rg -n "modelKey\(" internal/` → 3 sites, all in `reseat.go`'s direct-model branch — all covered by the one fix. Other spelling judges were checked and left: `provider.sameModel`/`modelGaps` (canonical, already folds spaces — this patch mirrors it), `usage.served.squash`/`SameSpelled` (drops separators including spaces — already agrees), reseat's group branch (`AutoGroupOf` → `Slug(sameModel(..))` — already agrees). Not changed on purpose: `digit p digit` (`deepseek-v4p1`) folding stays `sameModel`-only, and `modelKey`'s own two steps (every dot, both date shapes) stay as `TestModelKey` pins them.

**When the read fails**: not applicable — no file or network reads change; the mover's matching is pure string work.

**Not verified**: a real relay listing display-name ids and a real agent move on a running magpie (the fixture is the id spelling as reported in `1e643ba7e`'s own test and commit message).

**AI**: I've read the whole diff and can answer questions on it myself.
