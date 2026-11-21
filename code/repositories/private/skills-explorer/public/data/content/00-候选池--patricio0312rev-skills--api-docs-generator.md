---
name: api-docs-generator
description: Generates comprehensive API documentation in Markdown, HTML, or Docusaurus format from Express, Next.js, Fastify, or other API routes. Creates endpoint references, request/response examples, authentication guides, and error documentation. Use when users request "generate api docs", "api documentation", "endpoint documentation", or "api reference".
---

# API Docs Generator

Generate comprehensive, developer-friendly API documentation automatically.

## Core Workflow

1. **Scan routes**: Find all API route definitions
2. **Extract schemas**: Request/response types, params
3. **Generate docs**: Markdown/HTML documentation
4. **Add examples**: Request/response examples
5. **Document errors**: Error codes and handling
6. **Create guides**: Authentication, getting started

## Documentation Structure

```
docs/
├── api/
│   ├── index.md              # API overview
│   ├── authentication.md     # Auth guide
│   ├── errors.md             # Error reference
│   ├── rate-limiting.md      # Rate limit info
│   └── endpoints/
│       ├── users.md
│       ├── products.md
│       └── orders.md
├── guides/
│   ├── getting-started.md
│   ├── pagination.md
│   └── webhooks.md
└── sdks/
    ├── javascript.md
    ├── python.md
    └── curl.md
```

## Generator Script

````typescript
// scripts/generate-api-docs.ts
import * as fs from "fs";
import * as path from "path";

interface RouteInfo {
  method: string;
  path: string;
  name: string;
  description?: string;
  params?: ParamInfo[];
  queryParams?: ParamInfo[];
  requestBody?: SchemaInfo;
  responses?: ResponseInfo[];
  auth?: boolean;
  tags?: string[];
}

interface ParamInfo {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  example?: string;
}

interface SchemaInfo {
  type: string;
  properties?: Record<string, PropertyInfo>;
  required?: string[];
  example?: object;
}

interface PropertyInfo {
  type: string;
  description?: string;
  example?: unknown;
  enum?: string[];
  format?: string;
}

interface ResponseInfo {
  status: number;
  description: string;
  schema?: SchemaInfo;
  example?: object;
}

interface DocsOptions {
  title: string;
  baseUrl: string;
  version: string;
  outputDir: string;
  format: "markdown" | "html" | "docusaurus";
}

function generateApiDocs(routes: RouteInfo[], options: DocsOptions): void {
  const { outputDir } = options;

  // Create directories
  fs.mkdirSync(path.join(outputDir, "api", "endpoints"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "guides"), { recursive: true });

  // Generate overview
  generateOverview(options);

  // Generate auth docs
  generateAuthDocs(options);

  // Generate error docs
  generateErrorDocs(options);

  // Group routes by resource
  const groupedRoutes = groupRoutesByResource(routes);

  // Generate endpoint docs
  for (const [resource, resourceRoutes] of Object.entries(groupedRoutes)) {
    const content = generateEndpointDoc(resource, resourceRoutes, options);
    const filePath = path.join(outputDir, "api", "endpoints", `${resource}.md`);
    fs.writeFileSync(filePath, content);
  }

  // Generate getting started guide
  generateGettingStarted(routes, options);
}

function generateEndpointDoc(resource: string, routes: RouteInfo[], options: DocsOptions): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${capitalize(resource)}`);
  lines.push("");
  lines.push(`Endpoints for managing ${resource}.`);
  lines.push("");

  // Table of contents
  lines.push("## Endpoints");
  lines.push("");
  lines.push("| Method | Endpoint | Description |");
  lines.push("|--------|----------|-------------|");

  for (const route of routes) {
    lines.push(`| \`${route.method}\` | \`${route.path}\` | ${route.description || route.name} |`);
  }
  lines.push("");

  // Detailed documentation for each endpoint
  for (const route of routes) {
    lines.push(generateEndpointSection(route, options));
    lines.push("");
  }

  return lines.join("\n");
}

