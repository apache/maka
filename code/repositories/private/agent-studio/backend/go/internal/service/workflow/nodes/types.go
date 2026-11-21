package nodes

import (
	"context"
)

// Node 工作流节点（避免循环导入，复制核心定义）
type Node struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"`
	Title    string                 `json:"title"`
	Data     map[string]interface{} `json:"data"`
	Position struct {
		X int `json:"x"`
		Y int `json:"y"`
	} `json:"position"`
}

// ExecutionContext 执行上下文接口（避免循环导入）
type ExecutionContext interface {
	GetVariablesCopy() map[string]interface{}
	SetVariable(key string, value interface{})
	GetVariable(key string) (interface{}, bool)
}

// NodeExecutor 节点执行器接口
type NodeExecutor interface {
	// Execute 执行节点
	// 返回节点的输出结果（将被存入execCtx.Variables[nodeID]）
	Execute(ctx context.Context, node *Node, execCtx ExecutionContext) (map[string]interface{}, error)
	
	// Type 返回节点类型
	Type() string
}

// ExecutorFactory 节点执行器工厂
type ExecutorFactory struct {
	executors map[string]NodeExecutor
}

// NewExecutorFactory 创建执行器工厂
func NewExecutorFactory() *ExecutorFactory {
	return &ExecutorFactory{
		executors: make(map[string]NodeExecutor),
	}
}

// Register 注册节点执行器
func (f *ExecutorFactory) Register(executor NodeExecutor) {
	f.executors[executor.Type()] = executor
}

// Get 获取节点执行器
func (f *ExecutorFactory) Get(nodeType string) (NodeExecutor, bool) {
	executor, exists := f.executors[nodeType]
	return executor, exists
}
