A patch for this, @adamzmsun. The entries magpie wrote come off now even where magpie kept no note of them; what is left in config.toml afterwards is yours or kept for Codex's own saved threads.

## What's wrong

Uninstalling leaves `openai_base_url` (and `model_provider = "magpie"`) in `~/.codex/config.toml` when magpie's own notes of what it wrote are gone: Codex keeps sending every turn to a local port nothing listens on any more, and fails with a connection error that says nothing of magpie -- the `http_connection_failed` in this issue's report. The in-app uninstall and `magpie uninstall` both disconnect only the agents that still read as connected, and a Codex in this state reads as not connected, so nothing touched its config.

## Root cause

Uninstall's agent pass (internal/uninstall/uninstall.go:113, `Agents`) disconnects only `Connected()` (uninstall.go:101), which is `(*Agent).Wired` (internal/agent/applied.go:506). Codex's `Wired` wants a magpie model, a joined/beside note, or a routed group-spelled model -- and those notes (`codex.joined`, `codex.beside`, `codex.failover`) live in magpie's own folder. Delete that folder before uninstalling, or reinstall fresh beside an old config.toml, or come from a magpie older than the notes, and a Codex left on `openai_base_url` beside one of its own models reads as not connected (read that way on purpose since #1385, so the Agents page wouldn't lie). The failover end has the same gate: `EndCodexFailover` (internal/agent/codex.go:2429) answers only when `FailingOver` (codex.go:1192) sees its note, so it says no too. Nothing names the base URL then, and it stays; `model_provider = "magpie"` (the magpie-API takeover) is left the same way. Reproduced on the parent commit's own APIs: `Wired()` false, `EndCodexFailover` not ended, `Disconnect` a no-op, `openai_base_url` still in config.toml.

