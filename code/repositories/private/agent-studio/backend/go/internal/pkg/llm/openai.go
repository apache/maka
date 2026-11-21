package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// OpenAIExecutor OpenAI模型执行器
type OpenAIExecutor struct {
	BaseURL string
	APIKey  string
	Client  *http.Client
}

// NewOpenAIExecutor 创建OpenAI执行器
func NewOpenAIExecutor(baseURL string) *OpenAIExecutor {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		fmt.Println("警告: OPENAI_API_KEY 环境变量未设置")
	}

	return &OpenAIExecutor{
		BaseURL: baseURL,
		APIKey:  apiKey,
		Client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// Chat 非流式聊天
func (e *OpenAIExecutor) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	messages := e.buildMessages(req)

	payload := map[string]interface{}{
		"model":    req.Model,
		"messages": messages,
		"stream":   false,
	}
	if req.Temperature > 0 {
		payload["temperature"] = req.Temperature
	}
	if req.MaxTokens > 0 {
		payload["max_tokens"] = req.MaxTokens
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化请求失败: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", e.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	e.setHeaders(httpReq)

	resp, err := e.Client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("请求失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API错误 (状态码 %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("解析响应失败: %w", err)
	}

	if len(result.Choices) == 0 {
		return nil, fmt.Errorf("响应中没有choices")
	}

	return &ChatResponse{
		Content:      result.Choices[0].Message.Content,
		FinishReason: result.Choices[0].FinishReason,
		Tokens:       result.Usage.TotalTokens,
	}, nil
}

// StreamChat 流式聊天
func (e *OpenAIExecutor) StreamChat(ctx context.Context, req ChatRequest) (<-chan StreamChunk, error) {
	messages := e.buildMessages(req)

	payload := map[string]interface{}{
		"model":    req.Model,
		"messages": messages,
		"stream":   true,
	}
	if req.Temperature > 0 {
		payload["temperature"] = req.Temperature
	}
	if req.MaxTokens > 0 {
		payload["max_tokens"] = req.MaxTokens
	}

	body, err := json.Marshal(payload)
	if err != nil {
		ch := make(chan StreamChunk, 1)
		ch <- StreamChunk{Error: fmt.Errorf("序列化请求失败: %w", err), Done: true}
		close(ch)
		return ch, nil
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", e.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		ch := make(chan StreamChunk, 1)
		ch <- StreamChunk{Error: err, Done: true}
		close(ch)
		return ch, nil
	}

	e.setHeaders(httpReq)
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := e.Client.Do(httpReq)
	if err != nil {
		ch := make(chan StreamChunk, 1)
		ch <- StreamChunk{Error: fmt.Errorf("请求失败: %w", err), Done: true}
		close(ch)
		return ch, nil
	}

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		ch := make(chan StreamChunk, 1)
		ch <- StreamChunk{Error: fmt.Errorf("API错误 (状态码 %d): %s", resp.StatusCode, string(bodyBytes)), Done: true}
		close(ch)
		return ch, nil
	}

	ch := make(chan StreamChunk, 10)

	go func() {
		defer resp.Body.Close()
		defer close(ch)

		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}

			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				ch <- StreamChunk{Done: true}
				return
			}

			var event struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
			}

			if err := json.Unmarshal([]byte(data), &event); err != nil {
				continue
			}

			if len(event.Choices) > 0 && event.Choices[0].Delta.Content != "" {
				ch <- StreamChunk{Content: event.Choices[0].Delta.Content}
			}
		}

		if err := scanner.Err(); err != nil {
			ch <- StreamChunk{Error: err, Done: true}
		} else {
			ch <- StreamChunk{Done: true}
		}
	}()

	return ch, nil
}

// buildMessages 构建消息列表
func (e *OpenAIExecutor) buildMessages(req ChatRequest) []Message {
	var messages []Message

	if req.SystemPrompt != "" {
		messages = append(messages, Message{Role: "system", Content: req.SystemPrompt})
	}

	if req.UserPrompt != "" {
		messages = append(messages, Message{Role: "user", Content: req.UserPrompt})
	}

	if len(req.Messages) > 0 {
		messages = append(messages, req.Messages...)
	}

	return messages
}

// setHeaders 设置请求头
func (e *OpenAIExecutor) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.APIKey)
}
