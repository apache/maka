---
name: coordinating-multi-space-devops-agent
description: Coordinate the AWS DevOps Agent across multiple AgentSpaces from one Claude Code session — route questions to the right space (prod vs staging vs knowledge), query several spaces in parallel and synthesize, or compare findings across accounts. Use whenever the user has more than one AgentSpace configured, mentions multiple AWS accounts, or asks something like "check both prod and staging", "compare across accounts", or "ask the knowledge space".
---

# Querying multiple AgentSpaces

## Pre-flight

If `aws_devops_agent__list_agent_spaces` is **not** in your available tools, the remote MCP server is not connected. Tell the user to ask "help me set up the AWS DevOps Agent" so the `setup-devops-agent` skill auto-loads.

## Prerequisite: SigV4 auth required

Multi-space routing requires **SigV4 authentication** — Bearer tokens are scoped to a single AgentSpace and cannot route to other spaces.

Many real teams run **more than one AgentSpace** — typically a production space, a staging space, and a dedicated "knowledge" space that holds runbooks shared across accounts. Each space has its own set of associated AWS accounts, runbooks, and history.

This skill is the routing brain. Use it when the user has multiple spaces configured, or when a question genuinely spans accounts.

## Discovering spaces

```
aws_devops_agent__list_agent_spaces()
→ {"agentSpaces": [{"agentSpaceId": "as-abc123", "name": "prod"}, ...]}
```

If only one space is returned, this skill doesn't apply — use `chatting-with-aws-devops-agent` or `investigating-incidents-with-aws-devops-agent` directly (no `agent_space_id` needed).

If more than one is returned, decide whether the user's question is:

| Question shape                                          | Strategy                                                  |
| ------------------------------------------------------- | --------------------------------------------------------- |
| Scoped to one environment ("prod is broken")            | Single space — pick the matching one                      |
| Spans environments ("compare prod vs staging")          | **Parallel** — query each, synthesize                     |
| Generic knowledge ("what runbooks do we have for ECS?") | Route to the **knowledge** space if one is named that way |
| Ambiguous ("our service is slow")                       | **Ask the user** which environment, don't guess           |

## Per-session routing memory

If the user has a routing guide stored locally (e.g. `.claude/aws-agents-for-devsecops.md`, `AGENTS.md`, or per-project notes), read it once at the start of the session and use it as the routing table for the rest of the conversation. Format expected:

```markdown
| Space | AWS Profile | Agent Space ID | Purpose                                        |
| ----- | ----------- | -------------- | ---------------------------------------------- |
| prod  | acme-prod   | as-abc123      | Production incidents, customer-facing services |
| stage | acme-stage  | as-def456      | Pre-prod validation, integration testing       |
| kb    | acme-shared | as-ghi789      | Shared runbooks, cross-account knowledge       |
```

If no guide exists, run discovery:

1. `aws_devops_agent__list_agent_spaces()` → get all spaces.
2. For each space: `aws_devops_agent__chat(message="Summarize the AWS accounts, services, and runbooks you have access to.", agent_space_id="<SPACE_ID>")` → get a one-paragraph summary.
3. Offer to write the routing guide to the project (e.g. `.claude/aws-agents-for-devsecops.md`, `AGENTS.md`, or per-project notes) so future sessions skip discovery.

## Pattern A — Parallel queries, one synthesized answer

Use when the user wants a comparison: "compare prod and staging error rates", "is this issue happening in both accounts?", "audit costs across all our environments".

```
# 1. Query each space in parallel with environment-specific context
aws_devops_agent__chat(message="<question> | env=prod | <prod IaC context>", agent_space_id="PROD_ID")
→ {"executionId": "...", "answer": "..."}

aws_devops_agent__chat(message="<question> | env=stage | <stage IaC context>", agent_space_id="STAGE_ID")
→ {"executionId": "...", "answer": "..."}

# 2. Synthesize locally — present a side-by-side summary, not two separate dumps
```

**Don't just paste both responses.** Read both, identify what's the same vs. different, and tell the user the _delta_ — that's the value.

## Pattern B — Knowledge lookup, then per-space action

Use when one space holds runbooks/knowledge that informs work in another space.

```
# 1. Ask the knowledge space first
aws_devops_agent__chat(
    message="What's our standard runbook for ECS 503 errors?",
    agent_space_id="KB_ID"
)
→ {"answer": "<runbook text>"}

# 2. Apply that runbook in the target environment
aws_devops_agent__investigate(
    title="ECS 503 errors on checkout-service. [Runbook from knowledge space] <runbook text> [Local context] ...",
    agent_space_id="PROD_ID",
    priority="HIGH"
)
```

The DevOps Agent doesn't share state between spaces — you bridge it by quoting the knowledge space's response into the investigation's `title`.

## Pattern C — Targeted single-space query

Use when the user explicitly names a space or environment.

```
# Pick the matching agentSpaceId from your routing memory, pass it on the call
aws_devops_agent__chat(message="<question>", agent_space_id="<matched_space_id>")
```

If the routing is ambiguous and the user doesn't say, **ask once** — better than firing into the wrong account.

## Pattern D — Investigations don't share state

Investigations are per-space. If an issue spans accounts, you may need _two_ investigations:

```
aws_devops_agent__investigate(title="Latency spike — prod side", agent_space_id="PROD_ID", priority="HIGH")
aws_devops_agent__investigate(title="Latency spike — stage side", agent_space_id="STAGE_ID", priority="HIGH")
```

Track both `taskId`s. Poll both. Surface findings together.

This is rare — usually one space owns the problem. Don't fan out by default.

## What NOT to do

- **Don't blast every space with every question.** It's slow, expensive, and the user has to read 3× as much output.
- **Don't fan out without verifying scope.** If a space's `description` or recorded coverage doesn't mention the relevant service, skip it — sending a question into a scope-mismatched space typically hangs rather than returning "I don't know."
- **Don't fire investigations in parallel by default.** They take 5–8 minutes each. Pick the one space that owns the incident.
- **Don't silently switch spaces mid-conversation.** If a follow-up needs a different space, tell the user: "Switching to the knowledge space to look up the runbook."

## Timeout guidance

The `chat` tool buffers the full response server-side before returning. Complex cross-account queries can take 30-90s per space. If a space doesn't respond within 90s, it's likely a scope mismatch — surface a message like "Space X did not respond within 90s — skipping (likely scope mismatch)" and move on rather than hanging.

## See also

- `examples/multi-space-walkthrough.md` for a fully worked scenario (prod incident with staging comparison and knowledge-space runbook lookup).
- The `setup-devops-agent` skill for first-time configuration of multiple AgentSpaces, AWS profiles, and shell wrappers.
