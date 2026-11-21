> 历史（2026-09-27 性能方向调研，基于 upstream/main @ fffc19fb5）：候选与数字未随上游刷新；maka 自 2026-10-30 起停接新单，本文仅备查。现行入口见 [handbook/12-维护任务书](12-维护任务书.md)。

# Maka 性能优化作战地图

> 面向：以 apache/maka 性能优化为方向的接单与提案规划。
> 性质：活文档，随情报更新持续追加；所有数字带来源，未实测的标注为估计。
> 更新：2026-09-27（基于 upstream/main @ fffc19fb5）。

## 0. 思维模式选型（性能域的五个抓手）

| 模式 | 在性能工作里的具体用法 |
|---|---|
| **第一性原理** | 每个慢都回到"哪一步在处理多少数据"——rows scanned / bytes encoded / DOM nodes / frames serialized。不接"感觉慢"，只接可计数的放大。 |
| **对抗式审查** | 对已有 baseline 做证伪：历史计时是否还有效（#4677 明确警告 130s 老数据非当前基线）、PR 报告的收益是否同机同负载。 |
| **奥卡姆剃刀** | 同一收益取最小机制：能改索引/SQL 不改架构，能加 watermark 不换数据结构。 |
| **YAGNI** | 不为不存在的负载加缓存/并行；先测量证明热点存在再动手（#5038 原话：consolidation alone is not performance acceptance）。 |
| **列出无信心点** | 每个提案标注"未实测/估计/合成负载"三档置信度——维护者（Astro-Han）对这点极其较真，#4677 通篇在区分 measured 与 theoretical。 |

辅助：**消融**（删掉优化验证收益归因）、**蒸馏**（把 30+ 已合并 perf PR 的共性模式做成可复用清单，见 §2）。

---

## 1. 样板拆解：#5556（82.5% 极致优化的完整范式）

`perf(runtime): scope recovery work and tool validation`（已合并 09-23，effort/XXL）——**这就是我们要复制的模板**。

**问题**：启动恢复 + 工具验证的成本随**全部工作区历史**线性增长（与本次启动无关的 Session 也在被扫描）。

**修法的四个机制**（全是复杂度层面的手术，不是微优化）：
1. 先用**轻量控制态**分类恢复义务（obligations），只对已识别的义务加载完整 Runtime 证据——两阶段查询，避免全量物化；
2. 无恢复准入的 Session **跳过准入证据**读取；
3. 未决 Client Capability 发现**跨恢复 Session 批处理**（N 次查询 → 1 批）；
4. Plan 状态只作 active-o…（活跃义务的过滤信号）。

**结果**（302 Sessions / 857 Turns / 19,465 工具对 / 90,942 RuntimeEvents 的使用级 fixture）：

| 里程碑 | 前 | 后 | 降幅 |
|---|---:|---:|---:|
| Host ready | 13,273 ms | 2,319 ms | **82.5%** |
| composer 可见 | 14,282 ms | 3,316 ms | 76.8% |
| 输入可响应 | 14,918 ms | 3,879 ms | 74.0% |
| 选中历史可见 | 15,754 ms | 4,540 ms | 71.2% |

**配套**：schema-19→20 迁移加 4 个定向恢复索引；DB 只涨 0.196%；三次生产迁移中位 1.38s。

**可复制的三要素**：①真实规模的 fixture（30 万行级）；②里程碑化的测量（不是单一数字）；③复杂度论证（"scale with X rather than Y"写进标题）。

---

## 2. 已收割模式蒸馏（30+ perf PR 的共性——找同类未被收割的点）

