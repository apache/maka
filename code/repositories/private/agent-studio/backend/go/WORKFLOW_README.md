# 工作流引擎 API 文档

## 概述

Agent Studio Go版工作流引擎核心模块，支持DAG工作流的定义、验证和执行。

## 功能特性

- ✅ DAG拓扑排序与环检测
- ✅ 多种节点类型（StartNode、LLMNode、ConditionNode、EndNode）
- ✅ 变量引用解析（支持嵌套路径 `${nodeId.field.subfield}`）
- ✅ 节点状态跟踪与执行日志
- ✅ 并发安全的执行上下文
- ✅ 超时控制与错误处理
- ✅ 完整的单元测试覆盖

## API 接口

### 1. 执行工作流

**请求**
```http
POST /api/workflow/execute
Content-Type: application/json

{
  "workflowId": "5433",
  "input": {
    "message": "测试消息"
  }
}
```

**响应**
```json
{
  "success": true,
  "data": {
    "executionId": "uuid-here",
    "status": "pending"
  }
}
```

### 2. 查询执行日志

**请求**
```http
GET /api/workflow/:executionId/logs
```

**响应**
```json
{
  "success": true,
  "data": {
    "id": "uuid-here",
    "workflowId": "5433",
    "status": "success",
    "output": {
      "result": "执行结果"
    },
    "nodeStates": {
      "start": {
        "nodeId": "start",
        "status": "success",
        "duration": 0
      },
      "llm1": {
        "nodeId": "llm1",
        "status": "success",
        "duration": 1234,
        "result": {
          "content": "LLM响应内容"
        }
      }
    },
    "duration": 1234,
    "createdAt": "2026-10-23T10:00:00Z",
    "completedAt": "2026-10-23T10:00:01Z"
  }
}
```

### 3. 列出执行记录

**请求**
```http
GET /api/workflow/executions?workflowId=5433&status=success
```

**响应**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid-1",
      "workflowId": "5433",
      "status": "success",
      "createdAt": "2026-10-23T10:00:00Z"
    }
  ]
}
```

## 工作流定义格式

### 基本结构

```json
{
  "nodes": [
    {
      "id": "start",
      "type": "StartNode",
      "title": "开始",
      "data": {},
      "position": { "x": 0, "y": 0 }
    },
    {
      "id": "llm1",
      "type": "LLMNode",
      "title": "LLM节点",
      "data": {
        "model": "gpt-3.5-turbo",
        "systemPrompt": "你是一个助手",
        "userPrompt": "处理: ${start.result.message}",
        "temperature": 0.7,
        "maxTokens": 2000,
        "outputType": "Text"
      },
      "position": { "x": 200, "y": 0 }
    },
    {
      "id": "end",
      "type": "EndNode",
      "title": "结束",
      "data": {
        "outputParams": [
          {
            "key": "result",
            "value": "${llm1.result.content}"
          }
        ],
        "outputType": "JSON"
      },
      "position": { "x": 400, "y": 0 }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "start",
      "target": "llm1"
    },
    {
      "id": "e2",
      "source": "llm1",
      "target": "end"
    }
  ]
}
```

### 节点类型

#### StartNode (开始节点)
- 工作流入口
- 自动注入用户输入到 `${start.result.*}`

#### LLMNode (大模型节点)
```json
{
  "type": "LLMNode",
  "data": {
    "model": "模型ID",
    "systemPrompt": "系统提示词（支持变量引用）",
    "userPrompt": "用户提示词（支持变量引用）",
    "temperature": 0.7,
    "maxTokens": 2000,
    "outputType": "Text" // 或 "JSON"
  }
}
```

输出格式:
```json
{
  "result": {
    "content": "模型生成的文本",
    "tokens": 100,
    "finishReason": "stop"
  }
}
```

#### ConditionNode (条件节点)
```json
{
  "type": "ConditionNode",
  "data": {
    "leftValue": "${llm1.result.content}",
    "operator": "==",  // ==, !=, >, <, >=, <=, contains, startsWith, endsWith
    "rightValue": "预期值"
  }
}
```

输出格式:
```json
{
  "result": {
    "matched": true,
    "leftValue": "实际值",
    "operator": "==",
    "rightValue": "预期值"
  }
}
```

#### EndNode (结束节点)
```json
{
  "type": "EndNode",
  "data": {
    "outputParams": [
      {
        "key": "字段名",
        "value": "${nodeId.path.to.value}"
      }
    ],
    "outputType": "JSON"  // 或 "Text"
  }
}
```

## 变量引用语法

### 基本语法
```
${nodeId.field.subfield}
```

### 示例
```javascript
// 引用开始节点的输入
"${start.result.message}"

// 引用LLM节点的输出
"${llm1.result.content}"

// 引用条件节点的结果
"${condition1.result.matched}"

// 嵌套引用
"用户说: ${start.result.message}, AI回复: ${llm1.result.content}"
```

## 测试

### 运行单元测试
```bash
cd backend/go
go test ./internal/service/workflow -v
```

### 运行基准测试
```bash
go test ./internal/service/workflow -bench=. -benchmem
```

### 编译
```bash
go build -o server.exe ./cmd/server
```

## 数据库表结构

### workflow_executions
```sql
CREATE TABLE workflow_executions (
    id UUID PRIMARY KEY,
    workflow_id VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL,  -- pending/running/success/failed
    input JSONB,
    output JSONB,
    node_states JSONB,
    variables JSONB,
    error_msg TEXT,
    duration BIGINT DEFAULT 0,    -- 毫秒
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP
);

CREATE INDEX idx_workflow_executions_workflow_id ON workflow_executions(workflow_id);
CREATE INDEX idx_workflow_executions_status ON workflow_executions(status);
```

## 错误码

| 错误码 | 说明 |
|--------|------|
| INVALID_REQUEST | 请求参数无效 |
| WORKFLOW_NOT_FOUND | 工作流不存在 |
| INVALID_WORKFLOW | 工作流格式错误 |
| EXECUTION_NOT_FOUND | 执行记录不存在 |
| DB_ERROR | 数据库错误 |

## 性能指标

- 简单工作流（3节点）: ~20μs（模拟模式）
- DAG环检测: O(V+E)
- 变量解析: O(n*d)，n=变量数，d=嵌套深度
- 并发安全: 使用RWMutex保护

## 下一步计划

- [ ] 支持并行分支执行
- [ ] 支持循环节点（Loop）
- [ ] 支持子工作流嵌套
- [ ] 支持工作流可视化编辑器
- [ ] 支持更多节点类型（HTTP、数据库、文件操作等）
