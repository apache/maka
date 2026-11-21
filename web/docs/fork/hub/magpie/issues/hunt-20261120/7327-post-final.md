Carrying @MaxMaoSu's patch from the issue body — author kept on the commit — and verified at the current main. The fix is theirs as written; added on my side: the test pinning their two cases plus the fresh-computer join, and this verification.

**Why `Put` is the right place.** Every path that applies a bundle funnels through `library.Put` — a davsync pull lands via `bringLibrary` → the backup apply → `Put`, and a manual backup apply reaches the same call — so one guard at `Put` covers the sync flip this issue reports, without touching the writers that are themselves choices: `SaveInstructions`' activate (the thing being protected) and the borrow flow's explicit import (`borrow.go:455`, a user action, left as is).

**Behavior, spelled out** (the patch's three branches):

- this computer has chosen a set the bundle still carries → kept;
- nothing chosen here yet (fresh computer, no sets, empty active) → joins on the sender's set;
- the set this computer uses is no longer among the bundle's (removed on another computer) → moves to the bundle's, so the pointer never dangles.

`""` and the default set always count as present, matching `setPath`'s own convention.

**One consequence disclosed:** a manual backup apply goes through the same `Put`, so a restore onto a computer that has since chosen a set the bundle carries now keeps that choice too (the sets and their texts are still restored). That follows from the policy this issue asks for — which set is on is a per-computer choice — but it changes restore's old flip-along behavior, so it is stated here rather than left to be found.

| Element | Evidence (darwin/arm64, upstream/main `c7d573e83` + this commit) |
| --- | --- |
| RED | `TestPutKeepsThisComputersInstructionSet` at `c7d573e83` + the test: `instructions_active_test.go:47: this computer's set was flipped by the sync: "work" is on, want the default it chose` |
| GREEN | same test green after the commit (ok 6.3s) |
| Ablation | `internal/library/carry.go` reverted to base, test kept → the same red line; restored → green |
| Touched packages, full | `go test ./internal/library ./internal/davsync -count=1` → ok (222.5s / 56.1s), zero reds — nothing to attribute to base |
| `-race` | named test green under `-race` (8.3s) |
| gofmt / `git diff --check` | clean |
| vet ×3 | darwin / linux / windows (`nogui`) all clean |
| build ×3 | darwin / linux / windows (`nogui`) all ok |
| git am | the patch below replays cleanly on `c7d573e83`; the replayed tree `9d6cdb0d883bf8deeb8fae2d92247d150cab6bcd` equals the branch head's tree; author kept |

NOT-RUNNABLE here: a real two-machine folder sync over WebDAV — the two-sandbox test drives the same `Put` a sync lands through.

Sibling faces (rg over every `Instructions.Active` writer): `SaveInstructions` (the UI choice — what this fix protects), `borrow.go:455` (explicit import = itself a choice, left as is), `backup.go:698` / davsync `bringLibrary` (both through this `Put`, covered). No other writer exists.

The report's second ask (a `Note` field on `EnvVar`) is a separate feature — left for you to take or not.

**Branch with the commit**: [`fix/7327-keep-instructions-active`](https://github.com/ggbdpq/magpie/tree/fix/7327-keep-instructions-active) (head `e99aeade96d119a23ef22d72339753dc7d33f5e3`). Patch, `git am` ready, sha256[:16] `c4e5b0c0c17c3608`:

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: MaxMaoSu <45323874+MaxMaoSu@users.noreply.github.com>
Date: Fri, 20 Nov 2026 23:27:18 +0800
Subject: [PATCH] library: a sync keeps this computer's active instruction set
 (#7327)

A bundle that arrives through the sync carried its sender's active
instruction set in, so every sync replaced the set this computer had
on: a laptop on default and a work machine on a company set, syncing
to one folder, flipped each other on every run.

The sets and their texts stay shared; which set is on is this
computer's choice, kept at the one place a bundle becomes local state:
Put keeps the local Active when this computer has chosen one, takes
the bundle's only when nothing is chosen here yet (a fresh computer
joins on the sender's set), or the set it uses is no longer among the
bundle's (removed on another computer). "" and the default set always
count as present, per setPath's own convention.

The fix and its shape are MaxMaoSu's (#7327); the test pins their two
cases and the fresh-computer join.

Run (darwin/arm64, upstream/main c7d573e83 + this commit):
- TestPutKeepsThisComputersInstructionSet red at the flip line before
  this commit; green after (count=1)
- go test ./internal/library ./internal/davsync: ok (222.5s / 56.1s)

Co-authored-by: ggbdpq <ggbdpq@gmail.com>
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/library/carry.go                    | 28 +++++-
 internal/library/instructions_active_test.go | 94 ++++++++++++++++++++
 2 files changed, 121 insertions(+), 1 deletion(-)
 create mode 100644 internal/library/instructions_active_test.go

diff --git a/internal/library/carry.go b/internal/library/carry.go
index fdfd9012d..afec6fb92 100644
--- a/internal/library/carry.go
+++ b/internal/library/carry.go
@@ -622,6 +622,21 @@ func filled(m, have map[string]string, secret func(string) bool) map[string]stri
 // skill whose files are as they are here is left alone. The subagents
 // replace the ones here too, unless b is from a magpie that didn't carry
 // them.
+// hasInstrSet is whether the bundle carries the instruction set id. ""
+// and the default set are always there: every library has the default
+// set, and an empty id means it is the one in use.
+func (b *Bundle) hasInstrSet(id string) bool {
+	if id == "" || id == defaultSet {
+		return true
+	}
+	for _, s := range b.Instructions.Sets {
+		if s.ID == id {
+			return true
+		}
+	}
+	return false
+}
+
 func Put(b *Bundle) (*Result, error) {
 	if err := b.check(); err != nil {
 		return nil, err
@@ -805,8 +820,19 @@ func Put(b *Bundle) (*Result, error) {
 				return err
 			}
 		}
+		// which set is on is this computer's own choice (#7327): a sync
+		// shares the sets and their texts, and keeps the set this
+		// computer has on — it takes the bundle's only when nothing is
+		// chosen here yet, or the set it uses is no longer among the
+		// bundle's (removed on another computer)
+		active := l.Instructions.Active
+		if len(l.Instructions.Sets) == 0 && active == "" {
+			active = b.Instructions.Active // nothing chosen here yet
+		} else if !b.hasInstrSet(active) {
+			active = b.Instructions.Active // the set it uses isn't in the bundle
+		}
 		l.Instructions = Instructions{Agents: slices.Sorted(slices.Values(orNone(b.Instructions.Agents))),
-			Sets: slices.Clone(b.Instructions.Sets), Active: b.Instructions.Active}
+			Sets: slices.Clone(b.Instructions.Sets), Active: active}
 		for i := range l.Instructions.Sets {
 			s := &l.Instructions.Sets[i]
 			s.File = files[s.ID]
diff --git a/internal/library/instructions_active_test.go b/internal/library/instructions_active_test.go
new file mode 100644
index 000000000..82de2633c
--- /dev/null
+++ b/internal/library/instructions_active_test.go
@@ -0,0 +1,94 @@
+package library
+
+import (
+	"encoding/json"
+	"testing"
+)
+
+// Which instruction set is on is this computer's own choice (#7327,
+// MaxMaoSu): a sync that applies a bundle shares the sets and their texts,
+// but keeps the set this computer has on. It takes the bundle's only when
+// nothing is chosen here yet (a fresh computer joining the folder), or the
+// set it uses is no longer among the bundle's (removed on another
+// computer).
+func TestPutKeepsThisComputersInstructionSet(t *testing.T) {
+	// the sender: two sets, "work" on
+	h1 := sandbox(t)
+	setUpLibrary(t, h1)
+	sent, err := Collect()
+	if err != nil {
+		t.Fatal(err)
+	}
+	carried := mustJSON(t, sent)
+
+	// this computer is on "default" while the sets are shared: the sync
+	// brings the bundle's texts and leaves this computer's choice alone
+	sandbox(t)
+	home, work := "Home rules.", "Company rules."
+	ok(t)(SaveInstructions(InstructionsChange{Shared: &home, Agents: []string{"claude", "codex"}}))
+	ok(t)(SaveInstructions(InstructionsChange{Create: &InstrSet{ID: "work", Name: "Work"}, Texts: map[string]*string{"work": &work}}))
+	var in Bundle
+	json.Unmarshal([]byte(carried), &in)
+	ok(t)(Put(&in))
+	v, err := ReadInstructions()
+	if err != nil {
+		t.Fatal(err)
+	}
+	on, taken := "", ""
+	for _, s := range v.Sets {
+		if s.Active {
+			on = s.ID
+		}
+		if s.ID == "work" {
+			taken = s.Text
+		}
+	}
+	if on != "" && on != defaultSet {
+		t.Errorf("this computer's set was flipped by the sync: %q is on, want the default it chose", on)
+	}
+	if taken != "Company rules." {
+		t.Errorf("the bundle's text for \"work\" didn't arrive: %q", taken)
+	}
+
+	// the set this computer uses is no longer in the bundle: it moves to
+	// the bundle's
+	sandbox(t)
+	solo := "Just this one."
+	ok(t)(SaveInstructions(InstructionsChange{Shared: &home, Agents: []string{"claude", "codex"}}))
+	ok(t)(SaveInstructions(InstructionsChange{Create: &InstrSet{ID: "solo", Name: "Solo"}, Texts: map[string]*string{"solo": &solo}, Activate: "solo"}))
+	var in2 Bundle
+	json.Unmarshal([]byte(carried), &in2)
+	ok(t)(Put(&in2))
+	v, err = ReadInstructions()
+	if err != nil {
+		t.Fatal(err)
+	}
+	on = ""
+	for _, s := range v.Sets {
+		if s.Active {
+			on = s.ID
+		}
+	}
+	if on != "work" {
+		t.Errorf("a set the bundle no longer carries left this computer on it: %q is on, want the bundle's \"work\"", on)
+	}
+
+	// a fresh computer joins on the sender's set
+	sandbox(t)
+	var in3 Bundle
+	json.Unmarshal([]byte(carried), &in3)
+	ok(t)(Put(&in3))
+	v, err = ReadInstructions()
+	if err != nil {
+		t.Fatal(err)
+	}
+	on = ""
+	for _, s := range v.Sets {
+		if s.Active {
+			on = s.ID
+		}
+	}
+	if on != "work" {
+		t.Errorf("a fresh computer didn't join on the sender's set: %q is on, want \"work\"", on)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

Attribution: the patch is @MaxMaoSu's (author kept on the commit); AI-written only carried it into this tree, wrote the pinning test, and ran the verification below.
