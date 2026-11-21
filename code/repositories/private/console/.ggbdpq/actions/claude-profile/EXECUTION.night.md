# EXECUTION.night.md

# 无人值守执行法典（Night / Unattended Mode）

> ⚠️ 本文件为 **显式执行授权文件**  
> 当 Agent 以本文件作为执行法典运行时，  
> **视为用户已授予“无人值守、连续执行”的完整授权。**

---

## 0. 定位与继承关系

- 本文件 **继承**：`./EXECUTION.md`
- 本文件 **不重复定义** 执行流程、PRD 结构、commit 规范
- 本文件仅用于 **覆盖执行授权与确认策略**

> EXECUTION.md = 默认生产法典（保守 / 人工监督）  
> EXECUTION.night.md = 授权覆盖层（无人值守 / 长链路）

---

## 1. 启用条件（显式授权）

当满足以下条件时，视为 **Night Mode 已启用**：

- Agent 明确使用 `EXECUTION.night.md` 作为执行法典
- 用户未撤销 Night 授权
- 当前工作区为受控仓库（非临时草稿）

> ⚠️ 不需要用户在对话中再次输入“继续执行”
>
> **使用本文件本身，即是授权信号**

---

## 2. 执行授权规则（无人值守模式）

在 Night Mode 下，执行授权规则 **覆盖 EXECUTION.md 中的默认确认行为**：

### 2.1 授权覆盖范围

对满足以下条件的 PRD：

- `priority ∈ { P1, P2 }`
- `blocked_reason == ""` 或不存在
- 未命中 STOP（BLOCKED）条件

👉 **Agent 可自动、连续执行，无需二次确认**

---

### 2.2 仍然保留的硬性门禁（不可绕过）

Night Mode **不是放弃约束**，以下规则仍然 **强制执行**：

- ❌ 任意 PRD 命中 `blocked_reason` → 立即 STOP
- ❌ typecheck / tests 失败 → 立即 STOP
- ❌ 违反 append-only progress 规则 → iteration 失败
- ❌ commit message 不符合中文规范 → 必须重写 commit

> ⚠️ Night Mode 只能减少“确认步骤”，  
> **不能绕过工程与审计底线**

---

## 3. 执行节奏（长链路模式）

在 Night Mode 下，Agent 应采用以下节奏：

1. 从 `prd.json.items` 中选择下一条 `passes != true` 的 PRD
2. 严格按 EXECUTION.md 中定义的 iteration 流程执行：
   - select
   - implement
   - typecheck
   - progress
   - commit
3. 若 iteration 成功：
   - 更新 `progress.txt`
   - 更新 `prd.json` 状态
4. **自动进入下一条 PRD**
5. 重复，直至触发 STOP 条件

---

## 4. STOP（停止）条件（最高优先级）

Night Mode 下，仅在以下情况 **必须停止执行**：

### 4.1 STOP (BLOCKED)

- 出现新的 `blocked_reason`
- 外部依赖缺失 / 决策不完整
- 执行结果无法验证真实性

👉 **立即停止，等待人工介入**

---

### 4.2 STOP (SUCCESS)

当满足以下全部条件时，视为 Night Run 成功完成：

- `prd.json.items` 全部 `passes === true`
- `prd.json.statistics.completion === "100%"`
- `progress.txt` 中：
  - 每个 PRD 至少有一条记录
- git 历史中：
  - 每个 PRD 至少对应一个 commit
  - commit message 全部符合中文规范

---

## 5. 审计与回溯要求（Night 专用）

Night Mode 执行完成后，应满足：

- 所有 commit 可通过 PRD → Progress → Commit 链路追溯
- progress.txt 为 append-only，不存在回写
- 不允许 squash / rewrite Night Mode 期间的 commit（除非人工介入）

---

## 6. 撤销与回退

Night Mode 可随时撤销：

- 停止使用 `EXECUTION.night.md`
- 回退为默认 `EXECUTION.md`

> 撤销 Night Mode **不需要修改任何主执行法典内容**

---

## 7. 结语（执行哲学）

Night Mode 的目标不是“更快”，而是：

- **让 Agent 在你睡觉时，像一个可靠的初级工程团队**
- **早上你只需要 Review，而不是救火**

---
