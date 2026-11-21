package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"agent-studio-backend/internal/model"
	"agent-studio-backend/internal/pkg/llm"
	"agent-studio-backend/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// AgentController Agent相关API控制器
type AgentController struct {
	db       *gorm.DB
	executor *service.ExecutorService
}

// NewAgentController 创建Agent控制器
func NewAgentController(db *gorm.DB, executor *service.ExecutorService) *AgentController {
	return &AgentController{
		db:       db,
		executor: executor,
	}
}

// ExecuteRequest Agent执行请求
type ExecuteRequest struct {
	MicroAppVersionID string                 `json:"microAppVersionId" binding:"required"`
	Input             map[string]interface{} `json:"input"`
}

// Execute 执行Agent
// POST /api/agent/execute
func (c *AgentController) Execute(ctx *gin.Context) {
	var req ExecuteRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{
			"success":    false,
			"errCode":    "INVALID_REQUEST",
			"errMessage": "请求参数无效: " + err.Error(),
		})
		return
	}

	// 创建执行记录
	execution := &model.Execution{
		ID:      uuid.New(),
		AgentID: req.MicroAppVersionID,
		Status:  "running",
	}

	// 序列化输入
	if len(req.Input) > 0 {
		inputBytes, _ := json.Marshal(req.Input)
		execution.Input = datatypes.JSON(inputBytes)
	}

	if err := c.db.Create(execution).Error; err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"success":    false,
			"errCode":    "DB_ERROR",
			"errMessage": "创建执行记录失败: " + err.Error(),
		})
		return
	}

	// 设置SSE响应头
	ctx.Header("Content-Type", "text/event-stream")
	ctx.Header("Cache-Control", "no-cache")
	ctx.Header("Connection", "keep-alive")
	ctx.Header("Access-Control-Allow-Origin", "*")

	// 构造LLM请求(简化版,实际应从数据库读取Agent配置)
	userMessage := "你好"
	if msg, ok := req.Input["message"].(string); ok {
		userMessage = msg
	}

	chatReq := llm.ChatRequest{
		Model:       "gpt-3.5-turbo", // 临时硬编码,后续从Agent配置读取
		UserPrompt:  userMessage,
		Temperature: 0.7,
	}

	// 流式执行
	stream, err := c.executor.StreamChat(ctx.Request.Context(), chatReq)
	if err != nil {
		c.updateExecutionFailed(execution.ID, err.Error())
		ctx.SSEvent("message", gin.H{"error": err.Error()})
		ctx.SSEvent("message", "[DONE]")
		return
	}

	var fullContent string
	tokenCount := 0

	for chunk := range stream {
		if chunk.Error != nil {
			c.updateExecutionFailed(execution.ID, chunk.Error.Error())
			ctx.SSEvent("message", gin.H{"error": chunk.Error.Error()})
			break
		}

		if chunk.Done {
			break
		}

		if chunk.Content != "" {
			fullContent += chunk.Content
			tokenCount++
			ctx.SSEvent("message", gin.H{
				"content": chunk.Content,
				"tokens":  tokenCount,
			})
			ctx.Writer.Flush()
		}
	}

	// 更新执行记录
	c.updateExecutionSuccess(execution.ID, fullContent, tokenCount)

	ctx.SSEvent("message", "[DONE]")
}

// updateExecutionSuccess 更新执行成功
func (c *AgentController) updateExecutionSuccess(execID uuid.UUID, content string, tokens int) {
	now := time.Now()
	output := map[string]interface{}{
		"content": content,
		"tokens":  tokens,
	}
	outputBytes, _ := json.Marshal(output)

	c.db.Model(&model.Execution{}).Where("id = ?", execID).Updates(map[string]interface{}{
		"status":       "success",
		"output":       datatypes.JSON(outputBytes),
		"completed_at": now,
	})
}

// updateExecutionFailed 更新执行失败
func (c *AgentController) updateExecutionFailed(execID uuid.UUID, errMsg string) {
	now := time.Now()
	c.db.Model(&model.Execution{}).Where("id = ?", execID).Updates(map[string]interface{}{
		"status":       "failed",
		"error_msg":    errMsg,
		"completed_at": now,
	})
}

// GetExecution 获取执行记录
// GET /api/agent/execution/:id
func (c *AgentController) GetExecution(ctx *gin.Context) {
	execID := ctx.Param("id")

	var execution model.Execution
	if err := c.db.Where("id = ?", execID).First(&execution).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			ctx.JSON(http.StatusNotFound, gin.H{
				"success":    false,
				"errCode":    "NOT_FOUND",
				"errMessage": "执行记录不存在",
			})
			return
		}
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"success":    false,
			"errCode":    "DB_ERROR",
			"errMessage": err.Error(),
		})
		return
	}

	ctx.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    execution,
	})
}

// ListExecutions 获取执行记录列表
// GET /api/agent/executions
func (c *AgentController) ListExecutions(ctx *gin.Context) {
	agentID := ctx.Query("agentId")
	status := ctx.Query("status")

	query := c.db.Model(&model.Execution{})

	if agentID != "" {
		query = query.Where("agent_id = ?", agentID)
	}
	if status != "" {
		query = query.Where("status = ?", status)
	}

	var executions []model.Execution
	if err := query.Order("created_at DESC").Limit(100).Find(&executions).Error; err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"success":    false,
			"errCode":    "DB_ERROR",
			"errMessage": err.Error(),
		})
		return
	}

	ctx.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    executions,
	})
}

// TestModel 测试模型调用
// POST /api/agent/test-model
func (c *AgentController) TestModel(ctx *gin.Context) {
	var req struct {
		Model   string `json:"model" binding:"required"`
		Message string `json:"message" binding:"required"`
	}

	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{
			"success":    false,
			"errCode":    "INVALID_REQUEST",
			"errMessage": err.Error(),
		})
		return
	}

	chatReq := llm.ChatRequest{
		Model:      req.Model,
		UserPrompt: req.Message,
	}

	resp, err := c.executor.Chat(ctx.Request.Context(), chatReq)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"success":    false,
			"errCode":    "MODEL_ERROR",
			"errMessage": fmt.Sprintf("模型调用失败: %v", err),
		})
		return
	}

	ctx.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    resp,
	})
}

// Health 健康检查
// GET /api/health
func (c *AgentController) Health(ctx *gin.Context) {
	// 检查数据库连接
	sqlDB, err := c.db.DB()
	if err != nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{
			"success": false,
			"error":   "数据库连接异常",
		})
		return
	}

	if err := sqlDB.Ping(); err != nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{
			"success": false,
			"error":   "数据库ping失败: " + err.Error(),
		})
		return
	}

	ctx.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "服务正常",
		"time":    time.Now().Format(time.RFC3339),
	})
}

// Proxy 代理前端离线API请求到真实后端
// POST /api/proxy
func (c *AgentController) Proxy(ctx *gin.Context) {
	// 解析请求
	var proxyReq struct {
		URL    string                 `json:"url"`
		Data   map[string]interface{} `json:"data"`
		Params map[string]interface{} `json:"params"`
	}

	if err := ctx.ShouldBindJSON(&proxyReq); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{
			"success":    false,
			"errCode":    "INVALID_REQUEST",
			"errMessage": err.Error(),
		})
		return
	}

	// 临时返回未实现
	ctx.JSON(http.StatusNotImplemented, gin.H{
		"success":    false,
		"errCode":    "NOT_IMPLEMENTED",
		"errMessage": "代理功能尚未实现,请直接使用专用API",
	})
}
