# gateway: a remote magpie's key-limit marker never reaches the rest on the group fallback path

**Source**: found by code audit (AI-assisted) of the #2077 family while writing an end-to-end nail for #2167, not from a real failure I hit. The premise is #2077's own product rule as the maintainer stated it there ("only when A refuses for the gateway key's own limit does the whole remote magpie rest", fixed in v0.1.1233 by caa536733/d53a51cd).

## What happens

When the remote magpie's gateway key is over its own limit, its `keyLimited` answers a 429 marked with `X-Magpie-Limit-Reset` (`internal/gateway/key_limit.go:64`, the `remoteKeyLimitHeader` of `key_limit.go:28`). The magpie using it as a Remote magpie provider is meant to read that marker and rest the whole remote, while a refusal without it rests the model alone (`remoteModelRest`, `internal/gateway/routing.go:939`, consumed at `routing.go:908` and in `rateRest` at `routing.go:955`).

On the chat group fallback path the marker never arrives. The turn answers from a `holdWriter`, whose header is its own empty `http.Header{}` (`newHoldWriter`, `internal/gateway/fallback.go:1661`), and the upstream reply's headers reach that header only through `keepRetry` (`internal/gateway/routing.go:1023`). `keepRetry` has six call sites, all on the one whitelist: the `attempt` the group turn runs with the `holdWriter` (`internal/gateway/gateway.go:4487`, called at `gateway.go:2656`), a reply that broke off mid-stream (`internal/gateway/continuation.go:506`), the translated rounds under that attempt (`internal/gateway/search.go:1072`, `internal/gateway/gateway.go:5643`), the count_tokens error branch (`internal/gateway/gateway.go:1321`) and the decision group's last error (`internal/gateway/decide_group.go:238`) — the first four write the answering try's header, the last two pass through to the agent. `keepRetry` copies `Retry-After` and headers naming both `ratelimit` and `reset` — the marker names `reset` but not `ratelimit`, so it is dropped. `restAfterMarked` then reads a header without the marker, reads the key's own limit as one model's refusal, and rests the model alone.

So the half of #2077 that matters most — the key's limit refusing every model alike rests the whole remote — is unreachable on the path a group actually rests by. It works only where the upstream header arrives unfiltered: the count_tokens estimate (`internal/gateway/gateway.go:1316`) and the decision groups' own failure rest (`internal/gateway/decide_group.go:80`, entered with the upstream's own header) pass `res.Header` straight in, which is also why the unit test built on a hand-made `http.Header` (TestRemoteMagpieKeyLimitRestsTheKey) and those paths were green while every real relayed 429 stayed model-scoped.

## Reproduction (deterministic, in-repo)

A fake upstream speaking exactly what `keyLimited` writes: a 429 for `glm/glm-5` carrying `X-Magpie-Limit-Reset` and `Retry-After: 60`, a plain 429 for `kimi/kimi-k3` with no marker, a 200 for anything else; a Remote magpie provider on it; group `office/glm/glm-5, office/kimi/kimi-k3, other/m` (Ordered). One turn, then the rest scopes:

```go
// turn 1: neither remote model answers, other/m serves
// want: restOf("office")          — the key's own limit rests the remote whole
// want: !restOf("office/glm/glm-5") — and not glm alone
// want: restOf("office/kimi/kimi-k3") — kimi's own rate limit rests kimi alone
// turn 2: other/m serves again, the remote's models not asked
```

At `d783df46` the rest lands on `office/glm/glm-5` and `office/kimi/kimi-k3`, never on `office`. `TestRemoteMagpieKeyLimitRestsTheRemote` (in the patch) asserts the whole-remote scope and the silent second turn.

## Root cause and fix

The marker is a routing fact that travels in a header, and the relay is the only hop that strips headers. The fix keeps the whitelist for what it is and adds the one routing header it was missing — the same way `Retry-After` already rides:

```go
if l == "retry-after" || strings.EqualFold(k, remoteKeyLimitHeader) || strings.Contains(l, "ratelimit") && strings.Contains(l, "reset") {
```

