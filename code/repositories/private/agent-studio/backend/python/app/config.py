from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """应用配置"""
    
    # 服务器配置
    server_host: str = "0.0.0.0"
    server_port: int = 8000
    
    # 数据库配置
    database_url: str = "postgresql://postgres:postgres@localhost:5432/agent_studio"
    
    # OpenAI配置
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    
    # 通义千问配置
    qwen_api_key: str = ""
    qwen_base_url: str = "https://dashscope.aliyuncs.com/api/v1"
    
    # Redis配置
    redis_url: str = "redis://localhost:6379/0"
    
    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    """获取配置单例"""
    return Settings()
