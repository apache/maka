# 任务书 车道 A：#36049 对抗性 review REWORK（5 点逐条对码）

仓库：/Users/ggbdpq/cc/code/fork/orca（普通仓），upstream=stablyai/orca。PR：https://github.com/stablyai/orca/pull/36049（fix/gitea-head-filter-fast-path，head 776d3bb 时代，现 DIRTY、2074 commits 落后）。

## 事件

OrcaWin 2026-11-08T02:14 对抗性 review 判 **REWORK**（risk Medium，不关单）五点：
1. **空页当确定 miss**：`probeHeadFiltered`（pull-request-branch-lookup.ts）把空结果当两种 server 的确定 miss——仅当 Forgejo `head=` 过滤器至少覆盖既有 branch matcher 的全部匹配（ref/label/`label.endsWith(':branch')`/fork/AGit PR）才正确；若 Forgejo 只滤 same-repo heads，则今日显示 PR 的卡片会静默变"无 PR"。**要求：从 Forgejo 真机或源码证明过滤器覆盖这些形状，或空页时回退 bounded scan**。
2. **探针失败不记忆**：4xx/5xx/超时探针返回 null，既不缓存也不记 unsupported——拒绝 `head=` 的 host 或慢 host 每次扫描前都白付一次失败探针（至多 15s list timeout）。**要求：按 API base URL 记短 TTL 的 unsupported 判定，或复用既有 3s 失败 cooldown**。
3. **测试数调用次数**：client.test.ts / client-scan-invalidation.test.ts 新断言多数在数调用（listCalls/probeCalls/toHaveBeenCalledTimes）——**AGENTS.md 禁止 work-count 测试**。每路径保一个行为测试（如"有无 fast path 卡片解析同一 PR"），去掉调用计数。
4. **缓存压力与 merge 态**：每探针键占 32 个共享 scan-cache 槽之一，Forgejo 下 >32 分支卡会逐出他 repo 的扫描；分支落后 main 2074 commits 且 DIRTY，main 的 #39429 删了本分支还在改的 Gitea 测试。**要求：rebase 到 main，保留 main 新加的 `noteProviderCacheAnswer()` 调用**。
5. **无实测**：收益引自 Codeberg issue，未在 Orca 实测。真机 Forgejo host 的前后对比才能定案。

## 执行纪律

- worktree 自建：`git -C /Users/ggbdpq/cc/code/fork/orca worktree add /tmp/orca-36049 -b fix/36049-rework upstream/main`（分支名可沿用原 PR 分支 rebase，也可新支；推回原 PR 分支）。
- **逐点处置**：①先查 Forgejo 源码（github.com/forgejo/forgejo，`head=` filter 语义——pull 列表 API 的过滤实现）定空页语义；证明不了就按其建议空页回退 bounded scan（fail-safe，行为不变保证）。②实现探针失败短记忆（优先复用既有 cooldown 机制，先读现结构）。③测试重写去调用计数（行为测试替换）。④rebase 后保 `noteProviderCacheAnswer()`；冲突双方语义都留。⑤实测：本机无真实 Forgejo host 则如实 Not verified（真机面留报告者/维护者），可给 docker compose 起 forgejo 的本地实测替代（若网络允许）。
- **取代核对**：rebase 前 `git log upstream/main --oneline <旧merge-base>..<tip> -- <touched files>` + 关键词 grep（gitea/head filter/probe）——命中取代 STOP 交主线程。
- **max-lines 300 棘轮**（oxlint，skipBlankLines+skipComments）：超限拆内聚切片+消费方改 import。
- **验证**：改动面定向套件+相邻套件+`pnpm run typecheck:node`；管道吞退出码出假绿（`| tail` 吞 EXIT）——命令落文件再看 EXIT；vitest 走 `pnpm test` 系 wrapper（裸跑挂 alias）；失败先与干净 upstream/main 基线对照定性。
- **回应帖**（英文，回复 OrcaWin 线程）：逐点写处置（fixed with X / proved by Forgejo source Y / rebutted with Z），实测数字或 Not verified 如实；`--body-file` 发送，POST 报错≠没发先 GET 回读，发完逐字节核对。@OrcaWin 开头。
- fork PR 不跑上游 Actions：mergeable UNKNOWN=推送后瞬态数分钟收敛。不谎报，没跑的列 not run。
- 回报：`#36049 | rebase to <tip> | 五点逐条处置 | 验证实数 | 新head | 帖URL | 回读`。产物记 docs/hub/orca/journal/（回报里给行，主线程落账）。
