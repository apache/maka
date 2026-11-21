tui: 路由组内页把选中行滚出屏幕——成员和规则整页画、不留窗口，模型比终端行数多时高亮消失、页面冻结

## 现象

TUI 路由页（按键 3）进入一个成员较多的路由组后，`viewGroup` 把每个成员、每条规则和图案命中整页画出，不留窗口。组成员加规则的总行数超过终端行数时（比如一个装了整个供应商 30 个模型的组，80×24 终端），顶部的表头和高亮行一起被滚出屏幕；按 `j`/`k` 光标仍在移动而屏幕静止，页面冻结——`↵`/`E`/`F`/`d` 操作的模型用户看不见。这与 library 页当年的病相同（#2220），agents 页上周也刚修过同一处（fed24aa1，#2428）：providers 列表、分组列表、sessions 页都有窗口，唯独组内页没有。

## 最小复现

新增的两条测试在修复前（upstream/main 00857146）失败：

```
--- FAIL: TestGroupViewKeepsTheRowPicked (1.59s)
    routing_test.go:40: member 0 picked, but the screen stops short of it:
            14  p/m-13
            15  p/m-14
            ...
            30  p/m-29
        rules · as a turn begins, the first that matches sends it to its model first; ...
        none · n adds one
--- FAIL: TestGroupViewKeepsTheRulePicked (1.29s)
    routing_test.go:76: rule 0 picked, but the screen stops short of it (try 0):
```

复现步骤：`home(t)` 沙盒里存一个 30 成员的组（`provider.SaveGroup`），`press(t, model{w: 120, h: 24}, "3", "enter")` 进组页，`m.gsel = 0` 后取 `View()` 的最后 24 行——终端对超高的视图显示的正是最后 h 行，成员 0 已不在屏上。

## 根因

`internal/tui/routing.go` 的 `viewGroup`：成员循环 `for i, id := range g.Members` 与规则循环 `for i, r := range g.Rules` 都是无界全量输出，函数从头到尾没有窗口预算。对照组：`viewList`（agents 页）、`viewProviders`、`viewGroups`、`viewSessions`、`viewLibrary` 都以 `visible := max(3, m.h-N)` 计算可见行数、从选中行附近起画。

## 修法

`viewGroup` 照同一家族加窗口：`rows := max(3, m.h-10)`（表头、组信息行、节标题与页脚的固定行数）。成员和规则总行数装得下时整页照旧；装不下时以选中行为锚——

- 选中在成员里：画它前后的成员，下面留给装得下的前几条规则；
- 选中在规则里：画它前后的规则，上面留成员表的尾部。

挑选行永远在屏内，短组一个字节都不变。

## 验证

| 检查 | 结果 |
| --- | --- |
| 新增 `TestGroupViewKeepsTheRowPicked`（30 成员、80×24，挑 0/4/8/15/22/29） | 修前红（成员 0 挑中时屏幕停在 13–29），修后绿 |
| 新增 `TestGroupViewKeepsTheRulePicked`（1 成员 24 规则，挑规则 0/8/23） | 修前红，修后绿 |
| 消融回红（`git checkout HEAD~1 -- internal/tui/routing.go`） | 两条测试同形转红 |
| `go test -tags nogui -p 2 -count=1 ./internal/tui/` | ok（11.9s） |
| `go test -tags nogui -p 2 -count=1 -timeout 45m ./internal/agent/` | ok（179.4s） |
| `gofmt -l internal/` | 干净 |
| `go vet ./...`、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` | 过（trayimage_darwin.go 的 cgo `-Wenum-conversion` 警告为本机已知） |
| `go build`、linux(nogui)、windows 三平台 build | 过 |

## 没跑什么

- 图案命中区（patterns）和 classifier 行仍是全量输出：命中行数是每个图案一行、通常两三行，本修未给它们留窗口——图案特别多的组在极矮终端仍可能超高，属已知边界。
- GUI（窗口版）的路由视图不受影响，未测。
- 真实终端里的手工走查未做（本机无 TTY 用例），以渲染函数的截屏断言代替。

## 补丁与分支

- 分支：[ggbdpq/magpie@hunt28-agent-groupview](https://github.com/ggbdpq/magpie/tree/hunt28-agent-groupview)（基于 upstream/main 00857146，commit e264f13b）
- 合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`

<details>
<summary>patch（git format-patch -1 --stdout）</summary>