A markerless refusal is untouched: `remoteModelRest` still reads an empty header and rests the model alone, and the rest's length is untouched too (`retryAfter` reads only `Retry-After` and `ratelimit…reset`, so the marker changes the scope, never the duration). What does change beside the rest: a last-member pass-through, the translated-error paths and the count_tokens error branch now carry the marker to the agent, as `X-Magpie-Resets-At` already does ("one written straight to the agent carries it, harmlessly") — it is magpie's own marker, meaningful to a next-hop magpie, invisible to other agents.

Patch (against `d783df46`, current `upstream/main`):

<details>
<summary>format-patch</summary>

```
From f4f788baf44b11f8f75f47bc8667380f0a0eb64a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 18 Oct 2026 12:58:44 +0800
Subject: [PATCH] gateway: the other magpie's key-limit marker rides the relay
 to the rest
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

keepRetry copied Retry-After and ratelimit…reset headers from an
upstream refusal onto the holdWriter the group fallback answers from,
and dropped X-Magpie-Limit-Reset (#2077): restAfterMarked then read the
relay's header without the marker, read the remote magpie key's own
limit as one model's refusal and rested the model alone. The whole
remote rested only where the upstream header arrives unfiltered
(count_tokens, the decision groups), never on the chat fallback path
the group turn rests by. The marker is in the relay whitelist now, so
the key's own limit there rests the whole remote, as its keyLimited
means it, and a markerless refusal still rests the model alone.

Run:
- go test -tags nogui -count=1 -run
  TestRemoteMagpieKeyLimitRestsTheRemote ./internal/gateway/ fails
  without the change (the rest lands on office/glm/glm-5, not office)
  and passes with it.
- go test -tags nogui -race -count=2 on the new test and the remote
  magpie rest tests: ok.
- go test -tags nogui -count=1 -run
  'TestRemoteMagpie|TestKeyLimit|TestDecide|RetryAfter|ResetsAt|KeepRetry|Continuation'
  ./internal/gateway/: ok.
- gofmt -l on the two files: clean. go vet ./... on darwin,
  GOOS=linux -tags nogui and GOOS=windows: ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 .../gateway/remote_magpie_key_limit_test.go   | 76 +++++++++++++++++++
 internal/gateway/routing.go                   |  7 +-
 2 files changed, 81 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/remote_magpie_key_limit_test.go b/internal/gateway/remote_magpie_key_limit_test.go
index 441ee606..54aa21f6 100644
--- a/internal/gateway/remote_magpie_key_limit_test.go
+++ b/internal/gateway/remote_magpie_key_limit_test.go
@@ -2,10 +2,12 @@ package gateway
 
 import (
 	"context"
+	"encoding/json"
 	"io"
 	"net/http"
 	"net/http/httptest"
 	"strings"
+	"sync"
 	"sync/atomic"
 	"testing"
 
@@ -97,3 +99,77 @@ func TestRemoteMagpieKeyLimitRestsTheKey(t *testing.T) {
 		t.Error("a provider that isn't a remote magpie rests the model on a quota refusal")
 	}
 }
+
+// The marker comes by wire: the other magpie's keyLimited answers a 429
+// with remoteKeyLimitHeader, and what reaches restAfterMarked here is what
+// the relay kept of the upstream reply. The key's own limit there rests
+// the whole remote, not the model it was asked for — the opposite of that
+// model's own rate limit, which rests it alone
+// (TestRemoteMagpieQuotaRestsTheModel). So asked again, the remote's
+// models are behind the next member, neither of them asked.
+func TestRemoteMagpieKeyLimitRestsTheRemote(t *testing.T) {
+	fresh(t)
+	forgetSinks(t)
+	var mu sync.Mutex
+	var asked []string
+	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		var req struct {
+			Model string `json:"model"`
+		}
+		json.NewDecoder(r.Body).Decode(&req)
+		mu.Lock()
+		asked = append(asked, req.Model)
+		mu.Unlock()
+		w.Header().Set("Content-Type", "application/json")
+		if req.Model == "glm/glm-5" {
+			// what keyLimited answers with: its 429 names when the key
+			// resets, and marks itself the key's own
+			w.Header().Set(remoteKeyLimitHeader, "2026-10-19T00:00:00Z")
+			w.Header().Set("Retry-After", "60")
+			w.WriteHeader(http.StatusTooManyRequests)
+			io.WriteString(w, `{"error":{"message":"gateway key over its request budget","type":"rate_limit_error"}}`)
+			return
+		}
+		if req.Model == "kimi/kimi-k3" {
+			// that model's own rate limit there, no marker: rests alone
+			w.WriteHeader(http.StatusTooManyRequests)
+			io.WriteString(w, `{"error":{"message":"rate limit exceeded, slow down"}}`)
+			return
+		}
+		io.WriteString(w, `{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"from `+req.Model+`"},"finish_reason":"stop"}]}`)
+	}))
+	t.Cleanup(remote.Close)
+	if err := provider.Save(provider.Provider{ID: "office", Name: "Office", Preset: provider.RemoteMagpiePreset, Key: "k",
+		Chat: remote.URL + "/v1", Models: []string{"glm/glm-5", "kimi/kimi-k3"}}); err != nil {
+		t.Fatal(err)
+	}
+	other := &keyed{}
+	serveOn(t, "other", "ko", []string{"m"}, other)
+	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"office/glm/glm-5", "office/kimi/kimi-k3", "other/m"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	// neither of the remote's models answers: the turn goes to the next
+	// member
+	if code, body := postAs(t, s, "", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`); code != 200 || !strings.Contains(body, "from ko") {
+		t.Fatalf("the remote's key limit and its model's rate limit: %d %s", code, body)
+	}
+	// the key's own limit there rests the remote whole; kimi's own rate
+	// limit rests kimi alone
+	if _, ok := restOf("office"); !ok {
+		t.Errorf("the key's own limit there didn't rest the remote whole: %v", rests())
+	}
+	if r, ok := restOf("office/glm/glm-5"); ok {
+		t.Errorf("the key's own limit rested glm alone: %+v %v", r, rests())
+	}
+	if _, ok := restOf("office/kimi/kimi-k3"); !ok {
+		t.Errorf("kimi's own rate limit there didn't rest kimi alone: %v", rests())
+	}
+	// asked again, the remote sits out whole: neither model is
+	mu.Lock()
+	asked = nil
+	mu.Unlock()
+	if code, body := postAs(t, s, "", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`); code != 200 || !strings.Contains(body, "from ko") || len(asked) != 0 {
+		t.Fatalf("the remote's models were asked %v after its key limit: %d %s", asked, code, body)
+	}
+}
diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index 1d81d570..a6554cdd 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -1016,11 +1016,14 @@ func (c candidate) allowance() (provider.Allowance, bool) {
 // keepRetry passes on, with a vendor's error, what it said about when to
 // try again: restAfter reads it to rest the candidate that long, and an
 // agent given the error reads it too. When it said so in the error itself
-// (ChatGPT's resets_at), that goes on as Retry-After.
+// (ChatGPT's resets_at), that goes on as Retry-After. The other magpie's
+// marker that its key's own limit came with goes on too (#2077): the
+// relay's holdWriter answers restAfterMarked, and without it the key's
+// limit reads as one model's refusal and rests the model alone.
 func keepRetry(dst, src http.Header, body []byte) {
 	for k, vs := range src {
 		l := strings.ToLower(k)
-		if l == "retry-after" || strings.Contains(l, "ratelimit") && strings.Contains(l, "reset") {
+		if l == "retry-after" || strings.EqualFold(k, remoteKeyLimitHeader) || strings.Contains(l, "ratelimit") && strings.Contains(l, "reset") {
 			dst[k] = vs
 		}
 	}
-- 
2.50.1 (Apple Git-155)
```

</details>

## Verification

| What | Command / how | Result |
| --- | --- | --- |
| Red without the fix (base `d783df46`) | `go test -tags nogui -count=1 -run TestRemoteMagpieKeyLimitRestsTheRemote ./internal/gateway/` with `internal/gateway/routing.go` reverted and the test kept | `the key's own limit there didn't rest the remote whole: map[office/glm/glm-5:… office/kimi/kimi-k3:…]` and `the key's own limit rested glm alone: {Why:rate Status:429 … By:retry-after … Key:office/glm/glm-5 Model:glm/glm-5}` |
| Green | same command with the fix | `ok github.com/yetone/magpie/internal/gateway` |
| Race | `go test -tags nogui -race -count=2 -run 'TestRemoteMagpieKeyLimit\|TestRemoteMagpieQuotaRestsTheModel\|TestRemoteMagpieRestsTheModel' ./internal/gateway/` | ok |
| Family (named wide enough to include the `keepRetry`-pinning tests) | `go test -tags nogui -count=1 -run 'TestRemoteMagpie\|TestKeyLimit\|TestDecide\|RetryAfter\|ResetsAt\|KeepRetry\|Continuation\|TestQuotaRests\|WrittenReset\|TestRateLimit\|TestFailureReads' ./internal/gateway/` | ok (136 tests and subtests) |
| Format / vet | `gofmt -l` on the two files; `go vet ./...` on darwin, `GOOS=linux -tags nogui` and `GOOS=windows` | clean; ok ×3 |

**Siblings**: `keepRetry`'s six call sites — the group turn's `attempt` (`gateway.go:4487`), a reply that broke off mid-stream (`continuation.go:506`), the translated rounds under it (`search.go:1072`, `gateway.go:5643`), the count_tokens error branch (`gateway.go:1321`) and the decision group's last error (`decide_group.go:238`) — are all fed by the one whitelist, so one entry covers all. And what a relayed rest reads is that one header too: the held try's rest reads `hw.header` (`restAfterMarked`/`restAfter` at `gateway.go:3148, 3258, 3273, 3353, 3386`), whose only source of upstream headers is `keepRetry` — `newHoldWriter` starts it empty (`fallback.go:1661`) and every other write is magpie's own note. Checked and left: the count_tokens 429 (`gateway.go:1316`) and the decision groups' own failure rest (`decide_group.go:80`, entered with the upstream's own header from `decide_group.go:213` and `decide_group.go:308`) pass `res.Header` straight in and already scope correctly; the forward-error and unreachable-decision paths rest with a nil header (`gateway.go:1301`, `decide_group.go:182, 312`), where no marker can exist; the two synthetic-reply rewrites (`asBadGateway`, `notapi.go:91`; the dropped-request 503, `codex_dropped.go:78`) clone the upstream header whole into a reply the usual pipeline then reads, so they keep the marker rather than drop it; the Codex search and backend passes copy headers on non-rest paths only; `Retry-After` and `ratelimit…reset` headers already pass the whitelist; `remoteModelRest`'s other consumer `rateRest` (`routing.go:955`) reads the same header object and needs nothing; the marker is not read anywhere else (`rg 'remoteKeyLimitHeader'` — one write in `keyLimited`, one presence read in `remoteModelRest`). The tests that pin `keepRetry` itself (`quota_rest_test.go`, `written_reset_test.go`, `rate_backoff_test.go`) pass unchanged, and the Family run above names them.

**When the read fails**: a relay between the two magpies that strips the header degrades to today's model-level rest — the failure mode this fix removes, never a wider rest than the evidence names. A marker that arrives empty reads as absent (`remoteModelRest` checks presence, `routing.go:940`) and rests the model alone, as before. A marker with a malformed value still counts as present: its value is never parsed, so it changes the rest's scope, never its length (`retryAfter` reads only `Retry-After` and `ratelimit…reset` names; `resetsNoted` reads only `X-Magpie-Resets-At`), and it cannot panic — a bogus marker resting the remote whole is the same trust in the other magpie's own word that the marker's presence already is under #2077's rule. No file or saved-state reads change.

**Not verified**: a real two-machine magpie-to-magpie deployment; the fixture writes the header exactly as `keyLimited` writes it (name, RFC3339 value, beside `Retry-After`), and the maintainer's own #2077 check ran two real gateways over HTTP.

**AI**: I've read the whole diff and can answer questions on it myself.
