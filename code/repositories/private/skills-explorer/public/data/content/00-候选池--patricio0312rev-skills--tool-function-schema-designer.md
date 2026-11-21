---
name: tool-function-schema-designer
description: Designs robust function/tool calling schemas for LLMs with JSON schemas, validation strategies, typed interfaces, and example calls. Use when implementing "function calling", "tool use", "LLM tools", or "agent actions".
---

# Tool/Function Schema Designer

Design robust tool schemas that LLMs can reliably invoke.

## Function Schema Format

```typescript
// OpenAI function calling format
const searchDocsTool = {
  type: "function",
  function: {
    name: "search_documentation",
    description:
      "Search through product documentation using semantic search. Use this when the user asks about features, how-tos, or troubleshooting.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query, phrased as a question or keywords",
        },
        filters: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["api", "guides", "tutorials", "troubleshooting"],
              description: "Filter by documentation category",
            },
            version: {
              type: "string",
              description: "Filter by product version (e.g., 'v2.0')",
            },
          },
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 5,
          description: "Maximum number of results to return",
        },
      },
      required: ["query"],
    },
  },
};
```

## Typed Interfaces

```typescript
// TypeScript types matching schema
interface SearchDocsParams {
  query: string;
  filters?: {
    category?: "api" | "guides" | "tutorials" | "troubleshooting";
    version?: string;
  };
  max_results?: number;
}

// Implementation
async function search_documentation(params: SearchDocsParams): Promise<SearchResult[]> {
  const { query, filters = {}, max_results = 5 } = params;

  // Implementation
  return await vectorStore.search(query, {
    filter: filters,
    limit: max_results,
  });
}
```

## Validation Strategy

```typescript
import { z } from "zod";

// Zod schema for runtime validation
const searchDocsSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  filters: z
    .object({
      category: z.enum(["api", "guides", "tutorials", "troubleshooting"]).optional(),
      version: z.string().optional(),
    })
    .optional(),
  max_results: z.number().int().min(1).max(10).default(5),
});

// Validate before execution
function validateAndExecute(toolName: string, params: unknown) {
  const validated = searchDocsSchema.parse(params);
  return search_documentation(validated);
}
```

## Tool Registry

```typescript
export const TOOLS = {
  search_documentation: {
    schema: searchDocsTool,
    implementation: search_documentation,
    validator: searchDocsSchema,
  },
  create_ticket: {
    schema: createTicketTool,
    implementation: create_ticket,
    validator: createTicketSchema,
  },
  // ... more tools
};

// Execute tool safely
async function executeTool(name: string, params: unknown) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  const validated = tool.validator.parse(params);
  return tool.implementation(validated);
}
```

## Example Calls

```typescript
// Example 1: Simple search
{
  "name": "search_documentation",
  "parameters": {
    "query": "How do I authenticate API requests?"
  }
}

// Example 2: With filters
{
  "name": "search_documentation",
  "parameters": {
    "query": "rate limiting",
    "filters": {
      "category": "api",
      "version": "v2.0"
    },
    "max_results": 3
  }
}
```

## Error Handling

```typescript
interface ToolResult {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
  };
}

async function safeExecuteTool(name: string, params: unknown): Promise<ToolResult> {
  try {
    const data = await executeTool(name, params);
    return { success: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid parameters: ${error.message}`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: "EXECUTION_ERROR",
        message: error.message,
      },
    };
  }
}
```

## Best Practices

1. **Clear descriptions**: Explain when to use the tool
2. **Specific types**: Use enums, ranges, patterns
3. **Sensible defaults**: Reduce required parameters
4. **Validate rigorously**: Don't trust LLM output
5. **Error messages**: Help LLM correct mistakes
6. **Example calls**: Show success cases
7. **Type safety**: TypeScript interfaces

## Output Checklist

- [ ] JSON schema defined
- [ ] TypeScript interface
- [ ] Validation with Zod
- [ ] Implementation function
- [ ] Error handling
- [ ] Example calls (3+)
- [ ] Tool registry entry
- [ ] Documentation
