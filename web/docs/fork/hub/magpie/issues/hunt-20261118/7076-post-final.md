The reported 403: a provider of two keys with one switched off fetched as one — unmarked — so the on key's own models stayed what the two-key era had ticked, and a model the vendor took on later was refused on every request until a hand-run `magpie provider account-models <id> <key> all`. Following the reporter's root-cause (their three points and the fingerprint gap), this patch marks the one key's fetch so the refresh carries the list's gains and losses as it does for several keys.

**Root cause:** `fetchList` asks a provider with more than one key on per key (`fetchPerKey`), marking each model with the keys whose lists show it (`catalog.Model.Keys`). One key on goes through `fetchOne`, which marks nothing — and `keyMarks` builds the refresh's "now" from exactly those marks. With no marks the refresh is unknown and a key's models stay what an earlier fetch had ticked; `AccountServes` then keeps a model the vendor has taken on out of every account and key.

**The fix:** the one key's fetch marks each model with that key's fingerprint (`keyID`), the same stamp `fetchPerKey`'s loop makes, so `keyMarks` has the key and the refresh carries the list's gains and losses into its `AccountModels` — the user's un-ticks of models the list still has kept, a gone model unticked. A lone key's list is the whole of what the keys' lists have between them, so it stays on All models as the lone-key test locks; an off key is not asked and not marked. The contract note in `key_models_refresh.go` names the marked case.

**Source:** reported in #7076 with the reporter's own code-level root cause (the unmarked single-key fetch, the refresh's early return, and `AccountServes`'s strict check) and their field data; reproduced here with a two-key relay fixture, one key off.

**Red without the fix:** `TestFetchRefreshesASingleOnKeysModels` (new): the vendor takes `gpt-6.2-sol` on, the user picks it and fetches — `the on key after a fetch: [gpt-6.1-sol gpt-6-astra], want the vendor's addition ticked`. Restoring the fix passes, and the test also covers the vendor giving a model up (unticked) and the user's un-tick of a model the list still has (kept).

**Siblings:** `fetchOne` is shared with `ListAll` (the add-form picker, nothing persisted — no marks needed there) and `fetchPerKey`'s own loop (which marks through its `add`, untouched). The mark consumers downstream (`AccountServes`, the gateway's per-key lists) read the marks as several-key fetches already write them. The lone-key case keeps its designed All-models behavior — its own list is the whole of what the keys' lists have, and the refresh's guard leaves it un-narrowed (`TestFetchLeavesALoneKeyOnAllModels` passes unchanged). The report's third option (a staleness check inside `AccountServes`) would change what the 403 means and is left for you.

| Check | Result |
| --- | --- |
| `TestFetchRefreshesASingleOnKeysModels` | Green at final head: the vendor's addition ticked, a gone model unticked, the user's un-tick kept; without the fix `want the vendor's addition ticked` |
| Ablation (marking reverted, test kept) | the same failure; restored, green |
| `TestFetchLeavesALoneKeyOnAllModels`, `TestFetchRefreshesEachKeysModels`, `TestFetchTicksEachKeysListOnAllModels` | Pass unchanged (the lone key stays on All models) |
| Targeted `-race` (fetch and key-lists family) | Pass (`TestFetch`, `TestKeyListed` families) |
| `go test -tags nogui -timeout=45m -count=1 ./internal/provider/` | Exit 1 with `TestResolveVia` alone (144.1s) — the documented local proxy-isolation environment failure on this machine, the same test the #7014 and earlier verifications attribute; no failure in the fetch or key-models tests |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet ./…`; `GOOS=linux go vet -tags nogui ./…`; `GOOS=windows go vet ./…` | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Strict `git am` on base `b332ef7ef` | Applies cleanly; resulting tree equals final head; author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** the reporter's relay (one `responses`, one `chat` `baseAPI`, on Linux) end-to-end; the gateway's 403 beyond `AccountServes`'s own behavior (the fixture asserts the key's models and `AccountServes` directly).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7076-single-key-models](https://github.com/ggbdpq/magpie/tree/fix/7076-single-key-models), head `f5408bb3a21d0de7894ab9c884ecf5e5df7972f3`.

