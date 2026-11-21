Verified @SkyJiashu's fix (cc1cb76 on [their fork](https://github.com/SkyJiashu/magpie/tree/fix/win10-conpty-bracketed-paste)) on today's main (`ab98228cc`): it applies as is and the full claudetui suite passes. The on-machine evidence is already in this thread from two independent Windows 10 machines, so I'm posting a verification of their commit rather than a new patch — the commit below is SkyJiashu's unchanged, replayed on current main.

**What I verified**

- Byte integrity: their branch head `cc1cb76d8` is one commit, one file (`internal/claudetui/child_windows.go`, +41/−7), exactly as described in their comment.
- Freshness: no commit touched `internal/claudetui/child_windows.go` between their base (`2d5d1c1d2`) and today's tip (`ab98228cc`), so it replays with zero drift.
- Review: every call site (`rg -n "CreatePseudoConsole|ClosePseudoConsole" internal/` → all four in that one file) is rerouted through the resolver — the kernel32 probe in `start`, the create call, the close on the `startIn` error path, and `closeConsole`. The fallback covers each failure mode I could find (folder absent, `OpenConsole.exe` missing, either proc not found, `os.Executable` error) and lands on kernel32, i.e. today's behavior, never worse. The `windows.Coord` marshalling (`*(*uint32)(unsafe.Pointer(&size))`) matches x/sys's own conversion (two int16s, little-endian), and the returned HRESULT is wrapped as `syscall.Errno(r)`, value-preserving like x/sys's wrapper.

| Check | Result |
| --- | --- |
| `git am` on `ab98228cc` | applies; tree identical to the branch head (`e1dab4d948ea3075`) |
| `GOOS=windows go build ./internal/claudetui/` | clean |
| `GOOS=windows go vet ./internal/claudetui/` | clean |
| `GOOS=linux` / `GOOS=darwin go build ./internal/claudetui/` | clean (file is windows-constrained) |
| `go test ./internal/claudetui/ -count=1` (macOS) | ok 125.803s, identical to base by construction |
| `gofmt -l internal/claudetui/` | clean |

**The remaining decision is which shape to land** — both variants are verified on real Windows 10, so this is a design call, not an evidence question:

- **A — this patch**: opt-in `<exe dir>/conpty/` loader. No bundled binaries, no build changes; users drop Microsoft's MIT-licensed `Microsoft.Windows.Console.ConPTY` pair in themselves. Works today, ships nothing.
- **B — @3leg0ocat's magpie-lite variant** (`conpty_bundle_windows.go` + `child_windows.go`, built with `-tags liteconpty`): embeds ConPTY 1.25.260930003, extracts to a versioned cache folder, and fails closed instead of silently falling back. Ships Windows 10 support out of the box, at the cost of embed + packaging changes and ~1.15 MiB per arch, plus the version-pinning/licensing policy that only @yetone can set.
- The issue body's transcript + `--resume` route (suggestion 2) is a bigger bridge change, independent of both.

---
**Source**: reported in this issue with on-machine measurements (6.3KB pasted → 336B recorded, `LOST n×1024` across three scenarios); independently confirmed by SkyJiashu and 3leg0ocat on Windows 10 19044/19045 with Windows Terminal's ConPTY.

**Red without the fix**: not reproducible on my host (macOS; the ConPTY loader is windows-only). The red is this thread's real-machine data: with Windows 10's own ConPTY (conhost 10.0.19041) 8KB/64KB pastes arrive as 75–124B, with Terminal's `conpty.dll` they arrive intact.

**Siblings**: `rg -n "CreatePseudoConsole|ClosePseudoConsole" internal/` → 4 sites, all in `internal/claudetui/child_windows.go`, all rerouted by the patch.

**When the read fails**: folder or DLL missing/unloadable, or `os.Executable()` errors → kernel32, exactly today's behavior. No fixture test added — exercising the loader needs a real Windows DLL.

**Not verified**: a real Windows 10 machine (my host is macOS); the error text of a failing `CreatePseudoConsole` call through the new wrapper.

**Attribution**: verification written with GLM-5.3-Flash (ZCode); the commit is SkyJiashu's unchanged — please keep them as the author or add `Co-authored-by: SkyJiashu <liaojiashu95@gmail.com>`.

**Branch with the commit**: [hunt-20261112-t1-5205](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5205) (head `929c479e5fb96514`, on main `ab98228cc`).

**Patch**: <details><summary>patch: claudetui: use a conpty folder beside the executable before Windows' own ConPTY (#5205) — git am applies it as is; SHA-256 first 16: ef76ec315fb6ff55</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: SkyJiashu <liaojiashu95@gmail.com>
Date: Sat, 7 Nov 2026 03:08:09 +0000
Subject: [PATCH] claudetui: use a conpty folder beside the executable before
 Windows' own ConPTY

