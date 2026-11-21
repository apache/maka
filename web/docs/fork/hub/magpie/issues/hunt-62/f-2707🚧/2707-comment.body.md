All three points from your review are in. The branch is rebased onto current main `87d703c5` and force-pushed as the new head; one commit, patch attached below.

> 1. Write v2 only when the v1 seal would be large (for example near the GitHub limit), so most users stay readable by older versions.
> 2. Return a non-`ErrCorrupt` error when decompression fails, and read the decompressed data through a size-capped reader.
> 3. Word the docs and messages so they don't promise that every library fits GitHub.

**1. v2 only when the v1 seal would be large.** `Seal` now writes the plain version 1 an older magpie opens, and re-seals compressed as version 2 only when that v1 file would run past `sealLarge` = 50 MiB — under the 54.7 MiB your report saw refused, with margin. The v2 path takes a fresh nonce, and salt and iterations don't change between the two envelopes, so the key is still derived once per run (`TestSealDerivesOnce` passes untouched); the extra cost on a large library is one more `MarshalIndent` and one GCM seal. Tests: `TestSealStaysVersion1WhenSmall` (new: a small backup seals as version 1 and opens as itself), and `TestSealCompressesTheLibrary` now also asserts the 32 MiB library seals as version 2.

**2. Plain error + size-capped reader.** A version 2 bundle that won't decompress comes back as a plain error ("the sealed bundle doesn't decompress: …"), wrapping only the underlying gzip error, never `ErrCorrupt` — so `described`/`whatIs` no longer dress it as a cut backup with `Replace: true`, and a sync stops instead of offering Upload over the file. `unzipped` reads through `io.LimitReader` at `maxPlain` = 256 MiB, far above any bundle magpie writes, and refuses anything beyond. Tests: `TestOpenDecompressFailureIsPlain` (a GCM-authenticated non-gzip v2 bundle: the error is neither `ErrCorrupt` nor `ErrPassphrase`), `TestOpenCapsTheDecompression` (a GCM-authenticated 300 MiB gzip bomb: the cap refusal, not `ErrCorrupt`).

**3. Wording.** `docs/subsystems/sync-backup.md` (the sealing bullet and the GitHub-limit bullet), the `Seal` and `envelope` comments, and `internal/library/carry.go` now say compression is *expected* to keep a capped library within what GitHub takes, but GitHub's real limit is undocumented and a library of mostly incompressible files may still not fit. The too-large refusal already named the size and the backends a backup that big fits, so it stayed as it was.

On `internal/library`: the suite passes here (64 s), including `TestSyncGivesAnInstalledSelfServerItsTimeout`, before and after this rework — matching your own read that the one timeout under load was load, not the change; the commit only touches a comment in that package.

| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 ./internal/backup` | ok (7.5 s), incl. the three new tests above |
| `go test -tags nogui -count=1 ./internal/davsync` | ok (30.7 s), incl. `TestGitHubFailures/file_too_large_for_GitHub's_API` |
| `go test -tags nogui -count=1 ./internal/library` | ok (63.9 s) |
| `go test -tags nogui -count=1 ./internal/cli` | ok (29.2 s) |
| `gofmt -l` (backup, davsync, library) | clean |
| `go vet -tags nogui`, darwin/arm64 + linux/amd64 + windows/amd64 | clean |
| `go build` (main), darwin/arm64 + linux/amd64 + windows/amd64 | ok |
| Ablation: `sealLarge` forced to 0 (always v2), tests kept | `TestSealStaysVersion1WhenSmall` red; restored, green |
| Ablation: the `ErrCorrupt` wrap and uncapped reader restored, tests kept | `TestOpenDecompressFailureIsPlain` + `TestOpenCapsTheDecompression` red; restored, green |

