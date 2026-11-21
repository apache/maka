---
name: agents-build
description: >
  Use to extend an existing agent project with memory, app integration,
  VPC, multi-agent, migration, model, browser, code interpreter,
  payments, or resource removal. Triggers: "add memory",
  "remember across sessions", "call agent from app", "invoke agent from
  code", "agent auth", "streaming", "VPC", "VPC
  connectivity", "can't reach from VPC", "multi-agent",
  "A2A", "A2A auth", "orchestrator not delegating", "specialist not
  called", "migrate Bedrock Agent", "migration issue", "change model",
  "browser tool", "code
  interpreter", "delete agent", "tear down", "agentcore remove",
  "cross-account memory",
  "add payments capability to my agent", "wire payments plugin",
  "integrate x402 payments with the agent I'm building",
  "add MPP payments", "Machine Payments Protocol".
  External APIs via Gateway: use agents-connect. New project:
  use agents-get-started. CLI/dev-server errors: use agents-debug.
  Runtime x402/MPP payments: use agents-pay. Migration-specific Strands vs
  LangGraph routes here.
allowed-tools: Read Grep Glob Bash
metadata:
  type: skill
  version: "1.0.0"
  author: aws-agentcore
  requires-cli: ">=0.9.0"
---

# build

Add capabilities to your AgentCore agent project.

## When to use

- Adding cross-session memory to your agent
- Calling your deployed agent from a web app, mobile app, or backend service
- Configuring VPC networking for private resources (RDS, internal APIs)
- Building multi-agent systems with orchestrator/specialist patterns
- Migrating an existing Bedrock Agent to AgentCore
- Adding the Browser tool so the agent can navigate websites
- Adding the Code Interpreter so the agent can execute code in a sandbox
- Adding AgentCore Payments so the agent can pay for x402- or MPP-protected APIs, tools, or content
- Removing resources from your project or tearing down a deployment

Do NOT use for:

- Connecting to external tools/APIs via Gateway (OpenAPI specs, Lambda, MCP servers, credentials, policies) → use `agents-connect`
- Scaffolding a new project → use `agents-get-started`
- Deploying → use `agents-deploy`

## Input

`$ARGUMENTS` can be:

- A capability: "memory", "integrate", "vpc", "multi-agent", "migrate", "browser", "code-interpreter", "payments", "teardown"
- A description of what they want: "remember user preferences", "call from React app", "scrape a website", "run pandas in the agent", "delete my agent", "clean up resources"
- Empty — the skill will determine the workflow from context

## Process

### Step 0: Verify CLI version

Run `agentcore --version`. This skill requires v0.9.0 or later.

If older: "Run `agentcore update` to get the latest version."

### Step 1: Read project context

Read `agentcore/agentcore.json` to understand the current project — framework, existing resources, agent configuration.

If `agentcore/agentcore.json` is not found:

1. **Check if the developer is in the wrong directory.** Look for `agentcore/agentcore.json` in parent directories (up to 3 levels). If found, tell them: "Found an AgentCore project at `<path>`. Are you working in that project?"
2. **If no project exists anywhere nearby**, ask what capability they wanted to add. Then offer two paths:
   - "I can walk you through creating a project first and then adding CAPABILITY — want to do that?" (run the get-started flow inline, then continue with the build workflow)
   - "If you already have a project elsewhere, `cd` into it and try again."

Do not just say "go use agents-get-started" and stop — that loses the developer's context about what they actually wanted to do.

### Step 2: Determine the workflow

**Important disambiguation** — before routing to a build reference, check if the prompt is actually a connect or debug concern:

- If the phrase mentions external APIs, Lambda functions, OpenAPI specs, gateways, credentials, MCP servers, or policies → this is `agents-connect`, not build
- If the developer says something is broken (wrong answers, errors, tool failures) → this is `agents-debug`, not build
- Build is for **adding new capabilities** to a working project, not fixing broken ones

Based on the developer's prompt and `$ARGUMENTS`, load the appropriate reference:

| Developer intent                                                                                                                                                               | Reference to load                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Add memory, remember things, user preferences, cross-session                                                                                                                   | [`references/memory.md`](references/memory.md)                     |
| Call agent from app, invoke from code, streaming, SDK client, agent URL, execute shell in session                                                                              | [`references/integrate.md`](references/integrate.md)               |
| VPC, private network, RDS, internal API, subnet, security group                                                                                                                | [`references/vpc.md`](references/vpc.md)                           |
| Multi-agent, orchestrator, specialist, A2A, delegation, agent handoff                                                                                                          | [`references/multi-agent.md`](references/multi-agent.md)           |
| Custom headers from caller to agent, header allowlist, tenant ID/correlation ID/trace propagation                                                                              | [`references/request-headers.md`](references/request-headers.md)   |
| Migrate Bedrock Agent, import agent, move to AgentCore                                                                                                                         | [`references/migrate.md`](references/migrate.md)                   |
| Browser tool, web navigation, form filling, scraping, Nova Act, Playwright, live view                                                                                          | [`references/browser.md`](references/browser.md)                   |
| Code Interpreter, execute code, sandbox, run Python/JS/TS, data analysis in agent, pandas                                                                                      | [`references/code-interpreter.md`](references/code-interpreter.md) |
| Payments, pay for x402 or MPP content, 402 Payment Required, Machine Payments Protocol, WWW-Authenticate: Payment, microtransactions, paid API/tool, payment manager/connector | [`references/payments.md`](references/payments.md)                 |
| Delete agent, remove resource, tear down, clean up, destroy, start fresh                                                                                                       | [`references/teardown.md`](references/teardown.md)                 |
| Change model, switch model, use Haiku/Sonnet/Nova, different model                                                                                                             | Inline — see "Changing the model" below                            |

If the developer asks about the difference between local dev and deployed (e.g., "why does my memory work after deploy but not locally?"), load [`references/local-vs-deployed.md`](references/local-vs-deployed.md) alongside the specific workflow reference.

Read the matching file into context and follow its Process section step by step — do not summarize.

If the intent is ambiguous, ask the developer which capability they want to add.

### Changing the model

The model is configured in `app/<AgentName>/model/load.py` (scaffolded by `agentcore create`). To change it:

1. Open `app/<AgentName>/model/load.py`
2. Change the `model_id` parameter in the `BedrockModel()` constructor

```python
# Default (scaffolded by CLI)
return BedrockModel(model_id="global.anthropic.claude-sonnet-4-5-20250929-v1:0")

# Switch to Haiku for cost savings
return BedrockModel(model_id="us.anthropic.claude-3-5-haiku-20241022-v1:0")

# Switch to Nova Lite
return BedrockModel(model_id="amazon.nova-lite-v1:0")
```

Cross-region inference profile prefixes (`us.`, `eu.`, `apac.`, `global.`) control where inference runs. Use `global.` for maximum throughput, or a geographic prefix for data residency. Not all models support all prefixes — check the Bedrock inference profiles docs.

After changing the model:

- Verify the model is enabled in your region: AWS Console → Amazon Bedrock → Model access
- For cross-region profiles, enable in all destination regions
- If using `agents-harden`, update the IAM policy to scope to the new model ARN
- Run `agentcore dev` to test locally, then `agentcore deploy` to update the deployed agent

No `agentcore.json` change is needed — the model is configured in code, not in the project config.

### Pre-flight: validate any `--name` before generating the CLI command

Whichever reference you load, most end up producing an `agentcore add <resource> --name <something>` command. The CLI fails **late** on invalid names — you'll see the error after walking through prompts, not before running the command. Validate up front:

| Resource                                                                                                                       | Max chars | Allowed            | Starts with |
| ------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------ | ----------- |
| Agent (`add agent`)                                                                                                            | 48        | alphanumeric + `_` | letter      |
| Memory, gateway, gateway-target, credential, evaluator, online-eval, policy, policy-engine, payment-manager, payment-connector | 48        | alphanumeric + `_` | letter      |

Count the characters before constructing the command. If the name is over the limit or contains hyphens, dots, or spaces, push back: "`<name>` is N characters / uses `-`, which the CLI rejects. How about `<suggestion>`?" Never run the command with an invalid name hoping the CLI message will be clear.

Note: `agentcore create --name` (the project name) has a **stricter 23-char limit** and does not allow underscores. That's covered in `agents-get-started`; if you see the developer re-running create, flag the 23-char limit specifically.

## Output

Depends on the workflow — see the loaded reference for specific outputs.

## Quality criteria

- The correct reference was loaded based on the developer's intent
- All output follows the loaded reference's quality criteria
- Cross-references to other skills (agents-connect, agents-deploy) are included where relevant
