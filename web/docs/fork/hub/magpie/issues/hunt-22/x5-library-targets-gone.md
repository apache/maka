# library: 已卸载（只剩配置目录）的 agent 仍被列为技能/MCP/指令的写入目标——#2177 修复自己注明的未覆盖面

## 现象

把一个 agent 卸载、只留下它的配置目录（比如 #2173 里那个只有 37 字节 `~/.hermes/config.yaml` 的 Hermes）之后，Agents 页已经按 `d0fcb8bc` 的修复把它标成 "CLI not found" 并收起全部设置，但 **Library 页仍把它列为可写入对象**：技能、"给 MCP 服务器"、共享指令的下拉里都有它，勾选后 sync 照样往一个没有任何程序会读的目录里写，并报告成功。

`d0fcb8bc` 的提交说明在"Not covered"里自己点名了这个面：*library.Targets (Skills/MCP) still lists a gone agent as a place to give skills to*。本帖就是把这个缺口补上。

## 最小复现

`TestTargetsLeaveGoneAgentsOut`（`internal/library/targets_gone_test.go`）。沙盒 HOME 里只放报告者那份 `~/.hermes/config.yaml`，修复前：

```
--- FAIL: TestTargetsLeaveGoneAgentsOut (0.83s)
    targets_gone_test.go:21: hermes is a target with its CLI gone: [claude codex gemini opencode mimocode deveco pi goose cursor copilot crush dsh hermes]
```

`git stash push -- internal/library/targets.go` 后同一测试仍是这样 FAIL（夹具改动独立于修复，测试的牙是真的）；`stash pop` 后 PASS。

## 根因

`internal/library/targets.go` 的 `Targets()`（所有库写入面的共同上游：页面视图 `readView`、`sync`、market 引入）对 `agent.Detected()` 的每个结果只做了「文件占位」检查（`t.open()`），没有套 `d0fcb8bc` 引入的卸载判定。同一提交已经给了三处消费方同样的门（GUI 行、`connectKind`、TUI 的 `newModel`、`magpie ls`），漏了这一处——按「修一个缺陷要到达每个兄弟」的仓规，这是它的最后一个兄弟。

## 修法

`Targets()` 里对每个检测到的 agent 补一道 `a.CLIMissing() → continue`。`CLIMissing` 判不了的一律返回 false（WSL、插件 agent、自定义 detect、OpenCode/Goose 非 macOS），所以门只落在 magpie 能确定的卸载上，不影响任何「说不准」的机器。

测试夹具随语义更新：沙盒里被当夹具的 agent 现在把 CLI 放在目录旁边（模拟真实安装的机器；`library_test.go` 的 `sandbox()` 与 `holdCLI` 助手，以及 `TestAgentMCPFiles`/`TestCodeBuddyMCPFile`/`TestHermesMCP*`/`TestToolsOffInTheEntry`/`TestOmoTarget`/`TestPiInstructionsFirstThere`/`TestAgentsSkillsFolders`/`TestSiblingInstructionsMore` 的各自夹具）；用「删目录」模拟 agent 卸载的两个测试（`TestImportSharedSkillForKimi`、`TestSharedAgentsSkills`）连同沙盒 CLI 一起删。`TestAgentsSkillsFolders` 原本断言「目录在即为目标」的 hermes 行改为显式装上 CLI 后断言——该断言所依赖的状态在修复后只有卸载一种来路，属于本修要改掉的断言；若维护者认为「往残留目录写技能等重装后生效」是有意行为，否掉这条即可，红测试和门是独立的小改动，方便回退。

## 验证

