package workflow

import (
	"sync"
	"time"
)

// ExecutionState 执行状态
type ExecutionState string

const (
	StatePending   ExecutionState = "pending"
	StateRunning   ExecutionState = "running"
	StateSuccess   ExecutionState = "success"
	StateFailed    ExecutionState = "failed"
	StateCancelled ExecutionState = "cancelled"
)

// NodeState 节点执行状态
type NodeState struct {
	NodeID      string                 `json:"nodeId"`
	NodeType    string                 `json:"nodeType"`
	NodeTitle   string                 `json:"nodeTitle"`
	Status      ExecutionState         `json:"status"`
	StartTime   *time.Time             `json:"startTime,omitempty"`
	EndTime     *time.Time             `json:"endTime,omitempty"`
	Duration    int64                  `json:"duration,omitempty"` // 毫秒
	Result      map[string]interface{} `json:"result,omitempty"`
	ErrorMsg    string                 `json:"errorMsg,omitempty"`
}

// ExecutionContext 工作流执行上下文
// 用于存储执行过程中的所有中间状态和结果
type ExecutionContext struct {
	mu sync.RWMutex // 保护并发访问

	// 全局变量存储（节点ID -> 输出结果）
	Variables map[string]interface{} `json:"variables"`

	// 节点状态跟踪
	NodeStates map[string]*NodeState `json:"nodeStates"`

	// 整体执行状态
	State ExecutionState `json:"state"`

	// 执行时间
	StartTime time.Time  `json:"startTime"`
	EndTime   *time.Time `json:"endTime,omitempty"`

	// 错误信息
	ErrorMsg string `json:"errorMsg,omitempty"`

	// 元数据
	WorkflowID  string `json:"workflowId"`
	ExecutionID string `json:"executionId"`
}

// NewExecutionContext 创建新的执行上下文
func NewExecutionContext(workflowID, executionID string, initialInput map[string]interface{}) *ExecutionContext {
	return &ExecutionContext{
		Variables:   initialInput,
		NodeStates:  make(map[string]*NodeState),
		State:       StatePending,
		StartTime:   time.Now(),
		WorkflowID:  workflowID,
		ExecutionID: executionID,
	}
}

// Lock 获取写锁
func (ctx *ExecutionContext) Lock() {
	ctx.mu.Lock()
}

// Unlock 释放写锁
func (ctx *ExecutionContext) Unlock() {
	ctx.mu.Unlock()
}

// RLock 获取读锁
func (ctx *ExecutionContext) RLock() {
	ctx.mu.RLock()
}

// RUnlock 释放读锁
func (ctx *ExecutionContext) RUnlock() {
	ctx.mu.RUnlock()
}

// SetVariable 设置变量（线程安全）
func (ctx *ExecutionContext) SetVariable(key string, value interface{}) {
	ctx.Lock()
	defer ctx.Unlock()

	if ctx.Variables == nil {
		ctx.Variables = make(map[string]interface{})
	}
	ctx.Variables[key] = value
}

// GetVariable 获取变量（线程安全）
func (ctx *ExecutionContext) GetVariable(key string) (interface{}, bool) {
	ctx.RLock()
	defer ctx.RUnlock()

	value, exists := ctx.Variables[key]
	return value, exists
}

// GetVariablesCopy 获取变量的拷贝（用于变量解析）
func (ctx *ExecutionContext) GetVariablesCopy() map[string]interface{} {
	ctx.RLock()
	defer ctx.RUnlock()

	// 浅拷贝（对于变量解析已足够）
	copy := make(map[string]interface{}, len(ctx.Variables))
	for k, v := range ctx.Variables {
		copy[k] = v
	}
	return copy
}

// StartNode 标记节点开始执行
func (ctx *ExecutionContext) StartNode(node *Node) {
	ctx.Lock()
	defer ctx.Unlock()

	now := time.Now()
	ctx.NodeStates[node.ID] = &NodeState{
		NodeID:    node.ID,
		NodeType:  node.Type,
		NodeTitle: node.Title,
		Status:    StateRunning,
		StartTime: &now,
	}
}

