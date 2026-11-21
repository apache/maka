---
name: agents-get-started
description: >
  Use when a developer wants to create a new agent project or get started
  with AgentCore. Handles framework selection, project scaffolding, first
  deploy, and first invocation. Triggers on: "build an agent", "create an
  agent", "get started", "new project", "agentcore create", "which
  framework", "Strands vs LangGraph", "hello world agent", "first agent",
  "create MCP server", "host MCP server", "agentcore dev", "dev server",
  "what port", "local development".
  Not for adding capabilities to existing projects — use agents-build
  or agents-connect. Strands vs LangGraph in a migration context routes
  to agents-build, not here. Connecting to an existing MCP server routes
  to agents-connect, not here.
allowed-tools: Read Grep Glob Bash
metadata:
  type: skill
  version: "1.0.0"
  author: aws-agentcore
  requires-cli: ">=0.9.0"
---

# get-started

Walk a developer from zero to a running agent on AWS.

## When to use

- Developer wants to build an agent on AWS and doesn't know where to start
- Developer wants to create a new AgentCore project
- Developer is choosing between frameworks (Strands, LangGraph, GoogleADK, OpenAI Agents)
- Developer just ran `agentcore create` and wants to know what to do next

Do NOT use for:

- Environment/prerequisite issues (CLI not found, credentials broken) → use `agents-debug`
- Adding capabilities to an existing project (memory, tools, policies) → use `agents-build` or `agents-connect`
- Migrating an existing Bedrock Agent → use `agents-build` (loads [`references/migrate.md`](../agents-build/references/migrate.md))

## Input

`$ARGUMENTS` can be:

- A framework preference: "using LangGraph", "with Strands"
- A protocol: "MCP server", "A2A"
- A description of what the agent should do: "a customer support agent"
- Empty — the skill will guide framework selection

## Process

### Step 0: Verify CLI version

```bash
agentcore --version
```

This skill requires v0.9.0 or later.

If the version is older:

> Your AgentCore CLI is out of date (found vX.Y.Z, need v0.9.0+).

Offer to run the update: `agentcore update`. After the update completes, re-check the version to confirm it's ≥0.9.0 before continuing. Preserve any context the developer already provided (framework preference, project name, what they want to build) so they don't have to repeat themselves.

If `agentcore` is not found:

> The AgentCore CLI isn't installed. Run `npm install -g @aws/agentcore` (requires Node.js 20+).
> If you're having trouble with installation, I can run the `agents-debug` skill (which loads [`references/doctor.md`](../agents-debug/references/doctor.md)) to diagnose your environment.

### Step 1: Determine intent — exploring or ready to create?

Before jumping into framework selection, figure out where the developer is:

**Ask the developer:** "Are you exploring options (comparing frameworks, understanding what AgentCore does) or ready to create a project?"

- **Exploring** → Go to Step 2 (framework comparison). Present the options, answer questions, and wait. Do not construct a `create` command until they signal they're ready.
- **Ready to create** → Skip to Step 3 (create the project). If they already specified a framework, skip Step 2 entirely.
- **Already has a project** → Look for `agentcore/agentcore.json` in the current directory. If found, read it and skip to Step 5 (what to do next). Don't re-scaffold.

If the developer's intent is clear from `$ARGUMENTS` (e.g., "create a Strands agent called MyBot"), skip straight to Step 3.

### Step 2: Framework selection

**Check conversation context first.** If the developer already discussed frameworks earlier in this conversation (e.g., from a previous skill invocation), don't re-present the full table. Summarize what was discussed and ask if they've decided, or if anything changed.

If this is the first time discussing frameworks, present the options:

**Supported frameworks (CLI-scaffolded, Python):**

| Framework     | CLI value             | Best for                                                     |
| ------------- | --------------------- | ------------------------------------------------------------ |
| Strands       | `Strands`             | AWS-native, simplest path, best AgentCore integration        |
| LangGraph     | `LangChain_LangGraph` | Complex graph-based workflows, existing LangChain investment |
| Google ADK    | `GoogleADK`           | Teams already using Google's agent toolkit                   |
| OpenAI Agents | `OpenAIAgents`        | Teams already using OpenAI's agent SDK                       |

