# hunt-120 · 4920-usage-enum-snapshot（车道 B，合并车道：#4920 + #4918）

同报告者（KaranocaVe）连报的两支性能单，判定合并车道。**判定结果：两单均判 b) 设计成分 → 分析帖**（报告者建议的跨查询快照 / 增量配对都涉及缓存失效语义取舍），未动代码，无 patch。

- 基线：upstream/main `db7c57670`（发布前后两次 fetch 核实未移动）
- take：[#4920 评论 6590647777](https://github.com/yetone/magpie/issues/4920#issuecomment-6590647777)、[#4918 评论 6590648209](https://github.com/yetone/magpie/issues/4918#issuecomment-6590648209)
- 发布：
  - #4920 分析帖 [评论 6590794813](https://github.com/yetone/magpie/issues/4920#issuecomment-6590794813)（正文 `post-4920.md`）
  - #4918 分析帖 [评论 6590796784](https://github.com/yetone/magpie/issues/4918#issuecomment-6590796784)（正文 `post-4918.md`）

## 核心新事实（两帖的增量）

**#4920（Codex 文件枚举）**
- `queryPageOf` 先 `readRequestState`（全量枚举）再查 `idx.pages`——连缓存命中都先付一次枚举（枚举即失效检查）。
- 一次 Usage 刷新（requests + heatmap）= 两次独立全量枚举（两个 handler 无共享 hold；`ShareListing` 只有 GUI Sessions 在用）。
- 枚举非 Usage 专属：Sessions 15s 轮询 allFiles 同走 `codexFiles`，0.29 CPU-s 是全体读者摊的。
- 实测（Apple Silicon，1200 rollouts/400 天目录）：warm 枚举 6.7–10.3ms/次（≈18µs/目录），冷 1.06s；无变化双查询一轮 ≈15ms。报告者上万 rollout 外推与 0.29 CPU-s/30s 同量级。
- 方案表四格各答「谁买单」；机械候选：`idx.heats` 检查前移（省空闲刷新的一半枚举，需把 adopt 的 root/meta 重置语义一起前移）。

**#4918（recentDays 配对）**
- 三层缓存机制图：`idx.heats`（30s，版本=gateway log snapshot，经 gateway 的调用立即击穿）→ `heatOld`（cut 前 2 天外，10min+heatDisk）→ `recentDays`（每轮全量重配）。
- 探针（测试钩子 heatPairing/pairing/pairsOpening）：每轮 1 条 gateway 行 → `heatSplit paired 9 chunks`、`pairsOpening=6`（全部被命中本地 chunk 重新解包，虽未变化）；gateway 不变只新增 codex 文件 → `pairRowsIn=0`（heats 30s 接住）。
- `pairRowsMemo` 搬不到 recentDays：serials（path:size:mtimeNano）活跃下每轮变必 miss，serials 全同时 pages/heats 已接住——真正缺的是每 gateway chunk 粒度复用；设计关四条（fold 跨 chunk、(serial,index) 重基、actor 随 gateway 行、tokens/cost 红线）。

## 待观察 / 后续条件

- 维护者若点头 #4920 机械候选或 d（刷新内合并）→ 可回此单出结构断言（heats 命中路径零枚举）+ 最小 patch。
- 维护者若点头 #4918 每 chunk 复用路线 → 先出带消融的结构断言（pairsOpening 从「全部命中本地」降到「变化 chunk 相交数」）再动实现。
- 工作床 `/tmp/mg120-b` 与分支 `fix/4920-usage-enum-snapshot` 已清理（无 patch，分支指 tip 零独有提交，删除以免下次踩残留分支陷阱——本次开场即踩过前次残留）。
- 探针测试文件（internal/usage/zz_probe120_test.go）用后已删，探针输出抄录在本 README 与两帖内。

## 探针原始输出（存档）

```text
=== TestProbe120RecentPairingWholesale
  heatSplit paired 9 chunks
  refresh 1: pairRowsIn=1 picked locals unpacked=6
  refresh 2: pairRowsIn=1 picked locals unpacked=6
  refresh 3: pairRowsIn=1 picked locals unpacked=6
  new codex file: pairRowsIn=0 picked locals unpacked=0
=== TestProbe120EnumerationPerQuery
  wrote 1200 rollouts in 400 day folders
  call 0: 1200 sources, 1200 identities, 1.060230083s
  call 1: 1200 sources, 1200 identities, 10.347ms
  call 2: 1200 sources, 1200 identities, 9.139875ms
  call 3: 1200 sources, 1200 identities, 6.714625ms
  call 4: 1200 sources, 1200 identities, 6.969125ms
  refresh 0 (heatmap+requests, unchanged): 82.244375ms
  refresh 1 (heatmap+requests, unchanged): 15.349667ms
  refresh 2 (heatmap+requests, unchanged): 15.208541ms
```
