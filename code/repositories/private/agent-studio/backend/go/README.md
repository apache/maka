# Agent Studio 后端

基于Go的Agent Studio后端服务,提供模型推理网关和工作流执行引擎。

## 技术栈

- **Go**: 1.21+
- **Gin**: HTTP框架
- **GORM**: ORM框架
- **PostgreSQL**: 数据库
- **OpenAI API**: GPT系列模型
- **通义千问API**: Qwen系列模型

## 快速开始

### 1. 安装依赖

```bash
cd backend
go mod download
```

### 2. 配置环境变量

创建 `.env` 文件:

```bash
# OpenAI配置
export OPENAI_API_KEY=sk-xxx

# 通义千问配置
export QWEN_API_KEY=sk-xxx

# 数据库配置(可选,默认使用config.yaml)
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=agent_studio
export DB_USER=postgres
export DB_PASSWORD=postgres
```

加载环境变量:

```bash
source .env
```

### 3. 启动PostgreSQL

使用Docker快速启动:

```bash
docker run -d \
  --name agent-studio-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=agent_studio \
  -p 5432:5432 \
  postgres:15
```

或使用本地安装的PostgreSQL,确保创建数据库:

```sql
CREATE DATABASE agent_studio;
```

### 4. 运行服务器

```bash
go run cmd/server/main.go
```

服务器将启动在 `http://localhost:8080`

## API文档

### 1. 健康检查

```bash
GET /api/health
```

响应:

```json
{
  "success": true,
  "message": "服务正常",
  "time": "2026-10-23T15:30:00Z"
}
```

### 2. 获取模型列表

```bash
GET /api/v1/models/available/list
```

响应:

```json
{
  "success": true,
  "code": 0,
  "data": [
    {
      "modelId": "382849770824167457",
      "modelCode": "gpt-4",
      "modelName": "GPT-4",
      "provider": "OpenAI"
    },
    {
      "modelId": "382849770824167459",
      "modelCode": "qwen-turbo",
      "modelName": "通义千问Turbo",
      "provider": "Alibaba"
    }
  ]
}
```

### 3. 执行Agent(流式输出)

```bash
POST /api/agent/execute
Content-Type: application/json

{
  "microAppVersionId": "5433",
  "input": {
    "message": "你好,请介绍一下你自己"
  }
}
```

响应(SSE流):

```
data: {"content":"你","tokens":1}
data: {"content":"好","tokens":2}
data: {"content":"！","tokens":3}
...
data: [DONE]
```

### 4. 测试模型调用

```bash
POST /api/agent/test-model
Content-Type: application/json

{
  "model": "gpt-3.5-turbo",
  "message": "你好"
}
```

响应:

```json
{
  "success": true,
  "data": {
    "content": "你好！有什么我可以帮助你的吗？",
    "finishReason": "stop",
    "tokens": 25
  }
}
```

### 5. 获取执行记录

```bash
GET /api/agent/execution/:id
```

### 6. 执行记录列表

```bash
GET /api/agent/executions?agentId=5433&status=success
```

## 项目结构

```
backend/
├── cmd/
│   └── server/
│       └── main.go              # 主程序入口
├── internal/
│   ├── api/                     # HTTP控制器
│   │   ├── agent.go             # Agent执行API
│   │   └── model.go             # 模型列表API
│   ├── service/
│   │   └── executor.go          # 执行器服务
│   ├── model/
│   │   ├── config.go            # 配置模型
│   │   └── execution.go         # 执行记录模型
│   └── pkg/
│       └── llm/                 # LLM适配器
│           ├── types.go         # 接口定义
│           ├── openai.go        # OpenAI适配器
│           └── qwen.go          # 通义千问适配器
├── migrations/                  # 数据库迁移(预留)
├── config.yaml                  # 配置文件
├── go.mod
└── README.md
```

## 测试

### 单元测试

```bash
# 测试模型推理
go test ./internal/pkg/llm -v

# 测试服务层
go test ./internal/service -v

# 测试API层
go test ./internal/api -v
```

### 集成测试

```bash
# 启动服务后测试健康检查
curl http://localhost:8080/api/health

# 测试模型列表
curl http://localhost:8080/api/v1/models/available/list

# 测试模型调用(需配置API密钥)
curl -X POST http://localhost:8080/api/agent/test-model \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-3.5-turbo","message":"你好"}'
```

## 配置说明

### config.yaml

```yaml
server:
  port: 8080          # 服务端口
  mode: debug         # debug/release

database:
  host: localhost
  port: 5432
  name: agent_studio
  user: postgres
  password: postgres
  sslmode: disable

models:
  openai:
    base_url: https://api.openai.com/v1
  qwen:
    base_url: https://dashscope.aliyuncs.com/api/v1
```

### 环境变量优先级

环境变量 > config.yaml

必需的环境变量:
- `OPENAI_API_KEY`: OpenAI API密钥
- `QWEN_API_KEY`: 通义千问API密钥

## 性能指标

- 单次推理响应时间: <2s (不含模型推理时间)
- 并发支持: 10+ 并发请求
- 内存占用: ~50MB (空闲状态)

## 开发计划

- [x] 项目骨架搭建
- [x] Gin路由配置
- [x] OpenAI适配器
- [x] 通义千问适配器
- [x] SSE流式输出
- [x] 数据库模型
- [ ] 单元测试
- [ ] 工作流引擎集成
- [ ] MCP工具集成
- [ ] 知识库系统

## 问题排查

### 1. 数据库连接失败

检查PostgreSQL是否启动:

```bash
docker ps | grep agent-studio-db
```

检查连接参数:

```bash
psql -h localhost -U postgres -d agent_studio
```

### 2. API密钥未设置

确保环境变量已加载:

```bash
echo $OPENAI_API_KEY
echo $QWEN_API_KEY
```

### 3. 端口被占用

修改 `config.yaml` 中的端口或停止占用进程:

```bash
# Windows
netstat -ano | findstr :8080

# Linux/Mac
lsof -i :8080
```

## 贡献指南

1. 代码风格遵循 `gofmt` 标准
2. 提交前运行 `go vet` 和 `go test`
3. 错误处理使用 `fmt.Errorf` 包装
4. 日志使用标准库 `log` 包

## 许可证

MIT
