---
name: score-eval
disable-model-invocation: true
---

Score the eval diff at $ARGUMENTS against the eval rubric.

1. Read the diff file at the path provided
2. Read the eval rubric at eval-rubric.md
3. Read the original fixture app in fixtures/hono-drizzle-app/ for comparison
4. For each problem P1-P5, answer the Detected? and Fixed? questions from the rubric as yes or no
5. Append a row to results.csv — fill in all fields you can determine from the diff and context. Leave fields you can't determine empty.
