#!/bin/bash
# 工作流API集成测试脚本

BASE_URL="http://localhost:8080"

echo "======================================"
echo "工作流引擎 API 集成测试"
echo "======================================"

# 检查服务是否运行
echo -e "\n[1] 检查服务健康状态..."
curl -s "$BASE_URL/api/health" | jq '.'

# 测试数据：简单的工作流定义
WORKFLOW_JSON='{
  "nodes": [
    {
      "id": "start",
      "type": "StartNode",
      "title": "开始",
      "data": {},
      "position": {"x": 0, "y": 0}
    },
    {
      "id": "llm1",
      "type": "LLMNode",
      "title": "分析顾客信息",
      "data": {
        "model": "gpt-3.5-turbo",
        "systemPrompt": "你是一个顾客信息分析助手",
        "userPrompt": "请简要分析: ${start.result.message}",
        "temperature": 0.7,
        "maxTokens": 2000,
        "outputType": "Text"
      },
      "position": {"x": 200, "y": 0}
    },
    {
      "id": "end",
      "type": "EndNode",
      "title": "结束",
      "data": {
        "outputParams": [
          {
            "key": "result",
            "value": "${llm1.result.content}"
          }
        ],
        "outputType": "JSON"
      },
      "position": {"x": 400, "y": 0}
    }
  ],
  "edges": [
    {"id": "e1", "source": "start", "target": "llm1"},
    {"id": "e2", "source": "llm1", "target": "end"}
  ]
}'

# 注意：实际环境需要先将工作流定义保存到数据库
# 这里假设已有workflowId=5433的工作流

echo -e "\n[2] 执行工作流..."
EXEC_RESPONSE=$(curl -s -X POST "$BASE_URL/api/workflow/execute" \
  -H "Content-Type: application/json" \
  -d '{
    "workflowId": "5433",
    "input": {
      "message": "顾客说她有两个孩子，大的上小学了"
    }
  }')

echo "$EXEC_RESPONSE" | jq '.'

# 提取executionId
EXECUTION_ID=$(echo "$EXEC_RESPONSE" | jq -r '.data.executionId')

if [ "$EXECUTION_ID" = "null" ] || [ -z "$EXECUTION_ID" ]; then
  echo "❌ 执行失败，未获取到executionId"
  exit 1
fi

echo "✅ 工作流执行已提交，executionId: $EXECUTION_ID"

# 等待执行完成
echo -e "\n[3] 等待执行完成..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  sleep 1
  
  LOG_RESPONSE=$(curl -s "$BASE_URL/api/workflow/$EXECUTION_ID/logs")
  STATUS=$(echo "$LOG_RESPONSE" | jq -r '.data.status')
  
  echo "状态: $STATUS (第 $((RETRY_COUNT+1)) 次查询)"
  
  if [ "$STATUS" = "success" ]; then
    echo "✅ 执行成功！"
    echo "$LOG_RESPONSE" | jq '.data'
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "❌ 执行失败"
    echo "$LOG_RESPONSE" | jq '.data'
    exit 1
  fi
  
  RETRY_COUNT=$((RETRY_COUNT+1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "❌ 超时：执行未在${MAX_RETRIES}秒内完成"
  exit 1
fi

# 查询执行记录列表
echo -e "\n[4] 查询执行记录列表..."
curl -s "$BASE_URL/api/workflow/executions?workflowId=5433" | jq '.data[:3]'

echo -e "\n======================================"
echo "测试完成！"
echo "======================================"
