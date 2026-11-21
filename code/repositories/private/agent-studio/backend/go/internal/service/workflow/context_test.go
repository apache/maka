package workflow

import (
	"testing"
	"time"
)

func TestNewExecutionContext(t *testing.T) {
	input := map[string]interface{}{
		"key1": "value1",
		"key2": 123,
	}

	ctx := NewExecutionContext("wf-123", "exec-456", input)

	if ctx.WorkflowID != "wf-123" {
		t.Errorf("Expected workflowId 'wf-123', got '%s'", ctx.WorkflowID)
	}

	if ctx.ExecutionID != "exec-456" {
		t.Errorf("Expected executionId 'exec-456', got '%s'", ctx.ExecutionID)
	}

	if ctx.State != StatePending {
		t.Errorf("Expected state 'pending', got '%s'", ctx.State)
	}

	if len(ctx.Variables) != 2 {
		t.Errorf("Expected 2 variables, got %d", len(ctx.Variables))
	}

	if ctx.Variables["key1"] != "value1" {
		t.Error("Initial variables not set correctly")
	}
}

func TestExecutionContext_SetGetVariable(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", nil)

	// 设置变量
	ctx.SetVariable("node1", map[string]interface{}{
		"output": "result1",
	})

	ctx.SetVariable("node2", map[string]interface{}{
		"output": "result2",
	})

	// 获取变量
	value1, exists1 := ctx.GetVariable("node1")
	if !exists1 {
		t.Fatal("node1 variable should exist")
	}

	node1Map, ok := value1.(map[string]interface{})
	if !ok {
		t.Fatal("node1 should be a map")
	}

	if node1Map["output"] != "result1" {
		t.Error("node1 output incorrect")
	}

	// 获取不存在的变量
	_, exists := ctx.GetVariable("nonexistent")
	if exists {
		t.Error("Nonexistent variable should not exist")
	}
}

func TestExecutionContext_NodeLifecycle(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", nil)

	node := &Node{
		ID:    "test-node",
		Type:  "LLMNode",
		Title: "测试节点",
	}

	// 开始节点
	ctx.StartNode(node)

	state, exists := ctx.GetNodeState("test-node")
	if !exists {
		t.Fatal("Node state should exist after StartNode")
	}

	if state.Status != StateRunning {
		t.Errorf("Expected status 'running', got '%s'", state.Status)
	}

	if state.StartTime == nil {
		t.Error("StartTime should be set")
	}

	// 模拟执行时间
	time.Sleep(10 * time.Millisecond)

	// 完成节点
	result := map[string]interface{}{
		"output": "success",
	}
	ctx.CompleteNode("test-node", result)

	state, _ = ctx.GetNodeState("test-node")
	if state.Status != StateSuccess {
		t.Errorf("Expected status 'success', got '%s'", state.Status)
	}

	if state.EndTime == nil {
		t.Error("EndTime should be set")
	}

	if state.Duration == 0 {
		t.Error("Duration should be greater than 0")
	}

	if state.Result["output"] != "success" {
		t.Error("Result not set correctly")
	}
}

func TestExecutionContext_FailNode(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", nil)

	node := &Node{
		ID:    "fail-node",
		Type:  "LLMNode",
		Title: "失败节点",
	}

	ctx.StartNode(node)
	time.Sleep(5 * time.Millisecond)

	errorMsg := "模型调用失败"
	ctx.FailNode("fail-node", errorMsg)

	state, _ := ctx.GetNodeState("fail-node")
	if state.Status != StateFailed {
		t.Errorf("Expected status 'failed', got '%s'", state.Status)
	}

	if state.ErrorMsg != errorMsg {
		t.Errorf("Expected error message '%s', got '%s'", errorMsg, state.ErrorMsg)
	}

	if state.Duration == 0 {
		t.Error("Duration should be greater than 0")
	}
}

func TestExecutionContext_SetState(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", nil)

	// 设置为运行中
	ctx.SetState(StateRunning)
	if ctx.State != StateRunning {
		t.Errorf("Expected state 'running', got '%s'", ctx.State)
	}
	if ctx.EndTime != nil {
		t.Error("EndTime should be nil for running state")
	}

	// 设置为成功
	ctx.SetState(StateSuccess)
	if ctx.State != StateSuccess {
		t.Errorf("Expected state 'success', got '%s'", ctx.State)
	}
	if ctx.EndTime == nil {
		t.Error("EndTime should be set for terminal state")
	}
}

