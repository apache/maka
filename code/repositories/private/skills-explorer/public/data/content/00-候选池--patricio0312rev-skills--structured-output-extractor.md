---
name: structured-output-extractor
description: Extracts structured data from LLM responses using JSON schemas, Zod validation, and function calling for reliable parsing. Use when users request "structured output", "JSON extraction", "parse LLM response", "function calling", or "typed responses".
---

# Structured Output Extractor

Extract reliable, typed data from LLM responses.

## Core Workflow

1. **Define schema**: Create data structure
2. **Choose method**: Function calling vs prompting
3. **Generate response**: Call LLM with structure
4. **Validate output**: Parse and verify
5. **Handle errors**: Retry or fallback

## Methods Comparison

| Method           | Reliability | Flexibility | Best For        |
| ---------------- | ----------- | ----------- | --------------- |
| OpenAI JSON Mode | High        | Medium      | Simple JSON     |
| Function Calling | Very High   | High        | Complex schemas |
| Instructor       | Very High   | High        | Python/TS apps  |
| Zod + Prompting  | Medium      | High        | Custom parsing  |

## OpenAI Structured Outputs

### JSON Mode

```typescript
// extractors/json-mode.ts
import OpenAI from "openai";

const openai = new OpenAI();

interface ExtractedData {
  name: string;
  email: string;
  phone?: string;
  company?: string;
}

export async function extractContactInfo(text: string): Promise<ExtractedData> {
  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract contact information from text. Return JSON with:
{
  "name": "string",
  "email": "string",
  "phone": "string or null",
  "company": "string or null"
}`,
      },
      { role: "user", content: text },
    ],
  });

  return JSON.parse(response.choices[0].message.content!);
}
```

### Structured Outputs (Beta)

```typescript
// extractors/structured.ts
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

const ContactSchema = z.object({
  name: z.string().describe("Full name of the contact"),
  email: z.string().email().describe("Email address"),
  phone: z.string().nullable().describe("Phone number if available"),
  company: z.string().nullable().describe("Company name if mentioned"),
  role: z.string().nullable().describe("Job title or role"),
});

type Contact = z.infer<typeof ContactSchema>;

export async function extractContact(text: string): Promise<Contact> {
  const response = await openai.beta.chat.completions.parse({
    model: "gpt-4o-2024-08-06",
    messages: [
      {
        role: "system",
        content: "Extract contact information from the provided text.",
      },
      { role: "user", content: text },
    ],
    response_format: zodResponseFormat(ContactSchema, "contact"),
  });

  return response.choices[0].message.parsed!;
}
```

## Function Calling

### Define Functions

```typescript
// extractors/function-calling.ts
import OpenAI from "openai";

const openai = new OpenAI();

const functions = [
  {
    name: "extract_entities",
    description: "Extract named entities from text",
    parameters: {
      type: "object",
      properties: {
        people: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              role: { type: "string" },
              organization: { type: "string" },
            },
            required: ["name"],
          },
        },
        organizations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["company", "nonprofit", "government", "other"] },
            },
            required: ["name"],
          },
        },
        locations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["city", "country", "address", "other"] },
            },
            required: ["name"],
          },
        },
        dates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              normalized: { type: "string", format: "date" },
            },
            required: ["text"],
          },
        },
      },
      required: ["people", "organizations", "locations", "dates"],
    },
  },
];

export async function extractEntities(text: string) {
  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [
      {
        role: "system",
        content: "Extract all named entities from the provided text.",
      },
      { role: "user", content: text },
    ],
    functions,
    function_call: { name: "extract_entities" },
  });

  const functionCall = response.choices[0].message.function_call;
  return JSON.parse(functionCall!.arguments);
}
```

### Tool Use Pattern

```typescript
// extractors/tools.ts
import OpenAI from "openai";

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "classify_intent",
      description: "Classify the user intent from their message",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            enum: ["question", "complaint", "feedback", "request", "other"],
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
          entities: {
            type: "object",
            properties: {
              product: { type: "string" },
              issue: { type: "string" },
              sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
            },
          },
          suggestedAction: {
            type: "string",
          },
        },
        required: ["intent", "confidence"],
      },
    },
  },
];

export async function classifyMessage(message: string) {
  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [{ role: "user", content: message }],
    tools,
    tool_choice: { type: "function", function: { name: "classify_intent" } },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  return JSON.parse(toolCall!.function.arguments);
}
```

## Zod Schema Validation

### With Instructor-like Pattern

```typescript
// extractors/zod-extractor.ts
import { z } from "zod";
import OpenAI from "openai";

const openai = new OpenAI();

// Define schema
const ProductReviewSchema = z.object({
  productName: z.string(),
  rating: z.number().min(1).max(5),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  summary: z.string().max(200),
  wouldRecommend: z.boolean(),
  sentiment: z.enum(["positive", "negative", "mixed", "neutral"]),
});

type ProductReview = z.infer<typeof ProductReviewSchema>;

