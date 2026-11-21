---
name: mcp-server-builder
description: Builds Model Context Protocol (MCP) servers for Claude with tools, resources, and prompts. Use when users request "create MCP server", "build Claude tool", "MCP integration", or "custom Claude tools".
---

# MCP Server Builder

Create Model Context Protocol servers to extend Claude's capabilities with custom tools and resources.

## Core Workflow

1. **Define purpose**: Identify what capabilities to add
2. **Choose transport**: stdio (local) or HTTP/SSE (remote)
3. **Design tools**: Define tool schemas and handlers
4. **Add resources**: Optional file/data access
5. **Create prompts**: Optional reusable prompts
6. **Test locally**: Verify with MCP inspector
7. **Deploy**: Configure for Claude Desktop or API

## MCP Architecture Overview

```
┌─────────────┐     MCP Protocol      ┌─────────────┐
│   Claude    │◄────────────────────►│ MCP Server  │
│   (Host)    │  JSON-RPC over stdio  │  (Your App) │
└─────────────┘                       └─────────────┘
                                            │
                                            ▼
                                      ┌───────────┐
                                      │  Tools    │
                                      │ Resources │
                                      │  Prompts  │
                                      └───────────┘
```

## Project Setup

### TypeScript MCP Server

```bash
# Create project
mkdir my-mcp-server && cd my-mcp-server
npm init -y

# Install dependencies
npm install @modelcontextprotocol/sdk zod

# Dev dependencies
npm install -D typescript @types/node tsx
```

```json
// package.json
{
  "name": "my-mcp-server",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "my-mcp-server": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

## Basic Server Structure

```typescript
// src/index.ts
#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Create server instance
const server = new Server(
  {
    name: "my-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Define tools
const TOOLS = [
  {
    name: "get_weather",
    description: "Get current weather for a location",
    inputSchema: {
      type: "object" as const,
      properties: {
        location: {
          type: "string",
          description: "City name or coordinates",
        },
        units: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          default: "celsius",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "search_database",
    description: "Search the internal database",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        limit: {
          type: "number",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_weather": {
      const { location, units = "celsius" } = args as {
        location: string;
        units?: string;
      };

      // Implement your logic here
      const weather = await fetchWeather(location, units);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(weather, null, 2),
          },
        ],
      };
    }

    case "search_database": {
      const { query, limit = 10 } = args as { query: string; limit?: number };

      const results = await searchDatabase(query, limit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server running on stdio");
}

main().catch(console.error);

// Helper functions (implement your logic)
async function fetchWeather(location: string, units: string) {
  // Your implementation
  return { location, temperature: 22, units, condition: "sunny" };
}

async function searchDatabase(query: string, limit: number) {
  // Your implementation
  return { query, results: [], total: 0 };
}
```

## Tools

### Tool Schema Definition

```typescript
// src/tools/index.ts
import { z } from "zod";

// Define input schemas with Zod for validation
export const GetWeatherSchema = z.object({
  location: z.string().describe("City name or coordinates"),
  units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
});

export const SearchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  filters: z
    .object({
      category: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    })
    .optional(),
  limit: z.number().min(1).max(100).default(10),
});

// Convert Zod schema to JSON Schema for MCP
export function zodToJsonSchema(schema: z.ZodObject<any>) {
  // Use zod-to-json-schema package in production
  return schema;
}
```

### Tool Handler Pattern

```typescript
// src/tools/handlers.ts
import { z } from "zod";

type ToolHandler<T extends z.ZodSchema> = (
  args: z.infer<T>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

export function createToolHandler<T extends z.ZodSchema>(
  schema: T,
  handler: (args: z.infer<T>) => Promise<any>,
): ToolHandler<T> {
  return async (rawArgs) => {
    // Validate input
    const args = schema.parse(rawArgs);

    // Execute handler
    const result = await handler(args);

    // Format response
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  };
}

// Usage
export const handleGetWeather = createToolHandler(GetWeatherSchema, async ({ location, units }) => {
  const response = await fetch(
    `https://api.weather.com/v1/current?location=${location}&units=${units}`,
  );
  return response.json();
});
```

## Resources

### Static Resources

```typescript
// src/resources/index.ts
const RESOURCES = [
  {
    uri: "config://app-settings",
    name: "Application Settings",
    description: "Current application configuration",
    mimeType: "application/json",
  },
  {
    uri: "file://docs/readme",
    name: "Documentation",
    description: "Project documentation",
    mimeType: "text/markdown",
  },
];

// List resources handler
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: RESOURCES };
});

