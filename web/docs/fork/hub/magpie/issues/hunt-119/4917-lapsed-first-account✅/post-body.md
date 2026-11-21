A provider's row said its list had fallen back whenever its **first account's** list had, even when another account of the same provider told the list fine.

## Symptom

As reported: a Kiro oauth the vendor turned away (lapsed, hidden) sits under the provider's own key in `plugin-auth.json`, the API key in use beside it. The provider's models are the accounts' union, so the list itself is told (on current `main`; on the build this was filed against, the row also shrank to the plugin's default) — but the row kept saying `fellBack: true` with the lapsed account's list error, and with that row:

- `keepListed` took the provider for fallen back and put the last list told over the fresh one: a model the vendor added never showed up and one it dropped stayed listed, for as long as the lapsed account stood first (the workaround of removing it un-freezes this, as the reporter found);
- the hourly relist treated the provider as if its list had never been read, so the picks of models the vendor no longer lists were never set aside;
- `magpie plugin list` said the provider fell back.

## Root cause

`internal/plugin/host.js` asks the provider's own list of its first account (`info(id, undefined)` → `accountsOf(readAuth(), id)[0]`), and `rowOf` took the provider-level `fellBack`/`listError` from that one listing. Since the accounts' lists are unioned into the provider's (`566ae09db`), the provider's list falls back only when **no** account tells a list of its own — the first account alone failing doesn't say the provider fell back.

## Fix

`rowOf`: `fellBack` is now `p.fellBack && own.every(q => !q || q.fellBack || q.failed)` — the provider fell back only when every account's listing fell back or failed; `listError` follows it. Each account's own entry keeps its honest `fellBack`/`listError`. The Go side (`keepListed`, `pluginListedIDs`, `keptListed`) reads only these provider-level fields and needs no change: keep-last-good still applies where every account fell back.

## Verification

| Check | Result |
|-------|--------|
| `TestLapsedFirstAccountKeepsTheProvidersList` (internal/plugin, new) | fails on the parent (`a lapsed first account said the provider fell back`), passes here; with the vendor's list changed while the first account stays lapsed, the provider's list follows (`fake-newer` in, `fake-extra` out) |
| `TestFallenBackListSaysWhy`, `TestFallenBackListKeepsTheLastOne` (keep-last-good family) | pass — a provider whose every account falls back still keeps the last list told |
| plugin-related suites of internal/provider (`-run 'TestPlugin\|TestRelist\|TestDropGone\|TestFallenBack\|TestKiro'`), fetchedCount of internal/gui | pass |
| `go test -tags nogui -count=1 ./internal/plugin` | passes except the pre-existing `TestHostToldTheGatewayAddress` (fails on the parent too: `after the port moved … MAGPIE_ADDR=127.0.0.1:<old>`) |
| `go test -tags nogui -count=1 ./...` | 82 packages pass; 5 failures, all pre-existing on the parent or known full-run flakes, each re-run alone on a clean parent worktree: `TestMothX` (agent), `TestEveryRouteHasACommandOrIsNamed` (cli), `TestProxyCheckSaysAProxyPassedBy` (gui), `TestHostToldTheGatewayAddress` (plugin) fail there too; `TestCodexPoolSaysTheClientsVersion` (gateway) passes alone |
| `gofmt -l`, `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean (two pre-existing cgo `-Wenum-conversion` warnings in internal/gui, untouched) |
| `go build` darwin, linux (`-tags nogui`), windows | pass |
| ablation: the `rowOf` change reverted by hand, test kept | the new test fails again; passes once restored |

## Not verified

- Not tried with the real Kiro plugin and real accounts: the repo's fake test plugin stands in, shaped as the report's `plugin-auth.json` — a lapsed oauth under the provider's own key whose models hook throws (`HTTP 400` in the report, a thrown refusal in the test), a live API key beside it whose hook lists the vendor's models.
- The reporter's first two expectations are met on current `main` by the union itself (the list and the "Fetch models again" count follow the accounts that list fine); this patch stops the first account's failure from masking that — the row, `keepListed` and the relist. `magpie plugin list` still names the first account (`accountId` stays "the one kept under its own id", as the accounts' list documents); the accounts page and the provider's serving list follow the account in use.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: plugin: a lapsed account kept first doesn't say the provider fell back (#4917) — git am applies it as is; SHA-256 first 16: 080fbc3f462f20c3</summary>

```
From 812d1aa151fbbfde42d1f10775cbea269bab99e8 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 00:47:15 +0800
Subject: [PATCH] plugin: a lapsed account kept first doesn't say the provider
 fell back (#4917)

The provider's own row took fellBack and listError from its first
account's listing, whatever stood first in the sign-ins. With a lapsed
sign-in kept under the provider's own key beside a live account (a Kiro
oauth the vendor turned away beside the API key in use), the provider
said its list had fallen back although the live account's list told it:
the models are the accounts' union, so the provider falls back only when
no account tells a list of its own. Reading that row, keepListed put the
last list told over the fresh one and the relist stopped dropping the
picks of models the vendor no longer lists, for as long as the lapsed
account stood first; magpie plugin list said the provider fell back.

The last list told is still kept where every account fell back.

Fixes #4917

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/plugin/host.js                   | 10 ++-
 internal/plugin/plugin_list_error_test.go | 75 +++++++++++++++++++++++
 2 files changed, 83 insertions(+), 2 deletions(-)

