package llm

import "context"

// ModelExecutor 模型推理接口
type ModelExecutor interface {
	Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error)
	StreamChat(ctx context.Context, req ChatRequest) (<-chan StreamChunk, error)
}

// ChatRequest 聊天请求
type ChatRequest struct {
	Model        string                 `json:"model"`
	Messages     []Message              `json:"messages"`
	Temperature  float64                `json:"temperature,omitempty"`
	MaxTokens    int                    `json:"max_tokens,omitempty"`
	Stream       bool                   `json:"stream,omitempty"`
	SystemPrompt string                 `json:"-"` // 便捷字段,会转为system消息
	UserPrompt   string                 `json:"-"` // 便捷字段,会转为user消息
	Extra        map[string]interface{} `json:"-"` // 扩展参数
}

// Message 消息
type Message struct {
	Role    string `json:"role"`    // system/user/assistant
	Content string `json:"content"`
}

// ChatResponse 聊天响应
type ChatResponse struct {
	Content      string `json:"content"`
	FinishReason string `json:"finish_reason"`
	Tokens       int    `json:"tokens"`
}

// StreamChunk 流式输出块
type StreamChunk struct {
	Content string `json:"content"`
	Done    bool   `json:"done"`
	Error   error  `json:"error,omitempty"`
}
