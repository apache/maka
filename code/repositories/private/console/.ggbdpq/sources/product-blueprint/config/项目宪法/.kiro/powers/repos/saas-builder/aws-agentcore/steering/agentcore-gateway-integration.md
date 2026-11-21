# AgentCore Gateway Integration Guide

## Overview

This guide provides step-by-step instructions for adding AgentCore Gateway to a Strands agent. Gateway enables your agent to access external tools via MCP (Model Context Protocol), including Lambda functions, OpenAPI services, and more.

## Prerequisites

- Existing Strands agent deployed or ready to deploy
- `bedrock-agentcore-starter-toolkit` installed
- AWS credentials configured
- Lambda functions or APIs to expose as tools (optional)

## What is AgentCore Gateway?

AgentCore Gateway is a managed MCP endpoint that provides:
- **Centralized Tool Access**: Single endpoint for multiple tool sources
- **Built-in Authentication**: Automatic OAuth2 setup with Cognito
- **Multiple Target Types**: Lambda, OpenAPI, Smithy models, MCP servers
- **Semantic Search**: Optional semantic search for tools
- **Automatic Scaling**: Managed by AWS

## Architecture

```
Your Agent (Strands)
    ↓ (OAuth2 Bearer Token)
AgentCore Gateway (MCP Endpoint)
    ↓ (IAM Role / API Key)
├── Lambda Functions
├── OpenAPI Services
├── Smithy Models (AWS Services)
└── MCP Servers
```

## Step 1: Create Gateway

```bash
agentcore gateway create-mcp-gateway \
    --name MyAgentGateway \
    --region us-west-2 \
    --enable_semantic_search
```

This automatically creates:
- Gateway endpoint URL
- Cognito User Pool for OAuth2
- IAM execution role
- Client credentials

**Save the output** - you'll need:
- Gateway ARN
- Gateway URL
- Gateway ID
- Client ID (from Cognito)
- Client Secret (from Cognito)

## Step 2: Add Gateway Targets

### Option A: Lambda Function Target

Create a Lambda target configuration file `lambda_target.json`:

```json
{
    "lambdaArn": "arn:aws:lambda:us-west-2:123456789:function:MyFunction",
    "toolSchema": {
        "inlinePayload": [
            {
                "name": "my_tool",
                "description": "Description of what this tool does",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "param1": {
                            "type": "string",
                            "description": "First parameter"
                        },
                        "param2": {
                            "type": "number",
                            "description": "Second parameter"
                        }
                    },
                    "required": ["param1"]
                }
            }
        ]
    }
}
```

Add the target:

```bash
agentcore gateway create-mcp-gateway-target \
    --gateway-arn <gateway-arn-from-step-1> \
    --gateway-url <gateway-url-from-step-1> \
    --role-arn <role-arn-from-step-1> \
    --name MyLambdaTarget \
    --target-type lambda \
    --target-payload "$(cat lambda_target.json)" \
    --region us-west-2
```

### Option B: OpenAPI Service Target

```bash
agentcore gateway create-mcp-gateway-target \
    --gateway-arn <gateway-arn> \
    --gateway-url <gateway-url> \
    --role-arn <role-arn> \
    --name MyAPITarget \
    --target-type openApiSchema \
    --target-payload '{
        "openApiSchema": {
            "uri": "https://api.example.com/openapi.json"
        }
    }' \
    --credentials '{
        "api_key": "your-api-key",
        "credential_location": "header",
        "credential_parameter_name": "X-API-Key"
    }' \
    --region us-west-2
```

### Option C: Smithy Model Target (AWS Services)

```bash
agentcore gateway create-mcp-gateway-target \
    --gateway-arn <gateway-arn> \
    --gateway-url <gateway-url> \
    --role-arn <role-arn> \
    --name DynamoDBTarget \
    --target-type smithyModel \
    --region us-west-2
```

## Step 3: Get Gateway Credentials

Retrieve Cognito client credentials:

```bash
# Get gateway details
agentcore gateway get-mcp-gateway --name MyAgentGateway --region us-west-2

# Extract client ID from output, then get secret
aws cognito-idp describe-user-pool-client \
    --user-pool-id <user-pool-id> \
    --client-id <client-id> \
    --region us-west-2 \
    --query 'UserPoolClient.[ClientId,ClientSecret]' \
    --output json
```

## Step 4: Update Agent Code

### Install Required Dependencies

Add to `pyproject.toml`:
```toml
dependencies = [
    "bedrock-agentcore >= 1.0.3",
    "httpx >= 0.27.0",
    "strands-agents >= 1.13.0"
]
```

Or `requirements.txt`:
```
bedrock-agentcore>=1.0.3
httpx>=0.27.0
strands-agents>=1.13.0
```

