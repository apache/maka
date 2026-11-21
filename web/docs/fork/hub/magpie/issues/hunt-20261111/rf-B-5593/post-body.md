Refreshed on current `main` (`729664580`) — refreshed, not redesigned: same change (a saved Codex account's token refresh keeps its plan as the fresh tokens say), cherry-picked clean onto today's tip.

**Red without the fix** (bare `729664580`, the test from this branch — a Free sign-in saved, then the same account refreshed while the fake vendor says Plus):

```
--- FAIL: TestSavedRefreshUpdatesPlan
```

With the fix: `ok` — the saved account's plan follows the refresh, and routing sorts by the plan the account now has.

**Verification** (all on `729664580`, darwin/arm64):
| What | Result |
| --- | --- |
| `go test ./internal/provider -run TestSavedRefreshUpdatesPlan` | ok |
| full `go test ./internal/provider` | ok 129.5s, zero failures |
| `gofmt` / `go vet` | clean |
| ablation (the plan-keeping hunks reverse-applied, tests kept) | red again; restored, green |
| `git am` on detached `729664580^` | applies as is; tree identical to the branch head |

**Siblings**: the saved plan is read by `OAuth.plan()` (`account.go:839`, the routing side) — this patch keeps it in step with the refresh write (`logins_on.go`); the workspace-switch plan faces (`codex_workspace_*`) read live answers, untouched.

**Branch with the commit**: [hunt-20261111-rf-5593](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5593) (head `2c290901e6bb3918`).

**Not verified**: a real Free→Plus upgrade on a live ChatGPT account (the fixture runs both fakes: Free at sign-in, Plus at refresh).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: codex: a saved account's refresh keeps its plan as the fresh tokens say it (#5593) — git am applies it as is; SHA-256 first 16: 2f93488067dff4e1</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 7 Nov 2026 21:59:25 +0800
Subject: [PATCH] codex: a saved account's refresh keeps its plan as the fresh
 tokens say it (#5593)

A saved ChatGPT account's plan can change behind magpie's back: Free
upgraded to Plus, and the tokens OpenAI answers a refresh with carry
the plan the account is on now. The copy in logins.json was renewed in
its tokens alone, its plan left as the sign-in it was made of named it,
and the routing went on sorting the account into the free tier with the
stale value (OutmanSay, #5593). The ChatGPT API's refresh has kept its
account's plan current all along (siwcFresh); a saved Codex account's
renewal now does the same, reading chatgpt_plan_type off the fresh ID
token, or the access token beside it, and keeping the saved plan as it
was when the fresh tokens name none.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/account.go                 | 15 ++++
 internal/provider/codex_plan_refresh_test.go | 86 ++++++++++++++++++++
 internal/provider/logins_on.go               | 11 +++
 3 files changed, 112 insertions(+)
 create mode 100644 internal/provider/codex_plan_refresh_test.go

diff --git a/internal/provider/account.go b/internal/provider/account.go
index 91298d632..00f0f60dc 100644
--- a/internal/provider/account.go
+++ b/internal/provider/account.go
@@ -1229,6 +1229,21 @@ func codexAccountID(a codexAuth) string {
 	return claimString(jwtClaims(a.Tokens.IDToken), "https://api.openai.com/auth", "chatgpt_account_id")
 }
 
+// codexPlan is the ChatGPT plan a sign-in's tokens name ("free", "plus",
+// "pro" …), as the ID token says it and the access token beside it, ""
+// when neither does. A plan can change behind magpie's back while the
+// saved sign-in is kept as it was: a refresh answered for an upgraded
+// account carries the plan it is now, and the saved one follows it the
+// way the ChatGPT API's refresh does (siwcFresh) (#5593).
+func codexPlan(a codexAuth) string {
+	for _, tok := range []string{a.Tokens.IDToken, a.Tokens.AccessToken} {
+		if p := claimString(jwtClaims(tok), "https://api.openai.com/auth", "chatgpt_plan_type"); p != "" {
+			return p
+		}
+	}
+	return ""
+}
+
 // Why a ChatGPT sign-in is refreshed, in the words codex-rs sends with
 // its own refresh (refresh_reason, login/src/oauth/client.rs).
 const (
diff --git a/internal/provider/codex_plan_refresh_test.go b/internal/provider/codex_plan_refresh_test.go
new file mode 100644
index 000000000..dd8a54313
--- /dev/null
+++ b/internal/provider/codex_plan_refresh_test.go
@@ -0,0 +1,86 @@
+package provider
+
+import (
+	"context"
+	"encoding/json"
+	"net/http"
+	"net/http/httptest"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+)
+
+// planRefreshFakes signs me@ in while on Free, saved to logins.json, and
+// work@ in as Codex's own, so me@'s copy renews where it is kept
+// (logins_on.go) and not in Codex's auth.json. The token refresh is
+// pointed at a fake that answers every refresh with tokens saying Plus:
+// the account upgraded behind magpie's back.
+func planRefreshFakes(t *testing.T) string {
+	t.Helper()
+	home := signIn(t)
+	// me@ was saved while on Free
+	exp := float64(time.Now().Add(time.Hour).Unix())
+	writeFile(t, filepath.Join(home, ".codex", "auth.json"), map[string]any{
+		"auth_mode": "chatgpt",
+		"tokens": map[string]any{
+			"id_token":      fakeJWT(map[string]any{"email": "me@example.com", "https://api.openai.com/auth": map[string]any{"chatgpt_plan_type": "free", "chatgpt_account_id": "acct-1"}}),
+			"access_token":  fakeJWT(map[string]any{"exp": exp}),
+			"refresh_token": "r", "account_id": "acct-1",
+		},
+	})
+	resetRevoked() // marks are read from this HOME's logins.json
+	t.Cleanup(resetRevoked)
+	rememberLogins(true)
+	codexSignIn(t, home, "work@example.com", "r-work")
+	rememberLogins(true)
+	plus := fakeJWT(map[string]any{"email": "me@example.com", "https://api.openai.com/auth": map[string]any{"chatgpt_plan_type": "plus", "chatgpt_account_id": "acct-1"}})
+	refresh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		json.NewEncoder(w).Encode(map[string]any{"access_token": plus, "id_token": plus, "refresh_token": "r-2"})
+	}))
+	t.Cleanup(refresh.Close)
+	oldURL := codexTokenURL
+	codexTokenURL = refresh.URL
+	t.Cleanup(func() { codexTokenURL = oldURL })
+	return home
+}
+
+// savedPlanOf is the plan a saved account's row carries.
+func savedPlanOf(t *testing.T, user string) string {
+	t.Helper()
+	for _, l := range readLogins() {
+		if l.User == user {
+			return l.Plan
+		}
+	}
+	t.Fatalf("no saved account %q", user)
+	return ""
+}
+
+// A saved ChatGPT account's plan can change behind magpie's back: Free
+// upgraded to Plus, and the tokens the refresh answers with say so. The
+// plan the copy was saved with stayed as it was, and the routing went on
+// sorting the account into the free tier with it (OutmanSay, #5593). A
+// refresh keeps the saved plan as the fresh tokens name it, the way the
+// ChatGPT API's refresh does (siwcFresh).
+func TestSavedRefreshUpdatesPlan(t *testing.T) {
+	planRefreshFakes(t)
+	if got := savedPlanOf(t, "me@example.com"); got != "free" {
+		t.Fatalf("saved as %q, want free", got)
+	}
+
+	if _, _, err := renewSavedLogin(context.Background(), "codex", "me@example.com", true); err != nil {
+		t.Fatal(err)
+	}
+
+	// the refreshed sign-in is kept, and the plan follows what its tokens
+	// say now
+	for _, l := range readLogins() {
+		if l.User == "me@example.com" && !strings.Contains(string(l.Auth), `"r-2"`) {
+			t.Fatalf("the refreshed sign-in wasn't kept: %s", l.Auth)
+		}
+	}
+	if got := savedPlanOf(t, "me@example.com"); got != "plus" {
+		t.Fatalf("after the refresh the saved plan is %q, want plus", got)
+	}
+}
diff --git a/internal/provider/logins_on.go b/internal/provider/logins_on.go
index 00147c39b..d8cefade6 100644
--- a/internal/provider/logins_on.go
+++ b/internal/provider/logins_on.go
@@ -316,6 +316,17 @@ func renewSaved(ctx context.Context, agent, user string, force bool, stale strin
 			ls[i].Auth = auth
 			ls[i].Renewed = time.Now().UTC().Truncate(time.Second)
 			ls[i].Lapsed = ""
+			// the refreshed tokens name the plan the account is on now; the
+			// saved one followed the sign-in it was made of, so it follows
+			// the refresh too (#5593). Kept as it was when the fresh tokens
+			// name none (an answer of tokens alone), as the ChatGPT API's
+			// refresh keeps its account's (siwcFresh).
+			var a codexAuth
+			if json.Unmarshal(auth, &a) == nil {
+				if p := codexPlan(a); p != "" {
+					ls[i].Plan = p
+				}
+			}
 		}
 	}
 	return tok, accountID, writeLogins(ls)
-- 
2.50.1 (Apple Git-155)

```
</details>