// Generate JSON schema from Zod
function zodToJsonSchema(schema: z.ZodObject<any>) {
  // Simplified - use zod-to-json-schema in production
  const shape = schema.shape;
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny;
    properties[key] = zodTypeToJson(zodType);
    if (!zodType.isOptional()) {
      required.push(key);
    }
  }

  return { type: "object", properties, required };
}

export async function extractReview(reviewText: string): Promise<ProductReview> {
  const schema = zodToJsonSchema(ProductReviewSchema);

  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract a structured product review. Return JSON matching this schema:
${JSON.stringify(schema, null, 2)}`,
      },
      { role: "user", content: reviewText },
    ],
  });

  const data = JSON.parse(response.choices[0].message.content!);

  // Validate with Zod
  return ProductReviewSchema.parse(data);
}
```

### With Retry on Validation Error

```typescript
// extractors/retry.ts
export async function extractWithRetry<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  text: string,
  maxRetries = 3,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: text },
          // Add error context on retry
          ...(lastError
            ? [
                {
                  role: "user" as const,
                  content: `Previous attempt failed validation: ${lastError.message}. Please fix.`,
                },
              ]
            : []),
        ],
      });

      const data = JSON.parse(response.choices[0].message.content!);
      return schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        lastError = new Error(
          error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
        );
      } else {
        throw error;
      }
    }
  }

  throw new Error(`Failed after ${maxRetries} attempts: ${lastError?.message}`);
}
```

## Complex Extraction Patterns

### Hierarchical Data

```typescript
// extractors/hierarchical.ts
const DocumentSchema = z.object({
  title: z.string(),
  authors: z.array(
    z.object({
      name: z.string(),
      affiliation: z.string().optional(),
    }),
  ),
  abstract: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      content: z.string(),
      subsections: z
        .array(
          z.object({
            heading: z.string(),
            content: z.string(),
          }),
        )
        .optional(),
    }),
  ),
  references: z.array(
    z.object({
      authors: z.array(z.string()),
      title: z.string(),
      year: z.number(),
      source: z.string().optional(),
    }),
  ),
  keywords: z.array(z.string()),
});
```

### Multi-step Extraction

```typescript
// extractors/multistep.ts
export async function extractComplex(document: string) {
  // Step 1: Extract structure
  const structure = await extract(
    z.object({
      sections: z.array(z.string()),
      hasReferences: z.boolean(),
    }),
    "Identify the document structure",
    document,
  );

  // Step 2: Extract each section
  const sections = await Promise.all(
    structure.sections.map((section) =>
      extract(
        z.object({
          heading: z.string(),
          summary: z.string(),
          keyPoints: z.array(z.string()),
        }),
        `Extract details from section: ${section}`,
        document,
      ),
    ),
  );

  // Step 3: Extract references if present
  let references = [];
  if (structure.hasReferences) {
    references = await extract(
      z.array(
        z.object({
          authors: z.array(z.string()),
          title: z.string(),
          year: z.number(),
        }),
      ),
      "Extract all references",
      document,
    );
  }

  return { sections, references };
}
```

## Streaming Structured Output

```typescript
// extractors/streaming.ts
import { zodToJsonSchema } from "zod-to-json-schema";

export async function* streamExtract<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  text: string,
): AsyncGenerator<{ partial: any; complete: boolean }> {
  const jsonSchema = zodToJsonSchema(schema);

  const stream = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${prompt}\n\nReturn JSON matching: ${JSON.stringify(jsonSchema)}`,
      },
      { role: "user", content: text },
    ],
    stream: true,
  });

  let fullContent = "";

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || "";
    fullContent += content;

    // Try to parse partial JSON
    try {
      const partial = JSON.parse(fullContent);
      yield { partial, complete: false };
    } catch {
      // JSON not complete yet
    }
  }

  // Final parse and validate
  const final = JSON.parse(fullContent);
  const validated = schema.parse(final);
  yield { partial: validated, complete: true };
}
```

## Error Handling

```typescript
// extractors/error-handling.ts
export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly validationErrors?: z.ZodError,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

export async function safeExtract<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  text: string,
): Promise<{ success: true; data: T } | { success: false; error: ExtractionError }> {
  try {
    const data = await extractWithRetry(schema, prompt, text);
    return { success: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: new ExtractionError("Validation failed", text, error),
      };
    }
    return {
      success: false,
      error: new ExtractionError(error instanceof Error ? error.message : "Unknown error", text),
    };
  }
}
```

## Best Practices

1. **Use structured outputs**: OpenAI's native feature when available
2. **Define clear schemas**: Descriptive field names and descriptions
3. **Validate with Zod**: Type-safe runtime validation
4. **Retry on failure**: With error context
5. **Use function calling**: For complex schemas
6. **Handle edge cases**: Null values, empty arrays
7. **Stream for UX**: Partial results during extraction
8. **Test with variations**: Different input formats

## Output Checklist

Every structured extraction should include:

- [ ] Zod schema with descriptions
- [ ] Appropriate extraction method (JSON/function/tools)
- [ ] Runtime validation
- [ ] Retry logic with error context
- [ ] Error handling and typing
- [ ] Streaming support (if needed)
- [ ] Edge case handling
- [ ] Type-safe return values
- [ ] Comprehensive tests
