import httpx
import json
from typing import AsyncIterator
from app.services.llm.base import ModelExecutor, ChatRequest, ChatResponse


class OpenAIExecutor(ModelExecutor):
    """OpenAI模型执行器"""
    
    def __init__(self, api_key: str, base_url: str):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=60.0)
    
    async def chat(self, req: ChatRequest) -> ChatResponse:
        """非流式聊天"""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": req.model,
            "messages": [m.dict() for m in req.messages],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens
        }
        
        resp = await self.client.post(
            f"{self.base_url}/chat/completions",
            json=payload,
            headers=headers
        )
        resp.raise_for_status()
        
        data = resp.json()
        return ChatResponse(
            content=data["choices"][0]["message"]["content"],
            tokens=data["usage"]["total_tokens"]
        )
    
    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[str]:
        """流式聊天"""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": req.model,
            "messages": [m.dict() for m in req.messages],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": True
        }
        
        async with self.client.stream(
            "POST",
            f"{self.base_url}/chat/completions",
            json=payload,
            headers=headers
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    content = line[6:]
                    if content == "[DONE]":
                        break
                    try:
                        chunk = json.loads(content)
                        delta = chunk["choices"][0]["delta"]
                        if "content" in delta:
                            yield delta["content"]
                    except (json.JSONDecodeError, KeyError):
                        continue
    
    async def close(self):
        """关闭客户端"""
        await self.client.aclose()
