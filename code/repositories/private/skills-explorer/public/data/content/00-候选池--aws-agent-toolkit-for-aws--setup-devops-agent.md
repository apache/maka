---
name: setup-devops-agent
description: Setup and diagnostics for the AWS DevOps Agent MCP connection. Triggers when aws-devops-agent is missing from .mcp.json, when the connection is broken, or when the user says "set up devops agent" / "configure agent". Does NOT trigger if the MCP is already connected and working.
---

# AWS DevOps Agent — Claude Setup

The instructions below are specifically for setting up the AWS DevOps Agent plugin for Claude applications. For other clients, use this as a reference, but adjust the instructions based on the client's specific requirements.

## Step 0: Check if setup is needed

1/ Check if the "aws-devops-agent" MCP server is running. If it is, verify that it has a valid connection (see "Step 3: Verify connectivity").

If verification is successful, you should inform the user that the plugin is already setup using `SigV4 or Bearer Token`. Offer that you can switch the configuration to `Bearer Token or SigV4`, see "Step 2: Decide auth path" below for details.

If the user does not want to change their auth configuration, then you are DONE STOP HERE.

2/ Check for an MCP server config with a key "aws-devops-agent" in the following locations:

- Plugin scoped: `${CLAUDE_PLUGIN_ROOT}/.mcp.json`
- Project-scoped: .mcp.json (in your project directory, version-controlled)
- Project-specific: .claude/settings.local.json (in your project directory)
- User-specific local: ~/.claude/settings.local.json
- User-specific global: ~/.claude/settings.json
- Main Claude.json: ~/.claude.json
- Dedicated MCP file: ~/.claude/mcp_servers.json

Then:

- If `aws-devops-agent` key exists AND the server is connected (tools are available, see "Step 3: Verify connectivity") → Inform the user: "DevOps Agent is already configured and connected."; If Bearer Token is used in the MCP config, suggest that you can alternatively setup the plugin to use SigV4 credentials for the AWS DevOps Agent (multiple agent spaces, admin tooling). If SigV4 credentials are used in the MCP config, suggest that you can alternatively setup the plugin to use Bearer Token credentials for the AWS DevOps Agent (single agent space).
- If `aws-devops-agent` key exists but is failing → continue to "Step 1: Diagnose current state"
- If `aws-devops-agent` key does NOT exist → continue to "Step 1: Diagnose current state"

---

## Step 1: Diagnose current state

Run these checks:

```bash
# Bearer token
echo "DEVOPS_AGENT_TOKEN: $([ -n "$DEVOPS_AGENT_TOKEN" ] && echo 'set' || echo 'not set')"
echo "DEVOPS_AGENT_REGION: ${DEVOPS_AGENT_REGION:-not set}"

# SigV4 dependencies
uvx --version 2>&1

# AWS credentials
aws sts get-caller-identity 2>&1
```

Determine:

- `bearer_ready` = `DEVOPS_AGENT_TOKEN` is set AND `DEVOPS_AGENT_REGION` is set
- `sigv4_ready` = `aws sts get-caller-identity` succeeds AND `uvx` is installed

---

## Step 2: Decide auth path

After diagnostics, ALWAYS ask the user which path they want — even if only one is available. Present what you found and let them choose.

The user may want to use bearer token if they only have access to the operator app for an agent space.

The user may want to use SigV4 if they use multiple agent spaces and/or have admin permissions to manage agent spaces.

| Bearer ready | SigV4 ready | Action                                                                                                                                                                                                                                               |
| :----------: | :---------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     yes      |     yes     | "You have both a bearer token and AWS credentials configured. Which would you prefer for the DevOps Agent? **Bearer token** (single agent space) or **AWS credentials / SigV4** (multiple agent spaces and admin tooling)?"                          |
|     yes      |     no      | "You have a bearer token configured. Would you like me to set up the DevOps Agent using your **Bearer token** (single agent space)? Or would you prefer to configure **AWS credentials / SigV4** instead (multiple agent spaces and admin tooling)?" |
|      no      |     yes     | "You have valid AWS credentials. Would you like me to set up the DevOps Agent using **SigV4** (multiple agent spaces and admin tooling)? Or would you prefer to set up a **Bearer token** instead (single agent space)?"                             |
|      no      |     no      | "Neither a bearer token nor AWS credentials are configured. Would you like to connect via **Bearer token** (single agent space) or **AWS credentials / SigV4** (multiple agent spaces and admin tooling)?" Then guide them through the chosen path.  |

