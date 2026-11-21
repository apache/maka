from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Dict, Any
import uuid
import asyncio
from app.services.workflow_engine import WorkflowEngine, Workflow
from app.services.executor import get_executor_service

router = APIRouter(prefix="/api/workflow", tags=["workflow"])

# 内存存储执行结果(实际应用应使用数据库)
execution_results = {}


class ExecuteRequest(BaseModel):
    """工作流执行请求"""
    workflowId: str
    input: Dict[str, Any]


class ValidateRequest(BaseModel):
    """工作流验证请求"""
    workflow: Dict[str, Any]


@router.post("/execute")
async def execute(req: ExecuteRequest):
    """执行工作流"""
    # TODO: 从数据库查询工作流定义
    # 这里使用示例数据
    wf_data = {
        "nodes": [],
        "edges": []
    }
    
    wf = Workflow(wf_data)
    engine = WorkflowEngine(get_executor_service())
    
    exec_id = str(uuid.uuid4())
    execution_results[exec_id] = {
        "status": "pending",
        "output": None
    }
    
    # 异步执行
    async def run_workflow():
        try:
            result = await engine.execute(wf, req.input)
            execution_results[exec_id] = {
                "status": "success",
                "output": result["output"],
                "nodeStates": result["nodeStates"]
            }
        except Exception as e:
            execution_results[exec_id] = {
                "status": "failed",
                "error": str(e)
            }
    
    asyncio.create_task(run_workflow())
    
    return {
        "success": True,
        "data": {
            "executionId": exec_id,
            "status": "pending"
        }
    }


@router.get("/{execution_id}/logs")
async def get_logs(execution_id: str):
    """获取工作流执行日志"""
    if execution_id not in execution_results:
        raise HTTPException(status_code=404, detail="Execution not found")
    
    result = execution_results[execution_id]
    return {
        "success": True,
        "data": result
    }


@router.post("/validate")
async def validate(req: ValidateRequest):
    """验证工作流DAG合法性"""
    try:
        wf = Workflow(req.workflow)
        engine = WorkflowEngine(get_executor_service())
        # 尝试拓扑排序
        sorted_nodes = engine._topological_sort(wf)
        
        return {
            "success": True,
            "data": {
                "valid": True,
                "executionOrder": sorted_nodes
            }
        }
    except ValueError as e:
        return {
            "success": True,
            "data": {
                "valid": False,
                "error": str(e)
            }
        }
