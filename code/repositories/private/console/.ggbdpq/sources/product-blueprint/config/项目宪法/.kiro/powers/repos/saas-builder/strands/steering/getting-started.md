# Building Agents with Strands Agents SDK

Quick reference for building agents with Strands SDK. Use the Strands Agents Documentation server for detailed documentation.

## Quickstart: Build Your First Agent

When a user asks to build an agent, follow these steps automatically:

**1. Install required packages** based on the chosen model provider (Bedrock by default):

```bash
# For Bedrock (default)
pip install strands-agents strands-agents-tools

# For other providers, add the appropriate extension:
# pip install 'strands-agents[anthropic]' strands-agents-tools
# pip install 'strands-agents[openai]' strands-agents-tools
# pip install 'strands-agents[gemini]' strands-agents-tools
# pip install 'strands-agents[llamaapi]' strands-agents-tools
```

**2. Configure API credentials** for the chosen provider (prompt user if not set):

```bash
# For Bedrock - check for AWS credentials or API key
# For Anthropic - check for ANTHROPIC_API_KEY
# For OpenAI - check for OPENAI_API_KEY
# For Gemini - check for GOOGLE_API_KEY
# For Meta Llama - check for LLAMA_API_KEY
```

**3. Create your agent file** (`agent.py`):

```python
from strands import Agent
from strands_tools import calculator, python_repl, http_request

# Create an agent with community tools (uses Bedrock Claude 4 Sonnet by default)
agent = Agent(
    tools=[calculator, python_repl, http_request],
    system_prompt="You are an expert in the international space station and geography."
)

# Test the agent
response = agent("Which city is the closest to the international space station right now?")
print(response)
```

**4. Run the agent immediately** to verify it works:

```bash
python agent.py
```

> **Important:** Always complete all 4 steps automatically when building an agent. Don't wait for the user to ask to run the code.

**5. Iterate with conversation history:**

```python
# The agent maintains conversation context automatically
agent("My name is Alice")
response = agent("What's my name?")
print(response)  # Will remember "Alice"
```

## Installation

```bash
# Core SDK (includes Amazon Bedrock as a default model provider)
pip install strands-agents

# Model Provider Extensions
pip install 'strands-agents[anthropic]'  # Anthropic Claude
pip install 'strands-agents[openai]'     # OpenAI GPT
pip install 'strands-agents[gemini]'     # Google Gemini
pip install 'strands-agents[llamaapi]'   # Meta Llama

# Community tools (optional)
pip install strands-agents-tools
```

## Basic Agent Pattern

```python
from strands import Agent

agent = Agent(
    model=model_instance,      # Model provider (optional, defaults to Bedrock)
    tools=[tool1, tool2],      # Optional tools
    system_prompt="Instructions",  # Optional system prompt
)

response = agent("Your question here")
```

## Model Providers

### Amazon Bedrock (Default)