### Create MCP Client with OAuth2

Create or update `src/mcp_client/client.py`:

```python
import os
import httpx
from datetime import datetime, timedelta
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

# Gateway configuration
GATEWAY_MCP_URL = os.environ.get("GATEWAY_MCP_URL")
GATEWAY_CLIENT_ID = os.environ.get("GATEWAY_CLIENT_ID")
GATEWAY_CLIENT_SECRET = os.environ.get("GATEWAY_CLIENT_SECRET")
GATEWAY_TOKEN_ENDPOINT = os.environ.get("GATEWAY_TOKEN_ENDPOINT")
GATEWAY_SCOPE = os.environ.get("GATEWAY_SCOPE")

# Token cache
_token_cache = {"token": None, "expires_at": None}

def get_oauth_token():
    """Get OAuth2 token for gateway authentication with caching"""
    # Check if cached token is still valid
    if _token_cache["token"] and _token_cache["expires_at"] and datetime.now() < _token_cache["expires_at"]:
        return _token_cache["token"]
    
    # Fetch new token
    response = httpx.post(
        GATEWAY_TOKEN_ENDPOINT,
        data={
            "grant_type": "client_credentials",
            "client_id": GATEWAY_CLIENT_ID,
            "client_secret": GATEWAY_CLIENT_SECRET,
            "scope": GATEWAY_SCOPE
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    
    if response.status_code == 200:
        data = response.json()
        token = data["access_token"]
        # Cache token with 5 minute buffer before expiry
        expires_in = data.get("expires_in", 3600) - 300
        _token_cache["token"] = token
        _token_cache["expires_at"] = datetime.now() + timedelta(seconds=expires_in)
        return token
    else:
        raise Exception(f"Failed to get OAuth token: {response.status_code} - {response.text}")

def get_streamable_http_mcp_client() -> MCPClient:
    """Returns an MCP Client configured for AgentCore Gateway"""
    access_token = get_oauth_token()
    
    return MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_MCP_URL,
            headers={"Authorization": f"Bearer {access_token}"}
        )
    )
```

### Update Main Agent Code

**Recommended Pattern** (cleaner, more maintainable):

```python
from strands import Agent, tool
from bedrock_agentcore import BedrockAgentCoreApp
from mcp_client.client import get_streamable_http_mcp_client
from model.load import load_model

# Local tools
@tool
def local_tool(param: str) -> str:
    """A local tool that runs in the agent"""
    return f"Processed: {param}"

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload):
    # Create MCP client
    mcp_client = get_streamable_http_mcp_client()
    
    # Get gateway tools within context manager
    with mcp_client:
        gateway_tools = mcp_client.list_tools_sync()
        
        # Create agent with all tools
        agent = Agent(
            model=load_model(),
            tools=[local_tool] + gateway_tools,
            system_prompt="You are a helpful assistant with access to various tools."
        )
        
        prompt = payload.get("prompt", "Hello")
        response = agent(prompt)
        
        return {"response": response}

if __name__ == "__main__":
    app.run()
```

**Alternative Pattern** (if you need to reuse the client):

```python
from strands import Agent, tool
from bedrock_agentcore import BedrockAgentCoreApp
from mcp_client.client import get_streamable_http_mcp_client
from model.load import load_model

# Local tools
@tool
def local_tool(param: str) -> str:
    """A local tool that runs in the agent"""
    return f"Processed: {param}"

# Create MCP client once (reusable)
mcp_client = get_streamable_http_mcp_client()

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload):
    # Get gateway tools
    with mcp_client:
        gateway_tools = mcp_client.list_tools_sync()
        
        # Create agent with all tools
        agent = Agent(
            model=load_model(),
            tools=[local_tool] + gateway_tools,
            system_prompt="You are a helpful assistant with access to various tools."
        )
        
        prompt = payload.get("prompt", "Hello")
        response = agent(prompt)
        
        return {"response": response}

if __name__ == "__main__":
    app.run()
```

## Step 5: Configure Environment Variables

Create `.env` file:

```bash
# Gateway Configuration
GATEWAY_MCP_URL=https://your-gateway-id.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp
GATEWAY_CLIENT_ID=your-client-id
GATEWAY_CLIENT_SECRET=your-client-secret
GATEWAY_TOKEN_ENDPOINT=https://your-cognito-domain.auth.us-west-2.amazoncognito.com/oauth2/token
GATEWAY_SCOPE=YourGatewayName/invoke

# AWS Configuration
AWS_REGION=us-west-2
```

**IMPORTANT**: Never commit `.env` files with secrets to version control!

## Step 6: Deploy Agent

```bash
agentcore launch
```

