# GitHub API 实用命令与 flaky 测试排查方法

**一句话总结**：整理 gh api 操作 issue 评论的正确姿势（含三个坑）、git 检索的假阳性和排除法，以及"注入法"排查 flaky 测试的完整思路。

## 背景

一轮开源项目协作里批量处理 issue 回帖、排查一个偶发失败的测试（`-count=40` 下 3/40 红），踩了一批 gh/git/zsh 的坑，沉淀出可直接复用的命令和一套 flaky 测试定位方法。

## 核心命令

### gh api 操作 issue 评论

```bash
# 批量读某个 issue 的评论（tsv 输出好扫读）
gh api repos/OWNER/REPO/issues/N/comments --jq '.[] | [.user.login, .created_at[:16], (.body[:100] | gsub("\n";" "))] | @tsv'

# 发评论：body 先写成文件再 -F 传，避免转义地狱
gh api repos/OWNER/REPO/issues/N/comments -F body=@draft.md

# 回读校验（比对是否发成功/有无截断）：
# 注意单条评论的 GET 路由是 /issues/comments/<id>，【不带】issue 号
gh api repos/OWNER/REPO/issues/comments/<id> | jq -j '.body' > readback.md
diff readback.md draft.md
```

三个坑：
- `gh api ... --jq -j '.body'` 不工作（`-j` 会被吞进 `--jq` 的值），取原始字节要用管道 `| jq -j '.body'`。
- `--jq` 输出会在末尾补一个换行，逐字节比对时先 `jq -j` 原样取出，别把工具尾换行当成内容差异。
- **POST 报错 ≠ 没发成功**（网络 EOF 之类）：先按列表或单条路由 GET 核实，确认没发出去再重发，否则会发出重复评论。

### git 检索与核实

```bash
# 按 issue 号搜提交：必须加词边界，否则会撞上提交全文里的 SHA 子串
# （如 --grep=2969 会误命中包含 429698f96 的提交）
git log --oneline --grep='(^|[^0-9a-f])2969([^0-9a-f]|$)' -E

# 追一个符号的演化史（谁引入/谁改的）
git log --oneline -S 'someFuncName' -- path/to/file

# 判断某提交是否已进入某分支/tag（"是否已合入"的唯一可靠判法）
git merge-base --is-ancestor <sha> origin/main && echo merged || echo not-yet
git merge-base --is-ancestor <sha> v1.2.3 && echo in-tag || echo not-in-tag

# 查某历史提交的树里有没有某文件（不要用工作树 find——本地 checkout 可能落后）
git ls-tree <sha> -- path/to/file

# 批量检查自己的补丁在新基线上能否干净套用
git apply --3way --check my.patch

# 清理已删除目录的 worktree 残留元数据
git worktree prune
```

两个坑：
- fork 仓库共享对象库：上游仓库的 API 能解析你 fork 里提交的 SHA，`compare` 结果像"已在上游"，实际只是对象可解析——**"是否被收编"必须用 `merge-base --is-ancestor` 对 upstream ref 实测**。
- `git worktree add` 必须显式带 commit SHA；漏了会检出本地落后的 main，后续所有验证作废。

### zsh / python 两个小坑

```bash
# zsh 不分词：$FILES 拼进命令会变成一个整体参数，多文件要显式列
git checkout <sha> -- file1.go file2.go   # ✅
# git checkout <sha> -- $FILES            # ❌ pathspec 拼成单串报错

# zsh glob 无匹配会中止整条 && 链（且报 no matches found）：
# 批量删除前先 ls 确认存在，或逐个删

# python heredoc 写中文内容，必须加编码声明，否则 SyntaxError
python3 - <<'PYEOF'
# -*- coding: utf-8 -*-
# ...按行读文件、找最后一个非空行做锚点追加（splitlines 会留下尾部空串）
PYEOF
```

### GUI/前端测试环境

```bash
# 仓库没有 package.json 时，playwright 从 npx 缓存借：
NODE_PATH=~/.npm/_npx/<hash>/node_modules node --test some.test.cjs
# 先 ls ~/.npm/_npx/ 找含 playwright 的那个 hash 目录；抓错目录 = MODULE_NOT_FOUND 假红
```

## 关键结论

1. **flaky 测试用"注入法"复现，不要 rerun 碰运气**。先读懂失败路径，在代码里人为制造那个时序（如在关键 handler 里 sleep 超过客户端超时、让第一个请求返回 EOF），做到"修前必红、修后同注入必绿"——这才是可验证的修复。
2. **报错文案会误导定位**。实例：测试报 `a request after the handover reached pid 0`，看着像交接断链；注入复现后发现交接链日志完全正常，真因是一个单发 2s 探测把"超时/无字段/传输错误"全部折叠成 0。看到离谱错误信息先怀疑"它把几种失败折叠成了一个值"，别顺着文案找。
3. **对照组单次观察不构成归因**。3/40 红 vs 0/40 绿：若单次红率是 7.5%，40 次全绿的概率约 4.7%——一次对照在噪声内，要多轮或算一下概率再下结论。
4. **消融验证的标准动作**：先提交修复 → 只回退产品文件（保留测试）→ 测试复红 → 恢复 → 绿。红必须落在被改的语义上（断言级红），"编译失败红"不能证明行为正确性。
5. **批量发同类请求前先做一次"成功样本"的严格校验**（回读逐字节比对），确认命令形状对了再批量化——这次靠这个习惯把三处工具坑（路由、-j、尾换行）在第一单就暴露完。

## 下次怎么用

- 给 GitHub 仓库写自动化脚本（批量回帖/巡检）：直接套"文件传 body + 单条路由回读 + 先 GET 再重发"三件套。
- 排查偶发失败的测试：按"读懂失败路径 → 设计注入点 → 修前红/修后绿 → 消融闭环 → 连跑 10 次收尾"的顺序走。
- 任何人说"这个 fix 已经进 main/进某某版本了"：用 `merge-base --is-ancestor` 实测再信，fork 场景尤其如此。
