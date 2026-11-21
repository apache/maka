Refreshed on current `main` (`af3334533`) — refreshed, not redesigned: the same change as my earlier branch (`fix/5752-plugin-renewal-dedupe`), rebased onto today's tip, with one part narrowed away because the host itself now covers it.

**What changed since my last post**: yesterday's `6e2dcc4a1` holds a refresh that gives *nothing* back as a failed renewal. That covers the empty answer only. The reporter's own shape is not covered: a refresh that gives back only an `expires` still inside the plugin's `refreshLead` (no new token) — and neither is a new token whose `expires` is still inside it. Both are saved, the hold map is cleared, magpie is told the sign-ins changed and forgets every provider's list, and the next listing renews the same sign-in again — the loop the report is about. This branch now carries only that remaining part; my old empty-answer hunk is dropped in favor of the host's own backoff.

**Red without the fix** (bare `af3334533` + the test and fixture from this branch): `go test ./internal/plugin -run TestRenewalStillDueBacksOff` fails as the report's loop does:

```
d-keep renewed 3 times: a renewal that left the sign-in due was made again at once
d-new renewed 2 times: a renewal that left the sign-in due was made again at once
keep-alive on the still-due sign-in: {Due:true Renewed:false Waiting:false Err:}
a renewal with no new token was saved: ...
```

With the fix: `ok` (1.1s). When the read fails: a stored sign-in that cannot be read never reaches `renewLocked` (`renewAt` answers 0); a save raced by another host returns before anything is held, so the state stays as it was.

**Verification** (all on `af3334533`):
| What | Result |
| --- | --- |
| `go test ./internal/plugin -run TestRenewalStillDueBacksOff` | ok 1.1s |
| full `go test ./internal/plugin` | one failure, `TestHostToldTheGatewayAddress` — runs red on bare `af3334533` too (port timing, `host_addr_test.go:78`); not from this change |
| `go test -race ./internal/plugin` | the same single baseline failure, nothing new |
| `gofmt` / `go vet` | clean |
| `GOOS=linux/windows/darwin go build ./internal/plugin` | ok; `node --check host.js` ok |
| ablation (hold hunks reverted, tests kept) | red again verbatim (`d-keep renewed 3 times, d-new 2`); restored, green |
| `git am` on detached `af3334533` | applies as is; tree identical to the branch head |

**Siblings**: `renewLocked` has one caller (`renew`, under the account's lock). The hold written through `failedRenewal` keeps the shape its two existing writers use: read by `renewal()` (same secret, not older than `retryAfter`) and by `keepSignedIn` (waiting + error). The no-new-token hold sits on the old secret (nothing was saved); the new-token hold sits on the saved secret, so the keep-alive is told why, and the next listing waits. The other `changeAuth` callers are untouched.

**Branch with the commit**: [hunt-20261111-rf-5752](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5752) (head `d097bf152fb98c38f`).

**Not verified**: a real plugin answering the reporter's shape in a live magpie (the fixture `testdata/renew-due/index.js` exercises it against a real host); the reporter's machine.

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: plugin: a renewal that leaves the sign-in still due isn't renewed again at once (#5752) — git am applies it as is; SHA-256 first 16: 74ba73f6ba9ebf78</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 23:41:07 +0800
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

An answer that gives nothing back is held as a failed renewal already
(6e2dcc4a1). renewLocked now also reads the sign-in an answer leaves:
- an answer that renewed nothing (no new token) whose expires is still
  inside the lead: not saved (saving it would only list everything
  again), held back as a failed renewal with the reason, logged; the
  keep-alive is told due/not renewed/waiting with that error, and backs
  off;
- a new token that is still due: saved as before, then held back, so it
  isn't renewed again at once;
- an answer that leaves the sign-in not due: as before.

Run (mote): TestRenewalStillDueBacksOff (testdata/renew-due: lead 1h,
expires +30min, one account per answer shape) runs a real host; red on
the host as of 60559ee73 (d-keep renewed 3 times, d-new 2; the
keep-alive was told nothing; the no-new-token answer was saved), green
with the change. The renewal and keep-alive tests of internal/plugin
pass.

For #5752
Reported-by: hanxuanliang
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/plugin/host.js                     |  43 ++++++--
 internal/plugin/plugin_renew_due_test.go    | 109 ++++++++++++++++++++
 internal/plugin/testdata/renew-due/index.js |  39 +++++++
 3 files changed, 183 insertions(+), 8 deletions(-)
 create mode 100644 internal/plugin/plugin_renew_due_test.go
 create mode 100644 internal/plugin/testdata/renew-due/index.js

diff --git a/internal/plugin/host.js b/internal/plugin/host.js
index 62ac23b46..4e40296cd 100644
--- a/internal/plugin/host.js
+++ b/internal/plugin/host.js
@@ -2882,11 +2882,16 @@ async function apiKey({ provider, method, inputs, key, account, proxy }, signal)
 // the sign-in as it was, for the vendor's answer to tell, and isn't tried
 // again for RENEW_RETRY, doubled for each failure in a row up to
 // RENEW_RETRY_MOST (retryAfter), or, turned away for good, till it is
-// signed in again. A refresh that gives nothing back while the sign-in is
-// due failed too: magpie-ima-auth's swallows ima's "sign in again" and
-// returns undefined, and every request, models listing and usage read
-// asked ima again, ~80 times a minute for two dead accounts
-// (JZGiVvkSOA75376 on X).
+// signed in again. Nor is one that leaves the sign-in still due — an
+// answer whose expires is still inside the plugin's own refreshLead (or
+// one that gives nothing back): such an answer renewed nothing, and
+// making it again at once had every listing and request renew the same
+// sign-in, and every save told magpie the sign-ins changed, so every
+// provider was listed again, endlessly (#5752). A refresh that gives
+// nothing back while the sign-in is due failed too: magpie-ima-auth's
+// swallows ima's "sign in again" and returns undefined, and every
+// request, models listing and usage read asked ima again, ~80 times a
+// minute for two dead accounts (JZGiVvkSOA75376 on X).
 
 const RENEW_LEAD = 5 * 60 * 1000
 const RENEW_WAIT = 15 * 1000
@@ -3103,16 +3108,38 @@ async function renewLocked(provider, key, a, was) {
     failedRenewal(key, was, false, "")
     return
   }
+  const { type: _t, ...fields } = got
+  const next = { ...was, ...fields, type: "oauth" }
+  // An answer that leaves the sign-in still due (its expires still inside
+  // the plugin's own refreshLead) would be renewed again by the next
+  // thing to use the account, and each save tells magpie the sign-ins
+  // changed, which lists every provider again: every plugin's vendor was
+  // asked every few seconds for as long as magpie ran (#5752). So it is
+  // held back as a failed renewal is, and one that renewed nothing (no
+  // new token) isn't saved at all: saving it would only list everything
+  // again.
+  const due = renewAt(a, next)
+  const still = due !== 0 && Date.now() >= due
+  const why = still
+    ? `auth.refresh left the sign-in still due (its expires inside its own refreshLead, ${Math.round(leadOf(a) / 60e3)} min); held back to be tried again later`
+    : ""
+  if (still && !changed(next, was)) {
+    failedRenewal(key, was, false, why)
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
+  if (still) failedRenewal(key, next, false, why)
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

