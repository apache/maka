# magpie 在途补丁 rebase 与覆盖判定

**一句话总结**：维护一个落后上游的 fork + 几十支在途 patch 分支时，用 `git merge-tree` 批测真冲突、`git cherry` 判定"是否已被收编"、ff-only 同步 fork main，再把真冲突分支逐支语义化 rebase 推回。

## 背景

长期给 magpie 提 patch，fork main 一度落后上游 778 提交，在途未合分支 100+ 支。需要回答两件事：哪些分支真冲突需要 rebase；哪些 patch 其实已经被上游用别的实现悄悄修掉了（不用再维护）。

## 核心命令

```bash
# 批测：每支分支与 upstream/main 是否冲突（exit 0=干净跳过，1=真冲突并输出冲突文件）
for b in $(git for-each-ref refs/remotes/origin --format='%(refname:short)' | grep -E 'hunt|fix/'); do
  r=$(git merge-tree --write-tree --name-only upstream/main "$b" 2>/dev/null) && continue
  files=$(echo "$r" | grep -v '^Auto-merging\|^CONFLICT' | grep -v '^$' | tr '\n' ' ')
  [ -n "$files" ] && echo "CONFLICT $b: $files"
done
```

```bash
# 判定某 patch 是否已被上游收编：cherry 按 patch-id 对比，'-' 开头=已在 main
git fetch upstream main
git cherry upstream/main "$(git ls-remote origin <分支名> | cut -f1)"
```

```bash
# fork main 安全同步：独有提交=0 才允许 fast-forward 推送（有独有提交绝不能推）
git fetch upstream main
behind=$(git rev-list origin/main..upstream/main --count)
unique=$(git rev-list origin/main --not upstream/main --count)
[ "$unique" = "0" ] && [ "$behind" != "0" ] && git push origin upstream/main:main
```

```bash
# rebase 后按锚推回：force-with-lease 锚定旧 SHA，防止覆盖别人期间的推送 ⚠️
# （lease 不匹配会拒绝推送，比裸 --force 安全；旧 SHA 推前再 ls-remote 取一次防竞态）
git push origin <分支名> --force-with-lease=<分支名>:<旧origin-sha>
```

```bash
# zsh 里 gh api 的 URL 带 ? 必须加引号，否则触发 glob 报错 "no matches found"
gh api "repos/owner/repo/issues/N/comments?per_page=100"

# 扫自己参与过且仍 open 的 issue（--involves 不是 gh issue list 的旗标，要走 --search）
gh issue list --repo owner/repo --state open --search "involves:你的ID sort:updated-desc" --json number,updatedAt
```

```bash
# 交付后指纹复核：帖内声明的 SHA-256 前 16 位 vs 本地 format-patch 真实哈希
git format-patch -1 <sha> --stdout > /tmp/p.patch
shasum -a 256 /tmp/p.patch | cut -c1-16
```

## 关键结论

1. **`git merge-tree --write-tree` 是批量冲突探测的标准答案**：exit 0=干净（不动，纪律是"干净=不 rebase"，对在审 patch 制造噪音反而有害）；exit 1=真冲突（才进 rebase 车道）。注意分支要真的存在，不存在的 ref 也会 exit≠0，造成"空文件列表的假冲突"。
2. **`git cherry` 按 patch-id 判收编，但只对"原样合入"有效**：维护者 git am 原样收编→cherry 显示已合；维护者用别的实现重写同一问题→cherry 仍显示未合，需要读码逐面对照判定"语义是否被覆盖"，不能只信 cherry。
3. **事故级教训（上游 #3682）**：默认关闭的可选功能在全局锁内做同步 I/O（模型加载 3 分钟+每次识别），把全部核心请求排队成 504；测试用假服务从没跑过"冷启动+并发"场景，20+ 个版本零拦截。验收规则：涉及真实外部资源（模型/子进程/网络）的功能，必须做真资源冷启动+并发的验证。
4. **rebase 的价值在语义判定不在机械操作**：12 个真冲突里，上游改动有正交、有收窄、有部分覆盖（我方修法的另一半仍有效就保留）、也有整体覆盖（我方分支直接作废不 rebase）。docs 冲突机械保双方段落即可，代码冲突必须逐处核对数据格式语义——git 自动合并会做错帧头格式、节流变量移位这类事。
5. **三个高频小坑**：①gh 的 `-f` 不展开 `@file`（发出去的是字面路径字符串），要用 `-F`；②openpyxl 行构造用元组带尾随逗号会变成嵌套元组直接报错，用列表字面量；③正则 `\*\*?` 是"1 到 2 个星号"，要"0 到 2 个"得写 `\*{0,2}`——批量替换 markdown 里 `@sha`/`@\`sha\`/@\*\*`sha\`\*\*` 三种变体时踩过。

## 下次怎么用

维护"一个 fork + 大量在途 patch"的场景可直接套用三步：

1. **每轮开场**：ff 同步 fork main（先查独有提交=0 再推）→ merge-tree 批测活跃分支 → 只对真冲突分支开 rebase。
2. **rebase 每支**：先读冲突文件的上游新提交逐笔判定（正交/收窄/覆盖）→ rebase 保双方语义 → 跑该单定向测试 → force-with-lease 推回原分支名。
3. **判定收编**：`git cherry` 出结果后，对"未合"的再读上游相关文件近期提交，确认是否被别的实现覆盖——被覆盖就作废分支，不继续维护。

---
**备注**：文内 force-with-lease 属受控强推（锚定旧 SHA，他人已推送时会自动拒绝），仍需确认远端无他人新提交后再用；`git reset --hard` 仅在确认目标提交无独有内容时使用。
