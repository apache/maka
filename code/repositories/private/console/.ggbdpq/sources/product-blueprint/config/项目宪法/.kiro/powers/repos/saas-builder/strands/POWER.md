---
name: "strands"
displayName: "Build an agent with Strands SDK"
description: "Build AI agents with Strands SDK using Bedrock, Anthropic, OpenAI, Gemini, or Llama models"
keywords: ["agents", "ai", "llm", "bedrock", "anthropic", "openai", "gemini", "strands", "tools"]
author: "AWS"
---

# Strands Agents SDK Power

## Overview

Build AI agents quickly with the Strands Agents SDK. Create agents that use tools, maintain conversation context, and work with multiple LLM providers including Amazon Bedrock (default), Anthropic Claude, OpenAI GPT, Google Gemini, and Meta Llama. The SDK handles the complexity of tool calling, conversation history, and model integration so you can focus on building agent capabilities.

Perfect for creating chatbots, automation agents, data analysis assistants, and any AI-powered workflow that needs tool use and multi-turn conversations.

**No complex setup required** - works with Bedrock out of the box, or add your preferred provider with a simple pip install.

## CRITICAL: Always Read Getting Started Guide

**BEFORE using this power or creating any agent code, you MUST read the getting-started.md steering file.** This contains the correct API usage, proper method names, and essential patterns. Use `kiroPowers` with action="readSteering", powerName="strands", steeringFile="getting-started.md" to access it.

## Available Steering Files

This power includes a comprehensive getting-started guide:

- **getting-started** - Complete guide for building agents with all model providers, installation, tools, and troubleshooting

## Available MCP Servers

### strands-agents
**Package:** `strands-agents-mcp-server`

1. **search_docs** - Search curated documentation and return ranked results with snippets
   - Required: `query` (string) - Search query (e.g., "bedrock model", "how to use tools")
   - Optional: `k` (integer) - Maximum number of results to return (default: 5)
   - Returns: List of documents with URL, title, relevance score, and content snippet

2. **fetch_doc** - Fetch full document content by URL
   - Optional: `uri` (string) - Document URI (http/https URL). If empty, returns all available URLs
   - Returns: Full document with URL, title, and complete text content

## Tool Usage Examples

### Search Documentation

```javascript
usePower("strands", "strands-agents", "search_docs", {
  "query": "how to create custom tools",
  "k": 3
})
// Returns: Top 3 relevant documentation sections about creating tools
```

### Fetch Complete Documentation

```javascript
usePower("strands", "strands-agents", "fetch_doc", {
  "uri": "https://docs.strands.ai/user-guide/tools"
})
// Returns: Complete documentation page about tools
```

## Best Practices

### ✅ Do:
- Use Bedrock as default provider (included in base package)
- Install provider extensions only when needed: `pip install 'strands-agents[provider]'`
- Always install community tools: `pip install strands-agents-tools`
- Set API keys as environment variables (AWS_BEDROCK_API_KEY, ANTHROPIC_API_KEY, etc.)
- Use clear docstrings for custom tools - models read them
- Test agents immediately after creation with simple queries
- Use lower temperature (0.1-0.3) for factual tasks, higher (0.7-0.9) for creative
- Enable model access in Bedrock console before using
- Use `SystemContentBlock` with `cachePoint` for long prompts (1024+ tokens)

### ❌ Don't:
- Install all provider extensions if you only need one
- Hardcode API keys in code - use environment variables
- Skip tool docstrings - they guide the model's tool usage
- Use production AWS credentials for development (use Bedrock API keys)
- Forget to enable model access in Bedrock console
- Set max_tokens too low - agents need room for tool calls and responses
- Ignore conversation history - agents maintain context automatically

## Configuration

### Quick Setup (Bedrock - Default)

