Rebased onto the current main (`4164edce6`): this is the patch from [my comment of 10-19](https://github.com/yetone/magpie/issues/2965#issuecomment-6278495823), unchanged in substance — `AllBuiltAt` beside `AllBuilt`, and the test judges a rebuild by when its build was asked for, not by when the request began. Only the `"time"` import line is gone, the tree carries it already. What changes the 10-22 picture: this rebase no longer waits on 6a050eeb's kept catalog to soak, because the old test now fails on its own, idle, without any load at all.

Since 6a050eeb keeps the catalog for the next requests, a second request that starts past the old 900ms window builds nothing at all — and the old test's start-based guess then wants 1 where nothing was built. With a plain 1.2s pause put between the two requests (a test-only experiment, not part of the commit), the old form fails on this idle machine with the mirror image of the issue's line:

```
--- FAIL: TestRequestBuildsProvidersOnce (1.41s)
    request_builds_once_test.go:43: request 2 built the providers 0 times, want 1
```

So the 900ms guess now lies in both directions, and the patch removes it entirely; a rebuild is let past only when it is exactly one AND its ask landed a second or more after the first build's ask — the hold rightly letting go — while a rebuild asked within the second, or two builds in one request (the #2502 class), stays red.

Red first and ablation, same pause each time:

| Form | Result |
| --- | --- |
| old test + pause | FAIL: `request 2 built the providers 0 times, want 1` |
| patched test + same pause, `-count=3` | ok |
| old test form with the `AllBuiltAt` hook kept + pause | FAIL again — the test rewrite is what guards; the counter alone doesn't |

Your data is what names the loaded shape, credited as it stands: the issue's own run at load ~280–400 (the exact line cut by your output filter) and the follow-up `request 2 built the providers 1 times, want 0` on c8c0985df (loaded by a parallel GUI run) are the direction this patch closes — a build asked after the hold let go, judged against a want set from the request's start. The `request 1 built 2 times` red on dee5c9d75 is not the guess (it only touches request 2) and stays red under this patch by design, as said on 10-22; on the kept-catalog tree its window looks narrowed, worth watching for the signature past 10-21.

| Check | Command | Result |
| --- | --- | --- |
| Fixed test | `go test -tags nogui -count=5 -run 'TestRequestBuildsProvidersOnce$' ./internal/gateway/` | ok |
| Race | same with `-race -count=4` | ok |
| Full gateway | `go test -tags nogui -count=1 ./internal/gateway/` | ok (634.7s) |
| Provider package (product file touched) | `go test -tags nogui -count=1 ./internal/provider/` | ok (127.8s) |
| Format | `gofmt -l internal/gateway/ internal/provider/` | clean |
| Vet | `go vet -tags nogui ./internal/gateway/ ./internal/provider/` for darwin, linux, windows | ok |
| Builds | `CGO_ENABLED=0 go build -tags nogui ./...` for darwin, linux, windows | ok |
| am gate | `git am -3` onto a clean tree at `4164edce6` | applies as is, tree identical |

Run on macOS arm64, go1.26.8, idle (load ~4–7).

Not verified: your loaded machine (load ~280–400) is not reproduced here — the local red is the pause construction above, which is deterministic and needs no load; CI's machines and Windows at runtime are untried.

Branch: [`fix/2965-providers-once-load`](https://github.com/ggbdpq/magpie/tree/fix/2965-providers-once-load), one commit on top of upstream `4164edce6`, head `76f8fd7fb64f952f49fd6f4454582a88ea1f0568`; the patch below applies with `git am`.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.
**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch — 0001-gateway-TestRequestBuildsProvidersOnce-judges-the-build-s-ask.patch (sha256 988d7e590aa567aa)</summary>

```patch
From 76f8fd7fb64f952f49fd6f4454582a88ea1f0568 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 06:56:01 +0800
Subject: [PATCH] gateway: TestRequestBuildsProvidersOnce judges the build's
 ask, not the request's start (#2965)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Cause: the test judged the second request by when it began, letting it
want 0 rebuilds only within 900ms of the first, while what decides a
rebuild is the hold and the stamp, not the clock from a request's
start. Two ways that guess goes red: on a loaded machine a request can
begin within the second and reach the build after the hold has let what
was built go — "request 2 built the providers 1 times, want 0", seen in
full runs at load ~280–400; and since 6a050eeb keeps the catalog for
the next requests, a request that begins past the 900ms builds none at
all — "request 2 built the providers 0 times, want 1", which an idle
machine now reproduces with a plain 1.2s pause between the requests.

Fix: allProviders notes when the build it counts was asked for
(AllBuiltAt, beside AllBuilt), and the test judges a rebuild by that,
not by the request's start: a rebuild asked a second or more after the
first build's ask is the hold letting go, rightly, and is allowed only
when it is exactly one; a rebuild asked within the second, or more than
one build in a request (the #2502 bug class), stays red. Nothing rests
on how fast the machine gets from a request's start to its build.

Red first (macOS arm64, idle, this tree): with a 1.2s pause put before
the second request, the old test failed "request 2 built the providers
0 times, want 1"; the new test passed the same pause (-count=3); the
old form failed it again with the hook in place (ablation: the test is
what guards). The loaded-machine shape is the issue's own run at load
~280–400 and the maintainer's "request 2 built the providers 1 times,
want 0" at c8c0985df; the "request 1 built 2 times" red at dee5c9d75 is
not the guess — two builds inside one request stays red here by design,
per #2502.

Run (macOS arm64, go1.26.8, load ~4–7):
- go test -tags nogui -count=5 -run 'TestRequestBuildsProvidersOnce$'
  ./internal/gateway/: ok.
- go test -tags nogui -race -count=4 -run
  'TestRequestBuildsProvidersOnce$' ./internal/gateway/: ok.
- go test -tags nogui -count=1 ./internal/gateway/: ok (634.7s).
- go test -tags nogui -count=1 ./internal/provider/: ok (127.8s).
- gofmt -l internal/gateway/ internal/provider/: clean.
- go vet -tags nogui ./internal/gateway/ ./internal/provider/ for
  darwin, linux, windows: ok.
- CGO_ENABLED=0 go build -tags nogui ./..., darwin/linux/windows: ok.

Fixes #2965

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/request_builds_once_test.go | 31 ++++++++++++--------
 internal/provider/provider.go                |  6 ++++
 2 files changed, 25 insertions(+), 12 deletions(-)

diff --git a/internal/gateway/request_builds_once_test.go b/internal/gateway/request_builds_once_test.go
index 63ed12f7e..caab9c636 100644
--- a/internal/gateway/request_builds_once_test.go
+++ b/internal/gateway/request_builds_once_test.go
@@ -14,29 +14,36 @@ import (
 // 100–350% CPU under seven agents at once (#2502). The next request,
 // within a second and nothing written, builds none: one request after
 // another built the providers again each time. After a write it builds
-// once more.
+// once more. What a request within that second is judged by is when its
+// build was asked, not when the request began: on a loaded machine a
+// request can begin within the second what was built is held for and
+// reach the build after the hold has let it go, and that build is right
+// (#2965).
 func TestRequestBuildsProvidersOnce(t *testing.T) {
 	plugin.UseCached(nil)
 	setup(t, provider.Chat, &fake{t: t, reply: sse(`{"choices":[{"delta":{"content":"hi"}}]}`, "[DONE]")})
-	var first time.Time
+	var asked time.Time // when the first build was asked for
 	for i, want := range []int64{1, 0, 1} {
 		if i == 2 {
 			provider.Changed() // a provider saved
 		}
-		n, start := provider.AllBuilt.Load(), time.Now()
-		if i == 1 && start.Sub(first) > 900*time.Millisecond {
-			// what was built is held for a second: a request this late
-			// (a loaded machine) builds again, rightly
-			want = 1
-		}
-		if i == 0 {
-			first = start
-		}
+		n := provider.AllBuilt.Load()
 		code, body := post(t, "/v1/chat/completions", `{"model":"fake/m1","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
 		if code != 200 {
 			t.Fatalf("%d %s", code, body)
 		}
-		if got := provider.AllBuilt.Load() - n; got != want {
+		got := provider.AllBuilt.Load() - n
+		at := time.Unix(0, provider.AllBuiltAt.Load())
+		if i == 0 {
+			asked = at
+		}
+		if i == 1 && got == 1 && at.Sub(asked) >= time.Second {
+			// the request began within the second the built providers are
+			// held for, but its build was asked after the hold: built
+			// again, rightly (a loaded machine)
+			want = 1
+		}
+		if got != want {
 			t.Fatalf("request %d built the providers %d times, want %d", i+1, got, want)
 		}
 	}
diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index b333f4fa9..7a5bb5d89 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -859,8 +859,14 @@ func (p Provider) clone() Provider {
 // AllBuilt counts the times All built the list anew, for tests.
 var AllBuilt atomic.Int64
 
+// AllBuiltAt is when the build All last counted was asked for (allProviders
+// entered, the hold's rule read at once after), for a test to judge a build
+// by when it was asked, not by when the request that asked began (#2965).
+var AllBuiltAt atomic.Int64
+
 func allProviders() []Provider {
 	AllBuilt.Add(1)
+	AllBuiltAt.Store(time.Now().UnixNano())
 	f := load()
 	out, picks := ownOf(f)
 	for _, a := range Accounts() {
-- 
2.50.1 (Apple Git-155)
```

</details>
