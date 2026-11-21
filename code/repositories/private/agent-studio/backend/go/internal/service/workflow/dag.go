package workflow

import (
	"encoding/json"
	"fmt"
)

// Node 工作流节点
type Node struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"` // StartNode/LLMNode/ConditionNode/EndNode
	Title    string                 `json:"title"`
	Data     map[string]interface{} `json:"data"`
	Position struct {
		X int `json:"x"`
		Y int `json:"y"`
	} `json:"position"`
}

// Edge 工作流边
type Edge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	Target       string `json:"target"`
	SourceHandle string `json:"sourceHandle"`
	TargetHandle string `json:"targetHandle"`
}

// Workflow 工作流定义
type Workflow struct {
	Nodes             []Node                   `json:"nodes"`
	Edges             []Edge                   `json:"edges"`
	SessionVariables  []interface{}            `json:"sessionVariables"`
	MemoryConfig      map[string]interface{}   `json:"memoryConfig"`
}

// TopologicalSort 使用Kahn算法进行拓扑排序
// 返回按执行顺序排列的节点ID列表，如果检测到环则返回错误
func TopologicalSort(wf *Workflow) ([]string, error) {
	if wf == nil {
		return nil, fmt.Errorf("workflow is nil")
	}

	if len(wf.Nodes) == 0 {
		return []string{}, nil
	}

	// 1. 构建邻接表和入度表
	graph := make(map[string][]string)
	inDegree := make(map[string]int)
	nodeExists := make(map[string]bool)

	// 初始化所有节点的入度为0
	for _, node := range wf.Nodes {
		inDegree[node.ID] = 0
		nodeExists[node.ID] = true
		graph[node.ID] = []string{}
	}

	// 构建有向图
	for _, edge := range wf.Edges {
		// 验证边的源和目标节点存在
		if !nodeExists[edge.Source] {
			return nil, fmt.Errorf("edge source node %s does not exist", edge.Source)
		}
		if !nodeExists[edge.Target] {
			return nil, fmt.Errorf("edge target node %s does not exist", edge.Target)
		}

		graph[edge.Source] = append(graph[edge.Source], edge.Target)
		inDegree[edge.Target]++
	}

	// 2. Kahn算法：将所有入度为0的节点入队
	queue := []string{}
	for id, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, id)
		}
	}

	// 如果没有入度为0的节点，说明存在环
	if len(queue) == 0 && len(wf.Nodes) > 0 {
		return nil, fmt.Errorf("cycle detected: no node with zero in-degree")
	}

	// 3. 逐层剥离节点
	sorted := []string{}
	for len(queue) > 0 {
		// 取出队首节点
		curr := queue[0]
		queue = queue[1:]
		sorted = append(sorted, curr)

		// 将当前节点的所有邻居节点的入度减1
		for _, neighbor := range graph[curr] {
			inDegree[neighbor]--
			// 如果邻居节点入度变为0，加入队列
			if inDegree[neighbor] == 0 {
				queue = append(queue, neighbor)
			}
		}
	}

	// 4. 检测环：如果排序后的节点数量小于总节点数，说明存在环
	if len(sorted) != len(wf.Nodes) {
		// 找出未被访问的节点（环中的节点）
		visited := make(map[string]bool)
		for _, id := range sorted {
			visited[id] = true
		}
		
		unvisited := []string{}
		for _, node := range wf.Nodes {
			if !visited[node.ID] {
				unvisited = append(unvisited, node.ID)
			}
		}
		
		return nil, fmt.Errorf("cycle detected in workflow, nodes in cycle: %v", unvisited)
	}

	return sorted, nil
}

// GetNodeByID 根据ID获取节点
func GetNodeByID(wf *Workflow, nodeID string) *Node {
	for i := range wf.Nodes {
		if wf.Nodes[i].ID == nodeID {
			return &wf.Nodes[i]
		}
	}
	return nil
}

// FindNodeByType 查找指定类型的第一个节点
func FindNodeByType(wf *Workflow, nodeType string) *Node {
	for i := range wf.Nodes {
		if wf.Nodes[i].Type == nodeType {
			return &wf.Nodes[i]
		}
	}
	return nil
}

// FindNodesByType 查找指定类型的所有节点
func FindNodesByType(wf *Workflow, nodeType string) []*Node {
	var nodes []*Node
	for i := range wf.Nodes {
		if wf.Nodes[i].Type == nodeType {
			nodes = append(nodes, &wf.Nodes[i])
		}
	}
	return nodes
}

// ValidateWorkflow 验证工作流基本结构
func ValidateWorkflow(wf *Workflow) error {
	if wf == nil {
		return fmt.Errorf("workflow is nil")
	}

	if len(wf.Nodes) == 0 {
		return fmt.Errorf("workflow has no nodes")
	}

	// 检查是否有StartNode
	startNodes := FindNodesByType(wf, "StartNode")
	if len(startNodes) == 0 {
		return fmt.Errorf("workflow must have at least one StartNode")
	}

	// 检查是否有EndNode
	endNodes := FindNodesByType(wf, "EndNode")
	if len(endNodes) == 0 {
		return fmt.Errorf("workflow must have at least one EndNode")
	}

	// 检查节点ID唯一性
	nodeIDs := make(map[string]bool)
	for _, node := range wf.Nodes {
		if node.ID == "" {
			return fmt.Errorf("node must have an ID")
		}
		if nodeIDs[node.ID] {
			return fmt.Errorf("duplicate node ID: %s", node.ID)
		}
		nodeIDs[node.ID] = true
	}

	return nil
}

// ParseWorkflowFromJSON 从JSON字符串解析工作流
func ParseWorkflowFromJSON(jsonStr string) (*Workflow, error) {
	var wf Workflow
	if err := json.Unmarshal([]byte(jsonStr), &wf); err != nil {
		return nil, fmt.Errorf("failed to parse workflow JSON: %w", err)
	}

	// 验证工作流结构
	if err := ValidateWorkflow(&wf); err != nil {
		return nil, fmt.Errorf("workflow validation failed: %w", err)
	}

	return &wf, nil
}
