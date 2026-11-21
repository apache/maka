---
name: "power-builder"
displayName: "Power Builder"
description: "Complete guide for building and testing new Kiro Powers with templates, best practices, and validation"
keywords: ["kiro power", "power builder", "build power", "create power", "mcp power", "power documentation"]
author: "Kiro Team"
---

# Power Builder

## Overview

Learn how to build your own Kiro Powers with comprehensive guides covering everything from initial setup to testing and sharing. This power provides step-by-step instructions, templates, best practices, and validation tools for creating Guided MCP Powers and Knowledge Base Powers.

Whether you're documenting an MCP server, creating a CLI tool guide, or sharing best practices, this power walks you through the complete process including:
- Understanding the two types of powers (Guided MCP Powers and Knowledge Base Powers)
- Creating proper directory structures and required files
- Writing effective POWER.md documentation with frontmatter
- Configuring mcp.json for MCP servers
- Deciding when to split powers into multiple workflows
- Interactive power creation with agent guidance
- Testing locally with configure
- Sharing via repositories

## Getting Started

**For AI agents helping users build powers:**

This documentation provides all the concepts, schemas, and best practices you need. Once you've reviewed this, **read the interactive steering file for step-by-step guidance**:

```
Call action "readSteering" with powerName="power-builder", steeringFile="interactive.md"
```

The interactive workflow will guide you through:
- Understanding the user's use case
- Determining the right power type
- Gathering documentation
- Generating all necessary files
- Testing and installation

## Available Steering Files

This power has two steering files:

- **interactive** - Interactive agent-guided power creation workflow (read this after reviewing the documentation below)
- **testing** - Complete guide to testing and updating powers

**All conceptual knowledge is in this POWER.md file.** The steering files provide workflows for creation and testing.

## What is a Kiro Power?

A **Kiro Power** is documentation that packages:
1. **Knowledge** - POWER.md file with instructions, workflows, and best practices
2. **Optional MCP Integration** - mcp.json configuration if the power needs MCP servers
3. **Optional Steering** - Additional workflow guides for complex use cases

**Two Types:**
- **Guided MCP Powers** - Include MCP server configuration (mcp.json) plus documentation
- **Knowledge Base Powers** - Pure documentation (no mcp.json), such as CLI tool guides or best practices

---

## Philosophy: Two Types of Powers

### 1. Guided MCP Power 🎯

**Definition**: Powers that connect to MCP servers with comprehensive documentation.

**Structure:**
- `POWER.md` - Onboarding, workflows, troubleshooting
- `mcp.json` - MCP server configuration (required)
- Optional: `steering/` for multiple workflow guides

**When to Create:**
- You want to document an MCP server
- You need to provide setup and usage instructions
- You want to guide users through MCP tool usage

**Examples:**
- **Generate Release Notes** - Uses git MCP to parse commits and format changelogs
- **Supabase Local Dev** - Local development workflow for Supabase
- **Supabase Remote Dev** - Remote/cloud workflow for Supabase

**Steering Content**: Acts as a **knowledge base + configuration**
- Onboarding: Setup, installation, prerequisites
- Common workflows: Step-by-step instructions
- Troubleshooting: Common MCP errors and solutions

**Example Frontmatter:**
```yaml
---
name: "generate-release-notes"
displayName: "Generate Release Notes"
description: "Generate formatted release notes from git commits"
keywords: ["release", "changelog", "version", "notes", "git"]
author: "Your Name"
---
```

### 2. Knowledge Base Power 📚

**Definition**: Powers that provide pure documentation without MCP server connection.

**Structure:**
- `POWER.md` - Knowledge base content
- Optional: `steering/` for organized documentation
- **No mcp.json** file (this is the key difference)

**Important:** Knowledge Base Powers should usually include an **Onboarding section** in POWER.md to help users get started with the documented tool or knowledge.