function generateEndpointSection(route: RouteInfo, options: DocsOptions): string {
  const lines: string[] = [];
  const anchor = route.name.toLowerCase().replace(/\s+/g, "-");

  // Endpoint header
  lines.push(`## ${route.name} {#${anchor}}`);
  lines.push("");
  lines.push(
    `<span class="method method-${route.method.toLowerCase()}">${route.method}</span> \`${route.path}\``,
  );
  lines.push("");

  if (route.description) {
    lines.push(route.description);
    lines.push("");
  }

  // Authentication
  if (route.auth) {
    lines.push("### Authentication");
    lines.push("");
    lines.push(
      "This endpoint requires authentication. Include the Bearer token in the Authorization header.",
    );
    lines.push("");
  }

  // Path parameters
  if (route.params?.length) {
    lines.push("### Path Parameters");
    lines.push("");
    lines.push("| Parameter | Type | Required | Description |");
    lines.push("|-----------|------|----------|-------------|");

    for (const param of route.params) {
      lines.push(
        `| \`${param.name}\` | ${param.type} | ${param.required ? "Yes" : "No"} | ${param.description || "-"} |`,
      );
    }
    lines.push("");
  }

  // Query parameters
  if (route.queryParams?.length) {
    lines.push("### Query Parameters");
    lines.push("");
    lines.push("| Parameter | Type | Required | Default | Description |");
    lines.push("|-----------|------|----------|---------|-------------|");

    for (const param of route.queryParams) {
      lines.push(
        `| \`${param.name}\` | ${param.type} | ${param.required ? "Yes" : "No"} | ${param.example || "-"} | ${param.description || "-"} |`,
      );
    }
    lines.push("");
  }

  // Request body
  if (route.requestBody) {
    lines.push("### Request Body");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(route.requestBody.example || {}, null, 2));
    lines.push("```");
    lines.push("");

    if (route.requestBody.properties) {
      lines.push("| Field | Type | Required | Description |");
      lines.push("|-------|------|----------|-------------|");

      for (const [name, prop] of Object.entries(route.requestBody.properties)) {
        const required = route.requestBody.required?.includes(name) ? "Yes" : "No";
        lines.push(`| \`${name}\` | ${prop.type} | ${required} | ${prop.description || "-"} |`);
      }
      lines.push("");
    }
  }

  // Responses
  lines.push("### Responses");
  lines.push("");

  const responses = route.responses || [
    { status: 200, description: "Successful response" },
    { status: 400, description: "Bad request" },
    { status: 401, description: "Unauthorized" },
    { status: 404, description: "Not found" },
  ];

  for (const response of responses) {
    lines.push(`#### ${response.status} ${response.description}`);
    lines.push("");

    if (response.example) {
      lines.push("```json");
      lines.push(JSON.stringify(response.example, null, 2));
      lines.push("```");
      lines.push("");
    }
  }

  // Example request
  lines.push("### Example Request");
  lines.push("");
  lines.push("```bash");
  lines.push(generateCurlExample(route, options));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

function generateCurlExample(route: RouteInfo, options: DocsOptions): string {
  const parts: string[] = ["curl"];
  parts.push(`-X ${route.method}`);

  let url = `${options.baseUrl}${route.path}`;
  url = url.replace(/:(\w+)/g, "{$1}");
  parts.push(`"${url}"`);

  if (["POST", "PUT", "PATCH"].includes(route.method)) {
    parts.push('-H "Content-Type: application/json"');
  }

  if (route.auth) {
    parts.push('-H "Authorization: Bearer YOUR_TOKEN"');
  }

  if (route.requestBody?.example) {
    parts.push(`-d '${JSON.stringify(route.requestBody.example)}'`);
  }

  return parts.join(" \\\n  ");
}

function generateOverview(options: DocsOptions): void {
  const content = `# ${options.title} API Reference

Version: ${options.version}

Base URL: \`${options.baseUrl}\`

## Overview

Welcome to the ${options.title} API documentation. This API provides programmatic access to [describe your service].

## Quick Links

- [Authentication](./authentication.md)
- [Error Handling](./errors.md)
- [Rate Limiting](./rate-limiting.md)

## Endpoints

| Resource | Description |
|----------|-------------|
| [Users](./endpoints/users.md) | User management |
| [Products](./endpoints/products.md) | Product catalog |
| [Orders](./endpoints/orders.md) | Order processing |

## SDKs & Libraries

- [JavaScript/TypeScript](../sdks/javascript.md)
- [Python](../sdks/python.md)
- [cURL Examples](../sdks/curl.md)

## Support

If you have questions or need help, please:

- Check the [FAQ](../guides/faq.md)
- Open an issue on GitHub
- Contact support@example.com
`;

  fs.writeFileSync(path.join(options.outputDir, "api", "index.md"), content);
}

