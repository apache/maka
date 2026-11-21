# SMB 挂载的 git 克隆跨机同步与 CRLF 幻影脏清理

**一句话总结**：另一台机器共享出来的 git 克隆落后了几十次提交，别手工搬文件——从本机仓库直接 fetch 再 `merge --ff-only`，让 git 原子地完成全部「删旧位→写新位」，用剥 CR 哈希对比鉴定换行符幻影脏文件后批量恢复即可。

## 背景

本机 `/Users/ggbdpq/cc` 是正本（多机同步的私仓），局域网内 <内网IP> 共享的 `/Volumes/cc`（SMB 挂载）是落后 58 个提交的克隆，上周的目录重构在那边都没发生，文件还停在旧位置。全量 `git status` 在这种挂载盘上要跑几分钟以上，且工作区堆着大量 Windows 侧产生的脏文件，直接合并会被拦。

## 核心命令

```bash
# 确认两边历史关系：对方 HEAD 是本机 main 的祖先 = 纯落后，可安全快进
git -C /Volumes/cc log --oneline -3
git merge-base --is-ancestor <对方HEAD> main && echo 可快进

# 差量概览（大 diff 重命名检测会被跳过，只看 A/D/M/R 分布即可）
git diff --name-status <对方HEAD> main | awk '{print $1}' | sort | uniq -c

# 从本机仓库直接 fetch（走局域网 SMB，不依赖 GitHub）
git -C /Volumes/cc fetch --no-tags /Users/ggbdpq/cc main

# 快进合并；工作区脏会安全拒绝并列出路径，不会覆盖任何东西
git -C /Volumes/cc -c core.fsmonitor=false merge --ff-only FETCH_HEAD

# 鉴定脏文件：剥 \r 后哈希一致 = 纯 CRLF 换行符差异，恢复零信息损失
a=$(git show "<对方HEAD>:<文件路径>" | tr -d '\r' | shasum -a 256 | cut -c1-12)
b=$(tr -d '\r' < "/Volumes/cc/<文件路径>" | shasum -a 256 | cut -c1-12)
[ "$a" = "$b" ] && echo CRLF-ONLY || echo REAL-DRIFT

# 批量恢复纯噪音文件（路径写成 NUL 分隔文件，避免中文/空格转义问题）
git -C /Volumes/cc -c core.hooksPath=/dev/null checkout \
  --pathspec-from-file=/tmp/paths.nul --pathspec-file-nul --

# 恢复完等十几秒再合并（SMB 客户端缓存会让紧随其后的 git 读到旧内容）
sleep 12 && git -C /Volumes/cc -c core.fsmonitor=false merge --ff-only FETCH_HEAD

# 抽查恢复结果是否逐字节一致
cmp -s <(git show "<对方HEAD>:<文件路径>") "/Volumes/cc/<文件路径>" && echo 一致
```

## 关键结论

1. **克隆落后就快进，绝不手工 mv**。`merge --ff-only` 由 git 在索引层面原子完成几百个重命名、上千新增和删除，手工搬文件会把克隆的 git 状态搞成幻影 diff。
2. **`--ff-only` 是安全闸门**：它拒绝的那批路径恰好就是需要鉴定的脏文件清单，照单逐个剥 CR 验证，纯噪音恢复、真漂移留待决策。这次 4400+ 个文件全验下来零真实漂移。
3. **CRLF 幻影脏是 Windows 侧编辑器/工具写盘的产物**，不是真实改动；恢复成提交内容不丢任何信息。但只清本次差量涉及的文件即可，工作区里几千个历史幻影脏与本次同步无关，不必顺手全清。
4. **跨挂载跑 git 的两个坑**：残留的 Git LFS 钩子在缺 `git-lfs` 的环境会挡住 checkout/merge——仓内 `.gitattributes` 没有 `filter=lfs` 条目就可用 `-c core.hooksPath=/dev/null` 禁掉；SMB 客户端缓存会让「批量恢复后立刻合并」误判脏，中间隔十几秒就好。
5. **分析差量时的格式陷阱**：`-z` 输出里 M/D 条目是「状态+路径」二元组，R 条目是「状态+旧路径+新路径」三元组，按 parity 解析会错位；且重命名的旧路径同样要做脏鉴定（用 `--diff-filter=R` 单独取）。

## 下次怎么用

适用：本机仓库是正本，另一台机器（或挂载盘/NAS）上的克隆落后若干提交，那边工作区还有 Windows 味的脏文件。步骤：

1. `merge-base --is-ancestor` 确认纯落后、无分叉。
2. `git diff --name-status` 看差量规模，后台跑。
3. 对方克隆 `fetch <本机仓库路径> main` + `merge --ff-only`；被拦就按报错路径逐个剥 CR 鉴定。
4. 纯噪音文件写成 NUL pathspec 批量恢复（禁钩子），等十几秒再合并。
5. 用 `ls 新路径目录` 探测进度（大仓 SMB 上别反复跑全量 status），最后 `cmp -s` 抽查 + `log -1` 确认 HEAD 对齐。

待验证：批量恢复几千个文件在千兆网 SMB 上的耗时约为每百个文件 1 分钟量级（这次约 4400 个文件分两批，各跑约 3~4 分钟），更大规模建议直接整仓重新 clone 比对。