// Read resource handler
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case "config://app-settings":
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(getAppSettings(), null, 2),
          },
        ],
      };

    case "file://docs/readme":
      const content = await fs.readFile("./README.md", "utf-8");
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});
```

### Dynamic Resources

```typescript
// Resources with templates (e.g., database records)
const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "db://users/{userId}",
    name: "User Profile",
    description: "Get user by ID",
    mimeType: "application/json",
  },
];

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return { resourceTemplates: RESOURCE_TEMPLATES };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  // Parse URI to extract parameters
  const userMatch = uri.match(/^db:\/\/users\/(\w+)$/);
  if (userMatch) {
    const userId = userMatch[1];
    const user = await db.users.findById(userId);

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(user, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});
```

## Prompts

### Reusable Prompts

```typescript
// src/prompts/index.ts
const PROMPTS = [
  {
    name: "code_review",
    description: "Review code for best practices and issues",
    arguments: [
      {
        name: "language",
        description: "Programming language",
        required: true,
      },
      {
        name: "focus",
        description: "What to focus on (security, performance, style)",
        required: false,
      },
    ],
  },
  {
    name: "explain_error",
    description: "Explain an error message and suggest fixes",
    arguments: [
      {
        name: "error",
        description: "The error message",
        required: true,
      },
      {
        name: "context",
        description: "Additional context about what you were doing",
        required: false,
      },
    ],
  },
];

// List prompts handler
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: PROMPTS };
});

// Get prompt handler
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "code_review":
      return {
        description: "Code review prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please review the following ${args?.language || "code"} code.
${args?.focus ? `Focus particularly on: ${args.focus}` : ""}

Look for:
- Bugs and potential issues
- Security vulnerabilities
- Performance improvements
- Code style and best practices
- Suggestions for improvement`,
            },
          },
        ],
      };

    case "explain_error":
      return {
        description: "Error explanation prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `I encountered this error:

\`\`\`
${args?.error}
\`\`\`

${args?.context ? `Context: ${args.context}` : ""}

Please explain:
1. What this error means
2. Common causes
3. How to fix it
4. How to prevent it in the future`,
            },
          },
        ],
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});
```

## Error Handling

```typescript
// src/utils/errors.ts
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export class ToolError extends Error {
  constructor(
    message: string,
    public code: ErrorCode = ErrorCode.InternalError,
  ) {
    super(message);
    this.name = "ToolError";
  }

  toMcpError(): McpError {
    return new McpError(this.code, this.message);
  }
}

// Usage in handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    // ... handle tool
  } catch (error) {
    if (error instanceof ToolError) {
      throw error.toMcpError();
    }
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.errors.map((e) => e.message).join(", ")}`,
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
});
```

## Claude Desktop Configuration

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
// %APPDATA%\Claude\claude_desktop_config.json (Windows)
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "node",
      "args": ["/path/to/my-mcp-server/dist/index.js"],
      "env": {
        "API_KEY": "your-api-key"
      }
    },
    "npx-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    }
  }
}
```

## HTTP/SSE Transport

```typescript
// src/http-server.ts
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
const server = new Server(/* ... */);

// SSE endpoint for MCP
app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/mcp/messages", res);
  await server.connect(transport);
});

// Message endpoint
app.post("/mcp/messages", express.json(), async (req, res) => {
  // Handle incoming messages
});

app.listen(3000, () => {
  console.log("MCP HTTP server running on port 3000");
});
```

## Testing

### MCP Inspector

```bash
# Install MCP inspector
npx @modelcontextprotocol/inspector

# Run your server with inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

### Unit Tests

```typescript
// tests/tools.test.ts
import { describe, it, expect } from "vitest";
import { handleGetWeather } from "../src/tools/handlers";

describe("get_weather tool", () => {
  it("returns weather data for valid location", async () => {
    const result = await handleGetWeather({
      location: "New York",
      units: "celsius",
    });

    expect(result.content[0].type).toBe("text");
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty("temperature");
  });

  it("throws error for invalid location", async () => {
    await expect(handleGetWeather({ location: "", units: "celsius" })).rejects.toThrow();
  });
});
```

## Complete Example: GitHub MCP Server

```typescript
// src/index.ts
#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const server = new Server(
  { name: "github-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "list_issues",
    description: "List issues in a GitHub repository",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["owner", "repo", "title"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "list_issues": {
      const { owner, repo, state = "open" } = args as any;
      const { data } = await octokit.issues.listForRepo({ owner, repo, state });

      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            data.map((i) => ({ number: i.number, title: i.title, state: i.state })),
            null,
            2
          ),
        }],
      };
    }

    case "create_issue": {
      const { owner, repo, title, body, labels } = args as any;
      const { data } = await octokit.issues.create({ owner, repo, title, body, labels });

      return {
        content: [{
          type: "text",
          text: `Created issue #${data.number}: ${data.html_url}`,
        }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
```

## Best Practices

1. **Validate inputs**: Use Zod or similar for schema validation
2. **Handle errors gracefully**: Return meaningful error messages
3. **Use environment variables**: Never hardcode secrets
4. **Rate limit external calls**: Respect API limits
5. **Log appropriately**: Use stderr for logs (stdout is for MCP)
6. **Document tools well**: Clear descriptions help Claude use them correctly
7. **Keep tools focused**: Single responsibility per tool
8. **Test with inspector**: Verify behavior before deployment

## Output Checklist

Every MCP server should include:

- [ ] Server with name and version
- [ ] Capabilities declaration (tools/resources/prompts)
- [ ] Tool schemas with descriptions
- [ ] Input validation with clear error messages
- [ ] Proper error handling and MCP error codes
- [ ] Environment variable configuration
- [ ] Claude Desktop config example
- [ ] MCP inspector testing
- [ ] Unit tests for handlers
- [ ] README with setup instructions
