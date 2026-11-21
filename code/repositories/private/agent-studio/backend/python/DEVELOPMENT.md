# Agent Studio Python Backend - 开发总结

## 项目概述

Agent Studio Python 后端是基于 FastAPI 的现代化异步Web服务,提供智能体执行和工作流调度能力。本实现与Go版本并行开发,为用户提供技术栈选择。

## 已完成功能

### Phase 1: 核心架构 ✓

1. **配置管理** (`app/config.py`)
   - Pydantic Settings 配置管理
   - 环境变量加载
   - 多模型API配置

2. **模型推理网关** (`app/services/executor.py`)
   - 统一模型调用接口
   - OpenAI客户端实现
   - 通义千问客户端实现
   - 流式/非流式输出支持

3. **工作流引擎** (`app/services/workflow_engine.py`)
   - DAG拓扑排序(Kahn算法)
   - 循环检测
   - 节点执行调度
   - 变量引用解析(`${NodeId.field}`)
   - LLM节点执行
   - 条件节点执行

4. **HTTP API** (`app/api/`)
   - `/api/agent/execute` - Agent流式执行
   - `/api/workflow/execute` - 工作流异步执行
   - `/api/workflow/{id}/logs` - 执行状态查询
   - `/api/workflow/validate` - DAG验证
   - `/api/model/available/list` - 模型列表
   - `/api/health` - 健康检查

### 技术特性

- **异步IO**: 基于 asyncio/httpx 的高性能异步处理
- **类型安全**: Pydantic 数据验证
- **流式输出**: SSE(Server-Sent Events)流式响应
- **CORS支持**: 跨域资源共享配置
- **自动文档**: Swagger UI + ReDoc

## 目录结构

```
backend/python/
├── app/
│   ├── main.py                      # FastAPI应用入口
│   ├── config.py                    # 配置管理
│   ├── api/
│   │   ├── agent.py                 # Agent API
│   │   ├── workflow.py              # 工作流API
│   │   └── model.py                 # 模型API
│   └── services/
│       ├── executor.py              # 模型推理网关
│       ├── workflow_engine.py       # 工作流引擎
│       └── llm/
│           ├── base.py              # 模型接口定义
│           ├── openai_client.py     # OpenAI实现
│           └── qwen_client.py       # 通义千问实现
├── tests/
│   └── test_workflow.py             # 工作流测试
├── requirements.txt                  # 生产依赖
├── requirements-dev.txt              # 开发依赖
├── verify_minimal.py                 # 功能验证脚本
├── start.sh / start.bat             # 启动脚本
└── README.md                         # 使用文档
```

## 核心模块设计

### 1. 模型推理网关

**设计模式**: 策略模式 + 工厂模式

```python
class ExecutorService:
    def __init__(self):
        self.executors = {
            "openai": OpenAIExecutor(...),
            "qwen": QwenExecutor(...)
        }
    
    def _get_executor(self, model: str) -> ModelExecutor:
        """根据模型名称路由到对应执行器"""
        if model.startswith("gpt"):
            return self.executors["openai"]
        elif model.startswith("qwen"):
            return self.executors["qwen"]
```

**支持模型**:
- OpenAI: gpt-3.5-turbo, gpt-4, gpt-4-turbo
- 通义千问: qwen-turbo, qwen-plus, qwen-max

### 2. 工作流引擎

**核心算法**:

1. **拓扑排序** (Kahn算法)
   - 保证节点按依赖顺序执行
   - 检测循环依赖
   - 时间复杂度: O(V+E)

2. **变量引用解析**
   - 支持嵌套路径: `${Start.result.text}`
   - 缺失变量保持原样
   - 正则表达式实现

**节点类型**:
- `StartNode` - 入口节点
- `LLMNode` - 模型推理节点
- `ConditionNode` - 条件分支节点
- `CodeNode` - 代码执行节点(待实现)
- `EndNode` - 输出节点

### 3. API设计

**RESTful接口**:

```
POST /api/agent/execute
  Request: { microAppVersionId, input: { message } }
  Response: SSE流 (data: {"content": "..."})

POST /api/workflow/execute
  Request: { workflowId, input: {...} }
  Response: { success, data: { executionId, status } }

GET /api/workflow/{id}/logs
  Response: { success, data: { status, nodeStates, output } }

POST /api/workflow/validate
  Request: { workflow: { nodes, edges } }
  Response: { success, data: { valid, executionOrder } }
```