What I checked around it and left as it is: magpie's provider table `[model_providers.magpie]` stays on purpose -- threads started on magpie name the provider, and without the table Codex loads no config at all (the repo's own tests assert the table survives a reset). The same note-less residue class exists in principle for the other agents (a hand-picked own model beside magpie's endpoint in their env or config), but their endpoint is the plain gateway URL with no path of magpie's in it, so a sweep with no notes to go by can't tell magpie's write from a relay the user wired by hand; I left those alone rather than risk taking the user's own route. Codex is the one agent whose writes have an unmistakable shape (`/backend-api/codex`, the provider id `magpie`).

## The fix

Uninstall ends with a leftovers pass, for this machine's Codex like `EndCodexFailover` is: the base URL naming magpie's gateway and magpie as its provider go by the same gates a Disconnect takes them by -- `dropBase` behind `viaBase()`, `dropProvider` behind `asProvider()` -- notes or not. Once magpie is gone for good, nothing serves that address, whoever wrote it there. Codex's own model, provider and keys stay, and so does the provider table. Taking something says "Codex's leftover settings" in the report and restarts the Codex app's app-server, which read the old config as it started.

<details><summary>core of the diff</summary>

```diff
+	// what no Disconnect could name, notes gone: only what names magpie
+	// itself goes, by the same gates a Disconnect takes them by
+	TakeLeftovers: func() (bool, error) {
+		took := false
+		if viaBase() {
+			if err := dropBase(); err != nil {
+				return false, err
+			}
+			took = true
+		}
+		if asProvider() {
+			if err := dropProvider(); err != nil {
+				return false, err
+			}
+			took = true
+		}
+		return took, nil
+	},
```

</details>

git am applies it as is; SHA-256 first 16: 6ed0a53ff649ef45

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -run 'TestCodexLeftovers\|TestCodexProviderLeftovers\|TestCodexLeftoversLeaveTheUsersOwn' ./internal/agent/` (new; without the fix the tests do not build, and a repro on the parent's own APIs ends `RESIDUE: uninstalling left magpie's base URL`) | pass |
| `go test -tags nogui -timeout 25m ./internal/agent/...` | one red, TestMothX, red on the parent e17b6cefc too (verified in a worktree); every other test green |
| `go test -tags nogui ./internal/uninstall/...` (new TestRunTakesCodexLeftovers taken/failed; TestRunOrder expects the pass) | pass |
| `gofmt -l` on the five touched files, CRLF stripped first | none |
| `go vet -tags nogui ./internal/agent/ ./internal/uninstall/` | clean |
| `go build ./...` | ok (the macOS ld warnings are there on the parent too) |
| `git am -3` of the patch on e17b6cefc | applies clean |

## Not verified

Windows and the Codex desktop app itself (darwin/arm64 here). The sweep is this machine's Codex only, like `EndCodexFailover`; a WSL distro's config is left as it was. AI use: the patch was written by GLM-5.3-Flash (ZCode) and I have read all of it and ran every check above.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq ggbdpq@gmail.com.

<details><summary>patch</summary>

```
diff --git a/internal/agent/agent.go b/internal/agent/agent.go
index 9345f00b3..8dd998481 100644
--- a/internal/agent/agent.go
+++ b/internal/agent/agent.go
@@ -229,6 +229,13 @@ type Agent struct {
 	// no longer answers, and retry till magpie is open again (Leon920717
 	// on X). The next start's Sync writes it again.
 	EndFailover func() error
+	// TakeLeftovers takes out what magpie wrote that no Disconnect could
+	// name: an address at magpie's gateway whose marks are gone (magpie's
+	// folder deleted by hand, a fresh install beside an old config), which
+	// reads as not connected, so uninstalling would leave it pointing at a
+	// gateway that is gone for good (#3866). Uninstall runs it after the
+	// disconnects. It answers whether it changed anything.
+	TakeLeftovers func() (bool, error)
 	// Follow, for an agent whose own picker moves its main model where
 	// magpie keeps other settings following it (Claude Code's /model and
 	// its tiers), brings those along to the model picked there. Run as the
diff --git a/internal/agent/codex.go b/internal/agent/codex.go
index 636c1dc13..d5a0a23d4 100644
--- a/internal/agent/codex.go
+++ b/internal/agent/codex.go
@@ -1597,6 +1597,24 @@ func codexIn(at place) *Agent {
 			}
 			return errors.Join(dropMirrorFailover(), dropBase())
 		},
+		// what no Disconnect could name, marks gone: only what names magpie
+		// itself goes, by the same gates a Disconnect takes them by
+		TakeLeftovers: func() (bool, error) {
+			took := false
+			if viaBase() {
+				if err := dropBase(); err != nil {
+					return false, err
+				}
+				took = true
+			}
+			if asProvider() {
+				if err := dropProvider(); err != nil {
+					return false, err
+				}
+				took = true
+			}
+			return took, nil
+		},
 		OwnVia: codexOwnViaMagpie,
 		SideModel: func() string {
 			if m := get("model"); viaBase() && !asProvider() && isMagpie(m) {
@@ -2442,6 +2460,19 @@ func EndCodexFailover() (ended bool, err error) {
 	return true, nil
 }
 
+// TakeCodexLeftovers takes out of this machine's Codex config what magpie
+// wrote that no Disconnect could name: the base URL at magpie's gateway,
+// and magpie as its provider, where the marks magpie keeps them by are
+// gone with magpie's own files (#3866). It answers whether it changed
+// anything.
+func TakeCodexLeftovers() (bool, error) {
+	home, err := os.UserHomeDir()
+	if err != nil {
+		return false, err
+	}
+	return codex(home).TakeLeftovers()
+}
+
 // RelayOpenCodex leaves a relay at the gateway's address for the Codex
 // processes running as magpie quits (codexrelay.Start), when the address
 // is this computer's own and Codex is running at all.
diff --git a/internal/agent/codex_leftovers_test.go b/internal/agent/codex_leftovers_test.go
new file mode 100644
index 000000000..21977e6fd
--- /dev/null
+++ b/internal/agent/codex_leftovers_test.go
@@ -0,0 +1,85 @@
+package agent
+
+import (
+	"path/filepath"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/edit"
+)
+
+// Uninstalling takes magpie's dead addresses out of Codex's config even
+// where no Disconnect could name them (#3866): the marks magpie keeps its
+// writes by are gone (magpie's folder deleted by hand, a fresh install
+// beside an old config, a magpie from before the marks), so Codex reads as
+// not connected, and the base URL at magpie's gateway sends every turn to
+// a port nothing answers any more. Codex's own model and provider stay,
+// and so does magpie's provider table, whose threads name it.
+func TestCodexLeftoversGoAtUninstallWithoutTheMarks(t *testing.T) {
+	home, read := codexHome(t, `{"tokens":{"access_token":"x","id_token":"x.e30.x"}}`,
+		"model = \"gpt-5.4\"\nopenai_base_url = \""+codexGatewayURL()+"\"\n\n"+
+			"[model_providers.magpie]\nname = \"magpie\"\nbase_url = \""+codexGatewayURL()+"\"\nwire_api = \"responses\"\n")
+	cx := codex(home)
+	if cx.Wired() {
+		t.Fatalf("read as connected with no marks of magpie's:\n%s", read())
+	}
+	took, err := TakeCodexLeftovers()
+	if err != nil || !took {
+		t.Fatalf("took %v, err %v", took, err)
+	}
+	cfg := read()
+	if strings.Contains(cfg, "openai_base_url") {
+		t.Fatalf("magpie's base URL left for a gateway that is gone:\n%s", cfg)
+	}
+	if !strings.Contains(cfg, `model = "gpt-5.4"`) || strings.Contains(cfg, "model_provider =") || strings.Contains(cfg, "model_catalog_json") {
+		t.Fatalf("Codex's own pick disturbed:\n%s", cfg)
+	}
+	if !strings.Contains(cfg, "[model_providers.magpie]") {
+		t.Fatal("magpie's provider table taken: threads started on it name it")
+	}
+	// nothing of magpie's the second time
+	if took, err := TakeCodexLeftovers(); err != nil || took {
+		t.Fatalf("took again: %v, %v", took, err)
+	}
+}
+
+// magpie its provider with the marks gone: the pick and the name of
+// magpie's model list go with it, or Codex is left on a provider of a dead
+// gateway (and loading no config at all once its list file is gone).
+func TestCodexProviderLeftoversGoAtUninstallWithoutTheMarks(t *testing.T) {
+	home, read := codexHome(t, "",
+		"model = \"gpt-5.4\"\nmodel_provider = \"magpie\"\nopenai_base_url = \""+codexGatewayURL()+"\"\n\n"+
+			"[model_providers.magpie]\nname = \"magpie\"\nbase_url = \""+codexGatewayURL()+"\"\nwire_api = \"responses\"\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n")
+	path := filepath.Join(home, ".codex", "config.toml")
+	// the list magpie wrote for its provider, named as Codex reads it
+	if err := edit.SetTOMLTop(path, edit.KV{Path: "model_catalog_json", Value: filepath.Join(home, ".codex", "magpie-models.json")}); err != nil {
+		t.Fatal(err)
+	}
+	cx := codex(home)
+	if cx.Wired() {
+		t.Fatalf("read as connected with no marks of magpie's:\n%s", read())
+	}
+	if took, err := TakeCodexLeftovers(); err != nil || !took {
+		t.Fatalf("took %v, err %v", took, err)
+	}
+	cfg := read()
+	if strings.Contains(cfg, "openai_base_url") || strings.Contains(cfg, `model_provider = "magpie"`) || strings.Contains(cfg, "model_catalog_json") {
+		t.Fatalf("magpie's provider pick left:\n%s", cfg)
+	}
+	if !strings.Contains(cfg, `model = "gpt-5.4"`) || !strings.Contains(cfg, `trust_level = "trusted"`) {
+		t.Fatalf("Codex's own keys disturbed:\n%s", cfg)
+	}
+}
+
+// The user's own addresses stay, and nothing of theirs is taken.
+func TestCodexLeftoversLeaveTheUsersOwn(t *testing.T) {
+	const config = "model = \"gpt-5.4\"\nopenai_base_url = \"https://api.openai.com/v1\"\nmodel_provider = \"mine\"\n\n" +
+		"[model_providers.mine]\nname = \"mine\"\nbase_url = \"https://mine.example/v1\"\n"
+	_, read := codexHome(t, "", config)
+	if took, err := TakeCodexLeftovers(); err != nil || took {
+		t.Fatalf("took %v, err %v", took, err)
+	}
+	if cfg := read(); cfg != config {
+		t.Fatalf("the user's own config changed:\n%s", cfg)
+	}
+}
diff --git a/internal/uninstall/uninstall.go b/internal/uninstall/uninstall.go
index 65aced3fa..a27e168f2 100644
--- a/internal/uninstall/uninstall.go
+++ b/internal/uninstall/uninstall.go
@@ -75,6 +75,7 @@ func (r *Report) Failed() bool {
 var (
 	agents          = agent.All
 	endFailover     = agent.EndCodexFailover
+	endLeftovers    = agent.TakeCodexLeftovers
 	portRollouts    = agent.PortCodexRollouts
 	restartCodexApp = provider.RestartCodexAppWhenIdle
 	removeService   = func() error {
@@ -125,6 +126,20 @@ func Agents(ctx context.Context, r *Report) {
 		r.Agents = append(r.Agents, d)
 		codex = codex || a.ID == "codex"
 	}
+	// what no Disconnect could name: an agent whose config points at
+	// magpie's gateway with the marks magpie kept gone (its folder deleted
+	// by hand, a fresh install beside an old config) reads as not
+	// connected, and Codex left on that address knocks on a port nothing
+	// answers any more (#3866)
+	took, err := endLeftovers()
+	if took || err != nil {
+		d := Done{What: "Codex's leftover settings"}
+		if err != nil {
+			d.Err = err.Error()
+		}
+		r.Agents = append(r.Agents, d)
+		codex = true
+	}
 	// the threads Codex ran on magpie's models open without magpie
 	portRollouts(10 * time.Second)
 	if codex {
diff --git a/internal/uninstall/uninstall_test.go b/internal/uninstall/uninstall_test.go
index 845f986c4..19131d022 100644
--- a/internal/uninstall/uninstall_test.go
+++ b/internal/uninstall/uninstall_test.go
@@ -23,11 +23,11 @@ func fakes(t *testing.T, list []*agent.Agent, isWired map[string]bool, failing m
 	t.Helper()
 	var did []string
 	wasAgents, wasWired, wasDisconnect := agents, wired, disconnectOne
-	wasFailover, wasPort, wasRestart := endFailover, portRollouts, restartCodexApp
+	wasFailover, wasLeftovers, wasPort, wasRestart := endFailover, endLeftovers, portRollouts, restartCodexApp
 	wasService, wasAutostart, wasShortcut, wasScheme, wasPII, wasExe := removeService, autostartOff, removeShortcut, removeScheme, endPII, executable
 	t.Cleanup(func() {
 		agents, wired, disconnectOne = wasAgents, wasWired, wasDisconnect
-		endFailover, portRollouts, restartCodexApp = wasFailover, wasPort, wasRestart
+		endFailover, endLeftovers, portRollouts, restartCodexApp = wasFailover, wasLeftovers, wasPort, wasRestart
 		removeService, autostartOff, removeShortcut, removeScheme, endPII, executable = wasService, wasAutostart, wasShortcut, wasScheme, wasPII, wasExe
 	})
 	agents = func() []*agent.Agent { return list }
@@ -41,6 +41,7 @@ func fakes(t *testing.T, list []*agent.Agent, isWired map[string]bool, failing m
 		return nil
 	}
 	endFailover = func() (bool, error) { did = append(did, "failover"); return true, nil }
+	endLeftovers = func() (bool, error) { did = append(did, "leftovers"); return false, nil }
 	portRollouts = func(time.Duration) { did = append(did, "rollouts") }
 	restartCodexApp = func(context.Context, time.Duration) (int, bool, error) {
 		did = append(did, "codex app")
@@ -89,7 +90,7 @@ func TestRunOrder(t *testing.T) {
 
 	r := Run(context.Background())
 
-	want := []string{"service", "autostart", "shortcut", "scheme", "pii", "failover", "disconnect codex", "disconnect claude", "rollouts", "codex app"}
+	want := []string{"service", "autostart", "shortcut", "scheme", "pii", "failover", "disconnect codex", "disconnect claude", "leftovers", "rollouts", "codex app"}
 	if !slices.Equal(*did, want) {
 		t.Fatalf("did %q, want %q", *did, want)
 	}
@@ -140,6 +141,37 @@ func TestRunCodexAppLeft(t *testing.T) {
 	}
 }
 
+// What no Disconnect could name (the marks gone with magpie's folder) goes
+// even with no agent connected, says so, and restarts the Codex app's
+// app-server for it alone; one that can't be taken is said.
+func TestRunTakesCodexLeftovers(t *testing.T) {
+	t.Run("taken", func(t *testing.T) {
+		did := fakes(t, nil, map[string]bool{}, nil)
+		endLeftovers = func() (bool, error) { return true, nil }
+		r := Run(context.Background())
+		if !slices.Contains(*did, "codex app") {
+			t.Fatalf("the Codex app not restarted for its leftovers alone: %q", *did)
+		}
+		if len(r.Agents) != 1 || r.Agents[0].What != "Codex's leftover settings" || r.Agents[0].Err != "" {
+			t.Fatalf("agents %+v", r.Agents)
+		}
+	})
+	t.Run("failed", func(t *testing.T) {
+		fakes(t, nil, map[string]bool{}, nil)
+		endLeftovers = func() (bool, error) { return false, errors.New("config.toml: permission denied") }
+		r := Run(context.Background())
+		if r.CodexApp {
+			t.Fatal("the Codex app restarted over a leftover that failed")
+		}
+		if !r.Failed() {
+			t.Fatal("not failed")
+		}
+		if says := strings.Join(r.Says(), "\n"); !strings.Contains(says, "! disconnected Codex's leftover settings: config.toml: permission denied") {
+			t.Fatalf("says:\n%s", says)
+		}
+	})
+}
+
 // Skills and servers the user's agents use from the Library stay; the
 // rest of magpie's folder goes.
 func TestDataKeepsLibraryInUse(t *testing.T) {
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: fix/3866-codex-baseurl-uninstall (head d7affd027e00dc84f8d0a5bde4d28cdb7a6c00a9)
