@yetone Following up on the Antigravity gateway lane: the stale `antigravity/hub/2.9.1` in @banana499's report (#5679) is magpie's own fallback constant, not a reading of anything on the Mac — and a failed ask of the updater keeps it, silently, for the same six hours a good answer gets. Fixed in the patch below.

**Root cause**: every request to Code Assist as Antigravity builds its User-Agent at `google.go:452` as `antigravity/hub/` + `antigravityVersion()` + GOOS/GOARCH. `antigravityVersion()` (`google.go:477` before this patch) asks the updater's manifest (`latest-arm64-mac.yml`) for the newest Hub's version, keeps a good answer six hours, and, when the ask fails — the updater unreachable (magpie's GUI process doesn't ride the shell's proxy: Go reads proxy settings from environment variables the app, launched from Finder, doesn't have; `curl` in a terminal does, which is why the manifest "is accessible" from the same Mac), a bad gateway, or a manifest with no version — holds the fallback `2.9.1` (the constant the ask first shipped with, `637b2458e`) **silently and for the same six hours** (`antigravityVer.at` is set before the ask, so a failed ask is cached like a good one): one failed ask rode every request until magpie restarted, and if the ask failed again on start-up, 2.9.1 stayed. Nothing on the Mac is read: the installed app's version never enters this path (the reporter's own follow-up — app 2.29.1, manifest 2.29.0, UA still 2.9.1 — rules an old desktop install out). Code Assist gates Gemini 4 Argon by that version (the controlled experiment in Wei-Shaw/sub2api#8062: same token, same project, `antigravity/hub/2.9.1 …` → Argon 404 from an older catalog, `antigravity/hub/2.23.0 …` → 200), which is also why the failing side lists 23 models / 17 kept against the working side's 26 / 20: the fixed six of `antigravityHidden` come off both (23−6=17, 26−6=20), and the difference of three is the Argon tiers the older catalog doesn't carry.

Why Windows says 2.29.0 (not a coincidence, and no platform branch: `rg antigravity` finds one UA construction and one manifest URL, both platform-blind — Windows asks the same `latest-arm64-mac.yml`, whose version is the same across platforms): the only difference between the two machines is whether that one HTTP ask gets through. On the Windows box it does (its proxy takes the traffic system-wide), so the code reads 2.29.0 and caches it; on the Mac the ask fails and the old fallback rides instead.

**The fix**: a failed ask now holds the fallback for a minute and then asks again, saying so in the log (it was mute before — the reason the reporter could reach the manifest while magpie "continued sending 2.9.1" had no trace anywhere); a good answer still keeps its six hours. With the ask alive again the version follows on its own, no restart and no re-sign-in. The `2.9.1` constant itself stays as the bottom value — an empty version would read `antigravity/hub/ darwin/arm64`, worse than an old one — but it no longer sticks: this reporter's ask, once their proxy reaches the updater, heals within a minute. Reading the installed app's version as a second rung would need each platform's install metadata (the bundle id, the Windows installer's GUID) that this repo doesn't record anywhere; worth having, but it can stand on its own issue. To the reporter's four questions: (1) the version is asked of the updater's manifest, no macOS branch; (2) yes — an outdated fallback cached despite the manifest being reachable, exactly; (3) with the fix, no step is needed — the ask retries every minute and heals by itself; (4) the catalog follows the version now: a healed ask refreshes it on the next model listing.