func TestExecutionContext_SetError(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", nil)

	errorMsg := "工作流执行失败"
	ctx.SetError(errorMsg)

	if ctx.State != StateFailed {
		t.Errorf("Expected state 'failed', got '%s'", ctx.State)
	}

	if ctx.ErrorMsg != errorMsg {
		t.Errorf("Expected error message '%s', got '%s'", errorMsg, ctx.ErrorMsg)
	}

	if ctx.EndTime == nil {
		t.Error("EndTime should be set after SetError")
	}
}

func TestExecutionContext_GetProgress(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", nil)

	nodes := []*Node{
		{ID: "node1", Type: "StartNode", Title: "开始"},
		{ID: "node2", Type: "LLMNode", Title: "节点2"},
		{ID: "node3", Type: "LLMNode", Title: "节点3"},
		{ID: "node4", Type: "EndNode", Title: "结束"},
	}

	// 初始化所有节点
	for _, node := range nodes {
		ctx.StartNode(node)
	}

	// 完成2个节点
	ctx.CompleteNode("node1", nil)
	ctx.CompleteNode("node2", nil)

	// 1个节点失败
	ctx.FailNode("node3", "error")

	completed, total := ctx.GetProgress()

	if total != 4 {
		t.Errorf("Expected total 4, got %d", total)
	}

	if completed != 3 {
		t.Errorf("Expected completed 3, got %d", completed)
	}
}

func TestExecutionContext_GetDuration(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", nil)

	// 运行中的时长
	time.Sleep(10 * time.Millisecond)
	duration1 := ctx.GetDuration()

	if duration1 < 10 {
		t.Errorf("Expected duration >= 10ms, got %dms", duration1)
	}

	// 完成后的时长
	ctx.SetState(StateSuccess)
	duration2 := ctx.GetDuration()

	// duration2应该接近duration1（可能略大）
	if duration2 < duration1 {
		t.Error("Duration after completion should be >= duration during execution")
	}

	// 再等一会，duration应该保持不变（因为已结束）
	time.Sleep(5 * time.Millisecond)
	duration3 := ctx.GetDuration()

	if duration3 != duration2 {
		t.Errorf("Duration should not change after completion: %d vs %d", duration2, duration3)
	}
}

func TestExecutionContext_GetVariablesCopy(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", map[string]interface{}{
		"key1": "value1",
	})

	// 获取拷贝
	copy := ctx.GetVariablesCopy()

	// 修改拷贝
	copy["key2"] = "value2"

	// 原始变量不应该被修改
	if _, exists := ctx.Variables["key2"]; exists {
		t.Error("Modifying copy should not affect original variables")
	}

	if len(ctx.Variables) != 1 {
		t.Errorf("Expected 1 variable in original, got %d", len(ctx.Variables))
	}
}

func TestExecutionContext_ToMap(t *testing.T) {
	input := map[string]interface{}{
		"input1": "value1",
	}

	ctx := NewExecutionContext("wf-123", "exec-456", input)

	node := &Node{
		ID:    "test-node",
		Type:  "LLMNode",
		Title: "测试",
	}

	ctx.StartNode(node)
	ctx.CompleteNode("test-node", map[string]interface{}{"output": "result"})
	ctx.SetState(StateSuccess)

	result := ctx.ToMap()

	if result["executionId"] != "exec-456" {
		t.Error("executionId not set in map")
	}

	if result["workflowId"] != "wf-123" {
		t.Error("workflowId not set in map")
	}

	if result["state"] != StateSuccess {
		t.Error("state not set in map")
	}

	variables, ok := result["variables"].(map[string]interface{})
	if !ok || len(variables) != 1 {
		t.Error("variables not set correctly in map")
	}

	nodeStates, ok := result["nodeStates"].(map[string]*NodeState)
	if !ok || len(nodeStates) != 1 {
		t.Error("nodeStates not set correctly in map")
	}
}

func TestExecutionContext_ConcurrentAccess(t *testing.T) {
	ctx := NewExecutionContext("wf-1", "exec-1", nil)

	// 并发设置变量
	done := make(chan bool, 10)

	for i := 0; i < 10; i++ {
		go func(index int) {
			for j := 0; j < 100; j++ {
				ctx.SetVariable("key", index*100+j)
			}
			done <- true
		}(i)
	}

	// 并发读取变量
	for i := 0; i < 10; i++ {
		go func() {
			for j := 0; j < 100; j++ {
				ctx.GetVariable("key")
			}
			done <- true
		}()
	}

	// 等待所有goroutine完成
	for i := 0; i < 20; i++ {
		<-done
	}

	// 测试应该不会panic（数据竞争会被Go的race detector检测到）
	t.Log("Concurrent access test passed")
}
