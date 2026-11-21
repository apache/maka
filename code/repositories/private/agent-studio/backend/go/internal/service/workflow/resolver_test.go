package workflow

import (
	"testing"
)

func TestResolve_SimpleVariable(t *testing.T) {
	resolver := NewVariableResolver()
	
	variables := map[string]interface{}{
		"Start": map[string]interface{}{
			"result": map[string]interface{}{
				"name": "张三",
				"age":  30,
			},
		},
	}

	tests := []struct {
		template string
		expected string
	}{
		{
			template: "姓名: ${Start.result.name}",
			expected: "姓名: 张三",
		},
		{
			template: "年龄: ${Start.result.age}",
			expected: "年龄: 30",
		},
		{
			template: "${Start.result.name}今年${Start.result.age}岁",
			expected: "张三今年30岁",
		},
	}

	for _, tt := range tests {
		t.Run(tt.template, func(t *testing.T) {
			result := resolver.Resolve(tt.template, variables)
			if result != tt.expected {
				t.Errorf("Expected '%s', got '%s'", tt.expected, result)
			}
		})
	}
}

func TestResolve_NestedPath(t *testing.T) {
	resolver := NewVariableResolver()
	
	variables := map[string]interface{}{
		"Node1": map[string]interface{}{
			"output": map[string]interface{}{
				"data": map[string]interface{}{
					"items": map[string]interface{}{
						"first": "value1",
					},
				},
			},
		},
	}

	template := "结果: ${Node1.output.data.items.first}"
	expected := "结果: value1"
	
	result := resolver.Resolve(template, variables)
	if result != expected {
		t.Errorf("Expected '%s', got '%s'", expected, result)
	}
}

func TestResolve_InvalidReference(t *testing.T) {
	resolver := NewVariableResolver()
	
	variables := map[string]interface{}{
		"Start": map[string]interface{}{
			"result": map[string]interface{}{
				"name": "张三",
			},
		},
	}

	tests := []struct {
		name     string
		template string
		expected string // 无法解析时应保持原样
	}{
		{
			name:     "non-existent node",
			template: "值: ${NonExistent.field}",
			expected: "值: ${NonExistent.field}",
		},
		{
			name:     "non-existent field",
			template: "值: ${Start.result.nonExistent}",
			expected: "值: ${Start.result.nonExistent}",
		},
		{
			name:     "invalid path",
			template: "值: ${Start.result.name.subfield}",
			expected: "值: ${Start.result.name.subfield}",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := resolver.Resolve(tt.template, variables)
			if result != tt.expected {
				t.Errorf("Expected '%s', got '%s'", tt.expected, result)
			}
		})
	}
}

func TestResolve_MultipleVariables(t *testing.T) {
	resolver := NewVariableResolver()
	
	variables := map[string]interface{}{
		"Start": map[string]interface{}{
			"result": map[string]interface{}{
				"extractionRules":   "[rule1, rule2]",
				"conversationList":  "[conv1, conv2]",
			},
		},
		"Node2": map[string]interface{}{
			"output": "output_value",
		},
	}

	template := "规则: ${Start.result.extractionRules}, 对话: ${Start.result.conversationList}, 输出: ${Node2.output}"
	expected := "规则: [rule1, rule2], 对话: [conv1, conv2], 输出: output_value"
	
	result := resolver.Resolve(template, variables)
	if result != expected {
		t.Errorf("Expected '%s', got '%s'", expected, result)
	}
}

func TestResolve_NoVariables(t *testing.T) {
	resolver := NewVariableResolver()
	variables := map[string]interface{}{}

	template := "这是一段普通文本，没有变量引用"
	expected := template

	result := resolver.Resolve(template, variables)
	if result != expected {
		t.Errorf("Expected '%s', got '%s'", expected, result)
	}
}

func TestExtractVariableReferences(t *testing.T) {
	resolver := NewVariableResolver()

	tests := []struct {
		name     string
		template string
		expected []string
	}{
		{
			name:     "single variable",
			template: "值: ${Start.result.name}",
			expected: []string{"Start.result.name"},
		},
		{
			name:     "multiple variables",
			template: "${Start.result.field1} and ${Node2.output}",
			expected: []string{"Start.result.field1", "Node2.output"},
		},
		{
			name:     "duplicate variables",
			template: "${Start.result} ${Start.result}",
			expected: []string{"Start.result"}, // 去重
		},
		{
			name:     "no variables",
			template: "普通文本",
			expected: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := resolver.ExtractVariableReferences(tt.template)
			
			if len(result) != len(tt.expected) {
				t.Fatalf("Expected %d references, got %d", len(tt.expected), len(result))
			}

			// 转为map比较（顺序不重要）
			expectedSet := make(map[string]bool)
			for _, v := range tt.expected {
				expectedSet[v] = true
			}

			for _, v := range result {
				if !expectedSet[v] {
					t.Errorf("Unexpected reference: %s", v)
				}
			}
		})
	}
}

