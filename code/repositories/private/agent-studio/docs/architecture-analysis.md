# Agent Studio 架构分析与改进建议

## 一、项目现状评估

### 1.1 前端实现
**已完成部分**：
- 完整的React前端应用(app/目录)
- 7种智能体编辑模式(对话型×2、工作流、智能体、任务型、工具型、超级智能体)
- 知识库管理界面
- 离线数据模拟(offline-*.js)
- 完整的API契约定义

**技术栈识别**：
- 构建工具：Vite
- UI框架：React
- 数据管理：本地localStorage + JSON数据文件
- 工作流画布：ReactFlow节点系统

### 1.2 核心功能需求
从`offline-api.js`和工作流数据中提取的关键能力：

1. **Agent CRUD**
   - 创建/复制/更新/删除/启用/禁用
   - 多版本管理
   - 7种运行模式(runMode 0-6)

2. **工作流执行引擎**
   节点类型分析：
   - `StartNode` - 参数定义与触发
   - `LLMNode` - 模型推理(支持多模型、流式输出)
   - `CodeNode` - 代码沙箱执行
   - `ConditionNode` - 条件分支
   - `EndNode` - 结果输出
   - MCP工具节点 - 外部API调用

3. **知识库系统**
   - 文档管理(上传/删除/分类)
   - 向量化与检索
   - 知识库与Agent关联

4. **模型管理**
   - 多模型支持(OpenAI/Anthropic/通义千问/Ollama)
   - 模型参数配置
   - 流式/非流式输出

### 1.3 现有方案问题诊断

#### Go方案(backend-plan-golang.md)
**优势**：
- 高并发性能(goroutine)
- 内存占用低
- 单二进制部署

**过度设计问题**：
1. **Temporal引入不必要**
   - 工作流DAG本质是有向无环图的串行/并行执行
   - Temporal是企业级分布式工作流引擎,过于复杂
   - 学习曲线陡峭,文档采集难度大
   - 状态持久化可用PostgreSQL+简单状态机实现

2. **gVisor沙箱过重**
   - 生产环境可用,但本地开发调试困难
   - 可先用轻量级沙箱方案

3. **架构复杂度不匹配**
   ```
   架构层级：
   cmd/api/       - HTTP服务
   cmd/worker/    - Temporal worker (不必要)
   internal/service/workflow_engine.go - Temporal定义(可简化)
   ```

#### Python方案(backend-plan-python.md)
**优势**：
- FastAPI现代化异步框架
- AI生态完善(langchain等)
- 快速原型验证

**性能瓶颈**：
1. **GIL限制**
   - Python单线程并发受限
   - 工作流并行执行效率低
   - CPU密集型任务(向量化)性能差

2. **Celery复杂度**
   - Redis依赖
   - 任务序列化开销
   - 调试困难

3. **内存占用**
   - ~200MB基础占用 vs Go的~50MB

## 二、改进方案建议

### 2.1 技术栈选择：Go + 轻量级工作流引擎

#### 核心理由
1. **性能与并发**
   - 工作流执行需并行处理多个LLM节点
   - 向量化需高并发调用embedding模型
   - Go的goroutine天然支持,无GIL限制

2. **复杂度控制**
   - **移除Temporal** → 自研轻量级DAG引擎
   - **移除gVisor** → 使用标准容器或vm2沙箱
   - **简化依赖** → PostgreSQL + Qdrant即可

3. **部署便利性**
   - 单二进制 vs Python虚拟环境
   - 无运行时依赖,适合容器化部署

### 2.2 简化架构设计