| 命令 | 结果 |
| --- | --- |
| 修复前 `TestTargetsLeaveGoneAgentsOut` | FAIL，hermes 在目标列表里（输出见上） |
| `git stash` 只摘 `targets.go` 再跑 | 仍 FAIL（夹具独立，测试有牙） |
| `stash pop` 后同一测试 | PASS |
| `go test -tags nogui -count=1 -timeout 40m ./internal/library/` | PASS（67s） |
| `go test -tags nogui -count=1 ./internal/tui/ ./internal/cli/` | PASS（`TestLibraryPage` 依赖库目标，随夹具转绿） |
| `go test -tags nogui -count=1 -timeout 30m ./internal/gui/` | PASS（167s） |
| `gofmt -l internal/` | 无输出 |
| `go vet ./internal/library ./internal/tui`（darwin）+ `GOOS=linux vet -tags nogui` + `GOOS=windows vet` | 均无输出 |
| `go build` darwin / linux `-tags nogui` / windows | 均通过（darwin 的 `trayimage_darwin.go` cgo `-Wenum-conversion` 是已知环境警告） |

## 没跑什么

- 真机上对真实已卸载 agent 的 Library 页截图级复验（判定点与 TUI/GUI 同一函数 `CLIMissing`，单测覆盖其行为）。
- `go test ./...` 全仓（跑过的是 library、tui、cli、gui 四个受影响包）。
- RTK 页与 hooks 的兄弟面没有动：`internal/library/rtk.go` 的 `detected()` 与 `hooks.go` 的 `hookAgents` 各有名单，若维护者希望同一门也盖过去，值得单独核（本帖只动 `Targets()` 这一个共同上游）。

