package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// WorkflowExecution 工作流执行记录
type WorkflowExecution struct {
	ID          uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	WorkflowID  string         `gorm:"type:varchar(255);not null;index" json:"workflowId"`
	Status      string         `gorm:"type:varchar(20);index" json:"status"` // pending/running/success/failed
	Input       datatypes.JSON `gorm:"type:jsonb" json:"input"`
	Output      datatypes.JSON `gorm:"type:jsonb" json:"output"`
	NodeStates  datatypes.JSON `gorm:"type:jsonb" json:"nodeStates"`
	Variables   datatypes.JSON `gorm:"type:jsonb" json:"variables"`
	ErrorMsg    string         `gorm:"type:text" json:"errorMsg,omitempty"`
	Duration    int64          `gorm:"default:0" json:"duration"` // 执行时长(毫秒)
	CreatedAt   time.Time      `gorm:"autoCreateTime" json:"createdAt"`
	UpdatedAt   time.Time      `gorm:"autoUpdateTime" json:"updatedAt"`
	CompletedAt *time.Time     `json:"completedAt,omitempty"`
}

// TableName 指定表名
func (WorkflowExecution) TableName() string {
	return "workflow_executions"
}

// BeforeCreate GORM钩子:创建前生成UUID
func (e *WorkflowExecution) BeforeCreate() error {
	if e.ID == uuid.Nil {
		e.ID = uuid.New()
	}
	if e.Status == "" {
		e.Status = "pending"
	}
	return nil
}
