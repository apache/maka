# hunt37/C 交付草稿：#2667（dsh cordis.patch.yml 开头 --- 报错）

分支：https://github.com/ggbdpq/magpie/tree/hunt37-c-sess-dsh-docstart
提交：b5c182c3（基于 upstream/main 7660399a）

---

根因与修法在单提交 [`b5c182c3`](https://github.com/ggbdpq/magpie/commit/b5c182c3d6b99570e66c3c8e691c1059a63ca7a2)（分支 [`hunt37-c-sess-dsh-docstart`](https://github.com/ggbdpq/magpie/tree/hunt37-c-sess-dsh-docstart)，基于 main `7660399a`）：

**根因**：与报告的原因分析一致——`internal/agent/dsh.go` 的 `dshParse` 与 `internal/library/dsh.go` 的 `dshRead` 在首个列表条目之前（`len(items) == 0`）只放行空行、`#` 注释与 `[]`，首行 `---` 落进 "is not a list of entries magpie can edit"。两处是同一家族的两份判定，一起改。

**修法**：前置行分支认 `t == "---"`（YAML 文档起始标记），把它留在 head 里；写回时 head 先于条目，文件头的 `---` 原样保留（报告者的建议）。flow-style 列表带 `---` 的路径 `edit.BlockList` 本就把 marker 留在序列之前的行里，不受影响。

**验证**（macOS 14 arm64，go1.25.5）：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 修前红（新 tip `7660399a` 的产品文件 + 新测试） | `go test -tags nogui -p 2 -run TestDshDocStart ./internal/agent ./internal/library` | 两包红：`cordis.patch.yml is not a list of entries magpie can edit` |
| 修后绿（`b5c182c3`） | 同上 | 两包 ok |
| 消融回红（基线 `7660399a`，隔离 worktree 显式摘两产品文件，测试保留） | 同上 | 两包红，同错误 |
| 全包 | `go test -tags nogui -p 2 ./internal/sessions ./internal/provider ./internal/agent ./internal/library` | 四包 ok |
| 格式 | `gofmt -l internal/agent internal/library` | 干净 |
| vet | darwin/arm64、linux/amd64、windows/amd64 × `-tags nogui` | 干净 |
| build | 三平台 `go build -tags nogui ./...` | ok（`trayimage_darwin.go` 的 cgo 警告在 base 上预存） |

红测的 fixture 用报告正文的字面字节（含引号与尾随空格）。tip 在验证中途从 `e085d6e9` 前进到 `7660399a`，rebase 后红、绿都在新 tip 上重跑过。

**没跑什么**：`internal/gui/tests` 的 Playwright 用例；真实 dsh 二进制（沙盒内未装）——测试断言的是 `Field("model")` Set/Get 与 `SaveServer` 的公开路径及写入后的文件字节。

patch：

```diff
（见附 patch 文件，正文 details 内嵌）
```

合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)
