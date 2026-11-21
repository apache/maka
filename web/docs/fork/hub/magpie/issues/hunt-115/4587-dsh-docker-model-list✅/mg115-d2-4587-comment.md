Fixed on top of `1adff3779` — the source-level diagnosis in this issue is exactly right, and `visible <agent> all` now does what its own hints promise.

## Summary

`magpie visible <agent> all` removed only the visibility narrowing (`Visible[agent]`) and left `HiddenModels[agent]` and `PickedModels[agent]` in place, while every recovery hint promises a full recovery: `magpie models` says "magpie visible <agent> all shows it every model", so does the gateway's refusal to name a model, and the usage text says "show the agent every model again". An agent shown none of them — shown only the models picked for it with none picked, then switched to `--show-new`, which keeps what it is shown by writing the rest into `HiddenModels` — stayed empty through `all`, and the hint told the user to run `all` again; deleting `hiddenModels.<agent>` from settings.json was the only way back (#4587; #3432 is the same trap for an only-picked agent with some picks).

## Root cause

`SetOnlyPicked(agent, false)` deliberately preserves what the agent is shown right now: everything not picked becomes a `HiddenModels` entry (#1337). That policy is fine — the issue says so too — but `visible <agent> all`, the one recovery command every hint points at, undid only the narrowing, so the 13 kept models stayed kept and the hint looped.

## Fix

`visible <agent> all` now takes the per-model hidden list and the only-picked switch out together with the narrowing: typing `all` is the user explicitly asking for every model again, not a default that overwrites their picks. The per-model checkbox semantics on the Agents page, the settings API (which never overwrites these maps) and `--show-new`'s keep-what-is-shown behavior are untouched. The usage line for `all` states the wider scope now; the recovery hints needed no wording change — they became true.

## Verification

| Check | Result |
| --- | --- |
| New `TestVisibleAllShowsTakenOutModels` — the issue's exact sequence: only-picked with none picked → `--show-new` fills HiddenModels → `all` | FAIL before the fix (the CLI printed the same "✓ saved / is shown none of them / 3 taken out" loop as reported), PASS after |
| New `TestVisibleAllTakesOnlyPickedOut` — #3432's variant: only-picked with 1 of 3 picked → `all` | FAIL before, PASS after |
| Ablation: product file reverted to the branch's parent (`1adff3779`), tests kept | both new tests fail again, PASS after restore |
| `go test -tags nogui ./internal/cli/` (full package, sandboxed HOME) | ok |
| Targeted tests with `-race`; `gofmt -l`; `go vet`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...`; `go build` on darwin / linux / windows | all pass |

## Not verified

Not run against a real Docker deployment or a real DSH Desktop client; the gateway's `/v1/models` narrowing reads the same `CatalogFor` lists the tests assert on, but the remote scenario itself is untested here.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(cli): visible <agent> all clears the models taken out and the only-picked switch (#4587) — git am applies it as is; SHA-256 first 16: 9634b8d88f600888</summary>

```patch
From e581838db85923d69d76378e4f8385338e77110c Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 16:33:17 +0800
Subject: [PATCH] fix(cli): visible <agent> all clears the models taken out and
 the only-picked switch
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: `magpie visible <agent> all` took only the visibility
narrowing out, leaving HiddenModels and PickedModels in place. An agent
shown none of them — shown only the models picked for it with none picked,
then switched to --show-new, which keeps what it is shown by taking the
rest out — stayed none through `all`, the very recovery `magpie models`
and the gateway's refusal to name a model point at; only deleting
hiddenModels.<agent> from settings.json brought the models back (#4587, a
DSH behind a Docker gateway saw an empty model list; #3432, closed as not
planned, the same for an only-picked agent). `all` now takes the hidden
models and the only-picked switch out together with the narrowing, and its
usage line says so.

Run: go test ./internal/cli/ -run 'TestVisibleAll' -tags nogui — two new
tests fail before the change and pass after it.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/visible_cli.go      |  9 ++++-
 internal/cli/visible_cli_test.go | 69 ++++++++++++++++++++++++++++++++
 2 files changed, 77 insertions(+), 1 deletion(-)

diff --git a/internal/cli/visible_cli.go b/internal/cli/visible_cli.go
index 50920e361..d66bb958e 100644
--- a/internal/cli/visible_cli.go
+++ b/internal/cli/visible_cli.go
@@ -19,7 +19,8 @@ const visibleUsage = `usage:
   magpie visible <agent> <name>[,<name>…] show the agent only these: families (a tag set with
                                           magpie provider set <id> family=relay, or magpie group set),
                                           provider ids and group ids
-  magpie visible <agent> all              show the agent every model again
+  magpie visible <agent> all              show the agent every model again, the ones taken out of
+                                          its list one by one too
   magpie visible <agent> --only-picked    show the agent only the models ticked for it now; a model
                                           that comes later, of any provider, stays off until it is
                                           ticked in its list on the Agents page
@@ -102,6 +103,12 @@ func visibleCmd(args []string) error {
 	list := splitList(strings.Join(args[1:], ","))
 	if len(list) == 1 && strings.EqualFold(list[0], "all") {
 		delete(s.Visible, id)
+		// all is the recovery the hints point at (magpie models, the
+		// gateway's refusal to name a model): the models taken out of the
+		// agent's list one by one, and the only-picked switch, keep it
+		// shown none or fewer unless these go too (#4587)
+		delete(s.HiddenModels, id)
+		delete(s.PickedModels, id)
 	} else {
 		known := visibleNames()
 		for i, n := range list {
diff --git a/internal/cli/visible_cli_test.go b/internal/cli/visible_cli_test.go
index 0a66edff6..3b998f4a4 100644
--- a/internal/cli/visible_cli_test.go
+++ b/internal/cli/visible_cli_test.go
@@ -37,6 +37,75 @@ func TestVisibleKeyLowered(t *testing.T) {
 	}
 }
 
+// all shows the agent every model again: the models taken out of its list
+// one by one (HiddenModels) go with the narrowing, or the recovery the
+// hints point at doesn't. An agent shown none of them — only the models
+// picked for it, and none picked — stayed none through --show-new (which
+// keeps what it is shown by taking the rest out) and through all, and only
+// deleting hiddenModels.<agent> from settings.json brought the models
+// back (#4587: a DSH behind a Docker gateway saw an empty model list).
+func TestVisibleAllShowsTakenOutModels(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "config"))
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Chat: "http://127.0.0.1:1/v1", Models: []string{"m1", "m2", "m3"}}); err != nil {
+		t.Fatal(err)
+	}
+	t.Cleanup(func() { provider.Delete("relay") })
+	if err := provider.SetOnlyPicked("dsh", true); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SetPickedModels("dsh", nil); err != nil {
+		t.Fatal(err)
+	}
+	if shown, _ := provider.CatalogFor("dsh"); len(shown) != 0 {
+		t.Fatalf("want none picked, shown none; got %d", len(shown))
+	}
+	if err := visibleCmd([]string{"dsh", "--show-new"}); err != nil {
+		t.Fatal(err)
+	}
+	if ids := settings.Load().HiddenModels["dsh"]; len(ids) != 3 {
+		t.Fatalf("--show-new keeps what is shown by taking the rest out; hidden: %v", ids)
+	}
+	if shown, _ := provider.CatalogFor("dsh"); len(shown) != 0 {
+		t.Fatalf("want still none shown after --show-new; got %d", len(shown))
+	}
+	if err := visibleCmd([]string{"dsh", "all"}); err != nil {
+		t.Fatal(err)
+	}
+	if ids := settings.Load().HiddenModels["dsh"]; len(ids) != 0 {
+		t.Fatalf("all left %d taken out: %v", len(ids), ids)
+	}
+	if shown, _ := provider.CatalogFor("dsh"); len(shown) != 3 {
+		t.Fatalf("all shows %d of 3: %v", len(shown), shown)
+	}
+}
+
+// all takes the only-picked switch out too: an agent shown only the models
+// picked for it kept the ones not picked off through all, though the error
+// naming it says all shows it every model (#3432: zcode/GLM-5.3 stayed off
+// Claude Code after all).
+func TestVisibleAllTakesOnlyPickedOut(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "config"))
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Chat: "http://127.0.0.1:1/v1", Models: []string{"m1", "m2", "m3"}}); err != nil {
+		t.Fatal(err)
+	}
+	t.Cleanup(func() { provider.Delete("relay") })
+	if err := provider.SetOnlyPicked("claude", true); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SetPickedModels("claude", []string{"m1"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := visibleCmd([]string{"claude", "all"}); err != nil {
+		t.Fatal(err)
+	}
+	if _, only := provider.PickedModels("claude"); only {
+		t.Fatal("all left claude shown only the models picked for it")
+	}
+	if shown, _ := provider.CatalogFor("claude"); len(shown) != 3 {
+		t.Fatalf("all shows %d of 3: %v", len(shown), shown)
+	}
+}
+
 // magpie models and magpie visible take a WSL agent by its id, in the
 // distro's own case or any other: before, both lowered what was typed and
 // then matched it exactly against ids that keep the distro's case (#271).
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt115-d2-4587](https://github.com/ggbdpq/magpie/tree/hunt115-d2-4587) (head `e581838db85923d69d76378e4f8385338e77110c`).