#### 目录结构(精简版)
```
backend/
├── cmd/
│   └── server/
│       └── main.go              # 单一入口
├── internal/
│   ├── api/                     # Gin路由
│   │   ├── agent.go
│   │   ├── workflow.go
│   │   ├── mcp.go
│   │   └── knowledge.go
│   ├── service/
│   │   ├── executor.go          # 模型推理网关
│   │   ├── workflow/            # 工作流引擎(新设计)
│   │   │   ├── dag.go           # DAG解析与拓扑排序
│   │   │   ├── executor.go      # 节点执行调度
│   │   │   ├── context.go       # 执行上下文管理
│   │   │   └── nodes/           # 节点实现
│   │   │       ├── llm.go
│   │   │       ├── code.go
│   │   │       ├── condition.go
│   │   │       └── mcp.go
│   │   ├── mcp.go               # MCP客户端
│   │   └── vectorizer.go        # 向量化管线
│   ├── model/                   # GORM模型
│   └── pkg/
│       ├── llm/                 # 多模型适配器
│       └── sandbox/             # 代码沙箱
├── migrations/
├── go.mod
└── go.sum
```

#### 2.2.1 工作流引擎简化设计

**核心组件**：
```go
// DAG定义
type Node struct {
    ID       string                 `json:"id"`
    Type     string                 `json:"type"` // LLM/Code/Condition/MCP
    Data     map[string]interface{} `json:"data"`
    Position struct{ X, Y int }     `json:"position"`
}

type Edge struct {
    Source       string `json:"source"`
    Target       string `json:"target"`
    SourceHandle string `json:"sourceHandle"`
    TargetHandle string `json:"targetHandle"`
}

type Workflow struct {
    Nodes []Node `json:"nodes"`
    Edges []Edge `json:"edges"`
}

// 执行上下文
type ExecutionContext struct {
    Variables map[string]interface{} // 节点输出缓存
    State     ExecutionState          // pending/running/success/failed
    sync.RWMutex
}

// 执行器
type WorkflowEngine struct {
    executor *ModelExecutor
    mcpClient *MCPClient
    sandbox   *Sandbox
}

func (e *WorkflowEngine) Execute(ctx context.Context, wf *Workflow, input map[string]interface{}) (*ExecutionResult, error) {
    // 1. 拓扑排序验证DAG
    sorted, err := topologicalSort(wf)
    if err != nil {
        return nil, err
    }
    
    // 2. 初始化执行上下文
    execCtx := &ExecutionContext{
        Variables: input,
        State:     StatePending,
    }
    
    // 3. 按拓扑序执行
    for _, nodeID := range sorted {
        node := getNode(wf, nodeID)
        
        // 4. 路由到具体节点处理器
        result, err := e.executeNode(ctx, node, execCtx)
        if err != nil {
            execCtx.State = StateFailed
            return nil, err
        }
        
        // 5. 保存节点输出
        execCtx.Lock()
        execCtx.Variables[nodeID] = result
        execCtx.Unlock()
    }
    
    // 6. 提取最终输出
    return &ExecutionResult{
        Output: execCtx.Variables["end"],
        State:  StateSuccess,
    }, nil
}
```

**节点并发优化**：
```go
func (e *WorkflowEngine) Execute(ctx context.Context, wf *Workflow, input map[string]interface{}) (*ExecutionResult, error) {
    layers := layerize(wf) // 按依赖关系分层
    execCtx := &ExecutionContext{Variables: input}
    
    for _, layer := range layers {
        // 同一层节点可并行执行
        var wg sync.WaitGroup
        errChan := make(chan error, len(layer))
        
        for _, nodeID := range layer {
            wg.Add(1)
            go func(id string) {
                defer wg.Done()
                result, err := e.executeNode(ctx, getNode(wf, id), execCtx)
                if err != nil {
                    errChan <- err
                    return
                }
                execCtx.Lock()
                execCtx.Variables[id] = result
                execCtx.Unlock()
            }(nodeID)
        }
        
        wg.Wait()
        close(errChan)
        
        if err := <-errChan; err != nil {
            return nil, err
        }
    }
    
    return &ExecutionResult{Output: execCtx.Variables["end"]}, nil
}
```

#### 2.2.2 状态持久化(无需Temporal)