分支：[ggbdpq/magpie `hunt22-x5-library-targets-gone`](https://github.com/ggbdpq/magpie/tree/hunt22-x5-library-targets-gone)（基 upstream/main `d5847f19`）。本地提交作者是 ggbdpq，合入时请保留（git am）。

Generated-by: GLM-5.3-Flash (ZCode)

## 补丁

<details>
<summary>git format-patch -1 --stdout（b6e0bdc4，11 文件）</summary>
From b6e0bdc4e134131d4c60b3e221ab6f855047a508 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 03:39:06 +0800
Subject: [PATCH] library: an agent gone for its CLI isn't a target to give
 skills, MCP or instructions to

What changed: Targets() left out nothing when an agent's folder was all
that was here, so the Library page kept offering a skill, an MCP server
or instructions to an agent uninstalled outside magpie (#2177, #2173),
and sync kept writing to it. It now skips CLIMissing agents, as the
Agents page (d0fcb8bc), the TUI and `magpie ls` already do.

Test fixtures that wrote an agent's folder alone now put its CLI beside
it (sandbox's fixture agents, omp, Cline, CodeBuddy, OmO, Hermes), and
the ones that model "agent off" take the CLI of the sandbox out with the
folder. TestTargetsLeaveGoneAgentsOut is red without the fix.

Run: go test -tags nogui ./internal/library ./internal/tui ./internal/cli
./internal/gui; gofmt -l clean; go vet on darwin, linux (-tags nogui)
and windows for the touched packages; go build on the three.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/library.md             |  2 +-
 internal/library/agent_mcp_test.go     |  4 ++++
 internal/library/agent_skills_test.go  | 10 ++++++++++
 internal/library/hermes_mcp_test.go    |  4 +++-
 internal/library/library_test.go       | 25 +++++++++++++++++++++++++
 internal/library/mcp_tools_off_test.go |  1 +
 internal/library/omo_test.go           |  1 +
 internal/library/shared_skills_test.go |  5 ++++-
 internal/library/targets.go            |  6 ++++++
 internal/library/targets_gone_test.go  | 23 +++++++++++++++++++++++
 internal/tui/tui_test.go               | 11 ++++++++++-
 11 files changed, 88 insertions(+), 4 deletions(-)
 create mode 100644 internal/library/targets_gone_test.go

diff --git a/docs/subsystems/library.md b/docs/subsystems/library.md
index 0ef2ba81..e0c3f0c8 100644
--- a/docs/subsystems/library.md
+++ b/docs/subsystems/library.md
@@ -14,7 +14,7 @@ agents RTK, a CLI that cuts shell output down before the model reads it.
 | --- | --- | --- |
 | library.json | `Library` holds the instruction sets, the MCP servers, the skills, the projects, skill groups and copy settings. `Applied` records what magpie last wrote into each agent, so it only ever takes away its own. The instruction texts and skill folders live under `Dir` (`library/` in magpie's config folder). | [`library.go`](../../internal/library/library.go) |
 | One change | `change` locks the library, loads it, applies one edit, saves, syncs every agent and saves again. Every exported mutation (`SaveServer`, `InstallSkills`, `SetSkillHow` and the rest) goes through it. One change runs at a time, whether from the page or the CLI. | [`library.go`](../../internal/library/library.go) |
-| Targets | `Targets` lists the detected agents (`agent.Detected`), plus apps like Claude Desktop, with where each keeps its instructions file (and an `Override` it reads instead), its MCP file and its skills folder. An agent in a running WSL distro has its places under the distro's home (`wslTargetOf`): Claude Code, Codex, Pi and OmO each by its own rule, and every agent that keeps all of them in its own folder (Hermes Agent, omp, OpenCode, Droid and the rest of `ownFolder`, #1323) by the same rule as on this machine, its MCP file marked as WSL's so a Windows program isn't given to it. An agent a plugin adds (`a.Plugin`) has the places its plugin's `agent.library` names (`pluginTarget`): an instructions file, an MCP file in one of `agentplug.MCPFormats` (each the `mcpFormat` of the agent it is named for, `pluginMCP`) and a skills folder, `~` and `$VAR` expanded as its config is; one that names none is no target. Before, a plugin's agent got models and keys only. | [`targets.go`](../../internal/library/targets.go) |
+| Targets | `Targets` lists the detected agents (`agent.Detected`) whose CLI isn't gone (`CLIMissing`: an uninstall that left the folder behind, #2177, is given nothing the agent can't read), plus apps like Claude Desktop, with where each keeps its instructions file (and an `Override` it reads instead), its MCP file and its skills folder. An agent in a running WSL distro has its places under the distro's home (`wslTargetOf`): Claude Code, Codex, Pi and OmO each by its own rule, and every agent that keeps all of them in its own folder (Hermes Agent, omp, OpenCode, Droid and the rest of `ownFolder`, #1323) by the same rule as on this machine, its MCP file marked as WSL's so a Windows program isn't given to it. An agent a plugin adds (`a.Plugin`) has the places its plugin's `agent.library` names (`pluginTarget`): an instructions file, an MCP file in one of `agentplug.MCPFormats` (each the `mcpFormat` of the agent it is named for, `pluginMCP`) and a skills folder, `~` and `$VAR` expanded as its config is; one that names none is no target. Before, a plugin's agent got models and keys only. | [`targets.go`](../../internal/library/targets.go) |
 | Sync | `sync` writes each target's instructions and MCP servers. It then takes edits made in agents' skill copies into the library (`takeEdits`) and links or copies the skills. `~/.agents/skills` goes first, so an agent that reads it gets no second link. Then it syncs projects' skills. | [`sync.go`](../../internal/library/sync.go) |
 | Projects | A project (`Project`) is a folder given some of the library's skills and MCP servers, each for some agents. A skill is linked (or copied) into the folder the agent reads a project's skills from (`projectSkillsDirs`): `.claude/skills` for Claude Code, `.qoder/skills` for Qoder and Qoder CN, `.codebuddy/skills` for CodeBuddy Code, `.commandcode/skills` for Command Code, and `.agents/skills` for Codex, Gemini CLI, OpenCode, Pi, Cursor, Copilot CLI, Antigravity, Kimi, Goose, Grok, Droid and Cline. A server is written into the file the agent reads a project's servers from (`projectMCPFiles`), in the shape its user-wide file has: `.mcp.json` for Claude Code and CodeBuddy Code (CodeBuddy's `mcp.json` when the project has that and no `.mcp.json`, since it reads only the first of the two), `.codex/config.toml`, `.gemini/settings.json`, `.cursor/mcp.json`, `opencode.json`, `.zcode/config.json`, `.pi/mcp.json`, `.qoder/settings.json`'s `mcpServers` for Qoder and Qoder CN, and `.factory/mcp.json` for Droid. Claude Code, Qoder and CodeBuddy ask the user to approve a project's server before using it. Only targets whose vendor source or docs name them are listed (each map's comment cites them); an agent with none (Copilot CLI's MCP, Zed, WorkBuddy, Command Code's MCP, whose `.mcp.json` has its own `transport` shape) can't be picked for a project (eirc on Discord). `Placed`, `Wrote`, `Made` and `MadeFiles` record what magpie put there, the only things it takes away, and what it made is listed in the project's `.gitignore`. | [`projects.go`](../../internal/library/projects.go), [`project_mcp.go`](../../internal/library/project_mcp.go) |
 | Instructions | magpie's part of an agent's instructions file sits between two marker lines. The rest of the file is the user's. Several named sets can be switched between (#106). A set can be kept in a file of the user's own instead of `instruction-sets/` (`InstrSet.File`, 新v学员 on Discord): `~/.agents/AGENTS.md`, which Droid and omp read too. `textPath` reads it, `putText` keeps it aside and writes it but never removes it, removing the set lets go of it, and `linkable` refuses a file magpie writes into (an agent's own instructions, a file with the marker line), the library's own and another set's. The app's `KeepLinked` looks at the file every 30 s and writes a change into the agents (`SyncLinked`). `Collect` carries the set's text, not where its file is; `Put` keeps this computer's file for the set and never empties it for a text not carried. | [`instructions.go`](../../internal/library/instructions.go) |
diff --git a/internal/library/agent_mcp_test.go b/internal/library/agent_mcp_test.go
index 9eda87a4..6846739c 100644
--- a/internal/library/agent_mcp_test.go
+++ b/internal/library/agent_mcp_test.go
@@ -175,6 +175,9 @@ func TestAgentMCPFiles(t *testing.T) {
 			}
 			p := filepath.Join(h, c.file)
 			write(t, p, c.user)
+			// omp, Cline and CodeBuddy have an install command, so with the
+			// MCP file alone each is gone (#2177): its CLI beside the folder
+			holdCLI(t, h, map[string]string{"omp": "omp", "cline": "cline", "codebuddy": "codebuddy"}[c.id])
 			parse := func() map[string]entry {
 				t.Helper()
 				var doc map[string]any
@@ -294,6 +297,7 @@ func TestAgentMCPFiles(t *testing.T) {
 func TestCodeBuddyMCPFile(t *testing.T) {
 	h := sandbox(t)
 	write(t, filepath.Join(h, ".codebuddy/models.json"), "")
+	holdCLI(t, h, "codebuddy") // the folder alone is gone (#2177)
 	tg := targetByID("codebuddy")
 	if tg == nil || tg.MCP == nil || tg.MCP.Path != filepath.Join(h, ".codebuddy/.mcp.json") {
 		t.Fatalf("with no file: %+v", tg)
diff --git a/internal/library/agent_skills_test.go b/internal/library/agent_skills_test.go
index cce98eef..2c114b7f 100644
--- a/internal/library/agent_skills_test.go
+++ b/internal/library/agent_skills_test.go
@@ -20,6 +20,10 @@ func TestAgentsSkillsFolders(t *testing.T) {
 		".hermes/config.yaml", ".grok/config.toml", ".qoder/settings.json", ".workbuddy/models.json", ".fx/settings.json", ".config/devin/config.json"} {
 		write(t, filepath.Join(h, f), "")
 	}
+	// hermes and Cline installed: the CLI beside the folder (the folder
+	// alone is gone, #2177, and no target — TestTargetsLeaveGoneAgentsOut)
+	holdCLI(t, h, "hermes")
+	holdCLI(t, h, "cline")
 	want := map[string]string{
 		"kimi":        ".agents/skills",
 		"goose":       ".agents/skills",
@@ -133,7 +137,11 @@ func TestSharedSkillsWrittenOnce(t *testing.T) {
 // a word of its "own skill by that name".
 func TestImportSharedSkillForKimi(t *testing.T) {
 	h := sandbox(t)
+	// goose off: its folder and, since the sandbox puts the agents' CLIs
+	// beside them (#2177), its CLI too
 	os.RemoveAll(filepath.Join(h, ".config/goose"))
+	os.Remove(filepath.Join(h, "bin/goose"))
+	os.Remove(filepath.Join(h, "bin/goose.exe"))
 	write(t, filepath.Join(h, ".kimi/config.toml"), "")
 	shared := filepath.Join(h, ".agents/skills/orca")
 	skill(t, shared, "orca", "Orca")
@@ -290,6 +298,7 @@ func TestSiblingInstructionsMore(t *testing.T) {
 	write(t, filepath.Join(h, ".qoder", "settings.json"), "{}")
 	write(t, filepath.Join(h, ".commandcode", "settings.json"), "{}")
 	write(t, filepath.Join(h, ".codebuddy", "settings.json"), "{}")
+	holdCLI(t, h, "codebuddy") // the folder alone is gone (#2177)
 	write(t, filepath.Join(h, ".codebuddy", "CODEBUDDY.mdc"), "# Mine\n")
 	want := map[string]string{
 		"qoder":       filepath.Join(h, ".qoder", "AGENTS.md"),
@@ -375,6 +384,7 @@ func TestPiInstructionsFirstThere(t *testing.T) {
 	pi := filepath.Join(h, ".pi", "agent")
 	omo := filepath.Join(h, ".omo", "agent")
 	write(t, filepath.Join(omo, "settings.json"), "{}")
+	holdCLI(t, h, "omo") // the folder alone is gone (#2177)
 	for _, d := range []string{pi, omo} {
 		if tg := targetByID(map[string]string{pi: "pi", omo: "omo"}[d]); tg == nil ||
 			tg.Instructions != filepath.Join(d, "AGENTS.md") || tg.Override != filepath.Join(d, "AGENTS.override.md") {
diff --git a/internal/library/hermes_mcp_test.go b/internal/library/hermes_mcp_test.go
index 07877d9d..34dc82e2 100644
--- a/internal/library/hermes_mcp_test.go
+++ b/internal/library/hermes_mcp_test.go
@@ -35,6 +35,7 @@ func TestHermesMCP(t *testing.T) {
 	t.Setenv("HERMES_HOME", dir)
 	p := filepath.Join(dir, "config.yaml")
 	write(t, p, hermesConfig)
+	holdCLI(t, h, "hermes") // the config alone is gone (#2173, #2177)
 
 	tg := targetByID("hermes")
 	if tg == nil || tg.MCP == nil || tg.MCP.Path != p {
@@ -130,9 +131,10 @@ func TestHermesMCP(t *testing.T) {
 
 // A server Hermes has that the library doesn't is found, to bring in.
 func TestHermesMCPFound(t *testing.T) {
-	sandbox(t)
+	h := sandbox(t)
 	dir := appdir.HermesHome()
 	write(t, filepath.Join(dir, "config.yaml"), strings.Replace(hermesConfig, "toolsets:", "  remote:\n    url: https://r.example/sse\n    transport: sse\ntoolsets:", 1))
+	holdCLI(t, h, "hermes") // the config alone is gone (#2173, #2177)
 	l, err := load()
 	if err != nil {
 		t.Fatal(err)
diff --git a/internal/library/library_test.go b/internal/library/library_test.go
index 4ac2e4ce..eda02723 100644
--- a/internal/library/library_test.go
+++ b/internal/library/library_test.go
@@ -35,6 +35,18 @@ func sandbox(t *testing.T) string {
 	bin := filepath.Join(h, "bin")
 	testenv.Program(t, filepath.Join(bin, "gemini"), "#!/bin/sh\n")
 	write(t, filepath.Join(bin, "gemini.exe"), "")
+	// the other fixture agents' CLIs beside their folders, as on a machine
+	// where they are really installed: with the folder alone each would be
+	// gone (CLIMissing, #2177) and no target of the library's. Only these:
+	// a stand-in for an agent no folder here keeps would have it detected
+	// by its binary alone in every test.
+	for _, name := range []string{
+		"claude", "codex", "opencode", "mimo", "deveco", "pi", "goose",
+		"cursor-agent", "copilot", "crush", "dsh",
+	} {
+		testenv.Program(t, filepath.Join(bin, name), "#!/bin/sh\n")
+		write(t, filepath.Join(bin, name+".exe"), "")
+	}
 	t.Setenv("PATH", bin)
 	// never the machine's global node_modules
 	roots := piGlobalRoots
@@ -73,6 +85,19 @@ func write(t *testing.T, p, s string) {
 	}
 }
 
+// holdCLI puts a CLI of the given name in the sandbox's bin, beside the
+// agent folder the test wrote: the folder alone is an uninstall that left
+// it behind (#2177), and no target of the library's. An empty name is
+// nothing, for an agent with no install command, which is never gone.
+func holdCLI(t *testing.T, h, bin string) {
+	t.Helper()
+	if bin == "" {
+		return
+	}
+	testenv.Program(t, filepath.Join(h, "bin", bin), "#!/bin/sh\n")
+	write(t, filepath.Join(h, "bin", bin+".exe"), "")
+}
+
 func read(t *testing.T, p string) string {
 	t.Helper()
 	b, err := os.ReadFile(p)
diff --git a/internal/library/mcp_tools_off_test.go b/internal/library/mcp_tools_off_test.go
index 6c630c78..e4662e29 100644
--- a/internal/library/mcp_tools_off_test.go
+++ b/internal/library/mcp_tools_off_test.go
@@ -58,6 +58,7 @@ func TestToolsOffInTheEntry(t *testing.T) {
 	h := sandbox(t)
 	t.Setenv("HERMES_HOME", filepath.Join(h, "hermes-home"))
 	write(t, filepath.Join(h, "hermes-home", "config.yaml"), "model:\n  default: x\n")
+	holdCLI(t, h, "hermes") // the config alone is gone (#2173, #2177)
 	agents := []string{"codex", "crush", "gemini", "hermes"}
 	keys := map[string]string{"codex": "disabled_tools", "crush": "disabled_tools", "gemini": "excludeTools", "hermes": "exclude"}
 	ok(t)(SaveServer("", Server{Name: "fs", Transport: "stdio", Command: "npx", Args: []string{"-y", "@mcp/fs"}, Agents: agents}))
diff --git a/internal/library/omo_test.go b/internal/library/omo_test.go
index 8e2e0900..b07692c1 100644
--- a/internal/library/omo_test.go
+++ b/internal/library/omo_test.go
@@ -14,6 +14,7 @@ func TestOmoTarget(t *testing.T) {
 	h := sandbox(t)
 	d := filepath.Join(h, ".omo", "agent")
 	write(t, filepath.Join(d, "settings.json"), "{}")
+	holdCLI(t, h, "omo") // the folder alone is gone (#2177)
 	tg := targetByID("omo")
 	if tg == nil || tg.MCP == nil || tg.MCP.Path != filepath.Join(d, "mcp.json") || tg.MCP.Format != fmtPiNative ||
 		tg.Instructions != filepath.Join(d, "AGENTS.md") || tg.Skills != filepath.Join(d, "skills") {
diff --git a/internal/library/shared_skills_test.go b/internal/library/shared_skills_test.go
index 3e0063f4..610b142d 100644
--- a/internal/library/shared_skills_test.go
+++ b/internal/library/shared_skills_test.go
@@ -24,8 +24,11 @@ func symlink(t *testing.T, to, at string) {
 // shared folder as it is.
 func TestSharedAgentsSkills(t *testing.T) {
 	h := sandbox(t)
-	// no agent here whose own folder the shared one is (Goose's)
+	// no agent here whose own folder the shared one is (Goose's): its CLI
+	// of the sandbox too, since that alone would have it here (#2177)
 	os.RemoveAll(filepath.Join(h, ".config/goose"))
+	os.Remove(filepath.Join(h, "bin/goose"))
+	os.Remove(filepath.Join(h, "bin/goose.exe"))
 	shared := filepath.Join(h, ".agents/skills")
 	// a skill kept elsewhere (D:\aimer-skills\…) linked into the shared folder
 	ext := filepath.Join(h, "aimer-skills/grilling")
diff --git a/internal/library/targets.go b/internal/library/targets.go
index c5a7273b..9b780674 100644
--- a/internal/library/targets.go
+++ b/internal/library/targets.go
@@ -662,6 +662,12 @@ func Targets() []*Target {
 		if own[a.ID] {
 			continue
 		}
+		// an uninstall that left the folder behind (#2177, #2173): the
+		// Agents page calls the agent gone and offers none of its settings,
+		// since nothing reads them; the library gives nothing to it either
+		if a.CLIMissing() {
+			continue
+		}
 		if t := targetOf(a); t != nil && t.open() {
 			out = append(out, t)
 		}
diff --git a/internal/library/targets_gone_test.go b/internal/library/targets_gone_test.go
new file mode 100644
index 00000000..fd04b5e2
--- /dev/null
+++ b/internal/library/targets_gone_test.go
@@ -0,0 +1,23 @@
+package library
+
+import (
+	"path/filepath"
+	"slices"
+	"testing"
+)
+
+// An agent uninstalled outside magpie leaves its folder behind (#2177,
+// #2173): the Agents page calls it gone (CLIMissing) and offers none of
+// its settings, since nothing reads them. The Library kept it as a place
+// to give skills, MCP servers and instructions to, and sync carried on
+// writing there.
+func TestTargetsLeaveGoneAgentsOut(t *testing.T) {
+	h := sandbox(t)
+	// Hermes by its config.yaml alone (the reporter's 37 bytes): its
+	// folder is kept by nothing here — no hermes on the sandbox's PATH,
+	// no hermes-agent checkout beside the config
+	write(t, filepath.Join(h, ".hermes", "config.yaml"), "custom_providers: []\nmcp_servers: {}\n")
+	if got := ids(Targets()); slices.Contains(got, "hermes") {
+		t.Fatalf("hermes is a target with its CLI gone: %v", got)
+	}
+}
diff --git a/internal/tui/tui_test.go b/internal/tui/tui_test.go
index 89f24a48..77df3250 100644
--- a/internal/tui/tui_test.go
+++ b/internal/tui/tui_test.go
@@ -13,6 +13,7 @@ import (
 	"github.com/yetone/magpie/internal/agentenv"
 	"github.com/yetone/magpie/internal/library"
 	"github.com/yetone/magpie/internal/provider"
+	"github.com/yetone/magpie/internal/testenv"
 )
 
 // home is a sandbox: a home of its own with Claude Code and Codex in it,
@@ -24,7 +25,6 @@ func home(t *testing.T) string {
 	t.Setenv("USERPROFILE", h)
 	t.Setenv("XDG_CONFIG_HOME", filepath.Join(h, ".config"))
 	t.Setenv("XDG_CACHE_HOME", filepath.Join(h, ".cache"))
-	t.Setenv("PATH", "")
 	t.Setenv("XDG_DATA_HOME", filepath.Join(h, ".local", "share"))
 	for _, k := range agentenv.Vars {
 		t.Setenv(k, "")
@@ -35,6 +35,15 @@ func home(t *testing.T) string {
 	for _, f := range []string{".claude/settings.json", ".codex/config.toml"} {
 		write(t, filepath.Join(h, f), "")
 	}
+	// their CLIs beside the folders, as on a machine where they are really
+	// installed: the folder alone is an uninstall that left it behind
+	// (#2177), gone for the agents page and no target of the library's
+	bin := filepath.Join(h, "bin")
+	for _, name := range []string{"claude", "codex"} {
+		testenv.Program(t, filepath.Join(bin, name), "#!/bin/sh\n")
+		write(t, filepath.Join(bin, name+".exe"), "")
+	}
+	t.Setenv("PATH", bin)
 	for _, p := range []provider.Provider{
 		{ID: "a", Name: "A", Key: "ka", Models: []string{"m", "claude-opus-5-5"}, Chat: "http://127.0.0.1:1/v1"},
 		{ID: "b", Name: "B", Key: "kb", Models: []string{"gpt-5.5"}, Chat: "http://127.0.0.1:1/v1"},
-- 
2.50.1 (Apple Git-155)

</details>
