# EXECUTION.md（代理编排执行协议｜长期复用版）

> 本文件定义：如何让任意 AI 工具"机械地"把一个 spec 的 PRD 全部执行完成。  
> 默认行为：**自动循环**执行 PRD，直到全部完成或被阻塞（blocked）。

---

## 0. 目标与边界

### 目标

将「需求 → 执行 → 验收 → 留痕 → 提交」机械化，保证：

- 可审计（每次迭代都有日志与提交）
- 可回滚（可定位到每个 commit）
- 可度量（统计与完成率可计算）
- 可复用（不绑定项目名与工具）

### 边界

- 本文件只规范"执行层"（actions）。
- specs（design/requirements/tasks）用于规划与对齐，不裁决执行状态。

---

## 1. 目录契约（必须满足）

本 spec 的执行目录结构必须为：

- `.ggbdpq/actions/<spec-name>/`
  - `EXECUTION.md`（本文件）
  - `prd.json`（机器执行任务清单：唯一执行状态源）
  - `progress.txt`（执行留痕：append-only）

> `<spec-name>` 可为任意名称，不得在本协议中写死。

---

## 2. 唯一真相源（Single Source of Truth）

执行真相源只允许是：

- `.ggbdpq/actions/<spec-name>/prd.json`
- `.ggbdpq/actions/<spec-name>/progress.txt`

任何其他文档（包括 specs 下的 design/requirements/tasks、README、对话内容）不得覆盖 prd/progress 的结论。

---

## 3. Iteration（迭代）定义

一次 iteration = 完成 **一个** PRD item 的完整周期，必须包含：

1. 选择 1 个 PRD item
2. 实现其 steps
3. 运行并通过 `pnpm typecheck`
4. 追加 progress 记录（append-only）
5. 产生 1 次 git commit

缺一不可。否则该 iteration 无效。

---

## 4. 强约束（必须遵守）

### 4.1 一次只完成一个 PRD

每个 iteration 只允许：

- 一个 `passes: false → true`
- 对应一个 commit

其他 items 的 `passes` 不得改动。

### 4.2 Typecheck 门禁

在将某个 item 的 `passes` 置为 `true` 之前，必须运行：

```bash
pnpm typecheck
```

**规则：**

- typecheck 失败：不得将 passes 改为 true
- 必须先修复，再继续

### 4.3 Progress 只追加

每次 iteration 结束后，必须在 progress.txt 追加记录；禁止修改历史（append-only）。

### 4.4 Git 提交强制

每次 iteration 必须产生一次 git commit。

commit message 采用 Angular 风格：

```txt
<type>(<scope>): <subject>
```

- type 建议：feat / fix / docs / refactor / test / chore / build / ci
- scope 建议：core / engine / web / config / docs / actions / specs（可项目自定义）

【新增强制规则】：

- <subject> 必须使用 **中文**
- 禁止使用纯英文提交说明
- 如包含英文术语，需配合中文说明

示例：

- feat(core): 新增 PRD 解析服务
- fix(web): 修复 Dashboard 空状态渲染问题
- chore(repo): 补全 gitignore 并停止追踪依赖产物

- 若生成的 commit message 不符合上述中文要求：
  - 视为 iteration 失败
  - 禁止进入下一 PRD item
  - 必须重写 commit 后方可继续

---

## 5. 选择 PRD item 的规则（机械执行）

从 `prd.json.items` 中选择"下一条要做的 item"，规则如下：

1. 只从 `passes === false` 的 items 中选
2. 优先级：P0 > P1 > P2
3. 同优先级下，选择最小 id

如果不存在任何 `passes === false` 的 item：

- 停止（SUCCESS）：全部 PRD 已完成。

---

## 6. 执行算法（默认自动循环）

本节为工具无关算法：任何 AI 工具只要能读文件、改文件、运行命令，就必须按此执行。

### 6.1 Loop（AUTO）

重复执行以下 iteration，直到出现停止条件。

### 6.2 Iteration 步骤（Step 1 → Step 7）

**Step 1：选择 PRD item**

按第 5 节规则选择目标 item，并记录为 CURRENT_ITEM。

**Step 2：仅实现该 PRD**

只实现 CURRENT_ITEM.steps 中的要求：