**Common Subtypes:**
- **CLI Tool Guides** - Installation, usage, troubleshooting for command-line tools
- **Best Practices** - Coding patterns, architecture guidelines, security checklists
- **Workflow Documentation** - Step-by-step processes and procedures
- **Troubleshooting Guides** - Problem-solving knowledge bases
- **Reference Documentation** - Quick references, API guides, cheatsheets

**When to Create:**
- Documenting a CLI tool (not an MCP server)
- Sharing best practices or patterns
- Creating workflow guides
- Building troubleshooting knowledge bases

**Examples:**
- **Terraform CLI Guide** - Installation and usage of Terraform CLI
- **Best Practices Guide** - Coding patterns, architecture guidelines
- **Security Checklist** - Security review steps
- **Testing Strategies** - Test organization patterns

**Steering Content for CLI Tools**: Acts as **comprehensive guide**
- Onboarding: CLI installation instructions, prerequisites
- Common workflows: How to use CLI for various tasks
- Troubleshooting: Common CLI errors and solutions

**Steering Content for Other Types**: Acts as **knowledge repository**
- Best practices and guidelines
- Decision trees and checklists
- Pattern libraries
- Reference documentation

**Example Frontmatter:**
```yaml
---
name: "terraform-cli-guide"
displayName: "Terraform CLI Guide"
description: "Complete guide for using Terraform CLI with best practices"
keywords: ["terraform", "cli", "infrastructure", "iac"]
author: "Your Name"
---
```

---

### Decision Matrix: Which Type Should I Build?

| Question | Guided MCP Power | Knowledge Base Power |
|----------|------------------|----------------------|
| Does it connect to an MCP server? | ✅ Yes | ❌ No |
| Has mcp.json file? | ✅ Yes | ❌ No |
| Documents a CLI tool? | ❌ No | ✅ Often |
| Pure documentation/knowledge? | ❌ No (has tools) | ✅ Yes |
| Requires MCP tool execution? | ✅ Yes | ❌ No |
| Example: Git MCP server guide | ✅ Guided MCP Power | ❌ Not this type |
| Example: Terraform CLI guide | ❌ Not this type | ✅ Knowledge Base Power |
| Example: Best practices doc | ❌ Not this type | ✅ Knowledge Base Power |

---

## File Locations Reference

Understanding where Kiro stores configuration and steering files:

### MCP Configuration Locations

**Workspace Level:**
```
.kiro/settings/mcp.json
```
- Located in workspace root
- Workspace-specific MCP servers
- Checked first when looking for existing MCP configs

**User Level:**
```
~/.kiro/settings/mcp.json
```
- Global MCP servers available across all workspaces
- Fallback if workspace config doesn't exist

**Powers Configuration (Generated):**
```
~/.kiro/powers.mcp.json
```
- Auto-generated from installed powers
- Combines MCP configs from all installed powers

### Steering File Locations

**Workspace Level:**
```
.kiro/steering/
```
- Workspace-specific steering files
- Can be used as source for Knowledge Base Powers

**User Level:**
```
~/.kiro/steering/
```
- Global steering files
- Available across all workspaces
- Can be used as source for Knowledge Base Powers

---

## Power Granularity Best Practices

### Default: Single Power is Best

**⭐ IMPORTANT: A single power is perfectly fine for most cases.**

Do NOT default to suggesting splitting powers. Most tools should be documented as a single comprehensive power.

**Only split if there's a very strong conviction that it will significantly improve usability.**

### When to Split Powers (Rare)

Split only when there's a **strong conviction** that workflows are:
- **Completely independent** and never used together
- In **different environments** (local vs remote, dev vs prod)
- Require **different setups** or configurations
- Would be **confusing** if combined

**Examples of valid splitting (rare):**
```
Example: Supabase
✅ supabase-local-dev (local environment, different setup)
✅ supabase-remote-dev (cloud environment, different auth)
Reasoning: Entirely different contexts, users only use one at a time
```

### Default: Keep Together (Most Cases)

**The vast majority of tools should be a single power:**

❌ **Don't split these** - keep as one power:
```
✅ terraform (all commands together)
✅ git (all operations together)
✅ docker (full container lifecycle)
✅ aws-cli (all AWS services)
✅ kubectl (all Kubernetes operations)
✅ postgresql (all database operations)
```