function generateAuthDocs(options: DocsOptions): void {
  const content = `# Authentication

The ${options.title} API uses Bearer token authentication.

## Getting an Access Token

### Login

\`\`\`bash
curl -X POST "${options.baseUrl}/auth/login" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "user@example.com", "password": "your-password"}'
\`\`\`

Response:

\`\`\`json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600,
  "tokenType": "Bearer"
}
\`\`\`

## Using the Token

Include the token in the Authorization header of all authenticated requests:

\`\`\`bash
curl -X GET "${options.baseUrl}/users" \\
  -H "Authorization: Bearer YOUR_TOKEN"
\`\`\`

## Token Expiration

Tokens expire after 1 hour. When a token expires, you'll receive a 401 response:

\`\`\`json
{
  "error": {
    "code": "TOKEN_EXPIRED",
    "message": "Your access token has expired"
  }
}
\`\`\`

Refresh your token using the refresh endpoint:

\`\`\`bash
curl -X POST "${options.baseUrl}/auth/refresh" \\
  -H "Content-Type: application/json" \\
  -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
\`\`\`

## API Keys

For server-to-server communication, you can use API keys:

\`\`\`bash
curl -X GET "${options.baseUrl}/users" \\
  -H "X-API-Key: YOUR_API_KEY"
\`\`\`

Generate API keys in your dashboard under Settings > API Keys.
`;

  fs.writeFileSync(path.join(options.outputDir, "api", "authentication.md"), content);
}

function generateErrorDocs(options: DocsOptions): void {
  const content = `# Error Handling

The API uses conventional HTTP status codes and returns errors in a consistent format.

## Error Response Format

\`\`\`json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      "field": ["Specific error for this field"]
    },
    "trace_id": "abc123"
  }
}
\`\`\`

## HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | OK - Request succeeded |
| 201 | Created - Resource created successfully |
| 204 | No Content - Request succeeded, no content returned |
| 400 | Bad Request - Invalid request data |
| 401 | Unauthorized - Missing or invalid authentication |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource doesn't exist |
| 409 | Conflict - Resource already exists |
| 422 | Unprocessable Entity - Validation error |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error - Server error |

## Error Codes

### Validation Errors

| Code | Description |
|------|-------------|
| \`VALIDATION_ERROR\` | Request body validation failed |
| \`INVALID_FORMAT\` | Field format is invalid |
| \`REQUIRED_FIELD\` | Required field is missing |

### Authentication Errors

| Code | Description |
|------|-------------|
| \`UNAUTHORIZED\` | No authentication provided |
| \`INVALID_TOKEN\` | Token is invalid or malformed |
| \`TOKEN_EXPIRED\` | Token has expired |
| \`INSUFFICIENT_PERMISSIONS\` | User lacks required permissions |

### Resource Errors

| Code | Description |
|------|-------------|
| \`NOT_FOUND\` | Resource doesn't exist |
| \`ALREADY_EXISTS\` | Resource already exists |
| \`CONFLICT\` | Operation conflicts with current state |

### Rate Limiting

| Code | Description |
|------|-------------|
| \`RATE_LIMIT_EXCEEDED\` | Too many requests |

When rate limited, check the response headers:

\`\`\`
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1640000000
\`\`\`

## Handling Errors

\`\`\`typescript
try {
  const response = await api.get('/users');
} catch (error) {
  if (error.response) {
    switch (error.response.status) {
      case 401:
        // Redirect to login
        break;
      case 403:
        // Show permission denied
        break;
      case 404:
        // Show not found
        break;
      case 429:
        // Implement retry with backoff
        break;
      default:
        // Show generic error
    }
  }
}
\`\`\`
`;

  fs.writeFileSync(path.join(options.outputDir, "api", "errors.md"), content);
}

function generateGettingStarted(routes: RouteInfo[], options: DocsOptions): void {
  const content = `# Getting Started

This guide will help you make your first API request.

## Prerequisites

- An API key or user account
- A tool to make HTTP requests (curl, Postman, or your preferred HTTP client)

## Step 1: Get Your API Credentials

1. Sign up for an account at [example.com](https://example.com)
2. Navigate to Settings > API Keys
3. Generate a new API key

## Step 2: Make Your First Request

Let's fetch a list of users:

\`\`\`bash
curl -X GET "${options.baseUrl}/users" \\
  -H "Authorization: Bearer YOUR_TOKEN"
\`\`\`

You should receive a response like:

\`\`\`json
{
  "success": true,
  "data": [
    {
      "id": "user_123",
      "name": "John Doe",
      "email": "john@example.com"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 1
  }
}
\`\`\`

## Step 3: Create a Resource

\`\`\`bash
curl -X POST "${options.baseUrl}/users" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -d '{
    "name": "Jane Doe",
    "email": "jane@example.com"
  }'
\`\`\`

## Next Steps

- Read the [Authentication Guide](../api/authentication.md)
- Explore the [API Reference](../api/index.md)
- Check out [Error Handling](../api/errors.md)
- Try the [Postman Collection](./postman.md)
`;

  fs.writeFileSync(path.join(options.outputDir, "guides", "getting-started.md"), content);
}

