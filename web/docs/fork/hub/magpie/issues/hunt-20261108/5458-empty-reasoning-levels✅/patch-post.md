@yetone @expoli reported that a model of a custom OpenAI-compatible provider whose upstream `/v1/models` is silent about reasoning levels had its levels shown by `magpie model efforts` yet published as `reasoning_levels: []` by the gateway, and that `magpie model efforts <id> <levels>` with exactly the levels the CLI itself reported was a silent no-op — so such a model had no supported way to have its levels published.

**Root cause**: `keptEfforts` folded an override that named every level the model has into "offered all again" by setting it to nil (`internal/provider/modelprefs.go`, the `len(keep) == len(all)` step), and `setModelEfforts` then saw "no change" and wrote nothing. With no override kept, the lists publish what the catalog's borrowed word gives (`effortsOf` in `internal/provider/models.go`), and for a model whose vendor's list is silent and whose borrowed word falls short, that is nothing. The same fold is what made the override a no-op: keeping the levels and keeping nothing looked identical to `setModelEfforts`. Both gaps in the report come from that one fold.

**The fix**: what the user names is kept, even when it is every level the model has — it is their word on what the lists publish. A reset (`magpie model efforts <id> --reset`, no levels named) still offers them all again by taking the override away, and the "not a reasoning level" checks are unchanged. The gateway and the agents' lists already apply a kept override over the vendor's word (`effortsKept` in `entryFor`), so a model whose levels the gateway doesn't publish can now be told them by naming them, exactly as the report's expected fix asks. A subset is kept as before (#92), and `magpie model spec --reasoning` keeps its validation.

<details><summary>patch: provider: a model's levels named whole are kept, so the lists publish them (#5458) — git am applies it as is; SHA-256 first 16: eb7719cc47e5180a</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 08:20:01 +0800
Subject: [PATCH] provider: a model's levels named whole are kept, so the lists
 publish them (#5458)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

An override naming every level a model has was folded away as "offered
all again": nothing was kept in settings, and the gateway published the
levels it knew of on its own — none, for a model of a custom provider
whose vendor's list is silent about them. The CLI said the levels, the
list published none, and setting exactly those levels changed nothing,
so such a model had no supported way to be told them.

What the user names is kept now, even when it is the model's own set;
a reset (no levels) offers them all again by taking the override away.
expoli reported the empty list and the silent no-op.
---
 internal/gateway/modelprefs_test.go       | 76 +++++++++++++++++++++++
 internal/provider/modelprefs.go           |  8 ++-
 internal/provider/modelprefs_save_test.go | 57 +++++++++++++++++
 internal/provider/modelprefs_test.go      | 15 ++++-
 4 files changed, 151 insertions(+), 5 deletions(-)

diff --git a/internal/gateway/modelprefs_test.go b/internal/gateway/modelprefs_test.go
index 34d505665..e3ab01d25 100644
--- a/internal/gateway/modelprefs_test.go
+++ b/internal/gateway/modelprefs_test.go
@@ -1,7 +1,9 @@
 package gateway
 
 import (
+	"context"
 	"encoding/json"
+	"net/http"
 	"net/http/httptest"
 	"os"
 	"path/filepath"
@@ -62,3 +64,77 @@ func TestModelsListUsersNameAndLevels(t *testing.T) {
 		t.Fatalf("%v\n%s", got, rec.Body.String())
 	}
 }
+
+// A custom provider whose vendor's list is silent about a model's levels
+// had them published only while the catalog's borrowed word held, and an
+// override naming exactly those levels was folded away as "offered all
+// again", leaving nothing kept to publish (#5458). What the user names is
+// kept now even when it is every level the model has, and the list
+// publishes it.
+func TestModelsListKeepsAnOverrideNamingAllLevels(t *testing.T) {
+	fresh(t)
+	os.MkdirAll(filepath.Dir(catalog.CachePath()), 0o755)
+	data := `{"deepseek":{"models":{"deepseek-flash":{"id":"deepseek-flash","name":"DeepSeek Flash",
+		"reasoning_options":[{"type":"effort","values":["low","high","max"]}]}}}}`
+	if err := os.WriteFile(catalog.CachePath(), []byte(data), 0o644); err != nil {
+		t.Fatal(err)
+	}
+	catalog.Reset()
+	t.Cleanup(catalog.Reset)
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if r.URL.Path != "/v1/models" {
+			http.NotFound(w, r)
+			return
+		}
+		w.Header().Set("Content-Type", "application/json")
+		json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": []map[string]any{
+			{"id": "deepseek-flash", "object": "model", "owned_by": "relay"},
+		}})
+	}))
+	t.Cleanup(srv.Close)
+	if err := provider.Save(provider.Provider{ID: "digua", Name: "Digua", Chat: srv.URL + "/v1", Key: "k"}); err != nil {
+		t.Fatal(err)
+	}
+	p, err := provider.Find("digua")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if _, _, _, err := p.RefetchTaking(context.Background()); err != nil {
+		t.Fatal(err)
+	}
+	// the levels the CLI reports, named whole and in the user's order
+	if err := provider.SetModelEfforts("digua/deepseek-flash", []string{"max", "high", "low"}); err != nil {
+		t.Fatal(err)
+	}
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/v1/models", nil))
+	var out struct {
+		Data []struct {
+			ID     string   `json:"id"`
+			Flat   []string `json:"reasoning_levels"`
+			Levels []struct {
+				Effort string `json:"effort"`
+			} `json:"supported_reasoning_levels"`
+		} `json:"data"`
+	}
+	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
+		t.Fatal(err)
+	}
+	for _, m := range out.Data {
+		if m.ID != "digua/deepseek-flash" {
+			continue
+		}
+		if got, want := strings.Join(m.Flat, ","), "low,high,max"; got != want {
+			t.Fatalf("%s: reasoning_levels %q, want %q\n%s", m.ID, got, want, rec.Body.String())
+		}
+		var ls []string
+		for _, l := range m.Levels {
+			ls = append(ls, l.Effort)
+		}
+		if got, want := strings.Join(ls, ","), "low,high,max"; got != want {
+			t.Fatalf("%s: supported_reasoning_levels %q, want %q", m.ID, got, want)
+		}
+		return
+	}
+	t.Fatalf("no digua/deepseek-flash\n%s", rec.Body.String())
+}
diff --git a/internal/provider/modelprefs.go b/internal/provider/modelprefs.go
index f2aad1180..710199366 100644
--- a/internal/provider/modelprefs.go
+++ b/internal/provider/modelprefs.go
@@ -277,7 +277,11 @@ func setModelEfforts(ref string, efforts []string) (bool, error) {
 // keptEfforts is the levels a user keeps of p's model as ModelEfforts
 // holds them: those given, checked against the model's own (or Levels, for
 // a model with none known), in the vendor's order, and none when they are
-// all of them.
+// all of them and none were named — a reset. A set the user names is kept
+// even when it is every level the model has (#5458): a model whose levels
+// the gateway doesn't publish (its vendor's list is silent about them) had
+// no supported way to be told them, as the override equal to its own set
+// was folded away and nothing was kept to publish.
 func keptEfforts(p *Provider, model string, efforts []string) ([]string, error) {
 	all := p.Known(model)
 	var keep []string
@@ -297,7 +301,7 @@ func keptEfforts(p *Provider, model string, efforts []string) ([]string, error)
 		}
 	}
 	keep = effortsKept(all, keep) // in the vendor's order