## Step 7: Test Gateway Integration

```bash
# Test with a prompt that should use gateway tools
agentcore invoke '{
    "prompt": "Use the my_tool function with param1 set to test"
}'
```

## Gateway Management Commands

### List Gateways
```bash
agentcore gateway list-mcp-gateways --region us-west-2
```

### Get Gateway Details
```bash
agentcore gateway get-mcp-gateway --name MyAgentGateway --region us-west-2
```

### List Gateway Targets
```bash
agentcore gateway list-mcp-gateway-targets --name MyAgentGateway --region us-west-2
```

### Get Target Details
```bash
agentcore gateway get-mcp-gateway-target \
    --name MyAgentGateway \
    --target-name MyLambdaTarget \
    --region us-west-2
```

### Delete Gateway Target
```bash
agentcore gateway delete-mcp-gateway-target \
    --name MyAgentGateway \
    --target-name MyLambdaTarget \
    --region us-west-2
```

### Delete Gateway (with all targets)
```bash
agentcore gateway delete-mcp-gateway \
    --name MyAgentGateway \
    --force \
    --region us-west-2
```

## Target Types Explained

### 1. Lambda Target
- **Use for**: Custom business logic, AWS service integrations
- **Authentication**: IAM role (automatic)
- **Configuration**: Requires Lambda ARN and tool schema
- **Example**: Data processing, database queries, custom APIs

### 2. OpenAPI Target
- **Use for**: External REST APIs with OpenAPI specs
- **Authentication**: API key or OAuth2
- **Configuration**: Requires OpenAPI spec URI
- **Example**: Weather APIs, payment gateways, third-party services

### 3. Smithy Model Target
- **Use for**: AWS services (DynamoDB, S3, etc.)
- **Authentication**: IAM role (automatic)
- **Configuration**: Minimal, uses pre-configured models
- **Example**: DynamoDB operations, S3 file management

### 4. MCP Server Target
- **Use for**: Existing MCP-compatible services
- **Authentication**: Varies by server
- **Configuration**: Server endpoint and credentials
- **Example**: Custom MCP servers, third-party MCP services

## Lambda Function Requirements

Your Lambda function should handle tool calls:

```python
import json

def lambda_handler(event, context):
    """
    Event structure:
    {
        "tool_name": "my_tool",
        "arguments": {
            "param1": "value1",
            "param2": 123
        }
    }
    """
    tool_name = event.get('tool_name')
    arguments = event.get('arguments', {})
    
    if tool_name == 'my_tool':
        param1 = arguments.get('param1')
        # Process the request
        result = {"status": "success", "data": f"Processed {param1}"}
        return result
    
    return {"error": f"Unknown tool: {tool_name}"}
```

## OpenAPI Credential Types

### API Key Authentication
```json
{
    "api_key": "your-api-key",
    "credential_location": "header",
    "credential_parameter_name": "X-API-Key"
}
```

### OAuth2 (Custom Provider)
```json
{
    "oauth2_provider_config": {
        "customOauth2ProviderConfig": {
            "oauthDiscovery": {
                "discoveryUrl": "https://auth.example.com/.well-known/openid-configuration"
            },
            "clientId": "your-client-id",
            "clientSecret": "your-client-secret"
        }
    },
    "scopes": ["read", "write"]
}
```

### OAuth2 (Google)
```json
{
    "oauth2_provider_config": {
        "googleOauth2ProviderConfig": {
            "clientId": "your-google-client-id",
            "clientSecret": "your-google-client-secret"
        }
    },
    "scopes": ["https://www.googleapis.com/auth/userinfo.email"]
}
```

## Best Practices

1. **Token Caching**: Always cache OAuth tokens to avoid rate limits
2. **Error Handling**: Implement retry logic for gateway calls
3. **Tool Naming**: Use descriptive, unique tool names
4. **Schema Validation**: Ensure tool schemas match Lambda expectations
5. **Security**: Never commit credentials to version control
6. **Monitoring**: Check CloudWatch logs for gateway errors
7. **Testing**: Test gateway tools locally before deploying

## Troubleshooting

### Gateway Tools Not Available
- Verify gateway URL is correct
- Check OAuth token is being generated
- Ensure gateway status is READY
- Verify target status is READY

### Authentication Errors
- Check client ID and secret are correct
- Verify token endpoint URL
- Ensure scope matches gateway name
- Check token expiry and refresh logic

### Tool Execution Fails
- Verify Lambda function permissions
- Check Lambda function logs in CloudWatch
- Ensure tool schema matches Lambda expectations
- Verify IAM role has Lambda invoke permissions

### Gateway Creation Fails
- Check AWS permissions for AgentCore Gateway
- Verify region is supported
- Ensure gateway name is unique