**数据库表设计**：
```sql
CREATE TABLE workflow_executions (
    id UUID PRIMARY KEY,
    workflow_id VARCHAR NOT NULL,
    status VARCHAR NOT NULL,  -- pending/running/success/failed
    input JSONB,
    output JSONB,
    node_states JSONB,         -- {nodeID: {status, result, startTime, endTime}}
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX idx_workflow_executions_created ON workflow_executions(created_at DESC);
```

**状态更新策略**：
```go
// 节点开始执行
func (e *WorkflowEngine) onNodeStart(execID uuid.UUID, nodeID string) {
    db.Exec(`
        UPDATE workflow_executions 
        SET node_states = jsonb_set(
            COALESCE(node_states, '{}'::jsonb),
            ARRAY[$1],
            jsonb_build_object('status', 'running', 'startTime', NOW())
        )
        WHERE id = $2
    `, nodeID, execID)
}

// 节点执行完成
func (e *WorkflowEngine) onNodeComplete(execID uuid.UUID, nodeID string, result interface{}) {
    db.Exec(`
        UPDATE workflow_executions 
        SET node_states = jsonb_set(
            node_states,
            ARRAY[$1, 'status'],
            '"success"'
        ),
        node_states = jsonb_set(
            node_states,
            ARRAY[$1, 'result'],
            $2::jsonb
        ),
        node_states = jsonb_set(
            node_states,
            ARRAY[$1, 'endTime'],
            to_jsonb(NOW())
        )
        WHERE id = $3
    `, nodeID, toJSON(result), execID)
}
```

#### 2.2.3 代码沙箱(简化方案)

**生产环境**：标准Docker容器
```go
func (s *Sandbox) Execute(ctx context.Context, code string, input map[string]interface{}) (map[string]interface{}, error) {
    // 使用官方镜像,限制资源
    cmd := exec.CommandContext(ctx,
        "docker", "run", "--rm",
        "--network=none",
        "--cpus=0.5",
        "--memory=256m",
        "--read-only",
        "-i", "node:18-alpine",
        "node", "-e", code,
    )
    
    cmd.Stdin = toJSON(input)
    output, err := cmd.CombinedOutput()
    // 解析结果...
}
```

**本地开发**：Node vm2模块
```go
func (s *Sandbox) Execute(ctx context.Context, code string, input map[string]interface{}) (map[string]interface{}, error) {
    // 启动Node子进程
    cmd := exec.CommandContext(ctx, "node", "-e", `
        const {VM} = require('vm2');
        const vm = new VM({timeout: 5000, sandbox: {}});
        const input = JSON.parse(process.argv[1]);
        const result = vm.run('(function(input) {' + process.argv[2] + '})(input)');
        console.log(JSON.stringify(result));
    `, toJSON(input), code)
    
    output, err := cmd.CombinedOutput()
    // ...
}
```

### 2.3 关键接口实现优先级

#### Phase 1: 核心推理能力(2周)
```
GET  /api/models/available/list       # 可用模型列表
POST /api/agent/execute               # 单次推理
GET  /api/execution/:id               # 执行状态查询
POST /api/microAppVersion/update      # 配置保存
```

**验收标准**：
- 前端能调用OpenAI/通义千问完成推理
- 支持流式输出
- 历史记录可查询

#### Phase 2: 工作流引擎(3周)
```
POST /api/workflow/execute            # 工作流执行
GET  /api/workflow/:id/logs           # 执行日志
POST /api/workflow/validate           # DAG合法性校验
```

**验收标准**：
- 支持LLM节点串行执行
- 支持条件分支
- 同层节点可并行执行
- 执行状态可持久化

#### Phase 3: 扩展能力(2周)
```
POST /api/mcp/call                    # MCP工具调用
POST /api/knowledge/vectorize         # 文档向量化
POST /api/knowledge/search            # 知识检索
```

### 2.4 依赖项精简对比

