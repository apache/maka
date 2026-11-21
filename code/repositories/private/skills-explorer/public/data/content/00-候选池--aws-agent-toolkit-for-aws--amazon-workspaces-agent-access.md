---
name: amazon-workspaces-agent-access
description: Connects AI agents to remote Windows desktop applications on Amazon WorkSpaces Applications (AppStream 2.0) through the managed Agent Access MCP server, and guides reliable desktop automation. Covers connecting an agent to the MCP endpoint (SigV4, streaming URL, and Active Directory SAML/Domain Join), BLOCKING vs POLLING connect modes, the computer-use tools (screenshot, click, type, key, scroll), screenshot-budget and action-batching discipline, MCP tool forwarding (forwarded___ tools), session lifecycle and expire-on-delete, and troubleshooting connection errors. Use when building or debugging an agent that drives a remote Windows desktop or GUI application via WorkSpaces Applications / AppStream — including "dcv session not ready", "client_disconnected", 400 signing-region, POLLING/connection_status, SAML assertion, or forwarded tool questions. Not for Amazon WorkSpaces Personal/Core virtual desktops or general AppStream fleet administration unrelated to agent access.
version: 1
---

# Amazon WorkSpaces Applications — Agent Access

Domain expertise for connecting AI agents to remote Windows desktops on Amazon WorkSpaces Applications (AppStream 2.0) via the managed **Agent Access MCP server**, and for driving those desktops reliably.

**How it works:** Agent Access is **MCP-only** — there is no AWS CLI/SDK command that calls the desktop tools. Agents connect to `https://agentaccess-mcp.{region}.api.aws/mcp` over Streamable HTTP, SigV4-signed with service name `agentaccess-mcp`, and call MCP tools (`screenshot`, `left_click`, `type_text`, ...) to drive the desktop. The AWS CLI/SDK is used only for _setup_ — `appstream create-streaming-url`, fleet/stack configuration. `mcp-proxy-for-aws` handles the SigV4 signing.

**Recommended setup:** use `mcp-proxy-for-aws` (Python) as the transport; it signs each request and manages the DELETE lifecycle. Any MCP client that supports Streamable HTTP + SigV4 works. When running the AWS CLI/SDK _setup_ steps (create-streaming-url, stack/fleet configuration), the AWS MCP server is recommended for sandboxed execution and audit logging.

## Guardrail — where this skill's own files live (MCP vs local install)

This skill can be loaded two ways, and they resolve the skill's own bundled files from different places. Determine how the skill was loaded before reading a reference:

- **Loaded through the AWS MCP `retrieve_skill` tool:** The skill is not installed on the local filesystem. You MUST fetch each reference via `retrieve_skill` with the `file` parameter (e.g. `file="references/connection-setup.md"`), and use the returned content. Do NOT `file_read` these paths locally — they do not exist on disk.
- **Installed locally** (e.g. `.kiro/skills/amazon-workspaces-agent-access/` or `~/.claude/skills/amazon-workspaces-agent-access/`): Read files from the local skill directory using relative paths.

This distinction applies only to the skill's own packaged files. User data and session artifacts are always read from and written to the user's working directory. Never fetch or write customer data through `retrieve_skill`.

## Key facts agents get wrong (load the reference before answering in detail)

These are HTTP headers / metadata on the MCP connection — **not** tool parameters, and there is no `connect_to_desktop` tool. Do not invent tools or parameters; the desktop tools are exactly those in tools-reference.md.

- **Connect mode.** Selected by the **`X-Amzn-AgentAccess-Connect-Mode` HTTP header** (value `BLOCKING`, the default, or `POLLING`) — sent on the MCP request alongside the streaming-URL/SAML auth. It is **NOT** a JSON tool argument.
  - ❌ WRONG (common hallucination): calling a `connect_to_desktop` tool with a `connection_mode: "POLLING"` parameter, or a `session_id`/`application_id`/`user_id` argument. None of those exist.
  - ✅ RIGHT: set the `X-Amzn-AgentAccess-Connect-Mode: POLLING` header. Then `tools/list` initially returns **only** the `connection_status` tool; the agent calls `connection_status` repeatedly until its returned state is `CONNECTED`, and **only then** does `tools/list` return the full desktop tool set (`screenshot`, `left_click`, ...). (details: connection-modes.md)

    ```python
    # Correct POLLING usage — the mode is an HTTP header on the MCP connection:
    async with aws_iam_streamablehttp_client(
        endpoint="https://agentaccess-mcp.us-east-1.api.aws/mcp",  # use YOUR fleet's region
        aws_service="agentaccess-mcp", aws_region="us-east-1",  # region must match the fleet (else 400)
        headers={
            "X-Amzn-AgentAccess-Streaming-Session-Url": streaming_url,
            "X-Amzn-AgentAccess-Connect-Mode": "POLLING",   # header, not a tool arg
        },
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            # tools/list now returns ONLY connection_status until the desktop is up:
            while json.loads((await session.call_tool("connection_status", {})).content[0].text)["state"] != "CONNECTED":
                await asyncio.sleep(2)
            tools = await session.list_tools()   # now the full desktop tool set
    ```

