package workflow

import (
	"context"
	"fmt"
	"time"

	"agent-studio-backend/internal/pkg/llm"
	"agent-studio-backend/internal/service/workflow/nodes"
)

// WorkflowEngine 工作流执行引擎
type WorkflowEngine struct {
	executorFactory *nodes.ExecutorFactory
	resolver        *VariableResolver
}

// NewWorkflowEngine 创建工作流引擎
func NewWorkflowEngine(modelExec llm.ModelExecutor) *WorkflowEngine {
	factory := nodes.NewExecutorFactory()
	
	// 注册节点执行器
	factory.Register(nodes.NewLLMExecutor(modelExec))
	factory.Register(nodes.NewConditionExecutor())

	return &WorkflowEngine{
		executorFactory: factory,
		resolver:        NewVariableResolver(),
	}
}

// ExecutionResult 执行结果
type ExecutionResult struct {
	Output      interface{}            `json:"output"`
	State       ExecutionState         `json:"state"`
	Duration    int64                  `json:"duration"` // 毫秒
	NodeStates  map[string]*NodeState  `json:"nodeStates"`
	ErrorMsg    string                 `json:"errorMsg,omitempty"`
	Variables   map[string]interface{} `json:"variables"`
}

// Execute 执行工作流
func (e *WorkflowEngine) Execute(ctx context.Context, wf *Workflow, workflowID, executionID string, input map[string]interface{}) (*ExecutionResult, error) {
	// 1. 验证工作流
	if err := ValidateWorkflow(wf); err != nil {
		return nil, fmt.Errorf("workflow validation failed: %w", err)
	}

	// 2. 拓扑排序
	sorted, err := TopologicalSort(wf)
	if err != nil {
		return nil, fmt.Errorf("topological sort failed: %w", err)
	}

	// 3. 初始化执行上下文
	execCtx := NewExecutionContext(workflowID, executionID, input)
	execCtx.SetState(StateRunning)

	// 4. 按拓扑序执行节点
	for _, nodeID := range sorted {
		// 检查上下文是否被取消
		select {
		case <-ctx.Done():
			execCtx.SetError("execution cancelled")
			return e.buildResult(execCtx), ctx.Err()
		default:
		}

		node := GetNodeByID(wf, nodeID)
		if node == nil {
			execCtx.SetError(fmt.Sprintf("node %s not found", nodeID))
			return e.buildResult(execCtx), fmt.Errorf("node %s not found", nodeID)
		}

		// 执行节点
		if err := e.executeNode(ctx, node, execCtx); err != nil {
			execCtx.SetError(fmt.Sprintf("node %s failed: %v", nodeID, err))
			return e.buildResult(execCtx), fmt.Errorf("node %s execution failed: %w", nodeID, err)
		}
	}

	// 5. 提取EndNode输出
	output := e.extractOutput(wf, execCtx)

	// 6. 标记执行成功
	execCtx.SetState(StateSuccess)

	return e.buildResult(execCtx, output), nil
}

// executeNode 执行单个节点
func (e *WorkflowEngine) executeNode(ctx context.Context, node *Node, execCtx *ExecutionContext) error {
	// StartNode和EndNode仅占位，不执行
	if node.Type == "StartNode" {
		return e.executeStartNode(node, execCtx)
	}

	if node.Type == "EndNode" {
		return nil // EndNode不执行，只在最后提取输出
	}

	// 标记节点开始
	execCtx.StartNode(node)

	// 获取节点执行器
	executor, exists := e.executorFactory.Get(node.Type)
	if !exists {
		execCtx.FailNode(node.ID, fmt.Sprintf("no executor for node type: %s", node.Type))
		return fmt.Errorf("no executor for node type: %s", node.Type)
	}

	// 设置超时（5分钟）
	execTimeout := 5 * time.Minute
	timeoutCtx, cancel := context.WithTimeout(ctx, execTimeout)
	defer cancel()

	// 将workflow.Node转换为nodes.Node（避免循环导入）
	nodeForExec := &nodes.Node{
		ID:    node.ID,
		Type:  node.Type,
		Title: node.Title,
		Data:  node.Data,
	}
	nodeForExec.Position.X = node.Position.X
	nodeForExec.Position.Y = node.Position.Y

	// 执行节点
	result, err := executor.Execute(timeoutCtx, nodeForExec, execCtx)
	if err != nil {
		execCtx.FailNode(node.ID, err.Error())
		return err
	}

	// 保存节点输出到变量
	execCtx.SetVariable(node.ID, result)

	// 标记节点完成
	execCtx.CompleteNode(node.ID, result)

	return nil
}

// executeStartNode 执行开始节点（特殊处理）
func (e *WorkflowEngine) executeStartNode(node *Node, execCtx *ExecutionContext) error {
	execCtx.StartNode(node)

	// StartNode输出用户输入
	result := map[string]interface{}{
		"result": execCtx.GetVariablesCopy(),
	}

	execCtx.SetVariable(node.ID, result)
	execCtx.CompleteNode(node.ID, result)

	return nil
}

// extractOutput 从EndNode提取输出
func (e *WorkflowEngine) extractOutput(wf *Workflow, execCtx *ExecutionContext) interface{} {
	endNode := FindNodeByType(wf, "EndNode")
	if endNode == nil {
		return nil
	}

	data := endNode.Data

	// 检查输出配置
	outputParams, ok := data["outputParams"].([]interface{})
	if !ok || len(outputParams) == 0 {
		return nil
	}

	variables := execCtx.GetVariablesCopy()
	output := make(map[string]interface{})

	// 解析每个输出参数
	for _, param := range outputParams {
		paramMap, ok := param.(map[string]interface{})
		if !ok {
			continue
		}

		key, _ := paramMap["key"].(string)
		value, _ := paramMap["value"].(string)

		if key == "" {
			continue
		}

		// 解析变量引用
		resolvedValue := e.resolver.Resolve(value, variables)
		output[key] = resolvedValue
	}

	// 如果配置了outputType为JSON，返回解析后的对象
	if outputType, ok := data["outputType"].(string); ok && outputType == "JSON" {
		// 对于单个输出值，直接返回解析结果
		if len(output) == 1 {
			for _, v := range output {
				return v
			}
		}
	}

	return output
}

// buildResult 构建执行结果
func (e *WorkflowEngine) buildResult(execCtx *ExecutionContext, output ...interface{}) *ExecutionResult {
	var finalOutput interface{}
	if len(output) > 0 {
		finalOutput = output[0]
	}

	execCtx.RLock()
	defer execCtx.RUnlock()

	return &ExecutionResult{
		Output:     finalOutput,
		State:      execCtx.State,
		Duration:   execCtx.GetDuration(),
		NodeStates: execCtx.NodeStates,
		ErrorMsg:   execCtx.ErrorMsg,
		Variables:  execCtx.Variables,
	}
}
