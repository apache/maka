# NOTES — hunt79-h-3511 (issue #3511, test-only stabilization)

## 基线
- upstream/main @ fetch: e57e785633a7976d9ad31771979a6ed5b2e8e99a (与任务书派单时一致，零漂移入口)
- worktree: /tmp/magpie-hunt79-h, branch hunt79-h-3511
- 占坑: https://github.com/yetone/magpie/issues/3511#issuecomment-6387115556
- #3511 state OPEN, 0 comments, no assignee, no open PR referencing it (checked pr list + body scan)

## 机理复核（实测代码，与维护者描述一致）
- `settledLogStamp` (log_index.go:307): settled = `c.Before(start.Add(-settle))`，
  settle = logStampSettle(1s) 当 `c.Nanosecond()==0`（整秒戳），否则 logFineSettle(100ms)。
- settled==true 时 readLogSnapshot 走 `unchanged = old.settled && settled`（log_index.go:92）或 trusted 链
  （:110-111），**不调用 logRecordHash** → hashed 不增长。
- 测试 (log_hash_cost_test.go:107-150)：whole-second 子测强制 `logChangeTime = changeTime(info).Truncate(time.Second)`，
  读时钟 `logIndexNow = time.Now()+150ms`；断言 `tc.hashes != (hashed > 0)` → whole-second 期望 hashed>0（tc.hashes=true）。
- 红条件推演：追加落墙钟秒内 f，戳=x.0；读 start=x+f+0.15；settled ⟺ x.0 < x+f+0.15-1 ⟺ **f > 0.85**。
  需初始快照+全部 5 个 cycle 均 settled：f0>0.85 且 f0+span≤1.0（span≈0.1s）→ P≈0.05 ≈ 1/20，与 issue "~1 in 20" 吻合。
- 失败文本：`hashed %d bytes over %d appends and reads 150 ms after each`（:146）+ `0 bytes hashed over 5 appends`（:144 Logf）。

## 假设列表
1. （已核）settled 链不调 logRecordHash → settled 即 hashed=0。
2. （已核）fine 子测当前确定性绿：c≤now → c.Before(now+50ms) 恒真 → settled → hashed=0，无墙钟依赖。
3. （已核）cycle 内第二个 Summarize 走 unchanged 路径（同 size/modtime/stamp）。
4. （待验证）修复方案②（读时刻=戳+150ms）对两子测均确定性：whole → stamp.Before(stamp+150ms-1s)=false → 恒 hash；fine → settled 恒真 → 恒不 hash（需初始快照 settled，见下）。
5. （关键点）初始 Summarize 在 loop 前：若 stamp 未初始化（零值）→ 初始快照 unsettled → cycle1 read1 走 :111 hash → fine 子测 hashed>0 反红。**必须 stamp 初始化为 historyLog 的 change time**。

## 修复设计（维护者方向②，代价最小，断言不动）
- `stamp := logChangeTime(mustStat(t))`（historyLog 后、初始 Summarize 前）；
- `logIndexNow = func() time.Time { return stamp.Add(150 * time.Millisecond) }`；
- loop 内 Append 后取 `c := logChangeTime(mustStat(t))`（复用现有 skip 判定），`stamp = c`。
- 断言本意不变：fine 期望 0 字节、whole-second 期望 >0 字节——期望值不软化，只把读时刻从墙钟改为相对戳。
- hold the clock 方案①弃：Clock 只管记录时间戳，ctime 是真实 FS 时钟，冻结不了，代价更大。

## RED 注入设计（确定性）
- 临时改 logIndexNow（不提交）：`func() time.Time { return logChangeTime(mustStat(t)).Add(1050 * time.Millisecond) }`
  ——直接构造维护者说的“读已过戳+1s”：settled ⟺ x.0.Before(x.0+1.05-1)=true 恒真 → whole-second hashed=0 恒红，
  失败文本与 issue 逐字同型；fine 子测同注入下 settled 恒真 → 仍绿（对照组）。

## 兄弟面清单（同文件同型墙钟依赖逐一判定）
1. `whole-second_stamp` — 本单目标，改。
2. `fine_stamp` — 同 closure 但 fine 下无墙钟依赖（c≤now 恒 settled），不改，已论证。
3. `TestUsageAppendReadHashesNoPreReadScan` — 只断哈希上界（>2.1×size 才 fatal），settled 方向只会少 hash，无红面；初始 settle 用 now+2s 稳定。不改。
4. `TestUsagePartialLineThenCompletion` — settleLogClock=now+2s 或不 settle，断数据正确性不断哈希计数，无墙钟分数依赖。不改。
5. read_ahead_test.go / growing_rewrite_test.go — rg 无 logIndexNow/logChangeTime 引用。不涉。
6. incremental_log_test.go — `time.Sleep(logStampSettle+20ms)` 真睡，稳。不涉。

## 失败读取语义
N/A — 本单 test-only，不触产品读失败路径（readLogSnapshot 产品代码零 diff）。

## 交付记录（2026-10-25）
- commit: 6c99a27fa65be2f1a27c77d23f864cdd45e08dfe（作者 ggbdpq <ggbdpq@gmail.com>）
- fork 分支: hunt79-h-3511，ls-remote 比对一致；merge-base=upstream/main=e57e7856（发布时 upstream 零前进）
- patch sha256 前16: 17e0d654914ffb66
- take: issuecomment-6387115556；交付帖: issuecomment-6387240709（GET 回读八项全过：GLM=1、中文=0、fence 2、details 1/1、patch 内嵌、Attribution/分支链接/SHA 齐）
- 自然红: 13/100（本机 macOS arm64，issue 报 ~1/20；窗口宽度随单 cycle 耗时变化，机理同）
- 注入 RED: 读=戳+1050ms，10/10 红，文本同 issue；注入 GREEN: 修复+戳回拨 1s，20/20 绿
- 消融: 同注入打基线（撤修复）→ fine 10/10 红 + whole 10/10 红（原输出 /tmp/hunt79-ablation.log）