| 模式 | 案例 | 还能套用的空白点 |
|---|---|---|
| **两阶段查询：先轻量索引定位，再按需加载重证据** | #5556（恢复义务分类） | 恢复之外的"启动预扫描"路径：WorkHub linkage、memory 检索 |
| **批处理跨实体重复查询** | #5556（capability 发现批处理）、#5263（memory 搜索批量化） | 跨 Session 的 artifact/usage 聚合读 |
| **页构建器从 O(n²) 序列化改增量/流式** | #5166（16 个页构建器去重复编码）、#5510（transcript 增量物化） | #5038 点名的 5 个残留页构建器（§4.2） |
| **全记录写 → 增量/delta 写** | #4716（artifact 元数据 delta）、#4955（scheduled-task 点操作） | Shell 输出持久化全记录 `record_json`（#5038 §Shell，未测量） |
| **并行化独立 IO** | #5096（Claude Code transcript 列表并行） | 恢复期多 Session 索引加载、启动期多源探测 |
| **渲染窗口有界化** | #4259（超大 Turn 渲染）、#4539（Usage 分页）、#5532/#5550（按变更粒度发布） | 冷滚动的锚点几何（#4259 验收中）；历史搜索的预加载（#5523 有主） |
| **合成负载治理（写入放大）** | #4722（193MiB→1.88MiB 诊断物化） | 恢复扫描的重复全元数据读（#4677 未解项） |
| **缓存跨生命周期复用** | #4977（Mermaid 跨 remount）、#5040（工作区文件搜索）、#4917（提升的 var 绑定查找） | 字体加载/工具验证（#5614 有主） |

---

## 3. 权威方向：两个 tracking issue 就是选题权威

### #4677（用户可感预算——Desktop/Host 侧）
目标预算（验收口径，直接抄进 PR 正文当验收标准）：
- 本地 Session 打开到可见 tail：**p95 ≤ 150ms**
- 长 Session @30ms RTT：p95 ≤ 800ms
- 正常输入/滚动/hover：**无 >50ms 的 task/LoAF**
- 目录单次更新 1000 Sessions：renderer 侧 **≤ 16ms**
- Host 启动 / WorkHub / Usage：**预算未定（缺当前基线）——这就是可贡献的空白**

未勾选的交付项（= 可接单候选）：
- [ ] 超大 Turn 渲染验收（hover 收益 + 冷滚动/无障碍）——#4256/#4259
- [ ] 旧→新→最新导航与阅读位置保持——#4123/#4560
- [ ] **移除 WorkHub 打开/重连的全量 replay**——#4647/#4699
- [ ] **重profile Host 启动**，解残留恢复/批清理成本——#4027/#4038（见 §4.1，最大极致机会）
- [ ] Usage Activity 渲染有界 + 进 tab 延迟记录——#4531/#4539

### #5038（读写放大——Storage/Host 协议侧）
已点名的具体 O(n)→O(目标) 热点：
- **页构建器重复序列化**（追加一项→全页重序列化→丢弃）：memory-projection、artifact-coordinator、plan-coordinator、session-catalog-coordinator、runtime-resource-projection 五处。#5166 收割过 16 个构建器，这批是残留。
- **Shell 输出持久化全记录 `record_json`**：ShellRunManager.queuePersist → updateShellRun 全记录重写。**尚未测量**——tracking 的 delivery checklist 明确要有人来量。
- Byte-limit helper 与 `protocol/codec.ts` 的私有副本整合（transport 已接受 `EncodedProtocolMessage`，可沿既有缝扩展）。

---

## 4. 极致机会矩阵（按"数量级收益潜力"排序）

### 4.1 Host 启动的 artifact 阶段 —— ⭐ 最大剩余机会
- **历史画像**：冷启动 ~11.7k artifacts 时全启动约 **130s**，其中 artifact 元数据/清理阶段约 **90s**（#4027/#4037/#4038 的历史数据）。
- **现状**：多个持久化变更已落地，#4677 明确要求 **fresh startup profile**——老数字不可信，这正是切入的合法姿态：**先重新 profile，用新数据开 issue/PR**。
- **候选动作**：①恢复扫描的两阶段化（复制 #5556 模式到 artifact 域）；②批清理（#4038/**#4984 PR 仍 open 在审**（09-28 核实），该域在途勿碰）；③点读有界化验收（#4874 open）。
- **量级预期**：90s → 秒级（#5556 同款两阶段+批处理在同量级数据上打出过 82.5%）。
- **本机可行性**：需要构造 11.7k artifacts 规模的 fixture——存储操作全部本地 SQLite/文件，Windows 可做。

