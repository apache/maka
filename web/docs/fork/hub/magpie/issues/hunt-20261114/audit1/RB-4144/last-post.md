@skygunner's series is verified on today's main (`7dbfc9f2f`) and rebased onto it — branch [hunt-20261112-t1-4144](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-4144), head `eb23419a05aa0cdd`, both commits with their authorship kept, tree identical under `git am` of the two patches below (`git am` applies the series cleanly on today's tip; both patches together in one `git apply` run trip over the same-file create-then-modify across the two patch files, `git am` is the way).

**What the series does**: a corrupt frame — malformed header, decoder error, checksum mismatch — now stops the read instead of being skipped, the summary keeps its last good parse (or exposes none), the calls reader keeps its previous cache, and caches produced by the old skip are invalidated. The skip it replaces could count a fork's inherited usage off a line whose first half sat in the lost frame — the report's "plus own counted as 106" case.

**Two rebase adaptations, tests and version placement only, semantics untouched**:

- main moved to two-level cache versions (#2278: a global raise re-reads every agent's history, minutes of CPU). The raises go to `parseVersions` dsh 4 and `callParseVersions` dsh 1 — only dsh reads changed — instead of the global `cacheVersion`/`callCacheVersion` bumps the branch was first written with.
- `file.mod` is main's `modTime` (int64) now: the test fixtures take `modOf(info.ModTime())`.

**Red without the fix**: with the product files (`frames.go`, `calls_dsh.go`, `dsh.go`, `sessions.go`, `call_cache.go`) reverted to main and the tests kept, `TestCorruptFrameDoesNotExposeLineContinuation` fails — the line suffix is emitted alone and the fork's inherited-plus-own usage is counted, the report's case.

**Green with the fix**: the whole `./internal/sessions` package, ok in 98.8 s, zero failures; gofmt and go vet clean; GOOS linux and windows (nogui) build ok.

**On skip-with-report vs this fail-closed shape** — the alternative worth settling deliberately rather than by accident: skipping a frame is only safe when nothing spans it, and the dsh format cannot know that from the damaged region alone — a fork's `session/end-seed` marker, or the first half of a line continued in the next frame, can sit exactly there, which is how the skipped frame produced a wrong count rather than a short count. For a usage ledger, wrong is worse than missing-with-a-known-boundary; recovery is written down (repair the source; the changed size or mtime triggers the re-read). Best-effort recovery past a corrupt frame belongs on top of this, gated on the same boundary checks the docs hunk spells out — I'd leave that to the maintainer.

**Not verified**: a real corrupted wire file from the reporter's environment (the tests build the corruption synthetically); the real CPU cost of the dsh re-reads after an update on a long history.

---
**Source**: reported in this issue; the fix is @skygunner's ([fix/4144-sessions-frame-tail](https://github.com/skygunner/magpie/tree/fix/4144-sessions-frame-tail), head `ba4f3ef69a0fbfd8`), rebased and verified by me on macOS.

**Attribution**: AI-written (this verification, the rebase adaptations and the version-placement change); the fix is skygunner's, kept as author with the Co-authored-by line. Please keep the author (`vincent` / skygunner) for both commits.

**Patch**: <details><summary>patches: 0001 sessions: read past a complete frame with a bad checksum · 0002 sessions: stop at corrupt frames before counting fork history — git am applies them as is; SHA-256 first 16: 4d3ab4716a100ba4 / 453460ad807178c9</summary>

````From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: vincent <vincent@users.noreply.github.com>
Date: Thu, 29 Oct 2026 11:51:56 +1000
Subject: [PATCH 1/2] sessions: read past a complete frame with a bad checksum

Keep incomplete frames for later and stop at malformed headers or other decoder errors. Only skip a checksummed frame when its full boundary is known and no earlier partial line depends on it.

The new corruption tests failed on the previous code: the later frame was not read, and a malformed header returned nil. Verified: go test -tags nogui ./internal/sessions -count=1; focused tests with -race; go build ./...; go vet ./....

Co-authored-by: sisyphus-dev-ai <sisyphus-dev-ai@users.noreply.github.com>
---
 docs/subsystems/gateway-sessions.md      |  10 +-
 internal/sessions/frames.go              |  16 +-
 internal/sessions/frames_corrupt_test.go | 196 +++++++++++++++++++++++
 3 files changed, 216 insertions(+), 6 deletions(-)
 create mode 100644 internal/sessions/frames_corrupt_test.go

diff --git a/docs/subsystems/gateway-sessions.md b/docs/subsystems/gateway-sessions.md
index 067ae3885..531e3b842 100644
--- a/docs/subsystems/gateway-sessions.md
+++ b/docs/subsystems/gateway-sessions.md
@@ -815,7 +815,15 @@ no pointer to the original, and is still counted twice (#5072).
 The other agents the Sessions page reads (Cline,
 Qoder, Grok, Droid, Cursor, Hermes, Alma) have no reader yet (#1607). The
 Context page reads the gateway's own traces, so it shows none of these
-calls. Verification: `TestMiniMaxCodeCalls`, `TestKimiCode*` (the
+calls. For packed dsh sessions, [`scanFrames`](../../internal/sessions/frames.go)
+passes a complete frame with a checksum mismatch when its boundary is known and
+no unfinished line crosses it. Other decoder errors and malformed headers stop
+the read; a missing dictionary or decoder limit does not prove corruption.
+Corruption within an unfinished line also stops the read.
+An incomplete frame waits for more bytes, since it can contain a valid frame's
+magic as data. The readers do not save a tail on an error and retry from the
+start; later records can remain unavailable until the source file is repaired.
+Verification: `TestMiniMaxCodeCalls`, `TestKimiCode*` (the
 reporter's real wire files), `TestCodeBuddyCalls`, `TestWorkBuddyCalls*`,
 `TestPiCalls*` (Pi 1.1.0's and omp 18.9.1's own files) and
 `TestWSLSessionsListed`.
diff --git a/internal/sessions/frames.go b/internal/sessions/frames.go
index 37034b0b4..8040f178e 100644
--- a/internal/sessions/frames.go
+++ b/internal/sessions/frames.go
@@ -211,9 +211,10 @@ func scanFrames(path string, off, skip int64, fn func([]byte) bool) (next, nextS
 		var n int64
 		frame, n, err = readFrame(r, frame, frameSize(f, at))
 		if err != nil {
-			// the end, a frame still being written, or not one at all:
-			// what was read stands, the rest waits for the next read
-			err = nil
+			// An incomplete frame waits; a malformed header has no safe boundary.
+			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
+				err = nil
+			}
 			return
 		}
 		start := at
@@ -226,9 +227,14 @@ func scanFrames(path string, off, skip int64, fn func([]byte) bool) (next, nextS
 			continue
 		}
 		if out, err = dec.DecodeAll(frame, out[:0]); err != nil {
+			if !errors.Is(err, zstd.ErrCRCMismatch) || len(pending) != 0 || first && skip != 0 {
+				end = start
+				return
+			}
+			// The complete frame has a known end, but its contents are lost.
+			next, nextSkip = at, 0
 			err = nil
-			end = start
-			return
+			continue
 		}
 		from := int64(0)
 		if first {
diff --git a/internal/sessions/frames_corrupt_test.go b/internal/sessions/frames_corrupt_test.go
new file mode 100644
index 000000000..ed53c24cb
--- /dev/null
+++ b/internal/sessions/frames_corrupt_test.go
@@ -0,0 +1,196 @@
+package sessions
+
+import (
+	"bytes"
+	"errors"
+	"os"
+	"path/filepath"
+	"reflect"
+	"testing"
+
+	"github.com/klauspost/compress/zstd"
+)
+
+func TestScanFramesCorruption(t *testing.T) {
+	enc, err := zstd.NewWriter(nil, zstd.WithEncoderCRC(true))
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer enc.Close()
+	frame := func(s string) []byte { return enc.EncodeAll([]byte(s), nil) }
+	first, last := frame("first\n"), frame("last\n")
+	bad := frame("broken\n")
+	bad[len(bad)-1] ^= 0xff
+	malformed := []byte{0, 0, 0, 0}
+
+	for _, tc := range []struct {
+		name      string
+		middle    []byte
+		want      []string
+		badHeader bool
+	}{
+		{"complete corrupt frame", bad, []string{"first", "last"}, false},
+		{"malformed header", malformed, []string{"first"}, true},
+	} {
+		t.Run(tc.name, func(t *testing.T) {
+			p := filepath.Join(t.TempDir(), "session.zstd")
+			data := append(append(bytes.Clone(first), tc.middle...), last...)
+			if err := os.WriteFile(p, data, 0o600); err != nil {
+				t.Fatal(err)
+			}
+			var lines []string
+			next, skip, end, err := scanFrames(p, 0, 0, func(b []byte) bool { lines = append(lines, string(b)); return true })
+			if !reflect.DeepEqual(lines, tc.want) {
+				t.Fatalf("lines = %q, want %q", lines, tc.want)
+			}
+			if tc.badHeader {
+				if !errors.Is(err, errFrame) || next != int64(len(first)) || end != next {
+					t.Fatalf("malformed header: next=%d skip=%d end=%d err=%v", next, skip, end, err)
+				}
+			} else if err != nil || next != int64(len(data)) || end != next || skip != 0 {
+				t.Fatalf("corrupt frame: next=%d skip=%d end=%d err=%v", next, skip, end, err)
+			}
+		})
+	}
+}
+
+func TestScanFramesIncompleteRetained(t *testing.T) {
+	enc, err := zstd.NewWriter(nil)
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer enc.Close()
+	first, last := enc.EncodeAll([]byte("first\n"), nil), enc.EncodeAll([]byte("last\n"), nil)
+	p := filepath.Join(t.TempDir(), "session.zstd")
+	cut := len(last) / 2
+	if err := os.WriteFile(p, append(bytes.Clone(first), last[:cut]...), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	var lines []string
+	next, skip, end, err := scanFrames(p, 0, 0, func(b []byte) bool { lines = append(lines, string(b)); return true })
+	if err != nil || next != int64(len(first)) || end != next || skip != 0 || !reflect.DeepEqual(lines, []string{"first"}) {
+		t.Fatalf("partial: lines=%q next=%d skip=%d end=%d err=%v", lines, next, skip, end, err)
+	}
+	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if _, err := f.Write(last[cut:]); err != nil {
+		t.Fatal(err)
+	}
+	if err := f.Close(); err != nil {
+		t.Fatal(err)
+	}
+	_, _, _, err = scanFrames(p, next, skip, func(b []byte) bool { lines = append(lines, string(b)); return true })
+	if err != nil || !reflect.DeepEqual(lines, []string{"first", "last"}) {
+		t.Fatalf("completed: lines=%q err=%v", lines, err)
+	}
+}
+
+func TestDshReadersRecoverAfterCorruptFrame(t *testing.T) {
+	enc, err := zstd.NewWriter(nil, zstd.WithEncoderCRC(true))
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer enc.Close()
+	head := enc.EncodeAll([]byte("{\"type\":\"session\",\"id\":\"s\",\"version\":3}\n"), nil)
+	bad := enc.EncodeAll([]byte("broken\n"), nil)
+	bad[len(bad)-1] ^= 0xff
+	reply := enc.EncodeAll([]byte("{\"type\":\"assistant/message\",\"seq\":1,\"time\":1790503290000,\"data\":{\"message\":{\"source\":{\"model\":\"m\"}},\"usage\":{\"inputTokens\":7,\"outputTokens\":1}}}\n"), nil)
+	p := filepath.Join(t.TempDir(), "session.zstd")
+	data := append(append(bytes.Clone(head), bad...), reply...)
+	if err := os.WriteFile(p, data, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	info, err := os.Stat(p)
+	if err != nil {
+		t.Fatal(err)
+	}
+	f := file{path: p, size: info.Size(), mod: info.ModTime(), main: true}
+	s := parseDsh(f, nil)
+	if s.ID != "s" || s.Dsh == nil || s.Dsh.Tail == nil || s.Dsh.Tail.Off != int64(len(data)) {
+		t.Fatalf("summary: %+v", s)
+	}
+	calls, _, ok := readDshCalls(f, nil)
+	if !ok || len(calls.Calls) != 1 || calls.Calls[0].Input != 7 || calls.Dsh.Tail == nil || calls.Dsh.Tail.Off != int64(len(data)) {
+		t.Fatalf("calls: %+v, ok=%v", calls, ok)
+	}
+	if again, kept, ok := readDshCalls(f, calls); !ok || kept != 1 || len(again.Calls) != 1 {
+		t.Fatalf("repeated read: %+v, kept=%d ok=%v", again, kept, ok)
+	}
+}
+
+func TestScanFramesUnknownDictionaryRetained(t *testing.T) {
+	enc, err := zstd.NewWriter(nil, zstd.WithEncoderDictRaw(42, []byte("dictionary content")))
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer enc.Close()
+	frame := enc.EncodeAll([]byte("dictionary data\n"), nil)
+	p := filepath.Join(t.TempDir(), "session.zstd")
+	if err := os.WriteFile(p, frame, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	next, skip, end, err := scanFrames(p, 0, 0, func([]byte) bool { t.Fatal("decoded without dictionary"); return false })
+	if !errors.Is(err, zstd.ErrUnknownDictionary) || next != 0 || skip != 0 || end != 0 {
+		t.Fatalf("dictionary frame: next=%d skip=%d end=%d err=%v", next, skip, end, err)
+	}
+}
+
+func TestScanFramesIncompleteContainsFrame(t *testing.T) {
+	enc, err := zstd.NewWriter(nil)
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer enc.Close()
+	inner := enc.EncodeAll([]byte("inside\n"), nil)
+	// A raw block contains a complete frame as ordinary uncompressed data.
+	size := len(inner) + 10
+	outer := []byte{0x28, 0xb5, 0x2f, 0xfd, 0x20, byte(size)}
+	block := size<<3 | 1
+	outer = append(outer, byte(block), byte(block>>8), byte(block>>16))
+	outer = append(outer, inner...)
+	p := filepath.Join(t.TempDir(), "session.zstd")
+	if err := os.WriteFile(p, outer, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	next, skip, end, err := scanFrames(p, 0, 0, func([]byte) bool { t.Fatal("read nested frame"); return false })
+	if err != nil || next != 0 || skip != 0 || end != 0 {
+		t.Fatalf("incomplete outer frame: next=%d skip=%d end=%d err=%v", next, skip, end, err)
+	}
+}
+
+func TestScanFramesPartialMagic(t *testing.T) {
+	p := filepath.Join(t.TempDir(), "session.zstd")
+	magic := []byte{0x28, 0xb5, 0x2f, 0xfd}
+	for n := 1; n < len(magic); n++ {
+		if err := os.WriteFile(p, magic[:n], 0o600); err != nil {
+			t.Fatal(err)
+		}
+		next, skip, end, err := scanFrames(p, 0, 0, func([]byte) bool { t.Fatal("partial header decoded"); return false })
+		if err != nil || next != 0 || skip != 0 || end != 0 {
+			t.Fatalf("%d-byte header: next=%d skip=%d end=%d err=%v", n, next, skip, end, err)
+		}
+	}
+}
+
+func TestScanFramesCorruptFrameInsideLine(t *testing.T) {
+	enc, err := zstd.NewWriter(nil, zstd.WithEncoderCRC(true))
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer enc.Close()
+	first := enc.EncodeAll([]byte("partial"), nil)
+	bad := enc.EncodeAll([]byte("missing"), nil)
+	bad[len(bad)-1] ^= 0xff
+	last := enc.EncodeAll([]byte("end\n"), nil)
+	p := filepath.Join(t.TempDir(), "session.zstd")
+	if err := os.WriteFile(p, append(append(bytes.Clone(first), bad...), last...), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	var lines []string
+	next, _, end, err := scanFrames(p, 0, 0, func(b []byte) bool { lines = append(lines, string(b)); return true })
+	if err == nil || len(lines) != 0 || next != 0 || end != int64(len(first)) {
+		t.Fatalf("partial line across corruption: lines=%q next=%d end=%d err=%v", lines, next, end, err)
+	}
+}
-- 
2.50.1 (Apple Git-155)
````

````From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: vincent <vincent@users.noreply.github.com>
Date: Thu, 29 Oct 2026 12:06:08 +1000
Subject: [PATCH 2/2] sessions: stop at corrupt frames before counting fork
 history
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Do not skip checksum failures: the missing frame may end a seed or
start a line continued later. Keep the last successful result on a
read error and invalidate the cached parses and calls made by the
prior skip.

The version raises follow main's two-level scheme as of 873b4987e:
parseVersions dsh 4 (a summary parse that skipped a corrupt frame
kept what lay behind it) and callParseVersions dsh 1 (same for call
shards), instead of the global cacheVersion/callCacheVersion bump the
branch was first written with — a raise of the globals reads every
agent's history again (#2278), and only dsh reads changed.

Rebase adaptations to the tests only: file.mod is main's modTime
(int64) now, so the fixtures take modOf(info.ModTime()).

The new tests failed on the prior commit: a line suffix was emitted
alone and inherited plus own usage was counted as 106.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-sessions.md      | 19 +++--
 internal/sessions/call_cache.go          |  5 +-
 internal/sessions/calls_dsh.go           |  2 +-
 internal/sessions/dsh.go                 |  6 ++
 internal/sessions/frames.go              | 10 +--
 internal/sessions/frames_corrupt_test.go | 29 +++----
 internal/sessions/frames_review_test.go  | 98 ++++++++++++++++++++++++
 internal/sessions/sessions.go            |  6 +-
 8 files changed, 139 insertions(+), 36 deletions(-)
 create mode 100644 internal/sessions/frames_review_test.go

diff --git a/docs/subsystems/gateway-sessions.md b/docs/subsystems/gateway-sessions.md
index 531e3b842..2afcbf390 100644
--- a/docs/subsystems/gateway-sessions.md
+++ b/docs/subsystems/gateway-sessions.md
@@ -816,13 +816,18 @@ The other agents the Sessions page reads (Cline,
 Qoder, Grok, Droid, Cursor, Hermes, Alma) have no reader yet (#1607). The
 Context page reads the gateway's own traces, so it shows none of these
 calls. For packed dsh sessions, [`scanFrames`](../../internal/sessions/frames.go)
-passes a complete frame with a checksum mismatch when its boundary is known and
-no unfinished line crosses it. Other decoder errors and malformed headers stop
-the read; a missing dictionary or decoder limit does not prove corruption.
-Corruption within an unfinished line also stops the read.
-An incomplete frame waits for more bytes, since it can contain a valid frame's
-magic as data. The readers do not save a tail on an error and retry from the
-start; later records can remain unavailable until the source file is repaired.
+stops at a malformed header or decoder error, including a checksum mismatch:
+the lost frame can contain a fork's end-seed marker or part of a line. An
+incomplete frame waits for more bytes, since it can contain a valid frame's
+magic as data. On a read error the summary retains its previous parse, if any,
+and the calls reader retains its previous cache; without one they expose no
+partial data. A changed size or modification time triggers a new read; the
+old tail is reused only if its sampled prefix still matches. A repair that
+preserves both may leave cached data unchanged until cache invalidation, and a
+rewrite missed by the sampled prefix can also retain an earlier parse. The
+summary and calls cache versions were raised to discard results produced by
+the former skip behavior. Later records remain unavailable until the source is
+repaired and detected.
 Verification: `TestMiniMaxCodeCalls`, `TestKimiCode*` (the
 reporter's real wire files), `TestCodeBuddyCalls`, `TestWorkBuddyCalls*`,
 `TestPiCalls*` (Pi 1.1.0's and omp 18.9.1's own files) and
diff --git a/internal/sessions/call_cache.go b/internal/sessions/call_cache.go
index 48b937860..d4c5f27bf 100644
--- a/internal/sessions/call_cache.go
+++ b/internal/sessions/call_cache.go
@@ -44,6 +44,7 @@ import (
 // call's own time.
 // v14: Codex calls keep the thread that made the request.
 // v15: Codex calls keep the compaction marker independently of its duration.
+// v16: discard dsh calls read past a corrupt frame.
 // What each version names is what a cache of the one before it cannot serve:
 // the version is part of the directory's name, so a cache written by an older
 // one is never read (pruneCalls). It is raised for a change to every agent's
@@ -68,7 +69,9 @@ const callCacheVersion = "calls-v15"
 // (gemini-4-argon-d) is its model's (GeminiDeployment).
 // zcode 3: a call names its session as a request does, without the sess_
 // prefix (zcodeBareID), so the gateway's record of it pairs with it.
-var callParseVersions = map[string]int{"antigravity": 1, "cindy": 1, "codex": 3, "zcode": 3}
+// dsh 1: a calls read that went past a corrupt frame (the skip the old code
+// did) kept what lay behind it; the read stops at the frame now (frames.go).
+var callParseVersions = map[string]int{"antigravity": 1, "cindy": 1, "codex": 3, "dsh": 1, "zcode": 3}
 
 // CallCacheVersion is callCacheVersion and callParseVersions, for a cache
 // of what is made of the calls (usage's requests-v1.bin and heatmap): a
diff --git a/internal/sessions/calls_dsh.go b/internal/sessions/calls_dsh.go
index e93cf2997..197e504f8 100644
--- a/internal/sessions/calls_dsh.go
+++ b/internal/sessions/calls_dsh.go
@@ -108,7 +108,7 @@ func readDshCalls(f file, old *callFile) (st *callFile, kept int, ok bool) {
 		next, err = scanAt(f.path, off, nil, func(b []byte, _, _ int64) bool { return each(b) })
 		end = next
 	}
-	if !ok || err != nil && !headed {
+	if !ok || err != nil {
 		return &callFile{Path: f.path, Agent: "dsh"}, 0, false
 	}
 	c.Tail = nil
diff --git a/internal/sessions/dsh.go b/internal/sessions/dsh.go
index a61db7e11..76aaa8de3 100644
--- a/internal/sessions/dsh.go
+++ b/internal/sessions/dsh.go
@@ -325,6 +325,12 @@ func parseDsh(f file, old *state) *state {
 		// not a session's file: only its size and time
 		return &state{Size: f.size, Mod: f.mod.UnixNano()}
 	}
+	if err != nil {
+		if old != nil {
+			return old
+		}
+		return &state{}
+	}
 	c.Tail = nil
 	if err == nil {
 		c.Tail = markTail(f.path, next, nextSkip, end)
diff --git a/internal/sessions/frames.go b/internal/sessions/frames.go
index 8040f178e..6f1b382eb 100644
--- a/internal/sessions/frames.go
+++ b/internal/sessions/frames.go
@@ -227,14 +227,8 @@ func scanFrames(path string, off, skip int64, fn func([]byte) bool) (next, nextS
 			continue
 		}
 		if out, err = dec.DecodeAll(frame, out[:0]); err != nil {
-			if !errors.Is(err, zstd.ErrCRCMismatch) || len(pending) != 0 || first && skip != 0 {
-				end = start
-				return
-			}
-			// The complete frame has a known end, but its contents are lost.
-			next, nextSkip = at, 0
-			err = nil
-			continue
+			end = start
+			return
 		}
 		from := int64(0)
 		if first {
diff --git a/internal/sessions/frames_corrupt_test.go b/internal/sessions/frames_corrupt_test.go
index ed53c24cb..c0176ed2f 100644
--- a/internal/sessions/frames_corrupt_test.go
+++ b/internal/sessions/frames_corrupt_test.go
@@ -24,13 +24,13 @@ func TestScanFramesCorruption(t *testing.T) {
 	malformed := []byte{0, 0, 0, 0}
 
 	for _, tc := range []struct {
-		name      string
-		middle    []byte
-		want      []string
-		badHeader bool
+		name    string
+		middle  []byte
+		want    []string
+		wantErr error
 	}{
-		{"complete corrupt frame", bad, []string{"first", "last"}, false},
-		{"malformed header", malformed, []string{"first"}, true},
+		{"complete corrupt frame", bad, []string{"first"}, zstd.ErrCRCMismatch},
+		{"malformed header", malformed, []string{"first"}, errFrame},
 	} {
 		t.Run(tc.name, func(t *testing.T) {
 			p := filepath.Join(t.TempDir(), "session.zstd")
@@ -43,11 +43,7 @@ func TestScanFramesCorruption(t *testing.T) {
 			if !reflect.DeepEqual(lines, tc.want) {
 				t.Fatalf("lines = %q, want %q", lines, tc.want)
 			}
-			if tc.badHeader {
-				if !errors.Is(err, errFrame) || next != int64(len(first)) || end != next {
-					t.Fatalf("malformed header: next=%d skip=%d end=%d err=%v", next, skip, end, err)
-				}
-			} else if err != nil || next != int64(len(data)) || end != next || skip != 0 {
+			if !errors.Is(err, tc.wantErr) || next != int64(len(first)) || end != next || skip != 0 {
 				t.Fatalf("corrupt frame: next=%d skip=%d end=%d err=%v", next, skip, end, err)
 			}
 		})
@@ -87,7 +83,7 @@ func TestScanFramesIncompleteRetained(t *testing.T) {
 	}
 }
 
-func TestDshReadersRecoverAfterCorruptFrame(t *testing.T) {
+func TestDshReadersStopAtCorruptFrame(t *testing.T) {
 	enc, err := zstd.NewWriter(nil, zstd.WithEncoderCRC(true))
 	if err != nil {
 		t.Fatal(err)
@@ -106,18 +102,15 @@ func TestDshReadersRecoverAfterCorruptFrame(t *testing.T) {
 	if err != nil {
 		t.Fatal(err)
 	}
-	f := file{path: p, size: info.Size(), mod: info.ModTime(), main: true}
+	f := file{path: p, size: info.Size(), mod: modOf(info.ModTime()), main: true}
 	s := parseDsh(f, nil)
-	if s.ID != "s" || s.Dsh == nil || s.Dsh.Tail == nil || s.Dsh.Tail.Off != int64(len(data)) {
+	if s.ID != "" || len(s.Models) != 0 {
 		t.Fatalf("summary: %+v", s)
 	}
 	calls, _, ok := readDshCalls(f, nil)
-	if !ok || len(calls.Calls) != 1 || calls.Calls[0].Input != 7 || calls.Dsh.Tail == nil || calls.Dsh.Tail.Off != int64(len(data)) {
+	if ok || len(calls.Calls) != 0 {
 		t.Fatalf("calls: %+v, ok=%v", calls, ok)
 	}
-	if again, kept, ok := readDshCalls(f, calls); !ok || kept != 1 || len(again.Calls) != 1 {
-		t.Fatalf("repeated read: %+v, kept=%d ok=%v", again, kept, ok)
-	}
 }
 
 func TestScanFramesUnknownDictionaryRetained(t *testing.T) {
diff --git a/internal/sessions/frames_review_test.go b/internal/sessions/frames_review_test.go
new file mode 100644
index 000000000..7e6b6dfc1
--- /dev/null
+++ b/internal/sessions/frames_review_test.go
@@ -0,0 +1,98 @@
+package sessions
+
+import (
+	"bytes"
+	"errors"
+	"os"
+	"path/filepath"
+	"testing"
+	"time"
+
+	"github.com/klauspost/compress/zstd"
+)
+
+func TestCorruptFrameDoesNotExposeLineContinuation(t *testing.T) {
+	enc, err := zstd.NewWriter(nil, zstd.WithEncoderCRC(true))
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer enc.Close()
+	bad := enc.EncodeAll([]byte("lost prefix"), nil)
+	bad[len(bad)-1] ^= 1
+	data := append(bad, enc.EncodeAll([]byte("suffix\n"), nil)...)
+	p := filepath.Join(t.TempDir(), "x.zstd")
+	if err := os.WriteFile(p, data, 0600); err != nil {
+		t.Fatal(err)
+	}
+	var lines []string
+	next, _, end, err := scanFrames(p, 0, 0, func(b []byte) bool { lines = append(lines, string(b)); return true })
+	if !errors.Is(err, zstd.ErrCRCMismatch) || len(lines) != 0 || next != 0 || end != 0 {
+		t.Fatalf("lines=%q next=%d end=%d err=%v", lines, next, end, err)
+	}
+}
+
+func TestDshCorruptSeedCacheRepair(t *testing.T) {
+	setup(t)
+	enc, err := zstd.NewWriter(nil, zstd.WithEncoderCRC(true))
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer enc.Close()
+	frame := func(s string) []byte { return enc.EncodeAll([]byte(s), nil) }
+	head := frame("{\"type\":\"session\",\"id\":\"fork\",\"version\":3,\"isSeeded\":true}\n")
+	inherited := frame("{\"type\":\"assistant/message\",\"seq\":1,\"time\":1790503290000,\"data\":{\"message\":{\"source\":{\"model\":\"m\"}},\"usage\":{\"inputTokens\":99,\"outputTokens\":1}}}\n")
+	seed := frame("{\"type\":\"session/end-seed\",\"data\":{\"inherited\":true}}\n")
+	bad := bytes.Clone(seed)
+	bad[len(bad)-1] ^= 1
+	own := frame("{\"type\":\"assistant/message\",\"seq\":2,\"time\":1790503291000,\"data\":{\"message\":{\"source\":{\"model\":\"m\"}},\"usage\":{\"inputTokens\":7,\"outputTokens\":1}}}\n")
+	p := filepath.Join(t.TempDir(), "session.zstd")
+	build := func(mid []byte) []byte {
+		b := append(bytes.Clone(head), inherited...)
+		b = append(b, mid...)
+		return append(b, own...)
+	}
+	if err := os.WriteFile(p, build(bad), 0600); err != nil {
+		t.Fatal(err)
+	}
+	info, err := os.Stat(p)
+	if err != nil {
+		t.Fatal(err)
+	}
+	f := file{agent: "dsh", path: p, size: info.Size(), mod: modOf(info.ModTime()), main: true}
+	mu.Lock()
+	cache = make(map[string]*state)
+	refresh([]file{f}, nil)
+	summary := cache[p]
+	mu.Unlock()
+	if len(summary.Models) != 0 {
+		t.Fatalf("corrupt fork counted inherited or later usage: %+v", summary.Models)
+	}
+	calls := readCalls(f)
+	if len(calls.Calls) != 0 {
+		t.Fatalf("corrupt fork counted calls: %+v", calls.Calls)
+	}
+	if err := os.WriteFile(p, build(seed), 0600); err != nil {
+		t.Fatal(err)
+	}
+	fixedTime := info.ModTime().Add(time.Second)
+	if err := os.Chtimes(p, fixedTime, fixedTime); err != nil {
+		t.Fatal(err)
+	}
+	info, err = os.Stat(p)
+	if err != nil {
+		t.Fatal(err)
+	}
+	f.size, f.mod = info.Size(), modOf(info.ModTime())
+	mu.Lock()
+	refresh([]file{f}, nil)
+	summary = cache[p]
+	mu.Unlock()
+	m, ok := summary.Models.get("m")
+	if !ok || m.Input != 7 {
+		t.Fatalf("repaired summary: %+v", summary.Models)
+	}
+	calls = readCalls(f)
+	if len(calls.Calls) != 1 || calls.Calls[0].Input != 7 {
+		t.Fatalf("repaired calls: %+v", calls.Calls)
+	}
+}
diff --git a/internal/sessions/sessions.go b/internal/sessions/sessions.go
index 6c2445ea2..a6c119d7e 100644
--- a/internal/sessions/sessions.go
+++ b/internal/sessions/sessions.go
@@ -1464,7 +1464,11 @@ const cacheVersion = 29
 // (a parse kept from before has none, under the same row revision).
 // dsh 3: the ids of its newest turn's messages (TurnConvs), which a
 // request still answering carried and has no reply id for yet.
-var parseVersions = map[string]int{"codex": 3, "zcode": 1, "dsh": 3, "antigravity": 2}
+//
+// dsh 4: a parse that skipped a corrupt frame kept what lay behind it; the
+// read stops at the frame now (frames.go), so parses made by the skip are
+// read again.
+var parseVersions = map[string]int{"codex": 3, "zcode": 1, "dsh": 4, "antigravity": 2}
 
 type cacheFile struct {
 	Version int    `json:"version"`
-- 
2.50.1 (Apple Git-155)
````

</details>

