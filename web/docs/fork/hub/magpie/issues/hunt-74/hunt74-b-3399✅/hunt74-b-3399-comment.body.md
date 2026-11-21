Kimi Code's new K3.1 models get `always_thinking` in the tables magpie writes, so Off is no longer offered on them and the 400 is unreachable through the picker.

What you hit has two layers. The first is the catalog: models.dev, where magpie's model levels come from, did not list the two new models yet, so `/v1/models` showed `reasoning: false` with empty level lists, and `internal/agent/kimi.go` (`len(m.Efforts) > 0`) wrote no `thinking` capability — the session ran at `thinkingEffort: "off"` and the upstream refused it. That half heals itself: models.dev (fetched today, 2026-10-24) now lists `k3.1-pro` and `k3.1-pro-highspeed` under both `kimi-code-plan` catalogs with effort `low, high, max` and no off — matching your Kimi-side reading (thinking on, default Max) — and magpie refreshes that catalog at most a day stale on its own.

The second layer is code, and it is what this patch fixes: even with the levels known, magpie's generated tables said `thinking` alone. Kimi's own entries for these models declare a second capability, `always_thinking` — thinking cannot be turned off — and without it Kimi Code still offers Off beside the levels, so the refused state stays one click away. Magpie now writes `always_thinking` beside `thinking` for exactly the models whose levels have no off among them (the same rule WorkBuddy's `canDisableThinking` follows), and leaves kimi-cli out of it, as with `tool_use`: the old CLI refuses words it doesn't know. A model that has an off level (`k3`, `kimi-for-coding`) is written as before.

After this patch and a catalog refresh, magpie's table for `k3.1-pro` reads `capabilities = ["thinking", "always_thinking", "tool_use"]`, `support_efforts = ["low", "high", "max"]`, `default_effort = "high"`; `k3` stays `["thinking", "tool_use"]` with its off level. The image/video/`dynamically_loaded_tools` differences you measured are left alone — you're right that they are not what returns the 400.

## What changed

- `internal/agent/kimi.go`, `kimiModelTables`: when a model has reasoning levels and none of them is `none`, the new Kimi Code's table also gets `"always_thinking"` in `capabilities`, beside `"thinking"` (kimi-cli's tables are not told, `!legacy`, as for `tool_use`). Nothing else about the capabilities, `support_efforts` or `default_effort` changes.
- `internal/agent/kimi_efforts_test.go`: new `TestKimiAlwaysThinking` (a no-none model's table declares `thinking`, `always_thinking` and the levels; a has-none model's doesn't get the word; kimi-cli's table gets neither new word), and the `wide` row of `TestKimiEfforts` (levels `low, medium`, no off) now expects the word too.

## Verification

(darwin/arm64, go 1.26.8, tests under a temp `HOME`)

| Check | Result |
| --- | --- |
| after, `go test -tags nogui -run 'TestKimiAlwaysThinking|TestKimiEfforts' ./internal/agent/` | ok |
| before (baseline `dd1e8822`), same command | FAIL: k3.1-pro row `{Capabilities:[thinking tool_use] …}`, want `[thinking always_thinking tool_use]` |
| ablation: only `internal/agent/kimi.go` reverted to `dd1e8822`, tests kept | FAIL: `TestKimiAlwaysThinking` (k3.1-pro row) and `TestKimiEfforts` (`wide` row); restored from the commit, green again |
| `go test -tags nogui -count=1 ./internal/agent/` (full package) | ok but `TestMothX`, which fails the same on a clean `dd1e8822` worktree (pre-existing on this machine: a `mothx` on its `PATH`); no other red |
| `gofmt -l` on the two touched files | clean |
| `go vet ./...` | OK |
| `GOOS=linux go vet -tags nogui ./...` | OK |
| `GOOS=windows go vet ./...` | OK |
| `go build -tags nogui .` (darwin), `GOOS=linux go build -tags nogui .`, `GOOS=windows go build .` | OK |
| models.dev fetched 2026-10-24 | both `kimi-code-plan-cn` and `-global` list `k3.1-pro` / `k3.1-pro-highspeed`, `reasoning_options` = effort `["low","high","max"]`, no toggle |

