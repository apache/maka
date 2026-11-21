# Agent Studio Python Backend

Agent Studio 的 Python 后端实现，基于 FastAPI 构建。

## 技术栈

- **FastAPI**: 现代化异步Web框架
- **SQLAlchemy**: ORM数据库访问
- **Pydantic**: 数据验证
- **httpx**: 异步HTTP客户端
- **PostgreSQL**: 主数据库(可选)
- **Python 3.11+**

## 目录结构

```
backend/python/
├── app/
│   ├── main.py              # FastAPI应用入口
│   ├── config.py            # 配置管理
│   ├── api/                 # 路由层
│   │   ├── agent.py         # Agent执行API
│   │   ├── model.py         # 模型管理API
│   │   └── workflow.py      # 工作流执行API
│   ├── services/            # 业务逻辑
│   │   ├── executor.py      # 模型推理网关
│   │   ├── workflow_engine.py  # DAG调度器
│   │   └── llm/             # 模型适配器
│   │       ├── base.py      # 接口定义
│   │       ├── openai_client.py  # OpenAI客户端
│   │       └── qwen_client.py    # 通义千问客户端
│   ├── models/              # SQLAlchemy模型(待实现)
│   └── schemas/             # Pydantic数据模型
├── tests/                   # 测试
├── requirements.txt         # Python依赖
├── .env.example            # 环境变量示例
├── start.sh                # Linux/Mac启动脚本
└── start.bat               # Windows启动脚本
```

## 快速开始

### 1. 环境要求

- Python 3.11+
- pip

### 2. 安装依赖

#### Linux/Mac

```bash
# 创建虚拟环境
python3 -m venv venv
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

#### Windows

```cmd
# 创建虚拟环境
python -m venv venv
venv\Scripts\activate.bat

# 安装依赖
pip install -r requirements.txt
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env` 并填写配置:

```bash
cp .env.example .env
```

编辑 `.env`:

```env
# OpenAI配置
OPENAI_API_KEY=sk-your-openai-key
OPENAI_BASE_URL=https://api.openai.com/v1

# 通义千问配置
QWEN_API_KEY=sk-your-qwen-key
QWEN_BASE_URL=https://dashscope.aliyuncs.com/api/v1
```

### 4. 启动服务

#### 方式1: 使用启动脚本

Linux/Mac:
```bash
chmod +x start.sh
./start.sh
```

Windows:
```cmd
start.bat
```

#### 方式2: 直接运行

```bash
python -m app.main
```

服务将在 `http://localhost:8000` 启动。

### 5. 访问API文档

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## 核心功能

### 1. 模型推理网关

支持多模型统一调用:

- OpenAI (GPT-3.5, GPT-4)
- 通义千问 (qwen-turbo, qwen-plus, qwen-max)

#### 示例: Agent执行(流式)

```bash
curl -X POST http://localhost:8000/api/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "microAppVersionId": "test-agent",
    "input": {
      "message": "你好"
    }
  }'
```

#### 示例: 获取可用模型

```bash
curl http://localhost:8000/api/model/available/list
```

### 2. 工作流引擎

支持DAG工作流执行:

- 拓扑排序
- LLM节点
- 条件节点
- 变量引用 (`${NodeId.result.field}`)

#### 示例: 执行工作流

```bash
curl -X POST http://localhost:8000/api/workflow/execute \
  -H "Content-Type: application/json" \
  -d '{
    "workflowId": "test-workflow",
    "input": {
      "text": "Hello World"
    }
  }'
```

#### 示例: 查询执行状态

```bash
curl http://localhost:8000/api/workflow/{executionId}/logs
```

#### 示例: 验证工作流

```bash
curl -X POST http://localhost:8000/api/workflow/validate \
  -H "Content-Type: application/json" \
  -d '{
    "workflow": {
      "nodes": [...],
      "edges": [...]
    }
  }'
```

### 3. 健康检查

```bash
curl http://localhost:8000/api/health
```

## 开发

### 运行测试

```bash
pytest tests/
```

### 代码格式化

```bash
pip install black isort
black app/
isort app/
```

### 类型检查

```bash
pip install mypy
mypy app/
```

## 性能指标

- 启动时间: < 5s
- 单次推理响应: < 2s
- 内存占用: < 300MB

## 待实现功能

- [ ] 数据库集成 (SQLAlchemy + PostgreSQL)
- [ ] 代码沙箱节点
- [ ] MCP工具调用
- [ ] 知识库向量化
- [ ] 执行历史持久化
- [ ] 认证与鉴权
- [ ] 日志系统
- [ ] 监控指标

## 与Go版本对比

| 特性 | Python版本 | Go版本 |
|------|-----------|--------|
| 启动时间 | 3-5s | 1-2s |
| 内存占用 | 200-300MB | 50-100MB |
| 并发性能 | 中等(GIL限制) | 高(goroutine) |
| 开发速度 | 快 | 中等 |
| 生态支持 | AI生态完善 | 标准库强大 |
| 部署方式 | 虚拟环境 | 单二进制 |

## 故障排除

### 问题1: 模块导入错误

```bash
# 确保虚拟环境已激活
source venv/bin/activate  # Linux/Mac
venv\Scripts\activate.bat  # Windows

# 重新安装依赖
pip install -r requirements.txt
```

### 问题2: 端口占用

修改 `.env` 中的 `SERVER_PORT`:

```env
SERVER_PORT=8001
```

### 问题3: API密钥错误

检查 `.env` 中的配置:

```env
OPENAI_API_KEY=sk-your-real-key
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
