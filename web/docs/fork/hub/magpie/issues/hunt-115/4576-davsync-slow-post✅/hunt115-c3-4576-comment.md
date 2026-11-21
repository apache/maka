### What changed

The stall watchdog (`internal/davsync/stall.go`) now treats a request hauling a big body (64 KiB or more) the way it treats a GET or a PUT: its watchdog is put back each time bytes move, and after the body is all handed over the answer still gets 60 s on top of as long as the write took (at least 4x that). GitHub's uploads ride the one method the watchdog used to see as metadata: each `POST git/blobs` hauls up to 16 MiB of file as about 21 MB of base64 (`githubPart`, out of #2707's parts mechanism), and a flat 30 s needs 550 KB/s of effective upstream to get one part through. On a slower line the sync died on that POST at every attempt -- automatic, at start, and manual -- and a slow but live line now finishes the part instead of failing forever. The requests that stay on the flat 30 s are the ones the old rule was written for: the GitHub tree, commit and ref POSTs and PATCH and WebDAV's PROPFIND/MKCOL/MOVE/DELETE, all kilobytes at most.

### Root cause

`stallTransport.RoundTrip` picked the budget by method alone: `moving := req.Method == GET || req.Method == PUT`, everything else got `metaLimit` (30 s) for the whole request. The comment above it says the other requests "move a few KB at most" -- true for WebDAV and S3, false for the GitHub backend #2707 built, whose every upload is a POST and whose backup parts are 16 MiB of file each. One short window wedged the machine for good not because a state was remembered -- `sync-state.json` holds no stuck state, and every run started over -- but because every run retried the same first blob through the same 30 s budget on the same slow line: a deterministic failure loop that no restart or update could break (the reporter's restarts at 19:32-20:20 and the 0.1.2342 to 0.1.2391 update all died on the same POST). The TLS handshake timeout (#4077's shape) and the forcibly-closed connection through the local proxy in the log are aggravations on the same line, not the wedge itself.

