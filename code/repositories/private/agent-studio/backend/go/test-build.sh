#!/bin/bash
# 测试编译是否成功

echo "=== Agent Studio 后端构建测试 ==="
echo ""

# 设置Go代理
export GOPROXY=https://goproxy.cn,direct

# 清理旧文件
echo "1. 清理旧构建文件..."
rm -f test-server.exe
echo "✓ 完成"
echo ""

# 编译
echo "2. 编译服务器..."
go build -o test-server.exe ./cmd/server
if [ $? -eq 0 ]; then
    echo "✓ 编译成功"
    ls -lh test-server.exe
else
    echo "✗ 编译失败"
    exit 1
fi
echo ""

# 验证可执行文件
echo "3. 验证可执行文件..."
if [ -f test-server.exe ]; then
    echo "✓ 可执行文件已生成"
else
    echo "✗ 可执行文件未生成"
    exit 1
fi
echo ""

echo "=== 构建测试完成 ==="
echo ""
echo "提示:"
echo "  - 运行服务器: ./test-server.exe"
echo "  - 或使用: bash start.sh"
echo "  - 配置环境变量: 复制 .env.example 为 .env 并填写API密钥"
