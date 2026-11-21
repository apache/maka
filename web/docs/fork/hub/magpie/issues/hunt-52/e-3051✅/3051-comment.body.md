Fixed by waiting for the state instead of the fixed 200ms.

Your run at load ~400 failed with `full list again: picks [pool-a pool-b], set aside [qoder/claude-x kiro/claude-y]` at `plugin_delisted_test.go:129`. The test sends the full list on `answers`, checks the loop is not asked again within a fixed 200ms window (`case <-time.After(200 * time.Millisecond)`, `internal/provider/plugin_delisted_test.go:122` at `dee5c9d7`), then reads the provider with `Find` and asserts the picks came back. The loop applies the list in its own goroutine after the stub returns it, so the only thing ordering that `Find` after the apply was the 200ms itself; on a loaded machine the apply outlasts the window and the read comes too early.

The fix keeps the "not asked again" check as it is and waits for the picks separately: poll `Find` every 25ms, up to 10s, until the picks are back and nothing is set aside, then make the same assertion as before — the bounded-poll form the package's other tests already use (`claude_status_test.go`, `plugin_usage_test.go`, `retired_test.go`). Production code exposes no signal for "list applied", so the state itself is what the test waits on.

Branch: [`hunt52-e-plugin-picks-wait`](https://github.com/ggbdpq/magpie/tree/hunt52-e-plugin-picks-wait), one commit on top of upstream `dee5c9d7`; the patch below applies with `git am`.

## What changed

- `internal/provider/plugin_delisted_test.go`, test `TestPluginPicksComeBackWithTheirList` only. After the 200ms "not asked again" window (kept as it is, and still the only check that the loop does not ask again after a list that left nothing out), a bounded poll reads `Find("our-free-model")` every 25ms until the picks equal `pool-a pool-b qoder/claude-x kiro/claude-y` and `Delisted` is empty (10s deadline; on expiry it falls through to the unchanged assertion, which fails with the state it saw last). The final assertion, the "not asked again" check and every other assertion are unchanged. No production file touched.

## Verification

(darwin/arm64, go 1.26.8; `-run 'TestPluginPicksComeBackWithTheirList$' ./internal/provider/` throughout)

| Check | Result |
| --- | --- |
| after, `-count=10`, alone | ok, 10/10 |
| after, `-count=10`, load average ~340 (CPU burners) | ok, 10/10 |
| before, `-count=10`, alone | ok, 10/10 (flaky only under load, as reported) |
| before, `-count=20`, load average ~60-73 | ok, 20/20 — your red not reproduced locally (your run was ~400) |
| before + 300ms injected between the stub's answer and the loop's apply | FAIL: `full list again: picks [pool-a pool-b], set aside [qoder/claude-x kiro/claude-y]` — your failure, on demand |
| after + the same 300ms delay | ok — the poll waits the apply out |
| `go test -tags nogui -count=1 ./internal/provider/` | ok (102s) |
| `gofmt -l internal/provider/` | clean |
| `go vet -tags nogui ./internal/provider/`, darwin / linux / windows | OK |
| `go build -tags nogui ./...`, darwin / linux / windows | OK (pre-existing cgo warning in `internal/gui/trayimage_darwin.go`) |

## Not verified

- Your load ~400 machine: the most I could generate locally was ~340 (where the fixed form passes 10/10), and at ~60-73 the old form still passed 20/20 — the red was not reproduced with load alone here. It is reproduced on demand by injecting 300ms between the answer and the apply (table above), which is exactly the slack the fixed window hides; the poll removes that window by construction — it cannot read before the state exists, because it waits for the state.
- Windows and cross-compiled macOS/linux are build and vet only, as usual for this repo's matrix.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.
**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (git am)</summary>

```patch
From 749a176f99e555fa2efacc7b0eb3e34d5be26fe9 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 20:25:18 +0800
Subject: [PATCH] provider: TestPluginPicksComeBackWithTheirList waits for the
 picks, not 200ms (#3051)

What changed: after the full list answers, the test still checks the
loop is not asked again within 200ms (that check kept as it is), but it
no longer assumes the picks' return lands inside that window: it polls
Find every 25ms, up to 10s, until the picks are back and nothing is set
aside, then makes the same assertion as before. The package's other
tests wait this way already (claude_status_test.go,
plugin_usage_test.go, retired_test.go).

Why: the loop applies the list in its own goroutine after the stub
returns it, and the only thing ordering the test's Find after that
apply was the fixed 200ms. On the maintainer's machine at load ~400
the apply outlasted the window, and the test read the picks still set
aside: "full list again: picks [pool-a pool-b], set aside
[qoder/claude-x kiro/claude-y]" (#3051). Alone it always passed.

Run (darwin/arm64, go 1.26.8):
- go test -count=10 -run 'TestPluginPicksComeBackWithTheirList$'
  ./internal/provider/: after the fix, ok 10/10 alone and 10/10 at
  load average ~340; before it, 10/10 alone too (flaky only under
  load) and 20/20 at load ~60-73 (the maintainer's run was at ~400;
  not reproduced here with load alone)
- the old form with 300ms injected between the stub's answer and the
  loop's apply goes red with the maintainer's exact message; the new
  form with the same delay stays green: the failure is the fixed
  window, and the poll removes it
- go test -tags nogui -count=1 ./internal/provider/: ok (102s)
- gofmt -l internal/provider/: clean; go vet -tags nogui
  ./internal/provider/ for darwin, linux and windows: OK; go build
  -tags nogui ./... for the three: OK (a cgo warning in
  internal/gui/trayimage_darwin.go is pre-existing)

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/plugin_delisted_test.go | 18 ++++++++++++++++++
 1 file changed, 18 insertions(+)

diff --git a/internal/provider/plugin_delisted_test.go b/internal/provider/plugin_delisted_test.go
index 0689367f..f5f3e28e 100644
--- a/internal/provider/plugin_delisted_test.go
+++ b/internal/provider/plugin_delisted_test.go
@@ -116,11 +116,29 @@ func TestPluginPicksComeBackWithTheirList(t *testing.T) {
 	}
 
 	answers <- full
+	// a list that left nothing out is asked no sooner than the hour: the
+	// window only checks that. That the picks came back with the list is
+	// waited for after it, not assumed to land within it: the loop
+	// applies the list when it gets to it, later than any fixed delay on
+	// a loaded machine (one run at load ~400 read the picks still set
+	// aside), so the state is waited on, the window kept to its own check
 	select {
 	case <-asked:
 		t.Fatal("asked again soon after a list that left nothing out")
 	case <-time.After(200 * time.Millisecond):
 	}
+	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(25 * time.Millisecond) {
+		p, err = Find("our-free-model")
+		if err != nil {
+			t.Fatal(err)
+		}
+		if slices.Equal(p.Models, []string{"pool-a", "pool-b", "qoder/claude-x", "kiro/claude-y"}) && len(p.Delisted) == 0 {
+			break
+		}
+		if time.Now().After(deadline) {
+			break // the assertion below reports the state it saw last
+		}
+	}
 	p, err = Find("our-free-model")
 	if err != nil {
 		t.Fatal(err)
-- 
2.50.1 (Apple Git-155)

```

</details>
