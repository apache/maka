Following the reporter's verified chain, this patch keeps a weak ETag out of the saved version and out of every `If-Match`: a validator the write can never match reads as none, the write goes unconditioned once, and the next read past the mtime's second brings a strong one back — the sync recovers by itself instead of saying "the file on the server changed meanwhile" forever.

**Root cause:** Apache's `ap_make_etag` says a weak ETag (`W/"size-mtime"`) for a `GET` that lands in the same second as the file's mtime, uncompressed as magpie's read asks it — `versionOf` (`internal/davsync/dav.go`) saved any `ETag` verbatim, so the weak one entered `sync-state.json`, and `dav.put` sent it in `If-Match`, whose comparison RFC 9110 §13.1.1 makes strong: Apache answered `412` to every write over it, and the `errChanged` retry's `If-None-Match` — weak comparison — read `304`, keeping the same dead validator in the state for good. The `#1362` comment in `dav.go` already knew this face ("either never matches the file in an If-Match, so every write after such a read was refused") but only the compression half had a guard.

**The fix:** `versionOf` keeps no weak ETag — the same treatment its `Last-Modified` half already got for the same-second window — and a new `strongOf` guards `dav.put`'s own three `ETag` reads (the `If-Match` it is asked to write over, the re-match headers of a short-write retry, and the version a successful `PUT` answers), so a weak validator from any of them reads as none. The S3 writer shares the family: its `If-Match` and its answered version go through `strongOf` too, and its reads already go through `versionOf`.

The reporter's second suggestion (clearing `st.Server` before the `errChanged` retry) is not taken: with no weak ETag able to reach the cache or a header, the retry's `If-None-Match` is strong, and a `304` under it means the file really is the one cached — a fresh unconditional `GET` would return the same version. The chain the suggestion was for is gone at its root.

**Source:** reported in #7218 with the code-level chain (`versionOf`, `dav.put`, the `errChanged` retry), RFC references, and dual-OS reproductions against Synology DSM WebDAV (Apache `mod_dav`); the new end-to-end test replays that chain against a fake that answers like Apache does.

**Red without the fix:** `TestSyncSurvivesAWeakETag` (new) — `the sync after the weak ETag: the file on the server changed meanwhile`, the exact text the reporter saw. `TestVersionOfKeepsNoWeakETag` (new) pins the version half: `a weak ETag was kept: "W/\"17-1767225600\""`.