### 4.2 页构建器的二次方序列化（5 处残留）—— ✅ 已收割，勿再投入（2026-09-28 核对定案）
- **核对结论**：#5038 的五处（memory-projection / artifact-coordinator / plan-coordinator / session-catalog-coordinator / runtime-resource-projection）**全部已被 #5166 修复**（3d3a85069，2026-09-12 合并——晚于 #5038 证据基线 87797378c 四天，issue 正文未回填）。当前 main 五处均为 `JsonArrayPageBudget.tryAppend` 增量模式（信封只量一次、候选项才序列化、接受项不重编码）；#5166 实际覆盖 16 个构建器并附 39,000 样本 before/after（代表页中位时间 −5.2%～−74.8%）。
- **全仓扫描无漏网**：server 目录 15 个未用预算类的疑似文件逐个查 `stringify(candidate|page)`，仅 3 处命中且均为有界减半（PTY snapshot）或一次性量测，非页装配循环。
- **教训入册**：tracking issue 的 "Current evidence" 不随修复回填，接单前必须逐文件核对当前 main——本次五处若直接开 PR 会全额撞车。

### 4.3 1000-Turn hydration 端到端验收 —— ✅ 已交付（2026-09-28 深夜，舰队回合）：PASS
- **实测 p95 = 95.8ms 对 800ms 预算（余量 8.4 倍）**，open→tail 与 Session 长度解耦（tail 恒 84 msgs ≈20.5KiB）；全量 hydration 对照 1.37s（22×）；对 #2913 理论下限 150s 好两个数量级。[评论](https://github.com/apache/maka/issues/4677#issuecomment-5872906343)
- 方法：真组合 + 每 RPC 前后注 15ms 飞行延迟（`subscription.open`/`session.transcript.page` handler 即线路往返 seam）；harness 未提交（pr5 clone 未跟踪文件 `hydration-e2e-benchmark.mjs`，有 KiB 显示已修；可按 #5791 模式开脚本 PR，先经主智能体审）。
- **附带发现：注册的 `benchmark:transcript` 脚本在当前 main 已坏**（调 `store.readTranscriptPageSnapshot`，分页迁 ledger reader 后方法不存在）——候选小修复 PR。
- 诚实边界：in-process RPC + 模拟飞行延迟（无真 socket/TLS/WS 帧）；p95 基于 10 轮=max（弱尾）；fat fixture 未跑（seed 1.36s/turn，1000 turns≈23 分钟）。

### 4.3b 冷滚动/超大 Turn 验收（#4677 item 1）—— 侦察完成，本机数字暂留本地不发
- **验收断言已存在且本机 PASS**：`app-shell.stories.tsx:3238/:3325` 冷滚动锚点界**已从 #4259 时代的 120px 收紧到 1px**（#5184 geometry contract），collapsed/live 两 story 绿。
- 本机 workload 数字（msedge headless，合成 wheel，n=24）：每 240px 步意外位移 median **15.44px**（历史 239/244px 的数量级改善）。**暂不贴 GitHub**：方法与 story 断言不同源（合成输入 vs reader 路径），且缺 managed CI 正式数字（`performance-frontend.yml` 在 main 后从 Actions 跑）——等 CI 数字再发，避免方法学争论。
- **item 1 未闭合半边：hover gains**（#4259 评论区的 300-small-Turn rail A/B 无人跑）。artifact：`%TEMP%/maka-coldscroll-recon/`（results.json + driver.mjs）。
- 环境坑：Playwright chromium 下载本机卡死（cdn body 不推进），用 `channel: 'msedge'` 绕过。

