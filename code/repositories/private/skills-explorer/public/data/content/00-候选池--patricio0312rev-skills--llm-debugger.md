---
name: llm-debugger
description: Diagnoses LLM output failures including hallucinations, constraint violations, format errors, and reasoning issues. Provides root cause classification, prompt fixes, tool improvements, and new test cases. Use for "debugging AI", "fixing prompts", "quality issues", or "output errors".
---

# LLM Debugger

Systematically diagnose and fix LLM output issues.

## Failure Taxonomy

```python
class FailureType(Enum):
    HALLUCINATION = "hallucination"
    FORMAT_VIOLATION = "format_violation"
    CONSTRAINT_BREAK = "constraint_break"
    REASONING_ERROR = "reasoning_error"
    TOOL_MISUSE = "tool_misuse"
    REFUSAL = "unexpected_refusal"
    INCOMPLETE = "incomplete_output"
```

## Root Cause Analysis

```python
def diagnose_failure(input: str, output: str, expected: dict) -> dict:
    """Identify why LLM output failed"""

    issues = []

    # Check format
    if expected.get("format") == "json":
        try:
            json.loads(output)
        except:
            issues.append({
                "type": FailureType.FORMAT_VIOLATION,
                "details": "Invalid JSON output"
            })

    # Check required fields
    if expected.get("required_fields"):
        for field in expected["required_fields"]:
            if field not in output:
                issues.append({
                    "type": FailureType.INCOMPLETE,
                    "details": f"Missing required field: {field}"
                })

    # Check constraints
    if expected.get("max_length"):
        if len(output) > expected["max_length"]:
            issues.append({
                "type": FailureType.CONSTRAINT_BREAK,
                "details": f"Output too long: {len(output)} > {expected['max_length']}"
            })

    # Check for hallucination indicators
    if contains_hallucination_markers(output):
        issues.append({
            "type": FailureType.HALLUCINATION,
            "details": "Contains fabricated information"
        })

    return {
        "has_issues": len(issues) > 0,
        "issues": issues,
        "primary_issue": issues[0] if issues else None
    }

def contains_hallucination_markers(output: str) -> bool:
    """Detect common hallucination patterns"""
    markers = [
        r'According to.*that doesn\'t exist',
        r'In \d{4}.*before that year',
        r'contradicts itself',
    ]
    return any(re.search(marker, output, re.IGNORECASE) for marker in markers)
```

## Prompt Fixes

````python
PROMPT_FIXES = {
    FailureType.FORMAT_VIOLATION: """
Add strict format instructions:
"Output MUST be valid JSON with this exact structure:
```json
{{"field1": "value", "field2": 123}}
````

Do not add any text before or after the JSON."
""",

    FailureType.HALLUCINATION: """

Add grounding instructions:
"Base your response ONLY on the provided context.
If information is not in the context, say 'I don't have that information.'
Never make up facts or details."
""",

    FailureType.CONSTRAINT_BREAK: """

Add explicit constraints:
"Your response must be:

- Maximum 200 words
- No code examples
- Professional tone only"
  """,
  FailureType.REASONING_ERROR: """
  Add step-by-step reasoning:
  "Think through this step by step:

1. First, identify...
2. Then, consider...
3. Finally, conclude..."
   """,
   }

def suggest_prompt_fix(diagnosis: dict, current_prompt: str) -> str:
"""Generate improved prompt based on diagnosis"""
primary_issue = diagnosis["primary_issue"]
if not primary_issue:
return current_prompt

    fix = PROMPT_FIXES[primary_issue["type"]]

    return f"""{current_prompt}

IMPORTANT INSTRUCTIONS:
{fix}
"""

````

## Tool Improvements