1. **Get Bedrock API Key** (for development/exploration):
   - Open [Bedrock Console](https://console.aws.amazon.com/bedrock) → API keys
   - Generate long-term API key (30 days)
   - Copy and save securely (shown only once)

2. **Enable Model Access**:
   - Bedrock Console → Model access → Manage model access
   - Enable Claude 4 Sonnet or your preferred model

3. **Set Environment Variable**:
   ```bash
   export AWS_BEDROCK_API_KEY=your_bedrock_api_key
   ```

4. **Install SDK**:
   ```bash
   pip install strands-agents strands-agents-tools
   ```

### Other Providers

**Anthropic:**
- Get API key: [Anthropic Console](https://console.anthropic.com/)
- Install: `pip install 'strands-agents[anthropic]' strands-agents-tools`
- Set: `export ANTHROPIC_API_KEY=your_key`

**OpenAI:**
- Get API key: [OpenAI Platform](https://platform.openai.com/api-keys)
- Install: `pip install 'strands-agents[openai]' strands-agents-tools`
- Set: `export OPENAI_API_KEY=your_key`

**Google Gemini:**
- Get API key: [Google AI Studio](https://aistudio.google.com/apikey)
- Install: `pip install 'strands-agents[gemini]' strands-agents-tools`
- Set: `export GOOGLE_API_KEY=your_key`

**Meta Llama:**
- Get API key: [Meta Llama API](https://llama.developer.meta.com/)
- Install: `pip install 'strands-agents[llamaapi]' strands-agents-tools`
- Set: `export LLAMA_API_KEY=your_key`

## Troubleshooting

### Error: "Module 'strands.models.anthropic' not found"
**Cause:** Provider extension not installed
**Solution:**
1. Install the provider extension: `pip install 'strands-agents[anthropic]'`
2. Verify installation: `pip list | grep strands`
3. Restart Python interpreter if running in REPL

### Error: "Access denied to model"
**Cause:** Model access not enabled in Bedrock console
**Solution:**
1. Open [Bedrock Console](https://console.aws.amazon.com/bedrock)
2. Navigate to "Model access" in left sidebar
3. Click "Manage model access"
4. Enable the model you want to use (e.g., Claude 4 Sonnet)
5. Wait a few minutes for access to propagate

### Error: "Invalid API key" or "Authentication failed"
**Cause:** API key not set or incorrect
**Solution:**
1. Verify environment variable is set: `echo $AWS_BEDROCK_API_KEY`
2. Check for typos in the key
3. For Bedrock API keys, verify it hasn't expired (30-day limit)
4. Regenerate key if needed from provider console

### Error: "Token limit exceeded"
**Cause:** Response or tool calls exceed max_tokens setting
**Solution:**
1. Increase max_tokens in model configuration: `max_tokens=4096`
2. Simplify tool specifications (shorter docstrings)
3. Use fewer tools per agent
4. Break complex tasks into smaller steps

### Error: "Tool not found" or "Tool execution failed"
**Cause:** Tool not properly registered or has errors
**Solution:**
1. Verify tool is in the tools list: `Agent(tools=[your_tool])`
2. Check tool function has `@tool` decorator
3. Ensure tool has proper docstring with Args section
4. Test tool independently before adding to agent
5. Check tool return type matches docstring

### Error: "AWS credentials not found"
**Cause:** Using AWS credentials instead of Bedrock API key
**Solution:**
1. For development: Use Bedrock API key: `export AWS_BEDROCK_API_KEY=your_key`
2. For production: Configure AWS credentials: `aws configure`
3. Or set: `export AWS_ACCESS_KEY_ID=...` and `export AWS_SECRET_ACCESS_KEY=...`

### Agent gives incorrect or incomplete responses
**Cause:** Temperature too high or system prompt unclear
**Solution:**
1. Lower temperature for factual tasks: `temperature=0.1`
2. Make system prompt more specific and directive
3. Add examples in system prompt for complex tasks
4. Verify tools are working correctly independently

---

**Package:** `strands-agents-mcp-server`
**Source:** Official Strands SDK
**License:** MIT