**Ask the developer to choose.** Present the options and wait for their selection. Don't assume a default unless they explicitly say they have no preference.

> **Note on naming:** The CLI flag value is the exact string to pass to `--framework`. In prose use the shorter names.

**Default recommendation** (only when the developer says "no preference" or "you pick"): Strands — AWS-native framework with the tightest AgentCore integration and the most samples/docs.

**Key decision points to surface:**

- "Do you have existing agent code in LangGraph or OpenAI Agents?" → use that framework
- "Do you need complex graph-based workflows with conditional branching?" → LangGraph
- "Starting fresh with no preference?" → Strands

#### Framework not listed?

If the developer asks about a framework not in the table above, handle it:

| They ask about                       | What to say                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CrewAI, AutoGen, Semantic Kernel** | Not scaffolded by the CLI, but you can use them via the BYO Container path (below). AgentCore Runtime is framework-agnostic — any code that implements the HTTP contract works.                  |
| **Anthropic SDK / Claude Agent SDK** | This is a model SDK, not an agent framework. You can use it inside any framework (Strands, LangGraph, etc.) or standalone. For standalone use, wrap it in a container with the Runtime contract. |
| **Claude Code / Cursor / Copilot**   | These are IDE tools, not agent frameworks. They're where you _write_ agent code, not what you deploy. Pick a framework from the table above for the agent itself.                                |
| **LangChain (without LangGraph)**    | LangChain is a library, LangGraph is the agent framework built on it. The CLI scaffolds LangGraph. If you're using plain LangChain chains, the BYO Container path works.                         |
| **Custom / homegrown framework**     | BYO Container path — see below.                                                                                                                                                                  |

**BYO Container path (any framework, any language):**

For frameworks or languages not scaffolded by the CLI, AgentCore Runtime accepts any container that implements the HTTP contract (`POST /invocations`, `GET /ping`). The workflow:

1. `agentcore create --name <ProjectName> --defaults` to scaffold the project structure
2. `agentcore add agent --type byo --build Container --language <Language> --code-location <path>` to register your code
3. Write a `Dockerfile` that builds and runs your agent
4. `agentcore deploy` handles ECR push, CDK infra, and runtime creation

**Language-specific notes:**

