Took this (take above). The asks 1 and 3 are design calls — queueing is #3196's face, the v2 path is #4740's — but ask 2 is a gap in what magpie says, and this patch fills it: what magpie writes for an OpenCode refusal is the status and the names of the headers sent, so a 429 at a third of the quota and a spent allowance read exactly alike. The vendor says which it is — its own words, and for how long — and now magpie says that too.

**Before** (your line, 0.1.3148):

```
opencode: opencode-go answered 429 to POST opencode.ai/zen/go/v1/messages; x-opencode-session ses_e503…; headers sent: authorization, content-type, …
```

**After**:

```
opencode: opencode-go answered 429 to POST opencode.ai/zen/go/v1/messages; x-opencode-session ses_e503…; retry-after 5s; says "Too many requests. Please retry in a few seconds."; headers sent: …
```

The wait is said as how long from now, whether the vendor wrote `Retry-After` (seconds or an HTTP date) or a ratelimit reset header — the same reading the rest and the wait already go by, so what the log says and what the walk does can no longer disagree. The words are the refusal body's message (`vendorMessage`), or the body itself clipped when it names no message (a bare body, as #3740's), and the body is put back after reading, so `openCodeBareRefusal`, the retry helpers and whatever reads the reply next see it whole. Still one line a refusal, and every OpenCode refusal gets it — the missing-session 400 included, whose body now names its own reason.

The whole change (the tests beside it are the three named below):

```diff
--- a/internal/gateway/opencode_session.go
+++ b/internal/gateway/opencode_session.go
@@ -61,8 +66,25 @@ func logOpenCodeRefusal(p provider.Provider, req *http.Request, status int) {
-	log.Printf("opencode: %s answered %d to %s %s%s; x-opencode-session %s; headers sent: %s",
-		p.ID, status, req.Method, req.URL.Host, req.URL.Path, session, strings.Join(names, ", "))
+	said := fmt.Sprintf("opencode: %s answered %d to %s %s%s; x-opencode-session %s",
+		p.ID, res.StatusCode, req.Method, req.URL.Host, req.URL.Path, session)
+	if d := retryAfter(res.Header, time.Now()).Round(time.Second); d > 0 {
+		said += "; retry-after " + d.String()
+	}
+	if res.Body != nil {
+		b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
+		// what wasn't read is read after what was: a body is never cut
+		res.Body = readCloser{io.MultiReader(bytes.NewReader(b), res.Body), res.Body}
+		words := vendorMessage(b)
+		if words == "" {
+			words = strings.TrimSpace(string(b))
+		}
+		if words = clipRunes(words, 200); words != "" {
+			said += fmt.Sprintf("; says %q", words)
+		}
+	}
+	said += "; headers sent: " + strings.Join(names, ", ")
+	log.Print(said)
```

```diff
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5830,7 +5830,7 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
-		logOpenCodeRefusal(p, req, res.StatusCode)
+		logOpenCodeRefusal(p, req, res)
```

**What this does not do, on purpose**: the walk already treats a short 429 as a moment's trouble — your own turn went out again and answered on the fourth try, 29s in all, and Claude Code saw nothing. Where the 429s reached Claude Code (the Windows machine), something ended the waiting early — patience off, or the group's last member asked twice and told — and there are no logs from that machine to say which. The line above is exactly what that log would have needed to answer it: a short wait named, or a quota answer instead. Whether to wait longer, queue, or move to the v2 path stays with #3196/#4740 and you.

Sibling faces, read not changed: the routing log's try row already keeps the vendor's words in its error (`provider.APIError` at the walk), what it lacks is the wait — and that lives in the rest/wait fields, not the row's text; other providers have no dedicated refusal line (this one exists for the session 400's sake), so there is nothing beside to extend; `restAfter`'s reading of Retry-After is untouched — the log now says what it goes by.

**Run** (darwin/arm64, Go 1.25.5, on `30a0bfe88` + this):

- `TestOpenCodeRefusalSaysWhatTheVendorSaid`, `TestOpenCodeRefusalSaysABareBodyAndNoWait`, `TestOpenCodeRefusalSaysADatedWaitAsHowLong` — red on main (they do not compile against the old `status int` signature), green here; each way of breaking the change turns at least the first red.
- Ablation: both product files back to main → the three red again (the tests argue with the old signature); restored → green.
- `go test -tags nogui -timeout 25m -count=1 ./internal/gateway/`: ok 880.3s, nothing new red. Targeted `-race` on the three: ok. `gofmt -l`: clean. `go vet -tags nogui ./internal/gateway` on darwin and GOOS=linux: clean. `go build ./...`: ok.

---
**Source**: reported in #5509 by lingengyuan; every check above run locally on `30a0bfe88` + this commit, none against the live opencode.ai gateway — the refusal lines above are this patch's own output shape, the 429's words in the "after" are the test's fake.

**Not verified**: a real opencode.ai 429's body and headers at run time (whether Go names `Retry-After` or a reset header, and in which shape); the Windows machine's exposing walk; GOOS=windows.

**AI**: written with GLM-5.3-Flash (ZCode); I wrote the patch, ran the checks and can answer questions on it.

**Branch**: [`ggbdpq:fix/5509-opencode-429`](https://github.com/ggbdpq/magpie/compare/main...ggbdpq/magpie:fix/5509-opencode-429) — `ccfcd71f` on `30a0bfe88`.

**Patch**: `git format-patch -1 --zero-commit` of `ccfcd71f87b5b03740ecf5969e939615ddcc936d`; the patch as it am's hashes to `7adbabadfb82158a` (first 16 of the sha256).

*Attribution: the missing-session refusal line and its session/header reading are yetone's (`logOpenCodeRefusal`, d1f57b70e's face); the wait-and-words extension, the body's read-and-put-back, and the tests are this patch's.*

*Generated-by: GLM-5.3-Flash (ZCode)*

