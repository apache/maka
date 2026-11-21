package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"agent-studio-backend/internal/model"
	"agent-studio-backend/internal/service/workflow"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// WorkflowController 工作流控制器
type WorkflowController struct {
	engine *workflow.WorkflowEngine
	db     *gorm.DB
}

// NewWorkflowController 创建工作流控制器
func NewWorkflowController(engine *workflow.WorkflowEngine, db *gorm.DB) *WorkflowController {
	return &WorkflowController{
		engine: engine,
		db:     db,
	}
}

// WorkflowExecuteRequest 执行请求
type WorkflowExecuteRequest struct {
	WorkflowID string                 `json:"workflowId" binding:"required"`
	Input      map[string]interface{} `json:"input"`
}

// Execute 执行工作流
// POST /api/workflow/execute
func (c *WorkflowController) Execute(ctx *gin.Context) {
	var req WorkflowExecuteRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{
			"success":    false,
			"errCode":    "INVALID_REQUEST",
			"errMessage": err.Error(),
		})
		return
	}

	// 查询工作流定义(从micro_app_versions表或workflow-data.json)
	var wfData string
	err := c.db.Table("micro_app_versions").
		Select("data").
		Where("micro_app_version_id = ?", req.WorkflowID).
		Scan(&wfData).Error

	// 如果数据库中没有,尝试从测试数据读取
	if err != nil || wfData == "" {
		// 对于演示目的,可以从文件系统读取
		ctx.JSON(http.StatusNotFound, gin.H{
			"success":    false,
			"errCode":    "WORKFLOW_NOT_FOUND",
			"errMessage": "工作流不存在",
		})
		return
	}

	// 解析工作流JSON
	wf, err := workflow.ParseWorkflowFromJSON(wfData)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{
			"success":    false,
			"errCode":    "INVALID_WORKFLOW",
			"errMessage": "工作流格式错误: " + err.Error(),
		})
		return
	}

	// 创建执行记录
	execID := uuid.New()
	execution := &model.WorkflowExecution{
		ID:         execID,
		WorkflowID: req.WorkflowID,
		Status:     "pending",
		Input:      datatypes.JSON(mustMarshal(req.Input)),
		CreatedAt:  time.Now(),
	}

	if err := c.db.Create(execution).Error; err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"success":    false,
			"errCode":    "DB_ERROR",
			"errMessage": "创建执行记录失败: " + err.Error(),
		})
		return
	}

	// 异步执行工作流
	go c.executeWorkflowAsync(req.WorkflowID, execID.String(), wf, req.Input)

	// 立即返回执行ID
	ctx.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"executionId": execID.String(),
			"status":      "pending",
		},
	})
}

// executeWorkflowAsync 异步执行工作流
func (c *WorkflowController) executeWorkflowAsync(workflowID, executionID string, wf *workflow.Workflow, input map[string]interface{}) {
	// 更新状态为running
	c.db.Model(&model.WorkflowExecution{}).
		Where("id = ?", executionID).
		Update("status", "running")

	// 执行工作流
	result, err := c.engine.Execute(context.Background(), wf, workflowID, executionID, input)

	now := time.Now()
	updates := map[string]interface{}{
		"completed_at": now,
	}

	if err != nil {
		// 执行失败
		updates["status"] = "failed"
		updates["error_msg"] = err.Error()
		if result != nil {
			updates["output"] = datatypes.JSON(mustMarshal(result.Output))
			updates["node_states"] = datatypes.JSON(mustMarshal(result.NodeStates))
			updates["variables"] = datatypes.JSON(mustMarshal(result.Variables))
			updates["duration"] = result.Duration
		}
	} else {
		// 执行成功
		updates["status"] = "success"
		updates["output"] = datatypes.JSON(mustMarshal(result.Output))
		updates["node_states"] = datatypes.JSON(mustMarshal(result.NodeStates))
		updates["variables"] = datatypes.JSON(mustMarshal(result.Variables))
		updates["duration"] = result.Duration
	}

	c.db.Model(&model.WorkflowExecution{}).
		Where("id = ?", executionID).
		Updates(updates)
}

// GetLogs 查询执行日志
// GET /api/workflow/:id/logs
func (c *WorkflowController) GetLogs(ctx *gin.Context) {
	execID := ctx.Param("id")

	var exec model.WorkflowExecution
	if err := c.db.First(&exec, "id = ?", execID).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			ctx.JSON(http.StatusNotFound, gin.H{
				"success":    false,
				"errCode":    "EXECUTION_NOT_FOUND",
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
		"data": gin.H{
			"id":          exec.ID,
			"workflowId":  exec.WorkflowID,
			"status":      exec.Status,
			"input":       exec.Input,
			"output":      exec.Output,
			"nodeStates":  exec.NodeStates,
			"variables":   exec.Variables,
			"errorMsg":    exec.ErrorMsg,
			"duration":    exec.Duration,
			"createdAt":   exec.CreatedAt,
			"updatedAt":   exec.UpdatedAt,
			"completedAt": exec.CompletedAt,
		},
	})
}

// GetExecution 获取执行记录
// GET /api/workflow/execution/:id
func (c *WorkflowController) GetExecution(ctx *gin.Context) {
	c.GetLogs(ctx) // 复用GetLogs逻辑
}

// ListExecutions 获取执行记录列表
// GET /api/workflow/executions
func (c *WorkflowController) ListExecutions(ctx *gin.Context) {
	workflowID := ctx.Query("workflowId")
	status := ctx.Query("status")

	query := c.db.Model(&model.WorkflowExecution{})

	if workflowID != "" {
		query = query.Where("workflow_id = ?", workflowID)
	}
	if status != "" {
		query = query.Where("status = ?", status)
	}

	var executions []model.WorkflowExecution
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

// mustMarshal JSON序列化辅助函数
func mustMarshal(v interface{}) []byte {
	data, _ := json.Marshal(v)
	return data
}
