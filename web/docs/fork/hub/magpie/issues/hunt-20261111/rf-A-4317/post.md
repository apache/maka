Refresh of my patch above, not a redesign: the same single test commit rebased onto current `upstream/main` (`60559ee73`) and the whole verification re-run, because the branch had drifted ~1200 commits since November 4. The product fix this test pins is still on main (`c37b8b659`, the `Rest.there` marking and `quotaHeld` passing there-rests by), and the test file still is not on main, so the test remains the only thing holding the two-sessions-of-a-real-remote face.

**What this is**: the reporter's own test, written as one the package runs — `TestRemoteStrictQuotaDoesNotHoldOtherSessions`, two strict sessions of a remote magpie bound to two of its keys, one key spent. The spent session keeps its 429; the other session is answered from its own key instead of being blocked by a model-level hold replayed from the remote's refusal.

<details><summary>patch: gateway tests: a remote magpie's strict refusal holds the session it was for alone (#4317) — git am applies it as is; SHA-256 first 16: f418764656701260</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 05:52:52 +0800
Subject: [PATCH] gateway tests: a remote magpie's strict refusal holds the
 session it was for alone (#4317)

karlsbeard reports a strict session of a remote magpie refused for the
account it is bound to there holding another session of the same model,
whose account there still answers: this magpie rested the remote's
model (remoteModelRest) and gave the refusal again through quotaHeld
without asking the remote, which routes its strict sessions itself.
That replay is what c37b8b659 took away (Rest.there, quotaHeld passes
it by), told from a report of a group whose member moved there; its
tests ask one session of a mock remote. This one asks two sessions of
a real remote magpie, each bound to its own key there, one key spent:
the spent session gets its 429 as before, and the other is answered
from its own key. Red on 9b833205, the snapshot the report ran on,
both presets; green on the tip; with the marking taken out again it
fails as the report says ("strict session on available kb blocked by
ka's quota: 429"). The test is the reporter's, written as one the
package runs.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/remote_strict_quota_test.go | 65 ++++++++++++++++++++
 1 file changed, 65 insertions(+)
 create mode 100644 internal/gateway/remote_strict_quota_test.go

diff --git a/internal/gateway/remote_strict_quota_test.go b/internal/gateway/remote_strict_quota_test.go
new file mode 100644
index 000000000..1f2627185
--- /dev/null
+++ b/internal/gateway/remote_strict_quota_test.go
@@ -0,0 +1,65 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// TestRemoteStrictQuotaDoesNotHoldOtherSessions keeps a remote magpie's
+// strict session, refused for the account it is bound to there, from
+// holding another session of the same model that is bound to an account
+// still served there (#4317).
+func TestRemoteStrictQuotaDoesNotHoldOtherSessions(t *testing.T) {
+	for _, preset := range []string{provider.RemoteMagpiePreset, ""} {
+		t.Run("preset="+preset, func(t *testing.T) { remoteStrictQuotaDoesNotHoldOtherSessions(t, preset) })
+	}
+}
+
+func remoteStrictQuotaDoesNotHoldOtherSessions(t *testing.T, preset string) {
+	fresh(t)
+	v := &keyed{}
+	spent := false
+	serveOn(t, "accounts", "ka", []string{"m"}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if spent && r.Header.Get("Authorization") == "Bearer ka" {
+			w.Header().Set("Content-Type", "application/json")
+			w.Header().Set("Retry-After", "600")
+			w.WriteHeader(http.StatusTooManyRequests)
+			io.WriteString(w, `{"error":{"message":"quota exhausted"}}`)
+			return
+		}
+		v.ServeHTTP(w, r)
+	}), "kb")
+	if err := provider.SetRouting("accounts", provider.Rotate); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SetAffinity("accounts", provider.AffinityStrict); err != nil {
+		t.Fatal(err)
+	}
+	remote := httptest.NewServer(New().Handler())
+	t.Cleanup(remote.Close)
+	if err := provider.Save(provider.Provider{ID: "office", Name: "Remote magpie", Preset: preset, Key: "rk",
+		Chat: remote.URL + "/v1", Models: []string{"accounts/m"}}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	body := func(session string) string {
+		return `{"model":"office/accounts/m","messages":[{"role":"user","content":"hi ` + session + `"}]}`
+	}
+	for _, tc := range []struct{ session, key string }{{"one", "ka"}, {"two", "kb"}} {
+		if code, got := postAs(t, s, tc.session, body(tc.session)); code != 200 || !strings.Contains(got, "from "+tc.key) {
+			t.Fatalf("session %s opening: %d %s; want %s", tc.session, code, got, tc.key)
+		}
+	}
+	spent = true
+	if code, got := postAs(t, s, "one", body("one")); code != 429 {
+		t.Fatalf("strict session on exhausted ka: %d %s; want 429", code, got)
+	}
+	if code, got := postAs(t, s, "two", body("two")); code != 200 || !strings.Contains(got, "from kb") {
+		t.Fatalf("strict session on available kb blocked by ka's quota: %d %s", code, got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`hunt-20261111-rf-4317`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-4317) (head `08c4a4ebe92181bbdab2557e8ad64a76c56e2781`), rebased onto current `upstream/main` (`60559ee73`); on a fresh checkout `git am` applies it as is (replayed on a detached `60559ee73` worktree, resulting tree identical to the branch head, checked by tree hash).

Verification this round (all run on `60559ee73` + this commit, `GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `TestRemoteStrictQuotaDoesNotHoldOtherSessions` -count=3 | ok (2.367s), both presets |
| Ablation: the `Rest.there` marking (`id, r.there = c.restID(), true` in `restOf`) lifted, test kept | red on both presets with the report's own message: `strict session on available kb blocked by ka's quota: 429`; restored: green |
| `go test -race -run '^TestRemoteStrictQuotaDoesNotHoldOtherSessions$|^TestRemoteMagpie'` | ok (17.233s) |
| `gofmt -l internal/gateway/remote_strict_quota_test.go` | prints nothing |
| `go vet -tags nogui ./internal/gateway/` | clean |
| `go build -tags nogui ./...` darwin / `GOOS=linux` / `GOOS=windows` | clean |
| `go test -tags nogui -timeout 40m -count=1 ./internal/gateway/` (whole package, 1447s) | one failure: `TestKeyLimitReservationsStayInTheirWindow`, the pre-existing red on this machine (red at the parent commit too, first seen `da169135a`); no other failure |

**Siblings**: main already carries the mechanism's other faces — `remote_magpie_rest_test.go` (one model's 429 rests that model alone), `remote_magpie_key_limit_test.go` (the key's own limit there refuses every model alike), `remote_magpie_restricted_test.go` (restricted/verify refusals). `rg TestRemoteStrict` on main: only this file names the two-strict-sessions face. No other call site needed touching; the patch adds one test file and changes no product code.

**Not verified**: a real second magpie instance on another machine (httptest stand-ins both sides, as in the original post); reporter's original environment.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`. The test itself is karlsbeard's, from this report, credited in the commit.