- **Streaming session** (non-domain-joined) is the `X-Amzn-AgentAccess-Streaming-Session-Url` header. **Domain-joined** fleets instead pass the SAML assertion + stack ARN via MCP `_meta` keys `aws.agentaccess/workspacesApplicationsSamlAssertion` and `aws.agentaccess/workspacesApplicationsStackArn`. (details: connection-setup.md)
- **Expire-on-delete** is the `X-Amzn-AgentAccess-Expire-Streaming-Session-On-Delete` header (`true`/`false`; **default `false`**). Expiry happens on the client's explicit HTTP `DELETE` — `mcp-proxy-for-aws` sends it automatically on clean close. (details: session-lifecycle.md)
- **Forwarded tools are namespaced by server:** `forwarded___<server-name>___<tool-name>` (e.g. `forwarded___filesystem___read_file`) — **not** `forwarded___<tool-name>`. (details: tool-forwarding.md)
- **`COMPUTER_INPUT` requires `COMPUTER_VISION`** to also be ENABLED in the stack's `AgentAccessConfig`. (details: enabling-agent-access.md)

## Routing

| User need                                                                                                                                                                                               | Read                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Enable agent access on a stack** (`AgentAccessConfig`: COMPUTER_INPUT/COMPUTER_VISION/FORWARD_MCP_TOOLS, screen resolution/format, prerequisites) — the admin setup step before any agent can connect | [enabling-agent-access.md](references/enabling-agent-access.md)         |
| Connect an agent to the MCP server — endpoint, SigV4, streaming URL (non-domain-joined), or Active Directory SAML/Domain Join                                                                           | [connection-setup.md](references/connection-setup.md)                   |
| Choose BLOCKING vs POLLING; poll `connection_status` until the desktop is ready                                                                                                                         | [connection-modes.md](references/connection-modes.md)                   |
| The computer-use tool set (mouse, keyboard, screenshot) and their parameters                                                                                                                            | [tools-reference.md](references/tools-reference.md)                     |
| Automate reliably — screenshot budget, action batching, trusting UI actions, coordinate planning, dialog recovery                                                                                       | [automation-best-practices.md](references/automation-best-practices.md) |
| Expose your own MCP servers on the fleet as `forwarded___<server>___<tool>` tools; prefer forwarded tools for file/web tasks                                                                            | [tool-forwarding.md](references/tool-forwarding.md)                     |
| Session lifecycle — cleanup, expire-on-delete, idle timeout, one-agent-per-session                                                                                                                      | [session-lifecycle.md](references/session-lifecycle.md)                 |
| Debug an error (exact string → cause → fix): `dcv session not ready`, `client_disconnected`, 400/401/403, `Unknown tool`                                                                                | [troubleshooting.md](references/troubleshooting.md)                     |

## Security Considerations

- **The agent acts under the caller's AWS identity.** Every MCP request is SigV4-signed with service `agentaccess-mcp`; the desktop session runs with those credentials. Grant only the specific `agentaccess-mcp` actions the agent calls (e.g. `InvokeMcp`, `GetScreenshot`, `LeftClick`, `TypeText`) and scope them with the `agentaccess-mcp:StackArn` condition key — avoid a blanket `agentaccess-mcp:*` or `Resource: *`. Prefer IAM roles over long-lived users. (Full action list + example: connection-setup.md → IAM permissions.)
- **Screenshots can capture sensitive data.** `COMPUTER_VISION` captures whatever is on the desktop — treat screenshots as potentially containing PII or secrets. If screenshot storage is enabled, the S3 bucket must enforce encryption **at rest and in transit** and least-privilege access: grant the AppStream service principal only what it needs and the connecting agent only `s3:PutObject` (see enabling-agent-access.md).
- **Enable only the capabilities you need.** `COMPUTER_INPUT`, `COMPUTER_VISION`, and `FORWARD_MCP_TOOLS` are independent — do not enable input/forwarding on stacks that only need vision.
- **Tool forwarding executes code on the fleet.** Forwarded MCP servers run on the instance under the session context. Install only trusted servers system-wide, gate with `FORWARD_MCP_TOOLS`, and scope the `CallForwardedTool` IAM action by `agentaccess-mcp:StackArn` (see tool-forwarding.md).
- **Keep a human in the loop where warranted.** `UserControlMode: VIEW_STOP` lets an observer watch the live session and stop the agent. Treat agent-driven desktop actions as capable of arbitrary UI operations.
- **Audit with CloudTrail.** Agent session events are logged; tool calls are CloudTrail **data events** and require a trail configured to log them. Create a trail with `agentaccess-mcp` data events enabled, encrypt it with SSE-KMS, and add CloudWatch alarms for anomalous patterns (e.g. high screenshot volume, unexpected `TypeText`, repeated auth failures). If screenshot storage is enabled, turn on S3 server access logging for the bucket.
- **Protect federation material.** For domain-joined (SAML) fleets, safeguard the IdP signing certificate and the IAM SAML provider/role trust policy, and do not log the SAML assertion. Traffic is HTTPS + SigV4 — never disable TLS verification.
- **Treat typed input as potentially sensitive.** `type_text` can enter secrets (passwords, tokens); these may then appear in screenshots, screenshot-storage S3, and CloudTrail data events. Avoid typing long-lived secrets into the desktop where possible, and restrict who can read those sinks.
- Refer to the current [Agent Access documentation](https://docs.aws.amazon.com/appstream2/latest/developerguide/agent-access-mcp-server.html) and [AWS security best practices](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html) for the latest guidance.

**Note:** Regional endpoints, feature availability, and quotas change. When precision matters, confirm against the current [Agent Access MCP server documentation](https://docs.aws.amazon.com/appstream2/latest/developerguide/agent-access-mcp-server.html). The references focus on the values and gotchas that are easy to get wrong.
