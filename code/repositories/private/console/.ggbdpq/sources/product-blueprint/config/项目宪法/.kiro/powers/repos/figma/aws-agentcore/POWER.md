---
name: "aws-agentcore"
displayName: "Build an agent with Amazon Bedrock AgentCore"
description: "Build, test, and deploy AI agents using AWS Bedrock AgentCore with local development workflow. Amazon Bedrock AgentCore is an agentic platform for building, deploying, and operating effective agents."
keywords: ["agentcore", "bedrock", "aws", "agents", "ai", "development", "agent"]
author: "AWS"
---

# AWS Bedrock AgentCore

## Overview

Build and deploy AI agents using AWS Bedrock AgentCore with a complete local development workflow. This power provides access to AgentCore documentation, runtime management, memory operations, and gateway configuration through MCP tools, plus comprehensive guidance for the create-dev-test-deploy cycle.

AgentCore supports multiple agent SDKs (Strands, Claude, OpenAI) and model providers (Bedrock, OpenAI), with infrastructure deployment via CDK or Terraform.

## When to Use This Power

- Building a new agent from scratch with `agentcore create`
- Getting started with agent development and need guidance on the workflow
- Deploying an existing agent to AgentCore runtime
- Integrating AgentCore primitives (Memory, Gateway) into an existing agent
- Starting local development servers with hot reloading
- Testing agents locally before cloud deployment
- Searching AgentCore documentation
- Managing agent runtime, memory, and gateway configurations
- Deploying agents to AWS
- Working with Strands agents framework

## Available MCP Tools

This power provides the agentcore-mcp-server:
- `search_agentcore_docs` - Search AgentCore documentation
- `fetch_agentcore_doc` - Retrieve specific documentation pages
- `manage_agentcore_runtime` - Manage agent runtime configuration
- `manage_agentcore_memory` - Handle agent memory operations
- `manage_agentcore_gateway` - Configure agent gateway settings

## Getting Started

**For new users or building a new agent:** Use the getting-started steering file for complete step-by-step guidance on prerequisites, project creation, development workflow, and deployment. Access it with `readPowerSteering("agentcore", "getting-started.md")`.

**For deploying existing agents:** Use the `manage_agentcore_runtime` MCP tool to get complete deployment requirements and instructions for wrapping and deploying existing agents to AgentCore runtime.

## Integration Guides

**AgentCore Gateway:** 
- For creating and managing Gateway resources, use the `manage_agentcore_gateway` MCP tool for framework-agnostic CLI commands
- For fully integrating Gateway with a Strands agent, use `readPowerSteering("agentcore", "agentcore-gateway-integration.md")`

**AgentCore Memory:** 
- For creating and managing Memory resources, use the `manage_agentcore_memory` MCP tool for framework-agnostic CLI commands
- For fully integrating Memory with a Strands agent, use `readPowerSteering("agentcore", "agentcore-memory-integration.md")`

## Using MCP Tools

### Search Documentation

To search AgentCore docs:
```
usePower("agentcore", "agentcore-mcp-server", "search_agentcore_docs", {
  "query": "deployment configuration"
})
```

### Fetch Specific Documentation

```
usePower("agentcore", "agentcore-mcp-server", "fetch_agentcore_doc", {
  "doc_id": "getting-started"
})
```

### Manage AgentCore Runtime

Get deployment requirements and runtime configuration:
```
usePower("agentcore", "agentcore-mcp-server", "manage_agentcore_runtime", {})
```

### Manage AgentCore Memory

Get memory resource creation and CLI commands:
```
usePower("agentcore", "agentcore-mcp-server", "manage_agentcore_memory", {})
```

### Manage AgentCore Gateway

Get gateway configuration and deployment instructions:
```
usePower("agentcore", "agentcore-mcp-server", "manage_agentcore_gateway", {})
```

## Troubleshooting

### Dev Server Won't Start

**Error:** `Could not find entrypoint module`
**Solution:** Ensure `.bedrock_agentcore.yaml` exists or specify entrypoint manually

**Error:** `Port 8080 already in use`
**Solution:** The CLI will automatically try the next available port

### Local Invoke Fails

**Error:** `Connection refused`
**Solution:** Ensure dev server is running with `agentcore dev`

**Error:** `Invalid JSON payload`
**Solution:** Use proper JSON format or plain text (which gets auto-wrapped)

### Deployment Issues

**Error:** `AWS authentication failed`
**Solution:** Run `aws login` to authenticate

**Error:** `Model access denied`
**Solution:** Verify you have permissions for the Bedrock model in AWS console

## Additional Resources

For detailed development workflow guidance, see the steering file which covers:
- Complete project creation options
- Development server configuration
- Testing strategies
- Deployment best practices

Use `readPowerSteering("agentcore", "getting-started")` for the full guide.
