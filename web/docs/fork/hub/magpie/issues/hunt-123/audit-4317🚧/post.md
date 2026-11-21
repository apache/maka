Your reading of the code is exactly right, and the report reproduces as written: on `9b833205` (the snapshot you ran) both sub-cases of your test fail with your own symptom — session `one` gets its 429, session `two` is answered from the local replay `strict session on available kb blocked by ka's quota: 429 … (out of its allowance: not asked again before …)` — without ever asking the remote.

It is already fixed on the current main, by c37b8b659 (`gateway: a remote magpie's out-of-quota refusal is asked again, not replayed here`) — told from zaidu259434's report of a group whose member moved on the remote, which is the same root cause you traced: a refusal of a remote magpie's own provider rested the remote's model here (`remoteModelRest`) and `quotaHeld` gave it again without asking, whatever session it was for. That commit marks such a rest (`Rest.there`) and `quotaHeld` passes it by: the remote is asked every time, and it holds its strict sessions itself. In your scenario that means session `one` is sent to the remote, which answers from its own hold on `ka` (429, as Strict should), and session `two` is sent too and answered from `kb` (200). Your test, run on current main (`d8b3749e`), passes on both presets, five times in a row.

One gap remained: the tests that came with the fix ask a single session of a mock remote. The face your report names — two sessions of a real remote magpie, each bound to its own key there, one spent and one fine — had nothing holding it in the package. I have added your test as `internal/gateway/remote_strict_quota_test.go` (the reporter's, written as one the package runs): red on `9b833205`, green on the tip, and with the `Rest.there` marking taken out again it fails with your exact message, so it pins the fix itself.

- go test -tags nogui ./internal/gateway -run '^TestRemoteStrictQuotaDoesNotHoldOtherSessions$' -count=5: ok on d8b3749e; FAIL on 9b833205 (both presets, your symptom).
- Ablation (marking lifted): both sub-cases red with your message; restored: green.
- go test -tags nogui -timeout 25m ./internal/gateway/...: ok. -race on the new test: ok. gofmt, go vet, go build ./...: ok.

Patch below, `git am` applies it as is.

Attribution: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.` The test itself is karlsbeard's, from this report, credited in the commit.

<details>
<summary>patch: gateway tests: a remote magpie's strict refusal holds the session it was for alone (#4317) — git am applies it as is; SHA-256 first 16: ecdf5d595d452232</summary>

```diff
From ee84f0add527485215e10e799b9c406b545e64e4 Mon Sep 17 00:00:00 2001
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

Branch: https://github.com/ggbdpq/magpie/tree/fix/4317-strict-429-scope (head ee84f0add527485215e10e799b9c406b545e64e4)
