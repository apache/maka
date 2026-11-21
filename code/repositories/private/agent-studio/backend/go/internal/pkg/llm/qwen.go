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

// QwenExecutor 通义千问执行器
type QwenExecutor struct {
	BaseURL string
	APIKey  string
	Client  *http.Client
}

// NewQwenExecutor 创建通义千问执行器
func NewQwenExecutor(baseURL string) *QwenExecutor {
	apiKey := os.Getenv("QWEN_API_KEY")
	if apiKey == "" {
		fmt.Println("警告: QWEN_API_KEY 环境变量未设置")
	}

	return &QwenExecutor{
		BaseURL: baseURL,
		APIKey:  apiKey,
		Client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// Chat 非流式聊天
func (e *QwenExecutor) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	messages := e.buildMessages(req)

	payload := map[string]interface{}{
		"model": req.Model,
		"input": map[string]interface{}{
			"messages": messages,
		},
		"parameters": map[string]interface{}{},
	}

	if req.Temperature > 0 {
		payload["parameters"].(map[string]interface{})["temperature"] = req.Temperature
	}
	if req.MaxTokens > 0 {
		payload["parameters"].(map[string]interface{})["max_tokens"] = req.MaxTokens
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化请求失败: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", e.BaseURL+"/services/aigc/text-generation/generation", bytes.NewReader(body))
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
		Output struct {
			Text         string `json:"text"`
			FinishReason string `json:"finish_reason"`
		} `json:"output"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("解析响应失败: %w", err)
	}

	return &ChatResponse{
		Content:      result.Output.Text,
		FinishReason: result.Output.FinishReason,
		Tokens:       result.Usage.TotalTokens,
	}, nil
}

// StreamChat 流式聊天
func (e *QwenExecutor) StreamChat(ctx context.Context, req ChatRequest) (<-chan StreamChunk, error) {
	messages := e.buildMessages(req)

	payload := map[string]interface{}{
		"model": req.Model,
		"input": map[string]interface{}{
			"messages": messages,
		},
		"parameters": map[string]interface{}{
			"incremental_output": true,
		},
	}

	if req.Temperature > 0 {
		payload["parameters"].(map[string]interface{})["temperature"] = req.Temperature
	}
	if req.MaxTokens > 0 {
		payload["parameters"].(map[string]interface{})["max_tokens"] = req.MaxTokens
	}

	body, err := json.Marshal(payload)
	if err != nil {
		ch := make(chan StreamChunk, 1)
		ch <- StreamChunk{Error: fmt.Errorf("序列化请求失败: %w", err), Done: true}
		close(ch)
		return ch, nil
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", e.BaseURL+"/services/aigc/text-generation/generation", bytes.NewReader(body))
	if err != nil {
		ch := make(chan StreamChunk, 1)
		ch <- StreamChunk{Error: err, Done: true}
		close(ch)
		return ch, nil
	}

	e.setHeaders(httpReq)
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("X-DashScope-SSE", "enable")

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
			if !strings.HasPrefix(line, "data:") {
				continue
			}

			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))

			var event struct {
				Output struct {
					Text         string `json:"text"`
					FinishReason string `json:"finish_reason"`
				} `json:"output"`
			}

			if err := json.Unmarshal([]byte(data), &event); err != nil {
				continue
			}

			if event.Output.Text != "" {
				ch <- StreamChunk{Content: event.Output.Text}
			}

			if event.Output.FinishReason != "" {
				ch <- StreamChunk{Done: true}
				return
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
func (e *QwenExecutor) buildMessages(req ChatRequest) []Message {
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
func (e *QwenExecutor) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.APIKey)
}
