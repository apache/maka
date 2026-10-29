<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# MCP tools

Maka uses the official Rust MCP SDK (`rmcp`) for stdio and Streamable HTTP tool servers. The native Agent discovers tools at activation, then exposes them to direct calls, tool discovery and both Code Mode languages through the same tool catalog, approval flow and durable journal.

## Portable configuration files

Maka reads strict JSON with a `mcpServers` object from these locations, following the same home and workspace selection as `AGENTS.md`:

| Scope | Selection order |
| --- | --- |
| User | `~/.maka/mcp.json`, `~/.maka/.mcp.json`, `~/.agents/mcp.json`, `~/.agents/.mcp.json` |
| Project | `mcp.json`, then `.mcp.json`, directly in the conversation's selected workspace |

The home is the Agent's configured `assistant.home`. No parent-directory search occurs. The first existing file in each scope wins; an empty server object masks the fallback file, and invalid/unreadable files produce an error instead of falling back. Files must be regular files within the selected directory and at most 1 MiB. Workspace-instruction preferences do not turn MCP loading off.

```json
{
  "mcpServers": {
    "docs": {
      "command": "node",
      "args": ["./server.mjs"],
      "env": {"DOCS_MODE": "local"}
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headerEnv": {"authorization": "MCP_AUTHORIZATION"}
    }
  }
}
```

Entries replace whole servers by name, in this order: installation configuration → user file → project file. `{"disabled": true}` removes an inherited server. A file entry accepts `command`, `args`, `cwd`, `env`, `passEnv`, or `url`, `headers`, `headerEnv`, plus the tool selection, read-only permission, preapproval and timeout fields shown below. Transport is inferred from `command` or `url`; accepted explicit types are `stdio`, `http`, `streamable-http` and `streamable_http`. Legacy SSE, JSONC and `${…}` environment expansion are not supported; use `passEnv` or `headerEnv` for Host environment references.

In files, omitted `cwd` means the configuration file's directory; relative `cwd` is resolved from that directory. Relative executable paths such as `./.venv/bin/mcp` resolve from the effective `cwd`; bare commands use `PATH`. Arguments are passed literally.

User files load at Agent activation. Project files require explicit user confirmation in the terminal before any server connects or starts. Sending presents the selected file, commands/endpoints, environment/header references, preapproval and read-only grants while keeping the draft. Choose **Trust configuration**, then send the draft. The `projectMcp` query and `trustProjectMcp` mutation expose the same flow to other clients; Agent-originated calls cannot grant trust.

Trust persists for the selected workspace identity, path and configuration revision. File changes require confirmation again. New messages capture the newly trusted catalog; already queued messages retain their original connections. Different workspaces have separate project catalogs even when server names match. No dedicated connection editor is included.

## Installation configuration

Set `agent.mcpServers` in the product's `installation.json`, then [author and activate the installation](../../../products/maka/bundle/README.md#author-an-installation). For an existing installation, edit the Agent instance's `configuration.mcpServers` in the [Plugins composition editor](../../../products/maka/cli/README.md), save and reactivate the Agent. The default installation list is empty.

This is an Agent configuration fragment; merge it into the existing configuration:

```json
{
  "mcpServers": [
    {
      "name": "local_docs",
      "transport": {
        "type": "stdio",
        "command": "/absolute/path/to/mcp-server",
        "args": ["--stdio"],
        "cwd": "/absolute/path/to/data",
        "passEnv": ["DOCS_API_KEY"]
      },
      "tools": ["search", "read_document"],
      "readOnlyTools": ["search", "read_document"],
      "preapproved": false,
      "startupTimeoutMs": 10000,
      "callTimeoutMs": 120000
    },
    {
      "name": "remote",
      "transport": {
        "type": "streamable_http",
        "url": "https://mcp.example.com/mcp",
        "headerEnv": {"authorization": "MCP_AUTHORIZATION"}
      },
      "tools": ["search"]
    }
  ]
}
```

