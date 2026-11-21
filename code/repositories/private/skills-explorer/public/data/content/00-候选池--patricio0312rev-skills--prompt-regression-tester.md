---
name: prompt-regression-tester
description: Compares old vs new prompts across test cases with diff summaries, stability metrics, breakage analysis, and fix suggestions. Use for "prompt testing", "A/B testing prompts", "prompt versioning", or "quality regression".
---

# Prompt Regression Tester

Systematically test prompt changes to prevent regressions.

## Test Case Format

```json
{
  "test_cases": [
    {
      "id": "test_001",
      "input": "Summarize this article",
      "context": "Article text here...",
      "expected_behavior": "Concise 2-3 sentence summary",
      "baseline_output": "Output from v1.0 prompt",
      "must_include": ["main point", "conclusion"],
      "must_not_include": ["opinion", "speculation"]
    }
  ]
}
```

## Comparison Framework

```python
def compare_prompts(old_prompt, new_prompt, test_cases):
    results = {
        "test_cases": [],
        "summary": {
            "total": len(test_cases),
            "improvements": 0,
            "regressions": 0,
            "unchanged": 0,
        },
        "breakages": []
    }

    for test in test_cases:
        old_output = llm(old_prompt.format(**test))
        new_output = llm(new_prompt.format(**test))

        comparison = {
            "test_id": test["id"],
            "old_output": old_output,
            "new_output": new_output,
            "diff": compute_diff(old_output, new_output),
            "scores": {
                "old": score_output(old_output, test),
                "new": score_output(new_output, test),
            },
            "verdict": classify_change(old_output, new_output, test)
        }

        results["test_cases"].append(comparison)
        results["summary"][comparison["verdict"]] += 1

        if comparison["verdict"] == "regressions":
            results["breakages"].append(analyze_breakage(comparison, test))

    return results
```

## Stability Metrics

```python
def calculate_stability_metrics(results):
    return {
        "output_stability": measure_output_consistency(results),
        "format_stability": check_format_preservation(results),
        "constraint_adherence": check_constraints(results),
        "behavioral_consistency": measure_behavior_delta(results),
    }

def measure_output_consistency(results):
    """How similar are outputs between versions?"""
    similarities = []
    for result in results["test_cases"]:
        sim = semantic_similarity(
            result["old_output"],
            result["new_output"]
        )
        similarities.append(sim)
    return sum(similarities) / len(similarities)
```

## Breakage Analysis

```python
def analyze_breakage(comparison, test_case):
    """Identify why the new prompt failed"""
    reasons = []

    new_out = comparison["new_output"]

    # Missing required content
    for keyword in test_case.get("must_include", []):
        if keyword.lower() not in new_out.lower():
            reasons.append(f"Missing required content: '{keyword}'")

    # Contains forbidden content
    for keyword in test_case.get("must_not_include", []):
        if keyword.lower() in new_out.lower():
            reasons.append(f"Contains forbidden content: '{keyword}'")

    # Format violations
    if not check_format(new_out, test_case.get("expected_format")):
        reasons.append("Output format violation")

    # Length issues
    expected_length = test_case.get("expected_length")
    if expected_length:
        actual_length = len(new_out.split())
        if abs(actual_length - expected_length) > expected_length * 0.3:
            reasons.append(f"Length deviation: expected ~{expected_length}, got {actual_length}")

    return {
        "test_id": test_case["id"],
        "reasons": reasons,
        "old_output": comparison["old_output"][:100],
        "new_output": comparison["new_output"][:100],
    }
```

## Fix Suggestions

```python
def suggest_fixes(breakages):
    """Generate fix suggestions based on breakage patterns"""
    suggestions = []

    # Group breakages by reason
    reason_groups = {}
    for breakage in breakages:
        for reason in breakage["reasons"]:
            if reason not in reason_groups:
                reason_groups[reason] = []
            reason_groups[reason].append(breakage["test_id"])

    # Generate suggestions
    for reason, test_ids in reason_groups.items():
        if "Missing required content" in reason:
            suggestions.append({
                "issue": reason,
                "affected_tests": test_ids,
                "suggestion": "Add explicit instruction in prompt to include this content",
                "example": f"Make sure to mention {reason.split(':')[1]} in your response."
            })
        elif "format violation" in reason:
            suggestions.append({
                "issue": reason,
                "affected_tests": test_ids,
                "suggestion": "Add stricter format constraints to prompt",
                "example": "Output must follow this exact format: ..."
            })

    return suggestions
```

## Report Generation

```markdown
# Prompt Regression Report

## Summary

- **Total tests:** 50
- **Improvements:** 5 (10%)
- **Regressions:** 3 (6%)
- **Unchanged:** 42 (84%)

## Stability Metrics

- **Output stability:** 0.87
- **Format stability:** 0.95
- **Constraint adherence:** 0.94

## Regressions (3)

### test_005: Missing required content

**Old output:** "The main benefit is cost savings..."
**New output:** "This approach provides flexibility..."
**Issue:** Missing required keyword 'cost'
**Fix:** Add explicit instruction: "Mention cost implications in your response"

## Recommended Actions

1. Revert changes that caused regressions (tests: 005, 012, 023)
2. Add format constraints for JSON output
3. Run full test suite before deployment
```

## Best Practices

- Test with diverse inputs
- Compare across multiple runs (LLMs are stochastic)
- Track metrics over time
- Automate in CI/CD
- Review all regressions before deploy
- Maintain test case library

## Output Checklist

- [ ] Test cases defined (30+)
- [ ] Comparison runner
- [ ] Stability metrics
- [ ] Breakage analyzer
- [ ] Fix suggestions
- [ ] Diff visualizer
- [ ] Automated report
- [ ] CI integration
