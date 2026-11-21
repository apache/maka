@yetone — @hanxuanliang's report has the full loop in it, and the reporter's own branch ([`fix/renewal-still-due`](https://github.com/hanxuanliang/magpie/tree/fix/renewal-still-due), patch attached above) fixes the same root cause the same way. This is my own implementation and test of that fix, verified end to end on today's `main` — the host has moved since the reporter's base (`bceeabd93`) — so the two patches back each other up: take whichever lands first, they close the same three answer shapes.

**Root cause**: `renewLocked` (`internal/plugin/host.js`) took *any* object `auth.refresh` gave back for a renewal, whatever it left behind. A plugin with an hour's `refreshLead` that can't really renew — it keeps the token it has and pushes `expires` out half an hour, which is still inside the lead — leaves the sign-in **still due** (`expires - refreshLead` in the past). The host saved that answer, `unrenewed.delete(key)`'d the failed-renewal hold, and sent `auth` — and magpie's `changed()` forgot every provider's list. The next listing renewed the same sign-in again before its models hook, saved again, listed again — the loop never ended, and every listing asked *every* plugin's models hook, so other plugins' vendors were asked too. Two siblings sat beside it: `auth.refresh` giving back nothing (`undefined`) took no hold at all, so every use asked again; and an answer that renewed nothing was saved anyway, the save itself being what re-listed everything.

**The fix** — all in `renewLocked`, where the renewal's answer is judged and written, so every trigger point (request, listing, models, usage, check-in, the keep-alive) gets it through the one renewal they already share:

- nothing given back: held for `RENEW_RETRY` (30s) as a renewal that throws is — before, nothing held it;
- an answer that leaves the sign-in still due is held for `RENEW_RETRY` with the reason, logged. One that renewed nothing (no new token, `changed(next, was)` false) isn't saved at all — saving it would only have magpie list everything again; the keep-alive is told `due / not renewed / waiting` with that error, so `KeepPluginsSignedIn`'s own backoff (which already holds on `r.Due && !r.Renewed`) backs off;
- a new token that is still due: saved as before (it is the vendor's latest word), then held for `RENEW_RETRY` against the sign-in as it now stands, so the next listing or request doesn't make it again at once;
- an answer that leaves the sign-in not due: exactly as before.

**Failure-to-read semantics**: `auth.refresh` giving back nothing is now read as *this renewal failed with no error to tell* — held 30s, `gone: false` (it is not the vendor turning the account away), nothing saved, one error log per attempt (as a throw does). The due check reuses the host's own `renewAt` (same `expires - refreshLead` formula everywhere, no second reckoning).

**Sibling-face scan** — every renewal trigger point and every due reckoning, each left or covered with its reason:

- request hook's `fresh(provider, k)` (`host.js:1985`), listing's `await fresh(id, k)` before a models hook (`:2188` — the storm's own gate), `options` loader (`:3040`), `usageOf` (`:3109`), `checkinOf` (`:3188`), and `keepSignedIn` (`:2869`): all six go through the one `renewal()`, whose existing hold check (`:2825`) is what the new holds are read by — each is covered by the shared fix, none touched.
- due reckonings: `renewAt` (`:2807`) is the only formula; `renewal()` (`:2821`), `keepSignedIn` (`:2867`), `renew()` (`:2951`) and `renewLocked`'s own entry gate (`:2970`) already read it and are untouched; the added check (`:3007`) reads the same `renewAt` against the merged answer — the first place an answer's own `expires` is ever judged.
- Go side, `plugin_keepalive.go`: `look`'s hold (`r.Due && !r.Renewed` → `keepAliveBackoff`) already covers the shape the host now reports (it was only ever told *renewed* before); `plugin.RenewAt` (`providers.go:772`) reads the same `expires - lead` for scheduling and is untouched. Nothing Go-side changed.
- multi-host renewals: the per-account lock file (`lockRenew`) already serializes those; the still-due hold keys on the sign-in's own secret, so a real renewal by another host (the stored sign-in changes) voids it, as for a failure.

<details><summary>patch: plugin: a renewal that leaves the sign-in still due isn't renewed again at once — git am applies it as is; SHA-256 first 16: ef20c9490fd28e75</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 9 Nov 2026 22:58:20 +0800
Subject: [PATCH] plugin: a renewal that leaves the sign-in still due isn't
 renewed again at once
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A plugin that declares an hour's refreshLead and, unable to renew, keeps
the token it has and gives back only an expires half an hour out leaves
the sign-in still due (expires minus the lead is in the past). renewLocked
took that answer for a renewal: it saved it, sent "auth", and magpie's
changed() forgot every provider's list. The next listing renewed the same
sign-in again first, so the loop never ended, and every listing asked
every plugin's models hook — the vendor of every plugin too. On the
reporter's machine the host held 80-170 TLS connections to two unrelated
vendors, and plugin-auth.json was rewritten every 1-3 seconds for as
long as magpie ran (#5752).

renewLocked now reads the sign-in the answer leaves:
- nothing given back: held for RENEW_RETRY as a renewal that throws is —
  before, every use asked the plugin's refresh again;
- an answer that renewed nothing (no new token) whose expires is still
  inside the lead: not saved (saving it would only list everything
  again), held for RENEW_RETRY with the reason, logged; the keep-alive
  is told due/not renewed/waiting with that error, and backs off;
- a new token that is still due: saved as before, then held for
  RENEW_RETRY, so it isn't renewed again at once;
- an answer that leaves the sign-in not due: as before.

Run (mote): TestRenewalStillDueBacksOff (new, testdata/renew-due: lead
1h, expires +30min, one account per answer shape) runs a real host; red
on the old host.js (d-keep renewed 3 times, d-new and d-none 2; the
keep-alive was told nothing; the no-new-token answer was saved), green
with the change. The renewal and keep-alive tests of internal/plugin
and internal/provider pass.

For #5752
Reported-by: hanxuanliang
---
 internal/plugin/host.js                     |  43 +++++++-
 internal/plugin/plugin_renew_due_test.go    | 109 ++++++++++++++++++++
 internal/plugin/testdata/renew-due/index.js |  39 +++++++
 3 files changed, 186 insertions(+), 5 deletions(-)
 create mode 100644 internal/plugin/plugin_renew_due_test.go
 create mode 100644 internal/plugin/testdata/renew-due/index.js

diff --git a/internal/plugin/host.js b/internal/plugin/host.js
index 5530e9ab2..39369f5fe 100644
--- a/internal/plugin/host.js
+++ b/internal/plugin/host.js
@@ -2787,7 +2787,11 @@ async function apiKey({ provider, method, inputs, key, account, proxy }, signal)
 // a refresh token once turns a second away). A renewal that fails leaves
 // the sign-in as it was, for the vendor's answer to tell, and isn't tried
 // again for RENEW_RETRY, or, turned away for good, till it is signed in
-// again.
+// again. Nor is one that leaves the sign-in still due — nothing given
+// back, or an expires still inside the plugin's own refreshLead: such an
+// answer renewed nothing, and making it again at once had every listing
+// and request renew the same sign-in, and every save told magpie the
+// sign-ins changed, so every provider was listed again, endlessly.
 
 const RENEW_LEAD = 5 * 60 * 1000
 const RENEW_WAIT = 15 * 1000
@@ -2982,17 +2986,46 @@ async function renewLocked(provider, key, a, was) {
     send({ event: "log", level: "error", message: `${auths().get(provider)?.spec ?? provider}: auth.refresh: ${e?.message ?? e}` })
     return
   }
-  if (!got || typeof got !== "object") return
+  // Nothing given back: the renewal failed as one that throws does, save
+  // that the plugin had no error to tell. Held back for RENEW_RETRY like
+  // it, for the vendor to be asked again only after that.
+  if (!got || typeof got !== "object") {
+    unrenewed.set(key, { at: Date.now(), secret: secretOf(was), gone: false, error: "" })
+    send({ event: "log", level: "error", message: `${auths().get(provider)?.spec ?? provider}: auth.refresh gave back nothing; tried again in ${RENEW_RETRY / 1000}s` })
+    return
+  }
+  const { type: _t, ...fields } = got
+  const next = { ...was, ...fields, type: "oauth" }
+  // An answer that leaves the sign-in still due (its expires still inside
+  // the plugin's own refreshLead) would be renewed again by the next
+  // thing to use the account, and each save tells magpie the sign-ins
+  // changed, which lists every provider again: every plugin's vendor was
+  // asked every few seconds for as long as magpie ran. So it is held back
+  // for RENEW_RETRY as a failed one is, and one that renewed nothing (no
+  // new token) isn't saved at all: saving it would only list everything
+  // again.
+  const due = renewAt(a, next)
+  const still = due !== 0 && Date.now() >= due
+  const why = still
+    ? `auth.refresh left the sign-in still due (its expires inside its own refreshLead, ${Math.round(leadOf(a) / 60e3)} min); tried again in ${RENEW_RETRY / 1000}s`
+    : ""
+  if (still && !changed(next, was)) {
+    unrenewed.set(key, { at: Date.now(), secret: secretOf(was), gone: false, error: why })
+    send({ event: "log", level: "error", message: `${auths().get(provider)?.spec ?? provider}: ${why}` })
+    return
+  }
   // signed out, signed in again or renewed by another host while it ran:
   // that one stands. Checked under the lock the save is made under, so
   // nothing comes between the two.
-  const { type: _t, ...fields } = got
   const kept = await changeAuth((all) => {
     if (changed(all[key], was)) return false
-    all[key] = { ...was, ...fields, type: "oauth" }
+    all[key] = next
   })
   if (kept === false) return
-  unrenewed.delete(key)
+  // kept, though still due: not renewed again at once (the hold is read
+  // against the sign-in as it now stands)
+  if (still) unrenewed.set(key, { at: Date.now(), secret: secretOf(next), gone: false, error: why })
+  else unrenewed.delete(key)
   forgetAccount(key)
   send({ event: "auth", provider, account: key })
   send({ event: "signIn", provider, account: key, said: "renewed" })
diff --git a/internal/plugin/plugin_renew_due_test.go b/internal/plugin/plugin_renew_due_test.go
new file mode 100644
index 000000000..4dc60f60b
--- /dev/null
+++ b/internal/plugin/plugin_renew_due_test.go
@@ -0,0 +1,109 @@
+package plugin
+
+import (
+	"context"
+	"encoding/json"
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+)
+
+// A renewal that leaves the sign-in still due isn't renewed again by the
+// next thing to use the account: a plugin with an hour's refreshLead
+// that, unable to renew, gives back only an expires half an hour out (or
+// a new token with one, or nothing at all) had every listing, request and
+// keep-alive renew the same sign-in again at once, and each save told
+// magpie the sign-ins changed, which lists every provider again — the
+// vendor of every plugin was asked every few seconds for as long as
+// magpie ran. A renewal like that is held back RENEW_RETRY as a failed
+// one is; one that brought no new token isn't saved, as it renewed
+// nothing; the keep-alive is told why it couldn't, so it backs off.
+func TestRenewalStillDueBacksOff(t *testing.T) {
+	sandbox(t)
+	logf := filepath.Join(t.TempDir(), "renewals")
+	t.Setenv("RENEW_LOG", logf)
+	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
+	defer cancel()
+
+	abs, _ := filepath.Abs("testdata/renew-due/index.js")
+	if _, err := Add(ctx, abs); err != nil {
+		t.Fatal(err)
+	}
+	soon := time.Now().Add(time.Minute).UnixMilli() // inside the hour's lead
+	account := func(who, refresh string) string {
+		t.Helper()
+		k, err := Import(ctx, "dueco", map[string]any{"type": "oauth", "refresh": refresh, "access": "old-" + who, "expires": soon, "accountId": who})
+		if err != nil {
+			t.Fatal(err)
+		}
+		return k
+	}
+	keep := account("keep@due", "d-keep")
+	fresh := account("new@due", "d-new")
+	none := account("none@due", "d-none")
+	stored := func(key string) map[string]any {
+		var all map[string]map[string]any
+		b, _ := os.ReadFile(AuthPath())
+		json.Unmarshal(b, &all)
+		return all[key]
+	}
+	renewals := func(prefix string) int {
+		b, _ := os.ReadFile(logf)
+		n := 0
+		for _, l := range strings.Fields(string(b)) {
+			if strings.HasPrefix(l, prefix) {
+				n++
+			}
+		}
+		return n
+	}
+
+	// one listing renews each due sign-in once, before its models hook
+	if _, err := Providers(ctx); err != nil {
+		t.Fatal(err)
+	}
+	first := time.Now()
+	for _, p := range []string{"d-keep", "d-new", "d-none"} {
+		if n := renewals(p); n != 1 {
+			t.Fatalf("%s renewed %d times by one listing, want 1", p, n)
+		}
+	}
+	// the next listing, a moment later, renews none of them again; nor
+	// does the keep-alive that asks right after it
+	if _, err := Providers(ctx); err != nil {
+		t.Fatal(err)
+	}
+	k, err := KeepSignedIn(ctx, "dueco", keep)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if time.Since(first) < 20*time.Second { // RENEW_RETRY is 30s
+		for _, p := range []string{"d-keep", "d-new", "d-none"} {
+			if n := renewals(p); n != 1 {
+				t.Errorf("%s renewed %d times: a renewal that left the sign-in due was made again at once", p, n)
+			}
+		}
+		// the keep-alive is told why, as from a renewal that failed
+		if !k.Due || k.Renewed || !k.Waiting || !strings.Contains(k.Err, "refreshLead") {
+			t.Errorf("keep-alive on the still-due sign-in: %+v", k)
+		}
+	} else {
+		t.Logf("the two listings took %s, past RENEW_RETRY: renewing again is right", time.Since(first))
+	}
+
+	// a renewal that brought no new token saved nothing: the sign-in as
+	// it was
+	if a := stored(keep); a["access"] != "old-keep@due" || a["refresh"] != "d-keep" || int64(a["expires"].(float64)) != soon {
+		t.Errorf("a renewal with no new token was saved: %v", a)
+	}
+	// a new token, though its expires is still inside the lead: kept
+	if a := stored(fresh); a["access"] != "old-new@due+" || a["refresh"] != "d-new+" {
+		t.Errorf("a renewal's new token wasn't kept: %v", a)
+	}
+	// nothing given back: the sign-in as it was
+	if a := stored(none); a["access"] != "old-none@due" || int64(a["expires"].(float64)) != soon {
+		t.Errorf("a renewal that gave back nothing changed the sign-in: %v", a)
+	}
+}
diff --git a/internal/plugin/testdata/renew-due/index.js b/internal/plugin/testdata/renew-due/index.js
new file mode 100644
index 000000000..abf327ec3
--- /dev/null
+++ b/internal/plugin/testdata/renew-due/index.js
@@ -0,0 +1,39 @@
+// A plugin whose renewal leaves the sign-in still due: its refreshLead
+// is an hour, and every renewal it can't really make pushes expires out
+// by half an hour only, which stays inside that lead. The refresh token
+// says what the renewal gives back: "d-keep…" keeps the token it has and
+// gives a shorter expires, "d-new…" gives a new token with the same
+// short expires, and "d-none…" gives nothing at all. Each renewal is
+// written to $RENEW_LOG as a line naming the refresh token it was
+// given, so a test counts the renewals a listing or a keep-alive makes.
+import fs from "node:fs"
+
+const LEAD = 60 * 60 * 1000
+
+export const RenewDuePlugin = async () => ({
+  config: async (cfg) => {
+    cfg.provider = cfg.provider ?? {}
+    cfg.provider.dueco = {
+      name: "DueCo",
+      npm: "@ai-sdk/openai-compatible",
+      api: "https://due.invalid/v1",
+      models: { "due-1": { name: "Due One", limit: { context: 1000, output: 100 } } },
+    }
+  },
+  provider: {
+    id: "dueco",
+    models: async (provider) => provider.models,
+  },
+  auth: {
+    provider: "dueco",
+    refreshLead: LEAD,
+    methods: [{ type: "api", label: "API key" }],
+    async refresh(auth) {
+      fs.appendFileSync(process.env.RENEW_LOG, auth.refresh + "\n")
+      const expires = Date.now() + 30 * 60 * 1000
+      if (auth.refresh.startsWith("d-none")) return undefined
+      if (auth.refresh.startsWith("d-new")) return { access: auth.access + "+", refresh: auth.refresh + "+", expires }
+      return { expires }
+    },
+  },
+})
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5752-plugin-renewal-dedupe`](https://github.com/ggbdpq/magpie/tree/fix/5752-plugin-renewal-dedupe) (head `86cd26f1314edeec34b9bdd033b5b59656aade01`), rebased onto current `upstream/main` (`a6e4cf763` — fetched again before delivery; the two commits in between touch settings, not `internal/plugin`); on a fresh checkout `git am` applies clean. Raw patch: https://github.com/ggbdpq/magpie/commit/86cd26f1314edeec34b9bdd033b5b59656aade01.patch

| Check | Result |
| --- | --- |
| `TestRenewalStillDueBacksOff` (new, `testdata/renew-due`: lead 1h, `expires` +30min, one account per answer shape) runs a real host | **red on the old host.js** (`d-keep renewed 3 times` by two listings and a keep-alive, `d-new` 2 — its access read `old-new@due++`, the double renewal in the bytes — `d-none` 2; the keep-alive was told `{Due:true Renewed:false Waiting:false}`; the no-new-token answer was saved), **green with the change**: one listing renews each account once, the next listing and a keep-alive renew none, the no-new-token answer isn't saved, the new token is |
| Ablation (product file only, tests kept) | `host.js` reverted to the parent commit (`ddd6c649b`) turns the test red, the same six lines as before the fix; restored, green |
| `TestRenewalStillDueBacksOff` targeted with `-race`, and the renewal/keep-alive family (`-run "Renew\|KeepSignedIn\|Keep\|KeepAlive"`) of `internal/plugin` + `internal/provider` | pass |
| `go test -tags nogui -count=1 -timeout 45m ./...` | 87 packages ok; 4 reds, each checked against this machine, none in the changed path: `TestMothX` and `TestProxyCheckSaysAProxyPassedBy` (the standing proxy reds, HTTP_PROXY `127.0.0.1:7897`), `TestHostToldTheGatewayAddress` (`internal/plugin`) fails the same run alone on the clean parent commit `a6e4cf763`, and `TestCodexAppWorkspaceSwitchReadsEachWorkspace` (`internal/provider`, an upstream test from today) passes alone on both this commit and the parent — red only under the full run |
| `gofmt -l` on the touched tree (`internal/plugin/`) | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | ok (the macOS link prints its usual Xcode version warnings, exits 0) |
| Rebased and re-verified on `upstream/main` `a6e4cf763` | the targeted test ran green on the rebased head before push |

**Not verified**: the reporter's machine (80–170 TLS connections, `plugin-auth.json` every 1–3 seconds) — NOT-RUNNABLE here; what I have is the same shape through a real host with a real plugin fixture: one listing, one renewal per account, and the second listing renews nothing. The reporter's own patch documents the real-machine numbers on the reporter's side. The GUI suite: no GUI file changed. Linux and Windows as *runtime* for this path: not run (the change is in `host.js`, the same on each; vet and build cover them).

**Attribution**: AI-written; I've read the whole diff and the tests pass. The root-cause analysis is @hanxuanliang's (their patch in this issue is the same fix, independently implemented here). Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
