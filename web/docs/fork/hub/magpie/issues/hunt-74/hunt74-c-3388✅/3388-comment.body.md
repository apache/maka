Summary

An OpenCode account's key serves both of the vendor's products magpie knows as presets: OpenCode Zen at `https://opencode.ai/zen(/v1)` and OpenCode Go at `https://opencode.ai/zen/go(/v1)`. With Zen saved, adding Go with the same key was refused by the Add flow: "OpenCode Zen is already added with that key (opencode-zen); magpie provider key opencode-zen <key> changes its key". The add-time duplicate check treats a key at one host as one provider, so two different products of one vendor on one host could not coexist through Add, though two keys of one vendor can (anthropic-2).

Why the refusal looks where it looks

`sameProvider` (internal/provider/importapps.go) matches accounts by key + host + headers, and its host-only read is load-bearing there. Stored providers and import entries name one relay at different path granularities: the #1487 fixture's findcg is saved with `https://www.findcg.example/v1` and read back as `https://www.findcg.example`, while the entry imported from CC Switch keeps the `/v1` — and a Gemini-protocol relay is known by its bare host (`TestGeminiURLIsItsHost`). Making `sameProvider` path-strict reds `TestGeminiURLIsItsHost` and `TestImportRenamedInPicker` (both verified: green at dd1e8822, red with a host+path matcher). So the loosening belongs at the refusal site in `Add`, not in the shared matcher the import side leans on.

What changed

