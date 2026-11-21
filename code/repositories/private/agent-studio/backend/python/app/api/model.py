from fastapi import APIRouter

router = APIRouter(prefix="/api/model", tags=["model"])


@router.get("/available/list")
async def list_available_models():
    """获取可用模型列表"""
    return {
        "success": True,
        "data": [
            {
                "id": "gpt-3.5-turbo",
                "name": "GPT-3.5 Turbo",
                "provider": "openai",
                "description": "Fast and cost-effective",
                "contextWindow": 4096
            },
            {
                "id": "gpt-4",
                "name": "GPT-4",
                "provider": "openai",
                "description": "Most capable model",
                "contextWindow": 8192
            },
            {
                "id": "gpt-4-turbo",
                "name": "GPT-4 Turbo",
                "provider": "openai",
                "description": "Faster GPT-4",
                "contextWindow": 128000
            },
            {
                "id": "qwen-turbo",
                "name": "通义千问 Turbo",
                "provider": "qwen",
                "description": "快速响应版本",
                "contextWindow": 8000
            },
            {
                "id": "qwen-plus",
                "name": "通义千问 Plus",
                "provider": "qwen",
                "description": "增强能力版本",
                "contextWindow": 32000
            },
            {
                "id": "qwen-max",
                "name": "通义千问 Max",
                "provider": "qwen",
                "description": "最强能力版本",
                "contextWindow": 32000
            }
        ]
    }
