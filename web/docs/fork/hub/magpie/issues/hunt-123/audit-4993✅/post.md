A fix for this, with a test: **`davsync: a server that breaks on a conditional read is read without one (123pan, #4993)`** — head [`68e57a485`](https://github.com/ggbdpq/magpie/commit/68e57a485b87ff8b5220e5acb86d3d3443755314), branch [`fix/4993-webdav-conditional-get`](https://github.com/ggbdpq/magpie/tree/fix/4993-webdav-conditional-get).

## What broke

A sync after the first reads `magpie/magpie.magpie-backup` with the version last seen — `If-None-Match: <etag>` (`internal/davsync/dav.go`, `dav.get`), so a file unchanged is answered 304 and costs a request, not a download. 123pan answers that GET `HTTP 500` instead (the reporter's curl: a plain GET 200 with the file, a HEAD 200 with a valid ETag, a GET with `If-None-Match` 500 about half a minute later), and `dav.get` failed every answer that wasn't 200/304/403/404/409. Since the ETag is kept in the sync state, every sync after went out with the condition again, 500 again — the sync never came back on its own. The same read without the conditions works, so the server breaks on the condition, not the read.

## The fix

- A conditional read answered 5xx (429/503 are already the rate-limit path) is asked **again without the conditions**: the file comes whole, as it always did on a server without them, and the sync goes on.
- The version it comes back with is marked `NoCondRead`, kept in the sync state, so no read of that server is sent with a condition again — one wasted round-trip, not one every sync.
- The ETag stays: the write still goes over it with `If-Match`, so the check that keeps another computer's write from being gone over is kept, as the issue asks. The marking rides on the version a write leaves, too, so a sync that writes doesn't ask with a condition once more.
- Writes are untouched: `If-Match` is the concurrent-write protection, and 123pan's behaviour on a conditional PUT isn't in the report — a write it refused would say `writing … HTTP 500`, its own case.

<details>
<summary>Patch, <code>git am</code> ready (<code>68e57a485</code>) — SHA-256 first 16: <code>d587320e4f94d9bd</code></summary>

```patch
From 68e57a485b87ff8b5220e5acb86d3d3443755314 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 02:36:51 +0800
Subject: [PATCH] davsync: a server that breaks on a conditional read is read
 without one (123pan, #4993)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A sync after the first reads the backup with the version last seen —
If-None-Match, or If-Modified-Since on a server without ETags — and a
server that says 304 for a file unchanged is spared the download. 123pan
answers that GET 500 instead (the reporter's curl, 2026-11-03: a plain
GET answers 200 with the file, a HEAD answers 200 with a valid ETag, a
GET with If-None-Match answers 500 half a minute later), and the read
failed on every sync after: the ETag is kept in the sync state, so the
next read went out with the condition again, and 500 again.

A conditional read answered 5xx is asked again without the conditions,
and the version it comes back with is marked NoCondRead, so no read of
that server is sent with a condition again — the file comes whole, as it
always did on a server without them, and the ETag stays, for the write
to go over: the check that keeps another computer's write from being
gone over is kept. The marking rides on the version the write leaves
too, so a sync that writes doesn't ask with a condition once more.

TestDAV123panConditionalRead and TestSync123panConditionalRead are new;
a failed read without conditions is failed as before.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/davsync/123pan_test.go | 194 ++++++++++++++++++++++++++++++++
 internal/davsync/dav.go         |  40 ++++++-
 2 files changed, 232 insertions(+), 2 deletions(-)
 create mode 100644 internal/davsync/123pan_test.go

diff --git a/internal/davsync/123pan_test.go b/internal/davsync/123pan_test.go
new file mode 100644
index 000000000..b3cfcbffd
--- /dev/null
+++ b/internal/davsync/123pan_test.go
@@ -0,0 +1,194 @@
+package davsync
+
+import (
+	"context"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"slices"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// pan123DAV answers as 123pan's WebDAV plausibly does (#4993). The
+// reporter saw, with curl (2026-11-03): a plain GET of the file answers
+// 200 with its 1,910,440 bytes, a HEAD answers 200 with a valid ETag, and
+// a GET sent with If-None-Match — the ETag the HEAD said — answers HTTP
+// 500, about half a minute later. 304 never comes: the conditions aren't
+// understood, they break the read. Writes weren't seen (the read fails
+// first), so If-Match is taken to work.
+type pan123DAV struct {
+	mu    sync.Mutex
+	files map[string][]byte
+	etags map[string]string
+	dirs  map[string]bool
+	n     int
+	// condGets are the GETs that came with a condition, plainGets those
+	// that came without; puts the writes
+	condGets, plainGets, puts int
+}
+
+func newPan123DAV() *pan123DAV {
+	return &pan123DAV{files: map[string][]byte{}, etags: map[string]string{}, dirs: map[string]bool{"/dav": true}}
+}
+
+func (p *pan123DAV) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	p.mu.Lock()
+	defer p.mu.Unlock()
+	if u, pw, ok := r.BasicAuth(); !ok || u != "me" || pw != "pw" {
+		w.WriteHeader(http.StatusUnauthorized)
+		return
+	}
+	switch r.Method {
+	case http.MethodGet:
+		if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
+			p.condGets++
+			w.WriteHeader(http.StatusInternalServerError)
+			return
+		}
+		p.plainGets++
+		b, ok := p.files[r.URL.Path]
+		if !ok {
+			w.WriteHeader(http.StatusNotFound)
+			return
+		}
+		w.Header().Set("ETag", p.etags[r.URL.Path])
+		w.Write(b)
+	case http.MethodPut:
+		if !p.dirs[urlDir(r.URL.Path)] {
+			w.WriteHeader(http.StatusConflict)
+			return
+		}
+		b, _ := io.ReadAll(r.Body)
+		p.puts++
+		p.n++
+		p.files[r.URL.Path], p.etags[r.URL.Path] = b, `"`+strings.Repeat("e", p.n)+`"`
+		w.Header().Set("ETag", p.etags[r.URL.Path])
+		w.WriteHeader(http.StatusCreated)
+	case "MKCOL":
+		dir := strings.TrimSuffix(r.URL.Path, "/")
+		if p.dirs[dir] {
+			w.WriteHeader(http.StatusMethodNotAllowed)
+			return
+		}
+		p.dirs[dir] = true
+		w.WriteHeader(http.StatusCreated)
+	default:
+		w.WriteHeader(http.StatusMethodNotAllowed)
+	}
+}
+
+// A read sent with the version last seen is answered 500 by 123pan, not
+// 304: the read is asked again without the conditions, and the version is
+// marked so no condition is sent to that server again — the ETag stays,
+// for the write to go over (#4993).
+func TestDAV123panConditionalRead(t *testing.T) {
+	fake := newPan123DAV()
+	srv := httptest.NewServer(fake)
+	defer srv.Close()
+	d, err := newDAV(Config{URL: srv.URL + "/dav/", User: "me", Password: "pw"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	ctx := context.Background()
+	if _, err := d.put(ctx, []byte("v1"), ""); err != nil {
+		t.Fatal(err)
+	}
+	etag := fake.etags["/dav/magpie/magpie.magpie-backup"]
+
+	// the read with the version last seen: answered 500, asked again
+	// without the conditions, and said so in the version it gives back
+	data, v, err := d.get(ctx, version{ETag: etag})
+	if err != nil {
+		t.Fatalf("a read 123pan answers 500: %v", err)
+	}
+	if string(data) != "v1" {
+		t.Fatalf("read %q, want v1", data)
+	}
+	if !v.NoCondRead || v.ETag != etag {
+		t.Fatalf("version %+v, want the ETag kept and no conditional reads from here on", v)
+	}
+	if fake.condGets != 1 || fake.plainGets != 1 {
+		t.Fatalf("%d conditional GETs, %d plain: want one of each — the 500, then the read without the conditions", fake.condGets, fake.plainGets)
+	}
+
+	// the version marked: no condition is sent again
+	fake.condGets, fake.plainGets = 0, 0
+	if _, _, err := d.get(ctx, v); err != nil {
+		t.Fatal(err)
+	}
+	if fake.condGets != 0 || fake.plainGets != 1 {
+		t.Fatalf("%d conditional GETs, %d plain after the marking: want no conditions sent", fake.condGets, fake.plainGets)
+	}
+
+	// the write after the read goes over the ETag, and the version it
+	// leaves keeps the marking
+	v2, err := d.put(ctx, []byte("v2"), v.ETag)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !v2.NoCondRead {
+		t.Fatal("the version after the write lost the marking: the next sync would ask with the conditions again")
+	}
+}
+
+// 123pan breaks a sync that reads with the version last seen: the first
+// sync reads the file and writes, and every sync after reads with
+// If-None-Match, is answered 500, and fails. The read is asked again
+// without the conditions, once, and the syncs go through (#4993).
+func TestSync123panConditionalRead(t *testing.T) {
+	fake := newPan123DAV()
+	srv := httptest.NewServer(fake)
+	defer srv.Close()
+	ctx := context.Background()
+	a := newComputer(t)
+	a.use(t)
+	provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k1"})
+	if err := Configure(Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "correct horse", Keys: true}); err != nil {
+		t.Fatal(err)
+	}
+	if err := Now(ctx); err != nil {
+		t.Fatal(err)
+	}
+
+	// the first sync read without the conditions; the next reads with the
+	// ETag, is answered 500, and asks again without them
+	if err := Now(ctx); err != nil {
+		t.Fatalf("the sync after the first: %v", err)
+	}
+	if fake.condGets != 1 {
+		t.Fatalf("%d conditional GETs after the second sync, want 1: the one answered 500", fake.condGets)
+	}
+
+	// from here the conditions are not sent: the sync reads plainly
+	condGets, plainGets := fake.condGets, fake.plainGets
+	if err := Now(ctx); err != nil {
+		t.Fatal(err)
+	}
+	if fake.condGets != condGets || fake.plainGets != plainGets+1 {
+		t.Fatalf("%d conditional GETs, %d plain after the third sync: want the conditions gone for good", fake.condGets, fake.plainGets)
+	}
+
+	// changed here, the merge still goes up, over the ETag
+	provider.Save(provider.Provider{ID: "kimi", Name: "Kimi", Chat: "https://api.moonshot.cn/v1", Key: "k2"})
+	if err := Now(ctx); err != nil {
+		t.Fatal(err)
+	}
+	if fake.puts != 2 {
+		t.Fatalf("%d writes, want 2: the first sync's and the merged one", fake.puts)
+	}
+	b := newComputer(t)
+	b.use(t)
+	if err := Configure(Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "correct horse", Keys: true}); err != nil {
+		t.Fatal(err)
+	}
+	if err := Now(ctx); err != nil {
+		t.Fatal(err)
+	}
+	if got := ids(); !slices.Equal(got, []string{"deepseek=k1", "kimi=k2"}) {
+		t.Fatalf("b after joining: %v", got)
+	}
+}
diff --git a/internal/davsync/dav.go b/internal/davsync/dav.go
index 5ab0c4601..424bed8f4 100644
--- a/internal/davsync/dav.go
+++ b/internal/davsync/dav.go
@@ -43,10 +43,20 @@ type version struct {
 	// refused): another computer's write in the moment between may have
 	// gone over it (#1776)
 	Blind bool `json:"-"`
+	// NoCondRead: the server breaks on conditional reads — 123pan answers
+	// a GET sent with If-None-Match 500 (#4993) — so no read asks it with
+	// one again; the ETag stays, for the write to go over
+	NoCondRead bool `json:"noCondRead,omitempty"`
 }
 
 // conditions are the headers that ask for the file only when it isn't v.
+// None for a server that breaks on conditional reads: it was asked with
+// one once and said 500 (123pan, #4993), so it never is again — the ETag
+// stays, for the write to go over.
 func (v version) conditions() map[string]string {
+	if v.NoCondRead {
+		return nil
+	}
 	switch {
 	case v.ETag != "":
 		return map[string]string{"If-None-Match": v.ETag}
@@ -139,6 +149,10 @@ type dav struct {
 	base       *url.URL
 	user, pass string
 	client     *http.Client
+	// noCondRead: this server was asked with a condition once and broke
+	// on it (#4993), so no read of it is sent with one again, this run —
+	// and the version says so, for the runs after
+	noCondRead bool
 }
 
 func newDAV(c Config) (*dav, error) {
@@ -269,6 +283,9 @@ func (d *dav) there(ctx context.Context, u string) bool {
 // W/"…"; either never matches the file in an If-Match, so every write after
 // such a read was refused as changed meanwhile (#1362).
 func (d *dav) get(ctx context.Context, have version) (data []byte, v version, err error) {
+	if have.NoCondRead {
+		d.noCondRead = true
+	}
 	cond := have.conditions()
 	h := map[string]string{"Accept-Encoding": "identity"}
 	for k, v := range cond {
@@ -278,6 +295,23 @@ func (d *dav) get(ctx context.Context, have version) (data []byte, v version, er
 	if err != nil {
 		return nil, version{}, err
 	}
+	// A server that breaks on a conditional read — 123pan answers a GET
+	// sent with If-None-Match 500, half a minute later, where a file
+	// unchanged was to be answered 304 (#4993) — is asked again without
+	// the conditions: the file comes as it always did, costing a
+	// download, and the version is marked, so no read of this server is
+	// sent with a condition again. A read without conditions that fails
+	// all the same is a server trouble of its own, said as it is.
+	if cond != nil && res.StatusCode >= 500 {
+		res.Body.Close()
+		d.noCondRead = true
+		data, v, err = d.get(ctx, version{ETag: have.ETag, Modified: have.Modified, NoCondRead: true})
+		if err != nil {
+			return nil, version{}, err
+		}
+		v.NoCondRead = true
+		return data, v, nil
+	}
 	defer res.Body.Close()
 	if res.StatusCode == http.StatusNotModified && cond != nil {
 		return nil, have, errNotModified
@@ -359,8 +393,10 @@ func (d *dav) put(ctx context.Context, data []byte, etag string) (version, error
 				return version{}, cerr
 			}
 			// an ETag said here is the version written; with none, the
-			// next sync reads the file in full, as before
-			return version{ETag: res.Header.Get("ETag")}, nil
+			// next sync reads the file in full, as before. noCondRead
+			// rides along: it is the server's, not the version's, and the
+			// write's version is the one the next sync reads with
+			return version{ETag: res.Header.Get("ETag"), NoCondRead: d.noCondRead}, nil
 		case res.StatusCode == http.StatusPreconditionFailed:
 			return version{}, errChanged
 		case res.StatusCode == http.StatusForbidden && (try > 0 || d.there(ctx, d.url(folder)+"/")):
-- 
2.50.1 (Apple Git-155)

```

</details>

## Verification

| Check | Result |
| --- | --- |
| New `TestDAV123panConditionalRead` / `TestSync123panConditionalRead`, fix reverted (ablation) | red — the read fails `reading magpie.magpie-backup from the WebDAV server: HTTP 500`, the reporter's message |
| The two with the fix | green — the read is asked again without the conditions, and the syncs after send no condition |
| `go test -tags nogui ./internal/davsync/` | ok (35s) |
| The two under `-race` | ok |
| `go test -tags nogui ./internal/cli/` | one fail, `TestEveryRouteHasACommandOrIsNamed` — fails on `upstream/main` too (known pre-existing) |
| `gofmt -l internal/davsync/`, `go vet ./internal/davsync/ ./internal/cli/ ./internal/gui/`, `go build ./...` | clean (vet's two cgo warnings in `internal/gui` are pre-existing) |

Ablation: `dav.go` reverted to the base (`7785c4278`) with the test kept — build failed on the marking the test reads, and with the fix back the suite is green.

Conditions elsewhere are left alone on purpose: `s3.go` (a signed S3 request, its own HEAD-then-PUT design), `library/skillcheck.go` and the GitHub backend (the GitHub API honours the conditions), `gui/web.go` (magpie is the server there). `If-Modified-Since` is covered by the same fallback, since the retry carries no condition at all.

AI use: written by GLM-5.3-Flash (ZCode) under my direction; author `ggbdpq`.