**Even if there are many commands or workflows, keep them together unless there's a strong reason to split.**

### Naming Convention

**Default naming (use this):**
```
{tool-name}
```
Examples: `terraform`, `git`, `docker`, `kubectl`

**Only if splitting (rare):**
```
{tool-name}-{workflow-name}
```
Examples: `supabase-local-dev`, `supabase-remote-dev`

### Decision Framework

**Start with:** Should this be a single power? (Default answer: YES)

**Only split if ALL of these are true:**
1. ✅ Workflows are completely independent
2. ✅ Users will never need both together
3. ✅ Different environments or contexts
4. ✅ You have strong conviction it improves usability

**If even one is false → Keep as a single power**

---

## Knowledge Base Power Patterns

### Pattern 1: CLI Tool Guide

Structure for documenting command-line tools:

**POWER.md Contents:**
1. **Onboarding Section**
   - CLI installation instructions
   - Prerequisites (Node.js, Python, system requirements)
   - Basic setup and configuration

2. **Common Workflows Section**
   - Step-by-step CLI usage for common tasks
   - Command examples with explanations
   - Flag and option documentation

3. **Troubleshooting Section**
   - Common CLI errors
   - Installation issues
   - Platform-specific problems

**Example Structure:**
```markdown
## Onboarding

### Installation

#### Via npm
```bash
npm install -g tool-name
```

#### Via pip
```bash
pip install tool-name
```

### Prerequisites
- Node.js 16+ or Python 3.8+
- Operating system: macOS, Linux, Windows

### Basic Configuration
```bash
tool-name config set api-key YOUR_API_KEY
```

## Common Workflows

### Workflow 1: Initialize Project
```bash
# Create new project
tool-name init my-project

# Navigate to project
cd my-project

# Verify setup
tool-name status
```

### Workflow 2: Deploy Application
```bash
# Build project
tool-name build

# Test locally
tool-name serve --local

# Deploy to production
tool-name deploy --production
```

## Troubleshooting

### Error: "Command not found"
**Cause:** CLI not in PATH
**Solution:**
1. Verify installation: `which tool-name`
2. Add to PATH if needed
3. Restart terminal

### Error: "Permission denied"
**Cause:** Insufficient permissions
**Solution:**
1. Use `sudo` (Linux/macOS)
2. Run as administrator (Windows)
3. Check file permissions
```

### Pattern 2: Best Practices Guide

Structure for documenting patterns and guidelines:

**POWER.md Contents:**
1. **Overview**: What the best practices cover
2. **Principles**: Core principles to follow
3. **Patterns**: Specific patterns with examples
4. **Examples**: Real-world examples

**Example Structure:**
```markdown
## Overview
Comprehensive security best practices for web applications

## Core Principles
1. **Defense in Depth** - Multiple layers of security
2. **Least Privilege** - Minimal necessary permissions
3. **Fail Securely** - Safe failure modes

## Patterns

### Pattern: Input Validation
**Problem:** Untrusted user input
**Solution:** Validate and sanitize all inputs
```
// Good
const sanitized = sanitizeInput(userInput);
if (isValid(sanitized)) {
  process(sanitized);
}

// Bad
process(userInput); // Direct use without validation
```
```

### Pattern 3: Troubleshooting Guide

Structure for problem-solving documentation:

**POWER.md Contents:**
1. **Common Problems**: List of frequent issues
2. **Diagnostic Steps**: How to identify problems
3. **Solutions**: Step-by-step fixes
4. **Prevention**: How to avoid problems

**Example Structure:**
```markdown
## Common Problems

### Problem: Application Won't Start

**Symptoms:**
- Error: "Port already in use"
- Application crashes immediately
- No logs appearing

**Diagnostic Steps:**
1. Check if port is available: `lsof -i :3000`
2. Review error logs: `tail -f logs/error.log`
3. Verify dependencies: `npm list`

**Solution:**
1. Kill process using port:
   ```bash
   kill $(lsof -t -i:3000)
   ```
2. Or use different port:
   ```bash
   PORT=3001 npm start
   ```

**Prevention:**
- Use environment variables for ports
- Implement graceful shutdown
- Document port requirements
```

