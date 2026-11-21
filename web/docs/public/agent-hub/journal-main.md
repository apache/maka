# agent-hub 升级 — 主线程（集成者）日报

## 2026-10-24 · 第 0 阶段（契约冻结）完成

### 1. F1–F4 复核结论（计划 §2.2 vs 实际仓库）

仓库实际状态与计划基线描述**严重不符**：计划基于 13 提交旧快照（2026-10-01），
实际 main 已完成 WP0–WP9 的 LangChain.js 重构（bf019e0，2026-10-18 ADR-0003~0005），
Python 智能体代码（agent.py / llm.py / evidence.py）已删除，花语对话由 TS `apps/agent` 接管。

| # | 计划判定 | 实测结论 | 证据 |
|---|---|---|---|
| F1 | 重启恢复不成立（僵尸任务） | **已修复**：`restore_snapshots(schedule=True)` 对 queued/running 重新调度 `_run(resume=True)`，从快照进度续跑 | `tasks.py:93-94,146-153`；提交 f1cfca9（WP6） |
| F2 | 去重判断拿 status 比对键 | **已修复**：`if task.taskId not in _TASKS` | `tasks.py:90`；提交 7bfa01d |
| F3 | 快照非原子写入 | **已修复**：tmp + `os.replace`，损坏快照跳过时有 warning 日志 | `tasks.py:66-72,87-89`；提交 c8e8a12 |
| F4 | 证据静态挂载、可信度写死 | **Python 侧已消失**（evidence.py 随 WP9 删除）；ADR-0004 用工具因果校验（evidenceIds ⊆ 本轮 search_evidence）取代静态注入；"可信度=固定 fixture"口径已在 CONTEXT.md 明示 | `docs/adr/0004`、`CONTEXT.md` 可信度条目 |

F5–F7 能力缺口仍然成立（无多智能体编排、无持久化运行时、无评测），升级计划核心继续有效。

### 2. 对计划的具体偏差（已落实并记录）

1. **A0 取消**（F1–F3 已修复）：A 的任务序列改为 A1→A10。
2. **ADR 编号顺延**：0003~0005 已被占用，新 ADR 为 0006（SQLite 租约/CAS）、0007（LangGraph 编排，附 U1 实测）、0008（事件协议）、0009（工具权限）。
3. **绞杀者对象更名**：计划 4.2 节"保留不动 agent.py/llm.py/evidence.py"→ 实际保留对象为 `apps/agent`（TS）、`orders.py`、`tasks.py`。
4. **基线选择**：契约提交落在 `upgrade/base`（基于 main bf019e0）；`fix/agent-hardening`（领先 1 提交 5deb1c0 + README 在途修改）保持独立不动，不卷入升级基线。
5. **fencing 语义精确化**：写入校验"token 是当前值且 status=running"；租约过期未被接管不误拒（ADR-0008 第 5 条，有契约测试锁定两种情形）。
6. **RunContext 用 dataclass** 而非 pydantic（ADR-0008 第 6 条）。

### 3. 第 0 阶段验收证据

