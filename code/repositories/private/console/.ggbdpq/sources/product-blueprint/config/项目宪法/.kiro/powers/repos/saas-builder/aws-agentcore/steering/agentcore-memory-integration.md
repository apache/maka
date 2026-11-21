# AgentCore Memory Integration Guide

## Overview

This guide provides step-by-step instructions for adding AgentCore Memory to a Strands agent. Memory enables conversation persistence and long-term knowledge retention across sessions.

## Prerequisites

- Existing Strands agent deployed or ready to deploy
- `bedrock-agentcore-starter-toolkit` installed
- AWS credentials configured

## Step 1: Install Required Package

```bash
pip install 'bedrock-agentcore[strands-agents]'
```

Add to `pyproject.toml` or `requirements.txt`:
```
bedrock-agentcore[strands-agents]
```

## Step 2: Create Memory Resource

**IMPORTANT**: Memory creation is a ONE-TIME setup, done separately from your agent code.

### Option A: Using CLI (Recommended)

```bash
# Create basic memory (STM only)
agentcore memory create my_agent_memory \
    --description "Memory for my agent" \
    --region us-west-2 \
    --wait

# Create with LTM strategies (advanced)
agentcore memory create my_agent_memory \
    --description "Memory with long-term strategies" \
    --strategies '[
        {
            "summaryMemoryStrategy": {
                "name": "SessionSummarizer",
                "namespaces": ["/summaries/{actorId}/{sessionId}"]
            }
        },
        {
            "userPreferenceMemoryStrategy": {
                "name": "PreferenceLearner",
                "namespaces": ["/preferences/{actorId}"]
            }
        },
        {
            "semanticMemoryStrategy": {
                "name": "FactExtractor",
                "namespaces": ["/facts/{actorId}"]
            }
        }
    ]' \
    --region us-west-2 \
    --wait
```

### Option B: Using Python (for scripts)

```python
from bedrock_agentcore.memory import MemoryClient

client = MemoryClient(region_name="us-west-2")

# Basic memory
basic_memory = client.create_memory(
    name="MyAgentMemory",
    description="Memory for my agent"
)

memory_id = basic_memory.get('id')
print(f"Created memory with ID: {memory_id}")
```

**Save the memory ID** - you'll need it for your agent configuration.

## Step 3: Update Agent Code

Add memory imports and configuration to your agent:

```python
import os
from datetime import datetime
from strands import Agent
from bedrock_agentcore import BedrockAgentCoreApp
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload):
    # Memory configuration
    memory_id = "your-memory-id-here"  # From Step 2
    
    # Get session and actor IDs from payload or generate defaults
    session_id = payload.get("session_id", f"session_{datetime.now().strftime('%Y%m%d%H%M%S')}")
    actor_id = payload.get("actor_id", "default_user")
    
    # Create AgentCore Memory session manager
    agentcore_memory_config = AgentCoreMemoryConfig(
        memory_id=memory_id,
        session_id=session_id,
        actor_id=actor_id
    )
    
    session_manager = AgentCoreMemorySessionManager(
        agentcore_memory_config=agentcore_memory_config,
        region_name="us-west-2"
    )
    
    # Create agent with memory
    agent = Agent(
        system_prompt="You are a helpful assistant.",
        session_manager=session_manager
    )
    
    # Process the user prompt
    prompt = payload.get("prompt", "Hello")
    response = agent(prompt)
    
    return {
        "response": response,
        "session_id": session_id,
        "actor_id": actor_id
    }

if __name__ == "__main__":
    app.run()
```

## Step 4: Configure Environment Variables (Optional)

Create `.env` file:
```bash
AGENTCORE_MEMORY_ID=your-memory-id-here
AWS_REGION=us-west-2
```

Then use in code:
```python
memory_id = os.environ.get("AGENTCORE_MEMORY_ID", "fallback-memory-id")
```

## Step 5: Update AgentCore Configuration

Edit `.bedrock_agentcore.yaml`:

```yaml
agents:
  YourAgent:
    memory:
      mode: STM_ONLY  # or STM_AND_LTM for long-term memory
      memory_id: your-memory-id-here
      memory_name: MyAgentMemory
      event_expiry_days: 30
```

**CRITICAL DEPLOYMENT NOTE:**
- If deploying a NEW agent with memory, start with `mode: NO_MEMORY` first
- Deploy and test the agent successfully
- Then update to `mode: STM_ONLY` or `mode: STM_AND_LTM`
- Redeploy the agent

This ensures the agent works before adding memory complexity.

## Step 6: Deploy Agent

```bash
agentcore launch
```

## Step 7: Test Memory Functionality

Test conversation persistence:

```bash
# First message
agentcore invoke '{
    "prompt": "My name is Alice and I like pizza",
    "session_id": "test_session_001",
    "actor_id": "alice"
}'

# Second message - agent should remember
agentcore invoke '{
    "prompt": "What is my name and what do I like?",
    "session_id": "test_session_001",
    "actor_id": "alice"
}'
```

