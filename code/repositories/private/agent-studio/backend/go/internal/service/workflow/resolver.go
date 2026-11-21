package workflow

import (
	"fmt"
	"regexp"
	"strings"
)

// VariableResolver 变量引用解析器
type VariableResolver struct {
	// 变量引用的正则表达式: ${node.path.to.field}
	varPattern *regexp.Regexp
}

// NewVariableResolver 创建变量解析器
func NewVariableResolver() *VariableResolver {
	return &VariableResolver{
		varPattern: regexp.MustCompile(`\$\{([^}]+)\}`),
	}
}

// Resolve 解析模板字符串中的变量引用
// 模板格式: "文本 ${Start.result.field} 更多文本 ${Node2.output}"
// execCtx: 执行上下文，包含所有节点的输出结果
func (r *VariableResolver) Resolve(template string, variables map[string]interface{}) string {
	return r.varPattern.ReplaceAllStringFunc(template, func(match string) string {
		// 提取变量路径: ${Start.result.field} -> Start.result.field
		path := strings.Trim(match, "${}")
		
		// 根据路径查找值
		value, err := r.getValueByPath(path, variables)
		if err != nil {
			// 无法解析时保持原样
			return match
		}
		
		return fmt.Sprint(value)
	})
}

// getValueByPath 根据点分隔的路径获取嵌套值
// 例如: "Start.result.extractionRules" -> variables["Start"]["result"]["extractionRules"]
func (r *VariableResolver) getValueByPath(path string, variables map[string]interface{}) (interface{}, error) {
	parts := strings.Split(path, ".")
	if len(parts) == 0 {
		return nil, fmt.Errorf("empty path")
	}

	var current interface{} = variables

	for i, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, fmt.Errorf("empty path segment at position %d", i)
		}

		// 尝试将当前值转换为map
		currentMap, ok := current.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("path segment %s: expected map, got %T", part, current)
		}

		// 获取下一层级的值
		next, exists := currentMap[part]
		if !exists {
			return nil, fmt.Errorf("path segment %s: key not found", part)
		}

		current = next
	}

	return current, nil
}

// ExtractVariableReferences 提取模板中所有的变量引用
// 返回去重后的变量路径列表
func (r *VariableResolver) ExtractVariableReferences(template string) []string {
	matches := r.varPattern.FindAllStringSubmatch(template, -1)
	
	// 使用map去重
	pathSet := make(map[string]bool)
	for _, match := range matches {
		if len(match) > 1 {
			path := strings.Trim(match[1], " ")
			pathSet[path] = true
		}
	}

	// 转为切片
	paths := make([]string, 0, len(pathSet))
	for path := range pathSet {
		paths = append(paths, path)
	}

	return paths
}

// ValidateVariableReferences 验证模板中的所有变量引用是否可以解析
// 返回第一个无法解析的变量路径和错误
func (r *VariableResolver) ValidateVariableReferences(template string, variables map[string]interface{}) (string, error) {
	refs := r.ExtractVariableReferences(template)
	
	for _, ref := range refs {
		_, err := r.getValueByPath(ref, variables)
		if err != nil {
			return ref, fmt.Errorf("variable reference ${%s}: %w", ref, err)
		}
	}

	return "", nil
}

// ResolveMap 解析map中所有字符串值的变量引用
// 递归处理嵌套的map和slice
func (r *VariableResolver) ResolveMap(data map[string]interface{}, variables map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{})

	for key, value := range data {
		result[key] = r.resolveValue(value, variables)
	}

	return result
}

// resolveValue 解析单个值（支持string、map、slice递归处理）
func (r *VariableResolver) resolveValue(value interface{}, variables map[string]interface{}) interface{} {
	switch v := value.(type) {
	case string:
		// 字符串：解析变量引用
		return r.Resolve(v, variables)
	
	case map[string]interface{}:
		// 嵌套map：递归解析
		return r.ResolveMap(v, variables)
	
	case []interface{}:
		// 数组：递归解析每个元素
		result := make([]interface{}, len(v))
		for i, item := range v {
			result[i] = r.resolveValue(item, variables)
		}
		return result
	
	default:
		// 其他类型（数字、布尔等）：原样返回
		return value
	}
}