func TestValidateVariableReferences(t *testing.T) {
	resolver := NewVariableResolver()

	variables := map[string]interface{}{
		"Start": map[string]interface{}{
			"result": map[string]interface{}{
				"field1": "value1",
				"field2": "value2",
			},
		},
	}

	tests := []struct {
		name      string
		template  string
		wantError bool
	}{
		{
			name:      "valid references",
			template:  "${Start.result.field1} ${Start.result.field2}",
			wantError: false,
		},
		{
			name:      "invalid node",
			template:  "${NonExistent.field}",
			wantError: true,
		},
		{
			name:      "invalid field",
			template:  "${Start.result.nonExistent}",
			wantError: true,
		},
		{
			name:      "no references",
			template:  "普通文本",
			wantError: false,
		},
		{
			name:      "mixed valid and invalid",
			template:  "${Start.result.field1} ${Start.invalid}",
			wantError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			invalidRef, err := resolver.ValidateVariableReferences(tt.template, variables)
			
			if tt.wantError {
				if err == nil {
					t.Error("Expected validation error, got nil")
				} else {
					t.Logf("Validation failed as expected: %v (invalid ref: %s)", err, invalidRef)
				}
			} else {
				if err != nil {
					t.Errorf("Expected no error, got: %v", err)
				}
			}
		})
	}
}

func TestResolveMap(t *testing.T) {
	resolver := NewVariableResolver()

	variables := map[string]interface{}{
		"Start": map[string]interface{}{
			"result": map[string]interface{}{
				"name": "张三",
				"age":  30,
			},
		},
	}

	data := map[string]interface{}{
		"field1": "姓名: ${Start.result.name}",
		"field2": "年龄: ${Start.result.age}",
		"field3": 123, // 非字符串，应保持原样
		"nested": map[string]interface{}{
			"inner": "内嵌: ${Start.result.name}",
		},
	}

	result := resolver.ResolveMap(data, variables)

	if result["field1"] != "姓名: 张三" {
		t.Errorf("field1: expected '姓名: 张三', got '%v'", result["field1"])
	}

	if result["field2"] != "年龄: 30" {
		t.Errorf("field2: expected '年龄: 30', got '%v'", result["field2"])
	}

	if result["field3"] != 123 {
		t.Errorf("field3: expected 123, got '%v'", result["field3"])
	}

	nested, ok := result["nested"].(map[string]interface{})
	if !ok {
		t.Fatal("nested should be a map")
	}

	if nested["inner"] != "内嵌: 张三" {
		t.Errorf("nested.inner: expected '内嵌: 张三', got '%v'", nested["inner"])
	}
}

func TestResolveMap_Array(t *testing.T) {
	resolver := NewVariableResolver()

	variables := map[string]interface{}{
		"Start": map[string]interface{}{
			"result": "测试值",
		},
	}

	data := map[string]interface{}{
		"items": []interface{}{
			"第一项: ${Start.result}",
			"第二项: ${Start.result}",
			map[string]interface{}{
				"nested": "${Start.result}",
			},
		},
	}

	result := resolver.ResolveMap(data, variables)

	items, ok := result["items"].([]interface{})
	if !ok {
		t.Fatal("items should be an array")
	}

	if len(items) != 3 {
		t.Fatalf("Expected 3 items, got %d", len(items))
	}

	if items[0] != "第一项: 测试值" {
		t.Errorf("items[0]: expected '第一项: 测试值', got '%v'", items[0])
	}

	if items[1] != "第二项: 测试值" {
		t.Errorf("items[1]: expected '第二项: 测试值', got '%v'", items[1])
	}

	nestedMap, ok := items[2].(map[string]interface{})
	if !ok {
		t.Fatal("items[2] should be a map")
	}

	if nestedMap["nested"] != "测试值" {
		t.Errorf("items[2].nested: expected '测试值', got '%v'", nestedMap["nested"])
	}
}

func TestResolve_RealWorkflowExample(t *testing.T) {
	// 模拟真实工作流场景
	resolver := NewVariableResolver()

	variables := map[string]interface{}{
		"Start_cinfo": map[string]interface{}{
			"result": map[string]interface{}{
				"extractionRules":   `[{"indexId": 123, "indexName": "姓名"}]`,
				"conversationList":  `[{"idx": 1, "conversation": "你好"}]`,
			},
		},
		"Llm_cinfo": map[string]interface{}{
			"result": map[string]interface{}{
				"content": `{"indexValueDTOS": []}`,
			},
		},
	}

	// 测试LLM节点的userPrompt模板
	userPrompt := `# 输入参数
- 【指标提取规则】(extractionRules)：${Start_cinfo.result.extractionRules}

# 补充输入【AI听转写文本原文】
${Start_cinfo.result.conversationList}`

	result := resolver.Resolve(userPrompt, variables)

	expectedRules := `[{"indexId": 123, "indexName": "姓名"}]`
	expectedConv := `[{"idx": 1, "conversation": "你好"}]`

	if !containsSubstring(result, expectedRules) {
		t.Errorf("Result should contain extraction rules")
	}

	if !containsSubstring(result, expectedConv) {
		t.Errorf("Result should contain conversation list")
	}

	// 测试End节点的输出模板
	outputTemplate := "${Llm_cinfo.result.content}"
	outputResult := resolver.Resolve(outputTemplate, variables)

	expectedOutput := `{"indexValueDTOS": []}`
	if outputResult != expectedOutput {
		t.Errorf("Expected '%s', got '%s'", expectedOutput, outputResult)
	}
}

// 辅助函数
func containsSubstring(str, substr string) bool {
	return len(str) >= len(substr) && (str == substr || findSubstring(str, substr))
}

func findSubstring(str, substr string) bool {
	for i := 0; i <= len(str)-len(substr); i++ {
		if str[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