-	if len(keep) == len(all) {
+	if len(keep) == len(all) && len(efforts) == 0 {
 		keep = nil
 	}
 	return keep, nil
diff --git a/internal/provider/modelprefs_save_test.go b/internal/provider/modelprefs_save_test.go
index 71058da4c..e28af5446 100644
--- a/internal/provider/modelprefs_save_test.go
+++ b/internal/provider/modelprefs_save_test.go
@@ -57,3 +57,60 @@ func TestSetModelPrefs(t *testing.T) {
 		t.Fatalf("names %v, told %d times", settings.Load().ModelNames, touched)
 	}
 }
+
+// An override that names every level the model has is kept all the same
+// (#5458): folding it away as "offered all again" left no override in
+// settings, and a model whose levels the gateway doesn't publish (its
+// vendor's list is silent about them) then had no supported way to be
+// told them — the CLI said the levels, the list published none, and
+// setting exactly those levels changed nothing. What the user gave is
+// kept now; only a reset (no levels) offers them all again by taking
+// the override away.
+func TestModelEffortsNamingAllLevelsAreKept(t *testing.T) {
+	prefsHome(t)
+	p, err := Find("a")
+	if err != nil {
+		t.Fatal(err)
+	}
+	all := p.Known("sol")
+	if want := []string{"low", "medium", "high", "max"}; !slices.Equal(all, want) {
+		t.Fatalf("Known(sol) = %v, want %v", all, want)
+	}
+	// a subset was kept before (#92) and still is
+	if err := SetModelEfforts("a/sol", []string{"low", "high"}); err != nil {
+		t.Fatal(err)
+	}
+	if kept := settings.Load().ModelEfforts["a/sol"]; !slices.Equal(kept, []string{"low", "high"}) {
+		t.Fatalf("subset kept as %v", kept)
+	}
+	// the whole native set, spelt by the user: kept, not folded away
+	if err := SetModelEfforts("a/sol", []string{"max", "high", "medium", "low"}); err != nil {
+		t.Fatal(err)
+	}
+	kept, ok := settings.Load().ModelEfforts["a/sol"]
+	if !ok || !slices.Equal(kept, all) {
+		t.Fatalf("an override equal to the native set was not kept: %v", settings.Load().ModelEfforts)
+	}
+	// and the catalog carries it, in the vendor's order
+	if got := entry(t, "a/sol").Efforts; !slices.Equal(got, all) {
+		t.Fatalf("entry efforts %v, want %v", got, all)
+	}
+	// setting the same set again changes nothing further (told once more
+	// here, as the set above was a change)
+	if err := SetModelEfforts("a/sol", []string{"low", "medium", "high", "max"}); err != nil {
+		t.Fatal(err)
+	}
+	if kept := settings.Load().ModelEfforts["a/sol"]; !slices.Equal(kept, all) {
+		t.Fatalf("kept as %v after setting the same set again", kept)
+	}
+	// a reset still takes the override away
+	if err := SetModelEfforts("a/sol", nil); err != nil {
+		t.Fatal(err)
+	}
+	if _, ok := settings.Load().ModelEfforts["a/sol"]; ok {
+		t.Fatal("reset left the override behind")
+	}
+	if got := entry(t, "a/sol").Efforts; !slices.Equal(got, all) {
+		t.Fatalf("after a reset the entry offers %v, want all of %v", got, all)
+	}
+}
diff --git a/internal/provider/modelprefs_test.go b/internal/provider/modelprefs_test.go
index 29825f539..19055702d 100644
--- a/internal/provider/modelprefs_test.go
+++ b/internal/provider/modelprefs_test.go
@@ -155,7 +155,11 @@ func TestModelName(t *testing.T) {
 
 // Keeping some of a model's reasoning levels offers only those, in the
 // vendor's order, where magpie lists it (and so in the groups it is in);
-// asking for one it hasn't fails, and all of them, or none, is a reset.
+// asking for one it hasn't fails. A set naming every level the model has
+// is kept too (#5458): it is the user's word on what the lists publish,
+// where a model whose levels the gateway doesn't publish otherwise has no
+// supported way to be told them. A reset (no levels) offers them all
+// again by taking the override away.
 func TestModelEfforts(t *testing.T) {
 	prefsHome(t)
 	if err := SetModelEfforts("a/sol", []string{"high", "low", "high"}); err != nil {
@@ -183,8 +187,13 @@ func TestModelEfforts(t *testing.T) {
 	if err := SetModelEfforts("a/sol", []string{"low", "medium", "high", "max"}); err != nil {
 		t.Fatal(err)
 	}
-	if _, ok := settings.Load().ModelEfforts["a/sol"]; ok {
-		t.Fatal("every level kept is still a narrowing")
+	// naming every level the model has is kept as the user's word on what
+	// the lists publish (#5458), and offers all of them as before
+	if kept, ok := settings.Load().ModelEfforts["a/sol"]; !ok || !slices.Equal(kept, []string{"low", "medium", "high", "max"}) {
+		t.Fatalf("every level named was not kept: %v", settings.Load().ModelEfforts)
+	}
+	if got := entry(t, "a/sol").Efforts; !slices.Equal(got, []string{"low", "medium", "high", "max"}) {
+		t.Fatal(got)
 	}
 	SetModelEfforts("a/sol", []string{"max"})
 	if err := SetModelEfforts("a/sol", nil); err != nil {
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5458-empty-reasoning-levels`](https://github.com/ggbdpq/magpie/tree/fix/5458-empty-reasoning-levels) (head `34f9d68ef80252e8c9ac5c37d3380b98f310abb3`), rebased onto current `upstream/main` (`350599a0f`); on a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `TestModelEffortsNamingAllLevelsAreKept` (new, internal/provider) | red before the fix (`an override equal to the native set was not kept: map[]`), pass after |
| `TestModelsListKeepsAnOverrideNamingAllLevels` (new, internal/gateway) | pass: relay silent about levels, override naming all of them kept, `/v1/models` publishes `reasoning_levels: ["low","high","max"]` |
| `TestModelEfforts`, `TestModelEffortsGiven`, `TestSetModelPrefs` (updated/neighbors) | pass (the old "every level kept is still a narrowing" assertion was the folded behavior; updated to the kept one) |
| `go test ./internal/provider/` | ok (114s), zero failures |
| `go test -timeout 25m ./internal/gateway/` | ok (769s), zero failures |
| targeted `-race` (`TestModelEfforts*`, `TestSetModelPrefs`) | pass |
| `gofmt -l <changed files>` | prints nothing |
| `go vet ./internal/provider/ ./internal/gateway/ ./internal/cli/ ./internal/gui/` | clean |
| `GOOS=linux go vet -tags nogui`; `GOOS=windows go vet` | clean |
| `go build -tags nogui ./...`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build -tags nogui` | clean |
| `go test ./internal/cli/ -run TestModel`, `go test ./internal/gui/ -run 'TestProviderSaveModelPrefs|TestSettingsSaveKeeps'` | ok |
| Ablation | restoring the old fold (`len(keep) == len(all)` without the "none were named" condition) turns `TestModelEffortsNamingAllLevelsAreKept` red with the reporter's own signature (`map[]`); restored, green |
| `git am` on a fresh checkout of `upstream/main` | applies clean; resulting tree identical to the branch head (diff 0) |

**Not verified**: on the reporter's own magpie (0.1.2115, digua provider) — the reporter's machine is the place for that. One honest note: on current `upstream/main` I could not reproduce the gateway publishing `[]` for a model whose levels the CLI reports — both read the same `effortsOf`, and in tests a relay silent about levels with a catalog that knows the id publishes the borrowed levels. A live magpie whose catalog snapshot predates the model's catalog entries could hold that older answer in its held catalog; whatever the shape, with this fix naming the levels keeps them in settings and the lists publish what was kept.

**Not run**: `go test -tags nogui ./...` over the whole repo (the machine is running several verification lanes at once; the changed packages and their neighbors are covered above).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
