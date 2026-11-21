sessions, usage: a WorkBuddy, CodeBuddy or MiniMax Code folder whose projects or sessions folder is a link lists no session or call

## 现象

#2233 的形态不止落在 Codex 上。WorkBuddy 的 `~/.workbuddy/projects`、CodeBuddy Code 的 `~/.codebuddy/projects`、MiniMax Code 的 `~/.minimax/v2/sessions` 是链接时（Windows 上数据目录在另一盘走 junction，就是 #2233 里 `.codex` 的那种布局），Sessions 页一个 WorkBuddy 会话都不列，Usage 里 WorkBuddy、CodeBuddy Code、MiniMax Code 的调用、token 和成本全部消失。macOS 和 Linux 上 symlink 同样触发（WalkDir 对根的读法一样）。

## 最小复现

沙盒 HOME 里把 WorkBuddy 夹具的 `projects` 目录挪到旁边、原地放一个链接指过去（MiniMax 同款），修前的红：

```
$ go test -tags nogui -count=1 -run 'TestBuddyFilesThroughALinkedProjectsFolder|TestMiniMaxCallsThroughALinkedSessionsFolder' ./internal/sessions/
    link_root_test.go:40: want WorkBuddy's 3 session files behind the link, got 0: []
--- FAIL: TestBuddyFilesThroughALinkedProjectsFolder
    link_root_test.go:80: want MiniMax Code's one call on its own relay behind the link, got 0: []
--- FAIL: TestMiniMaxCallsThroughALinkedSessionsFolder
```

修后两个 PASS，把两处 walk 根改回去又各自变红。WorkBuddy 的 3 个会话文件经 `workbuddyFiles()` 供 Sessions 页；MiniMax 的中继调用经 `Calls()` 供 Usage（同一个测试走的是 `Calls(time.Time{})` 的全链路）。

## 根因

- `buddyFiles`（`internal/sessions/workbuddy.go:45`，WorkBuddy 的会话 + WorkBuddy/CodeBuddy 的调用共用）把 `filepath.Join(dir, "projects")` 直接交给 `filepath.WalkDir`；
- `minimaxCallFiles`（`internal/sessions/calls_minimax.go:55`）把 `minimaxSessions()` 直接交给 `filepath.WalkDir`。

`filepath.WalkDir` 只对根 lstat：链接不是目录，回调只发生一次、从不下潜，后面的每个会话文件都被跳过。对照同包其它读者：`ccFiles`（Claude Code/Qoder）和 `kimiFilesIn` 经 `readDirectory`/`SessionGlob`，其 `os.Stat` 跟随链接，所以不受影响；#2233 报的是 `codexFilesIn`，这两个兄弟函数不在它的范围内。

## 修法

两个 walk 根先过 `internal/proc.RealPath`（Windows 上 junction 也解析，正是 #2233 建议的同款；解析失败保持原路径，行为不变）。与 #2233 的 patch（`fix/codex-sessions-junction-mg7x3`，只动 `codexFilesIn`）合并后即覆盖全族。

## 验证

| 检查 | 结果 |
| --- | --- |
| 修前：两个新测试（d5847f19 与 c20bb76c 均红） | FAIL，见上 |
| 修后：两个新测试 | PASS |
| 回红：`git stash` 修复文件再跑 | 各自回到红，`stash pop` 后复绿 |
| `go test -tags nogui -count=1 ./internal/sessions/` | ok |
| `gofmt -l internal/` | 空 |
| `go vet ./...`；`GOOS=linux go vet -tags nogui ./...`；`GOOS=windows go vet ./...` | 过（仅已知的 `trayimage_darwin.go` cgo 警告） |
| `go build`；`GOOS=linux go build -tags nogui`；`GOOS=windows go build` | 过 |

### 没跑什么

- 真实 Windows junction：本机没有 Windows。测试用 symlink 建链（建不了就 skip），lstat 语义与 #2233 里实测的 junction（`lstat: ... isdir=false`）相同；Windows CI 只编译测试。
- 树中间的链接目录条目（如 `projects/<某个项目>` 本身是链接）不在本 patch 内：WalkDir 对链接条目同样不下潜。#2233 的 RealPath 修法也只解析根，这是全族剩余面，先不混进这一单。
- `ccFiles`/`hermes` 对条目的 `ModeSymlink` 检查不认识 Windows junction（Go 1.23+ 对 junction 的 lstat 是 ModeIrregular，非 ModeSymlink）——这是从 Go 源码推出的 Windows-only 形态，本机无法构造，未验证，不在此单范围。

patch（`git format-patch -1 --stdout`，基 `c20bb76c`）：

