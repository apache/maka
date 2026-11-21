# Getting Started with AgentCore

## Prerequisites
- Install the bedrock-agentcore-starter-toolkit before starting: `pip install bedrock-agentcore-starter-toolkit`

## Getting Additional Steering Files
When working with AgentCore, you should retrieve the specialized steering files for memory and gatewagsy management:

**To get the Memory steering file:**
```bash
# Ask Kiro to fetch and save the memory steering documentation
"Get the AgentCore Memory steering file and save it to .kiro/steering/"
```

**To get the Gateway steering file:**
```bash
# Ask Kiro to fetch and save the gateway steering documentation
"Get the AgentCore Gateway steering file and save it to .kiro/steering/"
```

These steering files provide detailed guidance on:
- Memory resource creation and CLI commands
- Gateway deployment and configuration
- Best practices and troubleshooting

## Memory Management
**CRITICAL:** When the user mentions "memory" or asks about AgentCore Memory, ALWAYS use the `manage_agentcore_memory` MCP tool to get complete documentation and CLI commands. This tool provides:
- Memory resource creation and configuration
- Complete CLI command reference for memory operations
- Best practices for memory integration

DO NOT attempt to manually configure memory without first consulting this tool.

**IMPORTANT - Memory and Deployment:**
- If the user has created AgentCore Memory resources but wants to deploy their agent, ALWAYS launch with `mode: NO_MEMORY` in the `.bedrock_agentcore.yaml` configuration first
- Memory integration should be added AFTER the initial successful deployment
- The agent code can still include memory session manager logic - it will simply not persist when `NO_MEMORY` is configured
- Once the agent is successfully deployed, you can update the configuration to use `STM_ONLY` or `STM_AND_LTM` and redeploy

## AgentCore Gateway for MCP Tools
**CRITICAL:** When the user mentions "gateway" or asks about AgentCore Gateway, MCP tools, or exposing APIs as tools, ALWAYS use the `manage_agentcore_gateway` MCP tool to get complete documentation and CLI commands. This tool provides:
- Gateway creation and configuration requirements
- Step-by-step CLI deployment workflow
- Target management for Lambda, OpenAPI, and Smithy models
- Authentication and authorization setup
- Common issues and troubleshooting

DO NOT attempt to manually configure gateways without first consulting this tool.

## Two Paths: New Project vs Existing Agent

### Path 1: Deploying an Existing Agent
**If you already have an agent**, DO NOT use `agentcore create`. Instead:

1. **Use the MCP tool to get deployment requirements:**
   - Call `manage_agentcore_runtime` tool to understand code requirements
   - This provides the complete deployment guide for existing agents

2. **Key requirements for existing agents:**
   - Wrap your agent with `BedrockAgentCoreApp`
   - Add `@app.entrypoint` decorator
   - Include `bedrock-agentcore` in requirements.txt
   - Then use `agentcore configure` and `agentcore launch`

**IMPORTANT:** The `agentcore create` command is ONLY for creating NEW projects from scratch. Using it on an existing agent will overwrite your code.

---

### Path 2: Create a New Project from Scratch
Use `agentcore create` to initialize a new agent project workspace.

**IMPORTANT FOR AI ASSISTANTS:** Always use `--non-interactive` mode when running this command programmatically. Interactive mode is only for human users running the command manually.

**DEFAULT BEHAVIOR:** If the user does not specify specific options (template, agent-framework, model-provider), use the defaults:
- Template: `basic`
- Agent Framework: `Strands`
- Model Provider: `Bedrock`

This means you can simply run `agentcore create --non-interactive --project-name <name>` and it will use all defaults.

**Command:**
```bash
agentcore create --non-interactive --project-name <name> --template <template> --agent-framework <framework> --model-provider <provider>
```