<details><summary>patch: provider: an ask of Antigravity's updater that fails holds its fallback for a minute, not six hours, and says so (#5679) — git am applies it as is; SHA-256 first 16: 72d7f46d6e5f77a9</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 15:40:04 +0800
Subject: [PATCH] provider: an ask of Antigravity's updater that fails holds
 its fallback for a minute, not six hours, and says so (#5679)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

antigravityVersion asks the updater's manifest for the newest Hub's
version, keeps a good answer for six hours, and, while the ask fails,
holds the fallback it first shipped with (2.9.1) — silently, and for
the same six hours a good answer gets, so one failed ask rode every
request until magpie restarted, and a Mac whose gateway couldn't reach
the updater said 2.9.1 across restarts of it (banana499: the installed
app was 2.29.1 and the manifest said 2.29.0, yet the User-Agent stayed
antigravity/hub/2.9.1 darwin/arm64 — with Code Assist gating Gemini 4
Argon from so old a version, where the same account's Windows magpie,
whose ask could get through, said 2.29.0 and Argon worked).

A failed ask — the updater unreachable (a GUI app doesn't ride the
shell's proxy), a bad gateway, a manifest with no version — now holds
the fallback for a minute and then asks again, saying so in the log;
a good answer still keeps its six hours. With the ask alive again the
version follows on its own, no restart needed.

Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/google.go      |  37 ++++++--
 internal/provider/google_test.go | 139 ++++++++++++++++++++++++++++++-
 2 files changed, 168 insertions(+), 8 deletions(-)

diff --git a/internal/provider/google.go b/internal/provider/google.go
index 70e35577a..70d291c7c 100644
--- a/internal/provider/google.go
+++ b/internal/provider/google.go
@@ -461,16 +461,27 @@ func (g googleApp) userAgent(model string) string {
 
 var antigravityVer struct {
 	sync.Mutex
-	v  string
-	at time.Time
+	v     string
+	at    time.Time
+	fresh bool // the updater answered the last ask with a version
 }
 
 // antigravityVersion is the newest Antigravity's version, which its
-// requests carry; asked of its updater at most every few hours.
+// requests carry; asked of its updater at most every few hours. An ask
+// that fails — the updater unreachable (a GUI app doesn't ride the
+// shell's proxy, and its host needn't be where Code Assist is), a bad
+// gateway, a manifest without a version — holds the fallback (2.9.1) for
+// a minute, then asks again, saying so in the log: that fallback is old
+// enough now that Code Assist gates Argon from it (#5679), so a silent
+// six-hour stick on it hid the failure and outlived the network.
 func antigravityVersion() string {
 	antigravityVer.Lock()
 	defer antigravityVer.Unlock()
-	if antigravityVer.v != "" && time.Since(antigravityVer.at) < 6*time.Hour {
+	keep := 6 * time.Hour
+	if !antigravityVer.fresh {
+		keep = time.Minute
+	}
+	if antigravityVer.v != "" && time.Since(antigravityVer.at) < keep {
 		return antigravityVer.v
 	}
 	antigravityVer.at = time.Now()
@@ -481,24 +492,36 @@ func antigravityVersion() string {
 	defer cancel()
 	req, err := http.NewRequestWithContext(ctx, http.MethodGet, antigravityVersionURL, nil)
 	if err != nil {
+		log.Printf("antigravity: the updater's version ask: %v; staying with %s", err, antigravityVer.v)
 		return antigravityVer.v
 	}
 	req.Header.Set("User-Agent", "electron-builder")
 	res, err := http.DefaultClient.Do(req)
 	if err != nil {
+		log.Printf("antigravity: the updater's version ask: %v; staying with %s", err, antigravityVer.v)
 		return antigravityVer.v
 	}
 	defer res.Body.Close()
+	if res.StatusCode != http.StatusOK {
+		log.Printf("antigravity: the updater's version ask: %s; staying with %s", res.Status, antigravityVer.v)
+		return antigravityVer.v
+	}
 	sc := bufio.NewScanner(io.LimitReader(res.Body, 64<<10))
+	good := ""
 	for sc.Scan() {
 		if v, ok := strings.CutPrefix(sc.Text(), "version:"); ok {
-			v = strings.Trim(strings.TrimSpace(v), `'"`)
-			if v != "" && strings.Trim(v, "0123456789.") == "" {
-				antigravityVer.v = v
+			if v = strings.Trim(strings.TrimSpace(v), `'"`); v != "" && strings.Trim(v, "0123456789.") == "" {
+				good = v
 			}
 			break
 		}
 	}
+	antigravityVer.fresh = good != ""
+	if good != "" {
+		antigravityVer.v = good
+	} else {
+		log.Printf("antigravity: the updater's manifest names no version; staying with %s", antigravityVer.v)
+	}
 	return antigravityVer.v
 }
 
diff --git a/internal/provider/google_test.go b/internal/provider/google_test.go
index 310fd9d75..5b41782b6 100644
--- a/internal/provider/google_test.go
+++ b/internal/provider/google_test.go
@@ -115,7 +115,7 @@ func resetGoogleState() {
 	googleState.refused = map[string]time.Time{}
 	googleState.Unlock()
 	antigravityVer.Lock()
-	antigravityVer.v, antigravityVer.at = "", time.Time{}
+	antigravityVer.v, antigravityVer.at, antigravityVer.fresh = "", time.Time{}, false
 	antigravityVer.Unlock()
 }
 
@@ -979,3 +979,140 @@ func TestAntigravityQuotaModelApartFromGroup(t *testing.T) {
 		}
 	}
 }
+
+// antigravityVersion asks the updater for the newest Hub's version and keeps
+// a good answer for six hours. An ask that fails — the updater unreachable,
+// a bad gateway, a manifest with no version — holds the fallback (2.9.1, the
+// version the ask first shipped with) for a minute, then asks again: that
+// fallback is old enough now that Code Assist gates Argon from it, so a
+// silent six-hour stick on it hid the failure and outlived the network
+// (#5679: a Mac whose gateway couldn't reach the updater kept saying 2.9.1
+// across restarts of magpie, while its Windows sibling, which could reach
+// it, said 2.29.0, and Argon worked only there).
+func TestAntigravityVersionFailedAskRetriedSoon(t *testing.T) {
+	var mu sync.Mutex
+	var hits, status int
+	var body string
+	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		hits++
+		s, b := status, body
+		mu.Unlock()
+		if s != 0 {
+			http.Error(w, b, s)
+			return
+		}
+		io.WriteString(w, b)
+	}))
+	defer live.Close()
+	gone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
+	goneURL := gone.URL
+	gone.Close()
+
+	old := antigravityVersionURL
+	t.Cleanup(func() {
+		antigravityVersionURL = old
+		resetGoogleState()
+	})
+	for _, c := range []struct {
+		name   string
+		closed bool // the updater's host refuses connections
+		status int
+		body   string
+		count  bool // the failed ask is countable (a closed host isn't)
+	}{
+		{"bad gateway", false, http.StatusBadGateway, "no", true},
+		{"unreachable", true, 0, "", false},
+		{"no version in the manifest", false, 0, "path: x.zip\n", true},
+	} {
+		t.Run(c.name, func(t *testing.T) {
+			host := live.URL
+			if c.closed {
+				host = goneURL
+			}
+			antigravityVersionURL = host + "/latest-arm64-mac.yml"
+			resetGoogleState()
+			mu.Lock()
+			hits, status, body = 0, c.status, c.body
+			mu.Unlock()
+			if v := antigravityVersion(); v != "2.9.1" {
+				t.Fatalf("version while the ask fails = %q, want the fallback 2.9.1", v)
+			}
+			if c.count {
+				mu.Lock()
+				n := hits
+				mu.Unlock()
+				if n != 1 {
+					t.Fatalf("asked %d times, want once", n)
+				}
+			}
+			// a failed ask holds the fallback for a minute, not the good
+			// answer's six hours
+			antigravityVer.Lock()
+			antigravityVer.at = time.Now().Add(-time.Minute)
+			antigravityVer.Unlock()
+			// and once the updater answers again, the version follows by
+			// itself, carried by the requests magpie sends (the failing Mac
+			// said 2.9.1 across restarts; with the ask alive again it says
+			// the updater's without one)
+			antigravityVersionURL = live.URL + "/latest-arm64-mac.yml"
+			mu.Lock()
+			status, body = 0, "version: 2.29.0\npath: x.zip\n"
+			mu.Unlock()
+			if v := antigravityVersion(); v != "2.29.0" {
+				t.Fatalf("version once the updater answers = %q, want 2.29.0", v)
+			}
+			a, _ := googleAppOf("antigravity")
+			if ua := a.userAgent(""); !strings.HasPrefix(ua, "antigravity/hub/2.29.0 ") {
+				t.Errorf("user agent = %q, want antigravity/hub/2.29.0 …", ua)
+			}
+		})
+	}
+}
+
+// A good answer keeps six hours: within them the updater isn't asked again,
+// past them it is.
+func TestAntigravityVersionGoodAnswerKeptSixHours(t *testing.T) {
+	var mu sync.Mutex
+	hits := 0
+	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		hits++
+		mu.Unlock()
+		io.WriteString(w, "version: 2.29.0\npath: x.zip\n")
+	}))
+	defer live.Close()
+
+	old := antigravityVersionURL
+	antigravityVersionURL = live.URL + "/latest-arm64-mac.yml"
+	resetGoogleState()
+	t.Cleanup(func() {
+		antigravityVersionURL = old
+		resetGoogleState()
+	})
+	if v := antigravityVersion(); v != "2.29.0" {
+		t.Fatalf("version = %q, want 2.29.0", v)
+	}
+	antigravityVer.Lock()
+	antigravityVer.at = time.Now().Add(-5 * time.Hour)
+	antigravityVer.Unlock()
+	if v := antigravityVersion(); v != "2.29.0" {
+		t.Fatalf("version = %q, want 2.29.0", v)
+	}
+	mu.Lock()
+	n := hits
+	mu.Unlock()
+	if n != 1 {
+		t.Fatalf("asked %d times within the six hours, want once", n)
+	}
+	antigravityVer.Lock()
+	antigravityVer.at = time.Now().Add(-7 * time.Hour)
+	antigravityVer.Unlock()
+	antigravityVersion()
+	mu.Lock()
+	n = hits
+	mu.Unlock()
+	if n != 2 {
+		t.Fatalf("not asked again past the six hours (asked %d, want 2)", n)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5679-antigravity-hub-ua`](https://github.com/ggbdpq/magpie/tree/fix/5679-antigravity-hub-ua) (head `581c73b3d51fee8daf1e3573f918005123579d3c`), rebased onto current `upstream/main` (`eadc6cdb9`); on a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `TestAntigravityVersionFailedAskRetriedSoon` (new; bad gateway / unreachable / manifest with no version) | red before the fix, pass after |
| `TestAntigravityVersionGoodAnswerKeptSixHours` (new; pins the six-hour keep of a good answer) | pass |
| `TestAntigravitySignsAsAntigravity` etc. (existing UA assertions, `google_test.go`) | pass |
| `go test ./internal/provider/ -tags nogui -timeout 25m -count=1` | ok (116s), zero failures |
| `go test -tags nogui ./...` (temp HOME) | 3 failures, all pre-existing on the untouched tree: `TestMothX` and `TestProxyCheckSaysAProxyPassedBy` (this machine's known local-proxy environment; listed before this lane started) and `TestHostToldTheGatewayAddress` — fails the same on the untouched tip (re-ran `TestHostToldTheGatewayAddress` at `15918265e`: FAIL), not from this patch; everything else ok |
| targeted `-race -run TestAntigravityVersion` | pass, 3 runs |
| `gofmt -l internal/provider/google.go internal/provider/google_test.go` | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | clean |
| Ablation | removing the failed ask's minute (`keep = time.Minute` → the old six hours for every answer) turns `TestAntigravityVersionFailedAskRetriedSoon` red on all three cases; restored, green |
| Re-verified on upstream/main `eadc6cdb9` | branch rebased as `upstream/main` moved (`437580535` at cut, then `15918265e`, then `eadc6cdb9`); antigravity tests re-run green after each |

**Not verified**: the reporter's own Mac (Google OAuth + the desktop gateway's network path) — NOT-RUNNABLE here; the failing-ask-to-healed-UA behavior is covered by the fake upstream in `TestAntigravityVersionFailedAskRetriedSoon`, whose three cases are the shapes the Mac's ask was failing with (unreachable among them). `TestPluginCheckinAsksAgainAtUntil` under `-race` fails intermittently with a `DATA RACE` on `time.Local` (test writes the global while `internal/testenv`'s background goroutine reads it) — fails the same on the parent commit (3 of 5 runs at `437580535`), not from this patch.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
