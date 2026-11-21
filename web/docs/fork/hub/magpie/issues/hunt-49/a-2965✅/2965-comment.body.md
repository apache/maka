The diagnosis in the issue is exactly right, and this patch takes the first of the two directions it named: judge by when the build was asked, not by when the request started.

Honest reproduction note: I could not reproduce the red locally — on an idle machine (Apple silicon, load ~5) `-count=8 -run 'TestRequestBuildsProvidersOnce$'` is 8/8 green on upstream `79160455`, matching what the issue already saw alone at e433d3fb3 and f73378365. So the flaw is proved by construction instead: I put an artificial 1.2s lag between request 2's start and its build (a sleep in `holdCatalog` before the hold is taken — an experiment, not part of the commit). That is the issue's exact scenario: the request starts ~60ms after request 1, well inside the 900ms window, but reaches the build ~1.2s in, after the 1s hold has let the built providers go. The old test fails with the failure line the loaded run didn't capture:

```
--- FAIL: TestRequestBuildsProvidersOnce (1.70s)
    request_builds_once_test.go:40: request 2 built the providers 1 times, want 0
```

Branch: [`hunt49-a-builds-once`](https://github.com/ggbdpq/magpie/tree/hunt49-a-builds-once), one commit on top of upstream `79160455`; the patch below applies with `git am`.

## What changed

- `internal/provider/provider.go`: `allProviders` now notes when the build it counted was asked for — `AllBuiltAt`, an atomic beside `AllBuilt`. The ask is `allProviders` entered, and the hold's `time.Since(h.at)` rule is read at once after, so the recorded time and the hold's decision agree to within microseconds.
- `internal/gateway/request_builds_once_test.go`: the second request's allowance is no longer decided from `time.Now()` before the request, with a 900ms guess at how far behind its build can fall. A rebuild is let past only when it is exactly 1 AND the recorded ask landed a second or more after the first build's ask — the hold rightly letting go. A rebuild asked within the second, or more than one build in a request (the #2502 bug class), still fails. The same contract, judged by the clock that actually rules it.

## Red before the fix

Flaky under load; not reproduced locally — here is the deterministic proof, honestly labeled as constructed:

| Step | Setup | Result |
|---|---|---|
| Red | old test, injected 1.2s ask lag | FAIL: `request 2 built the providers 1 times, want 0` |
| Green | new test, same injected lag, `-count=2` | ok |
| Ablation | test reverted to the old form alone (hook kept, same lag) | FAIL again — the new test is what guards |

## Verification

| Check | Command | Result |
|---|---|---|
| Fixed test | `go test -tags nogui -count=8 -run 'TestRequestBuildsProvidersOnce$' ./internal/gateway/` | ok, 8/8 |
| Race | same with `-race -count=4` | ok |
| Full package | `go test -tags nogui -count=1 ./internal/gateway/` | ok (446.5s) |
| Provider package (product file touched) | `go test -tags nogui -count=1 ./internal/provider/` | ok (78.3s) |
| Format | `gofmt -l internal/gateway/ internal/provider/` | clean |
| Vet | `go vet -tags nogui ./internal/gateway/ ./internal/provider/` for darwin, linux, windows | ok |
| Builds | `CGO_ENABLED=0 go build -tags nogui` for darwin, linux, windows (arm64) | ok |

## Not verified

- The maintainer's loaded machine (load ~280–400) is not reproduced here; the evidence is the injected-lag construction above, which puts the build's ask past the hold while the request stays inside the old 900ms window.
- CI's machines and Windows at runtime are untried.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.
**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch — 0001-gateway-TestRequestBuildsProvidersOnce-judges-the-bu.patch</summary>

```patch
From d71367984e0fad098e84c355f6904f4d2b9cd4e0 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 05:37:09 +0800
Subject: [PATCH] gateway: TestRequestBuildsProvidersOnce judges the build's
 ask, not the request's start (#2965)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Cause: the test judged the second request by when it began, letting it
want 0 rebuilds only within 900ms of the first, while what was built is
held for a second. On a loaded machine a request can begin at, say,
850ms and reach the build after the hold has let the built providers
go, so it builds again — want 0, got 1 — and the test went red once in
a package run at load ~280–400. Alone it passes.

Fix: allProviders notes when the build it counts was asked for
(AllBuiltAt, beside AllBuilt), and the test judges a rebuild within the
second by that, not by the request's start: a build asked a second or
more after the first is the hold letting go, rightly; a build asked
within it is the hold failing, and stays red. The 900ms guess at how
far behind the request's start its build can fall is gone — nothing
rests on how fast the machine gets from the request to the build. The
rebuild the loaded machine asked for is the only one let past, and only
when it is exactly one: two builds in a request is the #2502 bug, still
red.

Red first, by construction (the flake doesn't reproduce on an idle
machine, 8/8 green alone before the fix): with a 1.2s lag put between
the second request's start and its build (in holdCatalog, an experiment
not committed), the old test failed "request 2 built the providers 1
times, want 0"; the new test passed the same lag; the old test failed
it again with the new hook in place (ablation: the test is what
guards).

Run (macOS arm64, go1.26.8, load ~4–7):
- go test -tags nogui -count=8 -run 'TestRequestBuildsProvidersOnce$'
  ./internal/gateway/: ok.
- go test -tags nogui -race -count=4 -run
  'TestRequestBuildsProvidersOnce$' ./internal/gateway/: ok.
- go test -tags nogui -count=1 ./internal/gateway/: ok (446s).
- go test -tags nogui -count=1 ./internal/provider/: ok (78s).
- gofmt -l internal/gateway/ internal/provider/: clean.
- go vet -tags nogui ./internal/gateway/ ./internal/provider/ for
  darwin, linux, windows: ok.
- CGO_ENABLED=0 go build -tags nogui, darwin/linux/windows arm64: ok.

Fixes #2965

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/request_builds_once_test.go | 31 ++++++++++++--------
 internal/provider/provider.go                |  7 +++++
 2 files changed, 26 insertions(+), 12 deletions(-)

diff --git a/internal/gateway/request_builds_once_test.go b/internal/gateway/request_builds_once_test.go
index 63ed12f7..caab9c63 100644
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
index dc4241bf..5945bb03 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -23,6 +23,7 @@ import (
 	"strings"
 	"sync"
 	"sync/atomic"
+	"time"
 
 	"github.com/yetone/magpie/internal/appdir"
 	"github.com/yetone/magpie/internal/catalog"
@@ -636,8 +637,14 @@ func (p Provider) clone() Provider {
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
 	stored := f.Providers
 	picks := map[string]Provider{}
-- 
2.50.1 (Apple Git-155)
```

</details>