**Options:**
- `--project-name, -p`: Project name (alphanumeric only, max 36 chars, must start with a letter, no dashes or underscores)
- `--template, -t`: Template type - `basic` for runtime-only or `production` for monorepo with IaC (default: basic)
- `--agent-framework`: Agent SDK provider (Strands, ClaudeAgents, OpenAI, etc.) (default: Strands)
- `--model-provider, -mp`: Model provider (Bedrock, OpenAI, etc.) (default: Bedrock)
- `--provider-api-key, -key`: API key for non-Bedrock providers
- `--iac`: Infrastructure as code provider (CDK or Terraform) - required for production template
- `--non-interactive`: Run in non-interactive mode (auto-enabled when flags are provided)
- `--venv` / `--no-venv`: Automatically create a venv and install dependencies (default: true)

**Examples:**
```bash
# AI Assistant usage (non-interactive, basic template with defaults)
agentcore create --non-interactive --project-name MyAgent --template basic --agent-framework Strands --model-provider Bedrock

# With custom agent framework
agentcore create --non-interactive --project-name MyAgent --template basic --agent-framework ClaudeAgents --model-provider Bedrock

# Production template with IaC
agentcore create --non-interactive --project-name MyAgent --template production --agent-framework Strands --model-provider Bedrock --iac CDK

# Minimal command (uses all defaults: basic template, Strands, Bedrock)
agentcore create --non-interactive --project-name MyAgent

# Human user interactive mode (manual use only)
agentcore create
```

**What it creates:**
- Project directory with your chosen name
- Agent SDK boilerplate code
- Configuration files (.bedrock_agentcore.yaml)
- Dependencies setup (pyproject.toml or requirements.txt)
- Virtual environment (unless --no-venv specified)

---

### 2. Start Development Server
Navigate into your project and run `agentcore dev` to start a local development server with hot reloading.

**Command:**
```bash
cd <project-name>
agentcore dev
```

**Options:**
- `--port, -p`: Port for development server (default: 8080, auto-finds next available if taken)
- `--env, -env`: Set environment variables (format: KEY=VALUE, can be used multiple times)

**What it does:**
- Auto-detects entrypoint from `.bedrock_agentcore.yaml` or uses default `src.main:app`
- Starts uvicorn server with hot reloading using `uv run uvicorn`
- Watches for file changes and automatically reloads
- Makes your agent available at `http://localhost:<port>/invocations`
- Binds to 0.0.0.0 (accessible from all network interfaces)

**Examples:**
```bash
# Basic usage (uses port 8080 or next available)
agentcore dev

# With custom port
agentcore dev --port 3000

# With environment variables
agentcore dev --env API_KEY=abc123 --env DEBUG=true

# Multiple environment variables
agentcore dev --env KEY1=value1 --env KEY2=value2
```

**Server Details:**
- Default URL: `http://localhost:8080/invocations`
- Auto-detects entrypoint from `.bedrock_agentcore.yaml`
- Falls back to `src.main:app` if no config found or on error
- Uses `uv run uvicorn` (no separate uvicorn install needed)
- Automatically sets `LOCAL_DEV=1` environment variable

**Stopping the server:**
Press `Ctrl+C` to stop the development server.

---

### 3. Test Your Agent Locally
While the dev server is running, use `agentcore invoke --dev` to test your agent.

**Command:**
```bash
agentcore invoke --dev '{"prompt": "Hello"}'
```

**Options:**
- `--dev, -d`: Send request to local development server (required for local testing)
- `--port`: Port for local development server (default: 8080)
- `--local, -l`: Send request to a running local container
- `--session-id, -s`: Session ID for conversation continuity
- `--bearer-token, -bt`: Bearer token for OAuth authentication
- `--user-id, -u`: User ID for authorization flows
- `--headers`: Custom headers (format: 'Header1:value,Header2:value2')
- `--agent, -a`: Agent name (if multiple agents configured)

**Payload Format:**
- JSON string: `'{"prompt": "your message"}'`
- Plain text: `'your message'` (automatically wrapped in `{"prompt": "your message"}`)

**What it does:**
- Sends HTTP POST request to `http://localhost:<port>/invocations`
- Returns the agent's response in JSON format
- Shows helpful error panel if dev server isn't running