### Verification
| Check | Result |
|---|---|
| `go test ./internal/davsync/ -run TestGitHubSlowBlobUploadIsNotCutShort` (a 272 KB base64 body through a 320 KB/s line, watchdogs shortened to 1 s/300 ms) on parent `1fac66c0` | FAIL: `Post ".../git/blobs": the server didn't answer in 300ms (POST)` -- the shape of this issue's error, in a shortened sandbox |
| same, with the fix | ok (0.87 s) |
| `TestGitHubSmallPostKeepsTheLimit` (a kilobyte POST, a stopped server) with the fix | ok (0.30 s): small POSTs keep the flat limit |
| ablation: parent's `stall.go`, tests kept | FAIL again with the same message; restore, pass |
| `go test -tags nogui ./internal/davsync/ -count=1` | ok |
| same package, `-race -run 'Stall|Slow|Metadata|Transfer|Cut|GitHub'` | ok |
| `gofmt -l` on touched files, `go vet ./internal/davsync/` | clean |
| `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean |
| `go build -tags nogui` darwin / linux / windows | ok |

### Notes

- Sibling audit (`rg` over `internal/davsync`): the only non-GET/PUT senders are GitHub's `git/blobs` (big -- covered by this), `git/trees` and `git/commits` and `git/refs` PATCH (under 4 KB of JSON), the Contents DELETE of an empty repository's first write (under 200 B), and WebDAV/S3 usage DELETEs with no body. The threshold leaves all of the small ones exactly where they were: 64 KiB is 16x the largest metadata body and takes a line under ~2 KB/s the whole 30 s to send.
- `bigBody` reads `req.ContentLength`, set by `http.NewRequest` from the `bytes.Reader` every sender here uses; bodyless requests carry `http.NoBody` or a nil Body and never match.
- A stalled big POST now says "the server sent and took nothing for 1m0s (POST): the line or the server stopped" instead of a flat 30 s -- the same wording a stalled PUT has had since #657.

### Not verified

- No real slow line to GitHub was at hand (the reporter's Windows machine is where the wedge lives); the slow-line behavior is covered by the shortened-sandbox test above.
- `go test -tags nogui ./...` over the whole repository was not run (this box is running several worktrees at once); the touched package ran in full, with `-race` on the stall and GitHub suites, and vet ran for the whole tree on linux and windows.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: davsync: a GitHub blob POST on a slow but live line is no longer cut off at 30 s (#4576) — git am applies it as is; SHA-256 first 16: 5eea804af551685d</summary>

````
From e97601d65ed6d49f061fed3171d72398b111a324 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 18:16:20 +0800
Subject: [PATCH] davsync: a GitHub blob POST on a slow but live line is no
 longer cut off at 30 s

What changed: the stall watchdog saw a request as one whose body may
outlast the whole metadata limit only by method (GET, PUT), and gave every
other request a flat 30 s (#657's rule held for WebDAV and S3, whose
remaining requests move a few KB at most). GitHub's uploads ride a POST:
each blob POST hauls up to 16 MiB of file as about 21 MB of base64, and a
flat 30 s needs 550 KB/s to get one part through (#4576: on a slower line
the sync failed on the same POST at every attempt, automatic, at start and
manual, and never recovered -- the usage day file froze in the morning
while the machine kept working). A request hauling a big body (64 KiB or
more) now gets the same moving-aware budget as a PUT: the watchdog is put
back each time bytes move, and after the body is all handed over the
answer gets 60 s on top of as long as the write took. The metadata
requests (the GitHub tree, commit and ref POSTs and PATCH, WebDAV
PROPFIND/MKCOL/MOVE/DELETE -- kilobytes at most) keep their 30 s in all.

Run: TestGitHubSlowBlobUploadIsNotCutShort (a 272 KB base64 body through a
line at 320 KB/s, watchdogs shortened to 1 s/300 ms) fails on the old code
with "the server didn't answer in 300ms (POST)", the shape of #4576's
error, and passes now; TestGitHubSmallPostKeepsTheLimit pins the small
POSTs to the old limit either way. go test -tags nogui ./internal/davsync,
vet and builds for darwin, GOOS=linux and GOOS=windows pass. Not tried
against a real slow line to GitHub.

Fixes #4576

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/davsync/stall.go      |  32 ++++++---
 internal/davsync/stall_test.go | 123 +++++++++++++++++++++++++++++++++
 2 files changed, 146 insertions(+), 9 deletions(-)

diff --git a/internal/davsync/stall.go b/internal/davsync/stall.go
index ab84068d1..79bd16d81 100644
--- a/internal/davsync/stall.go
+++ b/internal/davsync/stall.go
@@ -11,12 +11,14 @@ import (
 )
 
 // A sync is never given a time to end in: a backup of tens of MB to a
-// server on a slow line takes minutes (#657, 43 MB at 305 KB/s). What ends
-// a request is a server that stops: the backup's GET and PUT (and S3's)
-// fail once nothing has moved, either way, for stallAfter — a body still
-// coming in or going out, however slowly, keeps them going. The other
-// requests (PROPFIND, MKCOL, MOVE, DELETE…) move a few KB at most and have
-// metaLimit in all.
+// server on a slow line takes minutes (#657, 43 MB at 305 KB/s), and one
+// part of a GitHub backup may take as long to go up (#4576, 16 MiB of file
+// as about 21 MB of base64 through a POST). What ends a request is a
+// server that stops: a GET or a PUT (S3's too, and GitHub's blob POSTs,
+// which haul those parts) fails once nothing has moved, either way, for
+// stallAfter — a body still coming in or going out, however slowly, keeps
+// it going. The other requests (PROPFIND, MKCOL, MOVE, DELETE…) move a
+// few KB at most and have metaLimit in all.
 var (
 	stallAfter = 60 * time.Second
 	metaLimit  = 30 * time.Second
@@ -39,12 +41,24 @@ func (e *errStalled) Error() string {
 // syncClient is the client WebDAV and S3 are reached with.
 var syncClient = &http.Client{Transport: stallTransport{http.DefaultTransport}}
 
-// stallTransport gives each request its watchdog: for a GET or a PUT one
-// put back each time bytes move, for the rest one that isn't.
+// bigBody says whether the request hauls a body that a live but slow line
+// may take longer than the whole metaLimit to send: GitHub's blob POSTs
+// carry up to 16 MiB of file, about 21 MB of base64, where a flat 30 s
+// needs 550 KB/s and a line under it never gets a part through (#4576),
+// while the metadata requests (PROPFIND's query, the GitHub tree, commit
+// and ref JSON) stay kilobytes small — a good way under the 64 KiB that
+// takes a line under 2 KB/s the whole limit to send.
+func bigBody(req *http.Request) bool {
+	return req.Body != nil && req.Body != http.NoBody && req.ContentLength >= 64<<10
+}
+
+// stallTransport gives each request its watchdog: for a GET, a PUT or a
+// request hauling a big body one put back each time bytes move, for the
+// rest one that isn't.
 type stallTransport struct{ base http.RoundTripper }
 
 func (t stallTransport) RoundTrip(req *http.Request) (*http.Response, error) {
-	moving := req.Method == http.MethodGet || req.Method == http.MethodPut
+	moving := req.Method == http.MethodGet || req.Method == http.MethodPut || bigBody(req)
 	after := metaLimit
 	if moving {
 		after = stallAfter
diff --git a/internal/davsync/stall_test.go b/internal/davsync/stall_test.go
index 7f262ed06..5542fb67a 100644
--- a/internal/davsync/stall_test.go
+++ b/internal/davsync/stall_test.go
@@ -3,12 +3,16 @@ package davsync
 import (
 	"bytes"
 	"context"
+	"encoding/base64"
+	"encoding/json"
 	"errors"
 	"io"
 	"net"
 	"net/http"
 	"net/http/httptest"
+	"net/url"
 	"strconv"
+	"strings"
 	"sync"
 	"testing"
 	"time"
@@ -254,3 +258,122 @@ func TestMetadataRequestHasALimit(t *testing.T) {
 		t.Fatalf("%v after %s, want the limit", err, time.Since(start))
 	}
 }
+
+// slowGitHub is the least of GitHub's API a commit talks to, so a blob POST
+// can be eaten as slowly as a live line: chunk bytes every gap. GitHub is
+// the one backend whose uploads ride a method the watchdog used to see as
+// metadata: its blob POSTs haul up to 16 MiB of file each, about 21 MB of
+// base64 (#4576).
+type slowGitHub struct {
+	chunk     int
+	gap       time.Duration
+	hangTrees bool // sit on the tree POST for good, as a server that stopped
+}
+
+func (h *slowGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	send := func(status int, v any) {
+		w.Header().Set("Content-Type", "application/json")
+		w.WriteHeader(status)
+		json.NewEncoder(w).Encode(v)
+	}
+	base := "/repos/alice/private"
+	switch {
+	case r.URL.Path == base:
+		send(http.StatusOK, map[string]any{"default_branch": "main", "private": true})
+	case strings.HasSuffix(r.URL.Path, "/git/ref/heads/main"):
+		send(http.StatusOK, map[string]any{"object": map[string]string{"type": "commit", "sha": "c1"}})
+	case strings.Contains(r.URL.Path, "/contents/"):
+		send(http.StatusNotFound, map[string]string{"message": "Not Found"})
+	case r.URL.Path == base+"/git/blobs" && r.Method == http.MethodPost:
+		var got bytes.Buffer
+		buf := make([]byte, max(h.chunk, 1))
+		for {
+			n, err := r.Body.Read(buf)
+			got.Write(buf[:n])
+			if err != nil {
+				break
+			}
+			time.Sleep(h.gap)
+		}
+		var in struct{ Content, Encoding string }
+		if json.Unmarshal(got.Bytes(), &in) != nil || in.Encoding != "base64" {
+			send(http.StatusUnprocessableEntity, map[string]string{"message": "Invalid blob"})
+			return
+		}
+		b, err := base64.StdEncoding.DecodeString(in.Content)
+		if err != nil {
+			send(http.StatusUnprocessableEntity, map[string]string{"message": "Invalid blob"})
+			return
+		}
+		send(http.StatusCreated, map[string]string{"sha": gitBlobSHA(b)})
+	case strings.Contains(r.URL.Path, "/git/commits/"):
+		send(http.StatusOK, map[string]any{"tree": map[string]string{"sha": "t1"}})
+	case r.URL.Path == base+"/git/trees" && r.Method == http.MethodPost:
+		if h.hangTrees {
+			// the body has to go for the server to see the client gone
+			io.Copy(io.Discard, r.Body)
+			select {
+			case <-time.After(5 * time.Second):
+			case <-r.Context().Done():
+			}
+			return
+		}
+		send(http.StatusOK, map[string]string{"sha": "t2"})
+	case r.URL.Path == base+"/git/commits" && r.Method == http.MethodPost:
+		send(http.StatusOK, map[string]string{"sha": "c2"})
+	case strings.HasSuffix(r.URL.Path, "/git/refs/heads/main") && r.Method == http.MethodPatch:
+		send(http.StatusOK, map[string]string{})
+	default:
+		send(http.StatusNotFound, map[string]string{"message": "Not Found"})
+	}
+}
+
+// githubOn wraps a test GitHub server the way the app reaches GitHub: the
+// API's host rewritten onto the test server, over the stall watchdog (and
+// the line's small buffers, as narrowLine holds them).
+func githubOn(t *testing.T, h http.Handler) *github {
+	t.Helper()
+	srv, client := narrowLine(t, h)
+	target, err := url.Parse(srv.URL)
+	if err != nil {
+		t.Fatal(err)
+	}
+	g, err := newGitHub(Config{URL: "github://alice/private/team", Password: "tok"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	g.client = &http.Client{Transport: githubTransport{client.Transport, target}}
+	return g
+}
+
+// A GitHub blob POST whose body goes up on a live but slow line is not cut
+// short: a flat 30 s killed the whole sync, for good, on any line that
+// couldn't push a 16 MiB part's 21 MB of base64 through it in half a
+// minute (#4576: the sync stopped at 10:30 and every attempt after died on
+// the same POST).
+func TestGitHubSlowBlobUploadIsNotCutShort(t *testing.T) {
+	shortStall(t, time.Second, 300*time.Millisecond)
+	h := &slowGitHub{chunk: 16 << 10, gap: 50 * time.Millisecond}
+	g := githubOn(t, h)
+	// 200 KB of file: about 272 KB of base64 body, ~0.9 s at the line's
+	// 320 KB/s, well over the whole metadata limit.
+	data := bytes.Repeat([]byte("magpie usage "), (200<<10)/13)
+	if _, err := g.put(context.Background(), data, ""); err != nil {
+		t.Fatalf("a slow but live blob POST: %v", err)
+	}
+}
+
+// A GitHub POST that hauls only a little (the tree, the commit, the ref —
+// kilobytes at most) keeps metaLimit in all, however long the server sits
+// on it: the big-body budget isn't a pass for every request.
+func TestGitHubSmallPostKeepsTheLimit(t *testing.T) {
+	shortStall(t, 300*time.Millisecond, 300*time.Millisecond)
+	g := githubOn(t, &slowGitHub{hangTrees: true})
+	start := time.Now()
+	_, err := g.put(context.Background(), []byte("sealed fixture"), "")
+	took := time.Since(start)
+	var st *errStalled
+	if !errors.As(err, &st) || st.idle || took > 3*time.Second {
+		t.Fatalf("%v after %s, want the metadata limit on a small POST", err, took)
+	}
+}
-- 
2.50.1 (Apple Git-155)

````

</details>

Branch with the commit: [hunt115-c3-4576](https://github.com/ggbdpq/magpie/tree/hunt115-c3-4576) (head `e97601d65ed6d49f061fed3171d72398b111a324`).
