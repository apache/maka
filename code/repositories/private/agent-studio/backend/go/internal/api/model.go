package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// ModelController 模型相关API控制器
type ModelController struct{}

// NewModelController 创建模型控制器
func NewModelController() *ModelController {
	return &ModelController{}
}

// ModelInfo 模型信息
type ModelInfo struct {
	ModelID   string `json:"modelId"`
	ModelCode string `json:"modelCode"`
	ModelName string `json:"modelName"`
	Provider  string `json:"provider"`
}

// ListModels 获取可用模型列表
// GET /api/v1/models/available/list
func (c *ModelController) ListModels(ctx *gin.Context) {
	models := []ModelInfo{
		{
			ModelID:   "382849770824167457",
			ModelCode: "gpt-4",
			ModelName: "GPT-4",
			Provider:  "OpenAI",
		},
		{
			ModelID:   "382849770824167458",
			ModelCode: "gpt-3.5-turbo",
			ModelName: "GPT-3.5 Turbo",
			Provider:  "OpenAI",
		},
		{
			ModelID:   "382849770824167459",
			ModelCode: "qwen-turbo",
			ModelName: "通义千问Turbo",
			Provider:  "Alibaba",
		},
		{
			ModelID:   "382849770824167460",
			ModelCode: "qwen-plus",
			ModelName: "通义千问Plus",
			Provider:  "Alibaba",
		},
	}

	ctx.JSON(http.StatusOK, gin.H{
		"success": true,
		"code":    0,
		"msg":     "success",
		"data":    models,
	})
}
