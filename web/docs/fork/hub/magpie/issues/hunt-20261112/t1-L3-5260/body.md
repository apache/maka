The key_env setup is now honored: with `key_env` on the entry, magpie writes `api_key` as a reference to that variable (`${HERMES_CUSTOM_MAGPIE_API_KEY}`) instead of the literal `magpie` token, so Hermes keeps sending the key from its `.env` and the Docker gateway takes it.

**What changed** (`internal/agent/hermes.go`, `hermesKeptKey` + a small `hermesKeyEnvRef`)

`hermesKeptKey` decides the `api_key` magpie writes. It already kept a `${VAR}` reference the user had put in `api_key` themselves, and syncs magpie's key into the named `.env` variable when the reference names a key the gateway doesn't take. The gap: a user who set up Hermes the supported way — `key_env: <VAR>` pointing at their own key in `.env`, no `api_key` at all — had raw `api_key` empty, so every model write put the literal loopback token there, and Hermes (which sends a non-empty `api_key` before it reads `key_env`, as your A/B showed) went out with `magpie`. Behind Docker's port mapping the request arrives from the bridge address, `identifyCaller` rightly takes it for another machine, and the token is refused — while the very key sitting in the `.env` says 200.

Now, when `raw` holds no reference, the entry's `key_env` is consulted first: set, the key is written as `${<key_env value>}`. Consequences, in order:

- Hermes expands the reference from its `.env` and sends the user's key — the gateway takes it, on loopback and behind Docker alike.
- `hermesKeptKey` keeps the reference on every later write (it is now a reference naming a key the gateway takes), so the overwrite can't come back.
- Your `.env` stays yours: the early `keyHolds` return means magpie no more rewrites `HERMES_CUSTOM_MAGPIE_API_KEY` than it rewrote the entry before.
- The state you were left in heals: `api_key: magpie` beside a `key_env` goes back to the reference on the next write — no manual `hermes config unset` needed.
- An `api_key` reference the user put in themselves still wins over `key_env`, as before; `Check` reads the entry through the same expansion, so a working `key_env` setup shows wired, not drift.

**Test** (`TestHermesWithAKeyEnvStaysAReference`, next to the existing `TestHermesWithAKeyInItsEnvFile` it models on): the reporter's provider shape (`key_env` only, a real issued gateway key in `.env`), then a model pick, a sync, and the healed broken state. Before the change: `api_key written as "magpie", want the key_env reference`. After: reference kept, `.env` untouched, `Check` clean.

**Siblings**: `rg -n "model_catalog_json|key_env"` — every other writer that pairs a literal magpie key with an env-var selection keeps the user's field instead of shadowing it: goose merges `api_key_env` as a kept field, vibe reads the key from `api_key_env_var` and never writes a key into the config, reasonix writes its own `api_key_env` and checks the user's value before touching it. jcode's `wire` writes an inline `api_key` into `[providers.magpie]` while leaving other keys of the entry alone — whether that shadows a user-set `api_key_env` depends on jcode's own resolution order, which I can't check here (no jcode source at hand); worth a look only if a report shows it.

| Check | Result |
| --- | --- |
| `go test ./internal/agent/ -run TestHermesWithAKeyEnvStaysAReference` | red before, green after |
| ablation (`hermes.go` at parent `ea3a00adc`, test kept) | red again, same assertion; restored, green |
| `go test ./internal/agent/ -run 'TestHermes|TestKeyHolds'` (also `-race`) | ok (2.731s / 5.017s) |
| `go test ./internal/agent/ -count=1 -timeout 25m` | only `TestMothX` fails — this host's known red, fails the same run alone on the parent (`7199afbb6`) |
| `go vet` darwin + `GOOS=windows`, `gofmt -l` | clean |
| `GOOS=windows` / `GOOS=linux -tags nogui go build` | clean |
| `git am` on `e2afa3931` | applies; tree identical to the branch head (`c5f8bda06d0d2a85`) |

**When the read fails**: `key_env` absent/empty or unreadable → `edit.GetYAML` returns "", the helper returns "" and magpie writes its key as before. A `key_env` naming a variable with no value in `.env` writes the reference and Hermes fails the round as it would with `key_env` alone — no worse than the pre-#5260 setup, and the value stays visible in the config.

