package workflow

import (
	"context"
	"testing"
	"time"

	"agent-studio-backend/internal/pkg/llm"
)

// MockModelExecutor 模拟模型执行器
type MockModelExecutor struct {
	responses map[string]string // model -> response
}

func NewMockModelExecutor() *MockModelExecutor {
	return &MockModelExecutor{
		responses: make(map[string]string),
	}
}

func (m *MockModelExecutor) SetResponse(model, response string) {
	m.responses[model] = response
}

func (m *MockModelExecutor) Chat(ctx context.Context, req llm.ChatRequest) (*llm.ChatResponse, error) {
	response, ok := m.responses[req.Model]
	if !ok {
		response = "这是一个模拟的LLM响应: " + req.UserPrompt
	}

	return &llm.ChatResponse{
		Content:      response,
		Tokens:       100,
		FinishReason: "stop",
	}, nil
}

func (m *MockModelExecutor) StreamChat(ctx context.Context, req llm.ChatRequest) (<-chan llm.StreamChunk, error) {
	ch := make(chan llm.StreamChunk)
	go func() {
		defer close(ch)
		response, _ := m.Chat(ctx, req)
		ch <- llm.StreamChunk{Content: response.Content, Done: false}
		ch <- llm.StreamChunk{Done: true}
	}()
	return ch, nil
}

// TestWorkflowEngine_SimpleLinear 测试简单的线性工作流
func TestWorkflowEngine_SimpleLinear(t *testing.T) {
	// 创建模拟执行器
	mockExec := NewMockModelExecutor()
	mockExec.SetResponse("test-model", "分析结果: 顾客年龄约30岁")

	// 创建引擎
	engine := NewWorkflowEngine(mockExec)

	// 构造简单的工作流: Start -> LLM -> End
	wf := &Workflow{
		Nodes: []Node{
			{
				ID:    "start",
				Type:  "StartNode",
				Title: "开始",
				Data:  map[string]interface{}{},
			},
			{
				ID:    "llm1",
				Type:  "LLMNode",
				Title: "分析顾客信息",
				Data: map[string]interface{}{
					"model":        "test-model",
					"systemPrompt": "你是一个顾客信息分析助手",
					"userPrompt":   "请分析: ${start.result.message}",
					"temperature":  0.7,
					"maxTokens":    2000.0,
					"outputType":   "Text",
				},
			},
			{
				ID:    "end",
				Type:  "EndNode",
				Title: "结束",
				Data: map[string]interface{}{
					"outputParams": []interface{}{
						map[string]interface{}{
							"key":   "result",
							"value": "${llm1.result.content}",
						},
					},
					"outputType": "JSON",
				},
			},
		},
		Edges: []Edge{
			{ID: "e1", Source: "start", Target: "llm1"},
			{ID: "e2", Source: "llm1", Target: "end"},
		},
	}

	// 执行工作流
	input := map[string]interface{}{
		"message": "顾客说她有两个孩子,大的上小学了",
	}

	result, err := engine.Execute(context.Background(), wf, "test-wf", "test-exec", input)

	// 验证结果
	if err != nil {
		t.Fatalf("Workflow execution failed: %v", err)
	}

	if result.State != StateSuccess {
		t.Errorf("Expected state %s, got %s", StateSuccess, result.State)
	}

	if result.Output == nil {
		t.Fatal("Output is nil")
	}

	// 验证输出（outputType=JSON且只有一个字段时，直接返回字符串）
	resultStr, ok := result.Output.(string)
	if !ok {
		t.Fatalf("Output is not a string: %T (value: %v)", result.Output, result.Output)
	}

	if resultStr == "" {
		t.Error("result is empty")
	}

	t.Logf("Output: %+v", result.Output)
	t.Logf("Duration: %d ms", result.Duration)

	// 验证节点状态（只有start和llm1会有状态，end节点不执行）
	if len(result.NodeStates) != 2 {
		t.Errorf("Expected 2 node states, got %d", len(result.NodeStates))
	}

	// 检查每个节点的状态
	for nodeID, state := range result.NodeStates {
		if state.Status != StateSuccess {
			t.Errorf("Node %s: expected status %s, got %s", nodeID, StateSuccess, state.Status)
		}
		t.Logf("Node %s: status=%s, duration=%dms", nodeID, state.Status, state.Duration)
	}
}

// TestWorkflowEngine_WithCondition 测试带条件分支的工作流
func TestWorkflowEngine_WithCondition(t *testing.T) {
	mockExec := NewMockModelExecutor()
	mockExec.SetResponse("test-model", "女")

	engine := NewWorkflowEngine(mockExec)

	// 工作流: Start -> LLM(判断性别) -> Condition(性别==女) -> End
	wf := &Workflow{
		Nodes: []Node{
			{
				ID:    "start",
				Type:  "StartNode",
				Title: "开始",
				Data:  map[string]interface{}{},
			},
			{
				ID:    "llm1",
				Type:  "LLMNode",
				Title: "判断性别",
				Data: map[string]interface{}{
					"model":        "test-model",
					"systemPrompt": "根据描述判断性别，只回答：男 或 女",
					"userPrompt":   "${start.result.message}",
					"outputType":   "Text",
				},
			},
			{
				ID:    "cond1",
				Type:  "ConditionNode",
				Title: "判断是否为女性",
				Data: map[string]interface{}{
					"leftValue":  "${llm1.result.content}",
					"operator":   "==",
					"rightValue": "女",
				},
			},
			{
				ID:    "end",
				Type:  "EndNode",
				Title: "结束",
				Data: map[string]interface{}{
					"outputParams": []interface{}{
						map[string]interface{}{
							"key":   "gender",
							"value": "${llm1.result.content}",
						},
						map[string]interface{}{
							"key":   "isFemale",
							"value": "${cond1.result.matched}",
						},
					},
				},
			},
		},
		Edges: []Edge{
			{ID: "e1", Source: "start", Target: "llm1"},
			{ID: "e2", Source: "llm1", Target: "cond1"},
			{ID: "e3", Source: "cond1", Target: "end"},
		},
	}

	input := map[string]interface{}{
		"message": "她是两个孩子的妈妈",
	}

	result, err := engine.Execute(context.Background(), wf, "test-wf", "test-exec", input)

	if err != nil {
		t.Fatalf("Workflow execution failed: %v", err)
	}

	if result.State != StateSuccess {
		t.Errorf("Expected state %s, got %s", StateSuccess, result.State)
	}

	t.Logf("Output: %+v", result.Output)
	t.Logf("Duration: %d ms", result.Duration)

	// 验证条件节点执行成功
	condState, exists := result.NodeStates["cond1"]
	if !exists {
		t.Fatal("Condition node state not found")
	}
	if condState.Status != StateSuccess {
		t.Errorf("Condition node failed: %s", condState.ErrorMsg)
	}

	t.Logf("Condition result: %+v", condState.Result)
}