- In `add(p, once=true)` (internal/provider/provider.go), the refusal now steps aside when what is here and what is added carry two different presets: two products of one vendor are not the one provider twice, and one key of the account reaches both (#3388). The same preset twice, and a custom provider at the host of what is here with the same key, are still refused as the one already here. Sibling-face call: all seven other `sameProvider` call sites (the import list's same/KeyOf/taken marking, holds, merge, the key-join address check) are untouched — their host contract is the one the tests pin.
- `TestAddSameKeyOtherPathOfHost` locks the issue's scene (Zen in, Go adds beside it, its endpoints intact, the same Go twice still refused); `TestAddSameKeySameHostCustom` holds the refusal for customs at one host, path or no path.

Verification
| Check | Result |
| --- | --- |
| `go test -tags nogui -run TestAddSameKeyOtherPathOfHost ./internal/provider` on dd1e8822 + tests (RED) | FAIL: `Go beside Zen, same key: OpenCode Zen is already added with that key (opencode-zen)…` — the reported answer, verbatim |
| Same with the fix (GREEN) | ok |
| Ablation: provider.go reverted to HEAD~1, tests kept | red as above; restored, green again |
| Guards: `TestAddSecondOfPreset`, `TestGeminiURLIsItsHost`, `TestImportRenamedInPicker`, `TestImportSameAccountFromTwoAppsOnce`, `TestOpenCodeZenNeedsNoKey` | all pass |
| `go test -tags nogui -count=1 ./internal/provider` (full package) | ok, 81.6s |
| `gofmt -l` on the touched files | clean |
| `go vet ./...` | exit 0 (one pre-existing cgo `-Wenum-conversion` warning in internal/gui/trayimage_darwin.go, untouched by this patch) |
| `GOOS=linux go vet -tags nogui ./...` / `GOOS=windows go vet ./...` | both exit 0 |
| `go build` on darwin, linux, windows | all ok |

Not verified

- The Add dialog was not driven in a browser this round; the refusal text the issue quotes is `Add`'s own, and the repro is pinned at that call in Go. The secondary message nit (the bare `<key>` placeholder read as a redacted key in the web UI) is untouched.
- An OpenCode Go entry read from OpenCode's auth.json while a Zen provider holds the same key is still marked "same" by the import picker and skipped — the import side's host contract again. Add is the path this issue reports; if the picker should offer Go beside Zen too, that is a follow-up on the import side.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: provider: two different presets on one host are not the one twice, so OpenCode Go goes beside Zen (#3388) — git am applies it as is; SHA-256 first 16: f49e23f2cf737cd7</summary>

```text
From 25b2a490ce718a07b2eabfa525a53de101fe8fcb Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 09:38:52 +0800
Subject: [PATCH] provider: two different presets on one host are not the one
 twice, so OpenCode Go goes beside Zen (#3388)

Adding a provider was refused when one already here held the same key
at the same host with the same headers. OpenCode Zen and OpenCode Go
are two presets of one vendor on opencode.ai, at /zen and /zen/go, and
one account's key works for both: with Zen in, adding Go was answered
"OpenCode Zen is already added with that key (opencode-zen)". The
refusal now steps aside when what is here and what is added carry two
different presets. The same preset twice, and a custom provider at the
host of what is here with the same key, are still refused as the one
already here.

The check stays as sameProvider has it: its host is load-bearing.
Providers are stored with protocol paths trimmed (an Anthropic base
kept without its /v1) while import entries name them with it, and a
Gemini-protocol relay is known by its bare host, so the host matches
an account however each app writes its URLs. The import side takes
nothing of this change.

Run: TestAddSameKeyOtherPathOfHost, new, fails without the change with
the reported answer and passes with it; TestAddSameKeySameHostCustom,
new, holds the refusal for customs at one host; go test -tags nogui
./internal/provider green; go vet for darwin, linux (nogui) and
windows green; go build for the three green.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/provider.go               | 10 ++-
 internal/provider/sameprovider_path_test.go | 67 +++++++++++++++++++++
 2 files changed, 75 insertions(+), 2 deletions(-)
 create mode 100644 internal/provider/sameprovider_path_test.go

diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index a36e7df0..2277790b 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -961,9 +961,15 @@ func add(p Provider, once bool) (string, error) {
 	}
 	// the same key on the same host with the same headers is the one
 	// already here, not another: adding it twice would only split its usage.
-	// A copy the user asked for is taken (AddCopy).
+	// A copy the user asked for is taken (AddCopy). Two different presets
+	// on one host are two products of the vendor, not the one twice: one
+	// key of the account reaches both (OpenCode's Zen and Go, #3388).
+	np := normalize(p)
 	for _, h := range All() {
-		if once && h.Account == nil && sameProvider(h, normalize(p)) {
+		if once && h.Account == nil && sameProvider(h, np) {
+			if h.Preset != "" && np.Preset != "" && h.Preset != np.Preset {
+				continue
+			}
 			return "", fmt.Errorf("%s is already added with that key (%s); magpie provider key %s <key> changes its key", h.Name, h.ID, h.ID)
 		}
 	}
diff --git a/internal/provider/sameprovider_path_test.go b/internal/provider/sameprovider_path_test.go
new file mode 100644
index 00000000..d781b3d5
--- /dev/null
+++ b/internal/provider/sameprovider_path_test.go
@@ -0,0 +1,67 @@
+package provider
+
+import (
+	"path/filepath"
+	"testing"
+)
+
+// #3388: OpenCode Zen and OpenCode Go are two presets of one vendor on one
+// host, at different paths (/zen, /zen/go), and one account's key works for
+// both. Adding Go beside Zen must not be refused as the one already there;
+// the same thing twice still is.
+func TestAddSameKeyOtherPathOfHost(t *testing.T) {
+	isolate(t)
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	zen, _ := FromPreset("opencode-zen")
+	zen.Key = "sk-opencode"
+	if _, err := Add(zen); err != nil {
+		t.Fatal(err)
+	}
+	goprov, _ := FromPreset("opencode-go")
+	goprov.Key = "sk-opencode"
+	id, err := Add(goprov)
+	if err != nil {
+		t.Fatalf("Go beside Zen, same key: %v", err)
+	}
+	got, err := Find(id)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if got.Chat != "https://opencode.ai/zen/go/v1" || got.Anthropic != "https://opencode.ai/zen/go" {
+		t.Fatalf("Go's endpoints moved: %+v", got)
+	}
+	// the same preset twice with the same key is still the one already here
+	dup, _ := FromPreset("opencode-go")
+	dup.Key = "sk-opencode"
+	if _, err := Add(dup); err == nil {
+		t.Fatal("a duplicate of Go was added")
+	}
+}
+
+// The dedup's host holds beyond the presets: a custom provider at one host
+// with a key of the account there is the one already here, at any path —
+// an address of a provider's is its host, as the import list reads it.
+func TestAddSameKeySameHostCustom(t *testing.T) {
+	isolate(t)
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	if _, err := Add(Provider{Name: "Relay", Chat: "https://relay.example/v1", Key: "sk-1"}); err != nil {
+		t.Fatal(err)
+	}
+	for _, u := range []string{"https://relay.example/v2", "https://relay.example"} {
+		if _, err := Add(Provider{Name: "Relay again", Chat: u, Key: "sk-1"}); err == nil {
+			t.Fatalf("%s was added beside the relay", u)
+		}
+	}
+	// another host is another provider, as it always was
+	if _, err := Add(Provider{Name: "Elsewhere", Chat: "https://other.example/v1", Key: "sk-1"}); err != nil {
+		t.Fatalf("another host: %v", err)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

Branch with the commit: [hunt74-c-sameprovider-path](https://github.com/ggbdpq/magpie/tree/hunt74-c-sameprovider-path) (head `25b2a490ce718a07b2eabfa525a53de101fe8fcb`).
