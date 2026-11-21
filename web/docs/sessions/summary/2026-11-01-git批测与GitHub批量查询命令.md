# git 批测与 GitHub 批量查询命令（开源仓库多分支维护）

**一句话总结**：管理几十个 fork 分支时，用 `git cherry` 判定哪些 patch 已进上游、用 worktree 批量实测 `git am`、用 GraphQL 一次查询几十个 issue 状态——三个手法覆盖维护工作九成的批量操作。

## 背景

维护一个开源仓库的 fork，长期积累了几十支在途分支（patch 已发、等上游收编）。上游每天合几百个提交，需要批量回答三个问题：哪些分支已被收编、哪些还能干净合入、哪些 issue 有新回复。逐个手查不可行，这次对话里跑通了三个批量手法。

## 核心命令

```bash
# 判定分支的提交是否已进上游：+ 开头=不在上游（在途），-= 已在上游（被收编）
git cherry upstream/main origin/my-branch

# 统计某分支在途提交数（配合脚本批测全部分支）
git cherry upstream/main origin/my-branch | grep -c '^+'

# 找一个提交首发于哪个版本 tag（排除非版本 tag 污染）
git tag --contains <sha> | grep -E '^v0\.1' | sort -V | head -1

# 统计自己在上游的署名贡献（四通道：作者/Co-authored-by/正文署名/尾注）
git log upstream/main --format='%an' | grep -c '^你的ID$'
git log upstream/main --format='%b' | grep -c 'Co-authored-by: 你的ID'
```

```bash
# 多分支批测：从上游 tip 建临时 worktree，逐支实测 git am（比 --check 可靠）
git worktree add /tmp/test-am upstream/main --detach
git format-patch <merge-base>..origin/my-branch --stdout > /tmp/p.patch
git -C /tmp/test-am am -3 /tmp/p.patch   # 真实落地，冲突立即暴露
git -C /tmp/test-am reset --hard upstream/main  # 测完还原，测下一支
git worktree remove /tmp/test-am --force
```

```bash
# GitHub GraphQL 一次批量查询 40 个 issue 的状态和最后评论者（比逐个 REST 快一个量级）
gh api graphql -f query='query { repository(owner:"org", name:"repo") {
  i123: issue(number: 123) { state comments(last:2){nodes{author{login} createdAt}} }
  i124: issue(number: 124) { ...同上结构... }
} }'
```

```bash
# 推送被 rebase 过的分支：锚定旧 SHA 防覆盖别人新推送
git push origin my-branch --force-with-lease
git ls-remote origin my-branch   # 推后终验远端 SHA == 本地
```

## 关键结论

1. **`git apply --check` 通过 ≠ 落地无冲突**。必须在实际 worktree 上跑真实 `git am -3` 才暴露真冲突；且一次 am 失败后会留下 `.git/rebase-apply` 残留，让后续所有 am 报同样的假冲突——失败后先清残留再测下一支。
2. **GitHub REST 的 comments API 按时间升序返回**。`per_page=6` 之类小页取"最后几条"拿到的是最早的几条，会漏掉最新回复；取尾一律 `?per_page=100` 取数组末尾，或改用 GraphQL 的 `comments(last: N)`。
3. **消融验证时整文件回退会产生假证据**：如果测试代码引用了产品文件里的常量，回退产品文件直接编译失败（build failed ≠ 断言红）。正确做法是把关键常量改成极端值，让变异点落在语义分叉行上。
4. **`git checkout HEAD -- <file>` 会无声覆盖工作树里未提交的修改**。消融/还原前先把工作提交了；丢了改动只能靠之前输出过的 diff 手工重写。
5. **openpyxl 批量写 Excel 用显式列号写入**（`ws.cell(row=r, column=c, value=v)` 从列 2 开始），不要用 append——追加行含前导空列时会整体右移一格覆盖邻行；写完必须全量回读校验行数与唯一性。
6. **Python 多行字符串里的中文文本含半角双引号会把字符串截断**（SyntaxError 整脚本不执行）。脚本里的中文引号一律用「」，避免和 Python 语法冲突。

## 下次怎么用

- 同步 fork 后想知道"我还有哪些 patch 没被上游收编"：跑上面的 cherry 批测循环，`+` 号清单即在途分支。
- 给维护者/同事发汇总前想确认哪些 issue 有新回复：GraphQL 批量查 `comments(last:1)` 的 author，一次往返代替 N 次 REST。
- 自动化更新 Excel 台账：先备份原文件（`cp x x.bak`），显式列写入，写后跑行数+去重校验，再交付。
- 提交进了上游想确认首发版本号：`git tag --contains` + grep 版本前缀。
