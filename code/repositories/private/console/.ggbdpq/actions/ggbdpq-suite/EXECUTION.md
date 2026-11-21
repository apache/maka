# Execution Law - agent-suite

> 版本：1.0.0  
> 生效日期：2026-01-26

---

## SSOT (Single Source of Truth)

本项目仅认可以下两个文件作为权威数据源：

1. `.ggbdpq/actions/agent-suite/prd.json` - 任务定义与状态
2. `.ggbdpq/actions/agent-suite/progress.txt` - 执行日志（追加式写入）

其他文档（如规划草案、设计文档）均为参考资料，不作为执行依据。

---

## 执行规则

### 1. 顺序执行

- 按 `prd.json` 中 `items` 数组顺序处理
- 仅处理第一个 `passes=false` 的 item
- 禁止跳过或并行处理

### 2. 最小变更

- 每个 item 仅做必要的最小变更
- 不预先实现后续 item 的内容
- 不做"顺便"的重构或优化

### 3. 验证门禁

- 每个 item 完成前必须通过 `pnpm typecheck`（如适用）
- 如 item 涉及测试，必须运行 `pnpm test`
- 验证失败则 item 不得标记为 passes

### 4. 记录规范

- 完成 item 后更新 `prd.json` 的 `passes` 字段
- 向 `progress.txt` 追加执行记录
- 禁止修改 progress.txt 的历史记录

### 5. 提交规范

- 每个 item 对应一个 git commit
- commit message 使用中文 subject
- 格式：`type(scope): 描述`

---

## 停止条件

### STOP(SUCCESS)

- 所有 items 的 `passes=true`
- 更新 `prd.json.statistics.completion` 为 100%

### STOP(BLOCKED)

无法继续时：

1. 在 `prd.json.statistics.blocked_reason` 写入阻塞原因
2. 包含：错误现象、关键日志、已尝试修复、下一步建议
3. 在 `progress.txt` 追加 BLOCKED 记录

---

## 阻塞处理流程

```
发现阻塞
    ↓
记录 blocked_reason（含错误、日志、尝试、建议）
    ↓
追加 progress.txt BLOCKED 条目
    ↓
STOP(BLOCKED)
    ↓
等待人工介入或外部依赖解决
```

---

## PRD Item 结构规范

每个 item 必须包含：

```json
{
  "id": "001",           // 3 位数字字符串
  "title": "中文标题",    // 简明任务描述
  "priority": "P1",      // P1 / P2 / P3
  "passes": false,       // 完成状态
  "steps": [             // 执行步骤
    {
      "desc": "步骤描述",
      "commands": ["pnpm xxx"],
      "touched_paths": ["docs/xxx.md"]
    }
  ],
  "acceptance": [        // 验收标准
    "可操作的验收点"
  ],
  "risks": [],           // 风险点（可为空）
  "notes": ""            // 备注（可为空）
}
```

---

## Statistics 结构规范

```json
{
  "blocked_reason": "",   // 阻塞原因（空表示未阻塞）
  "created_at": "2026-01-26T00:00:00Z",
  "updated_at": "2026-01-26T00:00:00Z",
  "item_total": 8,        // item 总数
  "passes_total": 0       // 已完成数
}
```

---

## 变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-01-26 | 1.0.0 | 初始版本，定义执行法典 |
