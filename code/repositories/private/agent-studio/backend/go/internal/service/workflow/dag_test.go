package workflow

import (
	"testing"
)

func TestTopologicalSort_SimpleLinear(t *testing.T) {
	wf := &Workflow{
		Nodes: []Node{
			{ID: "Start", Type: "StartNode"},
			{ID: "A", Type: "LLMNode"},
			{ID: "End", Type: "EndNode"},
		},
		Edges: []Edge{
			{Source: "Start", Target: "A"},
			{Source: "A", Target: "End"},
		},
	}

	sorted, err := TopologicalSort(wf)
	if err != nil {
		t.Fatalf("TopologicalSort failed: %v", err)
	}

	expected := []string{"Start", "A", "End"}
	if len(sorted) != len(expected) {
		t.Fatalf("Expected %d nodes, got %d", len(expected), len(sorted))
	}

	for i, nodeID := range sorted {
		if nodeID != expected[i] {
			t.Errorf("Position %d: expected %s, got %s", i, expected[i], nodeID)
		}
	}
}

func TestTopologicalSort_DAG(t *testing.T) {
	// 测试DAG: Start -> A -> C -> End
	//                  \-> B -/
	wf := &Workflow{
		Nodes: []Node{
			{ID: "Start", Type: "StartNode"},
			{ID: "A", Type: "LLMNode"},
			{ID: "B", Type: "LLMNode"},
			{ID: "C", Type: "LLMNode"},
			{ID: "End", Type: "EndNode"},
		},
		Edges: []Edge{
			{Source: "Start", Target: "A"},
			{Source: "Start", Target: "B"},
			{Source: "A", Target: "C"},
			{Source: "B", Target: "C"},
			{Source: "C", Target: "End"},
		},
	}

	sorted, err := TopologicalSort(wf)
	if err != nil {
		t.Fatalf("TopologicalSort failed: %v", err)
	}

	if len(sorted) != 5 {
		t.Fatalf("Expected 5 nodes, got %d", len(sorted))
	}

	// 验证拓扑序约束
	positions := make(map[string]int)
	for i, nodeID := range sorted {
		positions[nodeID] = i
	}

	// Start必须在A和B之前
	if positions["Start"] >= positions["A"] || positions["Start"] >= positions["B"] {
		t.Error("Start must come before A and B")
	}

	// A和B必须在C之前
	if positions["A"] >= positions["C"] || positions["B"] >= positions["C"] {
		t.Error("A and B must come before C")
	}

	// C必须在End之前
	if positions["C"] >= positions["End"] {
		t.Error("C must come before End")
	}
}

func TestTopologicalSort_Cycle(t *testing.T) {
	// 测试环: A -> B -> C -> A
	wf := &Workflow{
		Nodes: []Node{
			{ID: "Start", Type: "StartNode"},
			{ID: "A", Type: "LLMNode"},
			{ID: "B", Type: "LLMNode"},
			{ID: "C", Type: "LLMNode"},
		},
		Edges: []Edge{
			{Source: "Start", Target: "A"},
			{Source: "A", Target: "B"},
			{Source: "B", Target: "C"},
			{Source: "C", Target: "A"}, // 形成环
		},
	}

	_, err := TopologicalSort(wf)
	if err == nil {
		t.Fatal("Expected cycle detection error, got nil")
	}

	t.Logf("Cycle detected as expected: %v", err)
}

func TestTopologicalSort_SelfLoop(t *testing.T) {
	// 测试自环: A -> A
	wf := &Workflow{
		Nodes: []Node{
			{ID: "Start", Type: "StartNode"},
			{ID: "A", Type: "LLMNode"},
		},
		Edges: []Edge{
			{Source: "Start", Target: "A"},
			{Source: "A", Target: "A"}, // 自环
		},
	}

	_, err := TopologicalSort(wf)
	if err == nil {
		t.Fatal("Expected cycle detection error for self-loop, got nil")
	}

	t.Logf("Self-loop detected as expected: %v", err)
}

func TestTopologicalSort_EmptyWorkflow(t *testing.T) {
	wf := &Workflow{
		Nodes: []Node{},
		Edges: []Edge{},
	}

	sorted, err := TopologicalSort(wf)
	if err != nil {
		t.Fatalf("Empty workflow should not error: %v", err)
	}

	if len(sorted) != 0 {
		t.Errorf("Expected empty result, got %d nodes", len(sorted))
	}
}

func TestTopologicalSort_InvalidEdge(t *testing.T) {
	// 边引用不存在的节点
	wf := &Workflow{
		Nodes: []Node{
			{ID: "Start", Type: "StartNode"},
			{ID: "A", Type: "LLMNode"},
		},
		Edges: []Edge{
			{Source: "Start", Target: "A"},
			{Source: "A", Target: "NonExistent"}, // 不存在的节点
		},
	}

	_, err := TopologicalSort(wf)
	if err == nil {
		t.Fatal("Expected error for invalid edge target, got nil")
	}

	t.Logf("Invalid edge detected as expected: %v", err)
}

