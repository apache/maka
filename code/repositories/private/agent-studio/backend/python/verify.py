"""
简单验证脚本 - 无需额外依赖
"""
import sys
from pathlib import Path

# 添加项目根目录到路径
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from app.services.workflow_engine import WorkflowEngine, Workflow, ExecutionContext


def test_topological_sort():
    """测试拓扑排序"""
    print("测试拓扑排序...")
    
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
    print(f"  排序结果: {sorted_nodes}")
    assert sorted_nodes[0] == "start"
    assert sorted_nodes[-1] == "end"
    print("  ✓ 拓扑排序正常")


def test_cycle_detection():
    """测试循环检测"""
    print("测试循环检测...")
    
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
    
    try:
        engine._topological_sort(wf)
        print("  ✗ 应该检测到循环")
        sys.exit(1)
    except ValueError as e:
        if "Cycle detected" in str(e):
            print("  ✓ 循环检测正常")
        else:
            raise


def test_variable_resolution():
    """测试变量引用解析"""
    print("测试变量引用解析...")
    
    ctx = ExecutionContext()
    ctx.set("Start", {"result": {"text": "Hello"}})
    ctx.set("Node1", {"content": "World"})
    
    engine = WorkflowEngine(None)
    
    template = "Input: ${Start.result.text}, Output: ${Node1.content}"
    resolved = engine._resolve_variables(template, ctx)
    
    expected = "Input: Hello, Output: World"
    assert resolved == expected, f"Expected: {expected}, Got: {resolved}"
    print(f"  解析结果: {resolved}")
    print("  ✓ 变量解析正常")


def test_config():
    """测试配置加载"""
    print("测试配置加载...")
    
    from app.config import get_settings
    
    settings = get_settings()
    print(f"  服务器地址: {settings.server_host}:{settings.server_port}")
    print(f"  数据库: {settings.database_url}")
    print("  ✓ 配置加载正常")


def main():
    """运行所有测试"""
    print("=" * 60)
    print("Agent Studio Python Backend - 功能验证")
    print("=" * 60)
    
    try:
        test_config()
        print()
        test_topological_sort()
        print()
        test_cycle_detection()
        print()
        test_variable_resolution()
        print()
        
        print("=" * 60)
        print("✓ 所有测试通过!")
        print("=" * 60)
        
    except Exception as e:
        print()
        print("=" * 60)
        print(f"✗ 测试失败: {e}")
        print("=" * 60)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
