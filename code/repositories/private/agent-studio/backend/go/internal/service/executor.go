package service

import (
	"context"
	"fmt"

	"agent-studio-backend/internal/model"
	"agent-studio-backend/internal/pkg/llm"
)

// ExecutorService 执行器服务
type ExecutorService struct {
	executors map[string]llm.ModelExecutor
}

// NewExecutorService 创建执行器服务
func NewExecutorService(cfg *model.Config) *ExecutorService {
	executors := make(map[string]llm.ModelExecutor)

	// 初始化OpenAI执行器
	if openaiCfg, ok := cfg.Models["openai"]; ok {
		executors["openai"] = llm.NewOpenAIExecutor(openaiCfg.BaseURL)
	}

	// 初始化通义千问执行器
	if qwenCfg, ok := cfg.Models["qwen"]; ok {
		executors["qwen"] = llm.NewQwenExecutor(qwenCfg.BaseURL)
	}

	return &ExecutorService{
		executors: executors,
	}
}

// Chat 执行聊天
func (s *ExecutorService) Chat(ctx context.Context, req llm.ChatRequest) (*llm.ChatResponse, error) {
	executor, err := s.getExecutor(req.Model)
	if err != nil {
		return nil, err
	}

	return executor.Chat(ctx, req)
}

// StreamChat 流式聊天
func (s *ExecutorService) StreamChat(ctx context.Context, req llm.ChatRequest) (<-chan llm.StreamChunk, error) {
	executor, err := s.getExecutor(req.Model)
	if err != nil {
		ch := make(chan llm.StreamChunk, 1)
		ch <- llm.StreamChunk{Error: err, Done: true}
		close(ch)
		return ch, nil
	}

	return executor.StreamChat(ctx, req)
}

// getExecutor 根据模型名称获取执行器
func (s *ExecutorService) getExecutor(modelName string) (llm.ModelExecutor, error) {
	// 根据模型前缀判断provider
	var provider string
	switch {
	case contains(modelName, "gpt"):
		provider = "openai"
	case contains(modelName, "qwen"):
		provider = "qwen"
	default:
		return nil, fmt.Errorf("不支持的模型: %s", modelName)
	}

	executor, ok := s.executors[provider]
	if !ok {
		return nil, fmt.Errorf("未配置的provider: %s", provider)
	}

	return executor, nil
}

// contains 检查字符串是否包含子串
func contains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