diff --git a/internal/plugin/host.js b/internal/plugin/host.js
index 579ce505a..e89d248df 100644
--- a/internal/plugin/host.js
+++ b/internal/plugin/host.js
@@ -2149,6 +2149,12 @@ function rowOf(id, a, keys, stored, p, own) {
   for (const q of own) for (const [k, m] of Object.entries(q?.models ?? {})) models[k] ??= m
   const ids = (q) => Object.values(q.models).filter((m) => m.status !== "deprecated").map((m) => m.id)
   const first = stored[keys[0]]
+  // the provider's list is its accounts' union, so it fell back only when
+  // no account told a list of its own: a lapsed account kept first beside
+  // a live one doesn't say the provider fell back, and its list goes on
+  // moving (the last one told is kept for a provider whose every account
+  // fell back) (#4917)
+  const fellBack = keys.length > 0 && !!p.fellBack && own.every((q) => !q || q.fellBack || q.failed)
   return {
     id,
     spec: a.spec,
@@ -2168,8 +2174,8 @@ function rowOf(id, a, keys, stored, p, own) {
     signedIn: keys.length > 0,
     authType: first?.type ?? "",
     accountId: whoOf(first),
-    fellBack: keys.length > 0 && !!p.fellBack,
-    listError: keys.length > 0 && p.fellBack ? p.listError ?? "" : "",
+    fellBack,
+    listError: fellBack ? p.listError ?? "" : "",
     accounts: keys.map((k, i) => ({
       key: k,
       type: stored[k]?.type ?? "",
diff --git a/internal/plugin/plugin_list_error_test.go b/internal/plugin/plugin_list_error_test.go
index cb8698239..fcd8f3626 100644
--- a/internal/plugin/plugin_list_error_test.go
+++ b/internal/plugin/plugin_list_error_test.go
@@ -5,6 +5,7 @@ import (
 	"net/http"
 	"net/http/httptest"
 	"path/filepath"
+	"slices"
 	"sync/atomic"
 	"testing"
 	"time"
@@ -79,3 +80,77 @@ func listSaysWhy(t *testing.T, throws string) {
 		}
 	}
 }
+
+// A lapsed account kept first in the sign-ins (#4917) fails its own list,
+// but one it stands beside lists fine: the provider's list is the accounts'
+// union, so the provider hasn't fallen back, and the list it told goes
+// when its vendor's changes — the last one told is kept for a provider
+// whose every account fell back, not for one whose list was told.
+func TestLapsedFirstAccountKeepsTheProvidersList(t *testing.T) {
+	sandbox(t)
+	Restart()
+	provMu.Lock()
+	provCache = nil
+	provMu.Unlock()
+	var name atomic.Value
+	name.Store("extra")
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		w.Write([]byte(name.Load().(string)))
+	}))
+	defer srv.Close()
+	t.Setenv("FAKE_MODELS", srv.URL+"/models")
+	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
+	defer cancel()
+	abs, _ := filepath.Abs("testdata/fake/index.js")
+	if _, err := Add(ctx, abs); err != nil {
+		t.Fatal(err)
+	}
+	// a lapsed sign-in under the provider's own key, a live one beside it,
+	// as a Kiro oauth the vendor turned away kept first beside an API key
+	if _, err := Import(ctx, "fakeco", map[string]any{"type": "oauth", "refresh": "r-dead", "access": "stale", "expires": time.Now().Add(time.Hour).UnixMilli(), "accountId": "Lapsed"}); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := APIKey(ctx, "fakeco", 0, nil, "live", NewAccount); err != nil {
+		t.Fatal(err)
+	}
+	has := func(ps []Provider, id string) bool {
+		t.Helper()
+		if len(ps) != 1 || len(ps[0].Accounts) != 2 {
+			t.Fatalf("Providers = %+v", ps)
+		}
+		return slices.ContainsFunc(ps[0].Models, func(m Model) bool { return m.ID == id })
+	}
+	ps, err := Providers(ctx)
+	if err != nil || !has(ps, "fake-extra") {
+		t.Fatalf("with the vendor up, Providers = %+v, %v", ps, err)
+	}
+	// the lapsed account fell back; the provider, listing by the live one,
+	// didn't
+	if ps[0].FellBack || ps[0].ListError != "" {
+		t.Fatalf("a lapsed first account said the provider fell back saying %q (fellBack %v)", ps[0].ListError, ps[0].FellBack)
+	}
+	var lapsed, live *Account
+	for i := range ps[0].Accounts {
+		if ps[0].Accounts[i].Type == "oauth" {
+			lapsed = &ps[0].Accounts[i]
+		} else {
+			live = &ps[0].Accounts[i]
+		}
+	}
+	if lapsed == nil || !lapsed.FellBack || lapsed.ListError == "" {
+		t.Fatalf("the lapsed account says %+v", lapsed)
+	}
+	if live == nil || live.FellBack || live.ListError != "" {
+		t.Fatalf("the live account says %+v", live)
+	}
+
+	// the vendor's list changes: the provider's follows it, though its
+	// first account stays lapsed
+	name.Store("newer")
+	if ps, err = Providers(ctx); err != nil || !has(ps, "fake-newer") || has(ps, "fake-extra") {
+		t.Fatalf("with the vendor's list changed, Providers = %+v, %v", ps, err)
+	}
+	if ps[0].FellBack {
+		t.Fatalf("a lapsed first account says the provider fell back")
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4917-lapsed-first-account](https://github.com/ggbdpq/magpie/tree/fix/4917-lapsed-first-account) (head `812d1aa15`).