- 不得改动与本 item 无关的代码与文档
- 不得顺手重构、顺手优化、顺手加功能

**Step 3：运行 typecheck**

运行：

```bash
pnpm typecheck
```

- 若失败：修复并重复 Step 3，直到通过
- 未通过之前，不得进入 Step 4

**Step 4：更新 PRD 状态**

若 CURRENT_ITEM 已完成且满足 steps 与 typecheck：

- 将该 item 的 passes 设为 true

若被阻塞（无法在本 iteration 内完成，且需要用户输入/决策/外部依赖）：

- 保持 passes: false
- 写入 statistics.blocked_reason（见 7.2）
- 停止（BLOCKED）：不得继续 loop

**Step 5：重算 statistics（必须一致）**

更新 prd.json.statistics，必须与 items 一致：

- total = items.length
- passing = count(passes === true)
- failing = count(passes === false)
- completion = round(passing / total \* 100) + "%"

提交前必须校验：

- passing + failing === total

**Step 6：追加 progress 留痕**

在 progress.txt 末尾追加一段，必须包含：

- 日期时间
- 本次完成的 PRD：id / component / priority
- 做了什么（What）
- 为什么这样做（Why：关键决策）
- typecheck 结果摘要
- git commit message
- Next：下一条计划执行的 PRD（按第 5 节规则预告）

**Step 7：提交前门禁检查（强制）**

在执行 git commit 之前，**必须全部通过以下检查**：

1. 执行 `git status`
   - 确认不存在以下内容：
     - node_modules/
     - dist/
     - .vite/
     - 其他构建产物或依赖缓存
2. 执行 `git diff --stat`
   - 确认本次变更量：
     - 与当前 PRD item 强相关
     - 不存在异常级联改动（例如成百上千文件）
3. 执行以下至少一项：
   - `pnpm test`（推荐）
   - 或 `pnpm typecheck`（最低要求）

**任一检查不通过：**

- 禁止提交
- 必须先修复，再重新执行本 Step

产生一次 git commit，包含：

- 代码改动（若有）
- 更新后的 prd.json
- 更新后的 progress.txt

### 6.3 Continue

若本 iteration 成功完成（未 blocked）：

- 立即回到 Step 1，开始下一轮 iteration。

---

## 7. blocked_reason 与停止条件

### 7.1 停止条件

- STOP (SUCCESS)：不存在任何 `passes === false` 的 item
- STOP (BLOCKED)：本 iteration 需要用户输入/决策/外部依赖，无法继续

### 7.2 blocked_reason 规则

`statistics.blocked_reason` 仅在 BLOCKED 时填写：

- 填写条件：且仅当"必须依赖用户输入/决策/外部条件"才能继续
- 格式：

```txt
Blocked on <原因>. Need: <需要用户提供的输入/决策>.
```

示例：

```txt
Blocked on JSONC support decision. Need: confirm whether JSONC parsing is required.
```

当 iteration 成功完成：

- `statistics.blocked_reason` 必须清空为 ""

---

## 8. 多工具启动口令（统一入口）

所有工具的核心要求只有一句：严格按本文件执行算法。
工具差异只体现在"你用什么命令触发它"。

### Cursor

在对话框输入：

```txt
按 .ggbdpq/actions/<spec-name>/EXECUTION.md 执行
```

### Claude Code / Codex / Gemini CLI / Antigravity / Windsurf / Conductor（通用）

输入同义指令即可（保持短而硬）：

```txt
严格按 .ggbdpq/actions/<spec-name>/EXECUTION.md 机械执行：自动循环 PRD，直到 SUCCESS 或 BLOCKED。
```

### Kiro（定位说明）

Kiro 更适合参与 specs/ 链路（design/requirements/tasks）。
本协议定义的是 actions/ 执行链路；若用 Kiro 执行，也必须遵守本文件的 iteration 规则与真相源约束。

---

## 9. 最终验收（完成态应满足）

当 STOP (SUCCESS) 时应满足：

- `prd.json.items` 全部 `passes === true`
- `prd.json.statistics.completion === "100%"`
- `progress.txt` 对每个 PRD 至少有一条对应记录
- git 历史中每个 PRD 至少对应一个 commit（通常一 PRD 一 commit）
