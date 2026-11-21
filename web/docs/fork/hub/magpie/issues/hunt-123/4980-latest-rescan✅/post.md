**What's wrong**

`agents/rescan` — the page's own "re-detect" — forgot everything the Agents page keeps **except** where updates come from: `latestVersion` kept its answer under a constant key for six hours (`latests` memo, `cliupdate.go`), so a version published after magpie started showed no update pill and joined no "N agents have updates" line until the memo ran out or magpie restarted — while a fresh process asked npm at once and saw it, exactly your `/api/agents/cli` capture. Your reading of the mechanism was correct on every point; the fix is the first of your two options. Credit @noxchen for the two-process A/B that pins the memo.

**The fix** (3 files, +53)

- `Rescan` now drops the kept update answers (`latests.forgetAll()`, a new no-arg forget beside the per-key one, skipping any ask still running) — the same thing it already did for `proc.LookPath`, the WSL probes and Alma's server. The next read of the page asks npm/brew again.
- The six-hour TTL stands: the re-detect is the user saying "look again now", and a TTL change would trade npm politeness for a behavior the refresh already covers.

**Verification**

| Check | Result |
| --- | --- |
| New `TestRescanAsksLatestAgain` (npm registry served by the test, ask counted) | red before the fix — `after the refresh npm was asked 1 times, not once more`; ok with it (asked twice) |
| Ablation (fix reverted to the parent, tests kept) | the new test's red is that state verbatim; the existing `TestRescanLooksAgain` stays green both ways |
| `go test -tags nogui ./internal/agent/` full package | ok except `TestMothX` — red on the parent too (house pre-existing list, proven by stash at `7785c4278`), untouched |
| `-race -count=2` on the rescan tests | ok |
| `gofmt -l`, `go vet -tags nogui ./internal/agent/`, `go build ./...` | clean / clean (the trayimage cgo warning is #4821's, as on main) / ok |

<details><summary>patch: agent: the Agents page's re-detect asks where updates come from again (#4980) — git am applies it as is; SHA-256 first 16: b063e6353538928a</summary>

```patch
From 473f0ac3d77496f9ceb128496fe0bc536772a85b Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 03:26:59 +0800
Subject: [PATCH] agent: the Agents page's re-detect asks where updates come
 from again (#4980)

latestVersion kept its answer for hours under a constant key, and the
page's own refresh forgot everything but it: a version published after
magpie started showed no update until the memo ran out or magpie
restarted, though a fresh process asked npm at once and saw it.

Rescan now drops the kept answers, the way it already did for where
commands were found and what the slow readers had said.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/cliupdate.go   | 12 ++++++++++++
 internal/agent/rescan.go      |  4 ++++
 internal/agent/rescan_test.go | 37 +++++++++++++++++++++++++++++++++++
 3 files changed, 53 insertions(+)

diff --git a/internal/agent/cliupdate.go b/internal/agent/cliupdate.go
index 1b0fc6454..b06545f97 100644
--- a/internal/agent/cliupdate.go
+++ b/internal/agent/cliupdate.go
@@ -591,6 +591,18 @@ func (m *memo) forget(key string) {
 	m.mu.Unlock()
 }
 
+// forgetAll drops every kept answer whose ask isn't running: the Agents
+// page's re-detect asks them all again.
+func (m *memo) forgetAll() {
+	m.mu.Lock()
+	for k, e := range m.m {
+		if e.ready == nil {
+			delete(m.m, k)
+		}
+	}
+	m.mu.Unlock()
+}
+
 var versions, latests memo
 
 // installedVersion is what the CLI at bin says its version is, asked again
diff --git a/internal/agent/rescan.go b/internal/agent/rescan.go
index 5fcc8d8d7..736d1b7ba 100644
--- a/internal/agent/rescan.go
+++ b/internal/agent/rescan.go
@@ -16,6 +16,10 @@ import (
 func Rescan() {
 	proc.Forget()
 
+	// where updates come from is asked again, too: a version published
+	// after magpie started showed no update until the memo ran out (#4980)
+	latests.forgetAll()
+
 	cursorLocalSeen.Lock()
 	cursorLocalSeen.at = time.Time{}
 	cursorLocalSeen.Unlock()
diff --git a/internal/agent/rescan_test.go b/internal/agent/rescan_test.go
index 013fed15d..2d53bef41 100644
--- a/internal/agent/rescan_test.go
+++ b/internal/agent/rescan_test.go
@@ -1,6 +1,9 @@
 package agent
 
 import (
+	"encoding/json"
+	"net/http"
+	"net/http/httptest"
 	"os"
 	"path/filepath"
 	"runtime"
@@ -69,3 +72,37 @@ func TestRescanLooksAgain(t *testing.T) {
 		t.Errorf("Alma's answers are kept: %d", n)
 	}
 }
+
+// The refresh asks where updates come from again, too: a version published
+// after magpie started stayed invisible to its own re-detect until a
+// restart, the newest kept for hours and nothing asking anew (#4980).
+func TestRescanAsksLatestAgain(t *testing.T) {
+	asks := 0
+	reg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		asks++
+		_ = json.NewEncoder(w).Encode(map[string]string{"version": "1.5.0"})
+	}))
+	t.Cleanup(reg.Close)
+	oldReg := npmRegistry
+	npmRegistry = reg.URL + "/"
+	t.Cleanup(func() { npmRegistry = oldReg; latests = memo{} })
+	latests = memo{}
+
+	u := &updater{via: "npm", pkg: "earendil/test"}
+	if got := latestVersion(u); got != "1.5.0" {
+		t.Fatalf("latest %q", got)
+	}
+	if got := latestVersion(u); got != "1.5.0" {
+		t.Fatalf("latest %q the second time", got)
+	}
+	if asks != 1 {
+		t.Fatalf("npm asked %d times for one kept answer", asks)
+	}
+	Rescan()
+	if got := latestVersion(u); got != "1.5.0" {
+		t.Fatalf("latest %q after the refresh", got)
+	}
+	if asks != 2 {
+		t.Fatalf("after the refresh npm was asked %d times, not once more", asks)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [fix/4980-agent-version-refresh](https://github.com/ggbdpq/magpie/tree/fix/4980-agent-version-refresh) (head `473f0ac3d77496f9ceb128496fe0bc536772a85b`).

**Not verified:** no nvm/npm-global pi install here — the npm side is proven against a served registry, not npmjs.org; the brew and grok channels ride the same memo and the same forget, untested against their real vendors.

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