**Get API Key (Quick Start):**
1. Open [Bedrock Console](https://console.aws.amazon.com/bedrock) → API keys
2. Generate long-term API key (30 days, for development only)
3. Copy and save the key securely (shown only once)
4. Enable model access: Bedrock Console → Model access → Manage model access

**Setup:**

```bash
# Option 1: Simple API key (development/exploration)
export AWS_BEDROCK_API_KEY=your_bedrock_api_key

# Option 2: AWS credentials (production)
aws configure
# OR
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_REGION=us-west-2
```

**Note:** Long-term API keys expire in 30 days. For production, use IAM roles or temporary credentials.

**Usage:**

```python
from strands import Agent
from strands.models import BedrockModel
from strands_tools import calculator, python_repl, http_request

# Simplest - uses Claude 4 Sonnet
agent = Agent(
    tools=[calculator, python_repl, http_request],
    system_prompt="You are an expert in the international space station and geography."
)

response = agent("Which city is the closest to the international space station right now?")
print(response)

# With model ID string
agent = Agent(
    model="anthropic.claude-sonnet-4-20250514-v1:0",
    tools=[calculator, python_repl, http_request],
    system_prompt="You are an expert in the international space station and geography."
)

# Full configuration
model = BedrockModel(
    model_id="anthropic.claude-sonnet-4-20250514-v1:0",
    region_name="us-west-2",
    temperature=0.7,
    max_tokens=2048,
)

agent = Agent(
    model=model,
    tools=[calculator, python_repl, http_request],
    system_prompt="You are an expert in the international space station and geography."
)
```

**Popular Models:**
- `anthropic.claude-sonnet-4-20250514-v1:0` (default)
- `anthropic.claude-3-5-sonnet-20241022-v2:0`
- `us.amazon.nova-premier-v1:0`
- `us.amazon.nova-pro-v1:0`
- `us.meta.llama3-2-90b-instruct-v1:0`

### Anthropic (Direct)

**Get API Key:** Anthropic Console → API Keys ([Get started](https://console.anthropic.com/))

**Setup:**

```bash
pip install 'strands-agents[anthropic]'
export ANTHROPIC_API_KEY=your_anthropic_api_key
```

**Usage:**

```python
from strands import Agent
from strands.models.anthropic import AnthropicModel
from strands_tools import calculator, python_repl, http_request
import os

model = AnthropicModel(
    client_args={"api_key": os.environ["ANTHROPIC_API_KEY"]},
    model_id="claude-sonnet-4-20250514",
    max_tokens=1028,
    params={"temperature": 0.7}
)

agent = Agent(
    model=model,
    tools=[calculator, python_repl, http_request],
    system_prompt="You are an expert in the international space station and geography."
)

response = agent("Which city is the closest to the international space station right now?")
print(response)
```

**Popular Models:**
- `claude-sonnet-4-20250514`
- `claude-3-5-sonnet-20241022`
- `claude-3-opus-20240229`

### Meta Llama (Direct)

**Get API Key:** Meta Llama API → Create API Key ([Get started](https://llama.developer.meta.com/))

**Setup:**

```bash
pip install 'strands-agents[llamaapi]'
export LLAMA_API_KEY=your_llama_api_key
```

**Usage:**

```python
from strands import Agent
from strands.models.llamaapi import LlamaAPIModel
from strands_tools import calculator, python_repl, http_request
import os

model = LlamaAPIModel(
    client_args={"api_key": os.environ["LLAMA_API_KEY"]},
    model_id="Llama-4-Maverick-17B-128E-Instruct-FP8",
    temperature=0.7,
    max_completion_tokens=2048
)

agent = Agent(
    model=model,
    tools=[calculator, python_repl, http_request],
    system_prompt="You are an expert in the international space station and geography."
)

response = agent("Which city is the closest to the international space station right now?")
print(response)
```

**Popular Models:**
- `Llama-4-Maverick-17B-128E-Instruct-FP8`
- `Llama-3.3-70B-Instruct`
- `Llama-3.2-90B-Vision-Instruct`

### Google Gemini

**Get API Key:** Google AI Studio → Get API Key ([Get started](https://aistudio.google.com/apikey))

**Setup:**

```bash
pip install 'strands-agents[gemini]'
export GOOGLE_API_KEY=your_google_api_key
```

**Usage:**

```python
from strands import Agent
from strands.models.gemini import GeminiModel
from strands_tools import calculator, python_repl, http_request
import os

model = GeminiModel(
    client_args={"api_key": os.environ["GOOGLE_API_KEY"]},
    model_id="gemini-2.5-pro",
)

agent = Agent(
    model=model,
    tools=[calculator, python_repl, http_request],
    system_prompt="You are an expert in the international space station and geography."
)

response = agent("Which city is the closest to the international space station right now?")
print(response)
```

**Popular Models:**
- `gemini-3-pro-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`

### OpenAI

**Get API Key:** OpenAI Platform → API Keys ([Get started](https://platform.openai.com/api-keys))

**Setup:**

```bash
pip install 'strands-agents[openai]'
export OPENAI_API_KEY=your_openai_api_key
```

**Usage:**

```python
from strands import Agent
from strands.models.openai import OpenAIModel
from strands_tools import calculator, python_repl, http_request
import os

model = OpenAIModel(
    client_args={"api_key": os.environ["OPENAI_API_KEY"]},
    model_id="gpt-5-mini",
)

agent = Agent(
    model=model,
    tools=[calculator, python_repl, http_request],
    system_prompt="You are an expert in the international space station and geography."
)

response = agent("Which city is the closest to the international space station right now?")
print(response)
```

**Popular Models:**
- `gpt-5-mini`
- `gpt-5.1`

## Tools

```python
from strands import Agent, tool

@tool
def get_weather(location: str) -> str:
    """Get weather for a location.
    
    Args:
        location: City name
    """
    return f"Weather in {location}: Sunny, 72°F"

agent = Agent(tools=[get_weather])
```

**Community Tools:**

```python
from strands_tools import calculator, python_repl, http_request

agent = Agent(tools=[calculator, python_repl, http_request])
```

## Quick Tips

- **Temperature:** Lower (0.1-0.3) for factual, higher (0.7-0.9) for creative
- **Bedrock:** Requires AWS credentials and model access enabled
- **Tools:** Use clear docstrings - models read them
- **Caching:** Use `SystemContentBlock` with `cachePoint` for long prompts (1024+ tokens)

## Troubleshooting

- **Module not found:** Run `pip install 'strands-agents[provider]'`
- **Bedrock access:** Enable model in console, check IAM permissions
- **Token limits:** Increase `max_tokens` or simplify tool specs

Use the Strands Agents Documentation server for detailed documentation and additional features.