### 4.4 WorkHub linkage 全量 replay 移除 —— ✅ 验收证据已交付（2026-09-28），等维护者 tick
- #4647/#4699 已由 Astro-Han 本人实现并合并（09-05）。#4677 item 3 的验收半边已由我交付（[评论](https://github.com/apache/maka/issues/4677#issuecomment-5870998857)）：独立复现 3.1/32.7/202.8ms @ 100/1000/6000（作者 3.3/32.4/193.6ms，跨 OS 偏差 ~5%），harness 自带 0-active 断言 + not_owned 阳性对照；三套件 48 用例全绿（storage assignment 11 + crash-recovery 7 + coordinator 30）。无 WorkHub 专属 UDS 套件，传输并发归 CI。
- **残留语义（PR 正文自述，有意保留）**：on-demand 解析 O(目标 Session 自身 WorkHub 历史)；`maxAssignmentsPerTarget` 不对全终态目标生效。修复方向（stop_work 命名不对称→anti-join 无法下推）**维护者单独写方案中**——修复位被占，勿开实现 PR。
- 测量 harness：`%TEMP%/maka-workhub-linkage-bench.mjs`（临时脚本，未入库——修复方案落地时维护者会有自己的 harness，先不添维护面）。
### 4.5 Shell 输出持久化 —— ⛔ 已被认领（2026-09-28 核实）
- **liuxiaocs7 于 2026-09-08 在 #5038 评论区认领**第 2 交付项，09-14 仍在活跃推进（SQLite 物理布局诊断后修正方案：same-row 分列不保证免 WAL overflow 页写）。截至 09-28 无 PR。**勿再投入。**
- 其基线数据可直接引用：1MiB retained/64KiB changed → update p50 3.9ms、序列化放大 16x、WAL 放大 12.5x（Apple M4 Pro）。
### 4.6 Usage 有界读的 Storage 侧 —— 部分收割，剩 All-range 验收
- #5023（Sun-GLiang 的 design-only draft）**已于 2026-09-16 关闭**，设计会话死亡；#5514/#5517 已合并（页查询有界 + 范围统计复用）。
- 剩余：#5038 第 5 交付项——#5019 的 All-range 场景 + SQL scan/sort 实测。设计决策未对齐，**大动作前必须先在 issue 对齐方向**。

### 4.7 冷滚动锚点几何（交互级，毫秒到像素）
- 旧头 239px 异常位移 → 新头 32px（120px 测试界），**独立复测未做**（#4259 遗留验收）。测量型小 PR 候选。

### 4.8 CI/测量基建（低竞争高频合并区）
- 已有 #5042（manual frontend/protocol measurements）、#5243/#5250/#5251/#5419（CI 提速线）。**新测量设施 PR 的合并率高**——比如"Host startup p95 自动化基线"直接补 #4677 的"Missing numbers remain open acceptance work"。

---

## 4.9 已产出：fresh startup profile（第一步实测，2026-09-27）

测量工具：`packages/runtime-host/scripts/startup-profile.mjs`（本分支未提交，随测量 PR 交付）。
构造 fixture 后重启组合，分锚点计时（open / recover / firstQuery / close）。

**第一组数据（100 sessions × 3 turns × 2 artifacts，3 轮重启 median）**：

| 锚点 | median |
|---|---:|
| open（组合构造+store 打开） | 16ms |
| recover（五阶段域恢复） | **159ms** |
| firstQuery（首个 catalog 查询） | 1.1ms |
| close | 10ms |
| 重启合计 | **185ms** |

**结论（对抗式验证后的初步判断，待 12k-artifact 放大复核）**：
- 100-session / 200-artifact 规模下恢复只要 159ms——**#4027 的 130s/90s 残留在该规模不存在**，
  #5556 系列的收割是真实的。真正未验证的是 **11.7k artifacts 量级**（#4027 原始形态），
  放大实验进行中（300 sessions × 40 artifacts ≈ 12k artifacts）。