### Pattern 4: Reference Documentation

Structure for quick reference guides:

**POWER.md Contents:**
1. **Quick Reference**: Cheat sheet format
2. **API Reference**: Function/endpoint documentation
3. **Examples**: Common usage examples
4. **See Also**: Related documentation

**Example Structure:**
```markdown
## Quick Reference

### Common Commands
| Command | Description | Example |
|---------|-------------|---------|
| `init` | Initialize project | `tool init my-app` |
| `build` | Build project | `tool build --prod` |
| `deploy` | Deploy to production | `tool deploy` |

### Configuration Options
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | 3000 | Server port |
| `env` | string | "development" | Environment |

## API Reference

### Method: `create(options)`
Creates a new resource

**Parameters:**
- `options.name` (string, required): Resource name
- `options.type` (string, optional): Resource type

**Returns:** Promise<Resource>

**Example:**
```
const resource = await create({
  name: "my-resource",
  type: "standard"
});
```
```

---

## Power Structure

Powers can have three different structures depending on complexity:

### Pattern A: Simple Power (Most Common)
```
weather/
├── mcp.json    # MCP server config
└── POWER.md    # Everything: metadata + docs + steering
```
**Use for:** Most powers. Everything agents need is in POWER.md.

### Pattern B: Multiple Workflow Power
```
playwright/
├── mcp.json         # MCP server config
├── POWER.md         # Overview + common patterns
└── steering/        # Dynamic content loaded on-demand
    ├── web-scraping.md
    ├── e2e-testing.md
    └── performance.md
```
**Use when:** POWER.md >500 lines OR independent workflows OR progressive discovery needed.

**Note:** Steering files can contain workflows, troubleshooting guides, advanced features, references - any dynamic content loaded on-demand.

### Pattern C: Knowledge Base Power (No MCP)
```
testing-strategies/
├── POWER.md         # Overview of all topics
└── steering/        # Knowledge repository
    ├── unit-testing.md
    ├── integration-testing.md
    └── e2e-testing.md
```
**Use for:** Pure documentation/guidance. Maximum context preservation - agents only load what's relevant.

### Required Components

**ALL powers MUST have:**
1. **POWER.md** (required) - With complete frontmatter metadata
   - name, displayName, description (required)
   - keywords, author (optional but recommended)
   - Overview and documentation

**Guided MCP Powers ALSO need:**
2. **mcp.json** (required) - MCP server configuration