// TestWorkflowEngine_InvalidWorkflow 测试无效工作流
func TestWorkflowEngine_InvalidWorkflow(t *testing.T) {
	mockExec := NewMockModelExecutor()
	engine := NewWorkflowEngine(mockExec)

	tests := []struct {
		name    string
		wf      *Workflow
		wantErr bool
	}{
		{
			name: "missing StartNode",
			wf: &Workflow{
				Nodes: []Node{
					{ID: "end", Type: "EndNode"},
				},
			},
			wantErr: true,
		},
		{
			name: "missing EndNode",
			wf: &Workflow{
				Nodes: []Node{
					{ID: "start", Type: "StartNode"},
				},
			},
			wantErr: true,
		},
		{
			name: "cycle in graph",
			wf: &Workflow{
				Nodes: []Node{
					{ID: "start", Type: "StartNode"},
					{ID: "a", Type: "LLMNode", Data: map[string]interface{}{"model": "test"}},
					{ID: "b", Type: "LLMNode", Data: map[string]interface{}{"model": "test"}},
					{ID: "end", Type: "EndNode"},
				},
				Edges: []Edge{
					{ID: "e1", Source: "start", Target: "a"},
					{ID: "e2", Source: "a", Target: "b"},
					{ID: "e3", Source: "b", Target: "a"}, // 环
					{ID: "e4", Source: "b", Target: "end"},
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := engine.Execute(context.Background(), tt.wf, "test-wf", "test-exec", nil)
			if (err != nil) != tt.wantErr {
				t.Errorf("Execute() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// TestWorkflowEngine_ExecutionTimeout 测试执行超时
func TestWorkflowEngine_ExecutionTimeout(t *testing.T) {
	// 创建一个会超时的模拟执行器
	slowExec := &SlowModelExecutor{delay: 10 * time.Second}
	engine := NewWorkflowEngine(slowExec)

	wf := &Workflow{
		Nodes: []Node{
			{ID: "start", Type: "StartNode"},
			{
				ID:   "llm1",
				Type: "LLMNode",
				Data: map[string]interface{}{
					"model":      "test-model",
					"userPrompt": "test",
				},
			},
			{ID: "end", Type: "EndNode"},
		},
		Edges: []Edge{
			{ID: "e1", Source: "start", Target: "llm1"},
			{ID: "e2", Source: "llm1", Target: "end"},
		},
	}

	// 设置较短的超时
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	_, err := engine.Execute(ctx, wf, "test-wf", "test-exec", nil)

	if err == nil {
		t.Error("Expected timeout error, got nil")
	}

	t.Logf("Got expected error: %v", err)
}

// SlowModelExecutor 模拟慢速执行器
type SlowModelExecutor struct {
	delay time.Duration
}

func (s *SlowModelExecutor) Chat(ctx context.Context, req llm.ChatRequest) (*llm.ChatResponse, error) {
	select {
	case <-time.After(s.delay):
		return &llm.ChatResponse{Content: "slow response"}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *SlowModelExecutor) StreamChat(ctx context.Context, req llm.ChatRequest) (<-chan llm.StreamChunk, error) {
	ch := make(chan llm.StreamChunk)
	go func() {
		defer close(ch)
		<-time.After(s.delay)
		ch <- llm.StreamChunk{Content: "slow", Done: true}
	}()
	return ch, nil
}

// BenchmarkWorkflowEngine 性能基准测试
func BenchmarkWorkflowEngine(b *testing.B) {
	mockExec := NewMockModelExecutor()
	mockExec.SetResponse("test-model", "测试响应")

	engine := NewWorkflowEngine(mockExec)

	wf := &Workflow{
		Nodes: []Node{
			{ID: "start", Type: "StartNode"},
			{
				ID:   "llm1",
				Type: "LLMNode",
				Data: map[string]interface{}{
					"model":      "test-model",
					"userPrompt": "测试 ${start.result.msg}",
				},
			},
			{
				ID:   "end",
				Type: "EndNode",
				Data: map[string]interface{}{
					"outputParams": []interface{}{
						map[string]interface{}{
							"key":   "result",
							"value": "${llm1.result.content}",
						},
					},
				},
			},
		},
		Edges: []Edge{
			{ID: "e1", Source: "start", Target: "llm1"},
			{ID: "e2", Source: "llm1", Target: "end"},
		},
	}

	input := map[string]interface{}{"msg": "hello"}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		execID := "bench-" + string(rune(i))
		_, err := engine.Execute(context.Background(), wf, "bench-wf", execID, input)
		if err != nil {
			b.Fatalf("Execution failed: %v", err)
		}
	}
}
