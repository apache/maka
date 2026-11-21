Refreshed, not redesigned — the same test-only patch from [the original post](https://github.com/yetone/magpie/issues/4202#issuecomment-6618349158) and [the November 9 refresh](https://github.com/yetone/magpie/issues/4202#issuecomment-6748483509), rebased onto current `upstream/main` (`60559ee73`, 519 commits past `0d99261dc`, the base of that refresh). Zero conflicts: upstream has not touched `internal/gateway/remote_magpie_held_test.go` (the only file this patch adds to), and both guards the test pins are byte-identical on the new tip — `quotaHeld`'s `r.there` term (`internal/gateway/fallback.go:1429`) and `vendorTimed`'s (`fallback.go:1483`) — so a remote magpie's out-of-quota refusal is still asked again, never replayed, on both hold faces.

Verification on the new base (`60559ee73` + this commit):
| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 -run '^TestRemoteMagpie429IsAskedNotReplayed$' ./internal/gateway` | ok 1.447s |
| same with `-race` | ok 2.528s |
| `go test -tags nogui -count=1 -timeout 40m ./internal/gateway` | 1455.8s, one failure: `TestKeyLimitReservationsStayInTheirWindow` — the tracker's pre-existing red (red since `da169135a`, before this base); no new failures |
| `gofmt -l` on the touched file; `go vet -tags nogui ./internal/gateway` | clean; clean |
| `GOOS=linux go build -tags nogui ./...`; `GOOS=windows` | ok; ok |

Ablation re-done on the new base, the mutation one line at the semantic fork: the `r.there` term lifted from `quotaHeld`'s guard (1 file, 1 insertion, 1 deletion, tests kept) → red with the reporter's symptom word for word:
```
429 … You've hit your session limit · resets 3pm (Asia/Singapore) (out of its allowance: not asked again before 01:27 UTC+8) … the remote was asked 0 times
```
→ restored → green (1.490s).

**Siblings** (`0d99261dc..60559ee73`): `fallback.go` moved (10 commits) but both `r.there` guards are byte-identical from the old base to the tip (`quotaHeld` at :1429, `vendorTimed` at :1483); `remote_magpie_held_test.go` untouched upstream. Changed in the patch: nothing but the added test. Left: every other rest-holder — they hold rests magpie guessed itself, which `asksAt`/`restProbe` already re-ask (the first post's table).

**When the read fails**: not applicable — the commit adds a test; no read path changes.

Fresh at post time: `upstream/main` moved 11 commits past `60559ee73` (to `12610cf2f`) between the rebase and this post; none of them touches `remote_magpie_held_test.go` or `fallback.go`, so the patch's base claim stands.

**Not verified**: nothing new beyond the original post's caveats (no reproduction attempt on 0.1.1290; the pinned behaviors are exercised in-package on the new base).

**Patch**: <details><summary>patch: gateway: tests: a remote magpie's 429 out of quota is asked again too, not replayed (#4202, XIQI) — git am applies it as is; SHA-256 first 16: 02a123ddc217e6e9</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 07:42:43 +0800
Subject: [PATCH] gateway: tests: a remote magpie's 429 out of quota is asked
 again too, not replayed (#4202, XIQI)

---
 internal/gateway/remote_magpie_held_test.go | 75 +++++++++++++++++++++
 1 file changed, 75 insertions(+)

diff --git a/internal/gateway/remote_magpie_held_test.go b/internal/gateway/remote_magpie_held_test.go
index 9dbed1a7f..c69f98e47 100644
--- a/internal/gateway/remote_magpie_held_test.go
+++ b/internal/gateway/remote_magpie_held_test.go
@@ -2,6 +2,7 @@ package gateway
 
 import (
 	"encoding/json"
+	"fmt"
 	"io"
 	"net/http"
 	"net/http/httptest"
@@ -71,6 +72,80 @@ func TestRemoteMagpieQuotaIsAskedNotReplayed(t *testing.T) {
 	}
 }
 
+// XIQI's #4202: a group on another computer's magpie whose lone member was
+// refused with a 429 that named a session limit ("You've hit your session
+// limit · resets 3pm"), so this magpie rested the remote's model for as
+// long as the Retry-After it passed on said (an hour, the most a Retry-After
+// is trusted), and gave the 429 again on every request for the rest of the
+// hour — the remote's own quota had come back an hour before that, and the
+// client was still told the session limit. A 429 out of quota rests that
+// model of the remote as a 402 does (remoteModelRest), so it is asked again
+// all the same: the remote holds its own rests, and asks the official one
+// again as its own rest ends.
+func TestRemoteMagpie429IsAskedNotReplayed(t *testing.T) {
+	fresh(t)
+	var mu sync.Mutex
+	spent := true
+	asked := 0
+	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		var req struct {
+			Model string `json:"model"`
+		}
+		json.NewDecoder(r.Body).Decode(&req)
+		mu.Lock()
+		asked++
+		out := spent
+		mu.Unlock()
+		w.Header().Set("Content-Type", "application/json")
+		if out {
+			// what the remote says holding its group's lone member against
+			// the official "session limit · resets 3pm": its own Retry-After
+			// for when it will ask the official one again
+			w.Header().Set("Retry-After", "3600")
+			w.Header().Set(providerHeader, "claude")
+			w.WriteHeader(http.StatusTooManyRequests)
+			io.WriteString(w, `{"error":{"type":"rate_limit_error","message":"Magpie: Claude Code: You've hit your session limit · resets 3pm (Asia/Singapore)"}}`)
+			return
+		}
+		// the model is a Claude one, asked on Anthropic's Messages as the
+		// remote serves it there
+		w.Header().Set("Content-Type", "text/event-stream")
+		for _, event := range []string{
+			`{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"` + req.Model + `","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
+			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
+			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"once the official reset came"}}`,
+			`{"type":"content_block_stop","index":0}`,
+			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
+			`{"type":"message_stop"}`,
+		} {
+			fmt.Fprintf(w, "data: %s\n\n", event)
+		}
+	}))
+	t.Cleanup(remote.Close)
+	if err := provider.Save(provider.Provider{ID: "office", Name: "Remote magpie", Preset: provider.RemoteMagpiePreset, Key: "k",
+		Chat: remote.URL + "/v1", Models: []string{"group/claude-sonnet-5.5"}}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	body := `{"model":"office/group/claude-sonnet-5.5","messages":[{"role":"user","content":"hi"}]}`
+	if code, got := postAs(t, s, "", body); code != http.StatusTooManyRequests {
+		t.Fatalf("the remote's 429: %d %s", code, got)
+	}
+	// a second refusal, as the agent's retry meets it
+	postAs(t, s, "", body)
+	// the official quota comes back on the remote, as a reset does
+	mu.Lock()
+	spent, asked = false, 0
+	mu.Unlock()
+	code, got := postAs(t, s, "", body)
+	mu.Lock()
+	n := asked
+	mu.Unlock()
+	if code != http.StatusOK || !strings.Contains(got, "once the official reset came") || n != 1 {
+		t.Fatalf("after the official reset came: %d %s; the remote was asked %d times", code, got, n)
+	}
+}
+
 // The same for a magpie added by hand, as a plain OpenAI-compatible
 // provider: its reply names the provider that answered there.
 func TestHandAddedMagpieQuotaIsAskedNotReplayed(t *testing.T) {
-- 
2.50.1 (Apple Git-155)

````

</details>

Branch with the commit: [fix/4202-nested-retryafter](https://github.com/ggbdpq/magpie/tree/fix/4202-nested-retryafter) (head `b331fe5fe3f365483d07618ebcdb9e1f41d26d2a`, pushed with an explicit-sha refspec).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