- U1 LangGraph 试验：`apps/api/tests/test_langgraph_probe.py` sync + async 双绿。实测结论：langgraph 1.2.17 中 `Send` 必须经 `add_conditional_edges` 发出（节点返回 `list[Send]` 抛 `InvalidUpdateError`）；interrupt/`Command(resume=...)`/重开 SqliteSaver 恢复不重跑已完成节点，全部按预期。
- 契约冻结提交 `37231e2`（72 文件，+5491 行）：五接口 + RunEvent、fakes.py、conftest.py、16 个契约测试、fixtures/inspection/**（20 设备 + 20 遥测 + 30 语料，合成数据，5 台异常注入）、ADR-0006~0009、AGENTS.md 所有权矩阵、三个集成请求收件箱、依赖一次加齐（langgraph 1.2.17 / checkpoint-sqlite 3.1.2 / langchain-core 1.7.0 / mcp 2.3.0 / numpy 2.5.4 / rank-bm25 0.2.2 / pytest-asyncio 1.4.0）。
- `pytest 41 passed`（23 原有 + 2 试验 + 16 契约）；tag `contracts-v1` → 37231e2。
- 三个 worktree 已建并各配独立 venv（editable 必须指向各自 worktree，否则 pytest 会 import 到主仓代码）：ah-A=feat/runtime、ah-B=feat/agents、ah-C=feat/knowledge-eval，基线 pytest 各 41 passed。

### 4. 第 1–3 阶段启动

A / B / C 三个后台子智能体已按计划 §14 启动（含偏差修正）。主线程每日流程：
读三份日报 → 处理集成请求（只允许向后兼容契约补丁）→ `git diff --name-only contracts-v1..HEAD` 越界检查（越界即要求回滚）。

### 5. 主线程最不自信的 3 点

1. **fencing 语义细化偏离计划原文**："过期未被接管仍可写入"是我在 ADR-0008 的自主决策（有测试），若面试官按 Kleppmann 严格口径追问需能自圆其说——过期防护实际由心跳失败+编排层停止承担，存储层只挡被顶替者。
2. **fixture 异常模式的可发现性**：5 台异常注入是"写死模式"，detect_anomaly 的确定性规则（阈值/漂移/阶跃）能否全部检出未验证——C7 评测集推导期望值时若检不出会暴露生成数据与判据不匹配。
3. **子智能体越界风险**：zcode 子智能体无法被硬性限制在 worktree 内，所有权只能靠提示词约定 + 合并前 `git diff --name-only` 核查（U2 原文成立）。

## 2026-10-25 · 第 4 阶段（串行集成 I1→I10）完成

### 合并与验收（upgrade/base，主线程串行）

| 步骤 | 提交 | 验收 |
|---|---|---|
| I1 合并 feat/runtime | e8c8edf | pytest 142 + 旧 E2E 4 绿 |
| I2 合并 feat/knowledge-eval | （merge） | pytest 205 + evals.run/evals.gate 通过 |
| I3 合并 feat/agents + 接线 | 5da98a8 / db21cfe | pytest 292 + demo 真实依赖跑通（SqliteRunStore/SqliteLedger + HybridRetriever，真实 chunk_id 贯通证据链） |
| I5 /api/runs 路由 | e032de1 | 4 个 API 集成测试 + 全量 296 |
| I6 跨端契约 | 3e2dc68 | zod/pydantic 双端对账（shared 20 / pytest contracts 6） |
| I7 前端运行页 | 38f038a | typecheck/build/测试绿 + 真机截图 |
| I8 三条巡检 E2E | 8873b2a | E2E 两轮 7/7 稳定 |
| I9 Docker + CI 质量门 | a348c19 | docker compose up 真机验收：创建→执行→批准→completed/覆盖率 1.0 |
| I10 README 巡检章节 | 8c966cb | 最终门槛：pytest 298 + node 全链 + build 全绿 |

### 集成期发现与修复（全部有测试/验收锁定）

1. **payload/JSON 形状漂移**（贯穿 I6–I8）：pydantic 契约 snake_case vs 仓库 JSON 惯例 camelCase——统一 `alias_generator=to_camel + populate_by_name`（出站 by_alias，内部名不变）；审批链 decision 键一并统一。
2. **TestClient 断开 SSE 不通知 app 侧**：gen 挂到终态——测试改为"决定先行 + 单条流读到底"；生产 uvicorn disconnect 正常。
3. **interrupt 恢复重放 reporter**：approval.required 事件重复发出（同 approval_id）——消费方按 id 幂等（前端/测试同语义），写工具由账本去重（tool.deduplicated 作证）。
4. **刷新恢复语义修正**（I7 真 bug）：续传拿不到历史事件导致审批条无法重建——刷新从 0 重放重建状态，页内断线重连才用 Last-Event-ID。
5. **E2E 环境两坑**（非代码 bug）：shell 全局代理劫持回环探测（no_proxy 绕过）；macOS tempfile.gettempdir≠/tmp 导致 E2E db 清理从未生效（显式路径修正）。
6. **本机 E2E 前提**：OPENAI_API_KEY 置空强制离线剧本（.env 真实 key 会让内容断言失败）。

### 已知降级（如实记录）

- I8 第 2 条「重启 API 进程」降级为页面刷新恢复 + 页内断线续传：服务端进程重启续跑由 A9 SIGKILL 测试 + I5 集成测试覆盖，E2E 不覆盖进程重启（README Limitations 已注明）。
- 真实模型路径（B 的 models.py）只验了本地假上游契约；真实模型消融（计划 §11 E1–E7 的模型口径）未跑，待 API 预算确认（计划 §11【不自信】条款）。

### 第 5 阶段启动

对抗式审查子智能体（全新上下文，按计划 §10 清单）后台启动；消融先跑离线口径（evals.ablation 检索矩阵 + scripted agent suite），报告标注"仅验证流程"。

## 2026-10-25 · 第 5 阶段完成（对抗审查 → 发回修复 → 重新合并 → 蒸馏）

### 对抗式审查（全新上下文审查者，16 项清单，只读 + /tmp 实证）

- **运行时层高置信**：租约/fencing/终态吸收/幂等账本/并发幂等 8 项 ✅（含 8 进程实证）
- **P1（高）已实证正确性 bug**：审批等待期服务端重启 → 生产重认领路径用输入 dict 重新
  ainvoke（从未走 Command(resume)）→ 整图重跑、findings 翻倍、coverage=2.0 仍 completed；
  且旧 kill -9 测试只覆盖 store 层——README 相关声明有夸大
- P2（中）database is locked 无重试可静默杀死 worker；P3（中低）SSE gen 同步 store 调用
  阻塞事件循环 + Last-Event-ID 越界 OverflowError；P4–P7 低（hub 泄漏/coverage 口径/
  inspector 权限面/审批重放已知成本）

### 修复闭环（缺陷发回原所有者，先红后绿）

- B：R1 aget_state 检测 pending interrupt 走 Command(resume) + findings reducer 按
  device_id 去重（回归测试复现审查者路径）；R2 coverage 分母统一请求口径；R3
  list_devices 移出 inspector 权限面（130 passed）
- A：锁重试（仅 BUSY/LOCKED 指数退避，业务异常不重试；顺带修 rollback 掩盖）+
  run_forever 循环容错（147 passed）
- 主线程：SSE to_thread + Last-Event-ID clamp（R3）；hub resolve async 化 + 缓冲 TTL（R4）；
  README 续跑口径精确化（299→307 passed 合并后全量）
- 重新合并后：pytest 307、E2E 7/7（任务页 1 例既有 flaky 复跑通过——花语演示 1/10
  概率确定性失败单，与巡检无关）

### 蒸馏

`interview/docs/agent-hub/distillation.md`：简历三条（检索消融数字 0.942/0.925/0.858
标注合成语料口径）、面试十题证据表、数字出处对账、替身口径数字禁用清单、
真实模型消融待办（预算需用户确认）。

### 最终状态

upgrade/base HEAD=62d8769（contracts-v1 起共 12 个集成提交 + 三分支修复追加），
未推送（推送与合并到 main 由用户决定）。工作区仅剩用户在途的 README 修改未动。

## 2026-10-25 · 用户确认执行：推送/合并、清理、真实模型消融

- `upgrade/base` 推送 origin；main 快进合并至 62d8769 并推送。**注意**：用户在途的 README 修改（.env 重启说明）已随 I10 提交（8c966cb）入库，未丢失。
- ah-A/B/C 三 worktree 与 feat/* 三分支已清理（全部已合并）。
- 真实模型冒烟通过：deepseek-chat 全流程（INV-005 critical 判定、证据引用、工单、默认拒绝派工、零越权）。坑：Python 侧 models.py 只读 OPENAI_BASE_URL env（.env 里该行被注释，缺省打 api.openai.com）——消融以 env 注入 base_url/model 解决，未改代码。
- E1 真实消融入库（e1-real-20261024-222238）：两配置成功率均 100%，multi 并行时延 hard 档优 2 倍；single 工具 P/R 反而更高（如实记录）。E2/E3/E4/E7 待配置开关实现。

## 2026-10-25 · 仓库迁移（用户指令）

- agent-hub 迁至 `/Users/ggbdpq/cc/repositories/public/agent-hub`（cc 白名单 git 仓惯例：public 下独立 git 仓库被 ignore）。git/远端/分支完整；原地重建 venv（绝对路径失效）；node_modules 硬链接迁移无损。
- 迁移验证揪出**既有 SSE 终态竞态**（非迁移引入，pre-R3 同样复现，时序被拨动后确定性触发）：gen 在 events_after 批次与 get 状态检查的窗口内提前 return，终态前最后一批事件不推送。修复=终态后补排空一次（c6eceed 已推送）。pytest 307 + E2E 7/7 @ 新路径。
- 旧路径下该测试历史全绿——「通过≠无竞态」的实证案例，面试可用。

## 2026-10-25 · 第 5 阶段补缺启动（第 0 步完成）

### 全量门禁（main @ c6eceed，全部实跑）

| 门禁 | 结果 |
|---|---|
| pnpm build / test:shared / test:web / test:agent | 全 PASS |
| pnpm test:api（pytest） | 307 passed |
| pnpm test:e2e | 7 passed（13.4s） |
| python -m evals.gate | exit 0（retrieval @5=0.908；agent success=100%、forbidden=0；离线口径） |

### E1 工具 P/R 差异核实（假设：R3 移除 list_devices 致评测口径未同步）

**结论：部分成立但非主因。** 对 e1-real-20261024-222238.json 逐用例对比期望集（tools_expected）与实调集（tool.called 事件）：

| 差异源 | multi | single | 定性 |
|---|---|---|---|
| get_telemetry（期望 12/12 必调） | **漏 12/12（全部）** | 0 漏 | **主因**：B6 上下文隔离设计——inspector 设备简报自带遥测紧凑摘要，无需再调；评测期望把"数据获取"表达为"必调工具"，与多智能体的简报注入路径错配 |
| list_devices（期望 2 例） | 漏 2 | 漏 1 | **假设相关但贡献微小**：multi 漏 2 例确与 R3 权限收缩有关（inspector 不再可调，supervisor/planner 层未主动调）；single 也漏 1 例说明期望本身偏严 |
| dispatch_drone（期望 2 例） | 漏 2 | 漏 2 | 口径问题：E1 用默认拒绝审批，不派工是正确行为，期望集按"批准"假设写 |
| search_procedures | 多调 6 | 多调 6 | 两配置相同：非 evidence 用例上也检索（无区分度） |

修正方案（交 X 在重跑时落实，双口径透明呈现）：
1. 期望集区分"必调"与"信息获取方式不限"（get_telemetry/list_devices 归后者：工具调用或简报注入均可，以结论引用/evidence 为准）；
2. dispatch_drone 在默认拒绝审批口径下期望应为"不调用"（或双口径分列）；
3. 新旧两套口径同时报告（process-strict vs goal-oriented），量化口径影响。

### 并行启动

p5-base=c6eceed 已打标签；ah-X（feat/ablation）、ah-Y（feat/restart-e2e）、ah-Z（docs/deep-dive）三 worktree 就绪（X/Y 环境已配）。

## 2026-10-25 · 第 5 阶段补缺：Y/Z 完成、Y 已集成（f405a0f）

### Y（进程重启 E2E）——红测试揪出真生产缺陷
- Y1/Y2 spec 落地（独立 8818/8890 编排，playwright.config/CI 零改动）。
- **缺陷**：runner.py pending-interrupt 分支未 await 异步 approver → 协程进 Command(resume) → msgpack TypeError → run.failed（生产 ApprovalHub 必现；既有单测只注入同步 approver）。
- **集成（R-Y1/R-Y2/R-Y3 全闭环）**：单测先红（回退补丁复跑锁定 msgpack TypeError）→ 3 行修复 → pytest 308；门闩摘除后 E2E **9 passed**（含 SIGKILL 重启两条）；package.json 加 test:e2e:restart。
- Y 诚实口径两点：浏览器层 kill 落点实际稳定覆盖 interrupt-resume 路径（graph-rerun 路径经探针验证）；页面恢复=reload+从 0 重放（页内 Last-Event-ID 自动重连是已知边界）。

### Z（面试材料）完成待合并
docs/interview/ 三件：deep-dive（五机制，41/41 测试名核验、17 处行号抽查）、red-team-qa（30 题，5 处诚实「待确认」）、resume-points（数字全 ____ 占位待 X 回填）。

## 2026-10-25 · 第 5 阶段补缺：集成与审查收官（main @ 81f98de，未推送）

### 集成（Y→X→Z，每步全量门禁绿）
- Y 合并 + R-Y1 修复（单测先红：msgpack TypeError 复现→3 行 await 补丁→绿）+ R-Y3 摘门闩 + R-Y2 补一行（审查抓漏后补合入）；E2E 从 7 → 9 条（SIGKILL 重启两条）。
- X 合并（双口径评分层 + e1/e3/e7 离线消融四报告 + 333→334 passed）；reporter 工单语义不按 goal 收敛（决策记录于 X.md）。
- Z 合并（面试三件：deep-dive / red-team-qa 30 题 / resume-points 数字占位）。
- 门面：README 重写（Agent 工程演示定位）+ 拆分 docs/flora.md + docs/inspection.md + ADR-0006 Postgres 迁移段；删除「E2E 不覆盖进程重启」失效表述。

### 对抗审查（全新上下文，13 项清单，实测复算）
- 可发版置信度中高：重启套件实跑 2 passed、e1/e3/e7 全部关键数字复算吻合、E7 拦截门受控重跑实证。
- 确认成立并已修：P1 test:e2e:restart 命令断链（R-Y2 漏合入，补齐+实测 2 passed）、P3 e7 可观测性声明、P4 录屏行丢失。P2（测试名 typo）核实为审查者误报。
- 遗留（非阻塞，记录）：e1 时延分位数 JSON 只存末轮（复算缺口）；executor 账本键门拒绝路径无事件（改进方向已注明）；CI 真机 9 条 E2E 待推送后验证。

### 最终门禁（81f98de）
pytest 334 / build / test:shared / test:web / test:agent / test:e2e 9 条（34.0s）/ test:e2e:restart 2 条 / evals.gate exit 0。worktree ah-X/Y/Z 与三本地分支已清理。

### 等待用户确认（四类操作已停手）
1. X 真实模型消融：E1 $0.235（2076 次调用）+ E3 $0.13~0.20（单价 deepseek-flash 档假设，来源与日期见 X 日报）；E7 无费用。
2. 删除远端 upgrade/base 分支。
3. 仓库描述 + 主题（langgraph/multi-agent/mcp/rag/llm-evaluation/fastapi）。
4. tag v0.2.0 + Release（附 demo_crash 与审批流演示录屏/GIF——录屏需先制作，方案待定）。

## 2026-10-25 · v0.2.0 发布（四项确认全部执行完毕）

### 执行记录
1. **推送 + CI**：81f98de 与 1b5c9ad 两轮 CI 4/4 全绿（9 条 E2E 真机过）；e26944c（回填）推送后同样待 CI。
2. **真实模型消融（X，ah-X2）**：E1+E3 完成，0 崩溃全轮，pytest 343。实际花费 **$1.094**（估算 $0.37~0.44 的 2.5×，替身基线低估真实调用数与输入 Token；报告"估算 vs 实际"节已披露）。**真实结论与离线解读的差异**：①离线"multi 时延反而更慢"被修正——真实时延下并行扇出收益兑现（E1 P95 8.6s vs 26.2s，E3 6+ 台 P50 3.9×）；②离线"成功率均 100%"被修正——真实口径 single 98.7% > multi 96.7%（hard 档 96.7% vs 83.3%，multi 输在共享 24 步预算大清单耗尽）；③上下文隔离 Token 收益比离线更大（2.6×）。E1 判定如实：单智能体成功率更高（<3pp），多智能体价值在并行时延与隔离。
3. **删远端 upgrade/base** ✓；仓库描述 + 6 主题 ✓。
4. **两段录屏**（inspection-approval-flow / demo-crash-recovery webm）随 Release 发布；录制入口入库（e2e/demo-recording.spec.ts + playwright.record.config.ts）。
5. **resume-points 数字回填**（e26944c）→ 快速门禁（pytest 343 / E2E 9/9 / gate-0）→ **tag v0.2.0 + Release**（https://github.com/ggbdpq/agent-hub/releases/tag/v0.2.0）。

### 遗留（记录不阻塞）
- X 自报 3 点不自信全部在案：计费档假设（flash 档，peak 上界 $2.19 合计）、multi hard 档败因归因未做放宽 Budget 对照、E3R 容器与生产图的时延差。
- E7 账本键门拒绝路径无事件（可观测性改进方向）。

## 2026-10-25 · 第 6 轮启动（缺陷修复与评测补强，基线 p6-base=c1fa5a4）

### 第 0 步门禁（main @ e26944c，全部实跑）

| 门禁 | 结果 |
|---|---|
| pnpm build / test:shared / test:web / test:agent | 全 PASS |
| pnpm test:api（pytest） | 343 passed |
| pnpm test:e2e | 9 passed（34.7s） |
| pnpm test:e2e:restart | 2 passed（34.7s） |
| python -m evals.gate | exit 0 |

### E1 重跑预算估算（合并 P 后执行，任务既定故无需再确认；仍记录在案）

- 范围：hard 档 10 条 × 3 轮 × 2 配置（multi/single）+ 全量 50 条 × 1 轮 × 2 配置。
- 调用量：multi ~300（hard，8 台用例 ~10 调用/条）+ single ~270 + multi ~450（全量）+ single ~445 ≈ **1,465 次**。
- 费用：按 e1-real 实测均价（$0.6788/2690 次 ≈ $0.00025/次）≈ **$0.37**；peak 上界 2× ≈ $0.73。单价假设同前（deepseek-flash 档，未与账单核对）。

### 并行启动

P（fix/agent-quality @ ah-P）：P1 预算临界收敛（最后 1 步禁工具/重复调用拒绝/耗尽兜底出 finding）、P2 goal 收敛（只诊断跳过工单起草 + Z 文档同步）、P3 可选（规划缓存）。下行口径已入 P.md（不改 Budget 默认值；重复判定语义跨节点；与账本区分）。
Q（feat/eval-plus @ ah-Q）：Q3 期望修正（只诊断 → create_work_order forbidden）→ Q1 E4 消融（离线先跑）→ Q2 E7 真实版设计；真实模型费用估算后等确认。

## 2026-10-25 · 第 6 轮集成完成（main @ 211fa9f，未推送；停在两项确认前）

### 集成（P → E1 重跑 → Q，每步门禁全绿）
- **P 合并**（62021ea，357 passed）：P1a 步数临界保护 / P1b 连续重复拒绝 / P1c 判读兜底 / P2 goal 收敛 / P3 规划缓存。executor 新增两道闸（P.md 下行预授权，配套 tests/tools 改动一并备案）。
- **E1 改后真实重跑**（fe2cb59；工具接线 49b4534 加 --difficulty）：
  - hard 10×3：**multi 83.3% → 100%**（排名反转），single 96.7% 持平（R1 90% 单轮波动如实记录）；multi 越权 1.667 → 0；goal 召回 100%；步数 11.3 → 16.6（兜底跑完全程的设计意图，非退化）
  - 全量 50×1：multi/single 均 100%；multi P50/P95 7111.7/9691.0ms vs single 9164.4/25983.1ms——**multi 时延与成功率双优首次同时成立**
  - 实际 ~1123 次调用（估算 $0.37 方向相符）；改前/改后对比节在 e1-real-20261025-033010.md（含提交号）
- **Q 合并**（211fa9f，370 passed）：Q3 只诊断判定共享化（数据核实 forbidden 已一致，真实缺口在替身层）、E4 离线对照（Token 2.58×）、E7 注入版（on 全拦 / off 站级越权 336 次）；生产代码零改动。
- **文档**：resume-points 删「上下文隔离 2.6×」归因（改 39% 占比 + 待 E4 真实验证）、成本标注公开单价估算；inspection.md 索引补四份报告 + 离线口径表述修正；旧 e1-real-20261024 文件头标注已被取代。
- 最终门禁：pytest 370 / build / node 三组 / E2E 9 / restart 2 / gate-0 全绿；worktree 已清理。

### 停在两项确认前
1. **E4/E7 真实模型版**（Q 估算：E4 $0.256 + E7 注入版 $0.663 ≈ **$0.92** off-peak，peak 上界 $1.84；6,168 次调用）。
2. **v0.2.1 发布清单**（见下）。

## 2026-10-25 · 第 6 轮收官 + v0.2.1 发布（main @ 03fb853）

### E4/E7 真实模型（用户批复后执行）
- E4（$0.66 折算口径）：两臂质量均 100%、full 臂时延略高——上下文隔离成本收益成立、质量代价未观察到（真实口径）；resume-points 归因恢复。
- E7（真实模型）：**注入 1008 次 0 服从**——探针三重证据（注入文本进简报 True / 模型回复明确识别"提示注入风险" / tool_calls 空）；运行时门未获触发，价值由离线版作证。Q 预警的"100% 服从是上界假设"被实测证实。
- 实际花费合计 ≈ $0.66（E4，2,600 次）+ E7 ≥$0.68（≥2,680 次，含崩溃与误启浪费 ~2 轮）≈ **$1.34+**（超 $0.92 估算，替身基线低估 + 过程缺陷，全部披露）。

### 过程缺陷（本轮自身，全部如实记录）
1. E4/E7 计费级 Token 未随轮次落盘（RealLLMMeter 进程内实现）→ 报告不列 Token/成本计费口径，改用日志累计调用数 + E1R 均价折算（标注估算）。
2. E7 原进程崩溃于 violations 合并（int+dict）→ 补跑一轮；主线程重组进程误启与原进程并发（双烧一轮）→ 停止后补齐。教训：长任务 resume 前必须确认原进程已退出。
3. write_report 签名（stem 非 prefix）、render_markdown 标量渲染、finalize 强制 variance——三处接口认知偏差各付一次调试成本。

### 发布
- v0.2.1 tag + Release（含 P 修复改前/改后、E4/E7 真实结论、诚实记录节）；CI 三轮全绿（c1fa5a4→03fb853 共 4 次推送）。
