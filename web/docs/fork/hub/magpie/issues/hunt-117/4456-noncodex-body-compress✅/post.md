Taking the ledger half first with a patch; whether a non-Codex upstream's body can be compressed at all is a design call I'd rather not make unilaterally — the two options are laid out below.

## What changed

A request's ledger row now says what its tries sent up to the vendor, which no row said before:

- `up_bytes` — the bytes that actually went on the wire, tries summed: the plain body where it goes as read, less where it went zstd-compressed (a ChatGPT account's turn).
- `plain_bytes` — the request's last try as it went into that ask, before compression: beside `up_bytes`, a compressed turn's discount and a retried request's re-sends both read off the row.

The sums are added where the bytes are already counted (`sent` in `forwardOnce`, and in the Codex backend's turn loop), two int writes into the request's context — no second pass over any body, and the hot path pays one small allocation per request. A try that went out over a connection which then failed still counts, as a connection's own counter would; a single ask's second request (`RetryOneAuth` …) isn't added. Handed-on rows — the failed tries — carry neither field, so the rows of one request sum to what went up once. Rows written before this keep neither. The Usage page's rows (`usageapi`'s `Row`) carry the fields as they are; a column of its own on the page is the GUI's next step, and this patch doesn't touch the GUI.

For the observed session this would have answered the second question from inside magpie: `plain_bytes` against `up_bytes` and `tries` per row, where until now only a proxy's per-connection counts could guess. (The reporter's 900 MB/45 min, 124 requests are their external numbers and not reproducible on this side; they are the motivation, not the evidence.)

## Why the compression half is left as it is (two options)

Codex-only compression is deliberate, not an oversight. `provider.CodexCompressed` sends zstd because Codex's own client does (codex-rs `responses_request_compression`, on by default), and ChatGPT's backend answered a 1.1 MB plain turn 503 that it answers 200 compressed (ylorn on X, quoted in `codex_zstd.go`). For every other vendor this tree holds neither a known-accepted nor a known-rejected conclusion, and:

- HTTP negotiates reply encodings (`Accept-Encoding`), not request encodings. A `Content-Encoding` on a request body is a declaration the server is free to refuse (415) — or to misread as its JSON. The only vendor known here to take a compressed request body is ChatGPT's Codex backend, which takes zstd because Codex's own client sends it.
- The gateway relays a turn as the agent's client sent it — which is also what OpenCode's Zen free tier asks for ("as OpenCode itself sends it"). Go's `http.Client` never compresses a request body, so plain JSON is what these vendors see from normal traffic.
- The reporter's own numbers bound the win: of the ~24 MB session payload, 22.5 MB were 43 base64 screenshots — already-compressed data, which gzip can't shrink — and ~2 MB were text. The benefit is long tool outputs and file contents, not an order of magnitude.

So:

- **Option A — keep sending plain.** No vendor evidence, no change. Guessing wrong fails every request to that vendor (a 400/415, or a body read as garbage), which is expensive to discover in production.
- **Option B — an opt-in per-provider switch (default off), gzip, one plain re-send when the vendor refuses.** For upstreams the user has verified themselves. The cost is a setting, a retry path and per-request compression CPU (ms for MB-sized bodies) — set against the reporter's ~900 MB/45 min when the payload is text-heavy.

This lane shouldn't pick; if B is wanted, the two fields above would show each row's discount from day one.

## Verification

| Check | Result |
| --- | --- |
| `go test ./internal/gateway/ -run TestLedgerKeepsUpBytes` before the fix | FAIL — `UpBytes 0, the tries' bodies [57 57]` |
| the same after | ok |
| ablation: gateway.go back at 5daba8337, test kept | FAIL again; restored, ok |
| `go test -race ./internal/gateway/ -run 'TestLedgerKeepsUpBytes\|TestGroupFailsOver\|TestRefusalFailsOver'` | ok |
| `gofmt -l` on the 5 touched files | clean |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | pass (a cgo warning in internal/gui predates this) |
| builds of the touched packages, darwin/linux/windows | pass |
| `go test -tags nogui ./...` | 82 ok, 5 FAIL, all pre-existing and re-run red at the parent commit 5daba8337: `TestCodexPoolSaysTheClientsVersion` (the known gateway flake), `TestMothX` (agent), `TestEveryRouteHasACommandOrIsNamed` (cli — its own guard flags upstream's new `/api/usage/checkin-account` route), `TestProxyCheckSaysAProxyPassedBy` (gui — needs an outside proxy), `TestHostToldTheGatewayAddress` (plugin — port-move timing) |

**Not run**: end-to-end bytes against a real vendor (the reporter says their external numbers can't be reproduced on this side either; the evidence here is source-level and test-level), and the Usage page's table columns (GUI), which this patch doesn't touch.

<details><summary>patch: usage: the ledger row says what a request's tries sent up to the vendor (#4456) — git am applies it as is; SHA-256 first 16: 4c2de9dcaf7ce9b4</summary>

```patch
From b43be9e41955f66165ab61cd0b23ae4789e38cd7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 20:38:35 +0800
Subject: [PATCH] usage: the ledger row says what a request's tries sent up to
 the vendor (#4456)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A request's row said what it cost in tokens but not what it sent: the
bytes each try put on the wire to the vendor were known only where they
went (sent in forwardOnce, to codexDropped) and never written, so the
upstream traffic of a long session and what a hand-on re-sent could only
be guessed at from outside the machine, from a proxy's per-connection
counts (the reporter's: 45 minutes, ~900 MB up, 124 requests to
opencode.ai).

forwardOnce and codexBackend now add each try's bytes where they already
have them — the wire bytes sent (len(body), or what CodexCompressed left
on req), and the body before compression — into the request's context,
which the row's assembly reads: UpBytes, tries summed, and PlainBytes,
the last try's body as it went into its ask, so a compressed turn's
discount and a retried request's re-sends both read off the row beside
Tries. A try that went out over a connection which then failed still
counts, as a connection's own counter would; a single ask's second
request (RetryOneAuth …) isn't added, and a row of a request refused
before anything went out carries neither.

The sums live in the request's context (as a tool call's mcpUse does),
written on the request's own goroutine: no lock, and no pass over the
body — two int writes where the bytes were counted anyway. Handed-on
rows, the failed tries they are, carry neither field: the request's own
row has the total, so the rows of one request sum to what went up once.
Rows written before this was keep neither.

Whether a non-Codex upstream's body can be compressed at all — vendors
aren't asked about encodings the way a reply is negotiated, and magpie
relays a turn as its client sent it — is left as it is; this makes what
does go out visible.

Fixes #4456

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_backend.go |  5 ++
 internal/gateway/gateway.go       | 10 ++++
 internal/gateway/upbytes.go       | 31 ++++++++++++
 internal/gateway/upbytes_test.go  | 84 +++++++++++++++++++++++++++++++
 internal/usage/usage.go           | 13 +++++
 5 files changed, 143 insertions(+)
 create mode 100644 internal/gateway/upbytes.go
 create mode 100644 internal/gateway/upbytes_test.go

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 42768883c..53283b6c5 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -1213,6 +1213,8 @@ func (s *Server) codexUpstreamOn(w http.ResponseWriter, r *http.Request, rest st
 			// a turn to ChatGPT goes zstd-compressed again, as Codex sent it
 			// before magpie read it (ylorn on X); an API key's goes plain
 			sent = provider.CodexCompressed(req, body)
+			// counted for the request's ledger row, as forwardOnce's are (#4456)
+			sentUp(r.Context(), sent, len(body))
 			if res, err = s.client.Do(req); err != nil {
 				msg := "OpenAI: " + err.Error()
 				if overload && busyAgain < lastRetries && droppedUnanswered(r.Context(), err) {
@@ -1541,6 +1543,9 @@ func (s *Server) codexUpstreamOn(w http.ResponseWriter, r *http.Request, rest st
 		TierAsked: bodyTier(provider.Responses, body), TierSent: bodyTier(provider.Responses, body), TierServed: uu.Tier, TTFT: call.TTFT, FirstText: call.FirstText, ReasoningHidden: call.ReasoningHidden, Flow: call.Flow, Status: call.Status, Session: sessionOf(r.Header), NativeSession: nativeSessionOf(r.Header), Kind: call.Kind,
 		RequestID: requestID(res.Header), ResponseID: uu.ResponseID, Endpoint: r.URL.Path}
 	failedWith(&rec, call.Status, call.Error, errType)
+	if up := upBytesOf(r.Context()); up != nil {
+		rec.UpBytes, rec.PlainBytes = up.wire, up.plain
+	}
 	appendUsage(r, rec)
 }
 
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 9d59860a6..d503d76ef 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -2042,6 +2042,10 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 	}
 	defer discardArchive(capture)
 	r, watched := observeRequest(r, call.Kind, body)
+	// what the request's tries send up to the vendor is summed in its
+	// context, where forwardOnce and codexBackend add each try's bytes,
+	// for the ledger row to read (#4456)
+	r = r.WithContext(context.WithValue(r.Context(), upBytesKey{}, &upBytes{}))
 	defer func() { watched.end(call, time.Since(start).Milliseconds()) }()
 	switch call.Kind {
 	case "web_search":
@@ -4614,6 +4618,9 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 			// counts it once, as the request it is (小一 on Discord)
 			rec.Tries = tries
 		}
+		if up := upBytesOf(r.Context()); up != nil {
+			rec.UpBytes, rec.PlainBytes = up.wire, up.plain
+		}
 		failedWith(&rec, call.Status, call.Error, call.Usage.ErrType)
 		withBodies(&rec, &call)
 		appendUsage(r, rec)
@@ -5254,6 +5261,9 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 		// sent plain, ChatGPT answered a 1.1 MB one 503 (ylorn on X)
 		sent = provider.CodexCompressed(req, body)
 	}
+	// the bytes go on the wire whether the vendor answers or not, counted
+	// for the request's ledger row (#4456)
+	sentUp(ctx, sent, len(body))
 	res, err := p.Do(s.client, req)
 	if err == nil && res.StatusCode >= 400 && provider.OpenCodeURL(req.URL.String()) {
 		logOpenCodeRefusal(p, req, res.StatusCode)
diff --git a/internal/gateway/upbytes.go b/internal/gateway/upbytes.go
new file mode 100644
index 000000000..8d1e3592c
--- /dev/null
+++ b/internal/gateway/upbytes.go
@@ -0,0 +1,31 @@
+package gateway
+
+import "context"
+
+// upBytes is what a request's tries sent up to the vendor, kept in the
+// request's context as a tool call's mcpUse is: forwardOnce adds a try's
+// bytes where it already has them (sent), and the request's ledger row
+// reads the sum, so the row says what a session's upstream traffic was
+// and a hand-on's re-send stands beside Tries (#4456).
+type upBytes struct {
+	wire  int // the bytes that went on the wire, tries summed
+	plain int // the last try's body before compression
+}
+
+type upBytesKey struct{}
+
+func upBytesOf(ctx context.Context) *upBytes {
+	u, _ := ctx.Value(upBytesKey{}).(*upBytes)
+	return u
+}
+
+// sentUp is that a try went to the vendor: wire the bytes it sent
+// (len(body), or what CodexCompressed left on req), plain the body before
+// that. Read and written on the request's own goroutine — the ledger row
+// is assembled after the last try came back — so no lock.
+func sentUp(ctx context.Context, wire, plain int) {
+	if u := upBytesOf(ctx); u != nil {
+		u.wire += wire
+		u.plain = plain
+	}
+}
diff --git a/internal/gateway/upbytes_test.go b/internal/gateway/upbytes_test.go
new file mode 100644
index 000000000..aacde0873
--- /dev/null
+++ b/internal/gateway/upbytes_test.go
@@ -0,0 +1,84 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+	"github.com/yetone/magpie/internal/usage"
+)
+
+// A request asked twice — its first member overloaded, the next answering
+// — goes to its ledger row with what its tries sent up to the vendor:
+// UpBytes the bytes that went on the wire, tries summed, PlainBytes the
+// last try's body before compression. Neither was in a row before (#4456),
+// so a session's upstream traffic and what a hand-on re-sent could only be
+// guessed at from outside.
+func TestLedgerKeepsUpBytes(t *testing.T) {
+	fresh(t)
+	var sizes []int
+	overloaded := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		sizes = append(sizes, len(b))
+		w.Header().Set("Content-Type", "application/json")
+		w.WriteHeader(http.StatusInternalServerError)
+		io.WriteString(w, `{"error":{"message":"overloaded"}}`)
+	}))
+	t.Cleanup(overloaded.Close)
+	if err := provider.Save(provider.Provider{ID: "a", Name: "A", Key: "k", Models: []string{"m"}, Chat: overloaded.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		sizes = append(sizes, len(b))
+		w.Header().Set("Content-Type", "application/json")
+		io.WriteString(w, chatOK)
+	}))
+	t.Cleanup(ok.Close)
+	if err := provider.Save(provider.Provider{ID: "b", Name: "B", Key: "k", Models: []string{"m"}, Chat: ok.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SaveGroup(provider.Group{Name: "G", Members: []string{"a/m", "b/m"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	code, body := postAs(t, s, "", `{"model":"group/g","messages":[{"role":"user","content":"hi"}]}`)
+	if code != 200 || !strings.Contains(body, "hello") {
+		t.Fatalf("%d %s", code, body)
+	}
+	if len(sizes) != 2 {
+		t.Fatalf("the vendor saw %d asks (sizes %v)", len(sizes), sizes)
+	}
+	route := lastRoute(s).ID
+	var rows []usage.Record
+	deadline := time.Now().Add(10 * time.Second)
+	for {
+		rows = rows[:0]
+		for _, u := range usage.Load(time.Time{}) {
+			if u.RouteID == route && !u.HandedOn {
+				rows = append(rows, u)
+			}
+		}
+		if len(rows) >= 1 || time.Now().After(deadline) {
+			break
+		}
+		time.Sleep(20 * time.Millisecond)
+	}
+	if len(rows) != 1 {
+		t.Fatalf("the request's row: %d rows", len(rows))
+	}
+	row := rows[0]
+	if row.Tries != 2 || row.Status != 200 {
+		t.Fatalf("the request's row: tries %d, status %d", row.Tries, row.Status)
+	}
+	if row.UpBytes != sizes[0]+sizes[1] {
+		t.Fatalf("UpBytes %d, the tries' bodies %v", row.UpBytes, sizes)
+	}
+	if row.PlainBytes != sizes[1] {
+		t.Fatalf("PlainBytes %d, the last try's body %d", row.PlainBytes, sizes[1])
+	}
+}
diff --git a/internal/usage/usage.go b/internal/usage/usage.go
index 60ef606c3..2164b8b07 100644
--- a/internal/usage/usage.go
+++ b/internal/usage/usage.go
@@ -194,6 +194,19 @@ type Record struct {
 	// index tells HandedOn from such a record's route (handedOn).
 	Tries    int  `json:"tries,omitempty"`
 	HandedOn bool `json:"handed_on,omitempty"`
+	// UpBytes is how many bytes of this call's request actually went up to
+	// the vendor on the wire, its tries summed: the plain body where it
+	// goes as read, less where it went compressed (zstd to a ChatGPT
+	// backend, provider.CodexCompressed). A try gone over a connection
+	// that then failed still counts, as a connection's own counter would;
+	// what a single ask's second request re-sends (RetryOneAuth …) isn't
+	// added. A record from before it was kept has none (#4456).
+	UpBytes int `json:"up_bytes,omitempty"`
+	// PlainBytes is the request's last try as it went into that ask,
+	// before compression, what UpBytes would have been without one: beside
+	// it, a compressed turn's discount and a retried request's re-sends
+	// both read off the row. None when no try went out.
+	PlainBytes int `json:"plain_bytes,omitempty"`
 	// Kind is what the agent made the call for when it isn't a turn of
 	// the conversation: a Codex subagent's (review, compact, guardian…)
 	Kind string `json:"kind,omitempty"`
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4456-noncodex-body-compress](https://github.com/ggbdpq/magpie/tree/fix/4456-noncodex-body-compress) (head `b43be9e41955f66165ab61cd0b23ae4789e38cd7`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
