I took this (take above) and found the candidate standing — both posts are yours, the patch is installed on your side, and the review you asked for against the dead-path regressions is exactly what this lane owes. So this post is that review, all read and run on current main `416305451`: the cause confirmed in code, the candidate verified on a rebase it now needs, and what the two commits landed since your follow-up change (and don't). The lane steps aside; the candidate is the fix.

**Cause, independently confirmed** (`416305451`): `netproxy.go:54` keeps `PingAfter, PingWait = 10s, 10s`, `HTTP2Health()` (`netproxy.go:65`) hands those to every vendor transport, and Antigravity's is built as `netproxy.Dispatch(vendorTransport(...))` (`upstream_transport.go:39`, its `HTTP2: netproxy.HTTP2Health()` at :78). A quiet but live stream is read-idle, the transport PINGs it every ten seconds, and Google's Code Assist edge answers GOAWAY ENHANCE_YOUR_CALM `too_many_pings` — your 8/16/18.5-minute observations are consistent with that, and with nothing else in the tree: `lostPing` (`upstream_transport.go:145`) matches only Go's own `http2: client connection lost` (its health ping gone unanswered), so the peer's GOAWAY is caught neither by the upload retry-once nor by anything else. Your "the upload fallback is not a fix for this error" stands.

**The candidate needs a re-put before it applies**: it is against `94d4866b5`, your re-validation on v0.1.3162 (`8c97edc80` — an ancestor of current main, verified) — and `1fd0bb967`, landed after your follow-up, rewrote the exact line your RoundTrip hunk edits (it added `overHTTP1(req.Context())` to the h1 expression). Plain `git apply` fails there (`patch does not apply`, netproxy.go:197); `--3way` leaves one conflict, and the resolution is the union:

```diff
-	r := route{choice: choiceOf(req.Context()), h1: HTTP1 != nil && HTTP1(req.URL) || http1Asked(req) || overHTTP1(req.Context()) || h2BrokenFor(req), unchecked: uncheckedHost(req)}
+	r := route{choice: choiceOf(req.Context()), h1: HTTP1 != nil && HTTP1(req.URL) || http1Asked(req) || overHTTP1(req.Context()) || h2BrokenFor(req), unchecked: uncheckedHost(req), noPing: codeAssistHost(req.URL.Hostname())}
```

Your other three hunks apply untouched. With that one line resolved (committed locally as `68e6afdb9`, parent `416305451`):

- `go test -tags nogui -count=1 ./internal/netproxy/`: ok 4.9s — your two new tests and `1fd0bb967`'s four (`TestDownloadBrokenOverHTTP2TriesHTTP1`, `TestOverHTTP1EveryHost`, `TestAgainOverHTTP1`, `TestBrokeOff`) all green together: no collision with the landed sibling.
- Targeted, verbose: `TestCodeAssistDoesNotSendHealthPings` (both hosts × global/explicit-direct, case and trailing dot) PASS; `TestCodeAssistPingPolicyLeavesOtherHostsAlone` PASS.
- Ablation on the rebased tree, the two logic hunks alone taken out (the RoundTrip assignment and the transport clone; the whole file can't revert — your test needs `codeAssistHost` to compile): `TestCodeAssistDoesNotSendHealthPings` fails with `Google stream still gets health pings: &{... SendPingTimeout:1s ...}` and the host-matching test stays green — the change is the cause.
- `go vet -tags nogui ./internal/netproxy` on darwin and GOOS=linux clean; `go build ./...` ok; gateway targeted (`TestUpstream*`, `TestUpload*`, `TestH2*`) ok. Not run by this lane: the full gateway suite, `-race`, GOOS=windows — your Windows/vet/netproxy runs plus these leave the matrix broad but neither side has run it whole.

**What landed since your follow-up, and what it doesn't do here**: `1fd0bb967`'s `BrokeOff` now classifies a peer GOAWAY as a broke-off transfer, but `AgainOverHTTP1` is wired into the downloads (update, pii, Bun, Claude Code's binary, the Grok CLI) and has no caller in the gateway's vendor path (rg'd; only unrelated test names carry the word) — so the commit does not mitigate this issue's gateway face, and the candidate remains the only fix on the table.

**On the dead-path regressions you flagged (#2843/#4936)**: the pins for them live in netproxy's `deadpath_test.go`/`http2_health_test.go` and gateway's `upstream_h2_upload_test.go`; the netproxy package runs green with the candidate, the gateway package is untouched by it, and your own test asserts the shared base keeps `SendPingTimeout: 1s`. One face your posts don't name: uploads — `uploadTransport` also goes through the Dispatch (`upstream_transport.go:41`), so uploads to those two hosts lose the health probe under the candidate, same as the streams. It's the same tradeoff you accepted ("dead Code Assist paths rely on their existing caller/header/idle deadlines"), just on the upload socket too; the `lostPing` retry-once stays intact for every host that keeps its pings.

Scoping checks out: only `cloudcode-pa.googleapis.com` and `daily-cloudcode-pa.googleapis.com` (case-insensitive, trailing dot) are matched — `generativelanguage.googleapis.com`, Vertex's edge and every relay keep the 10-second policy, pinned by your negative test. If Google's other edges enforce `too_many_pings` the same way they'll surface as their own reports.

The one face both sides agree is open: a real long quiet production stream on the candidate — your 4.67-second OK proves connectivity, not the stream that GOAWAYs at minute eight.

---
**Source**: reported in #5518 by hj-smith, candidate and both validations theirs; every check above run locally on the rebase of their patch onto `416305451`, none against Google's production edge.

**Not verified**: a real authenticated long quiet Antigravity stream on the candidate; GOOS=windows and -race on the rebase; whether Google's other edges (Vertex, AI Studio) enforce `too_many_pings` the same way.

**AI**: written with GLM-5.3-Flash (ZCode); I rebased the candidate, ran the checks above and can answer questions on them.
