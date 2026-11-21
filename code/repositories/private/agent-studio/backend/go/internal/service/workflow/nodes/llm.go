package nodes

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"agent-studio-backend/internal/pkg/llm"
)

// LLMExecutor LLM节点执行器
type LLMExecutor struct {
	modelExec llm.ModelExecutor
	resolver  *VariableResolver
}

// NewLLMExecutor 创建LLM节点执行器
func NewLLMExecutor(modelExec llm.ModelExecutor) *LLMExecutor {
	return &LLMExecutor{
		modelExec: modelExec,
		resolver:  NewVariableResolver(),
	}
}

// Type 返回节点类型
func (e *LLMExecutor) Type() string {
	return "LLMNode"
}

// Execute 执行LLM节点
func (e *LLMExecutor) Execute(ctx context.Context, node *Node, execCtx ExecutionContext) (map[string]interface{}, error) {
	data := node.Data

	// 获取当前变量快照（用于变量解析）
	variables := execCtx.GetVariablesCopy()

	// 提取LLM节点配置
	config, err := e.extractConfig(data)
	if err != nil {
		return nil, fmt.Errorf("failed to extract LLM config: %w", err)
	}

	// 解析systemPrompt中的变量引用
	systemPrompt := e.resolver.Resolve(config.SystemPrompt, variables)

	// 解析userPrompt中的变量引用
	userPrompt := e.resolver.Resolve(config.UserPrompt, variables)

	// 构造聊天请求
	req := llm.ChatRequest{
		Model:        config.Model,
		SystemPrompt: systemPrompt,
		UserPrompt:   userPrompt,
		Temperature:  config.Temperature,
		MaxTokens:    config.MaxTokens,
	}

	// 调用模型
	resp, err := e.modelExec.Chat(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("model execution failed: %w", err)
	}

	// 构造节点输出
	result := map[string]interface{}{
		"result": map[string]interface{}{
			"content":      resp.Content,
			"tokens":       resp.Tokens,
			"finishReason": resp.FinishReason,
		},
	}

	// 如果配置了输出类型为JSON，尝试解析
	if config.OutputType == "JSON" {
		var jsonOutput interface{}
		if err := json.Unmarshal([]byte(resp.Content), &jsonOutput); err == nil {
			result["result"].(map[string]interface{})["jsonOutput"] = jsonOutput
		}
		// 解析失败不报错，保留原始content
	}

	return result, nil
}

// LLMConfig LLM节点配置
type LLMConfig struct {
	Model        string  `json:"model"`
	SystemPrompt string  `json:"systemPrompt"`
	UserPrompt   string  `json:"userPrompt"`
	Temperature  float64 `json:"temperature"`
	MaxTokens    int     `json:"maxTokens"`
	OutputType   string  `json:"outputType"` // Text/JSON
}

// extractConfig 从节点数据中提取LLM配置
func (e *LLMExecutor) extractConfig(data map[string]interface{}) (*LLMConfig, error) {
	config := &LLMConfig{
		Temperature: 0.7,    // 默认值
		MaxTokens:   2000,   // 默认值
		OutputType:  "Text", // 默认值
	}

	// 提取model
	if model, ok := data["model"].(string); ok && model != "" {
		config.Model = model
	} else {
		return nil, fmt.Errorf("model is required")
	}

	// 提取systemPrompt
	if systemPrompt, ok := data["systemPrompt"].(string); ok {
		config.SystemPrompt = systemPrompt
	}

	// 提取userPrompt
	if userPrompt, ok := data["userPrompt"].(string); ok {
		config.UserPrompt = userPrompt
	}

	// 提取temperature
	if temp, ok := data["temperature"].(float64); ok {
		config.Temperature = temp
	}

	// 提取maxTokens
	if maxTokens, ok := data["maxTokens"].(float64); ok {
		config.MaxTokens = int(maxTokens)
	}

	// 提取outputType
	if outputType, ok := data["outputType"].(string); ok && outputType != "" {
		config.OutputType = outputType
	}

	return config, nil
}

// VariableResolver 变量引用解析器（内部使用，避免循环导入）
type VariableResolver struct {
	varPattern *regexp.Regexp
}

// NewVariableResolver 创建变量解析器
func NewVariableResolver() *VariableResolver {
	return &VariableResolver{
		varPattern: regexp.MustCompile(`\$\{([^}]+)\}`),
	}
}

// Resolve 解析模板字符串中的变量引用
func (r *VariableResolver) Resolve(template string, variables map[string]interface{}) string {
	return r.varPattern.ReplaceAllStringFunc(template, func(match string) string {
		path := strings.Trim(match, "${}")
		value, err := r.getValueByPath(path, variables)
		if err != nil {
			return match
		}
		return fmt.Sprint(value)
	})
}

// getValueByPath 根据点分隔的路径获取嵌套值
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

		currentMap, ok := current.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("path segment %s: expected map, got %T", part, current)
		}

		next, exists := currentMap[part]
		if !exists {
			return nil, fmt.Errorf("path segment %s: key not found", part)
		}

		current = next
	}

	return current, nil
}