## Example: Complete Agent with Gateway

**Complete Working Example** (src/main.py):

```python
import os
from strands import Agent, tool
from bedrock_agentcore import BedrockAgentCoreApp
from mcp_client.client import get_streamable_http_mcp_client
from model.load import load_model

@tool
def local_calculator(a: int, b: int) -> int:
    """Add two numbers locally"""
    return a + b

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload):
    # Create MCP client for gateway
    mcp_client = get_streamable_http_mcp_client()
    
    # Get gateway tools within context manager
    with mcp_client:
        gateway_tools = mcp_client.list_tools_sync()
        
        # Create agent with both local and gateway tools
        agent = Agent(
            model=load_model(),
            tools=[local_calculator] + gateway_tools,
            system_prompt="You are a helpful assistant with access to local and remote tools."
        )
        
        prompt = payload.get("prompt", "Hello")
        response = agent(prompt)
        
        return {"response": response}

if __name__ == "__main__":
    app.run()
```

**MCP Client Module** (src/mcp_client/client.py):

```python
import os
import httpx
from datetime import datetime, timedelta
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

# Gateway configuration from environment
GATEWAY_MCP_URL = os.environ.get("GATEWAY_MCP_URL")
GATEWAY_CLIENT_ID = os.environ.get("GATEWAY_CLIENT_ID")
GATEWAY_CLIENT_SECRET = os.environ.get("GATEWAY_CLIENT_SECRET")
GATEWAY_TOKEN_ENDPOINT = os.environ.get("GATEWAY_TOKEN_ENDPOINT")
GATEWAY_SCOPE = os.environ.get("GATEWAY_SCOPE")

# Token cache for performance
_token_cache = {"token": None, "expires_at": None}

def get_oauth_token():
    """Get OAuth2 token with caching"""
    if _token_cache["token"] and _token_cache["expires_at"] and datetime.now() < _token_cache["expires_at"]:
        return _token_cache["token"]
    
    response = httpx.post(
        GATEWAY_TOKEN_ENDPOINT,
        data={
            "grant_type": "client_credentials",
            "client_id": GATEWAY_CLIENT_ID,
            "client_secret": GATEWAY_CLIENT_SECRET,
            "scope": GATEWAY_SCOPE
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    
    if response.status_code == 200:
        data = response.json()
        token = data["access_token"]
        expires_in = data.get("expires_in", 3600) - 300
        _token_cache["token"] = token
        _token_cache["expires_at"] = datetime.now() + timedelta(seconds=expires_in)
        return token
    else:
        raise Exception(f"Failed to get OAuth token: {response.status_code}")

def get_streamable_http_mcp_client() -> MCPClient:
    """Returns an MCP Client configured for AgentCore Gateway"""
    access_token = get_oauth_token()
    
    return MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_MCP_URL,
            headers={"Authorization": f"Bearer {access_token}"}
        )
    )
```

## Combining Gateway with Memory

You can use both Gateway and Memory together:

```python
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

@app.entrypoint
def invoke(payload):
    # Memory setup
    memory_config = AgentCoreMemoryConfig(
        memory_id=os.environ.get("AGENTCORE_MEMORY_ID"),
        session_id=payload.get("session_id", "default"),
        actor_id=payload.get("actor_id", "user")
    )
    session_manager = AgentCoreMemorySessionManager(
        agentcore_memory_config=memory_config,
        region_name="us-west-2"
    )
    
    # Gateway setup
    with gateway_client as client:
        gateway_tools = client.list_tools_sync()
        
        # Agent with both memory and gateway tools
        agent = Agent(
            model=load_model(),
            tools=gateway_tools,
            session_manager=session_manager
        )
        
        prompt = payload.get("prompt")
        response = agent(prompt)
        
        return {"response": response}
```

## Resources

- [AgentCore Gateway Documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [Strands MCP Tools](https://strandsagents.com/latest/documentation/docs/user-guide/concepts/tools/mcp-tools/)

## Quick Reference

```bash
# Create gateway
agentcore gateway create-mcp-gateway --name MyGateway --region us-west-2

# Add Lambda target
agentcore gateway create-mcp-gateway-target \
    --gateway-arn <arn> \
    --gateway-url <url> \
    --role-arn <role> \
    --name MyTarget \
    --target-type lambda \
    --target-payload "$(cat config.json)"

# List gateways
agentcore gateway list-mcp-gateways

# Delete gateway
agentcore gateway delete-mcp-gateway --name MyGateway --force
```

---

**Remember**: Gateway provides centralized access to external tools. Create the gateway once, add targets as needed, and reference it in your agent code via OAuth2 authentication.
