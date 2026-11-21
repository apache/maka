# 任务书 车道 B：#26898 bot 线程修复 → #24191 rebase → #24803 收编核证（串行三件）

仓库：/Users/ggbdpq/cc/code/fork/orca（普通仓），upstream=stablyai/orca。三件串行，先做完先推。

## 件 1：#26898 coderabbit 未解线程修复（Minor/Quick win）

- 线程（11-05 15:06，not outdated）：**"Try raw formats when the copied-file read fails"**——Windows 剪贴板同时广告图像字节与拷贝文件时，拷贝文件不可读使 `readWindowsClipboardImageFileAsPng` 返回 null 并提前退出 handler，raw 图像字节没机会试，粘贴静默失败。建议：仅当（读线程全文取其完整建议条件）才提前返回。
- 处置：读全线程→对码核实（ cleanshot-jpeg-png-paste 域）→按建议修（历史模式=多数采纳）→新测试红→绿→消融回红。
- 验证：定向套件+相邻+`pnpm run typecheck:node`（管道吞退出码出假绿，命令落文件看 EXIT；vitest 走 `pnpm test` wrapper）。
- rebase 到最新 main（**取代核对先行**：`git log upstream/main --oneline <旧merge-base>..<tip> -- <touched files>`+关键词 grep，命中取代 STOP）→push 显式 SHA refspec→ls-remote→回帖 coderabbit 线程（resolved+修复说明，英文，简短）→催审帖防连发（24h 内已有则跳过）。

## 件 2：#24191 rebase 推净（唯一 DIRTY）

- mergeStateStatus=DIRTY（全 22 单唯一冲突）。rebase 到最新 main，冲突双方语义都留；**取代核对**；rebase 后 typecheck 增量浮出会暴露 PR 外兄弟 fixture 缺新字段（#25191 先例：5 fixture 缺 showDockBadge 全补齐——同型注意）。
- max-lines 300 棘轮（oxlint skipBlankLines+skipComments 后计数，禁 disable 注释）：超限拆内聚切片到新模块+消费方改 import。
- 验证：定向+相邻+typecheck:node（+涉 renderer 加 typecheck:web）+oxfmt/oxlint+棘轮。push 显式 SHA refspec+ls-remote 回核。催审帖防连发（该单 11-05 21:23 已有我方动作，>24h 可发，格式=rebased onto `<短SHA>`/冲突解/线程清/验证实数+`@nwparker gentle ping — happy to adjust anything`）。

## 件 3：#24803 收编核证（只核不发，除非署名缺失）

- nwparker 11-07 04:36 关单："landed in #38969, which ports your commits with you as git author and extends the cleanup to agy. Closing as superseded."
- 核证：`gh pr view 38969` / `gh api repos/stablyai/orca/pulls/38969/commits`——逐 commit 核 author 是否真=ggbdpq <ggbdpq@gmail.com>（**先例 #33411：关单评论声称 credited 实际缺失→light 溯源帖挂盯**）。
- author 真落盘→零回帖（可发一句短谢，非必需）；author 缺失→light 溯源帖（引 #33411 先例格式）并回报挂盯。
- 顺带核 #38969 是否已 merge（合入则收编终态；仍 open 则在途）。

## 通用

- worktree 自建自清 `/tmp/orca-<件号>`（从远端 SHA 建，本地过期指针不信）；GOCACHE 默认；只碰自己分支；push 显式 `<sha>:refs/heads/<branch>`；fork PR 不跑上游 Actions（UNSTABLE=bot 态、UNKNOWN=瞬态）；不谎报没跑的列 not run。
- 回报：件 1 `#26898 | rebase to <tip> | 修复+测试红绿+消融 | 新head | 回帖URL`；件 2 `#24191 | rebase to <tip> | 冲突解+验证实数 | 新head | 催审帖URL`；件 3 `#24803/#38969 | author 核证结果 | 动作`。
