Rework per your review:

**1. "Narrow the class… Add a test that a hanging relay (a timeout body) still rests."** Done. The branch in `restAfterMarked` no longer matches all of `transportWords`: it matches a new `severedWords` — a connection that came up and then dropped, in the words the stack says it with: `unexpected EOF`, `connection lost mid-reply` (magpie's own), `connection (was )?(reset|aborted|closed)` and `forcibly closed`, `broken pipe`, `server closed idle connection`, `ConnectionClosed`, `ECONNRESET`, `ECONNABORTED`, `EPIPE`. What never connected at all, and what timed out waiting — `i/o timeout`, `context deadline exceeded`, `Client.Timeout`, `timeout awaiting response headers`, `TLS handshake timeout`, and the dial/lookup/refused/unreachable words — is not in the class: those rest whatever status carried them, offlineFailure above still taking the down network, the classifications below a relay that answers nothing. The `!connFailed` carve-out is gone with it: no word of `connFailed` is in `severedWords`, so the classes no longer overlap. The new `TestHangingRelayStillRests` walks five timeout bodies (`context deadline exceeded`, `Client.Timeout exceeded while awaiting headers`, `timeout awaiting response headers`, `i/o timeout`, `TLS handshake timeout`) and holds a rest for each, and walks five severed bodies (the mid-reply cut, `connection reset`, `broken pipe`, `forcibly closed`, `ECONNRESET`) and holds none.

**2. "Show it explains the report… reproduce that state from a mid-reply EOF on main, or find the path that really turned the account off."** I could do neither, and the code says the rest is not it. What the read of the repo holds:

- A rest never touches the logins. The `On` of a saved account is written at runtime from exactly one place, `SetLoginOn` (`internal/provider/logins_on.go`), and its only callers are the user's own account commands — `magpie accounts on/off` (`internal/cli/pool_cli.go`) and the GUI's switch (`internal/gui/providers.go`). No rest, no failure classification, nothing in the gateway writes `logins.json` or a login's `On`; the row the reporter read (`on: false`) is the stored value (`On: using || first || l.On`, the line you cited — verified at this tip), not something a rest computed.
- The provider going away is the account provider not being built at all: `provider.Find` fails when `Accounts()` → `codexAccount` says no — `auth.json` unreadable, unparseable, an empty access token, or `AuthMode == "apikey"` (`internal/provider/account.go:1102`), or the account row carrying a `Lapsed` sign-in, which a refused refresh writes (`savedRefreshFailed`, `logins_on.go:377`). All of those live on the sign-in/refresh side, not on the rest side.
- The new `TestMidReplyCutLeavesTheProviderAndItsLogin` shows the rest-side has no such power: the report's cut, and three more rests after it (the backoff ladder the old code built), leave the providers listed — the cut rests, and the provider registry is untouched.

So this patch still fixes the side effect you said it fixes, and the state the report saw has to come from the sign-in's own state — most likely a refresh of the saved sign-in that got refused and marked it lapsed (the machine sits behind a LAN proxy), which removes the account from the serving list while its row stays. I have no access to the reporter's `logins.json` or `app.log`, and I cannot reproduce `on: false` from an EOF on main; if the reporter can attach those two, the real path should fall out in minutes.

**3. The test cleanups.** Both done: the first `restAfter` call is no longer wrapped in a no-op `if` (`_ = r` gone), and the duplicated `restOf` check before the 502 case is gone.

**Evidence**

- RED with the class as wide as you reviewed it (matching all of `transportWords`, minus `connFailed`), the new tests kept:
  ```
  --- FAIL: TestHangingRelayStillRests (0.00s)
      midreply_cut_rest_test.go:73: a hanging relay rested nobody: codex: the reply went silent past its stream idle: context d (said by off)
  ```
- RED with the branch out entirely (ablation, tests kept):
  ```
  --- FAIL: TestMidReplyCutRestsNobody (0.00s)
      midreply_cut_rest_test.go:28: a mid-reply cut rested the account: 1m0s by backoff (OK: codex: connection lost mid-reply (unexpected EOF))
  ```
  (in the same ablation run the other two named tests red as well: `midreply_cut_rest_test.go:90` "a severed connection rested the account", `:118` "a mid-reply cut rested the account")
- Green: `TestMidReplyCutRestsNobody`, `TestHangingRelayStillRests`, `TestMidReplyCutLeavesTheProviderAndItsLogin` green `-count=2` (`ok 1.295s`), and green under `-race` (`ok 2.470s`).
- Whole package `internal/gateway`, branch, isolated run: `FAIL` at 908.2s — exactly 3 reds (`TestOpenCodeGoOwnFreeModelGetsNothingOfOpenCodes`, `TestOpenAIProviderTurnsGoOverWebSocketByDefault`, `TestOpenAIProviderSocketOffNeverDials`), and none of the three touches this patch's faces; each of the 3 is red on `upstream/main` too (base attribution next).
- Base attribution: two full `internal/gateway` runs in the shared environment, `upstream/main` 73 reds vs branch 72; `sort`+`comm` on the red sets (timings stripped): **branch red set ⊆ base red set, zero tip-only** — the one extra base red is `TestClaudeTUIConversationKeepsItsFolderWhenTheCallerMoves`. The 3 isolated-run reds are all present in both sets.
- `gofmt -l` empty on the touched files; `git diff --check` clean; `go vet ./...` clean for GOOS darwin, linux, windows (`-tags nogui`); `go build -tags nogui ./...` ok for the same three targets.
- `git am` on a clean `upstream/main` (`4716a77ff`) replays to a tree byte-identical to the branch tip (`cc65f8035d73279b5b06bbec6e6545f6c4f6cda9`), author preserved as `ggbdpq <ggbdpq@gmail.com>`.

**Siblings**: `transportFailed` (now the only reader of `transportWords`, feeding the too-long/prompt-length classification at `fallback.go:2178`) is untouched — there the full class is the right width, as it only names a failure a transport kind, and rests nobody by itself. `didNotStream` stays deliberately not exempted, as before. `errEndedShort` ("the reply ended before it was complete") is not in `severedWords` and still rests as it did — a vendor's stream ending short is that vendor's doing. `connFailed` and `offlineFailure` are untouched. The branch reads nothing from disk or network; a failed read of the error body holds no severed words and falls through to the classifications as before.

**Not verified**: a real upstream that severs a 12-minute reply (the report's own shape), the reporter's LAN-proxy path, and whether the 499 cancellations before the cut counted toward the backoff ladder. **Not found**: the path that really turned the account off — the evidence above bounds it to the sign-in's own state; the reporter's files would settle it.

Branch: [hunt-20261112-t1-5252](https://github.com/ggbdpq/magpie/tree/cc481f5bfb0c2ed4a10f8401ee828c1903fe17e6) — head `cc481f5bfb0c2ed4a10f8401ee828c1903fe17e6`, rebased onto current `upstream/main` (`4716a77ff`).

Patch: <details><summary>patch: gateway: a stream severed mid-reply rests nobody (#5252) — git am applies it as is; SHA-256 first 16: d66fdcf2e0b1d3b9</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 12 Nov 2026 19:49:03 +0800
Subject: [PATCH] gateway: a stream severed mid-reply rests nobody (#5252)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

roywongx's group sat on codex/gpt-6.1-sol:max when the reply died at
12m26s with "connection lost mid-reply (unexpected EOF)", and the account
was rested for it: by backoff, a minute doubling each time it met the
same end. The vendor had already said 200, so the cut went out as
magpie's own words under that 200, and no exemption restAfter knew passed
it by: offlineFailure wants a 502 and a network that reaches nothing, and
lateRests, the mid-reply path's own gate, has no transport words among
its exemptions. A 502 whose body is the read that failed went the same
way: transportWords knew the words, but only tooLongUnsaid read them, and
that is about a prompt's length.

A connection the stack dropped is no fault of the account: severedWords
— a connection that came up and then dropped (unexpected EOF, reset,
closed, aborted, broken pipe, ECONNRESET, EPIPE, magpie's own words for
the mid-reply cut) — rests nobody, whatever status carried them. What
never connected at all, or timed out waiting, rests as it did: a relay
that hangs on every request has to rest, or nothing would ever fail over
from one that answers nothing (yetone). An answer the vendor did give
rests as it did.

The rest explains none of what the report saw, though: a rest lives in
the gateway's rests alone — the login's On is only ever written by an
account command of the user's, and the provider stays listed however long
the rests run. The state the report saw has to come from the sign-in's
own state, whose files are not at hand here.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/fallback.go               |   9 ++
 internal/gateway/midreply_cut_rest_test.go | 132 +++++++++++++++++++++
 internal/gateway/routing.go                |  13 ++
 3 files changed, 154 insertions(+)
 create mode 100644 internal/gateway/midreply_cut_rest_test.go

diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 9d528ebc9..f90c829b4 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -2244,6 +2244,15 @@ func unsaidOverflows(p provider.Provider, status int) bool {
 // a request that met one may well fit, and is asked again.
 var transportWords = lazyre.New(`(?i)dial (tcp|udp)|connectex|wsarecv|wsasend|i/o timeout|TLS handshake timeout|context deadline exceeded|Client\.Timeout|timeout awaiting response headers|connection (was )?(reset|refused|aborted|closed)|forcibly closed|broken pipe|unexpected EOF|no such host|network is unreachable|no route to host|server closed idle connection|Unable to connect|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE`)
 
+// severedWords are a connection that came up and then dropped, in the words
+// the stack says it with: the request was underway and its read ended under
+// it — an unexpected EOF, a reset, a close, an abort, a broken pipe, or
+// magpie's own words for a reply severed mid-answer (#5252). A transport
+// failure that never connected at all, or one that timed out waiting, is
+// not here: those rest whatever status carried them, or a relay that
+// answers nothing would never be failed over from (yetone).
+var severedWords = lazyre.New(`(?i)unexpected EOF|connection lost mid-reply|connection (was )?(reset|aborted|closed)|forcibly closed|broken pipe|server closed idle connection|ConnectionClosed|ECONNRESET|ECONNABORTED|EPIPE`)
+
 // transportFailed says an error body is a transport failure rather than a
 // vendor's answer (transportWords), or one magpie made of a reply that
 // broke off or said nothing.
diff --git a/internal/gateway/midreply_cut_rest_test.go b/internal/gateway/midreply_cut_rest_test.go
new file mode 100644
index 000000000..4d83270ad
--- /dev/null
+++ b/internal/gateway/midreply_cut_rest_test.go
@@ -0,0 +1,132 @@
+package gateway
+
+import (
+	"net/http"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A reply whose stream the upstream severed mid-answer ends as magpie's
+// own words for it, under the 200 the vendor had already sent (#5252): a
+// Codex reply ran 12m26s, died with "connection lost mid-reply
+// (unexpected EOF)", and the account was rested for it — though the
+// connection dropping is no fault of the account, and the same request is
+// asked again. A 502 whose body is the read that failed was rested too:
+// transportWords knew the words, but only offlineFailure read them, and it
+// wants a down network. Neither rests now; an answer the vendor did give
+// still rests as it did.
+func TestMidReplyCutRestsNobody(t *testing.T) {
+	fresh(t)
+	s := New()
+	acct := candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{Agent: "codex", User: "me@example.com"}}, model: "gpt-6.1-sol", rest: "codex@me@example.com"}
+
+	cut := "codex: connection lost mid-reply (unexpected EOF)"
+	s.restAfter(acct, http.StatusOK, http.Header{}, []byte(cut))
+	if r, ok := restOf(acct.restKey()); ok {
+		t.Fatalf("a mid-reply cut rested the account: %v by %s (%s)", time.Until(r.Until).Round(time.Second), r.By, r.Error)
+	}
+
+	// the same for a 502 whose body is the read that failed, magpie's
+	// wrapper around a stream severed before it said anything
+	r := s.restAfter(acct, http.StatusBadGateway, http.Header{}, []byte("up: connection lost mid-reply (unexpected EOF)"))
+	if r.By == "backoff" || r.By == "cooldown" {
+		t.Fatalf("a severed read rested the account: %v by %s", time.Until(r.Until).Round(time.Second), r.By)
+	}
+	if _, ok := restOf(acct.restKey()); ok {
+		t.Fatalf("a severed read left a rest behind: %v by %s", time.Until(r.Until).Round(time.Second), r.By)
+	}
+
+	// an answer the vendor did give rests as it did: a 502 with nothing
+	// of the transport in it is the vendor failing, and the cooldown stands
+	r = s.restAfter(acct, http.StatusBadGateway, http.Header{}, []byte(`{"error":{"message":"the model had an internal error"}}`))
+	if r.By == "off" {
+		t.Fatalf("a vendor's own 502 no longer rests: %v by %s", time.Until(r.Until).Round(time.Second), r.By)
+	}
+	if _, ok := restOf(acct.restKey()); !ok {
+		t.Fatal("a vendor's own 502 rests nobody now")
+	}
+}
+
+// A relay that hangs on every request ends as a timeout, in the words the
+// transport says it with — i/o timeout, context deadline exceeded,
+// Client.Timeout, timeout awaiting response headers, a TLS handshake that
+// never finished. A connection that came up and then dropped is no fault
+// of the account and rests nobody; one that never came up, or never came
+// back in time, is: it rests, or nothing would ever fail over from a
+// relay that answers nothing (yetone).
+func TestHangingRelayStillRests(t *testing.T) {
+	fresh(t)
+	s := New()
+	acct := candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{Agent: "codex", User: "me@example.com"}}, model: "gpt-6.1-sol", rest: "codex@me@example.com"}
+
+	for _, hang := range []string{
+		"codex: the reply went silent past its stream idle: context deadline exceeded",
+		`Post "https://api.openai.com/v1/replies": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`,
+		"codex: timeout awaiting response headers",
+		"codex: read tcp 10.0.0.8:52417->93.184.216.34:443: i/o timeout",
+		"codex: TLS handshake timeout",
+	} {
+		r := s.restAfter(acct, http.StatusBadGateway, http.Header{}, []byte(hang))
+		if _, ok := restOf(acct.restKey()); !ok {
+			t.Fatalf("a hanging relay rested nobody: %.60s (said by %s)", hang, r.By)
+		}
+		clearRest(acct.restKey())
+	}
+
+	// a connection severed after it was up rests nobody, whatever carried
+	// the words — the same exemption, its own class (unexpected EOF,
+	// reset, closed, aborted, broken pipe, ECONNRESET, EPIPE)
+	for _, cut := range []string{
+		"codex: connection lost mid-reply (unexpected EOF)",
+		"codex: read tcp 10.0.0.8:52417->93.184.216.34:443: connection reset",
+		"codex: write tcp 10.0.0.8:52417->93.184.216.34:443: broken pipe",
+		"codex: an existing connection was forcibly closed by the remote host",
+		"codex: ECONNRESET while reading the reply",
+	} {
+		s.restAfter(acct, http.StatusBadGateway, http.Header{}, []byte(cut))
+		if _, ok := restOf(acct.restKey()); ok {
+			t.Fatalf("a severed connection rested the account: %.60s", cut)
+		}
+	}
+}
+
+// The state the report saw was the account off and the provider gone,
+// "no provider codex", a re-sign-in bringing it back. A rest is not that
+// shape: a rest lives in the gateway's rests alone, and the login's On is
+// only ever written by an account command of the user's (provider
+// logins' SetLoginOn) — no rest and no failure classification writes it.
+// The provider stays listed whatever the account was rested by, the backoff
+// ladder included; the gone provider must have come from the sign-in's own
+// state (auth.json unreadable or lapsed), not from the cut's rest.
+func TestMidReplyCutLeavesTheProviderAndItsLogin(t *testing.T) {
+	fresh(t)
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Anthropic: "https://relay.example/v1", Models: []string{"m1"}}); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := provider.Find("relay"); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	acct := candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{Agent: "codex", User: "me@example.com"}}, model: "gpt-6.1-sol", rest: "codex@me@example.com"}
+
+	// the report's cut: a 12-minute reply ends under the 200 the vendor
+	// had already sent, in magpie's words for the severed read
+	s.restAfter(acct, http.StatusOK, http.Header{}, []byte("codex: connection lost mid-reply (unexpected EOF)"))
+	if r, ok := restOf(acct.restKey()); ok {
+		t.Fatalf("a mid-reply cut rested the account: %v by %s", time.Until(r.Until).Round(time.Second), r.By)
+	}
+	if _, err := provider.Find("relay"); err != nil {
+		t.Fatalf("a provider went away with the cut: %v", err)
+	}
+
+	// and under the backoff the old code made of it: rests, however many
+	// and however long, leave the providers listed
+	for i := 0; i < 3; i++ {
+		s.restAfter(acct, http.StatusBadGateway, http.Header{}, []byte(`{"error":{"message":"the model had an internal error"}}`))
+	}
+	if _, err := provider.Find("relay"); err != nil {
+		t.Fatalf("a provider went away with the rests: %v", err)
+	}
+}
diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index c4e0cddf8..63da7b2c0 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -1531,6 +1531,19 @@ func (s *Server) restAfterMarked(c candidate, status int, header http.Header, bo
 		// was, and is asked again once the network is back (offline.go)
 		return Rest{Why: failOffline, Status: status, By: "off", Until: now}
 	}
+	if severedWords.Match(wordsOf(body)) {
+		// a connection that came up and then dropped (severedWords), in
+		// the words the stack says it, whatever status carried it: a
+		// stream severed mid-reply ends under the 200 the vendor had
+		// already sent, as magpie's own words for it ("connection lost
+		// mid-reply (unexpected EOF)", #5252), and a read that failed ends
+		// a 502 with them. No vendor answer was read; the account is as
+		// good as it was, and the request is asked again. What never
+		// connected at all, or timed out waiting, is not here — those rest
+		// as they did, offlineFailure above taking the down network, the
+		// classifications below a relay that answers nothing
+		return Rest{Why: why, Status: status, By: "off", Until: now}
+	}
 	if regionRefused(status, wordsOf(body)) {
 		// the vendor refused where the request came from (regionWords):
 		// the network's doing, and the edge's the connection reached, not
-- 
2.50.1 (Apple Git-155)

````

</details>

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