## 验证结果

运行 `python verify_minimal.py`:

```
✓ 目录结构完整 (12 个文件)
✓ 拓扑排序正常
✓ 循环检测正常
✓ 变量解析正常
```

## 性能指标

| 指标 | 目标 | 实际 |
|------|------|------|
| 启动时间 | < 5s | 预计 3-5s |
| 单次推理 | < 2s | 取决于模型API |
| 内存占用 | < 300MB | 预计 200-300MB |

## 待实现功能

### Phase 2: 数据持久化 (1-2天)

- [ ] SQLAlchemy模型定义
- [ ] Alembic数据库迁移
- [ ] 执行历史存储
- [ ] 工作流定义CRUD

### Phase 3: 扩展能力 (2-3天)

- [ ] 代码沙箱节点 (Docker/vm2)
- [ ] MCP工具调用
- [ ] 知识库向量化
- [ ] Qdrant向量检索

### Phase 4: 生产就绪 (1-2天)

- [ ] 认证与鉴权
- [ ] 结构化日志
- [ ] Prometheus监控
- [ ] 错误追踪
- [ ] 单元测试覆盖

## 与Go版本对比

| 维度 | Python版本 | Go版本 |
|------|-----------|--------|
| **开发速度** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **运行性能** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **内存占用** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **并发能力** | ⭐⭐⭐ (GIL限制) | ⭐⭐⭐⭐⭐ (goroutine) |
| **AI生态** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **部署便利** | ⭐⭐⭐ (虚拟环境) | ⭐⭐⭐⭐⭐ (单二进制) |
| **学习曲线** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **代码可读性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

## 使用建议

### Python版本适合:
- 快速原型验证
- AI生态依赖重
- 团队熟悉Python
- 中小规模部署

### Go版本适合:
- 高并发场景
- 低内存要求
- 云原生部署
- 生产环境

## 快速开始

1. **配置环境**
   ```bash
   cp .env.example .env
   # 编辑.env填写API密钥
   ```

2. **安装依赖**
   ```bash
   pip install -r requirements.txt
   ```

3. **启动服务**
   ```bash
   python -m app.main
   ```

4. **访问文档**
   - Swagger UI: http://localhost:8000/docs
   - ReDoc: http://localhost:8000/redoc

## 测试示例

### 1. 健康检查
```bash
curl http://localhost:8000/api/health
```

### 2. 获取模型列表
```bash
curl http://localhost:8000/api/model/available/list
```

### 3. Agent执行(流式)
```bash
curl -N -X POST http://localhost:8000/api/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "microAppVersionId": "test",
    "input": {"message": "你好"}
  }'
```

### 4. 工作流验证
```bash
curl -X POST http://localhost:8000/api/workflow/validate \
  -H "Content-Type: application/json" \
  -d '{
    "workflow": {
      "nodes": [
        {"id": "start", "type": "StartNode"},
        {"id": "end", "type": "EndNode"}
      ],
      "edges": [
        {"source": "start", "target": "end"}
      ]
    }
  }'
```

## 依赖项

**生产依赖**:
- fastapi 0.104.1 - Web框架
- uvicorn 0.24.0 - ASGI服务器
- sqlalchemy 2.0.23 - ORM
- pydantic 2.5.0 - 数据验证
- httpx 0.25.1 - HTTP客户端

**开发依赖**:
- pytest 7.4.3 - 测试框架
- pytest-asyncio 0.21.1 - 异步测试
- pytest-cov 4.1.0 - 代码覆盖率

## 贡献指南

1. 代码风格: 遵循 PEP 8
2. 类型注解: 使用 Python 3.11+ 类型提示
3. 文档: 所有公开API需要docstring
4. 测试: 新功能需要单元测试

## 许可证

MIT License

## 联系方式

- 项目仓库: agent-studio
- 反馈Issue: GitHub Issues
- 文档: README.md

---

**开发状态**: Phase 1 完成 ✓  
**最后更新**: 2026-10-23  
**开发者**: AI Assistant