- **12k 放大结果已出（决定性）**：300 sessions × 900 turns × **12,000 artifacts**（#4027 原始形态量级），
  3 轮重启 median：open 14ms / **recover 397ms** / firstQuery 1.2ms / close 23ms / **合计 435ms**。
  对照历史 130s 启动（90s artifact 阶段）：**残留在当前 main 已不存在**，#5556 系列与各持久化
  变更（#4716/#4037/#4038/#4874）合计收割 >99%。且 30 倍数据放大 recover 仅 2.5 倍（159→397ms，
  亚线性）——启动恢复域**从机会矩阵降级为维护性验收**（#4038 批清理验收仍 open，但成本可控）。
  30 单预算的重心正式移向：§4.2 页构建器 O(n²)、§4.4 WorkHub replay、#5023 Usage 读、§4.8 测量基建。

seed 成本记录：~6.3s/session（FakeBackend turn 完成等待占 ~4.2s），300-session 放大约 40 分钟。
**附带发现已定性并修复（09-28 晚，#5791 follow-up ca2c639d3）**：turn 完成等待里的"恒定 ~2s/turn"
**不是 FakeBackend 拓扑固定成本，是打字模拟 × 我的种子文本长度**——FakeBackend 非 steering 响应按
9 字符/块切块、每块 sleep(45)（有意模拟模型流式输出），283 字符种子文本 = 32 块 ≈ 1.44s 纯 pacing。
修法：startup-profile.mjs 种子文本缩到 ~25 字符（3 块，仍走流式多 delta 同款持久化路径），
1 session×2 turns 种子 4.5s→1.9s，300-session fixture 约 40 分钟→约 15 分钟。FakeBackend 本体不动
（测试依赖该模拟）。**教训：先做算术再归因**——块数×sleep 一步就能算出 1.44s，省一轮侦探小说。

## 4.10 已产出：#4722 残留全读 re-assess（第三单实测，2026-09-28）

