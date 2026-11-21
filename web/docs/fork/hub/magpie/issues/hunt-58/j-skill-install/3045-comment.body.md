This answers the screenshot in ye4241's comment above, which is a different failure from the Codex image-budget report this issue opened with (that one I addressed in [my comment from 10-21](https://github.com/yetone/magpie/issues/3045#issuecomment-6319795435)); please read this one on its own. Reproduced and fixed on current main `f5b0157420a` (fetched today).

## What the screenshot shows

Adding a skill from `stablyai/orca` fails with:

    GitHub's list of stablyai/orca's files wasn't understood: unexpected end of JSON input

The chain: the install asks GitHub's API for the repository's file list (`repoTree` in `internal/library/skillnew.go`, through `apiGet` in `internal/library/skillcheck.go`). `apiGet` read the answer's body with its read error thrown away (`body, _ := io.ReadAll(...)`). The status line of an answer arrives before its body — so when the connection died part-way through the body (a reset connection, a proxy that hangs up mid-answer), what was left was a status 200, a truncated body, and an error nobody kept. The truncated bytes went to the JSON parser, which said "unexpected end of JSON input", and the page framed that as GitHub's list being impossible to understand — when the list, in fact, never arrived.

Two things it was **not**:

- **Not rate limiting.** A spent limit arrives as a complete 403 whose body says "API rate limit exceeded", and magpie reports that in its own words. While investigating I watched the unauthenticated budget of this machine's shared address run out live: the same tree request answered `403` with valid JSON, which takes the friendly "limiting requests" path, never the screenshot's wording.
- **Not the repository.** `stablyai/orca` exists, and its tree lists 39,667 entries with `truncated: false` — well inside GitHub's own limits for this endpoint, so the answer parses fine whenever it arrives whole.

## Fix

`apiGet` keeps the read error now and says what happened — "couldn't read GitHub's answer: …" — and a 200 that arrives with nothing in it is reported as "GitHub answered nothing" instead of being fed to the parser (which also keeps an empty answer out of the ETag cache). With this patch, the screenshot's failure reads roughly "couldn't read GitHub's answer: unexpected EOF" — the broken trip, not a broken list.

Per the code standards' "a fix reaches every sibling of the bug": `latestRTK` (the rtk upgrade check, same package) had the same thrown-away read error on a GitHub API answer and keeps it now too. Everything else that reads a body with the error discarded in this repo reads it only to enrich a status-code error, where a truncated body cannot mislead, and is left alone.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Red, pre-fix | `go test -run 'TestAPIGetShortAnswer\|TestLatestRTKCutAnswer' ./internal/library/` | FAIL — "a cut-short answer wasn't noticed", "an empty answer wasn't noticed", and `TestLatestRTKCutAnswer` said the very "unexpected end of JSON input" |
| Green, post-fix | same | `ok`, both pass |
| Touched package in full | `go test -tags nogui -count=1 ./internal/library/` (temp HOME, `GOPATH`/`GOMODCACHE`/`GOCACHE` pinned) | `ok 66.511s`, exit 0 |
| Race | `go test -race -count=3 -run 'TestAPIGetShortAnswer\|TestLatestRTKCutAnswer' ./internal/library/` | `ok 32.923s`, exit 0 |
| Ablation | the new empty-body check removed by hand, test rerun | the empty-body assertion fails again; restored |
| Format | `gofmt -l` on the four changed files | clean |
| Vet | `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | pass (a pre-existing cgo warning in `internal/gui/trayimage_darwin.go` stays; the file is not touched) |
| Build | `go build ./...`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | pass on all three |

The new tests fake GitHub with httptest and never reach the network: the cut-short answer is a handler that promises `Content-Length: 1000`, flushes eight bytes of JSON, then aborts the connection — the answer's head arrives, its body doesn't, which is the shape the screenshot's failure takes.

## Not verified

- Which hop died on the reporter's machine (a reset connection, a proxy, or the mirror fallback when `MAGPIE_MIRRORS` is on) can't be told from a screenshot; all three reach this code as the same discarded read error.
- A middlebox that returns a complete-but-truncated JSON body and closes cleanly still lands on "wasn't understood" — accurate now, since the body truly arrived whole and is genuinely not JSON.
- The whole-repo suite was not run; the change touches only `internal/library`, and the package passes in full above. Nothing was pushed, so GitHub CI has not seen it.

## For the reporter (@ye4241)

The failure was on the way to GitHub, not in the repository and not in your setup — retrying when the connection holds should install `stablyai/orca` fine. Setting a GitHub token in Settings → Network and sharing keeps these requests off the shared 60-per-hour unauthenticated budget and off mirrors (requests that carry a token are never sent to a mirror), which removes the flakiest hop on a constrained network.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: […](https://github.com/ggbdpq/magpie/tree/hunt58-j-skill-install-json) (head `f0d77936212645940a5fbad673a1f3b579f3f7ec`).

<details><summary>patch: library: a GitHub answer cut off on the way is said so, not read as a list that couldn't be understood (#3045) — git am applies it as is; SHA-256 first 16: f9ccb6544348e153</summary>

```patch
From f0d77936212645940a5fbad673a1f3b579f3f7ec Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 00:20:22 +0800
Subject: [PATCH] library: a GitHub answer cut off on the way is said so, not
 read as a list that couldn't be understood (#3045)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: apiGet read the answer's body with its read error thrown