**Powers with multiple workflows MAY have:**
3. **steering/** directory (optional) - Additional dynamic content

### File Purpose

| Component | Purpose | Read By | When |
|-----------|---------|---------|------|
| `POWER.md` | **REQUIRED:** Metadata + primary documentation | Agent | **First** (via activate action) |
| `mcp.json` | Technical MCP server config (if power has tools) | System | Installation |
| `steering/*.md` | Dynamic content (workflows, troubleshooting, advanced features, references) | Agent | **On-demand** (via readSteering action) |

**Context Strategy:** Agents get steeringFiles list from activate, then load specific files only when needed.

---

## mcp.json Format

**Required for:** Guided MCP Powers
**Not needed for:** Knowledge Base Powers

**Schema:**
```json
{
  "mcpServers": {
    "server-name": {
      // Local (STDIO) MCP Server:
      "command": "string",
      "args": ["array"],
      "env": {"KEY": "value"},
      "cwd": "string",

      // OR Remote (HTTP/SSE) MCP Server:
      "url": "string",
      "headers": {"Authorization": "Bearer token"},

      // Common options:
      "disabled": false,
      "autoApprove": ["tool_name"],
      "disabledTools": []
    }
  }
}
```

**Note:** Use either local (command/args) OR remote (url/headers), not both.

**Single MCP Server Example:**
```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@dangahagan/weather-mcp"],
      "env": {"ENABLED_TOOLS": "all"}
    }
  }
}
```

**Multiple MCP Servers Example:**
```json
{
  "mcpServers": {
    "github-api": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_TOKEN": "GITHUB_TOKEN_ENV_VAR"}
    },
    "git-local": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git"]
    }
  }
}
```

---

## POWER.md Frontmatter Format

**Only these 5 fields exist:**
```yaml
---
name: "power-name"
displayName: "Human Readable Name"
description: "Clear description (max 3 sentences)"
keywords: ["keyword1", "keyword2", "keyword3"]
author: "Your Name"
---
```

**Required Fields:**
- `name`: Lowercase kebab-case identifier
- `displayName`: Human-readable title
- `description`: Clear description (max 3 sentences)

**Optional Fields:**
- `keywords`: Search keywords (improves discoverability)
- `author`: Creator name or organization

**IMPORTANT:** Fields like `version`, `tags`, `repository`, `license` do NOT exist and should NOT be used.

**Recommended POWER.md Sections:**
- **Overview**: What the power does and why it's useful
- **Available Steering Files**: List of steering files (if any)
- **Available MCP Servers**: Server and tool listings (if Guided MCP Power)
- **Tool Usage Examples**: How to use tools (if Guided MCP Power)
- **Best Practices**: Key practices for using this power
- **Troubleshooting**: Common errors and solutions
- **Configuration**: Setup requirements (if any)

### Optional `steering/*.md` Files

**Only create when:**
- POWER.md exceeds ~500 lines (context preservation)
- Power has independent workflows that don't need to be loaded together
- Dynamic content loading improves usability

**Use cases:**
- Independent workflows (web-scraping.md, e2e-testing.md)
- Advanced patterns (advanced-automation.md)
- Specialized domains (mobile-testing.md)
- Troubleshooting guides (troubleshooting.md)
- Reference docs (reference.md)

**When NOT to create:**
- Power is simple (< 500 lines in POWER.md)
- All content is closely related
- Agents need all information upfront

## Testing and Validation

For complete testing and validation instructions, read the testing steering file:

```
Call action "readSteering" with powerName="power-builder", steeringFile="testing.md"
```

The testing guide covers:
- Local testing workflow
- Installation via local directory
- Testing checklist
- Troubleshooting common issues
- Updating powers

---

## Best Practices

### Naming Conventions

**Power Names:**
- Use `kebab-case-format`
- Be descriptive: `generate-release-notes`, `track-competitor-prices`
- Action-oriented for workflow powers, tool-oriented for general powers
- Avoid: too generic (`helper`, `utils`), too long (>5 words)

**Display Names:**
- Use Title Case: "Generate Release Notes"
- Keep clear and professional (2-5 words)
- No emojis in display names

**Keywords:**
- Include 5-7 relevant keywords
- Mix specific and general terms
- Think about user search patterns
- Include variations: "release", "changelog", "version"

### Description Writing

- Maximum 3 sentences
- Focus on value, not implementation
- Include key capabilities
- Use active voice

**Good Examples:**
- "Generate formatted release notes and changelogs from git commits with categorized changes"
- "Monitor competitor prices by scraping websites - compose with SQLite for historical tracking"
- "Complete browser automation - navigate, test, screenshot, scrape any web task"

### Documentation Quality

- Document exact MCP tool names (agents need these to call tools)
- Show complete, runnable examples
- Include troubleshooting for common errors
- Explain parameters clearly (types, required/optional)
- Cover all required sections thoroughly

### File Organization

- Put metadata in POWER.md frontmatter (never in mcp.json)
- Only create steering/ directory when needed (>500 lines or dynamic loading)
- Use workspace paths for development: `{workspace}/powers/`
- Default to single power (only split with strong conviction)

### MCP Configuration

- Never include display metadata in mcp.json (goes in POWER.md frontmatter)
- Document environment variables clearly
- Provide MCP configuration reference: https://kiro.dev/docs/mcp/configuration/
- Only disable tools with explicit user consent

---