[评论](https://github.com/apache/maka/issues/4677#issuecomment-5871314423)。harness：`%TEMP%/maka-artifact-readall-bench.mjs`（applyChanges 批量播种 + 模板记录克隆，防 decoder 拒形）。

| records | readAll | listPage(64) | pointRead | create |
| --- | ---: | ---: | ---: | ---: |
| 500 | 0.8ms | ~1ms | ~1ms | 7ms |
| 6,000 | 10ms | ~10-12ms | ~10ms | 16ms |
| 12,000 | 25ms | 25-30ms | 25ms | 32ms |

**结论**：残留确认线性（~2µs/record），形状无关（目标 Session 增长 = 无关 Session 增长）——#5038 item 3 的"无关 Session 增长时有界吗"答案为**无界**；但绝对量级在已知最大真实规模（12k）仅 ~25ms/次，预算内。**定位：#4722 设计门控的镜像失效变更维持正确载体，不急**；#4874（lhpqaq 在途 PR）是点读有界化实现，我的数字是其 before 基线。附带教训：#4874 在途说明该域有主，测量可以、修法绝不碰。

## 4.11 舰队回合（2026-09-28 深夜，六 clone 并行，2026-09-28 战果汇总）

用户授权并行舰队（六 clone 各领一单，主智能体串行收口 GitHub 写入与共享文档——**取代补记七的"跨 clone 禁令"**）。五路返回、一路超时（pr2 Usage Activity 验收，desktop 环境最重，待重派）：

1. **#4677 item 5 全解**：fresh profile（第一单）+ #4722 复测（第三单）已交；✅
2. **hydration 验收 PASS**（§4.3）+ 坏 benchmark 发现；
3. **#5038 item 5 定界**（主仓库单）：**五条锚点全关**（#5387 实现/#5019 报告者复验关/#5514 Fixes #5515/#5517 合并/#5515 SQL 已测）——[闭环评论](https://github.com/apache/maka/issues/5038#issuecomment-5872914867)已发，transfer 字节数未单独测（构造有界）留了口子；
4. **#4677 item 2 十场景盘点**（pr4 单）：#5366 推翻 #5170 滑窗架构并**删光十场景回归线**——映射表已发[评论](https://github.com/apache/maka/issues/4677#issuecomment-5872928299)请维护者裁决（勾掉 vs 补场景 9 帧预算断言）；残留疑点：`desktop-transcript-range-store.test.ts` 在 #5366 后仍存在；
5. **byte-limit 整合**（pr3 单）：#5166+#5356 已结算性能实质，剩余整合面仅 turn.ts 一处 ~30 行机械去重——**含金量最低，进后备池不开**；
6. **冷滚动**（pr1 单）：见 §4.3b，本机数字留本地等 CI。

## 5. 启动性能专线（用户点名方向）的现状与残图

#4677 五个 untick 项现状：item 1 半闭合（等 CI 数字+hover gains）、item 2 等维护者裁决、item 3 已交、item 4 未动（pr2 超时）、item 5 全闭合。#5038 五项：item 1/5 已交闭环证据，item 2 liuxiaocs7 持有，item 3/4 等在途 PR（#4874/#4984）。




```
启动链路（#5556 之后）：
  [Host ready 2.3s ← #5556 已收割 82.5%]
     ├─ artifact 元数据/清理：历史 90s 残留 → 需 fresh profile（§4.1）
     ├─ 恢复扫描：两阶段化已收割，重复全元数据读未解（#4677）
     ├─ 批清理 #4038/#4984：交付未验收
  [composer 可见 3.3s]
     ├─ 字体加载 + 工具验证简化：#5614（有主）
  [输入可响应 3.8s]
     ├─ 启动任务图注册：#5380/#5414/#5591（refactor 线，有主）
  [Windows 特有]
     ├─ ACL 慢启动 #5323（已修）、TDZ #5302（open，bug 非性能）
```

**空白判断**：启动的"恢复与验证"大头已收割；剩余的合法切入点按顺序——
1. **fresh startup profile**（没人做，#4677 点名，测量型 PR 起手）；
2. **artifact 阶段两阶段化/批清理**（90s 残留）；
3. 启动预算 p95 的制定 PR（#4677 开口要的）。

---

## 6. 方法论闭环（每个 PR 都走这五步）

1. **找**：从 tracking issue 的未勾选项 + 本地图谱 §4 选点；先查认领（issue 页 assignee + 评论 take）与上游是否已有 PR（search `Fixes #N`）。
2. **量**：构造使用级 fixture（行数/字节数写进 PR）；里程碑化计时（median，多次）；同机同负载 before/after。测量工具现状：`benchmark:session-copy`、`benchmark:transcript`（runtime-host scripts）——缺的场景自己写 benchmark 脚本随 PR 交付（#5526 先例：纯测量 PR 也能合并）。
3. **修**：复杂度层面的手术（两阶段/批处理/增量/并行/delta），不微优化；标题写 `perf(scope): <what> scales with <X> rather than <Y>`。
4. **验**：消融（revert 单提交收益消失）；对 #4677 预算表报数；Windows 本机跑不了的（UDS/macOS）如实标注交 CI。
5. **交付**：PR 正文带测量表（抄 #5556 的三列格式）；链接 tracking issue 的对应 checklist 项；台账记录。

---

## 7. 无信心点（当前地图的弱点）

1. **130s/90s 是历史画像**——#4677 原文警告"not the current baseline"。若新 profile 显示已降到几秒，4.1 的机会就缩水。**动手前必须先跑 fresh profile**。
2. ~~页构建器残留清单的时效~~（已消解：09-28 逐文件核对，五处全被 #5166 收割，见 §4.2）。
3. **fixtures 的生产代表性**：合成负载（合成 Sessions/turns 分布）与真实用户数据的偏差是维护者最常 challenge 的点。
4. **Windows 本机**：部分 benchmark（UDS 双客户端类）跑不了，只能交 CI——测量型 PR 要设计成 Linux CI 可出数的形态。
5. 多性能 issue 显示有主（#5460 seekskyworld、#5523 liuxiaocs7、#4037 lhpqaq、#5038/#4677 Astro-Han 持有 tracking）——**接单前重新核对 assignee**，本地图谱的认领状态是快照。

## 8. 下一步行动清单（2026-09-28 晚核对后重排）

0. ~~跑 fresh startup profile~~（已产出两级画像并交付 #4677 评论，2026-09-27）。
1. **【进行中】PR-1：startup-profile.mjs 入库**（`packages/runtime-host/scripts/` + package.json 注册 `benchmark:startup-profile`，#5526/#5042 形态先例），正文附 12k artifacts 435ms 画像与 #4677 预算提案。在 maka-pr5 执行，分支从 upstream/main（fffc19fb5）切，不带本地 allowScripts 补丁提交。
2. PR-1 合并后候选（按序评估认领与本机可验证性）：
   - ~~#4677 item 3 WorkHub 验收~~（✅ 09-28 已交付，见 §4.4）；
   - ~~#4722 残留全读成本的 re-assess~~（✅ 09-28 已交付，见 §4.10）；
   - **冷滚动锚点几何复测**（#4259/#4677 item 1，#5042 的 scripts/perf Playwright/Storybook 基建可复用；需要 desktop e2e 环境）；
   - **#5019 All-range 验收**（先在 issue 对齐再动手）。
3. ~~页构建器五处~~（#5166 已收割，09-28 核对定案）；~~Shell 输出测量~~（liuxiaocs7 持有）；~~WorkHub replay 实现~~（已合并，修复位维护者自留）。
4. **09-30 竞态与在飞更新（09:00 晨间终版）**：#5842（Dante-dan take）、#5844（garvit-arora take）易主只供数据；#5843 等维护者方向输入（#5845 双审零 finding 等审）；0.6.3 升级核验病灶 15+1 条同形。**09-30 晨战果（七单全收）**：九 PR + #5845 全部 mergeable 干净等审、CI 全绿——#5744（f64e2fe88）/ #5805（738e9b57b）/ #5274（436e4359e 语义对撞 + b97145c7b 棘轮归零，CI 绿）/ #5265（0ac4a7ef9 + 0f26b77c7 两连修：side 进窗口、窗口排空在飞 retraction、rewind 同病一并修，CI 绿）。**新诊断 issue [#5864](https://github.com/apache/maka/issues/5864)**：大会话热切 ~2.5x 慢的机制全链（切走全拆 + 130 页/88.8MB 全量重读 + ~5.9s 周期 resource 轮询占道准入车道 6s/次）——**修法方向 (d) 轮询占道是最高杠杆单点，(c) tail-first 直接对口 #4677 预算；跟随前先在 issue 对齐**。预算 **32/50**。
5. **10-01 凌晨复扫：#5864 修法空间被 #5712 大幅收窄（预算 36/50）**：开场全流程（fetch+九 PR 三端点+mergeable）= **九单全部干净等审零新 finding**（#5265 09:27 溯源 P2 已由深夜场 eb0f8e4ed 闭环）；五 clone 全部与 origin 同步无竞态。**#5864 重叠判定（读 #5712 diff 实证）**：testikun 的 #5712（Fixes #5627，54 文件，自报热切同域数字 10.9s→663ms）覆盖本 issue ②全量重读半边（bounded range store + reader-position-following）与 ③的扫描成本半边（`listShellRunUpdates`/`getSessionUpdate` 对无 parent Session 不再读转录投影历史，新测试名即 "without reading transcript history"）；其文件清单无 polling/admission/workbar 文件。**剩余独立空间仅三条**：①切走全拆（closeIfIdle 订阅生命周期）；③的节奏/分道设计半边（5.9s refire + 准入车道独占，快扫描也不使车道共享安全）；④64MiB 预算页后超读前置检查。**新 issue 四道闸**：#5877（Recall N+1）被 liuxiaocs7 take+#5880 占坑排除；#5879（tool_search prompt cache 失效）不接——作者 sunrioa 持 14 天真实 usage 数据自做意向明显 + 验证依赖真实 provider cache 计数本机不可为。**已发 #5864 对齐评论**（[issuecomment-5912894688](https://github.com/apache/maka/issues/5864#issuecomment-5912894688)）：重叠情报 + 残留三空间 + 提议 #5712 合并后同 rig 复测残留基线再定跟进方向（优先序：预算前置 < 订阅生命周期）。留观不变：#5744×#4865、冷滚动贴数（main 仍零运行记录）、#5523（nudge 后静默）、#5843。
6. **10-01 白天场：#5691 part-3 定界完成，裁决等 #5709 合并（侦察单已耗）**：九 PR 零增量、接单池实锤枯竭（五候补全被 take+占坑 PR）。part-3（abort 记 usage-unknown 而非假 0）是 issue 正文明确项，**地基全现成**（usageBasis/coverage/resolveUsageBasis/读侧 SUM/schema CHECK），真正接缝 = 辅助调用在 run 外、canonical writer 不可达，需给 InteractiveUsageStoresWriter.modelCalls 加写接口（API 面扩张，动手前先在 issue 留设计意图）。与 #5709 交集最小核心 ≈0-2 文件但 #5709 随时落地必自造 dirty → **等合并信号，最小核心形态 150-250 行 + 6-10 用例，5-10 分钟验证轮**。附带发现：createHostPluginModel 用 callKind:'main' 走辅助管道写旧表（plugin 伪装 main），迁移时需定性。byte-limit 整合实现单在飞：首轮停手回报实为**三处私有副本**（turn/message/session-continuity，runtime-host protocol），超限消息文本与公共版有差异（判定与 code 零差异、无测试锁定）→ 已裁决三处全换公共实现。**→ 已收口为 [#5887](https://github.com/apache/maka/pull/5887)**（head e441dcf6b，+3/−36，披露消息文本变化，protocol.test.js 88/88 双绿，epoch 200 不变；CI 一轮红=epoch guard 视三文件为协议变更，加豁免声明 JSON 转绿，**预算 39/50**。新坑：豁免 JSON 纯 JSON 无注释头；守卫 staged 路径要显式 --staged；本机守卫验证须 fetch 后对最新 tip 跑）。10-01 续场：#5709 第二次撞号（#5884 用 201）→ callKinds 顺延 202，merge commit 2d7ea3448 已推收口；#5712 未合并（复测继续等）、issue 池枯竭、#5864 无回应。
7. **10-02 晨场：池枯竭 + #5909 误诊让坑（44/50）**：main→57964425a（#5896/#5746/#5888；**#5888 未触 protocol/index.ts → #5709 epoch 203 保持**，竞态者 #5753/#5495/#5902 均未合并）；十二 PR 三端点零新 finding、mergeable 全 blocked、CI 全绿；#5265 补发欠账回复（eb0f8e4ed 的溯源 P2 修复，此前只推未复）。10-01 当天 6 新 issue 全排除（#5903/#5907 me2seeks、#5898/#5899 Dante-dan、#5905 被作者自开 PR #5906 占坑）；#5909（Storybook 预览缺 token）诊断为误诊已让坑——styles.css:33 自 scaffold 即 @import maka-tokens.css，token（#3997，08-27）存在起加载链全覆盖，等报告者核实关单。#5746 政策信号：仅暂停 Grok 生成贡献（xAI 竞品条款未澄清，讨论 #5749），GLM 尾注不受影响。等信号不变：#5712/#5709 合并、#5753/#5495/#5902 任一合并（#5709 第五撞预案）、#5864 回应。**10-02 二扫**：全盘零增量；#5864 已被 Adarsh-Me take（我方对齐评论在案，改留观其方案）、#5912（WorkHub 预览闪烁）报告者自 take——池空；performance-frontend.yml main 仍零运行（最新 run 停在 09-14 全分支跑），冷滚动贴数继续等；等信号收敛为 #5712/#5709 合并与 #5753/#5495/#5902 撞号。
