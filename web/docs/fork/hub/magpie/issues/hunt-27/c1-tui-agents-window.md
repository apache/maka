tui: agents 页把选中行滚出屏幕——列表整页画、不留窗口，agent 比终端行数多时高亮消失、页面冻结

## 现象

`magpie`（TUI）的 agents 页（默认页）里，在本机装出的 agent 比终端一屏行数多时按 `j`/`↓` 往下走，光标走到某处后高亮从屏幕上消失；继续按 `j` 屏幕纹丝不动——选中行其实在列表里继续后移，只是它始终画在滚出屏幕的顶部区域。资源库页的同款病刚在 #2220 修掉，这是它的兄弟面：agents 页连窗口都没有，列表整页画。

## 最小复现

新测试 `TestAgentsViewKeepsTheRowPicked`（internal/tui/tui_test.go）：构造 30 个 agent，终端取最普通的 80×24（h=24），把选中行放到 agent-00/04/08/15/22/29 逐个断言「高亮落在屏幕最后 24 行内」（视图高于终端时终端滚屏，用户看到的是最后 h 行）。未修复的树上：

```
--- FAIL: TestAgentsViewKeepsTheRowPicked (0.00s)
    tui_test.go:449: row 0 (agent-00) picked, but the screen stops short of it:
            agent-06   —
            agent-07   —
            …（agent-06 到 agent-29，整屏没有一个 ▸）
```

整页输出 = 页头 2 行 + 30 行 agent + 补白 + 状态 + 提示 ≈ 35 行，屏幕只留最后 24 行：选中行 0–8 全在滚掉的顶部。修复后六个位置全绿。

## 根因

internal/tui/tui.go 的 `viewList`：没有窗口预算，`for i, a := range m.agents` 从第 0 行画到最后一行，行数完全交给终端滚屏。同一文件里 `viewProviders`/`viewPicker`/`viewSessions` 都按 `m.h` 开窗口，唯独默认的 agents 页没有；`viewLibrary` 的窗口在 #2220 修成了按渲染行计费。机器上 magpie 能探测的 agent 有四十余种（claude、codex、gemini、opencode、cursor……`agent.Detected()` 逐个认），装上 20 个以上、终端 24 行就触发；把 agent 隐藏（app 里 hidden）也只是排在后面变暗，行数不减。

## 修法

照 `viewProviders` 的现成窗口（agents 页每行恰好渲染 1 行，无分区头，行数窗口即渲染行窗口）：

```go
visible := max(3, m.h-7)
start := 0
if m.row >= visible {
    start = m.row - visible + 1
}
end := min(len(m.agents), start+visible)
for i := start; i < end; i++ {
```

列表装得下时 `start=0`，行为不变。

## 验证

| 检查 | 结果 |
| --- | --- |
| 修前红（422d057d，tip） | `TestAgentsViewKeepsTheRowPicked` FAIL：row 0 选中、屏幕停在 agent-06..29 无高亮 |
| 修后绿 | 同测试 ok；`internal/tui` `internal/library` 全量 ok（`-tags nogui -p 2 -count=1`） |
| 消融回红（只 stash `internal/tui/tui.go`） | 同形 FAIL（"row 0 (agent-00) picked, but the screen stops short of it"） |
| gofmt -l internal/tui | 0 |
| vet darwin / linux -tags nogui / windows | 0 |
| build darwin / linux -tags nogui / windows | 0（`trayimage_darwin.go` 的 cgo `-Wenum-conversion` 警告为已知环境噪音） |

没跑的：GUI（WebKit 依赖不在本机跑）与真实终端手测——断言建模了「视图高于终端时屏幕留最后 h 行」这一终端行为，未在实体 80×24 终端复按。

补丁（对 422d057d）与分支：