```python
def suggest_tool_fixes(diagnosis: dict, tool_schema: dict) -> dict:
    """Improve tool schema to prevent misuse"""

    fixes = {}

    for issue in diagnosis["issues"]:
        if issue["type"] == FailureType.TOOL_MISUSE:
            # Make required parameters more explicit
            fixes["parameters"] = {
                **tool_schema["parameters"],
                "description": "REQUIRED: " + tool_schema["parameters"].get("description", "")
            }

            # Add examples
            fixes["examples"] = [
                {
                    "params": {"query": "example search"},
                    "description": "Use for finding information"
                }
            ]

    return {**tool_schema, **fixes}
````

## Test Case Generation

```python
def generate_test_cases(diagnosis: dict, failed_input: str, failed_output: str) -> List[dict]:
    """Create regression test cases from failures"""

    test_cases = []

    # Test case for the specific failure
    test_cases.append({
        "input": failed_input,
        "expected_behavior": "Should not " + diagnosis["primary_issue"]["details"],
        "validation": lambda output: not has_same_issue(output, diagnosis),
    })

    # Edge cases based on failure type
    if diagnosis["primary_issue"]["type"] == FailureType.FORMAT_VIOLATION:
        test_cases.append({
            "input": failed_input,
            "validation": lambda output: is_valid_json(output),
            "description": "Output must be valid JSON"
        })

    # Similar inputs that might trigger same issue
    similar_inputs = generate_similar_inputs(failed_input)
    for inp in similar_inputs:
        test_cases.append({
            "input": inp,
            "validation": lambda output: not has_same_issue(output, diagnosis),
        })

    return test_cases
```

## Debugging Workflow

```python
def debug_llm_output(
    prompt: str,
    output: str,
    expected: dict,
    context: dict = {}
) -> dict:
    """Complete debugging workflow"""

    # 1. Diagnose issue
    diagnosis = diagnose_failure(prompt, output, expected)

    if not diagnosis["has_issues"]:
        return {"status": "ok", "diagnosis": diagnosis}

    # 2. Generate fixes
    fixed_prompt = suggest_prompt_fix(diagnosis, prompt)

    # 3. Create test cases
    test_cases = generate_test_cases(diagnosis, prompt, output)

    # 4. Test fix
    test_output = llm(fixed_prompt)
    fix_works = diagnose_failure(fixed_prompt, test_output, expected)["has_issues"] == False

    return {
        "status": "issues_found",
        "diagnosis": diagnosis,
        "fixes": {
            "prompt": fixed_prompt,
            "fix_verified": fix_works,
        },
        "test_cases": test_cases,
        "recommendations": generate_recommendations(diagnosis, context)
    }
```

## Interactive Debugging

```python
def interactive_debug():
    """Interactive debugging session"""
    print("LLM Debugger - Interactive Mode")

    prompt = input("Enter prompt: ")
    expected_output = input("Expected output format (json/text): ")

    output = llm(prompt)
    print(f"\nGenerated output:\n{output}\n")

    if input("Does this look correct? (y/n): ").lower() == 'n':
        diagnosis = diagnose_failure(prompt, output, {"format": expected_output})

        print("\nDiagnosis:")
        for issue in diagnosis["issues"]:
            print(f"- {issue['type'].value}: {issue['details']}")

        print("\nSuggested fix:")
        print(suggest_prompt_fix(diagnosis, prompt))
```

## Best Practices

1. **Reproduce consistently**: Multiple runs
2. **Isolate variables**: Test prompt changes one at a time
3. **Check examples**: Are few-shot examples clear?
4. **Validate constraints**: Are they explicit enough?
5. **Test edge cases**: Boundary conditions
6. **Log everything**: Inputs, outputs, issues
7. **Iterate systematically**: Track what fixes work

## Output Checklist

- [ ] Failure taxonomy defined
- [ ] Root cause analyzer
- [ ] Prompt fix suggestions
- [ ] Tool schema improvements
- [ ] Test case generator
- [ ] Fix verification
- [ ] Debugging workflow
- [ ] Recommendations engine
- [ ] Interactive debugger
- [ ] Logging system