// CompleteNode 标记节点执行成功
func (ctx *ExecutionContext) CompleteNode(nodeID string, result map[string]interface{}) {
	ctx.Lock()
	defer ctx.Unlock()

	if state, exists := ctx.NodeStates[nodeID]; exists {
		now := time.Now()
		state.Status = StateSuccess
		state.EndTime = &now
		state.Result = result

		if state.StartTime != nil {
			state.Duration = now.Sub(*state.StartTime).Milliseconds()
		}
	}
}

// FailNode 标记节点执行失败
func (ctx *ExecutionContext) FailNode(nodeID string, errorMsg string) {
	ctx.Lock()
	defer ctx.Unlock()

	if state, exists := ctx.NodeStates[nodeID]; exists {
		now := time.Now()
		state.Status = StateFailed
		state.EndTime = &now
		state.ErrorMsg = errorMsg

		if state.StartTime != nil {
			state.Duration = now.Sub(*state.StartTime).Milliseconds()
		}
	}
}

// SkipNode 标记节点被跳过（如条件分支中的未执行路径）
func (ctx *ExecutionContext) SkipNode(nodeID string) {
	ctx.Lock()
	defer ctx.Unlock()

	if state, exists := ctx.NodeStates[nodeID]; exists {
		state.Status = StatePending // 保持pending状态，表示未执行
	}
}

// GetNodeState 获取节点状态
func (ctx *ExecutionContext) GetNodeState(nodeID string) (*NodeState, bool) {
	ctx.RLock()
	defer ctx.RUnlock()

	state, exists := ctx.NodeStates[nodeID]
	return state, exists
}

// SetState 设置整体执行状态
func (ctx *ExecutionContext) SetState(state ExecutionState) {
	ctx.Lock()
	defer ctx.Unlock()

	ctx.State = state

	// 如果是终态，记录结束时间
	if state == StateSuccess || state == StateFailed || state == StateCancelled {
		now := time.Now()
		ctx.EndTime = &now
	}
}

// SetError 设置错误信息并标记为失败状态
func (ctx *ExecutionContext) SetError(errorMsg string) {
	ctx.Lock()
	defer ctx.Unlock()

	ctx.State = StateFailed
	ctx.ErrorMsg = errorMsg

	now := time.Now()
	ctx.EndTime = &now
}

// GetDuration 获取总执行时长（毫秒）
func (ctx *ExecutionContext) GetDuration() int64 {
	ctx.RLock()
	defer ctx.RUnlock()

	if ctx.EndTime != nil {
		return ctx.EndTime.Sub(ctx.StartTime).Milliseconds()
	}

	// 如果还在执行中，返回到目前为止的时长
	return time.Since(ctx.StartTime).Milliseconds()
}

// GetProgress 获取执行进度（已完成节点数/总节点数）
func (ctx *ExecutionContext) GetProgress() (completed int, total int) {
	ctx.RLock()
	defer ctx.RUnlock()

	total = len(ctx.NodeStates)
	for _, state := range ctx.NodeStates {
		if state.Status == StateSuccess || state.Status == StateFailed {
			completed++
		}
	}

	return completed, total
}

// ToMap 转换为map（用于序列化）
func (ctx *ExecutionContext) ToMap() map[string]interface{} {
	ctx.RLock()
	defer ctx.RUnlock()

	return map[string]interface{}{
		"executionId": ctx.ExecutionID,
		"workflowId":  ctx.WorkflowID,
		"state":       ctx.State,
		"startTime":   ctx.StartTime,
		"endTime":     ctx.EndTime,
		"duration":    ctx.GetDuration(),
		"errorMsg":    ctx.ErrorMsg,
		"variables":   ctx.Variables,
		"nodeStates":  ctx.NodeStates,
	}
}
