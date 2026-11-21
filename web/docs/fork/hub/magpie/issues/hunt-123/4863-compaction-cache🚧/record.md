# 4863-compaction-cache 车道记录（Lane C，2026-11-03）

## 结局
判定帖发布，未改代码（无 patch/无分支/无 push）。
- 帖：https://github.com/yetone/magpie/issues/4863#issuecomment-6616369515
- take 帖：https://github.com/yetone/magpie/issues/4863#issuecomment-6616346730
- 基线：upstream/main tip `d8b3749ef`；GET 回读八要素全过（零中文/表格/互引/SHA/AI use/尾部完整）。
- worktree /private/tmp/mg122-c 树净 @fix/5010-dsh-citations（未动，无产物可推）。

## 判定
#4863（compaction 面）与 #5043（replay 面）= 同一终点路径（replaySession，claude_replay.go），不同触发器。报告者两组数字（read 19,448/write 198,192；read 12,145/write 67,268）与 #5043 判定帖的 replay 签名（21,280/221,350）同形：read≈system+tools，write≈全史。

## 机理链（已核验行号，main d8b3749ef）
1. compaction 请求带上一轮 tool results → `match` 无活 run 等结果（"tool results no run waiting"）。
2. 无 idle run、shelf 精确 turnKey 未命中（unshelve 仅 prompt-suggestion/rewritten 两回退）→ `whyNoRun` 落 `b.lost`（"ended 20m36s ago: another run was kept in its place"）——该条目是被 3 分钟前 unshelve 消费的更早 run 的死亡记录，报告者"log points at the wrong cause"属实（为何更新的 run 无记录见下）。
3. from==nil → `replaySession`：两行 transcript（整史一个 user message + 末回复）、--resume、typed 64 messages → 前缀从未被缓存 → 全量写。

## 根因（结构性缺口）
**parked on tool calls 时死亡的 run 三不靠**：`park` 不算 shelf 键、`shelve` 前置 idleKey（2278）、`removeRun` 删未 shelve 的 session 文件（5700-5702）；convKey 仅 keepIdle(2191)/letGoOversized(rss:113) 设置 → 死亡无会话级记录。`oversized(3)` 注释自认此权衡（claude_rss.go:59-65）。427K preTokens 正是 RSS 预算放手的尺寸 = 客户端触发 compaction 的尺寸，两系统同时刻相撞。

## 假设排序
- H1 终点路径 replaySession 全量写：已钉死（代码+日志+数字三证）。
- H2 自动 compaction=parked 死亡链：最强（日志逐行吻合），死亡原因一行（oversized(3) let-go 或普通退出）待报告者日志定。
- H3 手动 /compact 维度漂移（-p 客户端 prompt≠run）：可能，未验。
- H4 compaction 请求自身 system/tools/model 漂移：并入 Option 2 理由，未验。
- H5 TTL 过期：已排除（3 分钟前健康轮次证明 session 当时新鲜可达）。

## 留维护者两案（帖内判定表）
1. parked run 死亡时 shelve 其 session（park 时算键，结果请求与 compaction 走正常 unshelve；重量级：park/shelve/removeRun 生命周期改造）。
2. unshelve 会话级回退（freshest entry of same conversation；轻量，仅 shelf 有货时有效；与 1 互补）。
- 不可行单独项：replaySession transcript 字节保真（thinking/signature 不回传 → 前缀仍断，#3808 域）。

## 向报告者要的证据（帖内已列）
1. 健康轮（read 173,738）到 compaction 请求之间的日志行（`is let go while it waits on tool calls` / `stopped`）。
2. 活 run idle 时紧接健康轮的手动 /compact：读缓存=纯 parked 死亡链；重写=维度漂移参与。

## 后续杠杆
- #3808（取消后一轮全量写）与 #5043 剩余项 1、#4863 三案同终点路径，帖内已主张合并推进。
- whyNoRun 的 b.lost 陈旧日志（误导性"ended X ago"）是廉价独立修法候选，帖内已指出机理（5635 keepLost / 5813-5817 回退序）。

## 车道 B1 收尾（2026-11-05，实施 Option 1 并发布）

- 实现：worktree /private/tmp/mg123-r2-4863-replay-cache-diagnose，分支 `fix/4863-replay-cache-diagnose`。O2 车道留提交 `0ae5eef70`（重启前未推未发），B1 补验证+rebase+推送+发帖。
- rebase upstream/main `c3ba2cc93` 无冲突 → **`605b14910720c90e7c85a1382b87eb14e5e7c1ab`**；fork 分支 https://github.com/ggbdpq/magpie/tree/fix/4863-replay-cache-diagnose
- diff 面：claude_subscription.go（parkKey 字段 + park(key)/shelveParked + removeRun 死亡 shelve，+54/-6）+ claude_rss.go（oversized 注释，6 行）+ busy_test.go（park("") 签名适配）+ 新测试 claude_subscription_park_shelf_test.go（173 行，行为级：deadClaude 假 CC 脚本，断言 --resume 且只告知增量）。
- patch 副本：本目录 `0001-claude-bridge-a-run-that-dies-parked-on-tool-calls-s.patch`；SHA-256 前 16 `7cebfb1554d8e421`（全 `7cebfb1554d8e421605d...`）。
- 验证矩阵（实跑，GOCACHE=/tmp/mg123-b1-gocache）：新测试单跑 ok 1.999s / 全量 `go test -tags nogui ./internal/gateway` ok 699.112s EXIT=0 零预存红 / gofmt -l 四文件净 / go vet -tags nogui 净 / **消融回红**：checkout parent 的 claude_subscription.go+busy_test.go 后新测试 FAIL（replaySession 全量粘贴触发增量断言，行为红），checkout 0ae5eef70 恢复树净 / race ok 3.291s / rebase 后复跑 ok 2.388s。
- 帖：https://github.com/yetone/magpie/issues/4863#issuecomment-6637609523 （五段+三件套；GET 回读九要素+零中文+作者 ggbdpq 全 PASS，19375 字符）。
- Not verified（帖内如实）：真实 427K 会话/Claude Max、报告者构建、Windows/WSL（测试替身 shell 脚本 skip）。
