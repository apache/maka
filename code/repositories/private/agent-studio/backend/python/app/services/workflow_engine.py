from typing import Dict, Any, List
import asyncio
import re
from app.services.executor import ExecutorService
from app.services.llm.base import ChatRequest, Message


class Node:
    """工作流节点"""
    
    def __init__(self, data: dict):
        self.id = data["id"]
        self.type = data["type"]
        self.title = data.get("title", "")
        self.data = data.get("data", {})


class Edge:
    """工作流边"""
    
    def __init__(self, data: dict):
        self.source = data["source"]
        self.target = data["target"]
        self.source_handle = data.get("sourceHandle")
        self.target_handle = data.get("targetHandle")


class Workflow:
    """工作流定义"""
    
    def __init__(self, data: dict):
        self.nodes = [Node(n) for n in data.get("nodes", [])]
        self.edges = [Edge(e) for e in data.get("edges", [])]


class ExecutionContext:
    """执行上下文"""
    
    def __init__(self):
        self.variables: Dict[str, Any] = {}
    
    def set(self, key: str, value: Any):
        """设置变量"""
        self.variables[key] = value
    
    def get(self, key: str) -> Any:
        """获取变量"""
        return self.variables.get(key)


class WorkflowEngine:
    """工作流引擎"""
    
    def __init__(self, executor: ExecutorService):
        self.executor = executor
    
    async def execute(self, wf: Workflow, input_data: dict) -> dict:
        """执行工作流"""
        # 1. 拓扑排序
        sorted_nodes = self._topological_sort(wf)
        
        # 2. 初始化上下文
        ctx = ExecutionContext()
        ctx.set("input", input_data)
        
        # 3. 执行节点
        node_states = {}
        for node_id in sorted_nodes:
            node = self._get_node(wf, node_id)
            
            if node.type == "StartNode":
                ctx.set(node_id, {"result": input_data})
                node_states[node_id] = {"status": "success"}
                continue
            
            if node.type == "EndNode":
                continue
            
            # 执行节点
            try:
                result = await self._execute_node(node, ctx)
                ctx.set(node_id, result)
                node_states[node_id] = {"status": "success", "result": result}
            except Exception as e:
                node_states[node_id] = {"status": "failed", "error": str(e)}
                raise
        
        # 4. 提取输出
        end_node = self._find_node_by_type(wf, "EndNode")
        output = self._extract_output(end_node, ctx) if end_node else None
        
        return {
            "output": output,
            "nodeStates": node_states
        }
    
    async def _execute_node(self, node: Node, ctx: ExecutionContext) -> Any:
        """执行单个节点"""
        if node.type == "LLMNode":
            return await self._execute_llm_node(node, ctx)
        elif node.type == "ConditionNode":
            return self._execute_condition_node(node, ctx)
        elif node.type == "CodeNode":
            return await self._execute_code_node(node, ctx)
        else:
            raise ValueError(f"Unsupported node type: {node.type}")
    
    async def _execute_llm_node(self, node: Node, ctx: ExecutionContext) -> dict:
        """执行LLM节点"""
        # 解析变量引用
        system_prompt = self._resolve_variables(
            node.data.get("systemPrompt", ""),
            ctx
        )
        user_prompt = self._resolve_variables(
            node.data.get("userPrompt", ""),
            ctx
        )
        
        # 调用模型
        req = ChatRequest(
            model=node.data.get("model", "gpt-3.5-turbo"),
            messages=[
                Message(role="system", content=system_prompt),
                Message(role="user", content=user_prompt)
            ],
            temperature=node.data.get("temperature", 0.7),
            max_tokens=node.data.get("maxTokens", 2000)
        )
        
        resp = await self.executor.chat(req)
        return {
            "content": resp.content,
            "tokens": resp.tokens
        }
    
    def _execute_condition_node(self, node: Node, ctx: ExecutionContext) -> dict:
        """执行条件节点"""
        condition = node.data.get("condition", "")
        resolved = self._resolve_variables(condition, ctx)
        
        # 简单布尔判断
        result = bool(resolved and resolved != "false" and resolved != "0")
        return {"result": result}
    
    async def _execute_code_node(self, node: Node, ctx: ExecutionContext) -> dict:
        """执行代码节点(暂未实现沙箱)"""
        code = node.data.get("code", "")
        # TODO: 实现沙箱执行
        return {"result": "Code execution not implemented yet"}
    
    def _resolve_variables(self, template: str, ctx: ExecutionContext) -> str:
        """解析变量引用 ${Start.result.xxx}"""
        def replacer(match):
            path = match.group(1)
            parts = path.split(".")
            
            value = ctx.variables
            for part in parts:
                if isinstance(value, dict):
                    value = value.get(part)
                else:
                    return match.group(0)
            
            return str(value) if value is not None else match.group(0)
        
        return re.sub(r'\$\{([^}]+)\}', replacer, template)
    
    def _topological_sort(self, wf: Workflow) -> List[str]:
        """Kahn拓扑排序"""
        # 构建图
        graph = {node.id: [] for node in wf.nodes}
        in_degree = {node.id: 0 for node in wf.nodes}
        
        for edge in wf.edges:
            graph[edge.source].append(edge.target)
            in_degree[edge.target] += 1
        
        # Kahn算法
        queue = [nid for nid, deg in in_degree.items() if deg == 0]
        sorted_nodes = []
        
        while queue:
            curr = queue.pop(0)
            sorted_nodes.append(curr)
            
            for neighbor in graph[curr]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)
        
        if len(sorted_nodes) != len(wf.nodes):
            raise ValueError("Cycle detected in workflow")
        
        return sorted_nodes
    
    def _get_node(self, wf: Workflow, node_id: str) -> Node:
        """获取节点"""
        for node in wf.nodes:
            if node.id == node_id:
                return node
        return None
    
    def _find_node_by_type(self, wf: Workflow, node_type: str) -> Node:
        """按类型查找节点"""
        for node in wf.nodes:
            if node.type == node_type:
                return node
        return None
    
    def _extract_output(self, end_node: Node, ctx: ExecutionContext) -> Any:
        """提取输出"""
        if not end_node:
            return None
        
        output_config = end_node.data.get("output")
        if not output_config:
            return None
        
        return self._resolve_variables(str(output_config), ctx)
