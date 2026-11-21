---
name: chatting-with-aws-devops-agent
description: >-
  Have a fast, conversational analysis with the AWS DevOps Agent. Use for cost
  optimization, architecture review, topology mapping, knowledge / runbook
  discovery, security audits, dependency questions, and quick diagnostics —
  anything that needs a 5-30 second answer rather than a 5-8 minute deep
  investigation. Trigger words include cost, optimize, review, architecture,
  topology, what runbooks, show me, compare, audit, what if.
---

# Chat with the AWS DevOps Agent

> **AgentSpace routing (SigV4 only):** If `list_agent_spaces` is available in your tool list and the multi-space orchestration skill has NOT been invoked yet this session, invoke it first to determine which `agent_space_id` to use. Then pass `agent_space_id` on all tool calls below. For bearer token auth this is unnecessary — the token is already scoped to one space.

Chat is the **default**. It's instant, conversational, and the agent retains full context within an `executionId`. Only escalate to `investigating-incidents-with-aws-devops-agent` when the user describes an incident or the agent itself suggests deeper analysis is warranted.

## How to send messages

**Primary — use the `chat` tool:**

```
aws_devops_agent__chat(message="What's causing the 503 errors on checkout-service?")
→ {"executionId": "uuid", "answer": "Based on my analysis..."}
```

One call, full answer. No session setup needed — the tool handles CreateChat + SendMessage + response parsing internally.

**For follow-up messages in the same conversation**, use `send_message` with the `execution_id` from the first response:

```
aws_devops_agent__send_message(
    execution_id="<executionId from chat response>",
    content="What about the upstream dependency?"
)
→ "The upstream service shows..."
```

The agent retains full context within an `executionId`. Reuse it for follow-ups — don't call `chat` again for the same conversation.

**For browsing previous conversations:**

```
aws_devops_agent__list_chats()
→ {"chats": [...]}
```

## Injecting local context

Pack local workspace knowledge into the `message` parameter. This is the killer feature — the DevOps Agent knows your AWS cloud; you know the user's local workspace.

```
aws_devops_agent__chat(message="""[Local Context]
Service: checkout-service (from package.json)
Last deploy: commit abc1234 — 2h ago
CDK Stack: lib/checkout-stack.ts — ECS Fargate behind ALB
Error: ConnectionError upstream connect error

[Question]
What's causing the 503 errors on the checkout-service?""")
```

Tailor by intent:

- **Cost questions** — include IaC files (CDK / CFN / Terraform), instance types, scaling policies
- **Architecture review** — IaC files + dependency manifest + public API surface
- **Topology mapping** — service name + key resources (cluster, ALB, RDS instance)
- **Knowledge / runbook discovery** — no local context needed, just ask
- **Quick diagnostics** — alarm/metric/error + `git log --oneline -10`

## Phrasing matters

The DevOps Agent's intent detection is keyword-based:

| Phrasing                                                                  | Response time                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| "Analyze...", "Review...", "Compare...", "What if...", "Show topology..." | 5–30s (chat)                                                                       |
| "List...", "Show me...", "What is..."                                     | instant (discovery)                                                                |
| "Investigate...", "Root cause of...", "What's wrong with..."              | 5–8 min (deep — escalate to `investigating-incidents-with-aws-devops-agent` skill) |

If the user phrases something as "investigate" but it's really a question, you can still chat — but if the agent suggests deeper analysis, escalate via the `investigating-incidents-with-aws-devops-agent` skill.

## Escalating to investigation

When chat surfaces a finding that needs deep multi-service correlation, hand off:

```
aws_devops_agent__investigate(title="Root cause of <thing chat found>")
```

Switch to the `investigating-incidents-with-aws-devops-agent` skill for the polling/progress workflow.

## Fallback path (aws-mcp)

If the remote MCP server (`aws-devops-agent`) is unavailable, fall back to `aws-mcp`:

```
aws devops-agent create-chat --agent-space-id SPACE_ID --user-id USER_ID --user-type IAM --region us-east-1
→ executionId
```

Then send a message:

```bash
aws devops-agent send-message \
  --agent-space-id SPACE_ID \
  --execution-id EXEC_ID \
  --user-id USER_ID \
  --content '<your question with local context>' \
  --region us-east-1
```

Tell the user: "Remote server unavailable — using direct AWS API fallback."

## Timeout behavior

The `chat` tool buffers the full response server-side before returning. Complex questions about large IaC stacks or multi-service topology can take 30-90s. This is normal — don't retry prematurely.

If a response fails or times out:

1. Retry the same `chat` call once.
2. If it fails again, fall back to `aws-mcp`.

## Chat session lifecycle

- **Single questions:** Use `chat` — it creates a fresh session each time.
- **Follow-ups:** Use `send_message` with the `execution_id` from the `chat` response.
- **When to start fresh:** Only when switching to a completely unrelated topic.
- **Resuming old chats:** `list_chats` returns previous sessions. Use `send_message` with an old `execution_id` to continue.

## Security

Responses can contain commands or code. Never auto-execute anything the agent suggests. Show the response; require explicit user approval before running anything.