```patch
From e264f13b6c985555a9b2b33313958fe5a2c6591d Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 16 Oct 2026 05:46:06 +0800
Subject: [PATCH] tui: a group's page keeps the row picked in view, members or
 rules
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
- viewGroup drew every member and every rule and left the window to the
  terminal: a group with more members and rules than the terminal has
  rows scrolled the highlight off the top and froze the page — j moved
  the pick while the screen stood still, the same disease the library
  page had (#2220) and the agents page before it. The rows around the
  one picked are drawn now, as many as fit: a pick among the models
  keeps the first rules below it, a pick among the rules keeps the
  models' tail above it, and a short group is drawn whole as before.

Run
- New TestGroupViewKeepsTheRowPicked (30 members, 80×24) and
  TestGroupViewKeepsTheRulePicked (24 rules): both fail on the code
  before (member 0 picked, the screen stops at member 13; rule 0
  picked, the screen stops at rule 8), pass after.
- go test -tags nogui -p 2 -count=1 ./internal/tui/ ok (11.9s).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/tui/routing.go      | 26 +++++++++++-
 internal/tui/routing_test.go | 79 ++++++++++++++++++++++++++++++++++++
 2 files changed, 103 insertions(+), 2 deletions(-)
 create mode 100644 internal/tui/routing_test.go

diff --git a/internal/tui/routing.go b/internal/tui/routing.go
index adc6ea07..b8326618 100644
--- a/internal/tui/routing.go
+++ b/internal/tui/routing.go
@@ -626,7 +626,28 @@ func (m model) viewGroup() string {
 	}
 	b.WriteString(pad + "  " + sMuted.Render(strings.Join(head, " · ")) + "\n\n")
 	b.WriteString(pad + "  " + sFaint.Render("models · the first that can take a request gets it") + "\n")
-	for i, id := range g.Members {
+	n, nr := len(g.Members), len(g.Rules)
+	// the rows around the one picked, as many as fit — a group with more
+	// members and rules than the terminal has rows would otherwise scroll
+	// the highlight off and freeze the page, as the library page did
+	// (#2220) and the agents page before it. What the terminal shows of a
+	// view taller than itself is its last lines: the top scrolls away.
+	rows := max(3, m.h-10) // the header, the head, the titles and the footer around them
+	memFrom, memTo := 0, n
+	ruleFrom, ruleTo := 0, nr
+	if n+nr > rows {
+		if m.gsel < n {
+			memFrom = max(0, m.gsel+1-rows)
+			memTo = min(n, memFrom+rows)
+			ruleTo = min(nr, max(0, rows-(memTo-memFrom)))
+		} else {
+			ruleTo = min(nr, m.gsel-n+1)
+			ruleFrom = max(0, ruleTo-rows)
+			memFrom = max(0, n-max(0, rows-(ruleTo-ruleFrom)))
+		}
+	}
+	for i := memFrom; i < memTo; i++ {
+		id := g.Members[i]
 		marker, name := "  ", sText.Render(id)
 		if i == m.gsel {
 			marker, name = sCursor.Render("▸ "), sNameOn.Render(id)
@@ -655,7 +676,8 @@ func (m model) viewGroup() string {
 	if len(g.Rules) == 0 {
 		b.WriteString(pad + "  " + sMuted.Render("none · n adds one") + "\n")
 	}
-	for i, r := range g.Rules {
+	for i := ruleFrom; i < ruleTo; i++ {
+		r := g.Rules[i]
 		marker, use := "  ", sText.Render(r.Use)
 		if len(g.Members)+i == m.gsel {
 			marker, use = sCursor.Render("▸ "), sNameOn.Render(r.Use)
diff --git a/internal/tui/routing_test.go b/internal/tui/routing_test.go
new file mode 100644
index 00000000..3b5b8de9
--- /dev/null
+++ b/internal/tui/routing_test.go
@@ -0,0 +1,79 @@
+package tui
+
+import (
+	"fmt"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// The group page keeps the row picked in view: a group with more members
+// and rules than the terminal has rows can't scroll the highlight off and
+// freeze the page, as the library page did (#2220) and the agents page
+// before it. What the terminal shows of a view taller than itself is its
+// last h lines — the top scrolls away.
+func TestGroupViewKeepsTheRowPicked(t *testing.T) {
+	home(t)
+	var members []string
+	for i := 0; i < 30; i++ {
+		members = append(members, fmt.Sprintf("p/m-%02d", i))
+	}
+	if err := provider.SaveGroup(provider.Group{ID: "many", Name: "Many", Members: members}); err != nil {
+		t.Fatal(err)
+	}
+	m := press(t, model{w: 120, h: 24}, "3", "enter")
+	if m.mode != modeGroup {
+		t.Fatalf("mode %d, want the group page", m.mode)
+	}
+	screen := func(v string, h int) string {
+		lines := strings.Split(v, "\n")
+		if len(lines) > h {
+			lines = lines[len(lines)-h:]
+		}
+		return strings.Join(lines, "\n")
+	}
+	// a plain 80×24 terminal: thirty members are rows past it
+	for _, pick := range []int{0, 4, 8, 15, 22, 29} {
+		m.gsel = pick
+		if v := screen(m.View(), m.h); !strings.Contains(v, fmt.Sprintf("m-%02d", pick)) {
+			t.Fatalf("member %d picked, but the screen stops short of it:\n%s", pick, v)
+		}
+	}
+	// the page starts at its top while it all fits
+	m.h = 60
+	m.gsel = 29
+	if v := screen(m.View(), m.h); !strings.Contains(v, "m-00") {
+		t.Fatalf("a tall terminal dropped the top of the list:\n%s", v)
+	}
+}
+
+// A pick among the rules stays in view too, with the models' tail above it.
+func TestGroupViewKeepsTheRulePicked(t *testing.T) {
+	home(t)
+	members := []string{"p/m-00"}
+	var rules []provider.Rule
+	for i := 0; i < 24; i++ {
+		rules = append(rules, provider.Rule{Use: "p/m-00", Agents: []string{fmt.Sprintf("agent-%02d", i)}})
+	}
+	if err := provider.SaveGroup(provider.Group{ID: "ruled", Name: "Ruled", Members: members, Rules: rules}); err != nil {
+		t.Fatal(err)
+	}
+	m := press(t, model{w: 120, h: 24}, "3", "enter")
+	if m.mode != modeGroup {
+		t.Fatalf("mode %d, want the group page", m.mode)
+	}
+	screen := func(v string, h int) string {
+		lines := strings.Split(v, "\n")
+		if len(lines) > h {
+			lines = lines[len(lines)-h:]
+		}
+		return strings.Join(lines, "\n")
+	}
+	for i, pick := range []int{0, 8, 23} {
+		m.gsel = len(members) + pick
+		if v := screen(m.View(), m.h); !strings.Contains(v, fmt.Sprintf("agent-%02d", pick)) {
+			t.Fatalf("rule %d picked, but the screen stops short of it (try %d):\n%s", pick, i, v)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