| 组件 | 原Go方案 | 改进方案 | 理由 |
|------|---------|---------|------|
| 工作流引擎 | Temporal | 自研DAG引擎(~500行) | 无需分布式,减少学习成本 |
| 代码沙箱 | gVisor | Docker/vm2 | 开发友好,可按环境切换 |
| 数据库 | PostgreSQL + Temporal DB | PostgreSQL | 单库,状态存JSONB字段 |
| 消息队列 | 不需要 | 不需要 | HTTP长连接+SSE足够 |
| 向量数据库 | Qdrant | Qdrant | 保持不变 |

**启动依赖对比**：
```yaml
# 原方案
services:
  - postgres
  - temporal
  - temporal-admin-tools
  - qdrant

# 改进方案
services:
  - postgres
  - qdrant
```

## 三、实施路线图

### 3.1 阶段划分

**Week 1-2: 基础架构搭建**
- [ ] Gin路由骨架
- [ ] GORM模型定义
- [ ] 模型推理网关(支持OpenAI/通义千问)
- [ ] SSE流式输出
- [ ] 单元测试覆盖

**Week 3-5: 工作流引擎**
- [ ] DAG解析与拓扑排序
- [ ] LLM节点执行器
- [ ] Condition节点执行器
- [ ] 变量引用解析(`${Start.result.xxx}`)
- [ ] 执行状态持久化
- [ ] 并行执行优化

**Week 6-7: 扩展能力**
- [ ] MCP客户端实现
- [ ] 文档分段与向量化
- [ ] Qdrant向量检索
- [ ] 代码沙箱(Docker方案)

**Week 8-9: 集成测试与优化**
- [ ] 端到端测试
- [ ] 性能压测(100并发推理<2s)
- [ ] 前端联调
- [ ] 文档完善

### 3.2 技术风险缓解

#### 风险1: 自研工作流引擎稳定性
**缓解措施**：
- 采用成熟的DAG拓扑排序算法(Kahn算法)
- 参考Airflow/Prefect的节点调度设计
- 充分单元测试(80%+覆盖率)
- 提供工作流可视化调试工具

#### 风险2: Go AI生态不如Python
**缓解措施**：
- 模型调用封装为统一HTTP接口,无关语言
- 文本分段用简单算法,不依赖langchain
- 向量化调用外部embedding API,不需本地模型

#### 风险3: 前端联调时间不足
**缓解措施**：
- 严格遵循已有`offline-api.js`契约
- 使用Postman/Swagger预先验证接口
- 提供Mock数据快速验证前端

### 3.3 质量保证

**代码规范**：
- 使用`golangci-lint`静态检查
- 遵循`Effective Go`最佳实践
- 接口设计遵循RESTful规范

**测试策略**：
```
├── 单元测试
│   ├── 工作流引擎(核心逻辑)
│   ├── 模型推理网关
│   └── 向量化管线
├── 集成测试
│   ├── API端到端测试
│   ├── 工作流执行测试
│   └── 数据库事务测试
└── 性能测试
    ├── 并发推理压测
    ├── 向量化吞吐量测试
    └── 内存泄漏检测
```

**监控与可观测性**：
```go
// Prometheus metrics
var (
    workflowExecutionDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "workflow_execution_duration_seconds",
            Help: "Workflow execution duration",
        },
        []string{"workflow_id", "status"},
    )
    
    llmInferenceDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "llm_inference_duration_seconds",
            Help: "LLM inference duration",
        },
        []string{"model", "status"},
    )
)

// 结构化日志
log.WithFields(log.Fields{
    "execution_id": execID,
    "node_id": nodeID,
    "duration": elapsed,
}).Info("Node execution completed")
```

## 四、关键代码示例

### 4.1 简化版工作流执行完整流程