If the user would like to setup a bearer token, refer them to the AWS docs for [Connect to DevOps Agent remote servers](https://docs.aws.amazon.com/devopsagent/latest/userguide/accessing-devops-agent-connect-to-devops-agent-remote-servers.html#create-an-access-token)
or walk them through the steps to create a access token from this document.

**Do NOT proceed to Step 3 until the user confirms their choice.**

---

## Step 3: Verify connectivity

If the "aws-devops-agent" MCP server is already running, check if you can list tools. If you can, then you have verified the connection.

Otherwise, proceed.

Verify BEFORE writing `.mcp.json`. This confirms the credentials work against the live endpoint. Or use this to verify an existing MCP server config.

### Bearer verification

```bash
curl -s -w "\nHTTP_STATUS: %{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DEVOPS_AGENT_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "https://connect.aidevops.${DEVOPS_AGENT_REGION}.api.aws/mcp"
```

| Result                          | Meaning                  | Action                                                               |
| ------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| HTTP 200 + `result.tools` array | Success                  | Proceed to Step 4                                                    |
| HTTP 401                        | Token invalid or expired | Tell user to create a new token in the Operator Web App              |
| HTTP 403                        | Token scope insufficient | Tell user token needs `agent:read` + `agent:operate` scopes          |
| Connection refused / timeout    | Endpoint unreachable     | If SigV4 is available, offer fallback. Otherwise report unavailable. |

### SigV4 verification

```bash
timeout 30 bash -c '
{
echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"setup-check\",\"version\":\"1.0\"}}}"
sleep 0.5
echo "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
sleep 0.5
echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}"
sleep 8
} | uvx mcp-proxy-for-aws-cli@latest "https://connect.aidevops.${DEVOPS_AGENT_REGION}.api.aws/mcp" --service aidevops --region "$DEVOPS_AGENT_REGION"
'
```

> **Note:** The first run may take 10-15s as `uvx` downloads `mcp-proxy-for-aws-cli` and its dependencies. Subsequent runs are near-instant.

| Result                              | Meaning                                     | Action                                                          |
| ----------------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Second line contains `result.tools` | Success                                     | Proceed to Step 4                                               |
| No output / timeout                 | Credentials invalid or endpoint unreachable | Check `aws sts get-caller-identity` again                       |
| `ExpiredTokenException` in stderr   | AWS session expired                         | Tell user to re-authenticate (`aws sso login` or refresh creds) |
| `AccessDeniedException`             | Missing IAM permissions                     | User needs DevOps Agent permissions on their role               |

---

## Step 4: Confirm and write `.mcp.json`

Before writing, confirm with the user:

> "I've verified connectivity. I'll now add the **[Bearer token / SigV4]** MCP server to the plugin's `.mcp.json`. Proceed?"

Only write after the user confirms. Write ONE server entry — never both. Install the MCP config in `${CLAUDE_PLUGIN_ROOT}/.mcp.json`. You can also offer to install the MCP server at the workspace level. The installation options are:

- Plugin scoped: `${CLAUDE_PLUGIN_ROOT}/.mcp.json` (default)
- Project-scoped: .mcp.json (in your project directory, version-controlled)
- Project-specific: .claude/settings.local.json (in your project directory)

### Bearer config

```json
{
  "mcpServers": {
    "aws-devops-agent": {
      "type": "http",
      "url": "https://connect.aidevops.${DEVOPS_AGENT_REGION}.api.aws/mcp",
      "headers": {
        "Authorization": "Bearer ${DEVOPS_AGENT_TOKEN}"
      },
      "timeout": 120000
    }
  }
}
```

### SigV4 config

Replace `<REGION>` with the user's actual region:

```json
{
  "mcpServers": {
    "aws-devops-agent": {
      "command": "uvx",
      "timeout": 120000,
      "args": [
        "mcp-proxy-for-aws-cli@latest",
        "https://connect.aidevops.<REGION>.api.aws/mcp",
        "--service",
        "aidevops",
        "--region",
        "<REGION>"
      ]
    }
  }
}
```

### Fallback (aws-mcp)

Only add if the primary `aws-devops-agent` endpoint is unreachable AND SigV4 credentials are available:

```json
{
  "mcpServers": {
    "aws-mcp": {
      "command": "uvx",
      "timeout": 100000,
      "args": [
        "mcp-proxy-for-aws-cli@latest",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--metadata",
        "AWS_REGION=us-east-1"
      ]
    }
  }
}
```

For Sigv4 only: After writing the new MCP config, inform the user that the MCP server has been written successfully. Proceed to the next step.

---

## Step 5: Multi-space routing (SigV4 only)

After successful SigV4 setup, discover and configure AgentSpace routing:

1. Call `list_agent_spaces` via the newly connected MCP to discover available spaces
2. Present the list to the user
3. If multiple spaces exist, write a routing guide to `.claude/aws-agents-for-devsecops.md`:

```markdown
# AWS DevOps Agent — Routing Guide

| Space  | Agent Space ID | Purpose    |
| ------ | -------------- | ---------- |
| <name> | <id>           | <ask user> |
```

1. Instruct: pass `agent_space_id` on every tool call when targeting a specific space.

---

## Step 6: Reload plugin

Inform the user that they will need to run /reload-plugins to start the new MCP server. You may
need to prompt the user to run it. Also mention that after restarting the MCP server they should try the following prompts:

- setup multi-space routing (SigV4 only)
- <list skill and prompt suggestions from ${CLAUDE_PLUGIN_ROOT}/README.md>

---

## Bearer token guidance (for users who need to create one)

1. Open the AWS DevOps Agent **Operator Web App** for your AgentSpace
2. Navigate to **Settings → Access tokens → Generate token**
3. Create a token with Permissions: **`Operate`**
4. Set environment variables:

   ```bash
   export DEVOPS_AGENT_TOKEN="<your-token>"
   export DEVOPS_AGENT_REGION="<your-region>"
   ```

   Available regions: https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent-supported-regions.html

5. Restart Claude Code (it reads env vars from the shell that launched it)

> **Important:** Without `Operate` permissions, the `chat` and `investigate` tools will be completely invisible — not just fail, but absent from the tool list.

---

## SigV4 guidance (for users who need to configure AWS credentials)

1. Install `uvx` if not present:
   - macOS: `brew install uv`
   - Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. Configure AWS credentials:

   ```bash
   aws configure sso --profile devops-agent
   aws sso login --profile devops-agent
   export AWS_PROFILE=devops-agent
   ```

3. Set the region:

   ```bash
   export DEVOPS_AGENT_REGION="<your-region>"
   ```

4. Verify: `aws sts get-caller-identity`
5. The IAM role must have DevOps Agent permissions (e.g., managed policy with aidevops access)

> **Important:** Unset `DEVOPS_AGENT_TOKEN` when using SigV4. If both are set, clients may attempt bearer auth instead of the signing proxy.

---

## Troubleshooting

| Error                           | Cause                                      | Fix                                                         |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| No tools visible                | Token not set or Claude Code not restarted | Set `DEVOPS_AGENT_TOKEN` + `DEVOPS_AGENT_REGION`, restart   |
| HTTP 401                        | Token invalid/expired                      | Create new token in Operator Web App                        |
| `chat`/`investigate` missing    | Token scope is `agent:read` only           | Create token with `agent:operate` scope                     |
| Connection refused / timeout    | Endpoint unreachable                       | Check network; if SigV4 available, offer `aws-mcp` fallback |
| `ExpiredTokenException`         | AWS session credentials expired            | `aws sso login` or refresh credentials                      |
| `AccessDeniedException` (SigV4) | Missing IAM permissions                    | Use a role with DevOps Agent access                         |
| Proxy won't start               | `uvx` not installed                        | `brew install uv` (macOS) or install per platform           |
| Tools appear but calls timeout  | Normal for `chat` (5-30s)                  | Ensure `"timeout": 120000` in mcp.json                      |
