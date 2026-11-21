---
name: prompt-template-builder
description: Creates reusable prompt templates with strict output contracts, style rules, few-shot examples, and do/don't guidelines. Provides system/user prompt files, variable placeholders, output formatting instructions, and quality criteria. Use when building "prompt templates", "LLM prompts", "AI system prompts", or "prompt engineering".
---

# Prompt Template Builder

Build robust, reusable prompt templates with clear contracts and consistent outputs.

## Core Components

**System Prompt**: Role, persona, constraints, output format
**User Prompt**: Task, context, variables, examples
**Few-Shot Examples**: Input/output pairs demonstrating desired behavior
**Output Contract**: Strict format specification (JSON schema, Markdown structure)
**Style Rules**: Tone, verbosity, formatting preferences
**Guardrails**: Do's and don'ts, safety constraints

## System Prompt Template

````markdown
# System Prompt: Code Review Assistant

You are an expert code reviewer specializing in {language} and {framework}. Your role is to provide constructive, actionable feedback on code quality, best practices, and potential issues.

## Output Format

Provide your review in the following JSON structure:

```json
{
  "summary": "Brief 1-2 sentence overview",
  "issues": [
    {
      "severity": "critical|major|minor",
      "line": number,
      "message": "Description of the issue",
      "suggestion": "How to fix it"
    }
  ],
  "strengths": ["List of positive aspects"],
  "overall_score": 1-10
}
```
````

## Style Guidelines

- Be constructive and specific
- Cite line numbers for issues
- Provide actionable suggestions
- Balance criticism with praise
- Use professional, respectful tone

## Constraints

- Do NOT suggest unnecessary refactors
- Do focus on correctness, security, performance
- Do NOT be overly pedantic about style
- Do consider the context and project requirements

````

## User Prompt Template with Variables

```typescript
// prompt-templates/code-review.ts
export const codeReviewPrompt = (variables: {
  language: string;
  framework: string;
  code: string;
  context?: string;
}) => `
Please review the following ${variables.language} code:

${variables.context ? `Context: ${variables.context}\n` : ''}

\`\`\`${variables.language}
${variables.code}
\`\`\`

Provide a thorough code review following the output format specified in the system prompt.
`;

// Usage
const prompt = codeReviewPrompt({
  language: 'typescript',
  framework: 'React',
  code: userSubmittedCode,
  context: 'This is a production component for user authentication',
});
````

## Few-Shot Examples

````markdown
# Few-Shot Examples

## Example 1: Good Code

**Input:**

```typescript
function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```
````

**Output:**

```json
{
  "summary": "Clean, type-safe implementation with no issues found.",
  "issues": [],
  "strengths": [
    "Type safety with TypeScript",
    "Functional approach with reduce",
    "Clear, descriptive naming"
  ],
  "overall_score": 9
}
```

## Example 2: Code with Issues

**Input:**

```typescript
function calc(arr) {
  let total = 0;
  for (var i = 0; i < arr.length; i++) {
    total = total + arr[i].price;
  }
  return total;
}
```

**Output:**

```json
{
  "summary": "Functional but has type safety and modern syntax issues.",
  "issues": [
    {
      "severity": "major",
      "line": 1,
      "message": "Missing type annotations for parameters and return value",
      "suggestion": "Add types: function calc(arr: Item[]): number"
    },
    {
      "severity": "minor",
      "line": 3,
      "message": "Using 'var' instead of 'let' or 'const'",
      "suggestion": "Replace 'var' with 'let': for (let i = 0; ...)"
    }
  ],
  "strengths": ["Logic is correct", "Handles empty array case"],
  "overall_score": 6
}
```

````

## Output Contracts

```typescript
// Define strict output schema
import { z } from 'zod';

export const codeReviewSchema = z.object({
  summary: z.string().min(10).max(200),
  issues: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor']),
    line: z.number().int().positive(),
    message: z.string(),
    suggestion: z.string(),
  })),
  strengths: z.array(z.string()),
  overall_score: z.number().int().min(1).max(10),
});

// Validate LLM output
export const parseCodeReview = (output: string) => {
  try {
    const parsed = JSON.parse(output);
    return codeReviewSchema.parse(parsed);
  } catch (error) {
    throw new Error('Invalid code review output format');
  }
};
````

## Template Variables

```typescript
export interface PromptVariables {
  // Required
  required_field: string;

  // Optional with defaults
  optional_field?: string;

  // Constrained values
  severity_level: "low" | "medium" | "high";

  // Numeric with ranges
  max_tokens: number; // 1-4096
}