**Not verified**: nothing is uploaded to the real GitHub API — sizes are asserted against the 54.7 MiB the report observed being refused, and GitHub's real limit is undocumented, so "fits" stays an expectation, not a measurement; the compression ratio on the reporter's real library isn't measured; GUI export/import wasn't opened by hand (it goes through the same `Seal`/`Open` the package suites cover).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: backup, davsync: a backup that would be too big for GitHub seals compressed (#2707) — git am applies it as is; SHA-256 first 16: 78dc37c991ae8512</summary>

```patch
From f698e15a820117bc1d52cfd64c5d5d0b27eb6c45 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 21:38:41 +0800
Subject: [PATCH] backup, davsync: a backup that would be too big for GitHub
 seals compressed (#2707)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

GitHub's file API refused the reporter's 54.7 MiB sealed backup as too
large (HTTP 422) while magpie's own guard allows 64 MiB, so a populated
library could not sync to GitHub at all: the sealed file carries the
bundle base64-encoded twice (the bundle's JSON, then the envelope's),
which alone takes 32 MiB of carried skill files to about 57 MiB.

What changed:
- Seal writes a backup that seals small as the plain version 1 an older
  magpie opens — most. One whose plain seal would run past what GitHub's
  file API was seen taking (50 MiB, under the 54.7 MiB refusal; the real
  limit is undocumented) is compressed and written as version 2, which an
  older magpie refuses with its newer-magpie message: update before
  syncing with it. The skill-files cap's size arithmetic
  (internal/library/carry.go) follows.
- A version 2 bundle that won't decompress comes back as a plain error,
  never ErrCorrupt: GCM has already authenticated the bytes, so it is not
  a cut write a sync rebuilds over, and described/whatIs no longer offer
  Upload over the file. The decompressed bundle is read through a 256 MiB
  cap, so a gzip bomb is refused instead of read into memory.
- A write GitHub refuses as too large names the file's size and the
  backends a backup that big fits, instead of the bare 422's words
  (internal/davsync/github.go, the 422 branch in commit).
- Docs and comments stop promising that every library fits GitHub:
  compression is expected to keep a capped library within what GitHub
  takes, but the real limit is undocumented and a library of mostly
  incompressible files may still not fit. docs/subsystems/sync-backup.md
  says both.

Run: base 87d703c5 (current main), head this commit. go test -tags nogui
-count=1 green: ./internal/backup (incl. TestSealStaysVersion1WhenSmall,
TestOpenDecompressFailureIsPlain, TestOpenCapsTheDecompression and
TestSealCompressesTheLibrary), ./internal/davsync (incl.
TestGitHubFailures/file_too_large_for_GitHub's_API), ./internal/library,
./internal/cli. gofmt -l clean; go vet -tags nogui and go build on
darwin/arm64, linux/amd64, windows/amd64. Ablations at this commit, tests
kept: sealLarge forced to 0 (always v2) turns TestSealStaysVersion1WhenSmall
red; the ErrCorrupt wrap and uncapped reader restored turn
TestOpenDecompressFailureIsPlain and TestOpenCapsTheDecompression red;
restored, all green. Not tried against the real GitHub API; GitHub's real
size limit is undocumented, and the compressed sizes are asserted against
the 54.7 MiB the report observed being refused.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/sync-backup.md  |  19 +++-
 internal/backup/backup.go       |  83 +++++++++++++++-
 internal/backup/backup_test.go  | 163 ++++++++++++++++++++++++++++++++
 internal/davsync/github.go      |   6 ++
 internal/davsync/github_test.go |  16 ++++
 internal/library/carry.go       |   7 +-
 6 files changed, 287 insertions(+), 7 deletions(-)

diff --git a/docs/subsystems/sync-backup.md b/docs/subsystems/sync-backup.md
index cbf52fc0..beb1b75d 100644
--- a/docs/subsystems/sync-backup.md
+++ b/docs/subsystems/sync-backup.md
@@ -17,7 +17,14 @@ clone a working tree or synchronize arbitrary files.
   interprets `github://owner/repo[/prefix]`, with `Config.Branch` selecting a
   branch or using the repository's default.
 - [`backup.go`](../../internal/backup/backup.go) owns bundle contents and
-  sealing. Sync divides the setup into providers, settings, profiles, agents
+  sealing. A backup that seals small stays the plain version 1 an older
+  magpie opens; one whose plain seal would run past what GitHub's file API
+  was seen taking is compressed (envelope version 2), which an older magpie
+  refuses with its update message. Compression takes a library's files back
+  to about their own size, so a capped library is expected to fit GitHub,
+  but GitHub's real limit is undocumented and a library of mostly
+  incompressible files may still not fit.
+  Sync divides the setup into providers, settings, profiles, agents
   and library. Provider keys, agent models, library and usage have their own
   inclusion switches.
 - [`usage.go`](../../internal/davsync/usage.go) shares separately sealed usage
@@ -113,8 +120,14 @@ repository can keep the token. The branch is part of the sync state key.
   The initial write omits `branch` so GitHub creates its default branch; other
   conflicts and missing branches are not treated as an empty repository.
 - Large files are downloaded by blob SHA, preserving the version that was
-  read. Sync files are limited to 64 MiB. Usage listing fails at the Contents
-  API's 1,000-file limit rather than treating a truncated list as complete.
+  read. Sync files are limited to 64 MiB, but GitHub's file API takes less of
+  an upload than that: a write it refuses as too large says the file's size
+  and the backends a backup that big fits. Sealed backups compress when the
+  plain seal would be too big, which is expected to keep a full library
+  within what GitHub takes, but GitHub's real limit is undocumented and a
+  library of mostly incompressible files may still not fit. Usage listing
+  fails at the Contents API's 1,000-file limit rather than treating a
+  truncated list as complete.
 - A stale SHA or a racing initial creation returns `errChanged`. Other 422
   responses stay actionable errors. Authentication, permission and branch
   failures remain distinct from missing files. Rate limits use sync backoff.
diff --git a/internal/backup/backup.go b/internal/backup/backup.go
index e1b7ce63..487d5b72 100644
--- a/internal/backup/backup.go
+++ b/internal/backup/backup.go
@@ -12,6 +12,8 @@
 package backup
 
 import (
+	"bytes"
+	"compress/gzip"
 	"context"
 	"crypto/aes"
 	"crypto/cipher"
@@ -21,6 +23,7 @@ import (
 	"encoding/json"
 	"errors"
 	"fmt"
+	"io"
 	"maps"
 	"os"
 	"path/filepath"
@@ -96,6 +99,10 @@ type Bundle struct {
 	LibraryKeys   *bool `json:"libraryKeys,omitempty"`
 }
 
+// envelope is the file around the sealed bundle. Version 1, an older
+// magpie's, keeps the bundle plain and still opens; version 2, written
+// only when the plain seal would run past what GitHub's file API was seen
+// taking, seals the bundle compressed (zipped).
 type envelope struct {
 	Format     string `json:"format"`
 	Version    int    `json:"version"`
@@ -262,7 +269,26 @@ func withoutKeys(p provider.Provider) provider.Provider {
 	return p
 }
 
-// Seal encrypts the bundle under the passphrase.
+// sealLarge is where a plainly sealed (version 1) backup stops: past it
+// Seal writes version 2, compressed. It sits near what GitHub's file API
+// was seen refusing — 54.7 MiB, less than the 64 MiB magpie's own guard
+// allows — with margin; GitHub's real limit is undocumented.
+const sealLarge = 50 << 20
+
+// maxPlain caps what opening a version 2 file may decompress to: far
+// above any bundle magpie writes (a library at the carry cap reads about
+// 44 MB), so only a bomb or a damaged writer reaches it.
+const maxPlain = 256 << 20
+
+// Seal encrypts the bundle under the passphrase. A backup that seals
+// small stays version 1, the plain seal an older magpie opens — most do.
+// One whose plain seal would run past what GitHub's file API was seen
+// taking is compressed and written as version 2, which an older magpie
+// refuses with its newer-magpie message: update it before syncing with
+// this one (#2707). Compression takes a library's files back to about
+// their own size, so a capped library is expected to fit GitHub again —
+// but a library of mostly incompressible files may still not, and the
+// write GitHub refuses says the size and where such a backup fits.
 func Seal(b Bundle, pass string) ([]byte, error) {
 	if pass == "" {
 		return nil, errors.New("a backup needs a passphrase")
@@ -279,9 +305,52 @@ func Seal(b Bundle, pass string) ([]byte, error) {
 		return nil, err
 	}
 	e.Data = gcm.Seal(nil, e.Nonce, plain, header(e))
+	v1, err := json.MarshalIndent(e, "", "  ")
+	if err != nil {
+		return nil, err
+	}
+	if len(v1) < sealLarge {
+		return v1, nil
+	}
+	// A fresh nonce: this envelope seals another plaintext under the key
+	// the plain seal above used.
+	e.Version = 2
+	e.Nonce = make([]byte, 12)
+	rand.Read(e.Nonce)
+	if gcm, err = aead(pass, e); err != nil {
+		return nil, err
+	}
+	e.Data = gcm.Seal(nil, e.Nonce, zipped(plain), header(e))
 	return json.MarshalIndent(e, "", "  ")
 }
 
+// zipped is plain as gzip. The error is dropped because the writer's
+// destination is memory, which cannot fail it.
+func zipped(plain []byte) []byte {
+	var buf bytes.Buffer
+	zw := gzip.NewWriter(&buf)
+	zw.Write(plain)
+	zw.Close()
+	return buf.Bytes()
+}
+
+// unzipped reads back what zipped wrote, through maxPlain: a file that
+// decompresses past it is refused, not read in.
+func unzipped(data []byte) ([]byte, error) {
+	zr, err := gzip.NewReader(bytes.NewReader(data))
+	if err != nil {
+		return nil, err
+	}
+	plain, err := io.ReadAll(io.LimitReader(zr, maxPlain+1))
+	if err != nil {
+		return nil, err
+	}
+	if len(plain) > maxPlain {
+		return nil, fmt.Errorf("the sealed bundle decompresses past %d bytes", maxPlain)
+	}
+	return plain, nil
+}
+
 // Open decrypts a backup. A byte order mark in front of the JSON is read
 // through: the file is written back through edit.WriteAtomic, which keeps
 // the mark a Windows tool saved the file with (#1534), and a backup moved
@@ -304,7 +373,7 @@ func Open(data []byte, pass string) (Bundle, error) {
 	if e.Format != format {
 		return Bundle{}, ErrNotBackup
 	}
-	if e.Version != 1 || e.KDF != "pbkdf2-sha256" {
+	if (e.Version != 1 && e.Version != 2) || e.KDF != "pbkdf2-sha256" {
 		return Bundle{}, errors.New("this backup was made by a newer magpie; update magpie to open it")
 	}
 	if e.Iterations < 100_000 || e.Iterations > 10_000_000 || len(e.Nonce) != 12 || len(e.Salt) < 16 {
@@ -318,6 +387,16 @@ func Open(data []byte, pass string) (Bundle, error) {
 	if err != nil {
 		return Bundle{}, ErrPassphrase
 	}
+	// version 2 sealed the bundle compressed; version 1 kept it plain. GCM
+	// has already authenticated the bytes, so a failure here is a bug or a
+	// damaged writer, not a cut write and not a wrong passphrase: a plain
+	// error, never ErrCorrupt, which a sync would read as a damaged backup
+	// it may replace (#2707 review).
+	if e.Version == 2 {
+		if plain, err = unzipped(plain); err != nil {
+			return Bundle{}, fmt.Errorf("the sealed bundle doesn't decompress: %w", err)
+		}
+	}
 	var b Bundle
 	if err := json.Unmarshal(plain, &b); err != nil {
 		return Bundle{}, err
diff --git a/internal/backup/backup_test.go b/internal/backup/backup_test.go
index ed9e1f98..13aeb3ae 100644
--- a/internal/backup/backup_test.go
+++ b/internal/backup/backup_test.go
@@ -2,10 +2,13 @@ package backup
 
 import (
 	"bytes"
+	"compress/gzip"
 	"context"
 	"crypto/rand"
 	"encoding/json"
 	"errors"
+	"fmt"
+	mrand "math/rand"
 	"os"
 	"path/filepath"
 	"reflect"
@@ -497,3 +500,163 @@ func TestRestorePluginsAndSignIn(t *testing.T) {
 		t.Fatalf("an older backup asked to install %v (%v)", asked, err)
 	}
 }
+
+// A backup that seals small stays version 1, the plain seal an older
+// magpie opens: only one whose plain seal would run past what GitHub's
+// file API was seen taking is compressed away as version 2 (#2707
+// review).
+func TestSealStaysVersion1WhenSmall(t *testing.T) {
+	data, err := Seal(Bundle{Version: 1}, "correct horse")
+	if err != nil {
+		t.Fatal(err)
+	}
+	var e envelope
+	if err := json.Unmarshal(data, &e); err != nil {
+		t.Fatal(err)
+	}
+	if e.Version != 1 {
+		t.Fatalf("a small backup sealed as version %d, want the plain version 1 an older magpie reads", e.Version)
+	}
+	if got, err := Open(data, "correct horse"); err != nil {
+		t.Fatal(err)
+	} else if got.Version != 1 {
+		t.Fatalf("opened as version %d", got.Version)
+	}
+}
+
+// sealedV2 is whatever bytes sealed in a version 2 envelope under pass:
+// the open path's tests build their own, GCM-valid, data.
+func sealedV2(t *testing.T, data []byte, pass string) []byte {
+	t.Helper()
+	e := envelope{Format: format, Version: 2, KDF: "pbkdf2-sha256", Iterations: iterations,
+		Salt: saltFor(pass), Nonce: make([]byte, 12)}
+	rand.Read(e.Nonce)
+	gcm, err := aead(pass, e)
+	if err != nil {
+		t.Fatal(err)
+	}
+	e.Data = gcm.Seal(nil, e.Nonce, data, header(e))
+	out, err := json.Marshal(e)
+	if err != nil {
+		t.Fatal(err)
+	}
+	return out
+}
+
+// A version 2 bundle that won't decompress is a bug or a damaged writer,
+// not a cut write (GCM had already authenticated the bytes) and not a
+// backup to rebuild over: its error is a plain one, never ErrCorrupt,
+// which a sync reads as its cue to replace the damaged file (#2707
+// review).
+func TestOpenDecompressFailureIsPlain(t *testing.T) {
+	_, err := Open(sealedV2(t, []byte("not gzip at all"), "correct horse"), "correct horse")
+	if err == nil {
+		t.Fatal("a sealed bundle that doesn't decompress opened")
+	}
+	if errors.Is(err, ErrCorrupt) {
+		t.Fatalf("a decompression failure read as ErrCorrupt, offered for rebuild: %v", err)
+	}
+	if errors.Is(err, ErrPassphrase) {
+		t.Fatalf("a decompression failure read as a wrong passphrase: %v", err)
+	}
+}
+
+// A decompressed bundle is read through a cap: a compressed file that
+// opens to more than any bundle magpie writes — a gzip bomb — is refused,
+// not read into memory (#2707 review).
+func TestOpenCapsTheDecompression(t *testing.T) {
+	var buf bytes.Buffer
+	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
+	for range 300 {
+		zw.Write(make([]byte, 1<<20))
+	}
+	zw.Close()
+	_, err := Open(sealedV2(t, buf.Bytes(), "correct horse"), "correct horse")
+	if err == nil || !strings.Contains(err.Error(), "decompresses past") {
+		t.Fatalf("a 300 MiB bomb: %v, want the cap refusal", err)
+	}
+	if errors.Is(err, ErrCorrupt) {
+		t.Fatalf("the cap refusal read as ErrCorrupt: %v", err)
+	}
+}
+
+// A backup carrying the most a library may carry (maxCarriedAll, 32 MiB
+// of skill files) seals far smaller than the bundle reads: its plain seal
+// would run past what GitHub's file API was seen refusing (54.7 MiB;
+// magpie's own guard allows 64 MiB, and GitHub's real limit is
+// undocumented), so it is compressed, as version 2. The backup opens as
+// it was sealed, and one an older magpie sealed, plainly, still opens
+// here.
+func TestSealCompressesTheLibrary(t *testing.T) {
+	skill := func(name string, text, binary int) *library.CarriedSkill {
+		rng := mrand.New(mrand.NewSource(int64(len(name))))
+		files := map[string][]byte{}
+		files["SKILL.md"] = []byte(strings.Repeat("# "+name+"\n\nStep by step, do the thing. See the notes below.\n\n", text/64))
+		files["assets/template.bin"] = make([]byte, binary)
+		rng.Read(files["assets/template.bin"])
+		return &library.CarriedSkill{Name: name, Files: files}
+	}
+	// 8 skills of 4 MiB each: half documentation, half a binary template,
+	// the worst of what a library carries
+	var skills []*library.CarriedSkill
+	for i := range 8 {
+		skills = append(skills, skill(fmt.Sprintf("skill-%d", i), 2<<20, 2<<20))
+	}
+	b := Bundle{Version: 1, Library: &library.Bundle{Skills: skills}}
+	plain, err := json.Marshal(b)
+	if err != nil {
+		t.Fatal(err)
+	}
+	sealed, err := Seal(b, "correct horse")
+	if err != nil {
+		t.Fatal(err)
+	}
+	var e envelope
+	if err := json.Unmarshal(sealed, &e); err != nil {
+		t.Fatal(err)
+	}
+	if e.Version != 2 {
+		t.Fatalf("a 32 MiB library sealed as version %d, want the compressed version 2", e.Version)
+	}
+	if len(sealed) >= len(plain) {
+		t.Fatalf("a %d-byte library sealed to %d bytes, without compressing", len(plain), len(sealed))
+	}
+	// the size GitHub was seen refusing for its file API (#2707; the real
+	// limit is undocumented): the most a library may carry is expected to
+	// seal back below it
+	if len(sealed) >= 54<<20 {
+		t.Fatalf("a 32 MiB library sealed to %d bytes, past what GitHub's file API refuses", len(sealed))
+	}
+	got, err := Open(sealed, "correct horse")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if back, err := json.Marshal(got); err != nil || !bytes.Equal(back, plain) {
+		t.Fatalf("the compressed backup opened as %d bytes, %v, not what was sealed", len(back), err)
+	}
+
+	// what an older magpie sealed: the bundle plain in a version 1 envelope
+	e = envelope{Format: format, Version: 1, KDF: "pbkdf2-sha256", Iterations: iterations,
+		Salt: saltFor("correct horse"), Nonce: make([]byte, 12)}
+	rand.Read(e.Nonce)
+	gcm, err := aead("correct horse", e)
+	if err != nil {
+		t.Fatal(err)
+	}
+	e.Data = gcm.Seal(nil, e.Nonce, plain, header(e))
+	old, err := json.MarshalIndent(e, "", "  ")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if got, err := Open(old, "correct horse"); err != nil {
+		t.Fatalf("a plainly sealed backup no longer opens: %v", err)
+	} else if back, _ := json.Marshal(got); !bytes.Equal(back, plain) {
+		t.Fatal("the plainly sealed backup opened as another bundle")
+	}
+	e.Version = 3
+	if newer, err := json.Marshal(e); err != nil {
+		t.Fatal(err)
+	} else if _, err := Open(newer, "correct horse"); err == nil || !strings.Contains(err.Error(), "newer magpie") {
+		t.Fatalf("a version 3 envelope: %v, want the newer-magpie refusal", err)
+	}
+}
diff --git a/internal/davsync/github.go b/internal/davsync/github.go
index e593f570..f4fded9e 100644
--- a/internal/davsync/github.go
+++ b/internal/davsync/github.go
@@ -305,6 +305,12 @@ func (g *github) commit(ctx context.Context, name string, data []byte, sha strin
 		if strings.Contains(string(body), `\"sha\" wasn't supplied`) {
 			return version{}, errChanged
 		}
+		// GitHub's file API takes less of an upload than the 64 MiB the
+		// guard above allows, so a file it refuses as too large is the
+		// size said, with where one that big fits (#2707)
+		if strings.Contains(strings.ToLower(string(body)), "too large") {
+			return version{}, fmt.Errorf("GitHub refused %s as too large (HTTP 422): GitHub's file API takes less of an upload than the 64 MiB magpie allows here, and this one is %d bytes; make what is shared smaller, or keep a backup this size on WebDAV or S3", name, len(data))
+		}
 		res.Body = io.NopCloser(bytes.NewReader(body))
 	}
 	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
diff --git a/internal/davsync/github_test.go b/internal/davsync/github_test.go
index 60313c03..af37048a 100644
--- a/internal/davsync/github_test.go
+++ b/internal/davsync/github_test.go
@@ -548,6 +548,22 @@ func TestGitHubFailures(t *testing.T) {
 			t.Fatalf("repository rules treated as a racing file creation: %v", err)
 		}
 	})
+	t.Run("file too large for GitHub's API", func(t *testing.T) {
+		f := newGithubFixture(t)
+		g, _ := newGitHub(githubConfig())
+		if err := g.prepare(context.Background()); err != nil {
+			t.Fatal(err)
+		}
+		f.mu.Lock()
+		f.status, f.message = 422, "Sorry, the file is too large to be processed. Consider creating/updating the file in a local clone and pushing it to GitHub."
+		f.mu.Unlock()
+		// the most the local guard lets through: GitHub takes less, and
+		// the refusal has to say so and where a backup this size fits (#2707)
+		_, err := g.put(context.Background(), make([]byte, 63<<20), "")
+		if err == nil || errors.Is(err, errChanged) || !strings.Contains(err.Error(), "takes less of an upload than the 64 MiB") {
+			t.Fatalf("GitHub's too-large refusal stayed the generic 422: %v", err)
+		}
+	})
 	t.Run("token cannot follow an external redirect", func(t *testing.T) {
 		f := newGithubFixture(t)
 		f.redirect = "https://outside.api.github.com/token"
diff --git a/internal/library/carry.go b/internal/library/carry.go
index 5831315b..c3d7e8c2 100644
--- a/internal/library/carry.go
+++ b/internal/library/carry.go
@@ -44,8 +44,11 @@ type CarriedSkill struct {
 // biggest once the skills come to maxCarriedAll. A skill's own files go
 // with it, its scripts and its templates (a PowerPoint template with its
 // pictures is several MB), but a sync reads at most 64 MiB of a backup
-// (davsync), and a skill's bytes are base64 twice in one (the bundle's
-// JSON, then the sealed envelope's): 32 MiB of files is about 57 MiB.
+// (davsync), and a skill's bytes are base64 in the bundle's JSON and
+// again in the sealed envelope's; past what GitHub's file API was seen
+// taking, the sealed data compresses, taking 32 MiB of files back to
+// about their own size. A library of mostly incompressible files may
+// still not fit GitHub, whose real limit is undocumented (#2707).
 const (
 	maxCarried    = 16 << 20
 	maxCarriedAll = 32 << 20
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [hunt39-c-dsh-sync-compress](https://github.com/ggbdpq/magpie/tree/hunt39-c-dsh-sync-compress) (head `f698e15a`).