away, so an answer whose body died on the way arrived as a truncated
200 and was left to the parser: adding a skill from stablyai/orca
failed with "GitHub's list of stablyai/orca's files wasn't understood:
unexpected end of JSON input" (follow-up comment on #3045). The read
error is kept now, as "couldn't read GitHub's answer", and a 200 with
nothing in it is said to be empty rather than parsed ("GitHub answered
nothing"), which also keeps an empty answer out of the ETag cache.
latestRTK, the one sibling of the same shape, keeps its read error too.

Run: TestAPIGetShortAnswer and TestLatestRTKCutAnswer fail without the
change — the first with "a cut-short answer wasn't noticed" and "an
empty answer wasn't noticed", the second with the very "unexpected end
of JSON input" — and pass with it; gofmt -l clean; go vet ./...,
GOOS=linux go vet -tags nogui ./..., GOOS=windows go vet ./... pass;
go build ./..., GOOS=linux go build -tags nogui ./...,
GOOS=windows go build ./... pass; the whole internal/library package
passes (go test -tags nogui -count=1 ./internal/library/, 66.5s, temp
HOME with Go's caches pinned); the two new tests pass -race -count=3.
The whole-repo suite was not run; only internal/library changed.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/library/rtk_upgrade.go      |  5 ++++-
 internal/library/rtk_upgrade_test.go | 21 +++++++++++++++++++++
 internal/library/skillcheck.go       |  8 +++++++-
 internal/library/skillcheck_test.go  | 26 ++++++++++++++++++++++++++
 4 files changed, 58 insertions(+), 2 deletions(-)

diff --git a/internal/library/rtk_upgrade.go b/internal/library/rtk_upgrade.go
index 6a894d7d..7f03f338 100644
--- a/internal/library/rtk_upgrade.go
+++ b/internal/library/rtk_upgrade.go
@@ -296,7 +296,10 @@ func latestRTK() (string, error) {
 	var r struct {
 		Tag string `json:"tag_name"`
 	}
-	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
+	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
+	if err != nil {
+		return "", fmt.Errorf("couldn't read GitHub's answer: %w", err)
+	}
 	if err := json.Unmarshal(body, &r); err != nil {
 		return "", err
 	}
diff --git a/internal/library/rtk_upgrade_test.go b/internal/library/rtk_upgrade_test.go
index c445359a..d04425f7 100644
--- a/internal/library/rtk_upgrade_test.go
+++ b/internal/library/rtk_upgrade_test.go
@@ -57,6 +57,27 @@ func asJSON(t *testing.T, v *RTKView) map[string]any {
 	return m
 }
 
+// An answer cut off on the way is said so, not shown as a version that
+// couldn't be read (#3045).
+func TestLatestRTKCutAnswer(t *testing.T) {
+	sandbox(t)
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		w.Header().Set("Content-Length", "1000")
+		w.Write([]byte(`{"tag_name": "v0.`))
+		w.(http.Flusher).Flush() // the answer's head arrives, its body doesn't
+		panic(http.ErrAbortHandler)
+	}))
+	defer srv.Close()
+	old, oldAPI := rtkReleases, rtkReleasesAPI
+	rtkReleases, rtkReleasesAPI = srv.URL+"/latest", srv.URL
+	t.Cleanup(func() { rtkReleases, rtkReleasesAPI = old, oldAPI })
+	if _, err := latestRTK(); err == nil {
+		t.Error("a cut-short answer wasn't noticed")
+	} else if !strings.Contains(err.Error(), "couldn't read GitHub's answer") {
+		t.Errorf("said: %v", err)
+	}
+}
+
 // Homebrew's rtk is upgraded with brew; the days it saved come with the
 // summary, oldest first; the latest release is read from where GitHub
 // redirects to.