export const buildPrompt = (vars: PromptVariables): string => {
  // Validate variables
  if (!vars.required_field) {
    throw new Error("required_field is required");
  }

  // Set defaults
  const optional = vars.optional_field ?? "default value";

  // Build prompt
  return `Task: ${vars.required_field}
Options: ${optional}
Severity: ${vars.severity_level}`;
};
```

## Style Rules

```markdown
## Tone Guidelines

- **Professional**: Formal language, no slang
- **Friendly**: Conversational but respectful
- **Technical**: Precise terminology, assume expertise
- **Educational**: Explain concepts, teach as you go

## Verbosity Levels

- **Concise**: 1-2 sentences, bullet points
- **Standard**: 1 paragraph per point
- **Detailed**: Full explanations with examples
- **Comprehensive**: Deep dive with references

## Formatting Preferences

- Use markdown headers for structure
- Bold important terms
- Code blocks for technical content
- Lists for enumeration
- Tables for comparisons
```

## Do's and Don'ts

```markdown
## Do's

✓ Provide specific, actionable feedback
✓ Include code examples when relevant
✓ Reference line numbers for issues
✓ Suggest concrete improvements
✓ Balance criticism with praise
✓ Consider context and constraints

## Don'ts

✗ Don't be vague ("this is bad")
✗ Don't suggest unnecessary rewrites
✗ Don't ignore security issues
✗ Don't be overly pedantic
✗ Don't assume unlimited resources
✗ Don't make assumptions without context
```

## Prompt Chaining

```typescript
// Multi-step prompts
export const chainedPrompts = {
  step1_analyze: (code: string) => `
    Analyze this code and identify potential issues:
    ${code}

    List issues in JSON array format with severity and description.
  `,

  step2_suggest: (issues: Issue[]) => `
    Given these code issues:
    ${JSON.stringify(issues)}

    Provide detailed fix suggestions for each issue.
  `,

  step3_summarize: (suggestions: Suggestion[]) => `
    Summarize these code review suggestions into a final report:
    ${JSON.stringify(suggestions)}
  `,
};

// Execute chain
const issues = await llm(chainedPrompts.step1_analyze(code));
const suggestions = await llm(chainedPrompts.step2_suggest(issues));
const report = await llm(chainedPrompts.step3_summarize(suggestions));
```

## Version Control

```typescript
// Track prompt versions
export const PROMPT_VERSIONS = {
  "v1.0": {
    system: "Original system prompt...",
    user: (vars) => `Original user prompt...`,
    deprecated: false,
  },
  "v1.1": {
    system: "Improved system prompt with better constraints...",
    user: (vars) => `Updated user prompt...`,
    deprecated: false,
    changes: "Added JSON schema validation, improved examples",
  },
  "v1.0-deprecated": {
    system: "...",
    user: (vars) => `...`,
    deprecated: true,
    deprecation_reason: "Replaced by v1.1 with better output format",
  },
};

// Use specific version
const prompt = PROMPT_VERSIONS["v1.1"];
```

## Testing Prompts

```typescript
// Test cases for prompt validation
const testCases = [
  {
    input: { code: "function test() {}", language: "javascript" },
    expected: {
      hasIssues: false,
      scoreRange: [8, 10],
    },
  },
  {
    input: { code: "func test(arr) { return arr[0] }", language: "javascript" },
    expected: {
      hasIssues: true,
      minIssues: 2,
      severities: ["major", "minor"],
    },
  },
];

// Run tests
for (const test of testCases) {
  const output = await llm(buildPrompt(test.input));
  const parsed = parseCodeReview(output);

  if (test.expected.hasIssues) {
    assert(parsed.issues.length >= test.expected.minIssues);
  }
  if (test.expected.scoreRange) {
    assert(parsed.overall_score >= test.expected.scoreRange[0]);
    assert(parsed.overall_score <= test.expected.scoreRange[1]);
  }
}
```

## Best Practices

1. **Clear instructions**: Be explicit about what you want
2. **Output contracts**: Define strict schemas
3. **Few-shot examples**: Show, don't just tell
4. **Variable validation**: Check inputs before building prompts
5. **Version tracking**: Maintain prompt history
6. **Test thoroughly**: Validate against edge cases
7. **Iterate**: Improve based on real outputs
8. **Document constraints**: Explain limitations

## Output Checklist

- [ ] System prompt with role and constraints
- [ ] User prompt template with variables
- [ ] Output format specification (JSON schema)
- [ ] 3+ few-shot examples (good and bad)
- [ ] Style guidelines documented
- [ ] Do's and don'ts list
- [ ] Variable validation logic
- [ ] Output parsing/validation
- [ ] Test cases for prompt
- [ ] Version tracking system
