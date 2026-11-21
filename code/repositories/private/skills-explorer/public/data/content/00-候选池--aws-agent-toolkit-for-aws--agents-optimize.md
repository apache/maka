---
name: agents-optimize
description: >
  Use when measuring or improving agent quality and performance — set up
  evaluators, online monitoring, CI/CD quality gates, observability, or
  cost optimization. Triggers on: "evaluate my agent", "add evaluator",
  "measure quality", "quality gate", "run evals", "agent too slow",
  "why is it slow", "reduce latency", "set up observability", "CloudWatch
  dashboard", "how much does my agent cost", "cost optimization", "logs
  not showing up", "logs missing", "spans not found", "eval failing",
  "eval error", "dev traces", "local traces", "agentcore dev traces",
  "traces to CloudWatch".
  Not for debugging errors or crashes — use agents-debug. Slow but
  correct routes here; broken routes to debug.
allowed-tools: Read Grep Glob Bash
metadata:
  type: skill
  version: "1.0.0"
  author: aws-agentcore
  requires-cli: ">=0.9.0"
---

# optimize

Measure and improve your AgentCore agent's quality through evaluation, monitoring, and observability.

## When to use

- You want to know if your agent is giving good answers
- You want to set up continuous quality monitoring in production
- You want to add a quality gate to your CI/CD pipeline
- You want to understand agent behavior through logs, metrics, and traces
- You want to set up CloudWatch dashboards or X-Ray tracing

Do NOT use for:

- Debugging a specific broken agent (wrong answers, errors) → use `agents-debug`
- Production security hardening (IAM, auth) → use `agents-harden`

## Input

`$ARGUMENTS` can be:

- An eval goal: "add a quality gate", "set up monitoring"
- An observability goal: "set up CloudWatch dashboard", "understand my traces"
- A specific evaluator: "llm-as-a-judge", "code-based"
- Empty — the skill will guide based on project context

## Process

### Step 0: Verify CLI version

Run `agentcore --version`. This skill requires v0.9.0 or later.

### Step 1: Read project context

Read `agentcore/agentcore.json` to understand existing evaluators, online eval configs, and agent setup.

If `agentcore/agentcore.json` is not found:

> "This skill requires an AgentCore project. Use `agents-get-started` to create one."

### Step 2: Determine the workflow

| Developer intent                                                        | Action                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Measure quality, add evaluator, run eval, CI/CD gate, online monitoring | Load [`references/evals.md`](references/evals.md) and follow its workflow                 |
| Set up observability, CloudWatch, X-Ray, logs, metrics, dashboards      | Load [`references/observability.md`](references/observability.md) and follow its workflow |
| Understand or reduce AgentCore costs                                    | Load [`references/cost.md`](references/cost.md)                                           |
| Both — "I want to understand and improve my agent"                      | Start with observability setup, then add evals                                            |

### Step 3: Follow the loaded reference

The reference file contains the full procedure. Follow it step by step.

### Cross-references

- After setting up evals, suggest `agents-harden` for production readiness
- If eval results reveal agent issues, suggest `agents-debug` for root cause analysis
- If the developer needs to add capabilities first, suggest `agents-build`

## Output

Depends on the workflow — see the loaded reference for specific outputs.

## Quality criteria

- Evaluator configuration uses only valid CLI flags
- Online eval sampling rate is appropriate (not 100% in production without discussion)
- CI/CD quality gate has a clear pass/fail threshold
- Observability setup includes both tracing and logging
- The developer understands the eval data delay: **~10 seconds put-to-get, end-to-end** — one ingestion step covers both trace reads and eval queries; there is no separate indexing wait
