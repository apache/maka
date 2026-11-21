@echo off
REM 工作流API集成测试脚本 (Windows版本)

set BASE_URL=http://localhost:8080

echo ======================================
echo 工作流引擎 API 集成测试
echo ======================================

echo.
echo [1] 检查服务健康状态...
curl -s "%BASE_URL%/api/health"

echo.
echo [2] 执行工作流...
curl -s -X POST "%BASE_URL%/api/workflow/execute" ^
  -H "Content-Type: application/json" ^
  -d "{\"workflowId\":\"5433\",\"input\":{\"message\":\"顾客说她有两个孩子，大的上小学了\"}}" ^
  > temp_exec.json

type temp_exec.json

REM 使用PowerShell提取executionId
powershell -Command "$json = Get-Content temp_exec.json | ConvertFrom-Json; $json.data.executionId" > temp_id.txt
set /p EXECUTION_ID=<temp_id.txt

echo.
echo 执行ID: %EXECUTION_ID%

echo.
echo [3] 等待5秒后查询结果...
timeout /t 5 /nobreak

echo.
echo [4] 查询执行日志...
curl -s "%BASE_URL%/api/workflow/%EXECUTION_ID%/logs"

echo.
echo [5] 查询执行记录列表...
curl -s "%BASE_URL%/api/workflow/executions?workflowId=5433"

REM 清理临时文件
del temp_exec.json temp_id.txt

echo.
echo ======================================
echo 测试完成！
echo ======================================