**Not verified**: a real Docker deployment (my host is macOS; the reported 401 path — bridge-address caller refused — is taken from your curl A/B and `identifyCaller`'s read); Hermes's exact precedence code (the `api_key` before `key_env` order is your measured behavior).

---
**Source**: reported in #5260 with an end-to-end repro, the failing config, and a curl A/B isolating the key Hermes sent.

**Red without the fix** (base `ea3a00adc`): with `internal/agent/hermes.go` reverted and the new test kept, `go test ./internal/agent/ -run TestHermesWithAKeyEnvStaysAReference` fails:
```
--- FAIL: TestHermesWithAKeyEnvStaysAReference (0.13s)
    hermes_test.go:574: a pick: api_key written as "magpie", want the key_env reference
```
With the fix: `ok`.

**Siblings**: goose / vibe / reasonix keep the user's env-var selection (no change needed, reasons above); jcode flagged for a follow-up look, unverifiable here.

**When the read fails**: as above — empty or unreadable `key_env` falls back to today's write.

**Not verified**: real Docker deployment; real Hermes binary behavior with both `api_key` (reference) and `key_env` present — your v0.1.2423-era A/B showed the literal wins; the reference expands to the same variable, so the sent key is unchanged either way, but I could not run Hermes here.

**Attribution**: AI-written; I've read the whole diff and the tests pass.

**Branch with the commit**: [hunt-20261112-t1-5260](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5260) (head `6ba7ffbc0e306f06`, on main `e2afa3931`).

**Patch**: <details><summary>patch: agent: a Hermes key_env keeps naming the key magpie writes beside it (#5260) — git am applies it as is; SHA-256 first 16: 8c8cf7f3e7bc127f</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 12 Nov 2026 21:32:39 +0800
Subject: [PATCH] agent: a Hermes key_env keeps naming the key magpie writes
 beside it

A Hermes set up with key_env, holding a gateway key of the user's in its
.env, had api_key: magpie written over the setup on every model write
(#5260): Hermes sends a non-empty api_key before it reads key_env, and
behind Docker's port mapping the gateway takes no loopback token from
the bridge address, so every fresh turn came back 401 while the key in
the .env was one the gateway takes (a curl with it said 200).

With key_env on the entry, the key now goes into api_key as a reference
to that variable: Hermes expands it from the .env as the user set up,
the variable stays theirs (a sync no more rewrites it than it rewrote
the entry before), and hermesKeptKey keeps the reference on the writes
after, as it keeps one the user put in api_key themselves. The state
the reporter was left in heals: the literal token beside a key_env goes
back to the reference on the next write. An api_key reference the user
put there still wins over key_env, as before.

Run:
- go test ./internal/agent -run TestHermesWithAKeyEnvStaysAReference:
  red before ("api_key written as \"magpie\""), green after
- the hermes and gatewaykey test families and the package pass

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/hermes.go      | 22 +++++++++++-
 internal/agent/hermes_test.go | 65 +++++++++++++++++++++++++++++++++++
 2 files changed, 86 insertions(+), 1 deletion(-)

diff --git a/internal/agent/hermes.go b/internal/agent/hermes.go
index 717625e69..ac63b888c 100644
--- a/internal/agent/hermes.go
+++ b/internal/agent/hermes.go
@@ -1056,16 +1056,36 @@ func hermesKey(at place, path, v string) (key string, known bool) {
 	return key, known
 }
 
+// hermesKeyEnvRef is the api_key reference the entry's key_env names,
+// where the user keeps the key in a variable of Hermes's own: written as a
+// reference, so Hermes reads the key from its .env as they set up, and
+// hermesKeptKey keeps it on the writes after. A literal api_key magpie
+// would write — the loopback token, which a gateway behind Docker's port
+// mapping refuses from the bridge address (#5260) — never reaches the
+// config while key_env is there.
+func hermesKeyEnvRef(path, entry string) string {
+	v, _ := edit.GetYAML(path, "providers."+entry+".key_env")
+	v = strings.TrimSpace(v)
+	if v == "" {
+		return ""
+	}
+	return "${" + v + "}"
+}
+
 // hermesKeptKey is the api_key magpie writes into the config at path, where
 // want is its own key: a reference the user put there stays, whenever the
 // key it names holds (keyHolds) or magpie can't see it. One naming a key
 // the gateway doesn't take stays too, and magpie's key goes into the .env
 // beside the config under its variable, which Hermes reads over the
 // environment; a value with more than the one reference in it is magpie's
-// key again.
+// key again. A key_env the user set on the entry names their variable: the
+// key goes as a reference to it, before any key of magpie's (hermesKeyEnvRef).
 func hermesKeptKey(at place, path, entry, want string) string {
 	raw, _ := edit.GetYAML(path, "providers."+entry+".api_key")
 	if !hermesEnvRef.MatchString(raw) {
+		if ref := hermesKeyEnvRef(path, entry); ref != "" {
+			return ref
+		}
 		return want
 	}
 	if key, known := hermesKey(at, path, raw); !known || keyHolds(key, want) {
diff --git a/internal/agent/hermes_test.go b/internal/agent/hermes_test.go
index 1b1291272..a5b0700ed 100644
--- a/internal/agent/hermes_test.go
+++ b/internal/agent/hermes_test.go
@@ -532,6 +532,71 @@ func TestHermesWithAKeyInItsEnvFile(t *testing.T) {
 	}
 }
 
+// #5260 (flmaximwang): a Hermes set up with key_env, holding a gateway key
+// of the user's in its .env, had api_key: magpie written over the setup on
+// every model write: Hermes sends a non-empty api_key first, so key_env
+// never got read, and behind Docker's port mapping the gateway takes no
+// loopback token from the bridge address, so every turn came back 401.
+// With key_env on the entry, magpie writes the key as a reference to that
+// variable: Hermes expands it from the .env as the user set up, the
+// variable stays theirs, and hermesKeptKey keeps the reference afterwards.
+func TestHermesWithAKeyEnvStaysAReference(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("HERMES_HOME", "")
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	if err := provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k", Models: []string{"pro"}}); err != nil {
+		t.Fatal(err)
+	}
+	dir := appdir.HermesHomeIn(home)
+	path := filepath.Join(dir, "config.yaml")
+	env := filepath.Join(dir, ".env")
+	os.MkdirAll(dir, 0o755)
+	secret, err := access.Update("add-key", access.Change{Name: "hermes"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	// the reporter's provider, as he wrote it: key_env only, the key in
+	// the .env
+	os.WriteFile(path, []byte("model:\n  default: x\nproviders:\n  magpie:\n    name: magpie\n    api_mode: chat_completions\n    base_url: "+here(home).v1()+"\n    key_env: HERMES_CUSTOM_MAGPIE_API_KEY\n"), 0o644)
+	os.WriteFile(env, []byte("HERMES_CUSTOM_MAGPIE_API_KEY="+secret+"\n"), 0o600)
+	a := hermes(home)
+	ref := func(what string) {
+		t.Helper()
+		if v, _ := edit.GetYAML(path, "providers.magpie.api_key"); v != "${HERMES_CUSTOM_MAGPIE_API_KEY}" {
+			t.Fatalf("%s: api_key written as %q, want the key_env reference", what, v)
+		}
+	}
+	if err := a.Field("model").Set("magpie/deepseek/pro"); err != nil {
+		t.Fatal(err)
+	}
+	ref("a pick")
+	b, err := os.ReadFile(env)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if want := "HERMES_CUSTOM_MAGPIE_API_KEY=" + secret + "\n"; string(b) != want {
+		t.Fatalf("the user's .env was touched:\n%s\nwant:\n%s", b, want)
+	}
+	if d := a.Check(); d != "" {
+		t.Fatalf("the entry with the user's key reads as drift: %s", d)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	ref("a sync")
+	// the state the reporter was left in heals: a literal token beside a
+	// key_env goes back to the reference on the next write
+	mine := "model:\n  default: deepseek/pro\n  provider: magpie\nproviders:\n  magpie:\n    name: magpie\n    api_key: " + gateway.Token + "\n    api_mode: chat_completions\n    base_url: " + here(home).v1() + "\n    key_env: HERMES_CUSTOM_MAGPIE_API_KEY\n"
+	os.WriteFile(path, []byte(mine), 0o644)
+	if err := a.Field("model").Set("magpie/deepseek/pro"); err != nil {
+		t.Fatal(err)
+	}
+	ref("the literal token beside a key_env, healed")
+}
+
 // keyHolds, which every agent's check of magpie's key goes through: a key
 // of the gateway's own stands in for magpie's, never for a URL or another
 // value, and one the gateway doesn't take doesn't.
-- 
2.50.1 (Apple Git-155)


```

</details>
