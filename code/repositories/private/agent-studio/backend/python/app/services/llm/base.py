from abc import ABC, abstractmethod
from typing import AsyncIterator, List
from pydantic import BaseModel


class Message(BaseModel):
    """聊天消息"""
    role: str
    content: str


class ChatRequest(BaseModel):
    """聊天请求"""
    model: str
    messages: List[Message]
    temperature: float = 0.7
    max_tokens: int = 2000
    stream: bool = False


class ChatResponse(BaseModel):
    """聊天响应"""
    content: str
    tokens: int


class ModelExecutor(ABC):
    """模型执行器接口"""
    
    @abstractmethod
    async def chat(self, req: ChatRequest) -> ChatResponse:
        """非流式聊天"""
        pass
    
    @abstractmethod
    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[str]:
        """流式聊天"""
        pass