| Language                | Recommended path                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Java (Spring Boot)      | [Spring AI SDK for AgentCore](https://aws.amazon.com/blogs/machine-learning/spring-ai-sdk-for-amazon-bedrock-agentcore-is-now-generally-available) — handles the Runtime contract, SSE streaming, and health checks. Use `--language Other --build Container`. |
| JavaScript / TypeScript | Implement the Runtime contract in Express/Fastify/etc. Use `--language TypeScript --build Container`.                                                                                                                                                          |
| Go, Rust, .NET, other   | Implement the Runtime HTTP contract. Use `--language Other --build Container`.                                                                                                                                                                                 |

The rest of this skill (deploy, status, logs, invoke) applies once the container builds correctly.

#### Framework vs. model provider — a common confusion

The framework is how your agent orchestrates (Strands, LangGraph, etc.). The model provider is which LLM it calls (Bedrock, Anthropic, OpenAI, Gemini). These are independent choices:

- Strands + Bedrock (default) — AWS-native everything
- Strands + Anthropic — Strands orchestration, direct Anthropic API for the model
- LangGraph + Bedrock — LangGraph orchestration, Bedrock for the model
- OpenAI Agents + OpenAI — OpenAI everything

If the developer says "I want to use Claude" they mean the model provider (Bedrock or Anthropic), not the framework. If they say "I want to use LangGraph" they mean the framework.

### Step 3: Create the project

Build the `agentcore create` command based on the developer's choices.

**Before constructing the command — validate the project name.** The CLI fails late: if the name is invalid, you'll see the error _after_ walking through prompts or building the full command. Save the round-trip and check these rules up front. Reject the name and ask for a new one if any rule fails:

- **Length ≤ 23 characters** (this is shorter than most developers assume — `MyCustomerSupportAgent` is 22 chars and fits; `CustomerSupportChatbot` is 22 and fits; `MyCustomerSupportBotApp` is 23 and just fits; `MyCustomerSupportChatBot` is 24 and **fails**)
- **Alphanumeric only** — no hyphens, underscores, dots, or spaces
- **Must start with a letter**

Say the count back out loud when close to the limit: "That name is 24 characters — the CLI caps project names at 23. Want to shorten it to `<suggestion>`?" Do not run the command with an invalid name on the assumption that the CLI error message will be clear — it isn't always, and the developer's mental model will be wrong for subsequent commands.

**Construct the command, then present it for confirmation before the developer runs it.** Show the full command with all flags and explain what each choice means. Wait for the developer to confirm or adjust before proceeding.

Example presentation:

> Here's the command I'd recommend based on what you've told me:
>
> ```bash
> agentcore create --name MyAgent --framework Strands --model-provider Bedrock --build CodeZip --memory none
> ```
>
> This creates a Strands agent using Bedrock models, deployed as a code zip (no Docker needed). Memory can be added later.
>
> Want to run this, or change anything?

Do NOT execute the command automatically — present it and wait.

**Minimal (defaults — Strands, Bedrock, CodeZip, no memory):**

```bash
agentcore create --name <ProjectName> --defaults
```

**With specific options:**

```bash
agentcore create \
  --name <ProjectName> \
  --framework <Framework> \
  --model-provider Bedrock \
  --build CodeZip \
  --memory none
```

**Flag reference:**

| Flag               | Values                                                        | Default                  |
| ------------------ | ------------------------------------------------------------- | ------------------------ |
| `--name`           | alphanumeric, max 23 chars                                    | prompted                 |
| `--framework`      | `Strands`, `LangChain_LangGraph`, `GoogleADK`, `OpenAIAgents` | prompted                 |
| `--protocol`       | `HTTP`, `MCP`, `A2A`                                          | `HTTP`                   |
| `--build`          | `CodeZip`, `Container`                                        | `CodeZip`                |
| `--model-provider` | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                    | prompted                 |
| `--memory`         | `none`, `shortTerm`, `longAndShortTerm`                       | prompted                 |
| `--network-mode`   | `PUBLIC`, `VPC`                                               | `PUBLIC`                 |
| `--dry-run`        | —                                                             | preview without creating |

**Guidance on choices:**

- **Protocol:** Use `HTTP` unless the developer specifically needs MCP tool serving or A2A agent-to-agent communication
- **Build:** Use `CodeZip` unless the developer needs custom system dependencies (CodeZip is faster to deploy and doesn't require Docker locally)
- **Model provider:** Use `Bedrock` unless the developer has a specific reason for another provider (Bedrock doesn't require managing API keys)
- **Memory:** Start with `none` — memory can be added later via `agents-build` (loads [`references/memory.md`](../agents-build/references/memory.md)) when the developer needs it

### Step 4: Explain what was created

After the project exists, read `agentcore/agentcore.json` and the generated code to explain the project structure.

The layout below reflects CLI v0.9.x. If the CLI version is different, run `tree <ProjectName>/ -L 3` to see the actual generated structure and explain from there.

```
<ProjectName>/
├── agentcore/
│   ├── agentcore.json      ← Project config (agents, resources)
│   ├── aws-targets.json    ← AWS account + region
│   ├── .env.local          ← Local environment variables (gitignored)
│   └── cdk/                ← CDK infrastructure (auto-managed, don't edit)
└── app/
    └── <AgentName>/
        ├── main.py          ← Your agent code — this is where you build
        ├── mcp_client/      ← Pre-wired example MCP client (see note below)
        └── pyproject.toml   ← Python dependencies
```

**Key files to highlight:**

- `app/<AgentName>/main.py` — the agent's entry point. This is where the developer adds tools, system prompts, and logic.
- `agentcore/agentcore.json` — the project config. Resources are added here via `agentcore add` commands.
- `agentcore/.env.local` — local environment variables. After deploy, resource IDs are written here for local dev.

**Heads-up on the scaffolded MCP client.** `main.py` imports `get_streamable_http_mcp_client()` from `mcp_client/client.py` and appends it to `tools`. In a fresh project, this client points at a public example MCP endpoint — so `agentcore dev` works immediately. Two things to flag:

1. **It will become a silent no-op if you repoint it at a gateway that isn't deployed yet.** The common path is to swap the example endpoint for `os.getenv("AGENTCORE_GATEWAY_<NAME>_URL")`. That env var is only populated after `agentcore deploy`. If the developer repoints and runs `agentcore dev` before deploying, `get_streamable_http_mcp_client()` returns a client with a `None` URL and the agent starts with zero MCP tools — no error, no warning. See the "Local dev gap" section in `agents-connect` for the guard pattern: `if not GATEWAY_URL: tools = []`.
2. **If the developer doesn't need MCP tools at all**, remove the `mcp_clients` list and the loop that appends it to `tools`. The scaffold includes it as a convenience, not a requirement.

The reference client code in `agents-connect` (Path A) shows the correct pattern for gateway-backed MCP clients once deploy has run.

### Step 5: Local development

```bash
agentcore dev
```

This starts a local dev server. The developer can interact with their agent immediately.

**Port the dev server binds to** (important if you're scripting `curl` calls or testing from another process):

| Protocol | Default port |
| -------- | ------------ |
| HTTP     | `8080`       |
| MCP      | `8000`       |
| A2A      | `9000`       |

The CLI prints the bound port and URL on startup — always read the actual value from the CLI output rather than hardcoding. **If the default port is already in use**, the CLI auto-increments (e.g., 8080 → 8081 → 8082), so a second dev session or a lingering process from a previous run can shift your port without warning. Use `agentcore dev --port <N>` to pin it, or grep `ps` / check the CLI banner if invocations start failing with connection-refused or exit-code-7 errors.

**Important limitations to mention:**

- Memory is not available in `agentcore dev` — it requires a deploy
- Gateway URLs are not available locally — they require a deploy
- The local server uses the model provider configured in the project

### Step 6: First deploy

When the developer is ready to deploy:

```bash
agentcore deploy
```

This will:

1. Show a preview of AWS resources to be created
2. Ask for confirmation
3. Build and deploy via CDK

**First deploy takes 3-5 minutes.** Subsequent deploys are faster.

After deploy, show them how to invoke:

```bash
agentcore invoke "Hello, what can you do?"
```

And how to check status:

```bash
agentcore status
```

### Step 7: What's next

Based on what the developer said they want to build, suggest the logical next skill:

| Developer intent                          | Next skill        | Command hint                          |
| ----------------------------------------- | ----------------- | ------------------------------------- |
| "How do I call it from my app?"           | `agents-build`    | `agentcore fetch access`              |
| "I want it to remember things"            | `agents-build`    | `agentcore add memory`                |
| "I want it to call external APIs"         | `agents-connect`  | `agentcore add gateway`               |
| "I want to restrict what it can do"       | `agents-connect`  | `agentcore add policy-engine`         |
| "I want to measure quality"               | `agents-optimize` | `agentcore add evaluator`             |
| "I want to go to production"              | `agents-harden`   | production readiness checklist        |
| "I want multiple agents working together" | `agents-build`    | `agentcore create --protocol A2A`     |
| "I need it in a VPC"                      | `agents-build`    | `agentcore create --network-mode VPC` |

Don't overwhelm — suggest one or two next steps based on what the developer actually asked for.

### Example walkthroughs

For task-framed prompts (e.g., "build a customer support agent"), load the matching example reference:

| Developer task                                     | Reference                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Customer support, chatbot, answer policy questions | [`references/example-support-agent.md`](references/example-support-agent.md) |

More examples can be added to this skill's references directory as common patterns emerge.

## Output

- A clear path from "I want to build an agent" to a running deployed agent
- The `agentcore create` command tailored to their choices
- An explanation of the generated project structure
- Concrete next steps based on their intent

## Quality criteria

- The `agentcore create` command uses only valid flags from CLI v0.9.1
- Framework recommendation is based on the developer's context, not a generic default
- The developer understands what each generated file does
- Next steps are specific to what the developer wants to build, not a generic list of all features