```go
package workflow

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
)

// Node类型枚举
const (
    NodeTypeStart     = "StartNode"
    NodeTypeLLM       = "LLMNode"
    NodeTypeCode      = "CodeNode"
    NodeTypeCondition = "ConditionNode"
    NodeTypeMCP       = "MCPNode"
    NodeTypeEnd       = "EndNode"
)

// 节点接口
type NodeExecutor interface {
    Execute(ctx context.Context, node *Node, execCtx *ExecutionContext) (interface{}, error)
}

// DAG拓扑排序
func topologicalSort(wf *Workflow) ([]string, error) {
    graph := buildGraph(wf)
    inDegree := make(map[string]int)
    
    // 计算入度
    for _, node := range wf.Nodes {
        if _, exists := inDegree[node.ID]; !exists {
            inDegree[node.ID] = 0
        }
    }
    for _, edge := range wf.Edges {
        inDegree[edge.Target]++
    }
    
    // Kahn算法
    queue := []string{}
    for id, deg := range inDegree {
        if deg == 0 {
            queue = append(queue, id)
        }
    }
    
    sorted := []string{}
    for len(queue) > 0 {
        curr := queue[0]
        queue = queue[1:]
        sorted = append(sorted, curr)
        
        for _, neighbor := range graph[curr] {
            inDegree[neighbor]--
            if inDegree[neighbor] == 0 {
                queue = append(queue, neighbor)
            }
        }
    }
    
    if len(sorted) != len(wf.Nodes) {
        return nil, fmt.Errorf("cycle detected in workflow")
    }
    
    return sorted, nil
}

// 执行器工厂
func (e *WorkflowEngine) getExecutor(nodeType string) NodeExecutor {
    switch nodeType {
    case NodeTypeLLM:
        return &LLMExecutor{modelExec: e.executor}
    case NodeTypeCode:
        return &CodeExecutor{sandbox: e.sandbox}
    case NodeTypeCondition:
        return &ConditionExecutor{}
    case NodeTypeMCP:
        return &MCPExecutor{client: e.mcpClient}
    default:
        return &DefaultExecutor{}
    }
}

// LLM节点执行器
type LLMExecutor struct {
    modelExec *ModelExecutor
}

func (e *LLMExecutor) Execute(ctx context.Context, node *Node, execCtx *ExecutionContext) (interface{}, error) {
    data := node.Data
    
    // 解析变量引用
    systemPrompt := resolveVariables(data["systemPrompt"].(string), execCtx)
    userPrompt := resolveVariables(data["userPrompt"].(string), execCtx)
    
    // 调用模型
    resp, err := e.modelExec.Chat(ctx, ChatRequest{
        Model:        data["model"].(string),
        SystemPrompt: systemPrompt,
        UserPrompt:   userPrompt,
        Temperature:  data["temperature"].(float64),
    })
    if err != nil {
        return nil, err
    }
    
    return map[string]interface{}{
        "content": resp.Content,
        "tokens":  resp.Tokens,
    }, nil
}

// 变量引用解析
func resolveVariables(template string, execCtx *ExecutionContext) string {
    // 解析 ${Start.result.xxx} 语法
    re := regexp.MustCompile(`\$\{([^}]+)\}`)
    return re.ReplaceAllStringFunc(template, func(match string) string {
        path := strings.TrimPrefix(strings.TrimSuffix(match, "}"), "${")
        parts := strings.Split(path, ".")
        
        execCtx.RLock()
        defer execCtx.RUnlock()
        
        val := execCtx.Variables
        for _, part := range parts {
            if m, ok := val.(map[string]interface{}); ok {
                val = m[part]
            } else {
                return match // 保持原样
            }
        }
        
        return fmt.Sprint(val)
    })
}
```

### 4.2 HTTP接口实现示例