Windows 10's conhost (10.0.19041) drops bracketed paste marks, so Claude Code
takes a long message as many pastes and submits only part of it (#5205).
Windows Terminal's conpty.dll with its OpenConsole.exe keeps them. When
<exe dir>/conpty holds both, CreatePseudoConsole and ClosePseudoConsole come
from it; otherwise from kernel32 as before, so nothing changes for anyone who
does not add the folder.
---
 internal/claudetui/child_windows.go | 48 ++++++++++++++++++++++++-----
 1 file changed, 41 insertions(+), 7 deletions(-)

diff --git a/internal/claudetui/child_windows.go b/internal/claudetui/child_windows.go
index ea2ce1dd5..9e8f04ae9 100644
--- a/internal/claudetui/child_windows.go
+++ b/internal/claudetui/child_windows.go
@@ -3,6 +3,7 @@ package claudetui
 import (
 	"fmt"
 	"os"
+	"path/filepath"
 	"sync"
 	"syscall"
 	"time"
@@ -27,9 +28,42 @@ type child struct {
 // remove (dropLeft).
 var endSignals = []os.Signal{os.Interrupt, syscall.SIGTERM}
 
+// pseudoConsole is where CreatePseudoConsole and ClosePseudoConsole come
+// from. Windows 10's own (conhost 10.0.19041) drops a paste's bracketed
+// paste marks, so Claude Code takes a long message as many pastes and
+// submits a part of it (yetone/magpie#5205); the ConPTY Windows Terminal
+// ships (conpty.dll, which runs the OpenConsole.exe beside it) keeps them.
+// dsh-cross: a conpty folder beside magpie's executable holding both is
+// used first; without it, the system's.
+type pseudoConsole struct{ create, close *windows.LazyProc }
+
+var console = sync.OnceValue(func() pseudoConsole {
+	if exe, err := os.Executable(); err == nil {
+		dir := filepath.Join(filepath.Dir(exe), "conpty")
+		if _, err := os.Stat(filepath.Join(dir, "OpenConsole.exe")); err == nil {
+			dll := windows.NewLazyDLL(filepath.Join(dir, "conpty.dll"))
+			if dll.NewProc("CreatePseudoConsole").Find() == nil && dll.NewProc("ClosePseudoConsole").Find() == nil {
+				return pseudoConsole{dll.NewProc("CreatePseudoConsole"), dll.NewProc("ClosePseudoConsole")}
+			}
+		}
+	}
+	k := windows.NewLazySystemDLL("kernel32.dll")
+	return pseudoConsole{k.NewProc("CreatePseudoConsole"), k.NewProc("ClosePseudoConsole")}
+})
+
+func createPseudoConsole(size windows.Coord, in, out windows.Handle, h *windows.Handle) error {
+	r, _, _ := console().create.Call(uintptr(*(*uint32)(unsafe.Pointer(&size))), uintptr(in), uintptr(out), 0, uintptr(unsafe.Pointer(h)))
+	if r != 0 {
+		return syscall.Errno(r)
+	}
+	return nil
+}
+
+func closePseudoConsole(h windows.Handle) { _, _, _ = console().close.Call(uintptr(h)) }
+
 func (s *shim) start(path string, args []string) error {
 	// Windows 10 before 1809 has none, and x/sys panics calling it there
-	if err := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find(); err != nil {
+	if err := console().create.Find(); err != nil {
 		return fmt.Errorf("no pseudo console on this Windows: %w", err)
 	}
 	// a .cmd (npm's shim) is run by cmd.exe, its arguments quoted as
@@ -53,9 +87,9 @@ func (s *shim) start(path string, args []string) error {
 		windows.CloseHandle(inW)
 		return err
 	}
-	var console windows.Handle
+	var pc windows.Handle
 	// wide, so a line of Claude Code's screen is a line
-	err := windows.CreatePseudoConsole(windows.Coord{X: screenCols, Y: screenRows}, inR, outW, 0, &console)
+	err := createPseudoConsole(windows.Coord{X: screenCols, Y: screenRows}, inR, outW, &pc)
 	// the console has its own of these
 	windows.CloseHandle(inR)
 	windows.CloseHandle(outW)
@@ -65,15 +99,15 @@ func (s *shim) start(path string, args []string) error {
 		out.Close()
 		return fmt.Errorf("a pseudo console: %w", err)
 	}
-	h, err := startIn(console, cmd.Path, line, childEnv(s.env...))
+	h, err := startIn(pc, cmd.Path, line, childEnv(s.env...))
 	if err != nil {
-		windows.ClosePseudoConsole(console)
+		closePseudoConsole(pc)
 		in.Close()
 		out.Close()
 		return err
 	}
 	s.pty = conpty{in: in, out: out}
-	s.proc, s.console = h, console
+	s.proc, s.console = h, pc
 	go func() {
 		_, _ = windows.WaitForSingleObject(h, windows.INFINITE)
 		var code uint32
@@ -153,7 +187,7 @@ func (c conpty) Write(p []byte) (int, error) { return c.in.Write(p) }
 // Windows 11 24H2, ClosePseudoConsole waits for its output to be read.
 func (s *shim) closeConsole() {
 	s.closeOnce.Do(func() {
-		go windows.ClosePseudoConsole(s.console)
+		go closePseudoConsole(s.console)
 	})
 }
 
-- 
2.50.1 (Apple Git-155)


```

</details>
