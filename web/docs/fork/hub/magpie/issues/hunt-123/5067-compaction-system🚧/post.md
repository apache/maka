A compaction a relay refuses as system asks again with the roles as the client sent them (#5067) — patch attached.

**What's wrong**: on a plugin provider whose `/v1/responses` is a relay of a ChatGPT account (magpie-sub2api → sub2api → Codex backend), every auto-compaction past the token limit fails with 400 `System messages are not allowed`, three failures in a row put the conversation on cooldown, and the sessions that did get through were silently downgraded to the plain-text summary. Normal turns on the same provider are fine. jian-cui's write-ups above pin the whole mechanism from app.log and sub2api's error log — this patch follows their first suggested fix ("retry once with the original roles").

**Root cause**: exactly as reported. `codexCompact` marks its summary ask (`askCompaction`), and `forVendor` — the Responses translation for any provider that isn't `Agent == "codex"` and isn't `*.openai.com` — swaps the ask's developer messages to system (`developerItemsAsSystem`, the #2955 fix). A plugin provider matches neither exemption, so the ask reaches the ChatGPT backend behind the relay as `system`, which that backend refuses. The swap's own comment says "the ChatGPT backend, which takes developer alone, never comes here" — plugin providers broke that assumption. The turns around the ask keep the developer role and are taken all along, which is why only compaction fails. And when the refusal comes through worded `{"detail":"System messages are not allowed"}`, none of the plain-text fallback triggers match (`upstreamFailed` looks for "upstream request failed", the relay's own wording), so the attempt counts a strike in `compactFails` — that's the 3-strikes hold; sessions whose relay says "Upstream request failed" still fall through to the text summary, which is why some survived.

**The fix**: when the summary ask comes back 400 "System messages are not allowed", it is asked again with the roles as the client sent them — `askAsSent` turns the compaction marker off, which skips the swap alone (the marker's only consumer is the `forVendor` call), leaving every other vendor transform in place. The backend takes it the way it takes the turns, so the summary keeps full fidelity instead of falling to the text downgrade. If that retry is refused too, the ask joins the existing plain-text fallback (a native `system` item beside the developer ones is the one shape that could refuse both), then the local summary, as before. #2955's vendors — which take system and refuse developer — never say this phrase, so their asks are unchanged, and `TestCodexCompactDeveloperAsSystemOnAVendorRelay` still passes. Sibling faces checked: `developerItemsAsSystem` has this one caller; `developerAsSystem` (Chat Completions face) is left alone — system is that protocol's own role, and a Chat endpoint is never the Codex backend; `codexBody` (direct Codex accounts) already normalizes system→developer; `plainCompact`/`localSummary` carry no roles.

<details><summary>patch: gateway: a compaction refused as system asks again with the roles as sent (#5067) — git am applies it as is; SHA-256 first 16: 5bc761b0e28c027d</summary>

```patch
From b39eb4f0cd13298417d5ae593f8e32022cdb9278 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 23:51:45 +0800
Subject: [PATCH] gateway: a compaction refused as system asks again with the
 roles as sent (#5067)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A plugin provider fronting a ChatGPT account is a vendor to magpie
(forVendor), so the summary ask goes to it with its developer messages
as the system ones they are (#2955) — but the ChatGPT backend behind
the relay takes developer alone, and refused every compaction with
400 "System messages are not allowed": three of the failures held the
conversation (compactFails), and the sessions that did get through
fell back to the plain-text summary. The swap was built for vendors
that reject developer; a backend that rejects system is the opposite
case, and the turns around the summary ask, developer as they came,
were taken all along.

Now a summary ask answered 400 "System messages are not allowed" is
asked again with the roles as the client sent them (askAsSent turns
the compaction marker off, the swap alone), and only when that is
refused too does the ask go on as text, as for the other refusal
shapes. Codex's own turns are untouched, and the #2955 vendors — which
take system and refuse developer — never say this, so their asks are
unchanged.

Test: TestCodexCompactSystemRefusedAsksAgainDeveloper (red before the
fix: the first ask went out as system and came back 400 to Codex).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_backend.go             | 37 ++++++++++--
 internal/gateway/codex_compact_guard.go       |  9 +++
 internal/gateway/codex_compact_system_test.go | 58 +++++++++++++++++++
 3 files changed, 99 insertions(+), 5 deletions(-)
 create mode 100644 internal/gateway/codex_compact_system_test.go

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 84236eb94..0c045cef5 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -3494,7 +3494,7 @@ func (s *Server) codexCompact(w http.ResponseWriter, r *http.Request, body []byt
 	}
 	r = askWhole(r)
 	r = askCompaction(r)
-	ask := func(b []byte) (*recorder, compactResult, error) {
+	ask := func(r *http.Request, b []byte) (*recorder, compactResult, error) {
 		rec := &recorder{header: http.Header{}, status: 200}
 		s.serve(rec, r, provider.Responses, b)
 		if rec.status >= 400 {
@@ -3508,16 +3508,30 @@ func (s *Server) codexCompact(w http.ResponseWriter, r *http.Request, body []byt
 		}
 		return rec, res, err
 	}
-	rec, res, err := ask(body)
+	rec, res, err := ask(r, body)
+	// A relay of the ChatGPT backend takes developer alone: the summary
+	// ask went to it with the developer messages as system ones
+	// (forVendor, #2955), and it refused every one, 400 "System messages
+	// are not allowed", three of the failures holding the conversation
+	// (compactFails, #5067) — while the turns around it, developer as
+	// they came, are taken. Asked again with the roles as the client
+	// sent them, the swap off, the summary is taken the way the turns
+	// are; when that is refused too, the ask goes on as text, as for the
+	// shapes below.
+	if first := rec.status; systemRefused(rec) {
+		who, msg := compactFailure(body, rec)
+		log.Printf("codex compaction: %s answered %d (%s); asking again with the roles as the client sent them", who, first, msg)
+		rec, res, err = ask(askAsSent(r), body)
+	}
 	local := ""
-	if first := rec.status; lacksEndpoint(first) || itemNotFound(rec) || upstreamFailed(rec) || protectionRefused(first, rec.body.Bytes()) ||
+	if first := rec.status; lacksEndpoint(first) || itemNotFound(rec) || upstreamFailed(rec) || systemRefused(rec) || protectionRefused(first, rec.body.Bytes()) ||
 		summaryTooLarge(rec) || err != nil && protectionWords.MatchString(err.Error()) {
 		who, msg := compactFailure(body, rec)
 		if err != nil {
 			msg = "broken off: " + err.Error()
 		}
 		log.Printf("codex compaction: %s answered %d (%s); asking again with the conversation as text", who, first, msg)
-		rec, res, err = ask(plainCompact(body))
+		rec, res, err = ask(r, plainCompact(body))
 		if rec.status >= 400 || err != nil {
 			again := ""
 			if err != nil {
@@ -3615,7 +3629,7 @@ func (s *Server) codexCompact(w http.ResponseWriter, r *http.Request, body []byt
 		who, _ := compactFailure(body, rec)
 		called := answeredWith(res.Output)
 		log.Printf("codex compaction: %s wrote no summary%s; asking again with the conversation as text", who, called)
-		prec, pres, perr := ask(plainCompact(body))
+		prec, pres, perr := ask(r, plainCompact(body))
 		switch {
 		case perr == nil && prec.status < 400 && pres.Status != "incomplete" && strings.TrimSpace(pres.summary()) != "":
 			rec, res = prec, pres
@@ -3714,6 +3728,19 @@ func upstreamFailed(rec *recorder) bool {
 
 var upstreamFailedWords = regexp.MustCompile(`(?i)upstream request failed`)
 
+// systemRefused is a summary ask turned away for the role the swap gave
+// it: a relay of the ChatGPT backend takes developer alone, and the
+// summary went to it with the developer messages as system ones
+// (forVendor, #2955), refused 400 "System messages are not allowed"
+// (#5067) — the turns around it, developer as they came, are taken. The
+// summary is asked again the way the turns go (askAsSent), and as text
+// when that is refused too.
+func systemRefused(rec *recorder) bool {
+	return rec.status == http.StatusBadRequest && systemRefusedWords.Match(rec.body.Bytes())
+}
+
+var systemRefusedWords = regexp.MustCompile(`(?i)system messages are not allowed`)
+
 // summaryTooLarge is a summary request refused for its size: past the
 // vendor's byte cap (413; DeepSeek's "Failed to buffer the request body:
 // length limit exceeded", celestial_eagle_99230 on Discord) or past the
diff --git a/internal/gateway/codex_compact_guard.go b/internal/gateway/codex_compact_guard.go
index fede06241..04763f6d1 100644
--- a/internal/gateway/codex_compact_guard.go
+++ b/internal/gateway/codex_compact_guard.go
@@ -140,6 +140,15 @@ func askCompaction(r *http.Request) *http.Request {
 	return r.WithContext(context.WithValue(r.Context(), compactionAskKey{}, true))
 }
 
+// askAsSent is a summary ask taken back to the roles the client sent,
+// after the swap was refused: the ChatGPT backend behind a relay takes
+// developer alone, and the summary went to it as system (forVendor,
+// #5067). Its turns, developer as they came, are taken, and the summary
+// goes the same way.
+func askAsSent(r *http.Request) *http.Request {
+	return r.WithContext(context.WithValue(r.Context(), compactionAskKey{}, false))
+}
+
 func askWhole(r *http.Request) *http.Request {
 	return r.WithContext(context.WithValue(r.Context(), wholeReplyKey{}, true))
 }
diff --git a/internal/gateway/codex_compact_system_test.go b/internal/gateway/codex_compact_system_test.go
new file mode 100644
index 000000000..6e2909d36
--- /dev/null
+++ b/internal/gateway/codex_compact_system_test.go
@@ -0,0 +1,58 @@
+package gateway
+
+import (
+	"net/http"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// chatgptSystem400 is what the ChatGPT backend answers a request carrying
+// the system role with, passed through the relay above it unchanged
+// (jian-cui's sub2api, #5067).
+const chatgptSystem400 = `{"detail":"System messages are not allowed"}`
+
+// #5067: Codex on a plugin provider whose Responses endpoint is a relay
+// of a ChatGPT account: the summary ask went out with its developer
+// messages as system ones (forVendor, #2955) and the backend behind the
+// relay refused every one, 400 "System messages are not allowed", three
+// of the failures holding the conversation (compactFails) — while the
+// turns around it, developer as they came, are taken. The summary is
+// asked again with the roles as the client sent them, and the backend
+// takes it the way it takes the turns.
+func TestCodexCompactSystemRefusedAsksAgainDeveloper(t *testing.T) {
+	f := &fake{t: t, reply: sse(
+		`data: {"type":"response.created","response":{"id":"resp_v1","status":"in_progress","output":[]}}`,
+		`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"SUMMARY"}]}}`,
+		`data: {"type":"response.completed","response":{"id":"resp_v1","status":"completed","output":[]}}`)}
+	f.refuse = func(body []byte) (int, string) {
+		if strings.Contains(string(body), `"role":"system"`) {
+			return http.StatusBadRequest, chatgptSystem400
+		}
+		return 0, ""
+	}
+	setup(t, provider.Responses, f)
+	code, body := codexPost(t, `{"model":"fake/m1","stream":true,"store":false,
+	  "input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are Codex, a coding agent."}]},
+	  {"type":"message","role":"user","content":[{"type":"input_text","text":"fix the login bug"}]},
+	  {"type":"message","role":"assistant","content":[{"type":"output_text","text":"I fixed main.go"}]},
+	  {"type":"compaction_trigger"}]}`)
+	if code != 200 || !strings.Contains(body, `"compaction"`) {
+		t.Fatalf("%d %s\nupstream got %s", code, body, f.got)
+	}
+	if got := compactedText(t, body); got != "SUMMARY" {
+		t.Errorf("summary %q", got)
+	}
+	if f.calls != 2 {
+		t.Errorf("asks: %d", f.calls)
+	}
+	// the second ask went with the roles as the client sent them:
+	// developer, never system
+	if strings.Contains(string(f.got), `"role":"system"`) {
+		t.Errorf("system went over the wire again: %s", f.got)
+	}
+	if !strings.Contains(string(f.got), `"role":"developer"`) {
+		t.Errorf("the retry lost the developer message: %s", f.got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

**Verification** (base `1e1068c86`, head `b39eb4f0cd13298417d5ae593f8e32022cdb9278`):

| Check | Result |
| --- | --- |
| Red without the fix (`TestCodexCompactSystemRefusedAsksAgainDeveloper`: fake relay refuses any body carrying `role:"system"` with the reporter's 400 verbatim) | `--- FAIL`: the first ask went out as system, Codex answered 400 |
| Green with the fix | `ok` |
| Ablation (product files reverted to the parent, test kept) | red on parent; restored → `ok` (`-count=1`) |
| Compaction family targeted, incl. #2955's `TestCodexCompactDeveloperAsSystemOnAVendorRelay` and the plain-text/guard ladders | `ok` |
| Race, same family (`-race`) | `ok` 15.09s |
| Full gateway suite, `go test ./internal/gateway/ -tags nogui -timeout 25m` | `ok` 643.349s, 0 failed |
| `gofmt -l` (changed files), `go vet -tags nogui ./internal/gateway/`, `go build ./...` (plain and nogui), root package tests | clean / clean / ok / `ok` 0.369s |

**Not verified**: a real sub2api → ChatGPT-account endpoint — the fake answers the reporter's captured 400 body verbatim and refuses any body carrying the system role, and the retry is asserted to arrive with the developer role kept. The other 400 in the report (`reasoning 'none' is not supported`, 14 of the last 40) is a separate path I didn't change: serve already retries an effort refusal once at the model's lowest level when the error names the supported levels, so most of those log entries are likely first attempts magpie retried past — I can't confirm each one was. The exact shape that skipped the plain-text fallback in the failing session (an error inside a 200 stream, per the reporter's guess) wasn't reproduced separately; with the role refusal itself fixed, that path is no longer reached.

---
**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/5067-compaction-system-messages](https://github.com/ggbdpq/magpie/tree/fix/5067-compaction-system-messages) (head `b39eb4f0cd13298417d5ae593f8e32022cdb9278`).