## Not verified

- Not exercised against a real Kimi Code 1.1.2 install or the live upstream: the capability names and levels written are the ones you measured in Kimi's own entries for these models, and the schema is the one Kimi itself writes; a session against the real vendor is the one thing this sandbox cannot do.
- The catalog half (the models' levels) rides in with models.dev and magpie's own refresh; verified by fetching models.dev today, not from this repo's fixture, whose snapshot (2026-10-09) predates the models.
- `default_effort` stays `high` (magpie's rule for every model, #333) rather than Kimi's Max default — any level it starts on is an enabled one, so this does not reintroduce the 400.
**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: hunt74-b-kimi-k31-always-thinking (#3399) — git am applies it as is; SHA-256 first 16: f47bdf58e3373f1c</summary>

```text
From 03b9f53e705da9dc19566c25c403a17205a8dd79 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 09:37:47 +0800
Subject: [PATCH] kimi: a model whose levels have no off gets always_thinking;
 kimi-cli isn't told (#3399)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Kimi Code's new k3.1-pro and k3.1-pro-highspeed think and cannot have
their thinking turned off: Kimi's own entries for them declare
always_thinking, and their upstream refuses a session run with thinking
off — "400 … does not support disabled thinking mode". Magpie's tables
for them said thinking alone once their levels were known (models.dev
lists effort low, high, max, no none), so Kimi Code still offered Off
beside the levels, and a session left at off was refused. The word
itself belongs to the new Kimi Code's schema; kimi-cli, which refuses
words it doesn't know as it does tool_use, isn't told.

So a model whose efforts have no none now gets always_thinking beside
thinking — the same read as WorkBuddy's canDisableThinking, which is
true exactly when none is among the efforts — and a model with none
(k3, kimi-for-coding) doesn't. The levels and default_effort are
unchanged (#333).

TestKimiAlwaysThinking fails without the change, and so does the wide
row of TestKimiEfforts.

Run: go test -tags nogui -run 'TestKimiAlwaysThinking|TestKimiEfforts'
./internal/agent/ red on dd1e8822, green here; go test -tags nogui
-count=1 ./internal/agent/ green but for TestMothX, red the same on a
clean dd1e8822 worktree (a mothx on this machine's PATH); gofmt -l on
the touched files clean; go vet ./..., GOOS=linux go vet -tags nogui
./... and GOOS=windows go vet ./... clean; go build -tags nogui and
GOOS=linux and GOOS=windows builds pass.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/kimi.go              |  7 +++
 internal/agent/kimi_efforts_test.go | 75 ++++++++++++++++++++++++++++-
 2 files changed, 81 insertions(+), 1 deletion(-)

diff --git a/internal/agent/kimi.go b/internal/agent/kimi.go
index 9f9c3a7c..e136cdcb 100644
--- a/internal/agent/kimi.go
+++ b/internal/agent/kimi.go
@@ -96,6 +96,13 @@ func kimiModelTables(path string, legacy bool, wrote map[string]map[string]strin
 		var caps []string
 		if len(m.Efforts) > 0 {
 			caps = append(caps, strconv.Quote("thinking"))
+			// a model with no none among its levels can't have its thinking
+			// turned off (Kimi's own k3.1-pro entries read always_thinking,
+			// and its upstream refuses a session run at off with a 400,
+			// #3399). kimi-cli has no word for it, as for tool_use.
+			if !legacy && !slices.Contains(m.Efforts, "none") {
+				caps = append(caps, strconv.Quote("always_thinking"))
+			}
 		}
 		if m.Images {
 			caps = append(caps, strconv.Quote("image_in"))
diff --git a/internal/agent/kimi_efforts_test.go b/internal/agent/kimi_efforts_test.go
index 09aaacaa..c750e921 100644
--- a/internal/agent/kimi_efforts_test.go
+++ b/internal/agent/kimi_efforts_test.go
@@ -62,8 +62,10 @@ func TestKimiEfforts(t *testing.T) {
 	}
 	ms := read(path)
 	for k, want := range map[string]model{
+		// wide has no none among its levels: its thinking can't go off
+		// (always_thinking, #3399)
 		"magpie/think/deep":  {[]string{"thinking", "tool_use"}, []string{"high", "max"}, "high"},
-		"magpie/think/wide":  {[]string{"thinking", "tool_use"}, []string{"low", "medium"}, ""},
+		"magpie/think/wide":  {[]string{"thinking", "always_thinking", "tool_use"}, []string{"low", "medium"}, ""},
 		"magpie/think/plain": {[]string{"tool_use"}, nil, ""},
 	} {
 		if got := ms[k]; !reflect.DeepEqual(got, want) {
@@ -81,3 +83,74 @@ func TestKimiEfforts(t *testing.T) {
 		t.Errorf("kimi-cli's: %+v", got)
 	}
 }
+
+// #3399: a thinking model with no none among its levels — Kimi's k3.1-pro —
+// cannot have its thinking turned off: Kimi's own entry for it declares
+// always_thinking, and its upstream refuses a session run at off with a
+// 400. magpie's table for it says so too; one with none (k3) doesn't, and
+// kimi-cli, which has no word for it as for tool_use, gets neither.
+func TestKimiAlwaysThinking(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	t.Setenv("KIMI_SHARE_DIR", "")
+	t.Setenv("KIMI_CODE_HOME", "")
+	if err := provider.Save(provider.Provider{
+		ID: "moonshot", Name: "Moonshot", Chat: "https://example.test/v1", Key: "key",
+		Models: []string{"k3.1-pro", "k3"},
+	}); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive("moonshot", "https://example.test/v1", []catalog.Model{
+		{ID: "k3.1-pro", Efforts: []string{"low", "high", "max"}},
+		{ID: "k3", Efforts: []string{"none", "low", "high", "max"}},
+	}); err != nil {
+		t.Fatal(err)
+	}
+	type model struct {
+		Capabilities   []string `toml:"capabilities"`
+		SupportEfforts []string `toml:"support_efforts"`
+		DefaultEffort  string   `toml:"default_effort"`
+	}
+	read := func(path string) map[string]model {
+		t.Helper()
+		b, err := os.ReadFile(path)
+		if err != nil {
+			t.Fatal(err)
+		}
+		var c struct {
+			Models map[string]model
+		}
+		if err := toml.Unmarshal(b, &c); err != nil {
+			t.Fatalf("%v\n%s", err, b)
+		}
+		return c.Models
+	}
+
+	path := filepath.Join(home, ".kimi-code", "config.toml")
+	writeFile(t, path, "")
+	if err := kimi(home).Field("model").Set("magpie/moonshot/k3.1-pro"); err != nil {
+		t.Fatal(err)
+	}
+	ms := read(path)
+	for k, want := range map[string]model{
+		"magpie/moonshot/k3.1-pro": {[]string{"thinking", "always_thinking", "tool_use"}, []string{"low", "high", "max"}, "high"},
+		"magpie/moonshot/k3":       {[]string{"thinking", "tool_use"}, []string{"low", "high", "max"}, "high"},
+	} {
+		if got := ms[k]; !reflect.DeepEqual(got, want) {
+			t.Errorf("%s: %+v, want %+v", k, got, want)
+		}
+	}
+
+	os.RemoveAll(filepath.Join(home, ".kimi-code"))
+	legacy := filepath.Join(home, ".kimi", "config.toml")
+	writeFile(t, legacy, "")
+	if err := kimi(home).Field("model").Set("magpie/moonshot/k3.1-pro"); err != nil {
+		t.Fatal(err)
+	}
+	if got := read(legacy)["magpie/moonshot/k3.1-pro"]; !reflect.DeepEqual(got, model{Capabilities: []string{"thinking"}}) {
+		t.Errorf("kimi-cli's: %+v", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt74-b-kimi-k31-thinking](https://github.com/ggbdpq/magpie/tree/hunt74-b-kimi-k31-thinking) (head `03b9f53e705da9dc19566c25c403a17205a8dd79`).