<details><summary>patch: provider: a fetch's one key is marked, so its models follow the list (#7076) — git am applies it as is; SHA-256 first 16: 3bdf3dd7af2995e4</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 19 Nov 2026 04:20:54 +0800
Subject: [PATCH] provider: a fetch's one key is marked, so its models follow
 the list (#7076)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: fetchList asked a provider with one key on as one, and
the single key's fetch left every model unmarked — the marks that say
which keys saw each model are what a fetch's refresh carries gains and
losses by. With no marks the refresh is unknown, and a key's own
models stayed what an earlier fetch — often a two-key era's — had
ticked: a model the vendor took on later was never ticked, and the
gateway refused it for every account and key (403, #7076). The one
key's fetch now marks each model with that key's fingerprint, and the
refresh carries the list's gains and losses as it does for several
keys, the user's ticks kept. A lone key's list is the whole of what
the keys' lists have, so it stays on All models as it was; an off key
is not asked and is not marked. The contract note in
key_models_refresh.go names the marked case.

Run: TestFetchRefreshesASingleOnKeysModels (new) fails without the fix
(the vendor's addition never ticked) and passes with it, the user's
un-ticks kept and the gone model unticked; the lone-key,
multi-key-refresh and All-models tests pass unchanged. See the issue
post for the matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/key_models_refresh.go      |  7 +--
 internal/provider/key_models_refresh_test.go | 57 ++++++++++++++++++++
 internal/provider/models.go                  | 15 +++++-
 3 files changed, 75 insertions(+), 4 deletions(-)

diff --git a/internal/provider/key_models_refresh.go b/internal/provider/key_models_refresh.go
index d0084a8d5..0feb57dd8 100644
--- a/internal/provider/key_models_refresh.go
+++ b/internal/provider/key_models_refresh.go
@@ -24,9 +24,10 @@ package provider
 // the models each key can serve). A key the user set back to every model
 // (AccountModelsAll) stays so, and one whose list has every model the
 // others list serves every model still, so the vendor's later additions
-// reach it. A key with no marks now (one key on, one switched off, a
-// list that failed with nothing kept) is unknown, and its models stay as
-// they are.
+// reach it. A key with no marks now (a list that failed with nothing
+// kept) is unknown, and its models stay as they are. The one key a fetch
+// asks alone is marked like a multi-key fetch marks its keys, so its
+// models follow the vendor's list (#7076).
 
 import (
 	"slices"
diff --git a/internal/provider/key_models_refresh_test.go b/internal/provider/key_models_refresh_test.go
index 8c8f4db9e..f0641a4e7 100644
--- a/internal/provider/key_models_refresh_test.go
+++ b/internal/provider/key_models_refresh_test.go
@@ -291,3 +291,60 @@ func TestFetchLeavesALoneKeyOnAllModels(t *testing.T) {
 		t.Errorf("a lone key was given %v", p.AccountModels)
 	}
 }
+
+// #7076: a provider of two keys with one switched off is fetched as one,
+// unmarked — its on key's own models stayed what the two-key era had
+// ticked, and a model the vendor took on later 403'd on every request
+// until a hand-run `provider account-models <id> <key> all`. The one key
+// on saw every model of its list: marked, its models follow the vendor's
+// list like a multi-key provider's do, the user's ticks kept.
+func TestFetchRefreshesASingleOnKeysModels(t *testing.T) {
+	prefillHome(t)
+	l := &relayLists{by: map[string][]string{"sk-a": {"gpt-6.1-sol", "gpt-6-astra"}}}
+	srv := l.serve(t)
+	if err := Save(Provider{ID: "relay", Name: "Relay", Chat: srv.URL + "/v1", Key: "sk-a",
+		Keys: []KeyAccount{{Key: "sk-b", Off: true}}}); err != nil {
+		t.Fatal(err)
+	}
+	fetch := func() {
+		t.Helper()
+		p, _ := Find("relay")
+		if _, err := p.Fetch(context.Background()); err != nil {
+			t.Fatal(err)
+		}
+	}
+	models := func(key string) []string {
+		p, _ := Find("relay")
+		return p.AccountModels[keyID(key)]
+	}
+	fetch()
+	// the two-key era's own models, as the reporter's were
+	if err := SetAccountModels("relay", keyID("sk-a"), []string{"gpt-6.1-sol", "gpt-6-astra"}); err != nil {
+		t.Fatal(err)
+	}
+	// the vendor takes gpt-6.2-sol on, the user picks it, fetch models runs
+	l.set("sk-a", "gpt-6.1-sol", "gpt-6-astra", "gpt-6.2-sol")
+	fetch()
+	if got := models("sk-a"); !slices.Equal(got, []string{"gpt-6.1-sol", "gpt-6-astra", "gpt-6.2-sol"}) {
+		t.Fatalf("the on key after a fetch: %v, want the vendor's addition ticked", got)
+	}
+	if p, _ := Find("relay"); !p.AccountServes(keyID("sk-a"), "gpt-6.2-sol") {
+		t.Error("the gateway would still refuse the model the vendor took on")
+	}
+
+	// a model the vendor gives up goes out the same way
+	l.set("sk-a", "gpt-6.1-sol", "gpt-6.2-sol")
+	fetch()
+	if got := models("sk-a"); !slices.Equal(got, []string{"gpt-6.1-sol", "gpt-6.2-sol"}) {
+		t.Fatalf("the on key after the vendor gave one up: %v, want it unticked", got)
+	}
+
+	// the user's un-tick of a model the list still has stays
+	if err := SetAccountModels("relay", keyID("sk-a"), []string{"gpt-6.1-sol"}); err != nil {
+		t.Fatal(err)
+	}
+	fetch()
+	if got := models("sk-a"); !slices.Equal(got, []string{"gpt-6.1-sol"}) {
+		t.Fatalf("the user's un-tick undone by a fetch: %v", got)
+	}
+}
diff --git a/internal/provider/models.go b/internal/provider/models.go
index 9a43cf358..134d457d1 100644
--- a/internal/provider/models.go
+++ b/internal/provider/models.go
@@ -548,7 +548,8 @@ func (p Provider) fetchList(ctx context.Context) ([]catalog.Model, error) {
 	}
 	// Only keys in use. An off key is not asked, and its list does not
 	// join the catalog or take capabilities off a key that is on.
-	if keys := p.KeysOn(); len(keys) > 1 {
+	keys := p.KeysOn()
+	if len(keys) > 1 {
 		return p.fetchPerKey(ctx, keys)
 	}
 	l, err := p.fetchOne(ctx)
@@ -566,6 +567,18 @@ func (p Provider) fetchList(ctx context.Context) ([]catalog.Model, error) {
 	if err != nil {
 		return nil, err
 	}
+	// the one key on saw every model of its list: marked, so its models
+	// follow the vendor's list like a multi-key provider's do. Unmarked,
+	// the key was unknown, and its models stayed what an earlier fetch —
+	// often a two-key era's — had ticked, a model the vendor took on
+	// later refused forever (#7076). A lone key's list is the whole of
+	// what the keys' lists have, and stays un-narrowed.
+	if len(keys) == 1 {
+		id := keyID(keys[0].Key)
+		for i := range l.models {
+			l.models[i].Keys = []string{id}
+		}
+	}
 	return catalog.Chat(l.models), catalog.SaveLiveSides(p.ID, l.base, l.models, l.sides)
 }
 
-- 
2.50.1 (Apple Git-155)

```

</details>
