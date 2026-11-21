# PATCH 帖模板（rework 版开头见尾注）

> 用法：五段依次填，三件套齐全，GET 回读清单在尾。全文英文（vendor 原文引用除外）。
> 矩阵（2026-11-07 校订）：Verification 表按上游 code-standards Acceptance criteria 第 3 条全列；没跑的写 `not run`，不省略行。在 origin/main 上同样失败的项不构成基线（“Fails the same on origin/main” is not a baseline）：照实写失败、不算通过，附点名根因的 issue 或说明。旧版表中的「GOOS=linux wails `undefined: pointer` is pre-existing」等预存红仅作排查参考，不构成基线。
> 变体：rework 帖把第一段换成 `Rework per @yetone's review ([the review](…#issuecomment-…)): <一句驳回原因> — <一句本次怎么改>`。

@yetone <一段：问题是什么、谁报的（@报告者 credit）、影响面>

**Root cause**: <机理两三句，带 file:line>

**The fix**: <修法两三句+设计取舍；报告者建议的方案注明「following the reporter's own analysis」>

<details><summary>patch: <commit subject> — git am applies it as is; SHA-256 first 16: <hash></summary>

```text
<git format-patch -1 --zero-commit 原样；>60KB 用 GitHub 原生 .patch URL 替代>
```

</details>

**Branch with the commit**: [`fix/<N>-<slug>`](https://github.com/ggbdpq/magpie/tree/fix/<N>-<slug>) (head `<full sha>`), rebased onto current `upstream/main` (<tip 短 sha>); on a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `<精确测试名>` (new) | red before the fix, pass after |
| <回归/邻居测试> | pass |
| `go test ./internal/<pkg>/ -tags nogui -timeout 25m -count=1` | ok (<秒>s), zero failures |
| `go test -tags nogui ./...` (temp HOME, pinned Go caches) | ok / <each failure, with the issue naming its cause> / not run |
| targeted `-race` | pass |
| `gofmt -l <changed files>` | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | clean |
| Ablation | removing <逻辑 hunk> turns <测试> red; restored, green |
| Re-verified on upstream/main `<tip>` | <rebase 实际执行范围一句> |

**Not verified**: <首位——报告者真机/真实账号面留报告者；跑不了的引擎/平台标 NOT-RUNNABLE>

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)

## 发布链与回读清单
1. push 显式 `<sha>:refs/heads/<branch>` → ls-remote 比对
2. `gh issue comment N -R yetone/magpie --body-file <文件>`（Write 写文件禁 heredoc；f-string 撞花括号用拼接）
3. GET 回读：author=`user` 字段=ggbdpq｜围栏成对｜patch 字节与本地一致｜旧值零残留（更新帖时）
4. POST 失败先 GET 核实绝不重发；REST 404 走 GraphQL node id（`gh api graphql -f 'query='+q` 单参数）
5. >60KB patch：GitHub 原生 `.patch` URL 替代围栏

## 存量单 PATCH 同步原帖（reverify/rebase 场景；出处 hunt123 九步第 8 步）
1. `gh api repos/yetone/magpie/issues/<N>/comments` 定位 author=ggbdpq 的 patch 帖 comment id
2. **PATCH 前 GET 该帖**（防他人已动/防双发——双帖判例）
3. python3 换三处：新 head/sha256/patch 块 + 验证基线行改 `Re-verified on upstream/main <sha>`（只声明本次实际执行范围）+ 旧值零残留
4. `gh api -X PATCH .../issues/comments/<id> -F body=@文件`（禁 -f 内嵌）
5. GET 回读：新值三处在+旧值零残留+围栏闭合+patch 字节完整；不过关修正重发
