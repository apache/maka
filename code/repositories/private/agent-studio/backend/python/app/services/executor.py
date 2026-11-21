from typing import AsyncIterator
from app.services.llm.base import ModelExecutor, ChatRequest, ChatResponse
from app.services.llm.openai_client import OpenAIExecutor
from app.services.llm.qwen_client import QwenExecutor
from app.config import get_settings


class ExecutorService:
    """统一模型推理服务"""
    
    def __init__(self):
        settings = get_settings()
        self.executors = {}
        
        # 初始化OpenAI
        if settings.openai_api_key:
            self.executors["openai"] = OpenAIExecutor(
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url
            )
        
        # 初始化通义千问
        if settings.qwen_api_key:
            self.executors["qwen"] = QwenExecutor(
                api_key=settings.qwen_api_key,
                base_url=settings.qwen_base_url
            )
    
    async def chat(self, req: ChatRequest) -> ChatResponse:
        """非流式聊天"""
        executor = self._get_executor(req.model)
        return await executor.chat(req)
    
    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[str]:
        """流式聊天"""
        executor = self._get_executor(req.model)
        async for chunk in executor.stream_chat(req):
            yield chunk
    
    def _get_executor(self, model: str) -> ModelExecutor:
        """根据模型路由到执行器"""
        if model.startswith("gpt"):
            if "openai" not in self.executors:
                raise ValueError("OpenAI not configured")
            return self.executors["openai"]
        elif model.startswith("qwen"):
            if "qwen" not in self.executors:
                raise ValueError("Qwen not configured")
            return self.executors["qwen"]
        else:
            raise ValueError(f"Unsupported model: {model}")
    
    async def close(self):
        """关闭所有执行器"""
        for executor in self.executors.values():
            await executor.close()


# 全局执行器实例
_executor_service = None


def get_executor_service() -> ExecutorService:
    """获取执行器服务单例"""
    global _executor_service
    if _executor_service is None:
        _executor_service = ExecutorService()
    return _executor_service
