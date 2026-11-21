Takes the six restore paths this issue names off the shape #4258's fix took out of Claude and Codex: the stashed originals are read with `peek` and taken out only once the write that puts them back has gone through, so a write that fails there (a full disk, a file a watcher held) leaves them stashed for the next try.

**What changed** (six files in `internal/agent`):

- agy — `migrate`, the restore write a start runs to move an older magpie's wiring out of settings.json, reads its pair with `peek`; each original is taken out only once its own `put` has gone through.
- antigravity — `leave` peeks the gateway, the model list and the catalog, writes the three back, then takes them out; the model is peeked just before its own write.
- ante — `unwire` peeks the provider and model pair and takes them out after both writes have gone through. Its made-file marks (`…:new`) go once the removal they gate has gone through, where they were taken before any removal — a file still holding the user's things keeps its mark now.
- astrbot — `unwire` peeks the pick and takes it out once `setPick` has gone through.
- cline — `restoreState` peeks the state snapshot, the secret and the marker, and takes them out only once the whole restore has gone through: the state is put back by two writes, the state file then the secrets, so a retry that had lost the snapshot would restore the state file from nothing, wiping what a first write had put back. `restore` does the same for the provider entry, the model list and the provider in use.
- claudedesktop — `desktopOff` peeks the deployment modes, the applied profile, the entry, the made files and the carried locale at the top and takes them out once the whole off has gone through; `desktopUncarryMCP` takes the carried MCP servers out once their write has gone through, and still gives them up where the user changed them since or the config is gone, as it did when it took them up front.

Every take-out goes through `forgetValues`, so a value written since — here or by another magpie — stays stashed. Nothing else changes: a file that doesn't parse is still copied aside, a pick the user made since still stands.

**Siblings**: `rg -n "unstash\(" internal/agent` → 40 files. Changed: every `unstash` site in the disconnect/restore paths of the six agents this issue lists — 18 sites in the six files. Left, outside this issue's list: the same take-out-before-put-back shape is still in other restore writes the scan shows — gemini's `unroute`, grokapp's `releaseRoute` and qwenpaw's `unwire` are the ones I read and confirmed, the scan lists a similar shape in minimax, paimon, snow, muse, empryo, nanobot, tuanjiecowork, miniq, hermes, dsh, omp, vscode, zoocode, kimi, penguin, jcode, vibe, openclaw, zed, morph, qwen, droid, craftagents, obsidian and qoder, and the shared `Disconnect`'s `connect.was` (`applied.go:951`) and Claude Desktop's on-path profile write-back (`desktopOn`) read the same way. A follow-up issue could take them the same way; they need a fixture and a red each, which would have made this one unreviewable.

**Red without the fix** (base `75f872ef1`; the one-file ablations ran at `80a315a70`, the eight files of this patch unchanged between the two): with only one product file reverted and the test kept, each new subtest fails at its stash assertion — `the stash lost "vertex"` (agy), `"gateway.cymbal.com"` (antigravity), `"together"` (ante), `astrbot.provider_id` (astrbot), `the extension's state` (cline), `"\"1p\""` (claudedesktop); with all six reverted at this head, all six fail. With the fix: `ok`.

**Verification**:
| Check | Command | Result |
| --- | --- | --- |
| Red, one file ablated | `go test ./internal/agent -run TestDisconnectFailureKeepsStashedOriginals/<agent>`, only that product file reverted, test kept | each of the six fails at its stash assertion |
| Red, all six ablated | same run, all six product files reverted, at this head | all six fail (`the stash lost …`) |
| Green | `go test -tags nogui ./internal/agent -run TestDisconnectFailureKeepsStashedOriginals -count=1` at this head | `ok`, all eight subtests — the two of #4258 and the six new |
| Package | `go test -tags nogui ./internal/agent -count=1 -timeout 25m` at this head | one failure, `TestMothX`, which fails the same on the base detached (`mothx_test.go:154`), untouched here |
| Race | `go test -race -tags nogui ./internal/agent -run TestDisconnectFailureKeepsStashedOriginals -count=1` at this head | `ok` |
| Vet, fmt | `go vet ./internal/agent`, `gofmt -l internal/agent` | clean |
| Builds | `go build -tags nogui .`, `GOOS=linux go build -tags nogui .`, `GOOS=windows go build .` | ok |
| Replay | `git am` of the patch below on `75f872ef1` | tree `3864c2b15068482890f0373811ec9ad13d9896dd`, the branch's tree |