`MCP_AUTHORIZATION` contains the complete header value, for example `Bearer …`, in the Host's environment. `headers` supplies literal HTTP headers; `headerEnv` resolves their values from the Host environment. Do not put credentials in URLs. HTTP follows the Host's proxy settings and does not follow redirects. OAuth login and automatic token refresh are not included.

Stdio uses a command and argument array, without a shell. `cwd` must be absolute. Only a small environment baseline (`PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `WINDIR`, `TEMP`, `TMP`, `TMPDIR`, `LANG`, `LC_ALL`) is inherited. Add explicit `env` values or names in `passEnv` as needed. The configured executable must already be installed; Maka does not download servers. Node is required only for servers that use it and for the test fixture.

## Names, trust and results

Server names contain 1–32 ASCII letters, digits, underscores or hyphens. Public names are `mcp__<server>__<tool>`; server hyphens and other characters in remote tool names become underscores. Collisions and unknown tools in explicit selections fail activation. For example, Code Mode calls `tools.mcp__local_docs__search({...})` in JavaScript or `await tools.mcp__local_docs__search({...})` in Python.

Omitting `tools` exposes all discovered tools from that server; an empty list exposes none. `readOnlyTools` explicitly trusts the named remote tools in read-only sessions and plans. Server `readOnlyHint` annotations cannot grant this permission. `preapproved` defaults to false, so calls require confirmation. Explicit preapproval skips confirmation but retains the session's live tool and workspace permission checks, including a recheck after approval. Planning still requires explicit read-only trust.

Installing an MCP server is a trust decision. Stdio servers run as the Host user, outside the session filesystem sandbox, and may access the machine independently of tool calls. HTTP servers control their own filesystem, network and effects. Maka permissions govern which MCP calls are admitted; they do not sandbox the server. Installation/user servers start at Agent activation; project servers start after configuration trust, on first use. Both occur before any per-call approval. Do not install untrusted servers or forward unrelated credentials.

The journal and Code Mode preserve the full MCP `CallToolResult` envelope, including `content`, `structuredContent`, `isError`, annotations and metadata. Text, images and audio also use the existing model-output projection. `isError: true` remains a server-reported tool error in that envelope. Resource links remain references and are not fetched automatically. Server descriptions, schemas and returned text are untrusted content.

## Lifecycle and limits

Tool schemas are frozen for each captured connection. A list-change notification retires the catalog; reactivate the Agent to discover a fresh catalog. A new protocol session gets a new binding identity, so previously queued work cannot silently acquire the replacement server. Submit a new message after reactivation. Installation/user startup failure fails Agent activation; project startup failure rejects the new message with the server name. Servers are not silently omitted. Unconfirmed startup cleanup prevents further project startup in that activation and remains a shutdown error.

Calls are sent once, with no automatic replay or expired-session recovery. Timeout/cancellation requests cancellation and retires an unsettled connection. Local stdio cleanup waits for process-group termination. Missing terminal results remain outcome-unknown; closing an HTTP connection cannot prove that external work stopped, so its cleanup remains unconfirmed. Inspect the external system before deliberately retrying an uncertain effect. Shutdown closes all owned connections.

Server configuration and discovery have no fixed count, page or byte quotas. Discovery follows cursors to completion and rejects repeated cursors. Stdio messages, HTTP JSON/error bodies and SSE events retain their complete payloads; cancellation and connection cleanup still apply. Defaults are 10 seconds for startup and 120 seconds per call; supported configured ranges are 1–300,000 ms and 1–3,600,000 ms respectively.

This integration exposes tools. It does not expose a resources/prompts browser, roots, sampling, elicitation, tasks, OAuth management or legacy HTTP+SSE transport.

## Verify

```sh
cargo test -p maka-mcp
cargo test -p maka-agent-native mcp_native_direct_and_code_mode
```

The tests use a real subprocess server and loopback HTTP/SSE server. They cover paginated discovery, results/media, explicit environment forwarding, large catalogs and complete large results, cancellation and process cleanup, direct/Code Mode calls, approvals and live permissions.