func TestGetNodeByID(t *testing.T) {
	wf := &Workflow{
		Nodes: []Node{
			{ID: "Start", Type: "StartNode", Title: "开始"},
			{ID: "A", Type: "LLMNode", Title: "节点A"},
		},
	}

	node := GetNodeByID(wf, "A")
	if node == nil {
		t.Fatal("Expected to find node A, got nil")
	}

	if node.Title != "节点A" {
		t.Errorf("Expected title '节点A', got '%s'", node.Title)
	}

	node = GetNodeByID(wf, "NonExistent")
	if node != nil {
		t.Error("Expected nil for non-existent node")
	}
}

func TestFindNodeByType(t *testing.T) {
	wf := &Workflow{
		Nodes: []Node{
			{ID: "Start", Type: "StartNode"},
			{ID: "A", Type: "LLMNode"},
			{ID: "B", Type: "LLMNode"},
			{ID: "End", Type: "EndNode"},
		},
	}

	startNode := FindNodeByType(wf, "StartNode")
	if startNode == nil || startNode.ID != "Start" {
		t.Error("Failed to find StartNode")
	}

	endNode := FindNodeByType(wf, "EndNode")
	if endNode == nil || endNode.ID != "End" {
		t.Error("Failed to find EndNode")
	}

	condNode := FindNodeByType(wf, "ConditionNode")
	if condNode != nil {
		t.Error("Should not find ConditionNode")
	}
}

func TestValidateWorkflow(t *testing.T) {
	tests := []struct {
		name    string
		wf      *Workflow
		wantErr bool
	}{
		{
			name: "valid workflow",
			wf: &Workflow{
				Nodes: []Node{
					{ID: "Start", Type: "StartNode"},
					{ID: "End", Type: "EndNode"},
				},
			},
			wantErr: false,
		},
		{
			name:    "nil workflow",
			wf:      nil,
			wantErr: true,
		},
		{
			name: "no nodes",
			wf: &Workflow{
				Nodes: []Node{},
			},
			wantErr: true,
		},
		{
			name: "no start node",
			wf: &Workflow{
				Nodes: []Node{
					{ID: "End", Type: "EndNode"},
				},
			},
			wantErr: true,
		},
		{
			name: "no end node",
			wf: &Workflow{
				Nodes: []Node{
					{ID: "Start", Type: "StartNode"},
				},
			},
			wantErr: true,
		},
		{
			name: "duplicate node IDs",
			wf: &Workflow{
				Nodes: []Node{
					{ID: "A", Type: "StartNode"},
					{ID: "A", Type: "EndNode"},
				},
			},
			wantErr: true,
		},
		{
			name: "empty node ID",
			wf: &Workflow{
				Nodes: []Node{
					{ID: "", Type: "StartNode"},
					{ID: "End", Type: "EndNode"},
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateWorkflow(tt.wf)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateWorkflow() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestParseWorkflowFromJSON(t *testing.T) {
	jsonStr := `{
		"nodes": [
			{"id": "Start", "type": "StartNode", "title": "开始", "position": {"x": 0, "y": 0}, "data": {}},
			{"id": "End", "type": "EndNode", "title": "结束", "position": {"x": 100, "y": 0}, "data": {}}
		],
		"edges": [
			{"source": "Start", "target": "End"}
		],
		"sessionVariables": [],
		"memoryConfig": {}
	}`

	wf, err := ParseWorkflowFromJSON(jsonStr)
	if err != nil {
		t.Fatalf("ParseWorkflowFromJSON failed: %v", err)
	}

	if len(wf.Nodes) != 2 {
		t.Errorf("Expected 2 nodes, got %d", len(wf.Nodes))
	}

	if len(wf.Edges) != 1 {
		t.Errorf("Expected 1 edge, got %d", len(wf.Edges))
	}
}

func TestParseWorkflowFromJSON_Invalid(t *testing.T) {
	tests := []struct {
		name    string
		jsonStr string
	}{
		{
			name:    "invalid JSON",
			jsonStr: `{invalid json}`,
		},
		{
			name: "missing start node",
			jsonStr: `{
				"nodes": [{"id": "End", "type": "EndNode", "title": "结束", "position": {"x": 0, "y": 0}, "data": {}}],
				"edges": []
			}`,
		},
		{
			name: "missing end node",
			jsonStr: `{
				"nodes": [{"id": "Start", "type": "StartNode", "title": "开始", "position": {"x": 0, "y": 0}, "data": {}}],
				"edges": []
			}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseWorkflowFromJSON(tt.jsonStr)
			if err == nil {
				t.Error("Expected error, got nil")
			}
		})
	}
}