function groupRoutesByResource(routes: RouteInfo[]): Record<string, RouteInfo[]> {
  const groups: Record<string, RouteInfo[]> = {};

  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    const resource = parts[0] || "api";

    if (!groups[resource]) {
      groups[resource] = [];
    }
    groups[resource].push(route);
  }

  return groups;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
````

## Example Generated Documentation

### users.md

````markdown
# Users

Endpoints for managing users.

## Endpoints

| Method   | Endpoint         | Description     |
| -------- | ---------------- | --------------- |
| `GET`    | `/api/users`     | List all users  |
| `GET`    | `/api/users/:id` | Get user by ID  |
| `POST`   | `/api/users`     | Create new user |
| `PUT`    | `/api/users/:id` | Update user     |
| `DELETE` | `/api/users/:id` | Delete user     |

## List Users {#list-users}

<span class="method method-get">GET</span> `/api/users`

Retrieve a paginated list of users.

### Authentication

This endpoint requires authentication. Include the Bearer token in the Authorization header.

### Query Parameters

| Parameter | Type    | Required | Default | Description              |
| --------- | ------- | -------- | ------- | ------------------------ |
| `page`    | integer | No       | 1       | Page number              |
| `limit`   | integer | No       | 10      | Items per page (max 100) |
| `sort`    | string  | No       | -       | Sort field               |
| `order`   | string  | No       | desc    | Sort order (asc/desc)    |

### Responses

#### 200 OK

```json
{
  "success": true,
  "data": [
    {
      "id": "user_abc123",
      "name": "John Doe",
      "email": "john@example.com",
      "role": "user",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 156,
    "total_pages": 16
  }
}
```
````

#### 401 Unauthorized

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

### Example Request

```bash
curl -X GET "https://api.example.com/users?page=1&limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Create User {#create-user}

<span class="method method-post">POST</span> `/api/users`

Create a new user account.

### Authentication

This endpoint requires authentication. Include the Bearer token in the Authorization header.

### Request Body

```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "role": "user"
}
```

| Field   | Type   | Required | Description                   |
| ------- | ------ | -------- | ----------------------------- |
| `name`  | string | Yes      | User's full name              |
| `email` | string | Yes      | User's email (must be unique) |
| `role`  | string | No       | User role (user, admin)       |

### Responses

#### 201 Created

```json
{
  "success": true,
  "data": {
    "id": "user_xyz789",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "user",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

#### 400 Bad Request

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": {
      "email": ["Invalid email format"]
    }
  }
}
```

### Example Request

```bash
curl -X POST "https://api.example.com/users" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"name": "John Doe", "email": "john@example.com"}'
```

````

## CLI Script

```typescript
#!/usr/bin/env node
// scripts/docs-gen.ts
import * as fs from "fs";
import { program } from "commander";

program
  .name("docs-gen")
  .description("Generate API documentation from routes")
  .option("-f, --framework <type>", "Framework (express|nextjs|fastify)", "express")
  .option("-s, --source <path>", "Source directory", "./src")
  .option("-o, --output <path>", "Output directory", "./docs")
  .option("-t, --title <name>", "API title", "My API")
  .option("-v, --version <version>", "API version", "1.0.0")
  .option("-b, --base-url <url>", "Base URL", "https://api.example.com")
  .option("--format <type>", "Output format (markdown|html|docusaurus)", "markdown")
  .parse();

const options = program.opts();

async function main() {
  const routes = await scanRoutes(options.framework, options.source);

  generateApiDocs(routes, {
    title: options.title,
    baseUrl: options.baseUrl,
    version: options.version,
    outputDir: options.output,
    format: options.format,
  });

  console.log(`Generated documentation in ${options.output}`);
}

main();
````

## Best Practices

1. **Keep docs updated**: Regenerate docs on route changes
2. **Include examples**: Show real request/response examples
3. **Document errors**: List all possible error codes
4. **Add authentication guide**: Explain how to authenticate
5. **Use consistent format**: Follow same structure for all endpoints
6. **Version your docs**: Match doc versions to API versions
7. **Make it searchable**: Include table of contents and anchors
8. **Provide SDKs**: Link to client libraries and code examples

## Output Checklist

- [ ] API overview with quick links
- [ ] Authentication guide
- [ ] Error handling reference
- [ ] Endpoint documentation per resource
- [ ] Path and query parameters documented
- [ ] Request body schemas with field descriptions
- [ ] Response examples for all status codes
- [ ] cURL examples for each endpoint
- [ ] Getting started guide
- [ ] SDK/library examples
