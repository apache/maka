#!/bin/bash
# Agent Studio 后端启动脚本

# 加载环境变量
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
    echo "✓ 已加载 .env 文件"
fi

# 检查API密钥
if [ -z "$OPENAI_API_KEY" ] && [ -z "$QWEN_API_KEY" ]; then
    echo "⚠️  警告: 未设置 OPENAI_API_KEY 或 QWEN_API_KEY"
    echo "   请创建 .env 文件或设置环境变量"
fi

# 设置Go代理
export GOPROXY=https://goproxy.cn,direct

# 启动服务器
echo "🚀 启动 Agent Studio 后端服务..."
go run cmd/server/main.go
