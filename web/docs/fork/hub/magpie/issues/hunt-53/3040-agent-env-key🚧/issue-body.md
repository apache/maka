## Summary

Droid's custom model `apiKey` (`~/.factory/settings.json`) and an OpenCode-shaped agent's `provider.magpie.options.apiKey` (`~/.config/opencode/opencode.json`; the same `Check` serves OpenCode, MiMo Code and DevEco Code) were compared with the value as written. A user who keeps magpie's key out of the file with a reference to a variable — Droid's `"${MAGPIE_API_KEY}"`, OpenCode's `"{env:MAGPIE_API_KEY}"` — got "…'s apiKey … was changed, so magpie's gateway won't take its requests" from Check, and a sync or a pick wrote magpie's literal key over the reference. Check now reads the key the reference names the way the agent itself does, and a sync keeps the reference while it holds — or while magpie can't see the variable. The same shape Hermes got in b9d1cd36f, whose body named these two as the siblings it left out.

## Cause

Both agents expand references in the key field themselves, from their environment; magpie compared the literal string:

- **Droid** (`internal/agent/droid.go`, `Check`): `wiringOff("Droid", …, "apiKey", at.gwKey())` read the entry's `apiKey` raw. Droid's docs say the field "supports environment variable references using ${VAR_NAME} syntax", read from the environment (`export PROVIDER_API_KEY=…`): [Custom Models (BYOK), docs.factory.com](https://docs.factory.com/model-independence/byok). Droid is closed source; what it expands beyond what the docs say is unverified, so the fix claims only the documented `${VAR_NAME}` form.
- **OpenCode** (`internal/agent/agents.go`, `openCodeLike`'s `Check`): `provider.magpie.options.apiKey` read raw. OpenCode expands `{env:VAR}` from `process.env` as it loads every config file — [`packages/core/src/config/variable.ts` (`substitute`)](https://github.com/sst/opencode/blob/dev/packages/core/src/config/variable.ts), applied to each file in [`packages/core/src/config.ts`](https://github.com/sst/opencode/blob/dev/packages/core/src/config.ts) (`loadFile`); [the docs](https://opencode.ai/docs/config/) document `{env:VARIABLE_NAME}` and, beside it, `{file:path}`. OpenCode 1 expanded the same way ([`packages/opencode/src/config/config.ts`](https://github.com/sst/opencode/blob/63d2b21b8fd89ee11282be7a62479b0ba2ae3f0c/packages/opencode/src/config/config.ts), `load`).

On the sync side, `syncJSONInOrder` (OpenCode) and Droid's `setModels` rewrite would put magpie's literal key in the reference's place.

## Fix

- `envRefKey` (in `gatewaykey.go`, beside `keyHolds`): a value that is one reference to a variable is the variable's value, read from this machine's environment, which is where those agents read it. A variable magpie can't see (one only the agent's own shell sets) is unknown, never drift: Check says nothing about it.
- Droid's and the OpenCode-shaped `Check` read the key through it; a reference that holds (`keyHolds`) stays out of the report.
- `envRefKept`: a sync or a pick keeps the reference when the key it names holds or magpie can't see it; one naming a key the gateway doesn't take is replaced by magpie's key — Hermes's goes into the `.env` its variable reads, these agents have no file to write, so the literal takes the reference's place. A value with more than the one reference in it is magpie's key again, as before.
- One line in `docs/subsystems/agent-wiring.md`, as b9d1cd36f added one for Hermes.

## Verification

| Check | Command | Result |
|---|---|---|
| New tests | `go test ./internal/agent -run 'TestDroidWithAKeyInTheEnvironment\|TestOpenCodeWithAKeyInTheEnvironment' -count=1` | ok (red at base `318697dc`, see below) |
| Neighbors | `go test ./internal/agent -run 'TestDroid\|TestOpenCode\|TestHermes\|TestKeyHolds\|TestGatewayKey\|TestWiring\|TestAir\|TestOpenChamber\|TestMiMo\|TestDevEco\|TestCrush' -count=1` | ok, and again under `-race` |
| Whole package | `go test ./internal/agent/... -count=1 -timeout 30m` | one red, `TestMothX` — red at base with this change's files away too (fails alone there, on this machine), so not this change's |
| Format, vet | `gofmt -l internal/agent`; `go vet ./internal/agent/...`, `GOOS=linux GOARCH=amd64 go vet -tags nogui ./internal/agent/...`, `GOOS=windows go vet ./internal/agent/...` | empty; ok |
| Builds | `go build .`; `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nogui .`; `GOOS=windows GOARCH=amd64 go build .` | all ok |

---
**Source**: the maintainer's own issue #3040 (found while fixing Hermes in b9d1cd36); not reported by a Droid or OpenCode user yet. Each agent's reference form is taken from its own source or docs, linked above.

**Red without the fix** (base `318697dc`): with `internal/agent/droid.go` (for the Droid test) and `internal/agent/agents.go` (for the OpenCode test) reverted and the new tests kept, `go test ./internal/agent -run 'TestDroidWithAKeyInTheEnvironment|TestOpenCodeWithAKeyInTheEnvironment'` fails:
```
--- FAIL: TestDroidWithAKeyInTheEnvironment (0.91s)
    droid_test.go:341: a gateway key in the environment is drift: Droid's apiKey (settings.json) was changed, so magpie's gateway won't take its requests
--- FAIL: TestOpenCodeWithAKeyInTheEnvironment (0.01s)
    opencode_test.go:46: a gateway key in the environment is drift: OpenCode's apiKey (opencode.json) was changed, so magpie's gateway won't take its requests
```
With the fix: `ok`.

**Siblings**: every place magpie compares a key it wrote (`keyHolds`, `wiringOff`), judged by that agent's own docs. Fixed here: Droid (`droid.go`) and the OpenCode-shaped `openCodeLike` (`agents.go`; OpenCode, MiMo Code, DevEco Code — DevEco is an OpenCode fork and MiMo Code shares its shape, so `{env:VAR}` reaches them the same way). Left, same shape — worth issues of their own: **Crush** (`agents.go`, `providers.magpie.api_key` in `crush.json`; its README: "Values support the same `$VAR` and `$(command)` expansion as other config fields", so a literal `$MAGPIE_API_KEY` there is expanded by Crush and compared literally by magpie) and **Air** with **OpenChamber** (`air.go`, `openchamber.go`; their Checks read `provider.magpie.options.apiKey` in an OpenCode config of their own, where OpenCode itself expands `{env:VAR}`). No reference form in the key field magpie writes and checks, per their docs: Hermes (covered by b9d1cd36), Gemini CLI and DeepSeek Harness (their `.env` files hold literal values), Claude Code (settings values are literal; its indirection is the `apiKeyHelper` script), Codex (`auth.json` holds a literal token; its `env_key` names a variable rather than inlining one), Qwen Code, Kimi Code, Grok Build, MiniMax Code, Mister Morph, Muse Code, omp, Pi, fx, Qoder, Goose (literal key fields in JSON/YAML/TOML), Cline (keys in its settings store), Zed (magpie writes it no key; its Check compares only `api_url`). Droid's docs also describe an `apiKeyHelper` script that takes precedence over `apiKey` — outside this fix, which claims only the documented `${VAR_NAME}` form.

**When the read fails**: a variable magpie can't see reads as unknown — Check says nothing and a sync keeps the reference (`TestDroidWithAKeyInTheEnvironment` and `TestOpenCodeWithAKeyInTheEnvironment`, the case named "a variable magpie can't see").

**Not verified**: a real Droid or OpenCode installation reading a referenced key (both were read from docs and, for OpenCode, source at dev `f09eee50`, 2026-10-16); Droid's closed-source expansion beyond the documented `${VAR_NAME}`; Windows; OpenCode's `{file:path}` form, left as it is.

Branch with the commit: [hunt53-g-agent-env-key](https://github.com/ggbdpq/magpie/tree/hunt53-g-agent-env-key) (head `92c48a031`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: agent: Droid's "${VAR}" and OpenCode's {env:VAR} api keys are read as the key they name, not as drift (#3040) — git am applies it as is; SHA-256 first 16: c26695dfd86cc5e1</summary>

```patch
From 92c48a03102a7cf502e6f86b2724c06c3ee8fa62 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 00:07:47 +0800
Subject: [PATCH] agent: Droid's "${VAR}" and OpenCode's {env:VAR} api keys are
 read as the key they name, not as drift (#3040)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The maintainer's own issue, found while fixing Hermes (b9d1cd36), whose
body left the siblings out. Droid's custom model apiKey and an
OpenCode-shaped agent's provider.magpie.options.apiKey were compared
with the value as written, so a user who keeps the key out of the file
with a reference to a variable — Droid's "${MAGPIE_API_KEY}"
(docs.factory.com, Custom Models: "apiKey supports environment variable
references using ${VAR_NAME} syntax", from the environment), OpenCode's
{env:MAGPIE_API_KEY} (its config loader expands it from process.env as
it reads the config, packages/core/src/config/variable.ts; the docs say
the same) — was told the key "was changed, so magpie's gateway won't
take its requests", and a sync or pick wrote magpie's literal key over
the reference.

Now envRefKey reads what the agent sends: a value that is one reference
to a variable is the variable's value, from this machine's environment,
which is where those agents read it (Hermes's .env reading stays
hermesKey's). One that holds (keyHolds) isn't drift, and neither is a
variable magpie can't see (one only the agent's shell sets), which is
unknown, never drift. One naming a key the gateway doesn't take is
drift, and a sync puts magpie's key in its place, a variable of the
shell's being nowhere magpie can write it (Hermes's goes into its .env;
these agents have no file to write, envRefKept). A value with more than
the one reference in it is magpie's key again, as before. OpenCode's
{file:path} form is left as it is. The two helpers sit beside keyHolds,
which both go through, and Droid shares OpenCode's shape of the check.

Test: TestDroidWithAKeyInTheEnvironment and
TestOpenCodeWithAKeyInTheEnvironment, each with the reference naming a
gateway key, magpie's own, an unset variable (unknown: not drift, kept)
and a wrong key, then a composite value.
Broken by hand: with droid.go at 318697dc the Droid one fails "a gateway
key in the environment is drift: Droid's apiKey (settings.json) was
changed"; with only the sync half removed, "a gateway key: the user's
reference was written over". agents.go likewise for OpenCode's.

Run (worktree, macOS arm64, load ~2):
- gofmt -l internal/agent: nothing. go vet ./internal/agent/...,
  GOOS=linux go vet -tags nogui ./internal/agent/... and GOOS=windows go
  vet ./internal/agent/...: ok. go build, GOOS=linux GOARCH=amd64
  -tags nogui and GOOS=windows GOARCH=amd64 builds: ok.
- go test ./internal/agent -run 'TestDroid|TestOpenCode|TestHermes|
  TestKeyHolds|TestGatewayKey|TestWiring|TestAir|TestOpenChamber|
  TestMiMo|TestDevEco|TestCrush': ok. The same family under -race: ok.
- go test ./internal/agent/... -count=1 -timeout 30m: one red,
  TestMothX — red at 318697dc with this change's files away too (it
  fails alone there, on this machine), so not this change's.

Fixes #3040
Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/agent-wiring.md |   1 +
 internal/agent/agents.go        |  48 +++++++++++++--
 internal/agent/droid.go         |  32 +++++++++-
 internal/agent/droid_test.go    | 103 ++++++++++++++++++++++++++++++++
 internal/agent/gatewaykey.go    |  39 ++++++++++++
 internal/agent/opencode_test.go |  90 ++++++++++++++++++++++++++++
 6 files changed, 307 insertions(+), 6 deletions(-)
 create mode 100644 internal/agent/opencode_test.go

diff --git a/docs/subsystems/agent-wiring.md b/docs/subsystems/agent-wiring.md
index 53ce2321..75b9dff8 100644
--- a/docs/subsystems/agent-wiring.md
+++ b/docs/subsystems/agent-wiring.md
@@ -49,6 +49,7 @@ something else shows up as drift.
   - fx keeps `reviewer_model` and a `tool_choice_mode` of `omit`. Its `auth` is magpie's whole, since fx refuses an `env` beside `type: none` (`fxKept`).
   - Hermes keeps the `default_model` that `hermes model` writes there, `key_cmd`, the timeouts, `extra_body`, a name and headers beside magpie's (`hermesKept`). This holds in every profile.
   - Hermes's `api_key` may be a reference, `${VAR}` or `${env:VAR}`, which Hermes expands from the `.env` beside the config (its own or a profile's) and then the environment. `Check` and a sync read the key it names (`hermesKey`): one that holds (`keyHolds`) stays and isn't drift, and so does one naming a variable magpie can't see (only a shell profile sets it), which is unknown. One naming a key the gateway doesn't take is drift, and a sync keeps the reference and writes magpie's key into that `.env` under the variable, made `0600` when there is none (`hermesKeptKey`; PaulT on Discord, `TestHermesWithAKeyInItsEnvFile`). A value with more than the one reference in it is replaced by magpie's key, as before.
+  - Droid's and OpenCode's key may be a reference to a variable too, `${VAR}` (docs.factory.com, Custom Models) and `{env:VAR}` (its config loader, `variable.ts`), each expanded from the environment. `Check` and a sync read the key it names (`envRefKey`): one that holds (`keyHolds`) stays and isn't drift, and so does one naming a variable magpie can't see, which is unknown. One naming a key the gateway doesn't take is drift, and a sync puts magpie's key in its place, a variable of the shell's being nowhere magpie can write it (`envRefKept`; #3040, `TestDroidWithAKeyInTheEnvironment`, `TestOpenCodeWithAKeyInTheEnvironment`). A value with more than the one reference in it is replaced by magpie's key, as before.
   - omp's `models.yml` keeps `modelOverrides`, `discovery`, `disableStrictTools`, headers and compat flags (`ompKept`). Its `auth` and `apiKey` are magpie's, or gone.
   - Kimi Code's `[providers.magpie]` has magpie's three keys set in place, so `custom_headers`, `env` and `default_model` stay (`kimiProvider`).
   - Cline's `models.json` keeps the provider's other keys, and on each model magpie lists what magpie doesn't write, such as a VS Code override (`clineKept`).
diff --git a/internal/agent/agents.go b/internal/agent/agents.go
index 6061e4ec..eed759fb 100644
--- a/internal/agent/agents.go
+++ b/internal/agent/agents.go
@@ -9,6 +9,7 @@ import (
 	"os"
 	"path/filepath"
 	"reflect"
+	"regexp"
 	"runtime"
 	"slices"
 	"sort"
@@ -765,7 +766,7 @@ func openCodeLike(at place, id, name, icon, bin, dir, auth string, ua []string,
 			break
 		}
 	}
-	provider := openCodeKept(path, func() any { return magpieProviderJSONAt("opencode", id, at.gw()) })
+	provider := openCodeKept(path, openCodeValue(at, path, id))
 	opts := func(key string) func(map[string]string) []Option {
 		return func(cur map[string]string) []Option {
 			return append(ownOptions(auth, cur[key]), viaMagpie(id, magpieID+"/")...)
@@ -804,8 +805,25 @@ func openCodeLike(at place, id, name, icon, bin, dir, auth string, ua []string,
 			if !usesMagpie(get("model"), get("small_model")) {
 				return ""
 			}
-			return wiringOff(name, path, func(k string) (string, bool) { return edit.GetJSON(path, "provider."+magpieID+".options."+k) },
-				"baseURL", at.v1(), "apiKey", openCodeKeyAt(id, at.gw()))
+			opt := func(k string) (string, bool) {
+				v, ok := edit.GetJSON(path, "provider."+magpieID+".options."+k)
+				if k != "apiKey" {
+					return v, ok
+				}
+				// a reference to a variable is the key the agent sends,
+				// as OpenCode reads it (envRefKey); one magpie can't see
+				// is unknown, never drift
+				key, ref, known := envRefKey(v, openCodeEnvRef)
+				switch {
+				case ref == "":
+					return v, ok
+				case known:
+					return key, true
+				default:
+					return at.gwKey(), true
+				}
+			}
+			return wiringOff(name, path, opt, "baseURL", at.v1(), "apiKey", openCodeKeyAt(id, at.gw()))
 		},
 		Sync: func() error {
 			// a model of magpie's chosen, but its provider gone from the
@@ -833,6 +851,28 @@ func openCodeKeyAt(id, gw string) string {
 	return keyAt(gw)
 }
 
+// openCodeEnvRef is an apiKey that is one reference to a variable, which
+// OpenCode expands from its environment as it loads the config ({env:VAR},
+// packages/core/src/config/variable.ts, from process.env; the other form
+// it takes there, {file:path}, magpie leaves as it is).
+var openCodeEnvRef = regexp.MustCompile(`^\{env:([^}]+)\}$`)
+
+// openCodeValue is magpie's provider block, as it is now, for an
+// OpenCode-shaped agent (id) whose config is at path, with a reference to
+// a variable the user put in its apiKey kept (envRefKept).
+func openCodeValue(at place, path, id string) func() any {
+	return func() any {
+		v := magpieProviderJSONAt("opencode", id, at.gw())
+		m, _ := v.(map[string]any)
+		o, _ := m["options"].(map[string]any)
+		if k, ok := o["apiKey"].(string); ok {
+			raw, _ := edit.GetJSON(path, "provider."+magpieID+".options.apiKey")
+			o["apiKey"] = envRefKept(raw, k, openCodeEnvRef)
+		}
+		return v
+	}
+}
+
 // openCodeRef is the value that makes the OpenCode config at path (agent
 // id's, whose catalog magpie's provider there lists) send model v. One of
 // magpie's goes to a provider of the file's own that already sends it to
@@ -852,7 +892,7 @@ func openCodeRefAt(at place, path, id, v string) (string, error) {
 	if own := ownGatewayProvider(path, ref, at.v1()); own != "" {
 		return own + "/" + ref, nil
 	}
-	provider := openCodeKept(path, func() any { return magpieProviderJSONAt("opencode", id, at.gw()) })
+	provider := openCodeKept(path, openCodeValue(at, path, id))
 	return v, edit.SetJSON(path, edit.KV{Path: "provider." + magpieID, Value: provider()})
 }
 
diff --git a/internal/agent/droid.go b/internal/agent/droid.go
index e8659cb9..d5ae9a5b 100644
--- a/internal/agent/droid.go
+++ b/internal/agent/droid.go
@@ -23,6 +23,7 @@ package agent
 import (
 	"encoding/json"
 	"path/filepath"
+	"regexp"
 	"slices"
 	"strconv"
 	"strings"
@@ -58,6 +59,12 @@ type droidEntry struct {
 	NoImageSupport bool `json:"noImageSupport"`
 }
 
+// droidEnvRef is an apiKey that is one reference to a variable, which droid
+// expands from its environment as it reads the settings
+// (docs.factory.com, Custom Models: "apiKey supports environment variable
+// references using ${VAR_NAME} syntax").
+var droidEnvRef = regexp.MustCompile(`^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$`)
+
 // droidEntries are magpie's custom models as the catalog is now.
 func droidEntries() []droidEntry { return droidEntriesAt(gateway.URL()) }
 
@@ -163,15 +170,20 @@ func droidIn(at place) *Agent {
 	setModels := func(with bool) error {
 		var ms []any
 		var had bool
+		// keys are the apiKeys the file's magpie entries hold now, a
+		// reference to a variable among them staying (envRefKept)
+		keys := map[string]string{}
 		for _, c := range droidCustoms(path, droidModels) {
 			if strings.HasPrefix(c.id, droidID) {
 				had = true
+				keys[c.id] = gjson.GetBytes(c.raw, "apiKey").String()
 				continue
 			}
 			ms = append(ms, c.raw)
 		}
 		if with {
 			for _, e := range droidEntries() {
+				e.APIKey = envRefKept(keys[e.ID], e.APIKey, droidEnvRef)
 				ms = append(ms, e)
 			}
 		} else if !had {
@@ -237,8 +249,24 @@ func droidIn(at place) *Agent {
 			if r.Get("provider").String() == "anthropic" {
 				base = at.gw()
 			}
-			return wiringOff("Droid", path, func(k string) (string, bool) { g := r.Get(k); return g.String(), g.Exists() },
-				"baseUrl", base, "apiKey", at.gwKey())
+			return wiringOff("Droid", path, func(k string) (string, bool) {
+				g := r.Get(k)
+				if k != "apiKey" {
+					return g.String(), g.Exists()
+				}
+				// a reference to a variable is the key droid sends, as
+				// droid reads it (envRefKey); one magpie can't see is
+				// unknown, never drift
+				key, name, known := envRefKey(g.String(), droidEnvRef)
+				switch {
+				case name == "":
+					return g.String(), g.Exists()
+				case known:
+					return key, true
+				default:
+					return at.gwKey(), true
+				}
+			}, "baseUrl", base, "apiKey", at.gwKey())
 		},
 		Fields: []Field{{
 			Key: "model", Label: "model",
diff --git a/internal/agent/droid_test.go b/internal/agent/droid_test.go
index a63efe23..8790b970 100644
--- a/internal/agent/droid_test.go
+++ b/internal/agent/droid_test.go
@@ -7,6 +7,8 @@ import (
 	"strings"
 	"testing"
 
+	"github.com/yetone/magpie/internal/access"
+	"github.com/yetone/magpie/internal/edit"
 	"github.com/yetone/magpie/internal/gateway"
 	"github.com/yetone/magpie/internal/provider"
 )
@@ -282,3 +284,104 @@ func TestDroidOverrideAndLegacy(t *testing.T) {
 		t.Fatal(err)
 	}
 }
+
+// A user who keeps magpie's key out of settings.json writes the entry's
+// apiKey as a reference to a variable, which droid expands from its
+// environment as it reads the settings (docs.factory.com, Custom Models:
+// "apiKey supports environment variable references using ${VAR_NAME}
+// syntax"). A reference names the key droid sends: one that reaches magpie
+// is not drift and a sync keeps it; one magpie can't see is unknown, kept
+// and not drift; one naming a key the gateway doesn't take is drift, and a
+// sync puts magpie's key in its place, a variable of the shell's being
+// nowhere magpie can write it (#3040).
+func TestDroidWithAKeyInTheEnvironment(t *testing.T) {
+	home, path := droidHome(t)
+	t.Setenv("MAGPIE_API_KEY", "")
+	os.Unsetenv("MAGPIE_API_KEY")
+	a := droid(home)
+	// the entry as the user wrote it, its key a reference
+	writeFile(t, path, `{
+  "customModels": [
+    {
+      "model": "deepseek/pro",
+      "id": "custom:magpie/deepseek/pro",
+      "displayName": "DeepSeek pro",
+      "baseUrl": "`+here(home).v1()+`",
+      "apiKey": "${MAGPIE_API_KEY}",
+      "provider": "generic-chat-completion-api",
+      "noImageSupport": true
+    }
+  ],
+  "sessionDefaultSettings": {
+    "model": "custom:magpie/deepseek/pro"
+  }
+}
+`)
+	secret, err := access.Update("add-key", access.Change{Name: "droid"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	ref := func(what string) {
+		t.Helper()
+		byID, _, _ := droidFile(t, path)
+		e := byID["custom:magpie/deepseek/pro"]
+		if e == nil {
+			t.Fatalf("%s: magpie's entry is gone", what)
+		}
+		if e["apiKey"] != "${MAGPIE_API_KEY}" {
+			t.Fatalf("%s: the user's reference was written over: %v", what, e["apiKey"])
+		}
+	}
+	for _, c := range []struct{ name, key string }{
+		{"a gateway key", secret},
+		{"magpie's own key", gateway.Token},
+	} {
+		t.Setenv("MAGPIE_API_KEY", c.key)
+		if d := a.Check(); d != "" {
+			t.Fatalf("%s in the environment is drift: %s", c.name, d)
+		}
+		if err := a.Sync(); err != nil {
+			t.Fatal(err)
+		}
+		ref(c.name)
+		if err := a.Field("model").Set("magpie/deepseek/pro"); err != nil {
+			t.Fatal(err)
+		}
+		ref(c.name + ", then a pick")
+	}
+	// a variable only the shell sets, which magpie doesn't see: unknown
+	os.Unsetenv("MAGPIE_API_KEY")
+	if d := a.Check(); d != "" {
+		t.Fatalf("a variable magpie can't see is drift: %s", d)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	ref("a variable magpie can't see")
+	// a key the gateway doesn't take
+	t.Setenv("MAGPIE_API_KEY", "sk-not-this-gateways")
+	if d := a.Check(); !strings.Contains(d, "apiKey") {
+		t.Fatalf("a key the gateway doesn't take is not reported: %q", d)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	byID, _, _ := droidFile(t, path)
+	if got := byID["custom:magpie/deepseek/pro"]["apiKey"]; got != gateway.Token {
+		t.Fatalf("a sync left %v in place of the reference naming a key the gateway doesn't take", got)
+	}
+	if d := a.Check(); d != "" {
+		t.Fatalf("after a sync: %s", d)
+	}
+	// more than the one reference: magpie's key, as before
+	if err := edit.SetJSON(path, edit.KV{Path: "customModels.0.apiKey", Value: "x${MAGPIE_API_KEY}"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	byID, _, _ = droidFile(t, path)
+	if got := byID["custom:magpie/deepseek/pro"]["apiKey"]; got != gateway.Token {
+		t.Fatalf("a value that doesn't reach magpie is kept: %v", got)
+	}
+}
diff --git a/internal/agent/gatewaykey.go b/internal/agent/gatewaykey.go
index 4217bc44..f09a44e0 100644
--- a/internal/agent/gatewaykey.go
+++ b/internal/agent/gatewaykey.go
@@ -1,9 +1,11 @@
 package agent
 
 import (
+	"regexp"
 	"strings"
 
 	"github.com/yetone/magpie/internal/access"
+	"github.com/yetone/magpie/internal/appdir"
 	"github.com/yetone/magpie/internal/gateway"
 )
 
@@ -81,3 +83,40 @@ func gatewayKey(want string) bool {
 func keyHolds(v, want string) bool {
 	return v == want || v != "" && gatewayKey(want) && gatewayTakes(v)
 }
+
+// envRefKey is the key an agent sends where its config holds v: a value
+// that is one reference to a variable of the environment's — Droid's
+// "${VAR}" (docs.factory.com, Custom Models) or OpenCode's {env:VAR}
+// (packages/core/src/config/variable.ts), which the agent expands from its
+// environment as it loads the config — is the variable's value, read from
+// this machine's environment, where those agents read it too. name is the
+// variable, "" when v is no such reference. known is false when the
+// variable isn't set here: one only the agent's own shell sets, which
+// magpie can't tell from one holding another key, so it is unknown, never
+// drift (#3040).
+func envRefKey(v string, ref *regexp.Regexp) (key, name string, known bool) {
+	m := ref.FindStringSubmatch(v)
+	if m == nil {
+		return v, "", false
+	}
+	if val, ok := appdir.LookupEnv(m[1]); ok {
+		return val, m[1], true
+	}
+	return "", m[1], false
+}
+
+// envRefKept is the key magpie writes where its own is want and the file
+// holds v: a reference to a variable the user put there stays, when the
+// key it names reaches magpie (keyHolds) or magpie can't see it; one
+// naming a key the gateway doesn't take is magpie's key again, as a value
+// with more than the one reference in it (#3040).
+func envRefKept(v, want string, ref *regexp.Regexp) string {
+	key, name, known := envRefKey(v, ref)
+	if name == "" {
+		return want
+	}
+	if !known || keyHolds(key, want) {
+		return v
+	}
+	return want
+}
diff --git a/internal/agent/opencode_test.go b/internal/agent/opencode_test.go
new file mode 100644
index 00000000..286f6818
--- /dev/null
+++ b/internal/agent/opencode_test.go
@@ -0,0 +1,90 @@
+package agent
+
+import (
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/access"
+	"github.com/yetone/magpie/internal/edit"
+	"github.com/yetone/magpie/internal/gateway"
+)
+
+// A user who keeps magpie's key out of opencode.json writes
+// options.apiKey as a reference to a variable, which OpenCode expands from
+// its environment as it loads the config ({env:VAR},
+// packages/core/src/config/variable.ts). A reference names the key
+// OpenCode sends: one that reaches magpie is not drift and a sync keeps
+// it; one magpie can't see is unknown, kept and not drift; one naming a
+// key the gateway doesn't take is drift, and a sync puts magpie's key in
+// its place, a variable of the shell's being nowhere magpie can write it
+// (#3040).
+func TestOpenCodeWithAKeyInTheEnvironment(t *testing.T) {
+	home := syncHome(t)
+	t.Setenv("MAGPIE_API_KEY", "")
+	os.Unsetenv("MAGPIE_API_KEY")
+	cfg := filepath.Join(home, ".config", "opencode", "opencode.json")
+	writeFile(t, cfg, `{"model":"magpie/relay/glm-4.6","provider":{"magpie":{"npm":"@ai-sdk/openai-compatible","name":"magpie","options":{"baseURL":"`+gatewayV1()+`","apiKey":"{env:MAGPIE_API_KEY}"},"models":{"relay/glm-4.6":{"name":"GLM-4.6"}}}}}`)
+	oc := opencode(home, filepath.Join(home, ".config"))
+	secret, err := access.Update("add-key", access.Change{Name: "opencode"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	ref := func(what string) {
+		t.Helper()
+		if v, _ := edit.GetJSON(cfg, "provider.magpie.options.apiKey"); v != "{env:MAGPIE_API_KEY}" {
+			t.Fatalf("%s: the user's reference was written over: %q", what, v)
+		}
+	}
+	for _, c := range []struct{ name, key string }{
+		{"a gateway key", secret},
+		{"magpie's own key", gateway.Token},
+	} {
+		t.Setenv("MAGPIE_API_KEY", c.key)
+		if d := oc.Check(); d != "" {
+			t.Fatalf("%s in the environment is drift: %s", c.name, d)
+		}
+		if err := oc.Sync(); err != nil {
+			t.Fatal(err)
+		}
+		ref(c.name)
+		if err := oc.Fields[0].Set("magpie/relay/glm-4.6"); err != nil {
+			t.Fatal(err)
+		}
+		ref(c.name + ", then a pick")
+	}
+	// a variable only the shell sets, which magpie doesn't see: unknown
+	os.Unsetenv("MAGPIE_API_KEY")
+	if d := oc.Check(); d != "" {
+		t.Fatalf("a variable magpie can't see is drift: %s", d)
+	}
+	if err := oc.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	ref("a variable magpie can't see")
+	// a key the gateway doesn't take
+	t.Setenv("MAGPIE_API_KEY", "sk-not-this-gateways")
+	if d := oc.Check(); !strings.Contains(d, "apiKey") {
+		t.Fatalf("a key the gateway doesn't take is not reported: %q", d)
+	}
+	if err := oc.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if v, _ := edit.GetJSON(cfg, "provider.magpie.options.apiKey"); v != gateway.Token {
+		t.Fatalf("a sync left %q in place of the reference naming a key the gateway doesn't take", v)
+	}
+	if d := oc.Check(); d != "" {
+		t.Fatalf("after a sync: %s", d)
+	}
+	// more than the one reference: magpie's key, as before
+	if err := edit.SetJSON(cfg, edit.KV{Path: "provider.magpie.options.apiKey", Value: "x{env:MAGPIE_API_KEY}"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := oc.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if v, _ := edit.GetJSON(cfg, "provider.magpie.options.apiKey"); v != gateway.Token {
+		t.Fatalf("a value that doesn't reach magpie is kept: %q", v)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