<details>
<summary>1a9c6ad8 sessions, usage: a WorkBuddy, CodeBuddy or MiniMax Code folder whose projects or sessions folder is a link lists no session or call (#2233)</summary>

```patch
From 1a9c6ad8bace94f73d559390ac6b289bb4da3bf5 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 03:17:07 +0800
Subject: [PATCH] sessions, usage: a WorkBuddy, CodeBuddy or MiniMax Code
 folder whose projects or sessions folder is a link lists no session or call
 (#2233)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

buddyFiles (WorkBuddy's sessions, and WorkBuddy's and CodeBuddy Code's
calls) handed its projects folder and minimaxCallFiles (MiniMax Code's
calls) its v2/sessions folder straight to filepath.WalkDir, which lstats
the root it is given, and a link is not a directory to it: it calls back
once for the root itself and never descends. On Windows a folder on
another drive is reached through a junction — #2233's shape, on Codex's
sessions folder — and the same user's junctioned WorkBuddy lists no
session on the Sessions page and no WorkBuddy, CodeBuddy or MiniMax Code
call in Usage; on macOS and Linux a symlink reads the same. The roots are
now walked where proc.RealPath resolves the link to (a junction on
Windows as well as a symlink), as #2233's fix walks Codex's.

Tests (internal/sessions/link_root_test.go): the projects folder of the
WorkBuddy fixture becomes a symlink to beside the home, and MiniMax's
v2/sessions the same; the sessions and the relay call must be read
behind the link. On main d5847f19 both fail ("want WorkBuddy's 3 session
files behind the link, got 0"; "want MiniMax Code's one call on its own
relay behind the link, got 0"); with the fix both pass, and fail again
with the two walk roots put back. Where a link cannot be made the tests
skip (Windows without a developer mode; CI compiles them only).

Run on origin/main c20bb76c (go1.25.5 darwin/arm64): go test -tags nogui
-count=1 ./internal/sessions ok; gofmt -l empty; go vet ./...,
GOOS=linux go vet -tags nogui ./..., GOOS=windows go vet ./...; go build,
GOOS=linux go build -tags nogui, GOOS=windows go build. Not tried on a
real Windows junction: no Windows box here; the junction's lstat is on
record in #2233 (isdir=false, the same read WalkDir's root gets).
---
 internal/sessions/calls_minimax.go  |  9 ++-
 internal/sessions/link_root_test.go | 85 +++++++++++++++++++++++++++++
 internal/sessions/workbuddy.go      | 11 +++-
 3 files changed, 103 insertions(+), 2 deletions(-)
 create mode 100644 internal/sessions/link_root_test.go

diff --git a/internal/sessions/calls_minimax.go b/internal/sessions/calls_minimax.go
index c5627ef8..b64f45b7 100644
--- a/internal/sessions/calls_minimax.go
+++ b/internal/sessions/calls_minimax.go
@@ -12,6 +12,7 @@ import (
 	"strings"
 
 	"github.com/yetone/magpie/internal/appdir"
+	"github.com/yetone/magpie/internal/proc"
 )
 
 // MiniMax Code's calls (#1605, LukeZ1988: MiniMax Code was missing from
@@ -52,7 +53,13 @@ const mcodeGateway = "custom_provider:magpie"
 // its message_id, and Calls counts an id once.
 func minimaxCallFiles() []file {
 	var out []file
-	filepath.WalkDir(minimaxSessions(), func(p string, d os.DirEntry, err error) error {
+	// walked where it really is when the sessions folder is a link (#2233),
+	// as buddyFiles walks its projects folder
+	root := minimaxSessions()
+	if real, err := proc.RealPath(root); err == nil {
+		root = real
+	}
+	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
 		if err != nil || d.IsDir() {
 			return nil
 		}
diff --git a/internal/sessions/link_root_test.go b/internal/sessions/link_root_test.go
new file mode 100644
index 00000000..f797dab9
--- /dev/null
+++ b/internal/sessions/link_root_test.go
@@ -0,0 +1,85 @@
+package sessions
+
+import (
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+)
+
+// linkThrough moves the folder at link to real and leaves a link in its
+// place, the way a folder on another drive is reached: a symlink elsewhere,
+// a junction on Windows (#2233). Skips where a link cannot be made.
+func linkThrough(t *testing.T, link, real string) {
+	t.Helper()
+	if err := os.Rename(link, real); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.Symlink(real, link); err != nil {
+		os.Rename(real, link)
+		t.Skipf("no link: %v", err)
+	}
+}
+
+// A WorkBuddy folder whose projects folder is a link lists its sessions as
+// they are (#2233's shape, on WorkBuddy's own folder), and CodeBuddy's are
+// read through its link too.
+func TestBuddyFilesThroughALinkedProjectsFolder(t *testing.T) {
+	claude, _ := setup(t)
+	home := filepath.Join(filepath.Dir(claude), "home")
+	outside := filepath.Dir(claude)
+
+	wb := filepath.Join(home, ".workbuddy")
+	copyTree(t, "testdata/workbuddy", wb)
+	wbReal := filepath.Join(outside, "workbuddy-projects")
+	linkThrough(t, filepath.Join(wb, "projects"), wbReal)
+	wbReal, _ = filepath.EvalSymlinks(wbReal) // /var is /private/var on macOS
+	fs := workbuddyFiles()
+	if len(fs) != 3 {
+		t.Fatalf("want WorkBuddy's 3 session files behind the link, got %d: %+v", len(fs), fs)
+	}
+	for _, f := range fs {
+		if f.agent != "workbuddy" || !f.main || !strings.HasPrefix(f.path, wbReal) {
+			t.Fatalf("workbuddy session behind the link: %+v", f)
+		}
+	}
+
+	cb := filepath.Join(home, ".codebuddy")
+	copyTree(t, "testdata/codebuddy", cb)
+	cbReal := filepath.Join(outside, "codebuddy-projects")
+	linkThrough(t, filepath.Join(cb, "projects"), cbReal)
+	cbReal, _ = filepath.EvalSymlinks(cbReal)
+	cfs := buddyFiles("codebuddy", CodeBuddyDir())
+	if len(cfs) != 2 {
+		t.Fatalf("want CodeBuddy's 2 session files behind the link, got %d: %+v", len(cfs), cfs)
+	}
+	for _, f := range cfs {
+		if f.agent != "codebuddy" || !strings.HasPrefix(f.path, cbReal) {
+			t.Fatalf("codebuddy session behind the link: %+v", f)
+		}
+	}
+}
+
+// MiniMax Code's calls are read when its v2/sessions folder is a link
+// (#2233's shape, on MiniMax's own folder).
+func TestMiniMaxCallsThroughALinkedSessionsFolder(t *testing.T) {
+	claude, _ := setup(t)
+	dir := filepath.Join(filepath.Dir(claude), "elsewhere")
+	t.Setenv("MINIMAX_DATA_DIR", dir)
+	copyTree(t, "testdata/minimax", dir)
+	mmReal := filepath.Join(dir, "v2", "sessions-elsewhere")
+	linkThrough(t, filepath.Join(dir, "v2", "sessions"), mmReal)
+	var got []Call
+	for _, c := range Calls(time.Time{}) {
+		if c.Agent == "minimax-code" {
+			got = append(got, c)
+		}
+	}
+	if len(got) != 1 {
+		t.Fatalf("want MiniMax Code's one call on its own relay behind the link, got %d: %+v", len(got), got)
+	}
+	if c := got[0]; c.Model != "m2" || c.Upstream != "custom_provider:relay" {
+		t.Fatalf("model %q upstream %q", c.Model, c.Upstream)
+	}
+}
diff --git a/internal/sessions/workbuddy.go b/internal/sessions/workbuddy.go
index 9422e007..aeb2b07c 100644
--- a/internal/sessions/workbuddy.go
+++ b/internal/sessions/workbuddy.go
@@ -10,6 +10,7 @@ import (
 	"strings"
 
 	"github.com/yetone/magpie/internal/appdir"
+	"github.com/yetone/magpie/internal/proc"
 )
 
 // WorkBuddy (Tencent's desktop agent) keeps its sessions much as Claude
@@ -44,7 +45,15 @@ func workbuddyFiles() []file { return buddyFiles("workbuddy", WorkBuddyDir()) }
 // or CodeBuddy Code's, which keeps them the same way.
 func buddyFiles(agent, dir string) []file {
 	var out []file
-	filepath.WalkDir(filepath.Join(dir, "projects"), func(p string, d os.DirEntry, err error) error {
+	// A projects folder that is a link — how a WorkBuddy folder on another
+	// drive is reached on Windows (#2233) — is walked where it really is:
+	// WalkDir lstats its root, a link is not a directory to it, and every
+	// session behind it would be missed.
+	root := filepath.Join(dir, "projects")
+	if real, err := proc.RealPath(root); err == nil {
+		root = real
+	}
+	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
 		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
 			return nil
 		}
-- 
2.50.1 (Apple Git-155)
```

</details>

分支：https://github.com/ggbdpq/magpie/tree/hunt22-x3-linked-session-folders

如果这个方向可以，请保留我（ggbdpq）的作者署名合入。

Generated-by: GLM-5.3-Flash (ZCode)