**Not verified**: real agents on real machines; the Windows and WSL paths of the six agents (cross-built only).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [hunt-20261114-6601](https://github.com/ggbdpq/magpie/tree/hunt-20261114-6601) (head `6d22a8130384d6b70796ea1b86471a479223faab`).

**Patch**: <details><summary>patch: agent: a restore write that fails leaves the other agents' originals stashed (#6601) — git am applies it as is; SHA-256 first 16: 71651545d2929fb2</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 14 Nov 2026 17:37:16 +0800
Subject: [PATCH] agent: a restore write that fails leaves the other agents'
 originals stashed
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

#6601, the shape #4258's fix took out of Claude and Codex, in the restore
paths it left: agy, antigravity, ante, astrbot, cline and Claude Desktop
took the stashed originals out of the stash before the write that puts
them back, so a write that failed there (a full disk, a file a watcher
held) lost them for good, and a retry had nothing to put back.

The originals are read with peek and taken out only once the write that
replaces them has gone through, each only while it is still the value
peeked: one a concurrent change wrote since stays stashed. Ante's
made-file marks go once the removal they gate has gone through, and a
file still holding the user's things keeps its mark now, where it was
taken before any removal. Cline's extension state is put back by two
writes, the state file then the secrets, so its snapshot is taken out
only once the whole restore has gone through: a retry that had lost it
would restore the state file from nothing, wiping what a first write had
put back. Claude Desktop's off puts the deployment modes, the applied
profile, the entry and the files magpie made back in several writes: they
go once the whole off has gone through, and the MCP servers it carried
out go once their write has, or with it where the user changed them
since.

agy's restore write is the migrate a start runs, the next start moving an
older magpie's wiring out of settings.json; its Disconnect has nothing of
the stash to put back, magpie's own file just goes. The same shape on the
wire paths — Claude Desktop's on writing the user's profile back, and the
agents outside this one — is left as it is.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/agy.go                        |  14 +-
 internal/agent/ante.go                       |  26 +-
 internal/agent/antigravity.go                |  16 +-
 internal/agent/astrbot.go                    |   7 +-
 internal/agent/claudedesktop.go              |  39 ++-
 internal/agent/cline.go                      |  38 ++-
 internal/agent/stash_restore_failure_test.go | 310 +++++++++++++++++++
 7 files changed, 420 insertions(+), 30 deletions(-)

diff --git a/internal/agent/agy.go b/internal/agent/agy.go
index b9a4daf3b..74904a429 100644
--- a/internal/agent/agy.go
+++ b/internal/agent/agy.go
@@ -289,12 +289,22 @@ func agyIn(at place) *Agent {
 		if !usesMagpie(m) {
 			return "", nil
 		}
-		if err := put("modelProvider", unstash(stashProvider)); err != nil {
+		// the originals are read and stay stashed until the write that
+		// puts them back has gone through: one that fails leaves them
+		// stashed for the next try (#6601)
+		peeked := peek(stashProvider, stashModel)
+		if err := put("modelProvider", peeked[stashProvider]); err != nil {
 			return m, err
 		}
-		if err := put("model", unstash(stashModel)); err != nil {
+		if v, ok := peeked[stashProvider]; ok {
+			forgetValues(map[string]string{stashProvider: v})
+		}
+		if err := put("model", peeked[stashModel]); err != nil {
 			return m, err
 		}
+		if v, ok := peeked[stashModel]; ok {
+			forgetValues(map[string]string{stashModel: v})
+		}
 		if ms := ownModels(); len(ms) > 0 {
 			return m, edit.SetJSON(path, edit.KV{Path: agyModels, Value: ms})
 		}
diff --git a/internal/agent/ante.go b/internal/agent/ante.go
index 07658d56d..6c2e63299 100644
--- a/internal/agent/ante.go
+++ b/internal/agent/ante.go
@@ -129,23 +129,32 @@ func anteAt(at place) *Agent {
 	// wiring out.
 	unwire := func() error {
 		if get(anteProviderKey) == magpieID {
-			was, mine := unstash(keyProvider), unstash(keyModel)
-			if err := set(anteProviderKey, was); err != nil {
+			// the originals are read and stay stashed until the writes
+			// that put them back have gone through: one that fails
+			// leaves them stashed for the next try (#6601)
+			peeked := peek(keyProvider, keyModel)
+			if err := set(anteProviderKey, peeked[keyProvider]); err != nil {
 				return err
 			}
-			if err := set(anteModelKey, mine); err != nil {
+			if err := set(anteModelKey, peeked[keyModel]); err != nil {
 				return err
 			}
+			forgetValues(peeked)
 		} else {
 			forget(keyProvider, keyModel)
 		}
 		// settings.json holding neither of magpie's keys, and magpie having
-		// made it, is magpie's file to take away
-		if get(anteProviderKey) == "" && get(anteModelKey) == "" && unstash(keyNewSettings) != "" {
+		// made it, is magpie's file to take away. The made-file marks are
+		// read and stay stashed until the removal they gate has gone
+		// through: one that fails leaves the mark for the next try (#6601)
+		marked := peek(keyNewSettings, keyNew)
+		newSettings, newFile := marked[keyNewSettings] != "", marked[keyNew] != ""
+		if get(anteProviderKey) == "" && get(anteModelKey) == "" && newSettings {
 			if raw, err := edit.Read(settingsPath); err == nil && len(gjson.ParseBytes(raw).Map()) == 0 {
 				if err := edit.Remove(settingsPath); err != nil {
 					return err
 				}
+				forget(keyNewSettings)
 			}
 		}
 		if !isFile(path) {
@@ -164,9 +173,12 @@ func anteAt(at place) *Agent {
 			}
 		}
 		// a file magpie made goes with its last entry
-		if unstash(keyNew) != "" {
+		if newFile {
 			if raw, err := edit.Read(path); err == nil && len(gjson.ParseBytes(raw).Map()) == 0 {
-				return edit.Remove(path)
+				if err := edit.Remove(path); err != nil {
+					return err
+				}
+				forget(keyNew)
 			}
 		}
 		return nil
diff --git a/internal/agent/antigravity.go b/internal/agent/antigravity.go
index e9921672b..435fdd91a 100644
--- a/internal/agent/antigravity.go
+++ b/internal/agent/antigravity.go
@@ -207,20 +207,26 @@ func (f agyFile) connect(ref string) error {
 // what they had (""); a file not there is made for v only when always
 func (f agyFile) leave(v string, always bool) error {
 	if f.wired() {
-		// back to what the user had
-		if err := f.putRaw("gateway", unstash(f.stashGateway)); err != nil {
+		// back to what the user had; the originals are read and stay
+		// stashed until the write that puts them back has gone through:
+		// one that fails leaves them stashed for the next try (#6601)
+		peeked := peek(f.stashGateway, f.stashList, f.stashSrc)
+		if err := f.putRaw("gateway", peeked[f.stashGateway]); err != nil {
 			return err
 		}
-		if err := f.putRaw(antigravityList, unstash(f.stashList)); err != nil {
+		if err := f.putRaw(antigravityList, peeked[f.stashList]); err != nil {
 			return err
 		}
-		if err := f.putRaw(antigravitySource, unstash(f.stashSrc)); err != nil {
+		if err := f.putRaw(antigravitySource, peeked[f.stashSrc]); err != nil {
 			return err
 		}
+		forgetValues(peeked)
 		if v == "" {
-			if err := f.putRaw(antigravityModel, unstash(f.stashModel)); err != nil {
+			was := peek(f.stashModel)
+			if err := f.putRaw(antigravityModel, was[f.stashModel]); err != nil {
 				return err
 			}
+			forgetValues(was)
 			return antigravityTidy(f.path)
 		}
 		forget(f.stashModel)
diff --git a/internal/agent/astrbot.go b/internal/agent/astrbot.go
index 9ac48a261..745a2131d 100644
--- a/internal/agent/astrbot.go
+++ b/internal/agent/astrbot.go
@@ -203,9 +203,14 @@ func astrbotAt(at place) *Agent {
 			return nil
 		}
 		if ours() {
-			if err := setPick(unstash(keyPick)); err != nil {
+			// the original is read and stays stashed until the write that
+			// puts it back has gone through: one that fails leaves it
+			// stashed for the next try (#6601)
+			peeked := peek(keyPick)
+			if err := setPick(peeked[keyPick]); err != nil {
 				return err
 			}
+			forgetValues(peeked)
 		} else {
 			forget(keyPick)
 		}
diff --git a/internal/agent/claudedesktop.go b/internal/agent/claudedesktop.go
index 1cb1b9ed0..1864f57e9 100644
--- a/internal/agent/claudedesktop.go
+++ b/internal/agent/claudedesktop.go
@@ -905,15 +905,22 @@ func desktopCarryMCP(p desktopPaths) error {
 
 // desktopUncarryMCP takes the servers desktopCarryMCP copied out of
 // Claude-3p again, each only while it is still as copied: one the user
-// changed since is theirs. An mcpServers left empty goes with them.
+// changed since is theirs. An mcpServers left empty goes with them. The
+// copy is read and stays stashed until the write that takes the servers
+// out has gone through: one that fails leaves it stashed for the next
+// try (#6601); one the user changed since, or a config gone, is given up
+// as it was when it was taken out up front.
 func desktopUncarryMCP(p desktopPaths) error {
-	prev := unstash(desktopMCP + p.key)
+	peeked := peek(desktopMCP + p.key)
+	prev := peeked[desktopMCP+p.key]
 	var carried map[string]json.RawMessage
 	if prev == "" || json.Unmarshal([]byte(prev), &carried) != nil || len(carried) == 0 {
+		forgetValues(peeked)
 		return nil
 	}
 	have := desktopServers(p.config3p)
 	if have == nil {
+		forgetValues(peeked)
 		return nil
 	}
 	gone := false
@@ -924,12 +931,21 @@ func desktopUncarryMCP(p desktopPaths) error {
 		}
 	}
 	if !gone {
+		forgetValues(peeked)
 		return nil
 	}
 	if len(have) == 0 {
-		return edit.DelJSON(p.config3p, "mcpServers")
+		if err := edit.DelJSON(p.config3p, "mcpServers"); err != nil {
+			return err
+		}
+		forgetValues(peeked)
+		return nil
 	}
-	return edit.SetJSON(p.config3p, edit.KV{Path: "mcpServers", Value: have})
+	if err := edit.SetJSON(p.config3p, edit.KV{Path: "mcpServers", Value: have}); err != nil {
+		return err
+	}
+	forgetValues(peeked)
+	return nil
 }
 
 func desktopSameJSON(a, b json.RawMessage) bool {
@@ -1005,10 +1021,14 @@ func desktopOff(p desktopPaths) error {
 		return err
 	}
 	k := p.key
-	stashed := unstash(desktopStashed+k) != ""
-	mode, mode3p, applied := unstash(desktopMode+k), unstash(desktopMode3p+k), unstash(desktopApplied+k)
+	// the originals are read and stay stashed until the writes that put
+	// them back have gone through: one that fails leaves them stashed for
+	// the next try (#6601)
+	peeked := peek(desktopStashed+k, desktopMode+k, desktopMode3p+k, desktopApplied+k, desktopMade+k, desktopLocale+k)
+	stashed := peeked[desktopStashed+k] != ""
+	mode, mode3p, applied := peeked[desktopMode+k], peeked[desktopMode3p+k], peeked[desktopApplied+k]
 	var made []string
-	if m := unstash(desktopMade + k); m != "" {
+	if m := peeked[desktopMade+k]; m != "" {
 		made = strings.Split(m, "\n")
 	}
 	if !stashed && !slices.ContainsFunc(entries, desktopOurs) {
@@ -1076,7 +1096,7 @@ func desktopOff(p desktopPaths) error {
 
 	// Claude-3p's config.json magpie made only to carry the language:
 	// gone again when it still holds nothing but that language
-	if loc := unstash(desktopLocale + k); loc != "" && slices.Contains(made, p.app3p) {
+	if loc := peeked[desktopLocale+k]; loc != "" && slices.Contains(made, p.app3p) {
 		if b, err := os.ReadFile(p.app3p); err == nil {
 			var m map[string]json.RawMessage
 			var only string
@@ -1101,6 +1121,9 @@ func desktopOff(p desktopPaths) error {
 			os.Remove(f)
 		}
 	}
+	// what was put back and taken away is taken out of the stash once the
+	// whole off has gone through (#6601)
+	forgetValues(peeked)
 	return nil
 }
 
diff --git a/internal/agent/cline.go b/internal/agent/cline.go
index e2154c48c..d8610b903 100644
--- a/internal/agent/cline.go
+++ b/internal/agent/cline.go
@@ -110,7 +110,13 @@ func clineIn(at place) *Agent {
 	// restoreState puts back the extension's state from before magpie;
 	// magpie's keys go when nothing was stashed
 	restoreState := func() error {
-		saved, secret, stated := unstash(key+"state"), unstash(key+"secret"), unstash(key+"stated")
+		// the originals are read and stay stashed until the writes that
+		// put them back have gone through: one that fails leaves them
+		// stashed for the next try (#6601) — a retry reads the state's
+		// snapshot again, so it is taken out with the rest only once the
+		// whole restore has gone through
+		peeked := peek(key+"state", key+"secret", key+"stated")
+		saved, secret, stated := peeked[key+"state"], peeked[key+"secret"], peeked[key+"stated"]
 		if stated == "" && !stateOnMagpie() {
 			return nil
 		}
@@ -120,12 +126,18 @@ func clineIn(at place) *Agent {
 			}
 		}
 		if _, err := os.Stat(secrets); err != nil {
+			forgetValues(peeked)
 			return nil
 		}
 		if secret != "" {
-			return edit.SetJSON(secrets, edit.KV{Path: "openAiApiKey", Value: secret})
+			if err := edit.SetJSON(secrets, edit.KV{Path: "openAiApiKey", Value: secret}); err != nil {
+				return err
+			}
+		} else if err := edit.DelJSON(secrets, "openAiApiKey"); err != nil {
+			return err
 		}
-		return edit.DelJSON(secrets, "openAiApiKey")
+		forgetValues(peeked)
+		return nil
 	}
 	// restore puts back the openai-compatible provider and the provider in
 	// use the user had before magpie
@@ -133,8 +145,12 @@ func clineIn(at place) *Agent {
 		if err := restoreState(); err != nil {
 			return err
 		}
-		entry, last := unstash(key+"entry"), unstash(key+"lastUsedProvider")
-		if list := unstash(key + "models"); list != "" {
+		// the originals are read and stay stashed until the write that
+		// puts them back has gone through: one that fails leaves them
+		// stashed for the next try (#6601)
+		peeked := peek(key+"entry", key+"lastUsedProvider", key+"models")
+		entry, last := peeked[key+"entry"], peeked[key+"lastUsedProvider"]
+		if list := peeked[key+"models"]; list != "" {
 			if err := edit.SetJSON(models, edit.KV{Path: "providers." + clineSlot, Value: json.RawMessage(list)}); err != nil {
 				return err
 			}
@@ -149,9 +165,17 @@ func clineIn(at place) *Agent {
 			return err
 		}
 		if last != "" {
-			return edit.SetJSON(path, edit.KV{Path: "lastUsedProvider", Value: last})
+			if err := edit.SetJSON(path, edit.KV{Path: "lastUsedProvider", Value: last}); err != nil {
+				return err
+			}
+			forgetValues(peeked)
+			return nil
 		}
-		return edit.DelJSON(path, "lastUsedProvider")
+		if err := edit.DelJSON(path, "lastUsedProvider"); err != nil {
+			return err
+		}
+		forgetValues(peeked)
+		return nil
 	}
 	// own is the provider a model or effort of Cline's own is set on: the
 	// one in use, else Cline's default
diff --git a/internal/agent/stash_restore_failure_test.go b/internal/agent/stash_restore_failure_test.go
index 9d7929d81..85037e24b 100644
--- a/internal/agent/stash_restore_failure_test.go
+++ b/internal/agent/stash_restore_failure_test.go
@@ -9,6 +9,7 @@ import (
 	"testing"
 
 	"github.com/yetone/magpie/internal/edit"
+	"github.com/yetone/magpie/internal/provider"
 )
 
 // failRestoreOnce makes the write that carries marker fail once: where the
@@ -146,4 +147,313 @@ func TestDisconnectFailureKeepsStashedOriginals(t *testing.T) {
 			t.Fatalf("the concurrent key went with the retry: %q", stashShared()["concurrent.probe"])
 		}
 	})
+
+	// #6601: the same shape in the other agents' restore paths — the
+	// originals come out of the stash only once the write that puts them
+	// back has gone through, so a write that fails leaves them for the
+	// next try.
+	t.Run("agy", func(t *testing.T) {
+		home := t.TempDir()
+		t.Setenv("HOME", home)
+		t.Setenv("USERPROFILE", home)
+		t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+		t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+		if err := provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k", Models: []string{"pro", "flash"}}); err != nil {
+			t.Fatal(err)
+		}
+		path := filepath.Join(home, ".gemini", "antigravity-cli", "settings.json")
+		os.MkdirAll(filepath.Dir(path), 0o755)
+		// wired by an older magpie: its model and provider in settings.json
+		// itself, the user's own stashed for the move out
+		os.WriteFile(path, []byte(`{"model": "magpie/deepseek/pro", "modelProvider": "gemini", "customModelsConfig": {"customModels": {"mine": {"apiProvider": "API_PROVIDER_ANTHROPIC", "modelName": "claude-sonnet-4-5"}, "magpie/deepseek/pro": {"apiProvider": "API_PROVIDER_GOOGLE_GEMINI", "modelName": "deepseek/pro"}}}}`), 0o644)
+		stash(map[string]string{"agy:" + path + ":model": "mine", "agy:" + path + ":modelProvider": "vertex"})
+		a := agy(home)
+
+		// the restore write is the migrate a start runs: the next start
+		// moves an older magpie's wiring out of settings.json
+		injected, err := failRestoreOnce(t, path, "vertex", a.Sync)
+		if !injected {
+			t.Fatal("no write carried the user's provider back")
+		}
+		if err == nil {
+			t.Fatal("the restore write failed but Sync said it went through")
+		}
+		stashHolds(t, "vertex", "mine")
+
+		if err := os.WriteFile(path, []byte(`{"model": "magpie/deepseek/pro", "modelProvider": "gemini", "customModelsConfig": {"customModels": {"mine": {"apiProvider": "API_PROVIDER_ANTHROPIC", "modelName": "claude-sonnet-4-5"}, "magpie/deepseek/pro": {"apiProvider": "API_PROVIDER_GOOGLE_GEMINI", "modelName": "deepseek/pro"}}}}`), 0o644); err != nil {
+			t.Fatal(err)
+		}
+		stash(map[string]string{"concurrent.probe": "keep"})
+		if err := a.Sync(); err != nil {
+			t.Fatalf("the retry: %v", err)
+		}
+		body, err := os.ReadFile(path)
+		if err != nil {
+			t.Fatal(err)
+		}
+		for _, w := range []string{"vertex", "claude-sonnet-4-5"} {
+			if !strings.Contains(string(body), w) {
+				t.Fatalf("the retry lost %q:\n%s", w, body)
+			}
+		}
+		if strings.Contains(string(body), "magpie/deepseek") {
+			t.Fatalf("the retry left magpie's behind:\n%s", body)
+		}
+		if stashShared()["concurrent.probe"] != "keep" {
+			t.Fatalf("the concurrent key went with the retry: %q", stashShared()["concurrent.probe"])
+		}
+	})
+
+	t.Run("antigravity", func(t *testing.T) {
+		home := antigravityHome(t)
+		path := filepath.Join(home, ".antigravity", "settings.json")
+		os.MkdirAll(filepath.Dir(path), 0o755)
+		os.WriteFile(path, []byte(antigravityUser), 0o600)
+		a := antigravity(home)
+		if err := a.Apply("model", "magpie/anth/claude-sonnet-5"); err != nil {
+			t.Fatal(err)
+		}
+		wired, err := os.ReadFile(path)
+		if err != nil {
+			t.Fatal(err)
+		}
+
+		injected, err := failRestoreOnce(t, path, "gateway.cymbal.com", a.Disconnect)
+		if !injected {
+			t.Fatal("no write carried the user's gateway back")
+		}
+		if err == nil {
+			t.Fatal("the restore write failed but Disconnect said it went through")
+		}
+		stashHolds(t, "gateway.cymbal.com", "gemini-3.8-flash")
+
+		if err := os.WriteFile(path, wired, 0o600); err != nil {
+			t.Fatal(err)
+		}
+		stash(map[string]string{"concurrent.probe": "keep"})
+		if err := a.Disconnect(); err != nil {
+			t.Fatalf("the retry: %v", err)
+		}
+		body, err := os.ReadFile(path)
+		if err != nil {
+			t.Fatal(err)
+		}
+		for _, w := range []string{"gateway.cymbal.com", "gemini-3.8-flash"} {
+			if !strings.Contains(string(body), w) {
+				t.Fatalf("the retry lost %q:\n%s", w, body)
+			}
+		}
+		if stashShared()["concurrent.probe"] != "keep" {
+			t.Fatalf("the concurrent key went with the retry: %q", stashShared()["concurrent.probe"])
+		}
+	})
+
+	t.Run("ante", func(t *testing.T) {
+		home, _, settings := anteHome(t)
+		a := ante(home)
+		if err := a.Connect(); err != nil {
+			t.Fatal(err)
+		}
+		wired, err := os.ReadFile(settings)
+		if err != nil {
+			t.Fatal(err)
+		}
+
+		injected, err := failRestoreOnce(t, settings, "together", a.Disconnect)
+		if !injected {
+			t.Fatal("no write carried the user's provider back")
+		}
+		if err == nil {
+			t.Fatal("the restore write failed but Disconnect said it went through")
+		}
+		stashHolds(t, "together", "moonshotai/Kimi-K2-Instruct")
+
+		if err := os.WriteFile(settings, wired, 0o644); err != nil {
+			t.Fatal(err)
+		}
+		stash(map[string]string{"concurrent.probe": "keep"})
+		if err := a.Disconnect(); err != nil {
+			t.Fatalf("the retry: %v", err)
+		}
+		body, err := os.ReadFile(settings)
+		if err != nil {
+			t.Fatal(err)
+		}
+		for _, w := range []string{"together", "moonshotai/Kimi-K2-Instruct"} {
+			if !strings.Contains(string(body), w) {
+				t.Fatalf("the retry lost %q:\n%s", w, body)
+			}
+		}
+		if stashShared()["concurrent.probe"] != "keep" {
+			t.Fatalf("the concurrent key went with the retry: %q", stashShared()["concurrent.probe"])
+		}
+	})
+
+	t.Run("astrbot", func(t *testing.T) {
+		home, path := astrbotHome(t, astrbotConfig)
+		a := astrbot(home)
+		if err := a.Pick("model", "magpie/kimi/k2"); err != nil {
+			t.Fatal(err)
+		}
+		wired, err := os.ReadFile(path)
+		if err != nil {
+			t.Fatal(err)
+		}
+		// the entry the restore puts back: the pick itself, whose value
+		// also stands in connect.was — so the entry is named by its key
+		picked := ""
+		for k, v := range stashShared() {
+			if strings.Contains(k, "provider_id") && v == "deepseek/deepseek-chat" {
+				picked = k
+			}
+		}
+		if picked == "" {
+			t.Fatalf("the user's pick is not stashed: %v", stashShared())
+		}
+
+		injected, err := failRestoreOnce(t, path, "deepseek/deepseek-chat", a.Disconnect)
+		if !injected {
+			t.Fatal("no write carried the user's pick back")
+		}
+		if err == nil {
+			t.Fatal("the restore write failed but Disconnect said it went through")
+		}
+		if stashShared()[picked] != "deepseek/deepseek-chat" {
+			t.Fatalf("the stash lost the user's pick (%s): %v", picked, stashShared())
+		}
+
+		if err := os.WriteFile(path, wired, 0o644); err != nil {
+			t.Fatal(err)
+		}
+		stash(map[string]string{"concurrent.probe": "keep"})
+		if err := a.Disconnect(); err != nil {
+			t.Fatalf("the retry: %v", err)
+		}
+		body, err := os.ReadFile(path)
+		if err != nil {
+			t.Fatal(err)
+		}
+		if string(body) != astrbotConfig {
+			t.Fatalf("the retry left:\n%s", body)
+		}
+		if stashShared()["concurrent.probe"] != "keep" {
+			t.Fatalf("the concurrent key went with the retry: %q", stashShared()["concurrent.probe"])
+		}
+	})
+
+	t.Run("cline", func(t *testing.T) {
+		home := t.TempDir()
+		t.Setenv("HOME", home)
+		t.Setenv("USERPROFILE", home)
+		t.Setenv("CLINE_DIR", "")
+		t.Setenv("CLINE_DATA_DIR", "")
+		t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+		t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+		if err := provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k", Models: []string{"pro", "flash"}}); err != nil {
+			t.Fatal(err)
+		}
+		data := filepath.Join(home, ".cline", "data")
+		path := filepath.Join(data, "settings", "providers.json")
+		modelsPath := filepath.Join(data, "settings", "models.json")
+		statePath, secretsPath := filepath.Join(data, "globalState.json"), filepath.Join(data, "secrets.json")
+		os.MkdirAll(filepath.Dir(path), 0o700)
+		os.WriteFile(modelsPath, []byte(`{"version":1,"providers":{"openai-compatible":{"provider":{"name":"OpenAI Compatible","baseUrl":"https://x/v1","defaultModelId":"mine"},"models":{"mine":{"id":"mine","name":"mine"}}},"ollama":{"models":{"q":{"id":"q"}}}}}`), 0o600)
+		os.WriteFile(path, []byte(`{"version":1,"lastUsedProvider":"anthropic","modes":{},"providers":{
+  "anthropic":{"settings":{"provider":"anthropic","apiKey":"sk-a","model":"claude-opus-5","reasoning":{"effort":"high"}},"updatedAt":"2026-09-01T00:00:00.000Z","tokenSource":"manual"},
+  "openai-compatible":{"settings":{"provider":"openai-compatible","apiKey":"sk-o","model":"mine","baseUrl":"https://x/v1"},"updatedAt":"2026-09-01T00:00:00.000Z","tokenSource":"manual"}}}`), 0o600)
+		os.WriteFile(statePath, []byte(`{"actModeApiProvider":"anthropic","planModeApiProvider":"anthropic","actModeOpenAiModelId":"mine",`+
+			`"actModeOpenAiModelInfo":{"maxTokens":10},"openAiBaseUrl":"https://x/v1","telemetrySetting":"disabled"}`), 0o600)
+		os.WriteFile(secretsPath, []byte(`{"openAiApiKey":"sk-o","anthropicApiKey":"sk-a"}`), 0o600)
+		a := cline(home)
+		if err := a.Apply("model", "magpie/deepseek/pro"); err != nil {
+			t.Fatal(err)
+		}
+		wired, err := os.ReadFile(statePath)
+		if err != nil {
+			t.Fatal(err)
+		}
+		// the entries the restore puts back, named by their keys: the
+		// stashed entry and secret also carry the state's own markers
+		keys := []string{"state", "secret", "stated"}
+		for _, k := range keys {
+			if stashShared()["cline:"+path+":"+k] == "" {
+				t.Fatalf("the extension's %s is not stashed: %v", k, stashShared())
+			}
+		}
+
+		injected, err := failRestoreOnce(t, statePath, "https://x/v1", a.Disconnect)
+		if !injected {
+			t.Fatal("no write carried the extension's state back")
+		}
+		if err == nil {
+			t.Fatal("the restore write failed but Disconnect said it went through")
+		}
+		for _, k := range keys {
+			if stashShared()["cline:"+path+":"+k] == "" {
+				t.Fatalf("the stash lost the extension's %s: %v", k, stashShared())
+			}
+		}
+
+		if err := os.WriteFile(statePath, wired, 0o644); err != nil {
+			t.Fatal(err)
+		}
+		stash(map[string]string{"concurrent.probe": "keep"})
+		if err := a.Disconnect(); err != nil {
+			t.Fatalf("the retry: %v", err)
+		}
+		body, err := os.ReadFile(statePath)
+		if err != nil {
+			t.Fatal(err)
+		}
+		if !strings.Contains(string(body), "https://x/v1") {
+			t.Fatalf("the retry lost the extension's state:\n%s", body)
+		}
+		providers, err := os.ReadFile(path)
+		if err != nil {
+			t.Fatal(err)
+		}
+		if !strings.Contains(string(providers), `"anthropic"`) {
+			t.Fatalf("the retry lost the provider in use:\n%s", providers)
+		}
+		if stashShared()["concurrent.probe"] != "keep" {
+			t.Fatalf("the concurrent key went with the retry: %q", stashShared()["concurrent.probe"])
+		}
+	})
+
+	t.Run("claudedesktop", func(t *testing.T) {
+		home, p := desktopSandbox(t)
+		desktopWrite(t, p.config, `{"deploymentMode":"1p","preferences":{"x":1}}`)
+		desktopWrite(t, p.config3p, `{"deploymentMode":"1p","preferences":{"x":1}}`)
+		a := claudeDesktop(home)
+		if err := a.Field("provider").Set("magpie"); err != nil {
+			t.Fatal(err)
+		}
+		wired, err := os.ReadFile(p.config)
+		if err != nil {
+			t.Fatal(err)
+		}
+
+		injected, err := failRestoreOnce(t, p.config, `"1p"`, func() error { return a.Field("provider").Set("") })
+		if !injected {
+			t.Fatal("no write carried the user's mode back")
+		}
+		if err == nil {
+			t.Fatal("the restore write failed but Disconnect said it went through")
+		}
+		stashHolds(t, `"1p"`)
+
+		if err := os.WriteFile(p.config, wired, 0o644); err != nil {
+			t.Fatal(err)
+		}
+		stash(map[string]string{"concurrent.probe": "keep"})
+		if err := a.Field("provider").Set(""); err != nil {
+			t.Fatalf("the retry: %v", err)
+		}
+		if m := desktopJSON(t, p.config); m["deploymentMode"] != "1p" {
+			t.Fatalf("the retry left: %v", m)
+		}
+		if stashShared()["concurrent.probe"] != "keep" {
+			t.Fatalf("the concurrent key went with the retry: %q", stashShared()["concurrent.probe"])
+		}
+	})
 }
-- 
2.50.1 (Apple Git-155)

```

</details>
