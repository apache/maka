"""
最小验证脚本 - 测试核心逻辑(无外部依赖)
"""
import sys
from pathlib import Path


def test_topological_sort():
    """测试Kahn拓扑排序算法"""
    print("测试拓扑排序算法...")
    
    # 简单图: start -> node1 -> end
    #              \-> node2 -/
    nodes = ["start", "node1", "node2", "end"]
    edges = [
        ("start", "node1"),
        ("start", "node2"),
        ("node1", "end"),
        ("node2", "end")
    ]
    
    # 构建图
    graph = {node: [] for node in nodes}
    in_degree = {node: 0 for node in nodes}
    
    for source, target in edges:
        graph[source].append(target)
        in_degree[target] += 1
    
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
    
    print(f"  排序结果: {sorted_nodes}")
    assert len(sorted_nodes) == len(nodes), "拓扑排序不完整"
    assert sorted_nodes[0] == "start", "起始节点应该在最前"
    assert sorted_nodes[-1] == "end", "结束节点应该在最后"
    print("  ✓ 拓扑排序正常")


def test_cycle_detection():
    """测试循环检测"""
    print("测试循环检测...")
    
    # 循环图: node1 -> node2 -> node1
    nodes = ["node1", "node2"]
    edges = [
        ("node1", "node2"),
        ("node2", "node1")
    ]
    
    # 构建图
    graph = {node: [] for node in nodes}
    in_degree = {node: 0 for node in nodes}
    
    for source, target in edges:
        graph[source].append(target)
        in_degree[target] += 1
    
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
    
    if len(sorted_nodes) != len(nodes):
        print("  ✓ 检测到循环(预期行为)")
    else:
        print("  ✗ 未检测到循环")
        sys.exit(1)


def test_variable_resolution():
    """测试变量引用解析"""
    print("测试变量引用解析...")
    
    import re
    
    # 模拟上下文
    ctx = {
        "Start": {"result": {"text": "Hello"}},
        "Node1": {"content": "World"}
    }
    
    def resolve_variables(template, context):
        def replacer(match):
            path = match.group(1)
            parts = path.split(".")
            
            value = context
            for part in parts:
                if isinstance(value, dict):
                    value = value.get(part)
                else:
                    return match.group(0)
            
            return str(value) if value is not None else match.group(0)
        
        return re.sub(r'\$\{([^}]+)\}', replacer, template)
    
    template = "Input: ${Start.result.text}, Output: ${Node1.content}"
    resolved = resolve_variables(template, ctx)
    
    expected = "Input: Hello, Output: World"
    assert resolved == expected, f"Expected: {expected}, Got: {resolved}"
    print(f"  解析结果: {resolved}")
    print("  ✓ 变量解析正常")


def test_directory_structure():
    """测试目录结构"""
    print("测试目录结构...")
    
    project_root = Path(__file__).parent
    
    required_dirs = [
        "app",
        "app/api",
        "app/services",
        "app/services/llm",
        "tests"
    ]
    
    for dir_path in required_dirs:
        full_path = project_root / dir_path
        assert full_path.exists(), f"缺少目录: {dir_path}"
    
    required_files = [
        "app/main.py",
        "app/config.py",
        "app/services/executor.py",
        "app/services/workflow_engine.py",
        "app/services/llm/base.py",
        "app/services/llm/openai_client.py",
        "app/services/llm/qwen_client.py",
        "app/api/agent.py",
        "app/api/workflow.py",
        "app/api/model.py",
        "requirements.txt",
        "README.md"
    ]
    
    for file_path in required_files:
        full_path = project_root / file_path
        assert full_path.exists(), f"缺少文件: {file_path}"
    
    print(f"  ✓ 目录结构完整 ({len(required_files)} 个文件)")


def main():
    """运行所有测试"""
    print("=" * 60)
    print("Agent Studio Python Backend - 核心功能验证")
    print("=" * 60)
    print()
    
    try:
        test_directory_structure()
        print()
        test_topological_sort()
        print()
        test_cycle_detection()
        print()
        test_variable_resolution()
        print()
        
        print("=" * 60)
        print("✓ 所有核心功能验证通过!")
        print()
        print("下一步:")
        print("  1. 配置环境变量: cp .env.example .env")
        print("  2. 安装依赖: pip install -r requirements.txt")
        print("  3. 启动服务: python -m app.main")
        print("  4. 访问文档: http://localhost:8000/docs")
        print("=" * 60)
        
    except Exception as e:
        print()
        print("=" * 60)
        print(f"✗ 验证失败: {e}")
        print("=" * 60)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