- 分支：[ggbdpq/magpie @ hunt27-tui-agents-window](https://github.com/ggbdpq/magpie/tree/hunt27-tui-agents-window)（commit a069f1ce）

<details>
<summary>patch</summary>

```
From a069f1cef6f08d349a351eda9a49165d36401ddb Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 23:33:33 +0800
Subject: [PATCH] tui: the agents page keeps the row picked in view, however
 many agents are installed
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
- viewList drew every agent and left the window to the terminal: on a
  machine with more agents than the terminal has rows the highlight
  scrolled off the top and the page froze — pressing j changed the row
  while the screen stood still, the same disease the library page had
  (#2220). The rows around the one picked are drawn now, as many as fit
  (the providers page's window).

Run
- TestAgentsViewKeepsTheRowPicked (new): 30 agents on a plain 80x24
  terminal, the row picked at 0, 4, 8, 15, 22 and 29 stays on screen,
  and a tall terminal still shows the list's top. Red at 422d057d
  ("row 0 (agent-00) picked, but the screen stops short of it",
  agents 06-29 with no highlight), green after; red again with only
  internal/tui/tui.go stashed. internal/tui and internal/library whole
  (ok, -tags nogui -p 2). gofmt clean; vet darwin, linux -tags nogui
  and windows = 0; build darwin, linux -tags nogui and windows = 0
  (trayimage_darwin.go's cgo -Wenum-conversion warning as ever).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/tui/tui.go      | 12 ++++++++++-
 internal/tui/tui_test.go | 45 ++++++++++++++++++++++++++++++++++++++++
 2 files changed, 56 insertions(+), 1 deletion(-)

diff --git a/internal/tui/tui.go b/internal/tui/tui.go
index 09dbb198..3b21faac 100644
--- a/internal/tui/tui.go
+++ b/internal/tui/tui.go
@@ -852,7 +852,17 @@ func (m model) viewList() string {
 	var b strings.Builder
 	b.WriteString(m.header())
 	b.WriteString("\n\n")
-	for i, a := range m.agents {
+	// the rows around the one picked, as many as fit — a machine with more
+	// agents than the terminal has rows would otherwise scroll the highlight
+	// off and freeze the page, as the library page did (#2220)
+	visible := max(3, m.h-7)
+	start := 0
+	if m.row >= visible {
+		start = m.row - visible + 1
+	}
+	end := min(len(m.agents), start+visible)
+	for i := start; i < end; i++ {
+		a := m.agents[i]
 		sel := i == m.row
 		marker := "  "
 		name := sName.Render(padRight(a.Name, nameW))
diff --git a/internal/tui/tui_test.go b/internal/tui/tui_test.go
index 77df3250..60df8c23 100644
--- a/internal/tui/tui_test.go
+++ b/internal/tui/tui_test.go
@@ -2,6 +2,7 @@ package tui
 
 import (
 	"encoding/json"
+	"fmt"
 	"os"
 	"path/filepath"
 	"slices"
@@ -10,6 +11,7 @@ import (
 
 	tea "github.com/charmbracelet/bubbletea"
 
+	"github.com/yetone/magpie/internal/agent"
 	"github.com/yetone/magpie/internal/agentenv"
 	"github.com/yetone/magpie/internal/library"
 	"github.com/yetone/magpie/internal/provider"
@@ -411,3 +413,46 @@ func TestFirstRunShowsCatalogSync(t *testing.T) {
 		t.Fatal("S started a second sync while the first runs")
 	}
 }
+
+// The agents page keeps the row picked in view: a machine with more agents
+// than the terminal has rows can't scroll the highlight off and freeze the
+// page, as the library page did (#2220). What the terminal shows of a view
+// taller than itself is its last h lines — the top scrolls away.
+func TestAgentsViewKeepsTheRowPicked(t *testing.T) {
+	var agents []*agent.Agent
+	for i := 0; i < 30; i++ {
+		agents = append(agents, &agent.Agent{
+			ID:     fmt.Sprintf("agent-%02d", i),
+			Name:   fmt.Sprintf("agent-%02d", i),
+			Path:   fmt.Sprintf("/opt/agent-%02d/bin/agent", i),
+			Fields: []agent.Field{{Key: "model", Label: "model"}},
+		})
+	}
+	m := model{w: 120, agents: agents, hidden: len(agents),
+		values: make([]map[string]string, len(agents)), failover: make([]string, len(agents))}
+	for i := range m.values {
+		m.values[i] = map[string]string{"model": ""}
+	}
+	screen := func(v string, h int) string {
+		lines := strings.Split(v, "\n")
+		if len(lines) > h {
+			lines = lines[len(lines)-h:]
+		}
+		return strings.Join(lines, "\n")
+	}
+	// a plain 80×24 terminal: thirty agents are nine rows past it
+	m.h = 24
+	for _, pick := range []int{0, 4, 8, 15, 22, 29} {
+		m.row = pick
+		v := screen(m.viewList(), m.h)
+		if !strings.Contains(v, "▸ "+agents[pick].Name) {
+			t.Fatalf("row %d (%s) picked, but the screen stops short of it:\n%s", m.row, agents[pick].Name, v)
+		}
+	}
+	// the page starts at its top while it all fits
+	m.h = 60
+	m.row = 29
+	if v := screen(m.viewList(), m.h); !strings.Contains(v, "agent-00") {
+		t.Fatalf("a tall terminal dropped the top of the list:\n%s", v)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`

Generated-by: GLM-5.3-Flash (ZCode)
