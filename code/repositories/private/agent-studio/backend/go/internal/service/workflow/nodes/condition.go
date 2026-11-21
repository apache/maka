package nodes

import (
	"context"
	"fmt"
	"strings"
)

// ConditionExecutor 条件分支节点执行器
type ConditionExecutor struct {
	resolver *VariableResolver
}

// NewConditionExecutor 创建条件分支节点执行器
func NewConditionExecutor() *ConditionExecutor {
	return &ConditionExecutor{
		resolver: NewVariableResolver(),
	}
}

// Type 返回节点类型
func (e *ConditionExecutor) Type() string {
	return "ConditionNode"
}

// Execute 执行条件分支节点
func (e *ConditionExecutor) Execute(ctx context.Context, node *Node, execCtx ExecutionContext) (map[string]interface{}, error) {
	data := node.Data

	// 获取变量快照
	variables := execCtx.GetVariablesCopy()

	// 提取条件配置
	config, err := e.extractConfig(data)
	if err != nil {
		return nil, fmt.Errorf("failed to extract condition config: %w", err)
	}

	// 解析变量引用
	leftValue := e.resolver.Resolve(config.LeftValue, variables)
	rightValue := e.resolver.Resolve(config.RightValue, variables)

	// 评估条件
	result := e.evaluateCondition(leftValue, config.Operator, rightValue)

	// 返回结果
	return map[string]interface{}{
		"result": map[string]interface{}{
			"matched":    result,
			"leftValue":  leftValue,
			"operator":   config.Operator,
			"rightValue": rightValue,
		},
	}, nil
}

// ConditionConfig 条件节点配置
type ConditionConfig struct {
	LeftValue  string `json:"leftValue"`  // 左值（支持变量引用）
	Operator   string `json:"operator"`   // 操作符: ==, !=, >, <, >=, <=, contains, startsWith, endsWith
	RightValue string `json:"rightValue"` // 右值（支持变量引用）
}

// extractConfig 从节点数据中提取条件配置
func (e *ConditionExecutor) extractConfig(data map[string]interface{}) (*ConditionConfig, error) {
	config := &ConditionConfig{}

	// 提取leftValue
	if leftValue, ok := data["leftValue"].(string); ok {
		config.LeftValue = leftValue
	} else {
		return nil, fmt.Errorf("leftValue is required")
	}

	// 提取operator
	if operator, ok := data["operator"].(string); ok && operator != "" {
		config.Operator = operator
	} else {
		return nil, fmt.Errorf("operator is required")
	}

	// 提取rightValue
	if rightValue, ok := data["rightValue"].(string); ok {
		config.RightValue = rightValue
	} else {
		return nil, fmt.Errorf("rightValue is required")
	}

	return config, nil
}

// evaluateCondition 评估条件表达式
func (e *ConditionExecutor) evaluateCondition(left, operator, right string) bool {
	switch operator {
	case "==":
		return left == right
	case "!=":
		return left != right
	case ">":
		return left > right
	case "<":
		return left < right
	case ">=":
		return left >= right
	case "<=":
		return left <= right
	case "contains":
		return strings.Contains(left, right)
	case "startsWith":
		return strings.HasPrefix(left, right)
	case "endsWith":
		return strings.HasSuffix(left, right)
	default:
		return false
	}
}