diff --git a/internal/library/skillcheck.go b/internal/library/skillcheck.go
index d0e25d6b..365c1da7 100644
--- a/internal/library/skillcheck.go
+++ b/internal/library/skillcheck.go
@@ -174,13 +174,19 @@ func apiGet(u string) ([]byte, int, bool, error) {
 		return nil, 0, token, fmt.Errorf("couldn't reach GitHub: %w", err)
 	}
 	defer resp.Body.Close()
-	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
+	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
+	if err != nil {
+		return nil, resp.StatusCode, token, fmt.Errorf("couldn't read GitHub's answer: %w", err)
+	}
 	if e, ok := limitedBy(resp, body, token); ok {
 		return nil, resp.StatusCode, token, e
 	}
 	if resp.StatusCode == 304 && cached {
 		return had.body, 200, token, nil
 	}
+	if resp.StatusCode == 200 && len(body) == 0 {
+		return nil, resp.StatusCode, token, fmt.Errorf("GitHub answered nothing")
+	}
 	if et := resp.Header.Get("ETag"); resp.StatusCode == 200 && et != "" {
 		etags.Lock()
 		etags.m[u] = etagged{etag: et, body: body}
diff --git a/internal/library/skillcheck_test.go b/internal/library/skillcheck_test.go
index 2aa05a8d..c35cdb3a 100644
--- a/internal/library/skillcheck_test.go
+++ b/internal/library/skillcheck_test.go
@@ -182,3 +182,29 @@ func check(t *testing.T) map[string]SkillCheck {
 	}
 	return m
 }
+
+// A GitHub answer cut off on the way, or an empty one, is said so, not
+// read as a list that couldn't be understood (#3045).
+func TestAPIGetShortAnswer(t *testing.T) {
+	sandbox(t)
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		w.Header().Set("Content-Length", "1000")
+		w.Write([]byte(`{"tree": [`))
+		w.(http.Flusher).Flush() // the answer's head arrives, its body doesn't
+		panic(http.ErrAbortHandler)
+	}))
+	defer srv.Close()
+	if _, _, _, err := apiGet(srv.URL); err == nil {
+		t.Error("a cut-short answer wasn't noticed")
+	} else if !strings.Contains(err.Error(), "couldn't read GitHub's answer") {
+		t.Errorf("said: %v", err)
+	}
+
+	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
+	defer empty.Close()
+	if _, _, _, err := apiGet(empty.URL); err == nil {
+		t.Error("an empty answer wasn't noticed")
+	} else if !strings.Contains(err.Error(), "GitHub answered nothing") {
+		t.Errorf("said: %v", err)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
