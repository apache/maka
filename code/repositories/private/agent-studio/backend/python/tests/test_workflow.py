import pytest
from app.services.workflow_engine import WorkflowEngine, Workflow, ExecutionContext


def test_topological_sort_simple():
    """测试简单拓扑排序"""
    wf_data = {
        "nodes": [
            {"id": "start", "type": "StartNode"},
            {"id": "node1", "type": "LLMNode"},
            {"id": "end", "type": "EndNode"}
        ],
        "edges": [
            {"source": "start", "target": "node1"},
            {"source": "node1", "target": "end"}
        ]
    }
    
    wf = Workflow(wf_data)
    engine = WorkflowEngine(None)
    
    sorted_nodes = engine._topological_sort(wf)
    assert sorted_nodes == ["start", "node1", "end"]


def test_topological_sort_parallel():
    """测试并行节点拓扑排序"""
    wf_data = {
        "nodes": [
            {"id": "start", "type": "StartNode"},
            {"id": "node1", "type": "LLMNode"},
            {"id": "node2", "type": "LLMNode"},
            {"id": "end", "type": "EndNode"}
        ],
        "edges": [
            {"source": "start", "target": "node1"},
            {"source": "start", "target": "node2"},
            {"source": "node1", "target": "end"},
            {"source": "node2", "target": "end"}
        ]
    }
    
    wf = Workflow(wf_data)
    engine = WorkflowEngine(None)
    
    sorted_nodes = engine._topological_sort(wf)
    assert sorted_nodes[0] == "start"
    assert sorted_nodes[-1] == "end"
    assert "node1" in sorted_nodes
    assert "node2" in sorted_nodes


def test_topological_sort_cycle():
    """测试循环检测"""
    wf_data = {
        "nodes": [
            {"id": "node1", "type": "LLMNode"},
            {"id": "node2", "type": "LLMNode"}
        ],
        "edges": [
            {"source": "node1", "target": "node2"},
            {"source": "node2", "target": "node1"}
        ]
    }
    
    wf = Workflow(wf_data)
    engine = WorkflowEngine(None)
    
    with pytest.raises(ValueError, match="Cycle detected"):
        engine._topological_sort(wf)


def test_variable_resolution():
    """测试变量引用解析"""
    ctx = ExecutionContext()
    ctx.set("Start", {"result": {"text": "Hello"}})
    ctx.set("Node1", {"content": "World"})
    
    engine = WorkflowEngine(None)
    
    template = "Input: ${Start.result.text}, Output: ${Node1.content}"
    resolved = engine._resolve_variables(template, ctx)
    
    assert resolved == "Input: Hello, Output: World"


def test_variable_resolution_missing():
    """测试缺失变量引用"""
    ctx = ExecutionContext()
    ctx.set("Start", {"result": {"text": "Hello"}})
    
    engine = WorkflowEngine(None)
    
    template = "Input: ${Start.result.text}, Missing: ${Node1.content}"
    resolved = engine._resolve_variables(template, ctx)
    
    assert "Hello" in resolved
    assert "${Node1.content}" in resolved  # 保持原样


def test_condition_node():
    """测试条件节点"""
    ctx = ExecutionContext()
    ctx.set("Start", {"result": True})
    
    engine = WorkflowEngine(None)
    
    node_data = {
        "id": "cond1",
        "type": "ConditionNode",
        "data": {
            "condition": "${Start.result}"
        }
    }
    
    from app.services.workflow_engine import Node
    node = Node(node_data)
    
    result = engine._execute_condition_node(node, ctx)
    assert result["result"] is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
