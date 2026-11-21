# agent-hub 巡检多智能体 — 简历与面试蒸馏（第 5 阶段产出）

> 口径铁律：**每个数字必须能在 agent-hub 仓库 `apps/api/evals/reports/` 找到出处**；
> 检索数字是确定性检索组件在合成语料上的离线评测（工程质量，不依赖模型）；智能体侧
> 数字全部为离线替身口径，**仅验证工程流程，不代表模型效果**——简历中不使用后者。

## 一、简历项目要点（三条）

**agent-hub：巡检多智能体平台（Python · FastAPI · LangGraph · SQLite · React）**

1. 基于 LangGraph 实现 Supervisor + 规划 / 巡检分析 / 报告三类 Worker：Plan-and-Execute
   规划、`Send` 多设备并行扇出、子任务超时降级为部分完成（覆盖率可解释）；工具按
   读 / 写 / 高危三级，权限、步数、Token 预算由工具执行器用代码强制（越权以
   `tool.denied` 事件化），高危操作经 LangGraph `interrupt` 人工审批，审批 id 贯通
   事件流与工单。
2. 自研持久化运行时：SQLite（WAL）租约 + 心跳 + fencing token + CAS 写入，进程被
   SIGKILL 后自动接管并从检查点续跑（kill -9 故障注入测试锁定"任务最终结束"）；
   过期执行者写入一律 `LeaseLost` 拒绝；写工具经幂等账本不重复执行（崩溃续跑后
   `tool.deduplicated` 作证）；事件按 seq 持久化支撑 SSE `Last-Event-ID` 断点续传。
3. 同一 ToolSpec 注册表暴露为 MCP Server（dangerous 工具不外露）与三个 Skill；
   混合检索（BM25 + 向量 + RRF）为结论提供可回溯证据（未观测 chunk 引用被剔除）；
   检索组件消融矩阵（合成语料 60 标注、离线）：hybrid-unigram Recall@5 **0.942**、
   bm25-only 0.925、vector-only 0.858（出处：`ablation-retrieval-20261024-174444.md`），
   依数据将重排器默认关闭、诚实记录"向量通道为负贡献"。

## 二、面试十题的实践证据升级

| 题 | 升级后的证据（全部可在仓库/测试找到） |
|---|---|
| 1 何时用 Agent vs 工作流 | E1 消融框架就绪（`SingleReActRunner` 基线在库），真实模型对比待跑——**如实说**：离线阶段只验证了编排正确性，多 vs 单的模型口径结论待真实评测；已用确定性规则（detect_anomaly）把"数值判断交给代码、LLM 只做解释"的边界画清 |
| 3 提示词 vs 运行时 | 工具执行器（`app/tools/executor.py`）权限→白名单→预算→账本→超时全链代码强制；评测集越权用例实测越权 0 次（`agent-scripted-tools-*.md`）；对仲裁：E7"只靠提示词"对照组待真实模型 |
| 5 主/子智能体 | supervisor→planner→inspector×N（Send 扇出）→reporter；子任务只收"简报+本设备摘要"（Token 上限 CI 断言、完整遥测不进简报）；失败子任务降级 partial + 覆盖率 |
| 7 超时重试 | 幂等账本键 `run_id:node:step:tool_call_id` 续跑可复现；超时状态未知 → `ledger.fail(retryable=True) → unknown`，禁止自动重试（契约测试锁定） |
| 8 刷新与重连 | SSE `Last-Event-ID` 续传（`events_after` 无空洞 seq）+ 页面刷新从 0 重放重建状态（事件幂等）；E2E"审批中断→刷新→审批条恢复→批准"通过 |
| 10 崩溃恢复与旧结果覆盖 | fencing token 单调 + CAS（`WHERE fencing_token=? AND status='running'`）；契约测试：过期未接管不误拒、被顶替必拒；`demo_crash` 打印 kill -9→回收→续跑→完成全序列 |
| 2 效果评测 | 评测框架只依赖 AgentRunner；60 条评测集（含 10 条故障注入）；质量门 `evals.gate` 低于阈值退出码 1（CI 红，吸取"只打印不失败"教训） |
| 4 RAG | 标题层级切分（chunk_id 内容不变则不变——证据引用稳定）、BM25（bigram，U4 闭环：jieba 实测低 3.3pp 故不引入）+ Hashing 向量 + RRF(k=60)；空结果不编造 |
| 6 数据库/工程化 | SQLite WAL + busy_timeout；`docker compose up` 三服务一键演示（真机验收通过）；CI 含质量门 |
| 9 崩溃一致性 | 快照原子写（tmp+os.replace）、续单号、事件与终态同事务；fencing 语义精确化有契约测试（过期未接管不误拒） |

## 三、数字出处对账表

| 数字 | 出处 | 口径 |
|---|---|---|
| 检索 hybrid-unigram Recall@5 = 0.942（MRR 0.792） | `evals/reports/ablation-retrieval-20261024-174444.md` | 合成语料 60 标注、离线确定性 |
| bm25-only-bigram 0.925 / vector-only 0.858 | 同上 | 消融对照组 |
| 越权调用次数 = 0 | `agent-scripted-tools-20261024-152922.md` | 离线替身口径（流程验证） |
| jieba vs bigram：0.892 vs 0.925（@5） | `retrieval-20261024-153400.md`（U4 闭环） | 合成语料、字面对齐查询占优的说明见报告结论段 |
| pytest 298 passed / E2E 7 passed | CI/本地实测（2026-10-25） | — |

**禁止在简历/面试使用的数字**：agent scripted 成功率 88.3%/100%（替身口径，不代表模型效果）。

## 三·补充：E1 真实模型消融（2026-10-25 已执行，deepseek-chat）

出处：`apps/api/evals/reports/e1-real-20261024-222238.md/.json`（12 条分层子集、单次运行、排除故障注入）：

- **成功率两配置均 100%**（差距 0pp < 3pp 判定线）→ 按计划 §11 如实采信：本语料上单智能体成功率不差；
- **multi 的并行扇出时延显著更优**：hard 档 8.2s vs single 10.3~17.0s（最大差 2 倍）——多智能体的已证价值在并行时延与隔离/可控性，而非成功率；
- 有趣反例（如实保留）：single 的工具调用 P/R（84.0%/89.7%）高于 multi（72.2%/57.2%）——multi 每设备的工具调用集合与期望序列偏离更大；
- 面试口径：「多智能体的收益取决于任务结构——可并行的独立子任务收益在时延，串行依赖任务收益可能为负；用消融数据说话」；
- 待办：E2/E3/E4/E7 配置变体开关未实现；≥3 次均值与更大样本待扩展。

## 四、待办（计划 §11 的真实模型口径）

- [ ] E1–E4、E7 真实模型消融（每配置 ≥3 次取均值；预算需确认，优先便宜模型跑全量）
- [ ] 真实模型下 B 的 `models.py` 真机冒烟（当前仅本地假上游契约测试）
- [ ] 真实模型评测报告补"模型名/日期/单价/样本量"后替换简历占位数字
