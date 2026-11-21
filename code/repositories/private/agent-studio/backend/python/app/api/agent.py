from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any
import json
from app.services.executor import get_executor_service
from app.services.llm.base import ChatRequest, Message

router = APIRouter(prefix="/api/agent", tags=["agent"])


class ExecuteRequest(BaseModel):
    """Agent执行请求"""
    microAppVersionId: str
    input: Dict[str, Any]


@router.post("/execute")
async def execute(req: ExecuteRequest):
    """Agent执行(SSE流式)"""
    executor = get_executor_service()
    message = req.input.get("message", "")
    
    async def event_stream():
        """SSE事件流"""
        chat_req = ChatRequest(
            model="gpt-3.5-turbo",
            messages=[Message(role="user", content=message)],
            stream=True
        )
        
        try:
            async for chunk in executor.stream_chat(chat_req):
                yield f"data: {json.dumps({'content': chunk})}\n\n"
            
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
    
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream"
    )


@router.get("/models")
async def list_models():
    """获取可用模型列表"""
    return {
        "success": True,
        "data": [
            {
                "id": "gpt-3.5-turbo",
                "name": "GPT-3.5 Turbo",
                "provider": "openai"
            },
            {
                "id": "gpt-4",
                "name": "GPT-4",
                "provider": "openai"
            },
            {
                "id": "qwen-turbo",
                "name": "通义千问 Turbo",
                "provider": "qwen"
            },
            {
                "id": "qwen-plus",
                "name": "通义千问 Plus",
                "provider": "qwen"
            }
        ]
    }
