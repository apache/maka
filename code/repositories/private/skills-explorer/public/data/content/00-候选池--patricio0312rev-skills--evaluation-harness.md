---
name: evaluation-harness
description: Builds repeatable evaluation systems with golden datasets, scoring rubrics, pass/fail thresholds, and regression reports. Use for "LLM evaluation", "testing AI systems", "quality assurance", or "model benchmarking".
---

# Evaluation Harness

Build systematic evaluation frameworks for LLM applications.

## Golden Dataset Format

```json
[
  {
    "id": "test_001",
    "category": "code_generation",
    "input": "Write a Python function to reverse a string",
    "expected_output": "def reverse_string(s: str) -> str:\n    return s[::-1]",
    "rubric": {
      "correctness": 1.0,
      "style": 0.8,
      "documentation": 0.5
    },
    "metadata": {
      "difficulty": "easy",
      "tags": ["python", "strings"]
    }
  }
]
```

## Scoring Rubrics

```python
from typing import Dict, Any

def score_exact_match(actual: str, expected: str) -> float:
    """Binary score: 1.0 if exact match, 0.0 otherwise"""
    return 1.0 if actual.strip() == expected.strip() else 0.0

def score_semantic_similarity(actual: str, expected: str) -> float:
    """Cosine similarity of embeddings"""
    actual_emb = get_embedding(actual)
    expected_emb = get_embedding(expected)
    return cosine_similarity(actual_emb, expected_emb)

def score_contains_keywords(actual: str, keywords: List[str]) -> float:
    """Percentage of required keywords present"""
    found = sum(1 for kw in keywords if kw.lower() in actual.lower())
    return found / len(keywords)

def score_with_llm(actual: str, expected: str, rubric: Dict[str, float]) -> Dict[str, float]:
    """Use LLM as judge"""
    prompt = f"""
    Grade this output on a scale of 0-1 for each criterion:

    Expected: {expected}
    Actual: {actual}

    Criteria: {', '.join(rubric.keys())}

    Return JSON with scores.
    """
    return json.loads(llm(prompt))
```

## Test Runner

```python
class EvaluationHarness:
    def __init__(self, dataset_path: str):
        self.dataset = self.load_dataset(dataset_path)
        self.results = []

    def run_evaluation(self, model_fn):
        for test_case in self.dataset:
            # Generate output
            actual = model_fn(test_case["input"])

            # Score
            scores = self.score_output(
                actual,
                test_case["expected_output"],
                test_case["rubric"]
            )

            # Record result
            self.results.append({
                "test_id": test_case["id"],
                "category": test_case["category"],
                "scores": scores,
                "passed": self.check_threshold(scores, test_case),
                "actual_output": actual,
            })

        return self.generate_report()

    def score_output(self, actual, expected, rubric):
        return {
            "exact_match": score_exact_match(actual, expected),
            "semantic_similarity": score_semantic_similarity(actual, expected),
            **score_with_llm(actual, expected, rubric)
        }

    def check_threshold(self, scores, test_case):
        min_scores = test_case.get("min_scores", {})
        for metric, threshold in min_scores.items():
            if scores.get(metric, 0) < threshold:
                return False
        return True
```

## Thresholds & Pass Criteria

```python
# Define thresholds per category
THRESHOLDS = {
    "code_generation": {
        "correctness": 0.9,
        "style": 0.7,
    },
    "summarization": {
        "semantic_similarity": 0.8,
        "brevity": 0.7,
    },
    "classification": {
        "exact_match": 1.0,
    }
}

def check_test_passed(result: Dict) -> bool:
    category = result["category"]
    thresholds = THRESHOLDS.get(category, {})

    for metric, threshold in thresholds.items():
        if result["scores"].get(metric, 0) < threshold:
            return False

    return True
```

## Regression Report

```python
def generate_regression_report(baseline_results, current_results):
    report = {
        "summary": {},
        "regressions": [],
        "improvements": [],
        "unchanged": 0
    }

    for baseline, current in zip(baseline_results, current_results):
        assert baseline["test_id"] == current["test_id"]

        baseline_passed = baseline["passed"]
        current_passed = current["passed"]

        if baseline_passed and not current_passed:
            report["regressions"].append({
                "test_id": baseline["test_id"],
                "category": baseline["category"],
                "baseline_scores": baseline["scores"],
                "current_scores": current["scores"],
            })
        elif not baseline_passed and current_passed:
            report["improvements"].append(baseline["test_id"])
        else:
            report["unchanged"] += 1

    report["summary"] = {
        "total_tests": len(baseline_results),
        "regressions": len(report["regressions"]),
        "improvements": len(report["improvements"]),
        "unchanged": report["unchanged"],
    }

    return report
```

## Continuous Evaluation

```python
# Run evaluation on every commit
def ci_evaluation():
    harness = EvaluationHarness("golden_dataset.json")
    results = harness.run_evaluation(production_model)

    # Check for regressions
    baseline = load_baseline("baseline_results.json")
    report = generate_regression_report(baseline, results)

    # Fail CI if regressions
    if report["summary"]["regressions"] > 0:
        print(f"❌ {report['summary']['regressions']} regressions detected!")
        sys.exit(1)

    print("✅ All tests passed!")
```

## Best Practices

1. **Representative dataset**: Cover edge cases
2. **Multiple metrics**: Don't rely on one score
3. **Human validation**: Review LLM judge scores
4. **Version datasets**: Track changes over time
5. **Automate in CI**: Catch regressions early
6. **Regular updates**: Add new test cases

## Output Checklist

- [ ] Golden dataset created (50+ examples)
- [ ] Multiple scoring functions
- [ ] Pass/fail thresholds defined
- [ ] Test runner implemented
- [ ] Regression comparison
- [ ] Report generation
- [ ] CI integration
- [ ] Baseline established