## Memory Management Commands

### List all memories
```bash
agentcore memory list --region us-west-2
```

### Get memory detailsd
```bash
agentcore memory get your-memory-id --region us-west-2
```

### Check memory status
```bash
agentcore memory status your-memory-id --region us-west-2
```

### Delete memory (WARNING: Permanent)
```bash
agentcore memory delete your-memory-id --region us-west-2 --wait
```

## Memory Configuration Options

### AgentCoreMemoryConfig Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `memory_id` | str | Yes | ID of the memory resource |
| `session_id` | str | Yes | Unique session identifier |
| `actor_id` | str | Yes | Unique user/actor identifier |
| `retrieval_config` | Dict | No | Configuration for LTM retrieval |

### RetrievalConfig (for LTM)

```python
from bedrock_agentcore.memory.integrations.strands.config import RetrievalConfig

config = AgentCoreMemoryConfig(
    memory_id=memory_id,
    session_id=session_id,
    actor_id=actor_id,
    retrieval_config={
        "/preferences/{actorId}": RetrievalConfig(
            top_k=5,
            relevance_score=0.7
        ),
        "/facts/{actorId}": RetrievalConfig(
            top_k=10,
            relevance_score=0.3
        )
    }
)
```

## Memory Strategies Explained

### 1. Short-Term Memory (STM)
- Stores conversation events within a session
- Automatic expiry based on retention policy (default: 90 days)
- Best for: Conversation continuity

### 2. Summary Memory Strategy
- Automatically summarizes conversation sessions
- Namespace: `/summaries/{actorId}/{sessionId}`
- Best for: Session recaps, context compression

### 3. User Preference Memory Strategy
- Learns and stores user preferences across sessions
- Namespace: `/preferences/{actorId}`
- Best for: Personalization, user settings

### 4. Semantic Memory Strategy
- Extracts and stores factual information
- Namespace: `/facts/{actorId}`
- Best for: Knowledge retention, fact recall

## Best Practices

1. **Session IDs**: Use consistent, meaningful session IDs for related conversations
2. **Actor IDs**: Use unique identifiers per user (e.g., user ID, email hash)
3. **Memory Modes**: Start with `STM_ONLY`, add LTM strategies as needed
4. **Testing**: Always test memory locally before deploying
5. **Monitoring**: Check CloudWatch logs for memory-related errors
6. **Cleanup**: Delete unused memory resources to avoid costs

## Troubleshooting

### Memory Not Persisting
- Verify memory ID is correct
- Check session_id is consistent across calls
- Ensure memory mode is not `NO_MEMORY`
- Check CloudWatch logs for errors

### Memory Creation Fails
- Verify AWS permissions for AgentCore Memory
- Check if memory name already exists
- Ensure region is supported

### Agent Fails After Adding Memory
- Start with `mode: NO_MEMORY` and test
- Verify memory resource is ACTIVE
- Check IAM role has memory permissions

## Example: Complete Agent with Memory

```python
import os
from datetime import datetime
from strands import Agent, tool
from bedrock_agentcore import BedrockAgentCoreApp
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

@tool
def get_time() -> str:
    """Get the current time"""
    return datetime.now().strftime("%H:%M:%S")

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload):
    # Memory configuration
    memory_id = os.environ.get("AGENTCORE_MEMORY_ID", "your-memory-id")
    session_id = payload.get("session_id", f"session_{datetime.now().strftime('%Y%m%d%H%M%S')}")
    actor_id = payload.get("actor_id", "default_user")
    
    # Create session manager
    config = AgentCoreMemoryConfig(
        memory_id=memory_id,
        session_id=session_id,
        actor_id=actor_id
    )
    
    session_manager = AgentCoreMemorySessionManager(
        agentcore_memory_config=config,
        region_name="us-west-2"
    )
    
    # Create agent with memory and tools
    agent = Agent(
        system_prompt="You are a helpful assistant with memory. Remember user preferences and past conversations.",
        tools=[get_time],
        session_manager=session_manager
    )
    
    # Process request
    prompt = payload.get("prompt", "Hello")
    response = agent(prompt)
    
    return {
        "response": response,
        "session_id": session_id,
        "actor_id": actor_id
    }

if __name__ == "__main__":
    app.run()
```

## Resources

- [AgentCore Memory Documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html)
- [Strands Session Management](https://strandsagents.com/latest/documentation/docs/user-guide/concepts/agents/session-management/)
- [Memory Namespaces Guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/session-actor-namespace.html)

## Quick Reference

```bash
# Create memory
agentcore memory create my_memory --wait

# List memories
agentcore memory list

# Get memory details
agentcore memory get <memory-id>

# Delete memory
agentcore memory delete <memory-id> --wait
```

---

**Remember**: Memory is created ONCE, then referenced by ID in your agent code. The memory resource persists independently of your agent deployments.
