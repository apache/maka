---
name: agents-connect
description: >
  Use when connecting your agent to external APIs, tools, or services via
  Gateway, or restricting tool access with Cedar policies. Handles gateway
  setup, target types, outbound auth (OAuth, API key, IAM), credentials,
  and Cedar policy authoring. Triggers on: "connect to API", "add gateway",
  "connect to MCP server", "Lambda tools", "OpenAPI", "gateway target",
  "Cedar policy", "restrict tools", "policy engine", "gateway auth error",
  "store API key", "outbound credential", "env var API key", "API key None
  after deploy", "credential not available after deploy",
  "should this be a gateway target", "give my agent tools",
  "add tools to agent".
  Not for inbound auth (who can call your agent) — use agents-harden.
  Not for debugging agent behavior — use agents-debug.
  Not for VPC networking errors (agent can't reach APIs due to VPC) — use
  agents-build. Not for creating or hosting a new MCP server project — use
  agents-get-started.
allowed-tools: Read Grep Glob Bash
metadata:
  type: skill
  version: "1.0.0"
  author: aws-agentcore
  requires-cli: ">=0.9.0"
---

# connect

Give your AgentCore agent access to external APIs, tools, and services via the AgentCore Gateway — and control what it can access with Cedar policies.

## When to use

- You want your agent to call an external API or MCP server
- You want to expose Lambda functions as agent tools
- You have an OpenAPI spec you want to turn into agent tools
- Your agent needs credentials to call an external service
- You want to restrict which tools your agent can call (Cedar policies)
- You want role-based or amount-based access control on tool calls
- A gateway connection, tool call, or policy authorization is failing

For adding Cedar policies to control tool access, load [`references/policy.md`](references/policy.md).

## Input

`$ARGUMENTS` is optional:

```
/connect                    # interactive — asks what you're connecting to
/connect mcp                # MCP server setup
/connect lambda             # Lambda function as tools
/connect openapi            # OpenAPI schema as tools
/connect credential         # Add a credential for outbound auth
```

## Process

### Step 0: Verify CLI version

Run `agentcore --version`. This skill requires v0.9.0 or later. If the version is older, tell the developer to run `agentcore update` before proceeding.

### Step 1: Read the project

Read `agentcore/agentcore.json` to understand:

- What framework the project uses
- What gateways and targets are already configured (in the `agentCoreGateways` array)

**If no project context:** Ask what they're trying to connect to and proceed with the appropriate pattern.

### Step 2: Identify what they're connecting to

Ask (or infer from `$ARGUMENTS`):

> "What are you connecting your agent to?
>
> 1. An external MCP server (e.g., a third-party tool provider)
> 2. A Lambda function you've written
> 3. An API with an OpenAPI spec
> 4. An AWS API Gateway REST API
> 5. An external service with no OpenAPI spec, MCP server, or Lambda in front of it — and you can't add one"

**Options 1–4 front the service as a Gateway target.** This is the default path: the gateway handles outbound auth via its credential providers (so the agent code never sees the secret), the tool becomes discoverable over MCP, and policy engines can authorize or deny calls at the edge. Pick the target type that matches the service.

**Option 5 is Path D** — register a credential and call the API directly from agent code. This is the fallback when fronting isn't practical; the skill walks through when it's appropriate and when it isn't.

---

## Default: prefer a Gateway target over direct API calls in code

Before jumping into paths, set expectations. Most "my agent needs to call X" requests land on a Gateway target — not on `httpx` inside the entrypoint.

**Why Gateway is the default:**

- **Credential injection at the edge.** Gateway's credential providers (OAuth, API key, IAM) attach auth to the outbound request. The agent code calls `session.call_tool(...)` — it never touches the secret. Agent code that does `client = openai.OpenAI(api_key=...)` is one leaked prompt / log line / traceback away from exfiltrating the key.
- **Discoverable tool catalog.** Tools are listed by the MCP server; the framework (Strands, LangGraph, etc.) binds them automatically. Adding a tool is an `agentcore add gateway-target` + redeploy, not a code change.
- **Policy enforcement.** Cedar policies can authorize or deny tool calls per principal, per tool, per argument value. This is impossible when tool calls are buried in `httpx.post(...)` inside agent code.
- **Semantic search.** Once the catalog has 20+ tools, `x_amz_bedrock_agentcore_search` selects the relevant ones per turn.

**When a direct API call in agent code is the right answer:**

| Situation                                                                                 | Why Gateway isn't right                          | What to do                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Streaming/bidirectional protocol (SSE with live output, WebSockets, WebRTC, long-polling) | Gateway's MCP transport doesn't front those yet  | Direct call, Path D                                                                                         |
| Latency hot path where the MCP hop is measurable and the trade-off is accepted            | Extra network hop                                | Direct call, Path D, with measurement to back the decision                                                  |
| Vendor proprietary protocol / binary SDK                                                  | No HTTP surface for Gateway to front             | Use the vendor SDK directly, Path D for any secrets                                                         |
| Calling another agent via A2A                                                             | A2A is HTTP-by-design and has its own auth model | [`agents-build/references/multi-agent.md`](../agents-build/references/multi-agent.md), not a Gateway target |
| AWS service SDK (S3, DynamoDB, SQS, etc.) the runtime already has IAM for                 | No auth value in fronting — adds hops            | Direct boto3 call with the runtime's execution role                                                         |

For **every other case**, recommend a Gateway target. If the developer insists on a direct call, ask which of the five situations above applies. If none, steer them back to a Gateway target.

**Triage heuristic:**

- Service has an MCP server → Path A
- Service is a Lambda function you control → Path B
- Service has an OpenAPI spec (or you can generate one — FastAPI, ASP.NET, Spring, etc. generate OpenAPI automatically) → Path C
- Service is already fronted by API Gateway → Path C (`--type api-gateway`)
- None of the above and you can't add one → Path D

---

## What Gateway is — and what it isn't

Before choosing a target type, get the mental model right. Most Gateway confusion comes from having it flipped.

**Gateway hosts tools for your agent to call.** The direction is:

```
Your agent  ───→  Gateway  ───→  Lambda function / OpenAPI API / MCP server / Smithy model
             (agent calls tool)
```

The agent is the client. The Gateway fronts a catalog of tools. Each tool is a Gateway target (Lambda, OpenAPI, MCP server, API Gateway, Smithy).

**Gateway is not an inbound reverse proxy for your agent.** If you're building an app that needs to invoke your agent, the app does not go through a Gateway. The direction is:

```
Your app  ───→  AgentCore Runtime  (direct invoke_agent_runtime call)
```

The app signs the invocation with IAM SigV4 or presents a JWT. See [`agents-build/references/integrate.md`](../agents-build/references/integrate.md) for the app-side patterns.

### When you're confused about which direction you need

Ask: **who is calling whom?**

- "My agent needs to look up weather data" → agent is calling a tool → **Gateway target** (this skill, Paths A/B/C)
- "My FastAPI app needs to call my agent" → app is calling the agent → **direct invocation** (not Gateway; use [`agents-build/references/integrate.md`](../agents-build/references/integrate.md))
- "My agent needs to fetch data from my FastAPI app" → agent is calling the app as a tool → **Gateway target** with the app exposed as an OpenAPI or REST target (Path C with your FastAPI's `/openapi.json`)

If you catch yourself configuring a Gateway target whose endpoint is `bedrock-agentcore.<region>.amazonaws.com` or pointing at your own runtime's URL, stop — you have the flow inverted.

### What target type fits your tool

| What the tool is                     | Target type           | Notes                                    |
| ------------------------------------ | --------------------- | ---------------------------------------- |
| MCP server (third-party or your own) | `mcp-server`          | Most common for MCP tool catalogs        |
| AWS Lambda function you wrote        | `lambda-function-arn` | Uses IAM auth automatically              |
| HTTP API with an OpenAPI spec        | `open-api-schema`     | FastAPI's built-in `/openapi.json` works |
| AWS API Gateway REST API             | `api-gateway`         | For APIs already fronted by API Gateway  |
| AWS service with a Smithy model      | `smithy-model`        | Direct AWS service integration           |

Your tool doesn't naturally have an OpenAPI spec and isn't an MCP server or Lambda? Either wrap it in a Lambda (simplest), generate an OpenAPI spec for it (FastAPI does this automatically), or front it with API Gateway.

---

### Step 3: Navigate the auth matrix

**This is the most common source of errors.** The auth options depend on the target type, and the CLI exposes only a subset of what the API/SDK support.

| What you're connecting to | CLI `--type`          | Outbound auth via CLI                                                                            | Additional options via API/SDK                |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| External MCP server       | `mcp-server`          | `none`, `oauth` (2LO only)                                                                       | OAuth 3LO (`AUTHORIZATION_CODE`); IAM (SigV4) |
| Lambda function           | `lambda-function-arn` | `none` (default — direct invoke via gateway role), `oauth` (2LO) for OAuth-protected downstreams | OAuth 3LO                                     |
| OpenAPI spec              | `open-api-schema`     | `oauth` (2LO), `api-key` (required — no `none`)                                                  | OAuth 3LO                                     |
| AWS API Gateway           | `api-gateway`         | `none`, `api-key`                                                                                | IAM (`GATEWAY_IAM_ROLE`)                      |
| Smithy model              | `smithy-model`        | `oauth` (2LO)                                                                                    | IAM; OAuth 3LO                                |

**Two OAuth grant types, not one.** The CLI's `--outbound-auth oauth` only configures **2-legged OAuth** (client credentials / M2M). If the service requires **3-legged OAuth** (`AUTHORIZATION_CODE` grant, user-delegated access), there is no CLI flag — you must configure the target via boto3 / the AWS SDK. See the [CreateGatewayTarget docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-building-adding-targets-authorization.html) for the `OAuthCredentialProvider` with `grantType: AUTHORIZATION_CODE` and `defaultReturnUrl`. 3LO applies to MCP, Lambda, OpenAPI, and Smithy targets. Call this out up front — developers who need 3LO will otherwise burn a round-trip trying CLI flags that don't exist.

**IAM (SigV4) for MCP servers** is configured via the AWS SDK/API (`CreateGatewayTarget` with `GATEWAY_IAM_ROLE` credential provider + `iamCredentialProvider.service`), not the CLI. It requires the MCP server to be hosted behind an AWS service that natively verifies SigV4: AgentCore Runtime, AgentCore Gateway, Amazon API Gateway, or Lambda Function URLs. ALB or direct EC2 endpoints do not verify SigV4 — use OAuth there instead. ([MCP server target auth strategies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html#gateway-target-MCPservers-considerations))

**API key auth for MCP server targets is not supported at the API level** — not just a CLI gap. The [MCP server targets docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html#gateway-target-MCPservers-considerations) list only "No authorization, OAuth, and IAM" as supported authorization strategies for MCP targets. If the MCP server uses an API key (a common pattern for third-party MCP providers), handle it in agent code via Path D.

**Auth options change.** If the matrix above doesn't match what the CLI accepts, check the current CLI help (`agentcore add gateway-target --help`) and the AWS docs — auth support per target type evolves across releases. If the `awsknowledge` MCP server is available, search for "AgentCore CreateGatewayTarget" to get the current API parameters.

**CLI vs. API for gateway auth:** The CLI covers `none`, `oauth` (2LO), and `api-key`. For IAM (SigV4) and 3-legged OAuth, use boto3 directly — the examples are in the Path A section below. The general pattern: create the gateway and target via CLI, deploy, then apply the advanced auth config via boto3 if the CLI doesn't support it.

Tell the developer which auth option applies to their target type before generating any commands.

### When your gateway has many tools, let the model search for them

Once a gateway has more than a handful of tools — roughly 20+ — passing every tool definition to the model on every turn wastes tokens and degrades accuracy. The model does better when it sees only the tools relevant to the current request.

AgentCore Gateway has a built-in semantic search tool for exactly this. Your agent calls a single MCP tool named `x_amz_bedrock_agentcore_search` with a natural-language query, and the gateway returns the most relevant tools from its catalog. The agent then invokes the returned tools normally.

If a developer is considering building their own tool-selection layer with Bedrock Knowledge Bases, a vector store, or custom embeddings — stop them. The gateway already does this, evaluated against curated relevance criteria, with no infrastructure to manage.

Usage pattern (the agent calls this the same way it calls any other gateway tool):

```python
# Via the MCP client, as a tool call
result = await session.call_tool(
    "x_amz_bedrock_agentcore_search",
    arguments={"query": "find tools related to processing refunds"}
)
# result.content lists the most relevant tools — the agent then invokes them
```

The feature works with any target type (Lambda, OpenAPI, MCP, API Gateway, Smithy). Enable it per gateway — see the [Search for tools in your AgentCore gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-semantic-search.html) docs for the exact API surface and framework-specific client code.

Rule of thumb: if a gateway has more than 20 tools, recommend enabling semantic search. For smaller catalogs, passing all tools directly is still fine.

### Passing custom headers from the caller to the agent

If the developer needs callers to send custom HTTP headers (tenant IDs, correlation IDs, protocol-specific headers like `A2A-Version`, tracing headers, idempotency keys), the runtime's default is to strip most headers before they reach agent code. Load [`agents-build/references/request-headers.md`](../agents-build/references/request-headers.md) for the allowlist configuration and prefix pattern.

This is about inbound calls to your agent, not outbound calls to tools — but developers hit it often enough that it's worth mentioning here.

---

## Path A: MCP server

### Add a gateway (if none exists)

> [!WARNING]
> Never deploy a gateway without inbound authentication to production. A gateway with
> no authorizer exposes all connected tools (Lambda, MCP, OpenAPI) to any caller who
> knows the URL — functionally equivalent to --authorizer-type NONE on the runtime.
> Always use --authorizer-type CUSTOM_JWT or AWS_IAM for production gateways.
> The no-auth form (agentcore add gateway --name X) is for local testing only.

```bash
# Development (no inbound auth — for testing only)
agentcore add gateway --name MyGateway

# Production (JWT inbound auth)
agentcore add gateway \
  --name MyGateway \
  --authorizer-type CUSTOM_JWT \
  --discovery-url https://your-idp.example.com/.well-known/openid-configuration \
  --allowed-audience my-api \
  --allowed-clients my-client-id
```

### Add the MCP server as a target

```bash
# No outbound auth (public MCP server)
agentcore add gateway-target \
  --type mcp-server \
  --name WeatherTools \
  --endpoint https://mcp.example.com/mcp \
  --gateway MyGateway

# OAuth outbound auth (2-legged — client credentials / M2M)
agentcore add gateway-target \
  --type mcp-server \
  --name WeatherTools \
  --endpoint https://mcp.example.com/mcp \
  --gateway MyGateway \
  --outbound-auth oauth \
  --oauth-client-id your-client-id \
  --oauth-client-secret your-client-secret \
  --oauth-discovery-url https://auth.example.com/.well-known/openid-configuration \
  --oauth-scopes read,write
```

Note: The CLI `--outbound-auth` flag supports `oauth` (2LO / client credentials) or `none` for MCP servers.

- **3-legged OAuth (`AUTHORIZATION_CODE` grant)** — user-delegated access — is supported by the API but has no CLI path. Configure via boto3 `create_gateway_target` with `OAuthCredentialProvider.grantType = "AUTHORIZATION_CODE"` and `defaultReturnUrl`. See [Connecting to an OAuth-protected MCP server using Authorization Code flow](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html#gateway-target-MCPservers-auth-code-grant-flow).
- **IAM (SigV4)** for MCP servers hosted on AgentCore Runtime, another AgentCore Gateway, API Gateway, or Lambda Function URLs is configured via the AWS SDK/API (not the CLI) — use `CreateGatewayTarget` with `GATEWAY_IAM_ROLE` credential provider and an `iamCredentialProvider.service` value.
- **API key auth** is not supported for MCP server targets at the API level (the MCP target docs list only no-auth, OAuth, and IAM as strategies) — if the MCP server uses an API key, handle it in agent code directly (see Path D).

### Deploy and get the gateway URL

```bash
agentcore deploy -y
agentcore fetch access --name MyGateway
```

The gateway URL is injected as `AGENTCORE_GATEWAY_<NAME>_URL` after deploy.

### Generate gateway client code

**Framework-agnostic MCP client:**

```python
import os
import asyncio
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

# Injected by AgentCore after deploy. Format: AGENTCORE_GATEWAY_<UPPERCASENAME>_URL
GATEWAY_URL = os.getenv("AGENTCORE_GATEWAY_MYGATEWAY_URL")

async def get_gateway_tools():
    """Discover tools from the gateway. Returns empty list if not deployed."""
    if not GATEWAY_URL:
        return []
    async with streamablehttp_client(GATEWAY_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return result.tools

async def call_gateway_tool(tool_name: str, arguments: dict):
    """Call a specific tool through the gateway."""
    if not GATEWAY_URL:
        raise RuntimeError("Gateway not available in local dev — deploy first")
    async with streamablehttp_client(GATEWAY_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await session.call_tool(tool_name, arguments)
```

**For Strands**, pass gateway tools directly to the agent:

```python
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession
from strands import Agent
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model  # scaffolded by `agentcore create`

app = BedrockAgentCoreApp()
GATEWAY_URL = os.getenv("AGENTCORE_GATEWAY_MYGATEWAY_URL")

@app.entrypoint
def invoke(payload, context):
    if not GATEWAY_URL:
        # Local dev — run without gateway tools
        agent = Agent(model=load_model())
        return {"response": str(agent(payload.get("prompt", "")))}

    # Deployed — discover and use gateway tools
    tools = asyncio.run(get_gateway_tools())
    agent = Agent(
        model=load_model(),
        tools=tools,
    )
    return {"response": str(agent(payload.get("prompt", "")))}

if __name__ == "__main__":
    app.run()
```

**For LangGraph**, add gateway tools to the tool node:

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

@app.entrypoint
def agent_invocation(payload, context):
    if not GATEWAY_URL:
        tools = []
    else:
        # Use LangChain MCP adapter to get tools as LangChain-compatible tools
        client = MultiServerMCPClient({"gateway": {"url": GATEWAY_URL, "transport": "streamable_http"}})
        tools = asyncio.run(client.get_tools())

    llm_with_tools = llm.bind_tools(tools)
    # ... rest of your LangGraph graph ...
```

---

## Path B: Lambda function as tools

```bash
agentcore add gateway-target \
  --type lambda-function-arn \
  --name MyTools \
  --lambda-arn arn:aws:lambda:us-east-1:123456789012:function:my-tools \
  --tool-schema-file tools.json \
  --gateway MyGateway
```

The `tools.json` defines the tool schemas:

```json
{
  "inlinePayload": [
    {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "inputSchema": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "City name" }
        },
        "required": ["city"]
      }
    }
  ]
}
```

**Auth:** Lambda targets use IAM role auth automatically — no `--outbound-auth` flag. The gateway's execution role needs `lambda:InvokeFunction` on the Lambda ARN.

Use the same MCP client code from Path A to call the tools.

---

## Path C: OpenAPI spec as tools

```bash
# From a local file (api-key auth)
agentcore add credential --name MyAPIKey --api-key sk-...

agentcore add gateway-target \
  --type open-api-schema \
  --name MyAPI \
  --schema specs/api.json \
  --gateway MyGateway \
  --outbound-auth api-key \
  --credential-name MyAPIKey
```

**Auth is required** for OpenAPI targets — either `oauth` (client credentials or authorization code) or `api-key`.

⚠️ **Security note:** `--api-key` appears in shell history. Two safer options:

1. **Interactive prompt (recommended):** run `agentcore add credential --name MyAPIKey --type api-key` without `--api-key` — the CLI will prompt, and the value goes straight into the credential provider (Secrets Manager-backed) without hitting your shell history.
2. **Edit `agentcore.json` + `.env.local` for local dev only:** if you need the credential to work under `agentcore dev`, put the value in `agentcore/.env.local` (gitignored). This file is read by the local dev server only — it is **not** uploaded to runtime on deploy. The deployed runtime gets the value from the credential provider.

Do **not** try to ship a credential to the deployed runtime via environment variables — AgentCore Runtime env vars are not vault-backed. Register the credential once with `agentcore add credential` and reference it by name in the gateway target or in code (Path D).

---

## Path D: Credentials for use in agent code

For calling APIs directly in agent code (not through a gateway target).

### Before you reach for Path D, check if it's actually the right path

Path D is the **fallback**, not the starting point. For most external services, a Gateway target (Paths A–C) is safer and less code. Before generating Path D code, confirm one of these applies:

- The service uses a streaming/bidirectional protocol Gateway doesn't front (SSE with live output, WebSockets, WebRTC)
- It's a measurably latency-critical hot path and the team has accepted the trade-off
- The client is a vendor binary SDK with no HTTP surface
- It's an AWS service SDK where the runtime's execution role already has IAM permissions (in which case: use the SDK directly — no credential registration needed)
- The developer has a specific blocker (e.g., the service ships an OpenAI-shaped API the vendor's SDK wraps, and rebuilding the SDK call as a Gateway target would be a regression)

If none of those applies, route back to Path A/B/C:

> "Before we wire up a credential for direct use in agent code, can we front this as a Gateway target instead? Gateway injects the credential at the edge — your agent code never touches the secret — and the tool becomes policy-enforceable. If SERVICE has an OpenAPI spec, MCP server, or Lambda function in front of it, Path C / A / B is the better fit. Which one applies?"

Only continue into the rest of Path D when the developer confirms a legitimate reason Gateway won't work.

### Register the credential

```bash
# API key
agentcore add credential --name OpenAI --api-key sk-...

# OAuth (machine-to-machine)
agentcore add credential \
  --name MyOAuthProvider \
  --type oauth \
  --discovery-url https://idp.example.com/.well-known/openid-configuration \
  --client-id my-client-id \
  --client-secret my-client-secret \
  --scopes read,write
```

⚠️ **Security note:** `--api-key` and `--client-secret` appear in shell history. Run the command without those flags to get an interactive prompt — the value goes straight into the credential provider without touching your shell history.

**For local dev only**, put the same value in `agentcore/.env.local` (gitignored) so `agentcore dev` can resolve the decorator locally. The deployed runtime ignores `.env.local` and fetches the secret from the credential provider at call time — **never** ship secrets as runtime environment variables.

### Use credentials in agent code

Use the `@requires_api_key` or `@requires_access_token` decorators — they handle token caching and refresh automatically. The decorators work with both sync and async functions:

```python
from bedrock_agentcore.identity.auth import requires_api_key, requires_access_token

# Sync function — decorator injects the fetched key via keyword arg
@requires_api_key(provider_name="OpenAI")
def call_openai(prompt: str, *, api_key: str) -> str:
    import openai
    client = openai.OpenAI(api_key=api_key)
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content

# Async function — same decorator, async def
@requires_access_token(
    provider_name="MyOAuthProvider",
    scopes=["read", "write"],
    auth_flow="M2M",
)
async def call_my_api(data: dict, *, access_token: str) -> dict:
    import httpx
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.example.com/endpoint",
            headers={"Authorization": f"Bearer {access_token}"},
            json=data,
        )
        return response.json()
```

The decorator itself handles the token lifecycle — you don't need to make the function async just to use it. Parameters are keyword-only (`*, api_key: str` or `*, access_token: str`) — the decorator injects them.

**Local dev:** In `agentcore dev`, credentials are read from `agentcore/.env.local`. The decorator pattern works the same way locally and deployed.

---

## Local dev gap

> [!WARNING]
> Gateway URLs (AGENTCORE_GATEWAY_*_URL) are only available after deploy.
> In agentcore dev, these env vars are not set. Always check before using:
>
> ```python
> GATEWAY_URL = os.getenv("AGENTCORE_GATEWAY_MYGATEWAY_URL")
> if not GATEWAY_URL:
>     # run without gateway tools in local dev
> ```
>
> Never assume the gateway is available locally.

---

## Troubleshooting

**"mcp-server target doesn't support api-key auth"**
Correct — API key auth is not supported for MCP server targets at the API level ([MCP target auth strategies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html#gateway-target-MCPservers-considerations)). Options: OAuth (2LO or 3LO), IAM (for MCP servers hosted on AgentCore Runtime, API Gateway, or Lambda Function URLs), or Path D — manage the credential in agent code and call the MCP server directly.

**"I need 3LO / authorization-code OAuth but `--outbound-auth oauth` doesn't ask for a return URL"**
The CLI only configures 2LO (client credentials). 3-legged OAuth requires boto3 — call `create_gateway_target` with `credentialProviderType: OAUTH`, `grantType: AUTHORIZATION_CODE`, and `defaultReturnUrl`. See [Connecting to an OAuth-protected MCP server using Authorization Code flow](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html#gateway-target-MCPservers-auth-code-grant-flow).

**"api-gateway target doesn't support oauth"**
Use `api-key` or `none` for API Gateway targets.

**Gateway URL not set after deploy**
Run `agentcore fetch access --name MyGateway` to get the URL. Check `agentcore status --type gateway` to verify the gateway is deployed.

**Tool calls failing with auth errors**
Check `agentcore logs --runtime MyAgent --since 1h --level error` for the specific error. Common causes: expired OAuth token, wrong credential name, IAM permission missing.

**"Adding gateway to existing agent" workaround**
The CLI recommends creating a throwaway agent to copy gateway client code. This skill generates the code directly — no workaround needed.

**MCP clients (Claude Desktop, claude.ai) can't auto-connect to Gateway**
AgentCore Gateway does not currently implement the MCP OAuth spec endpoints (RFC 8414 OAuth Authorization Server Metadata, RFC 7591 Dynamic Client Registration). MCP clients that expect to auto-discover OAuth config and register themselves — like Claude Desktop and claude.ai — cannot connect without manual credential configuration. The workaround is to manually obtain the Cognito `client_id` and `client_secret` and enter them in the MCP client's advanced settings. This is a platform limitation, not a config error.

## Output

- A clear recommendation on **Gateway target vs direct API call**, grounded in the five cases where direct is legitimate
- CLI commands to set up the gateway and target (or to register the credential, if Path D is the right call)
- Framework-specific gateway client code
- Credential setup (avoiding shell history exposure, never stored in runtime env vars)
- Local dev gap handling