**Examples:**
```bash
# JSON payload (default port 8080)
agentcore invoke --dev '{"prompt": "What is AWS?"}'

# Plain text (auto-wrapped)
agentcore invoke --dev 'Hello, how are you?'

# Custom port
agentcore invoke --dev --port 3000 '{"prompt": "Hello"}'

# Complex JSON
agentcore invoke --dev '{"prompt": "Analyze this", "context": "additional data"}'

# With session ID for conversation continuity
agentcore invoke --dev --session-id abc123 '{"prompt": "Continue our chat"}'
```

**Expected Response:**
```
✓ Response from dev server:
{
  "response": "Agent's response here..."
}
```

**Error Handling:**
If dev server is not running, you'll see:
```
⚠️ Development Server Not Found

No development server found on http://localhost:8080

Get Started:
   agentcore create myproject
   cd myproject
   agentcore dev
   agentcore invoke --dev "Hello"
```

---

## Development Best Practices

### Testing Changes
**CRITICAL:** After every code change, you MUST test locally using `agentcore invoke --dev` to verify:
- The change works as intended
- No errors are introduced
- The agent responds correctly

### Typical Development Loop
1. Make code changes to your agent
2. Save the file (dev server auto-reloads)
3. Run `agentcore invoke --dev '{"prompt": "test message"}'`
4. Verify the response
5. Repeat until satisfied

### Troubleshooting

**Dev server won't start:**
- Verify entrypoint file exists (default: `src/main.py`)
- Check for syntax errors in your code
- Ensure dependencies are installed: `uv pip install -e .`
- Check if `.bedrock_agentcore.yaml` exists and has valid entrypoint
- Note: uvicorn is run via `uv run uvicorn`, no separate install needed

**Invoke fails:**
- Ensure dev server is running
- Check the server URL (default: `http://localhost:8080`)
- Verify payload format is valid JSON

**Port conflicts:**
- Dev server automatically finds next available port if 8080 is taken
- Check console output for actual port being used

---

## Deploying to AgentCore Runtime

### For Existing Agents (NOT created with agentcore create)
**CRITICAL:** Use the `manage_agentcore_runtime` MCP tool to get complete deployment requirements.

Quick summary:
1. **Wrap your agent code** with BedrockAgentCoreApp pattern
2. **Update requirements.txt** to include `bedrock-agentcore`
3. **Configure:** `agentcore configure --entrypoint your_agent.py --non-interactive`
4. **Deploy:** `agentcore launch`
5. **Test:** `agentcore invoke '{"prompt": "Hello"}'`

### For New Projects (created with agentcore create)
Once local development is complete:
1. **Configure for deployment:** `agentcore configure --entrypoint your_agent.py`
2. **Deploy to cloud:** `agentcore launch`
3. **Check status:** `agentcore status`
4. **Invoke in cloud:** `agentcore invoke '{"prompt": "Hello"}'`
5. **Stop session:** `agentcore stop-session` (to free resources)
6. **Destroy resources:** `agentcore destroy` (when done, use `--dry-run` first)

---

## Quick Reference

### For Existing Agents
```bash
# Get deployment requirements (use MCP tool: manage_agentcore_runtime)
# Then configure and deploy:
agentcore configure --entrypoint agent.py --non-interactive
agentcore launch
agentcore invoke '{"prompt": "Hello"}'
```

### For New Projects
```bash
# Create new project (non-interactive for AI assistants)
agentcore create --non-interactive --project-name MyAgent --template basic --agent-framework Strands --model-provider Bedrock

# Create new project (interactive for human users)
agentcore create

# Navigate to project
cd <project-name>

# Start dev server (in one terminal)
agentcore dev

# Test locally (in another terminal)
agentcore invoke --dev '{"prompt": "test"}'

# Configure for deployment
agentcore configure --entrypoint src/main.py

# Deploy to AWS
agentcore launch

# Check deployment status
agentcore status

# Invoke deployed agent
agentcore invoke '{"prompt": "Hello"}'

# Stop active session
agentcore stop-session

# Preview what would be destroyed
agentcore destroy --dry-run

# Destroy all resources
agentcore destroy

# Stop dev server
# Press Ctrl+C in the dev server terminal
```