**Siblings:** `s3.go`'s writer had the same shape (an `If-Match` and an answered `version` with no weak check) and is fixed with the same `strongOf`; its reads share `versionOf`. `123pan`'s HEAD-based flow and the `NoCondRead` servers (#4993) never send `If-Match`, so nothing to guard there. The `conditions()` sender reads only what the version kept, which holds no weak ETag now.

| Check | Result |
| --- | --- |
| `TestSyncSurvivesAWeakETag` | Green at final head; without the fix: `the sync after the weak ETag: the file on the server changed meanwhile` |
| `TestVersionOfKeepsNoWeakETag` | Green; without the fix: `a weak ETag was kept: "W/…"` |
| Ablation (`versionOf` guard, `If-Match` guard, answered-version guard reverted together) | Same end-to-end failure; restored, green |
| `go test -tags nogui -timeout=45m -count=1 ./internal/davsync/` | Pass (49.2s), `TestSyncUnchangedIsNotRead` and the WebDAV/S3 family included |
| Targeted `-race` (`TestSync`, `TestVersionOf`, `TestS3`) | Pass |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet` darwin; `GOOS=linux go vet -tags nogui`; `GOOS=windows go vet` | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Actual rebase onto `b17d9e3fc` | Clean; `git range-diff` `=` (no drift) |
| Strict `git am` on `b17d9e3fc` | Applies cleanly; resulting tree equals final head; author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** against a real Synology DSM server — the fake answers the way the reporter's captures say Apache does (weak ETag on the same-second read, strong-comparison `If-Match`, weak-comparison `If-None-Match`); the reporter's own dual-OS reproduction stands in for the live server.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7218-weak-etag-guard](https://github.com/ggbdpq/magpie/tree/fix/7218-weak-etag-guard), head `b1b0ec55bd25790480c89cca34aa0fd60e5997dc`.

<details><summary>patch: davsync: a weak ETag is no version to write over (#7218) — git am applies it as is; SHA-256 first 16: f93993fe9f339240</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 20 Nov 2026 00:23:18 +0800
Subject: [PATCH] davsync: a weak ETag is no version to write over (#7218)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: Apache's ap_make_etag says a weak ETag (W/"…") for a read
that lands in the same second as the file's mtime, uncompressed as the
read asks it (#1362). A weak one never matches an If-Match — RFC 9110
§13.1.1 is strong comparison — so the write over it was refused 412 for
good, and the retry's If-None-Match, which compares weakly, read 304 and
kept the same dead validator in the state: every later sync said "the
file on the server changed meanwhile" until another computer overwrote
the file or the server version was cleared by hand. versionOf keeps no
weak ETag now (as it already kept no Last-Modified from the same second),
and dav.put matches, re-matches and answers only with a strong one — a
weak validator reads as none, the write goes unconditioned once, and the
next read past the mtime's second brings a strong one back.

Run: TestSyncSurvivesAWeakETag (new) fails without the fix (the sync
after the weak ETag: the file on the server changed meanwhile) and
passes with it, no weak validator sent; TestVersionOfKeepsNoWeakETag
(new) pins the version half. TestSyncUnchangedIsNotRead and the family
pass unchanged. See the issue post for the matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/davsync/dav.go            | 28 +++++++++---
 internal/davsync/davsync_test.go   | 32 ++++++++++---
 internal/davsync/s3.go             |  4 +-
 internal/davsync/weak_etag_test.go | 73 ++++++++++++++++++++++++++++++
 4 files changed, 123 insertions(+), 14 deletions(-)
 create mode 100644 internal/davsync/weak_etag_test.go

diff --git a/internal/davsync/dav.go b/internal/davsync/dav.go
index a6df9fa3a..d1e9eb320 100644
--- a/internal/davsync/dav.go
+++ b/internal/davsync/dav.go
@@ -66,10 +66,26 @@ func (v version) conditions() map[string]string {
 	return nil
 }
 
+// strongOf is an ETag fit for an If-Match: a weak one (W/"…") never
+// matches it, so it reads as none and the write goes unconditioned once,
+// the next read past the mtime's second bringing a strong one back
+// (#7218).
+func strongOf(e string) string {
+	if strings.HasPrefix(e, "W/") {
+		return ""
+	}
+	return e
+}
+
 // versionOf is the version an answer's headers tell; none when they tell
-// nothing that can be asked about again.
+// nothing that can be asked about again. A weak ETag is none: it never
+// matches an If-Match (RFC 9110 §13.1.1 is strong comparison), so a write
+// over it was refused 412 for good, and the retry's If-None-Match, which
+// compares weakly, read 304 and kept the same dead validator in the state
+// forever — Apache's ap_make_etag says W/"…" for a read in the same
+// second as the file's mtime, uncompressed as this asks it (#1362, #7218).
 func versionOf(h http.Header) version {
-	if e := h.Get("ETag"); e != "" {
+	if e := strongOf(h.Get("ETag")); e != "" {
 		return version{ETag: e}
 	}
 	lm := h.Get("Last-Modified")
@@ -364,7 +380,7 @@ func (d *dav) get(ctx context.Context, have version) (data []byte, v version, er
 // compared; a short write is tried again and told as itself in the end.
 func (d *dav) put(ctx context.Context, data []byte, etag string) (version, error) {
 	h := map[string]string{"Content-Type": "application/octet-stream"}
-	if etag != "" {
+	if etag = strongOf(etag); etag != "" {
 		h["If-Match"] = etag
 	}
 	for try, writes := 0, 0; ; try++ {
@@ -383,9 +399,9 @@ func (d *dav) put(ctx context.Context, data []byte, etag string) (version, error
 					// it — the ETag the PUT answered, else the one the
 					// check read; with neither, the old one goes, for it
 					// can't hold any more
-					if e := res.Header.Get("ETag"); e != "" {
+					if e := strongOf(res.Header.Get("ETag")); e != "" {
 						h["If-Match"] = e
-					} else if he != "" {
+					} else if he = strongOf(he); he != "" {
 						h["If-Match"] = he
 					} else {
 						delete(h, "If-Match")
@@ -398,7 +414,7 @@ func (d *dav) put(ctx context.Context, data []byte, etag string) (version, error
 			// next sync reads the file in full, as before. noCondRead
 			// rides along: it is the server's, not the version's, and the
 			// write's version is the one the next sync reads with
-			return version{ETag: res.Header.Get("ETag"), NoCondRead: d.noCondRead}, nil
+			return version{ETag: strongOf(res.Header.Get("ETag")), NoCondRead: d.noCondRead}, nil
 		case res.StatusCode == http.StatusPreconditionFailed:
 			return version{}, errChanged
 		case res.StatusCode == http.StatusForbidden && (try > 0 || d.there(ctx, d.url(folder)+"/")):
diff --git a/internal/davsync/davsync_test.go b/internal/davsync/davsync_test.go
index df1a0b22d..f7c890107 100644
--- a/internal/davsync/davsync_test.go
+++ b/internal/davsync/davsync_test.go
@@ -45,8 +45,14 @@ type fakeDAV struct {
 	tooMany                     bool
 	retryAfter                  string
 	mtimes                      map[string]time.Time
-	// gets are the reads, full those answered with the file, of bytes
-	// bytes in all, and notModified those answered 304
+	// weak: an Apache mod_dav whose GET lands in the same second as the
+	// file's mtime — its ETag is weak (W/"…"), its If-None-Match compares
+	// weakly, and its If-Match never matches a weak one (RFC 9110
+	// §13.1.1): the validator a weak read leaves can never write again
+	// (#7218). weakIfMatch and weakIfNoneMatch count the weak validators
+	// a request sent, for the test to say none did.
+	weak                           bool
+	weakIfMatch, weakIfNoneMatch   int
 	gets, full, bytes, notModified int
 }
 
@@ -85,8 +91,15 @@ func (f *fakeDAV) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 				return
 			}
 		} else {
-			w.Header().Set("ETag", f.etags[r.URL.Path])
-			if f.cond && r.Header.Get("If-None-Match") == f.etags[r.URL.Path] {
+			etag := f.etags[r.URL.Path]
+			if f.weak {
+				etag = `W/` + etag
+			}
+			w.Header().Set("ETag", etag)
+			if f.cond && (r.Header.Get("If-None-Match") == etag || f.weak && r.Header.Get("If-None-Match") == f.etags[r.URL.Path]) {
+				if f.weak && strings.HasPrefix(r.Header.Get("If-None-Match"), "W/") {
+					f.weakIfNoneMatch++
+				}
 				f.notModified++
 				w.WriteHeader(http.StatusNotModified)
 				return
@@ -100,7 +113,10 @@ func (f *fakeDAV) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 			w.WriteHeader(http.StatusConflict)
 			return
 		}
-		if m := r.Header.Get("If-Match"); m != "" && m != f.etags[r.URL.Path] {
+		if m := r.Header.Get("If-Match"); m != "" && (f.weak && strings.HasPrefix(m, "W/") || m != f.etags[r.URL.Path]) {
+			if f.weak && strings.HasPrefix(m, "W/") {
+				f.weakIfMatch++
+			}
 			w.WriteHeader(http.StatusPreconditionFailed)
 			return
 		}
@@ -114,7 +130,11 @@ func (f *fakeDAV) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 		// long before now, and a second later for each write
 		f.mtimes[r.URL.Path] = time.Date(2026, 1, 1, 0, 0, f.n, 0, time.UTC)
 		if f.putETag && !f.lastModified {
-			w.Header().Set("ETag", f.etags[r.URL.Path])
+			e := f.etags[r.URL.Path]
+			if f.weak {
+				e = `W/` + e
+			}
+			w.Header().Set("ETag", e)
 		}
 		w.WriteHeader(http.StatusCreated)
 	case "MKCOL":
diff --git a/internal/davsync/s3.go b/internal/davsync/s3.go
index 6ed961f30..8e0c1cdd6 100644
--- a/internal/davsync/s3.go
+++ b/internal/davsync/s3.go
@@ -254,7 +254,7 @@ func (s *s3) put(ctx context.Context, data []byte, etag string) (version, error)
 	where := s.endpoint.String() + " " + s.bucket
 	if _, no := unconditional.Load(where); !no {
 		h := map[string]string{"Content-Type": "application/octet-stream"}
-		if etag != "" {
+		if etag = strongOf(etag); etag != "" {
 			h["If-Match"] = etag
 		} else {
 			h["If-None-Match"] = "*"
@@ -265,7 +265,7 @@ func (s *s3) put(ctx context.Context, data []byte, etag string) (version, error)
 		}
 		defer res.Body.Close()
 		if res.StatusCode >= 200 && res.StatusCode < 300 {
-			return version{ETag: res.Header.Get("ETag")}, nil
+			return version{ETag: strongOf(res.Header.Get("ETag"))}, nil
 		}
 		e := readError(res)
 		switch {
diff --git a/internal/davsync/weak_etag_test.go b/internal/davsync/weak_etag_test.go
new file mode 100644
index 000000000..d4e35f1fa
--- /dev/null
+++ b/internal/davsync/weak_etag_test.go
@@ -0,0 +1,73 @@
+package davsync
+
+import (
+	"context"
+	"net/http"
+	"net/http/httptest"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// Apache's ap_make_etag makes a weak ETag (W/"…") for a GET that lands in
+// the same second as the file's mtime — even uncompressed (#1362 asked
+// identity for the compression face). A weak ETag never matches an
+// If-Match (RFC 9110 §13.1.1 is strong comparison), so a write that went
+// over it was refused 412 for good, and the retry after it read 304 under
+// the weak comparison If-None-Match uses, keeping the same dead validator
+// in the state forever: every later sync said "the file on the server
+// changed meanwhile" until another computer overwrote the file or the
+// server version was cleared by hand (Synology DSM WebDAV, #7218). A weak
+// ETag is kept out of the version whole — the write then goes
+// unconditioned once, and the next read past the mtime's second brings a
+// strong one back.
+func TestSyncSurvivesAWeakETag(t *testing.T) {
+	fake := &fakeDAV{files: map[string][]byte{}, etags: map[string]string{}, dirs: map[string]bool{"/dav": true},
+		cond: true, putETag: true, weak: true}
+	srv := httptest.NewServer(fake)
+	defer srv.Close()
+	ctx := context.Background()
+	a := newComputer(t)
+	a.use(t)
+	if err := Configure(Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "correct horse", Keys: true, Agents: true}); err != nil {
+		t.Fatal(err)
+	}
+	if err := Now(ctx); err != nil {
+		t.Fatal(err)
+	}
+	// the weak ETag the first read saw is in the state now; a change here
+	// writes over it
+	if err := provider.Save(provider.Provider{ID: "one", Name: "One", Chat: "https://api.one.example/v1", Key: "k1"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := Now(ctx); err != nil {
+		t.Fatalf("the sync after the weak ETag: %v", err)
+	}
+	if err := provider.Save(provider.Provider{ID: "two", Name: "Two", Chat: "https://api.two.example/v1", Key: "k2"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := Now(ctx); err != nil {
+		t.Fatalf("the sync after it: %v", err)
+	}
+	if st := Status(); st.Error != "" {
+		t.Fatalf("the sync stayed broken: %q", st.Error)
+	}
+	if n := fake.weakIfMatch + fake.weakIfNoneMatch; n > 0 {
+		t.Fatalf("a weak ETag went out in a validator %d times", n)
+	}
+}
+
+// versionOf keeps no weak ETag, whatever the server's other headers say:
+// an ETag the write can't match is none at all.
+func TestVersionOfKeepsNoWeakETag(t *testing.T) {
+	h := http.Header{}
+	h.Set("ETag", `W/"17-1767225600"`)
+	if v := versionOf(h); v.ETag != "" {
+		t.Fatalf("a weak ETag was kept: %q", v.ETag)
+	}
+	h.Set("Last-Modified", "Wed, 01 Jan 2025 00:00:02 GMT")
+	h.Set("Date", "Wed, 01 Jan 2025 00:00:03 GMT")
+	if v := versionOf(h); v.Modified == "" {
+		t.Fatal("without the ETag, the Last-Modified was not kept")
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

