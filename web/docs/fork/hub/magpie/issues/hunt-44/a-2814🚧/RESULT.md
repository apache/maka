# hunt44 A · #2814 sessions call-cache shard 走 steady.WriteFile —— 执行留档

- 分支：`hunt44-a-sessions-steady`（worktree `/tmp/magpie-h1`，基 upstream/main `95ef45fda4b3978e94f12954a27d41e5ef1dca85`）
- 提交：`e0380455`（单提交，作者 ggbdpq <ggbdpq@gmail.com>，message 含 What changed/Why/Run/预存 flaky 说明/Generated-by 尾注）
- patch：`0001-sessions-a-call-cache-shard-is-synced-before-its-ren.patch`（SHA-256 前 16 `43745408809dc8ce`）
- 状态：**已发布**（分支已推 fork，英文帖已发并回读一致）
- 产物来源说明：本路由由子智能体执行代码与验证，其最终报告被截断；主线程复核了全部关键证据（下方标注「主线程复验」）后补写本文件与英文稿。

## 修法

- 非追加路径：帧在内存里拼好后走 `steady.WriteFile(shard, frame, 0600)`（flush 后 rename，rename 错误返回）——#1505 后 logins.go、plugin/store.go、mcpauth、kiro、codex_autoreset、lastgood 的既有先例。
- 失败只按 shard 路径记一次（`callShardErrors`，`sayCallShardError`），写成功清除；`pruneCalls` 清掉已消失 session 的路径。
- `pruneCalls` 的孤儿 temp 清扫兼容 `.<shard>.*` 形态（旧 `calls-*.tmp` 保留）。
- 追加路径不动（帧头自带 CRC32，撕裂尾部由 `readCalls` 兜住）。

## 验证（子智能体实测 + 主线程复验）

| 检查 | 结果 |
|---|---|
| 定向 `TestCallShard` @head | ok（主线程复验 1.618s） |
| sessions 全量 | ok 11.365s（529 tests） |
| steady 全量 | ok 1.060s |
| sessions `-race` 全量 | ok 24.117s |
| gofmt / vet darwin+linux+windows / build darwin+linux+windows | 全过 |
| 消融（基线 call_cache.go + 新测试） | RED：`a shard whose flush failed was renamed in (<nil>)`（主线程复验 ✓）；恢复绿 ✓ |
| mutation：摘 flush / 吞 rename 错误 | 各自回红；恢复绿 |

预存 flaky（如实登记）：sessions 全包 `-race` 9 跑 1 败于 `TestOpenCodeSubagents`（`testenv.Zone` 与后台 `saveCache` goroutine 竞态）；clean upstream 副本 3 跑 1 败复现，与本改动无关。

## 诚实边界

- 真实 Windows「文件被占用/杀软锁住导致 rename 失败」现场未复现；失败 rename 行为由单测断言。
- 真实强制断电/重启的 flush 保障未实测；保证来自 `steady.WriteFile` 本身（其它存储已在用）。
