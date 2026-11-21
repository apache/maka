from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.api import agent, workflow, model
from app.services.executor import get_executor_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时初始化
    print("Starting Agent Studio Python Backend...")
    yield
    # 关闭时清理
    print("Shutting down...")
    executor = get_executor_service()
    await executor.close()


app = FastAPI(
    title="Agent Studio Backend (Python)",
    description="Agent Studio Python后端服务",
    version="1.0.0",
    lifespan=lifespan
)

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(agent.router)
app.include_router(workflow.router)
app.include_router(model.router)


@app.get("/")
async def root():
    """根路径"""
    return {
        "message": "Agent Studio Python Backend",
        "version": "1.0.0"
    }


@app.get("/api/health")
async def health():
    """健康检查"""
    return {
        "status": "ok",
        "service": "agent-studio-python"
    }


if __name__ == "__main__":
    import uvicorn
    from app.config import get_settings
    
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.server_host,
        port=settings.server_port,
        reload=True
    )
