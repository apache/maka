# tui: 资源库页把选中行滚出屏幕——窗口起点按行数算、渲染按行数花，分区头把预算吃穿

## 现象

`magpie`（TUI）资源库页（6）里，在列表比终端一屏长时按 `j`/`↓` 往下走，光标走到某个位置后高亮从屏幕上消失，再按 `j` 屏幕也不再有任何变化；选中行其实在列表里继续后移，但视图停在原地。分区越多（自己的 MCP servers → skills → 在 agents 里找到的 servers/skills → RTK），越容易触发：一个 30 行左右的终端、十来个 server 加一屏 skills 就够了。

## 最小复现

新测试 `TestLibraryViewKeepsTheRowPicked`（internal/tui/library_view_test.go）：构造 instructions 1 行 + 10 个 MCP + 20 个 skill + 3 个 found-mcp + 5 个 found-skill + RTK 的列表，`h=30`（一屏约 24 行），把选中行放到 `skill-10`（第 21 行）。未修复的树上：

```
--- FAIL: TestLibraryViewKeepsTheRowPicked (0.00s)
    library_view_test.go:39: row 21 (skill-10) picked, but the view stops short of it:
        ◉ magpie   1 agents   2 providers   3 routing   4 usage   5 sessions   6 library

            instructions · what every agent reads before a conversation
            shared instructions  no agent

            mcp servers · a adds one, e changes it
            srv-00               no agent
            …（srv-01…srv-09 照排）

            skills · a adds some from GitHub or a folder, u fetches one from GitHub again
            skill-00             no agent
            …（到 skill-09 为止）
```

视图从第 0 行画起、画到 `skill-09` 就停——选中行 `skill-10`（带着 `▸` 高亮）不在画面里。`own-mcp-*`、`own-skill-4`、`RTK` 四个选中位置同样红；修复后全绿。

## 根因

internal/tui/library.go 的 `viewLibrary`：窗口起点按**行数**预算推出，

```go
visible := max(4, m.h-6)
start := 0
if m.lrow >= visible-2 {
    start = m.lrow - visible + 3
}
```

`+3` 只给**一个**分区头留了余量（空行 + 标题）。而它喂的渲染循环按**渲染行**花同一个预算：每跨一个分区（instructions→mcp→skill→found-*→rtk）多画一个空行和一行标题，各占 1 行；从 `start` 到选中行之间只要有 ≥2 个分区头，标题吃掉的行数就超过了预算，`lines < visible` 在到达选中行之前成立不了，循环在选中行上方停下。同一页面里其它列表（providers、routing、sessions）没有分区头，所以只有资源库页踩中。

## 修法

`start` 不再按行数倒推，而是从选中行往前走、按渲染循环同样的计法累加（每行 1 行，列表开头/换分区处 +2，首行无空行时 −1），取「到选中行的行数仍装得下」的最大 `start`：

```go
spend := func(from int) int {
    lines := 0
    for i := from; i <= m.lrow && lines <= visible; i++ {
        lines++
        if i == from || m.lib[i].kind != m.lib[i-1].kind {
            lines += 2 // the head, and the blank before it
            if i == 0 {
                lines-- // the list's first section has no blank above it
            }
        }
    }
    return lines
}
start := m.lrow
for start > 0 && spend(start-1) <= visible {
    start--
}
```

列表都是几十行的规模，O(n²) 无所谓；渲染循环本身不动。

## 验证

| 检查 | 结果 |
| --- | --- |
| `TestLibraryViewKeepsTheRowPicked`（新）在 `743fcc03`（upstream/main）上 | 红（skill-10 / own-mcp-0 / own-skill-4 / RTK 四个位置，输出见上） |
| 同测试，打上补丁后 | 绿 |
| `go test -tags nogui -p 2 -count=1 ./internal/tui/`（含既有 TestLibraryPage） | 全绿 |
| `gofmt -l internal/tui/` | 无输出 |
| `go vet ./internal/tui/`；`GOOS=linux go vet -tags nogui ./internal/tui/`；`GOOS=windows go vet ./internal/tui/` | 通过 |
| `go build -o /dev/null .`；`GOOS=linux go build -tags nogui -o /dev/null .`；`GOOS=windows go build -o /dev/null .` | 通过（darwin 的 `trayimage_darwin.go` cgo `-Wenum-conversion` 警告与 ld 重复库告警为既有环境噪音） |

补丁以 `git format-patch -1 --stdout` 附下（作者保留），分支在 fork 的 [`hunt21-w2-tui-library-cursor`](https://github.com/ggbdpq/magpie/tree/hunt21-w2-tui-library-cursor)。

## 没跑什么

- 没有 GUI/Playwright 验证（本缺陷在 TUI，纯 Go 单测覆盖）。
- 没在真实终端里人肉复现（判定完全来自 `viewLibrary` 的字符串输出；如需人工复核：`magpie tui` → 6 资源库 → 加十来个 server 和 skills → `j` 走到 skills 尾部之后）。
- 没动其它页面的窗口算法；routing 页的「removed」分隔行同样在行预算外多画 2 行，但它的窗口按行数取行、选中行必然在窗口内，只是列表底可能溢出屏幕 2 行，不属于本单的现象，未一并改。

<details>
<summary>patch（git format-patch -1 --stdout）</summary>

```patch
__PATCH__
```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
