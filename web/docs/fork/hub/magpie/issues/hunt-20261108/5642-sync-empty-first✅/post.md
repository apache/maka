@yetone @tan-yong-sheng — three computers set to sync with only "Library instructions, MCP servers, skills, hooks and subagents" ticked: whichever of them had no setup of its own wrote the folder's file first, and a few minutes later the computer that had providers and routing groups had them mirrored away, exactly as reported against S3. The folder's file always carries the providers, the settings and the profiles — those parts have no tick of their own — so a computer with nothing in those parts makes its empty parts the folder's, and the computer that has them loses them when it joins. The other two backends (WebDAV, GitHub) share the same merge, so they were exposed the same way.

**Root cause**: `syncOnce` merges each part three ways (`internal/davsync/davsync.go`). On the first sync (`first` — this computer has no sync state yet), a part the server's file has was brought in whatever it holds, and `bring("providers")` runs `provider.Mirror` (`internal/provider/backup.go:103`), which mirrors the whole face: an empty providers part clears the local providers and routing groups. `backup.Collect` already refuses to carry a providers file that can't be read for exactly this reason ("carried as no providers, it would take them all away where sync mirrors it"); a computer that genuinely has none was not distinguished from one that lost them. The same shape was guarded once before, for the gateway keys alone (#1714's `keepUnseenGatewayKeys`).

**The fix**: on the first sync, a part that reads as empty in the folder's file goes up from what this computer has instead of coming down empty — an empty part is the folder never having had one (its first writer may have had no setup of its own), not a removal. The emptiness check uses the same `hashes` the change detection uses, so it reads as empty only when the part holds nothing at all. After the joining, an empty part stays what a computer made of it and reaches every computer as before — removing things still spreads.

<details><summary>patch: davsync: an empty part in the folder's file doesn't clear what a computer joining it has (#5642) — git am applies it as is; SHA-256 first 16: 3bb62abfd5aaf7c7</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 02:42:57 +0800
Subject: [PATCH] davsync: an empty part in the folder's file doesn't clear
 what a computer joining it has (#5642)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Three computers picking the library alone: whichever had no setup of
its own wrote the folder's file first, and the computer with providers
and routing groups had them mirrored away when it joined after — an
empty part is the folder never having had one, not a removal. On the
first sync, a part that reads as empty goes up from what this computer
has instead of coming down empty; after the joining, an empty part
stays what a computer made of it and goes everywhere as before.
(#1714 keeps a joining computer's gateway keys on the same shape.)

Verified: TestSyncEmptyFirstKeepsLaterSetups red without the fix (a's
providers []), green with it; the package's other syncs stay green,
including removals reaching every computer.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/davsync/davsync.go          | 23 +++++++--
 internal/davsync/empty_first_test.go | 72 ++++++++++++++++++++++++++++
 2 files changed, 92 insertions(+), 3 deletions(-)
 create mode 100644 internal/davsync/empty_first_test.go

diff --git a/internal/davsync/davsync.go b/internal/davsync/davsync.go
index ccc95032a..35b3656e1 100644
--- a/internal/davsync/davsync.go
+++ b/internal/davsync/davsync.go
@@ -892,6 +892,12 @@ func orEmpty[V any](m map[string]V) map[string]V {
 	return m
 }
 
+// emptyHashes is hashes of a bundle with nothing in it. A part of a
+// server's file reading as one of these is a part the folder never had —
+// its first writer may have had no setup of its own — not one a computer
+// removed (#5642).
+var emptyHashes = hashes(backup.Bundle{})
+
 // take puts from's part in to. The merged bundle is a sync one (BundleVersion):
 // its per-part markers, not the whole-bundle Keys bit, say which part
 // carries credentials, so a keyed providers upload no longer tells a reader
@@ -1288,9 +1294,20 @@ func syncOnce(ctx context.Context, c Config, st *state) error {
 			if first && p == "settings" {
 				keepUnseenGatewayKeys(&remote, local)
 			}
-			bringIn = append(bringIn, p)
-			if first {
-				here = append(here, p)
+			// A part that reads as empty in a file this computer is
+			// joining is the folder never having had one, not a
+			// removal: what this computer has goes up, not the empty
+			// part down (#5642). After the joining, an empty part is
+			// what a computer made of it, and goes everywhere as
+			// before.
+			if first && L[p] != emptyHashes[p] && R[p] == emptyHashes[p] {
+				take(&merged, local, p)
+				there = append(there, p)
+			} else {
+				bringIn = append(bringIn, p)
+				if first {
+					here = append(here, p)
+				}
 			}
 		case lc && rc: // both: the newer stays
 			if changed(p, c.Keys).After(remote.Created) {
diff --git a/internal/davsync/empty_first_test.go b/internal/davsync/empty_first_test.go
new file mode 100644
index 000000000..1bf266115
--- /dev/null
+++ b/internal/davsync/empty_first_test.go
@@ -0,0 +1,72 @@
+package davsync
+
+import (
+	"context"
+	"net/http/httptest"
+	"slices"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A computer with no setup of its own that joins first must not let its
+// empty file clear out what a computer joining after it has: an empty
+// part on the server is the folder never having had one, not a removal.
+// Three computers picking the library alone (#5642): whichever empty one
+// writes first, the one with providers and routing groups keeps them,
+// and its setup is what the others get.
+func TestSyncEmptyFirstKeepsLaterSetups(t *testing.T) {
+	fake := &fakeDAV{files: map[string][]byte{}, etags: map[string]string{}, dirs: map[string]bool{"/dav": true}}
+	srv := httptest.NewServer(fake)
+	defer srv.Close()
+	ctx := context.Background()
+	lib := true // the library alone, as the reporter had it
+	cfg := Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "correct horse", Library: &lib}
+	now := func(t *testing.T) {
+		t.Helper()
+		if err := Now(ctx); err != nil {
+			t.Fatal(err)
+		}
+	}
+
+	// b joins first, with nothing of its own: its empty setup goes up
+	b := newComputer(t)
+	b.use(t)
+	Configure(cfg)
+	now(t)
+
+	// a joins after it, with providers and a routing group: none of it
+	// goes away
+	a := newComputer(t)
+	a.use(t)
+	provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k1"})
+	if err := provider.SaveGroup(provider.Group{ID: "fast", Name: "Fast", Members: []string{"deepseek/deepseek-chat"}}); err != nil {
+		t.Fatal(err)
+	}
+	Configure(cfg)
+	now(t)
+	if got := ids(); !slices.Equal(got, []string{"deepseek=k1"}) {
+		t.Fatalf("a's providers after joining: %v", got)
+	}
+	gs, err := provider.StoredGroups()
+	if err != nil || len(gs) != 1 || gs[0].ID != "fast" {
+		t.Fatalf("a's groups after joining: %v %v", gs, err)
+	}
+
+	// what a has goes up: b, syncing next, has it too (without the key,
+	// which stays a's), and a keeps it when b's sync comes back
+	b.use(t)
+	now(t)
+	if got := ids(); !slices.Equal(got, []string{"deepseek="}) {
+		t.Fatalf("b after a joined: %v", got)
+	}
+	a.use(t)
+	now(t)
+	if got := ids(); !slices.Equal(got, []string{"deepseek=k1"}) {
+		t.Fatalf("a after b's sync came back: %v", got)
+	}
+	gs, err = provider.StoredGroups()
+	if err != nil || len(gs) != 1 || gs[0].ID != "fast" {
+		t.Fatalf("a's groups after b's sync came back: %v %v", gs, err)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/5642-sync-category-merge`](https://github.com/ggbdpq/magpie/tree/fix/5642-sync-category-merge) (head `446d35a1f376042cb0e60fc7c718d701bebd42df`), rebased onto current `upstream/main` (`2d5d1c1d2`); on a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `TestSyncEmptyFirstKeepsLaterSetups` (new) | red before the fix (`a's providers after joining: []`), pass after |
| `TestSync`, `TestSyncLibrary`, `TestSyncNutstore`, `TestSyncProviderOrder`, `TestSyncRace`, `TestSyncPluginsAndSignIn`, `TestConfigurePassword` | pass |
| `go test ./internal/davsync/ -tags nogui -timeout 25m -count=1` | ok (41s), zero failures |
| `go test -tags nogui ./...` (temp HOME, pinned Go caches) | ok, zero failures |
| targeted `-race` (`go test ./internal/davsync/ -tags nogui -race -timeout 25m -count=1`) | pass (139s) |
| `gofmt -l internal/davsync` | prints nothing |
| `go vet ./internal/davsync/`; `GOOS=linux go vet -tags nogui ./internal/davsync/`; `GOOS=windows go vet ./internal/davsync/` | clean |
| `go build`; `GOOS=linux go build ./internal/davsync/`; `GOOS=windows go build ./internal/davsync/` | clean |
| Ablation | disabling the empty-part guard (`false && first && …`) turns `TestSyncEmptyFirstKeepsLaterSetups` red (`a's providers after joining: []`); restored, green |
| Re-verified on upstream/main `2d5d1c1d2` | rebased (the one commit re-applied clean); the new test, `TestSync` and `TestSyncLibrary` rerun green |

**Not verified**: the reporter's three real computers against a real S3 bucket — NOT-RUNNABLE here. The test reproduces the merge on the shared path all three backends go through (`syncOnce`), with the reporter's own pick (the library alone, `Keys: false`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