```go
package api

import (
    "net/http"
    "github.com/gin-gonic/gin"
    "github.com/google/uuid"
)

type WorkflowController struct {
    engine *workflow.WorkflowEngine
    db     *gorm.DB
}

// POST /api/workflow/execute
func (c *WorkflowController) Execute(ctx *gin.Context) {
    var req struct {
        WorkflowID string                 `json:"workflowId" binding:"required"`
        Input      map[string]interface{} `json:"input"`
    }
    
    if err := ctx.ShouldBindJSON(&req); err != nil {
        ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }
    
    // 查询工作流定义
    var version model.MicroAppVersion
    if err := c.db.Where("micro_app_version_id = ?", req.WorkflowID).First(&version).Error; err != nil {
        ctx.JSON(http.StatusNotFound, gin.H{"error": "workflow not found"})
        return
    }
    
    // 解析工作流JSON
    var wf workflow.Workflow
    if err := json.Unmarshal([]byte(version.Data), &wf); err != nil {
        ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid workflow data"})
        return
    }
    
    // 创建执行记录
    execID := uuid.New()
    execution := &model.WorkflowExecution{
        ID:         execID,
        WorkflowID: req.WorkflowID,
        Status:     "pending",
        Input:      req.Input,
    }
    c.db.Create(execution)
    
    // 异步执行
    go func() {
        result, err := c.engine.Execute(context.Background(), &wf, req.Input)
        
        updates := map[string]interface{}{
            "completed_at": time.Now(),
        }
        
        if err != nil {
            updates["status"] = "failed"
            updates["output"] = map[string]interface{}{"error": err.Error()}
        } else {
            updates["status"] = "success"
            updates["output"] = result.Output
            updates["node_states"] = result.NodeStates
        }
        
        c.db.Model(&model.WorkflowExecution{}).Where("id = ?", execID).Updates(updates)
    }()
    
    ctx.JSON(http.StatusOK, gin.H{
        "success": true,
        "data": gin.H{
            "executionId": execID.String(),
            "status":      "pending",
        },
    })
}

// GET /api/workflow/:id/logs
func (c *WorkflowController) GetLogs(ctx *gin.Context) {
    execID := ctx.Param("id")
    
    var execution model.WorkflowExecution
    if err := c.db.Where("id = ?", execID).First(&execution).Error; err != nil {
        ctx.JSON(http.StatusNotFound, gin.H{"error": "execution not found"})
        return
    }
    
    ctx.JSON(http.StatusOK, gin.H{
        "success": true,
        "data": gin.H{
            "status":     execution.Status,
            "nodeStates": execution.NodeStates,
            "output":     execution.Output,
            "createdAt":  execution.CreatedAt,
            "completedAt": execution.CompletedAt,
        },
    })
}
```

## 五、总结

### 5.1 核心改进点

1. **移除Temporal** - 减少70%学习成本,降低运维复杂度
2. **简化沙箱方案** - 本地开发体验友好,生产环境可选
3. **优化架构分层** - 单进程模型,调试容易
4. **保留Go优势** - 并发性能,内存占用,部署便利

### 5.2 预期收益

| 指标 | Python方案 | 原Go方案 | 改进Go方案 |
|------|-----------|---------|-----------|
| 学习曲线 | 简单 | 陡峭(Temporal) | 中等 |
| 并发性能 | 低(GIL) | 高 | 高 |
| 内存占用 | ~200MB | ~50MB | ~50MB |
| 部署复杂度 | 中(venv) | 低(单二进制) | 低 |
| 开发效率 | 高 | 中 | 高 |
| 生态完整度 | 高 | 中 | 中 |

### 5.3 下一步行动

1. **技术预研**(3天)
   - [ ] 验证DAG拓扑排序算法
   - [ ] 测试Docker沙箱隔离效果
   - [ ] 评估Qdrant Go SDK完整性

2. **原型开发**(1周)
   - [ ] 实现单个LLM节点执行
   - [ ] 实现简单串行工作流
   - [ ] 前端联调验证接口契约

3. **正式开发**(6周)
   - 按Phase 1-3拆分迭代
   - 每阶段交付可运行Demo
   - 持续集成测试

---

**文档版本**: v1.0  
**最后更新**: 2026-10-23  
**作者**: AI架构师  
**审核状态**: 待产品确认
