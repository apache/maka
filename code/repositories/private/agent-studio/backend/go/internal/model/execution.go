package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// Execution 执行记录
type Execution struct {
	ID          uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	AgentID     string         `gorm:"not null;index" json:"agentId"`
	Input       datatypes.JSON `gorm:"type:jsonb" json:"input"`
	Output      datatypes.JSON `gorm:"type:jsonb" json:"output"`
	Status      string         `gorm:"not null;index" json:"status"` // pending/running/success/failed
	ErrorMsg    string         `gorm:"type:text" json:"errorMsg,omitempty"`
	CreatedAt   time.Time      `gorm:"index" json:"createdAt"`
	CompletedAt *time.Time     `json:"completedAt,omitempty"`
}

// TableName 指定表名
func (Execution) TableName() string {
	return "executions"
}

// BeforeCreate GORM钩子:创建前生成UUID
func (e *Execution) BeforeCreate() error {
	if e.ID == uuid.Nil {
		e.ID = uuid.New()
	}
	if e.Status == "" {
		e.Status = "pending"
	}
	return nil
}
