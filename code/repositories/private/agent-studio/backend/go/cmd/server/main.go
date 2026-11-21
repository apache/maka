package main

import (
	"fmt"
	"log"
	"os"

	"agent-studio-backend/internal/api"
	"agent-studio-backend/internal/model"
	"agent-studio-backend/internal/service"
	"agent-studio-backend/internal/service/workflow"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	// 加载配置
	cfg, err := model.LoadConfig("config.yaml")
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// 设置Gin模式
	if cfg.Server.Mode == "release" {
		gin.SetMode(gin.ReleaseMode)
	}

	// 连接数据库
	db, err := connectDatabase(&cfg.Database)
	if err != nil {
		log.Fatalf("数据库连接失败: %v", err)
	}

	// 自动迁移表结构
	if err := db.AutoMigrate(&model.Execution{}, &model.WorkflowExecution{}); err != nil {
		log.Fatalf("数据库迁移失败: %v", err)
	}

	// 初始化服务
	executorService := service.NewExecutorService(cfg)

	// 初始化工作流引擎
	workflowEngine := workflow.NewWorkflowEngine(executorService)

	// 初始化控制器
	modelController := api.NewModelController()
	agentController := api.NewAgentController(db, executorService)
	workflowController := api.NewWorkflowController(workflowEngine, db)

	// 创建路由
	router := gin.Default()

	// 跨域中间件
	router.Use(corsMiddleware())

	// 注册路由
	v1 := router.Group("/api/v1")
	{
		// 模型相关
		v1.GET("/models/available/list", modelController.ListModels)
	}

	agent := router.Group("/api/agent")
	{
		// Agent执行
		agent.POST("/execute", agentController.Execute)
		agent.POST("/test-model", agentController.TestModel)
		
		// 执行记录
		agent.GET("/execution/:id", agentController.GetExecution)
		agent.GET("/executions", agentController.ListExecutions)
	}

	// 工作流路由
	wf := router.Group("/api/workflow")
	{
		// 工作流执行
		wf.POST("/execute", workflowController.Execute)
		
		// 执行记录
		wf.GET("/:id/logs", workflowController.GetLogs)
		wf.GET("/execution/:id", workflowController.GetExecution)
		wf.GET("/executions", workflowController.ListExecutions)
	}

	// 健康检查
	router.GET("/api/health", agentController.Health)

	// 静态文件服务(前端)
	router.Static("/assets", "../app/assets")
	router.StaticFile("/", "../app/index.html")
	router.StaticFile("/agents.json", "../app/agents.json")
	router.StaticFile("/workflow-data.json", "../app/workflow-data.json")
	router.StaticFile("/business-data.json", "../app/business-data.json")
	router.StaticFile("/knowledge-content.json", "../app/knowledge-content.json")
	router.StaticFile("/knowledge-documents.json", "../app/knowledge-documents.json")
	router.StaticFile("/navigation.json", "../app/navigation.json")

	// 启动服务器
	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	log.Printf("服务器启动在 http://localhost%s", addr)
	log.Printf("前端地址: http://localhost%s", addr)
	log.Printf("健康检查: http://localhost%s/api/health", addr)
	log.Printf("模型列表: http://localhost%s/api/v1/models/available/list", addr)

	if err := router.Run(addr); err != nil {
		log.Fatalf("服务器启动失败: %v", err)
	}
}

// connectDatabase 连接数据库
func connectDatabase(cfg *model.DatabaseConfig) (*gorm.DB, error) {
	dsn := cfg.DSN()
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, fmt.Errorf("打开数据库连接失败: %w", err)
	}

	// 测试连接
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("获取数据库实例失败: %w", err)
	}

	if err := sqlDB.Ping(); err != nil {
		return nil, fmt.Errorf("数据库ping失败: %w", err)
	}

	log.Println("数据库连接成功")
	return db, nil
}

// corsMiddleware CORS中间件
func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}

func init() {
	// 确保工作目录正确
	if _, err := os.Stat("config.yaml"); os.IsNotExist(err) {
		// 尝试切换到backend目录
		if err := os.Chdir("backend"); err != nil {
			log.Println("警告: 未找到config.yaml,请确保在backend目录下运行")
		}
	}
}
