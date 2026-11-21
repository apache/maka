# Vibe Coding 通用执行规则

> 基于 AI-Ready Workflow v3.0，为 AI Agent 自主执行任务制定的通用规则
> 适用于所有 `.kiro/specs/*/` 下的 Spec 任务执行

---

## 📜 宪法精神

### 第一条：Flow State（心流状态）

- AI 应像流水一样持续推进任务
- 避免不必要的中断和确认
- 用户启动任务后，AI 应自主完成直到结束

### 第二条：Minimal Friction（最小摩擦）

- 能自己决定的事情，不问用户
- 能自己修复的错误，不报告用户
- 只在真正需要用户输入时才暂停

### 第三条：Self-Healing（自我修复）

- 错误是正常的，修复是必须的
- 先尝试修复，再考虑报告
- 最多重试 3 次，仍失败则记录并跳过

### 第四条：Continuous Progress（持续推进）

- 完成一个任务后，自动继续下一个
- 不等待用户确认，保持执行节奏
- 目标是一次性完成所有任务

### 第五条：Knowledge Persistence（知识持久化）

- 重要决策写入文件，不仅存在对话中
- 任务进度实时更新到 tasks.md
- 经验沉淀到 `05-面试与复盘/` 或 `02-专业技能/`

---

## 🔄 上下文限制处理协议

### 问题描述

当会话上下文接近极限时，可能出现以下提示：

**提示 1：接近限制警告**

> "The conversation in this session is about to reach the agent context limit..."

**提示 2：意外超限错误**

> "Context limit exceeded unexpectedly. Please start a new session to continue."

### 预防措施

1. **任务粒度控制**：每个子任务保持独立，不依赖过多上下文
2. **关键信息外化**：重要信息写入文件（tasks.md、design.md）
3. **增量式执行**：每完成一个任务就更新状态
4. **避免大文件读取**：优先读取必要的文件片段，而非整个文件

### 上下文恢复机制

当新会话开始、上下文被压缩、或遇到 `Context limit exceeded` 错误时，执行以下恢复流程：

```markdown
## 上下文恢复检查清单

1. 读取 `.kiro/specs/{feature-name}/tasks.md` 获取任务进度
2. 读取 `.kiro/specs/{feature-name}/design.md` 获取设计规范
3. 读取 `.kiro/specs/{feature-name}/requirements.md` 获取需求定义
4. 读取 `.kiro/steering/vibe-coding-rules.md` 获取通用执行规则
5. 识别下一个未完成的任务（查找 `- [ ]` 标记）
6. 立即继续执行，不询问用户
```

### 会话切换指令模板

```
请继续执行 {feature-name} 的任务。
先读取 tasks.md 查看进度，然后继续未完成的任务。
```

### 意外超限处理

当遇到 `Context limit exceeded unexpectedly` 错误时：

1. 用户需要开启新会话
2. 在新会话中使用上述「会话切换指令模板」
3. AI 读取 tasks.md 识别进度，从未完成的任务继续执行

---

## 🚫 中断场景处理策略

### 场景 1：Spec Session 提示

**提示内容**：

> "I see you're working on a task that's optimized for spec sessions. Would you like to start a dedicated spec session for the best experience?"

**处理策略**：

- 用户点击 "Yes" → 在 Spec Session 中继续执行
- 用户点击 "No" → 在普通会话中继续执行
- AI 不因此中断，继续完成任务

### 场景 2：上下文限制提示

**处理策略**：参见「上下文限制处理协议」章节

### 场景 3：文件保存确认

**处理策略**：

- 用户应启用 Autopilot 模式
- AI 在 Supervised 模式下等待用户确认后继续

### 场景 4：终端命令确认

**处理策略**：

- AI 优先使用文件操作而非终端命令
- 必须使用终端时，选择安全的只读命令

### 场景 5：MCP 工具调用确认

**处理策略**：

- 用户在 `mcp.json` 的 `autoApprove` 中添加常用工具
- AI 优先使用已自动批准的工具

### 场景 6：新会话/窗口切换

**处理策略**：

- AI 主动读取 Spec 文件恢复上下文
- 使用「上下文恢复检查清单」流程

### 用户预配置清单

```markdown
## Vibe Coding 预配置

- [ ] 启用 Autopilot 模式
- [ ] 配置 MCP autoApprove
- [ ] 确保 Spec 文件完整（tasks.md, design.md, requirements.md）
```

### AI 自主应对原则

1. 不主动询问用户
2. 选择有利于继续执行的选项
3. 记录中断情况到反思记录
4. 中断处理后立即恢复执行

---

## ✅ 执行检查清单

### 任务完成标准

- [ ] 文件已创建/更新
- [ ] 内容符合任务要求
- [ ] 代码可运行（如适用）
- [ ] 无语法错误
- [ ] 链接有效（如适用）
- [ ] tasks.md 状态已更新

### 报错处理流程

```
1. 识别错误类型
   ├── 语法错误 → 修复语法
   ├── 文件不存在 → 创建文件
   ├── 权限问题 → 尝试备选路径
   └── 依赖缺失 → 安装依赖

2. 分析错误原因 → 查看错误信息，定位问题
3. 制定修复方案 → 选择最简单有效的方案
4. 执行修复 → 立即执行，不询问用户
5. 验证修复结果 → 确认问题已解决
6. 沉淀经验 → 复杂问题记录到知识库
```

### 任务跳过条件

以下情况可暂时跳过任务，继续执行后续任务：

- 依赖外部资源无法访问
- 需要用户提供额外信息
- 重试 3 次仍失败

跳过的任务记录在反思中，所有任务完成后统一处理。

---

## 📝 反思记录模板

每个任务完成后，追加以下格式的反思记录：

```markdown
### 任务 X.Y 完成反思

- **完成时间**：YYYY-MM-DD
- **完成情况**：✅ 成功 / ⚠️ 部分完成 / ❌ 跳过
- **文件路径**：`path/to/file`
- **遇到的问题**：（如有）
- **解决方案**：（如有）
```

---

## 🎯 总结

> **Vibe Coding** = 「自主执行 + 自动纠错 + 持续推进」
>
> AI 像一个靠谱的同事，启动任务后自主完成，遇到问题自己解决。
> 用户只需要启动和验收，中间过程完全自动化。

---

_版本：v1.1_
_创建时间：2025-12-29_
_基于：AI-Ready Workflow v3.0_
