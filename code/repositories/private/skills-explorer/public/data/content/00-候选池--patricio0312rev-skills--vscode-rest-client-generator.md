---
name: vscode-rest-client-generator
description: Generates .http files for the VS Code REST Client extension from Express, Next.js, Fastify, or other API routes. Creates organized request files with variables, environments, and authentication. Use when users request "generate http files", "rest client requests", "create .http file", or "vscode api testing".
---

# VS Code REST Client Generator

Generate .http files for inline API testing in VS Code without leaving the editor.

## Core Workflow

1. **Scan routes**: Find all API route definitions
2. **Extract metadata**: Methods, paths, params, bodies
3. **Create .http files**: Organize by resource or single file
4. **Add variables**: Environment-specific values
5. **Configure auth**: Bearer, Basic, API Key
6. **Include examples**: Request bodies with sample data

## File Structure Options

```
# Option 1: Single file
api-requests.http

# Option 2: By resource
http/
├── users.http
├── products.http
├── orders.http
└── auth.http

# Option 3: By environment
http/
├── local.http
├── staging.http
└── production.http
```

## Basic .http File Syntax

```http
### Get all users
GET {{baseUrl}}/users
Authorization: Bearer {{authToken}}

### Get user by ID
GET {{baseUrl}}/users/{{userId}}
Authorization: Bearer {{authToken}}

### Create user
POST {{baseUrl}}/users
Content-Type: application/json
Authorization: Bearer {{authToken}}

{
  "name": "John Doe",
  "email": "john@example.com"
}

### Update user
PUT {{baseUrl}}/users/{{userId}}
Content-Type: application/json
Authorization: Bearer {{authToken}}

{
  "name": "John Updated"
}

### Delete user
DELETE {{baseUrl}}/users/{{userId}}
Authorization: Bearer {{authToken}}
```

## Environment Variables

```http
# settings.json or .vscode/settings.json
# {
#   "rest-client.environmentVariables": {
#     "$shared": {
#       "version": "v1"
#     },
#     "local": {
#       "baseUrl": "http://localhost:3000/api",
#       "authToken": "local-dev-token"
#     },
#     "staging": {
#       "baseUrl": "https://staging-api.example.com",
#       "authToken": ""
#     },
#     "production": {
#       "baseUrl": "https://api.example.com",
#       "authToken": ""
#     }
#   }
# }

### Variables Reference
# Use Ctrl+Alt+E (Cmd+Alt+E on Mac) to switch environments
# {{$shared.version}} - shared across all environments
# {{baseUrl}} - from current environment
# {{$timestamp}} - current timestamp
# {{$randomInt min max}} - random integer
# {{$guid}} - random UUID
```

## Generator Script

```typescript
// scripts/generate-http-files.ts
import * as fs from "fs";
import * as path from "path";

interface RouteInfo {
  method: string;
  path: string;
  name: string;
  description?: string;
  body?: object;
  headers?: Record<string, string>;
  queryParams?: { name: string; value: string; optional?: boolean }[];
}

interface HttpFileOptions {
  baseUrlVar: string;
  authType?: "bearer" | "basic" | "apikey";
  authVar?: string;
  includeComments?: boolean;
}

function generateHttpFile(routes: RouteInfo[], options: HttpFileOptions): string {
  const lines: string[] = [];

  // Add file header
  lines.push("# Auto-generated API requests");
  lines.push(`# Base URL: {{${options.baseUrlVar}}}`);
  lines.push("# Switch environment: Ctrl+Alt+E (Cmd+Alt+E on Mac)");
  lines.push("");

  for (const route of routes) {
    // Request separator and name
    lines.push(`### ${route.name}`);

    if (route.description) {
      lines.push(`# ${route.description}`);
    }

    // Method and URL
    let url = `{{${options.baseUrlVar}}}${route.path}`;

    // Convert :param to {{param}}
    url = url.replace(/:(\w+)/g, "{{$1}}");

    // Add query params
    if (route.queryParams?.length) {
      const queryString = route.queryParams.map((p) => `${p.name}=${p.value}`).join("&");
      url += `?${queryString}`;
    }

    lines.push(`${route.method} ${url}`);

    // Headers
    if (["POST", "PUT", "PATCH"].includes(route.method)) {
      lines.push("Content-Type: application/json");
    }

    // Authentication
    if (options.authType === "bearer" && options.authVar) {
      lines.push(`Authorization: Bearer {{${options.authVar}}}`);
    } else if (options.authType === "basic") {
      lines.push(`Authorization: Basic {{${options.authVar}}}`);
    } else if (options.authType === "apikey") {
      lines.push(`X-API-Key: {{${options.authVar}}}`);
    }

    // Custom headers
    if (route.headers) {
      for (const [key, value] of Object.entries(route.headers)) {
        lines.push(`${key}: ${value}`);
      }
    }

    // Request body
    if (route.body && ["POST", "PUT", "PATCH"].includes(route.method)) {
      lines.push("");
      lines.push(JSON.stringify(route.body, null, 2));
    }

    lines.push("");
    lines.push("");
  }

  return lines.join("\n");
}

function generateHttpFilesByResource(
  routes: RouteInfo[],
  outputDir: string,
  options: HttpFileOptions,
): void {
  const groupedRoutes = groupRoutesByResource(routes);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const [resource, resourceRoutes] of Object.entries(groupedRoutes)) {
    const content = generateHttpFile(resourceRoutes, options);
    const filePath = path.join(outputDir, `${resource}.http`);
    fs.writeFileSync(filePath, content);
    console.log(`Generated ${filePath}`);
  }
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
```

## Complete Example Files

### users.http

```http
# Users API
# Environment: {{$env}}

@baseUrl = {{baseUrl}}
@authToken = {{authToken}}

### List all users
# @name listUsers
GET {{baseUrl}}/users?page=1&limit=10
Authorization: Bearer {{authToken}}

### Get user by ID
# @name getUser
GET {{baseUrl}}/users/{{userId}}
Authorization: Bearer {{authToken}}

### Create new user
# @name createUser
POST {{baseUrl}}/users
Content-Type: application/json
Authorization: Bearer {{authToken}}

{
  "name": "John Doe",
  "email": "john@example.com",
  "role": "user"
}

### Update user
# @name updateUser
PUT {{baseUrl}}/users/{{userId}}
Content-Type: application/json
Authorization: Bearer {{authToken}}

{
  "name": "John Updated",
  "email": "john.updated@example.com"
}

### Partial update user
# @name patchUser
PATCH {{baseUrl}}/users/{{userId}}
Content-Type: application/json
Authorization: Bearer {{authToken}}

{
  "status": "active"
}

### Delete user
# @name deleteUser
DELETE {{baseUrl}}/users/{{userId}}
Authorization: Bearer {{authToken}}

### Upload user avatar
# @name uploadAvatar
POST {{baseUrl}}/users/{{userId}}/avatar
Content-Type: multipart/form-data; boundary=----FormBoundary

------FormBoundary
Content-Disposition: form-data; name="avatar"; filename="avatar.png"
Content-Type: image/png

< ./avatar.png
------FormBoundary--
```

### auth.http

```http
# Authentication API

@baseUrl = {{baseUrl}}

### Login
# @name login
POST {{baseUrl}}/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}

### Use token from login response
@authToken = {{login.response.body.$.token}}

### Register
# @name register
POST {{baseUrl}}/auth/register
Content-Type: application/json

{
  "name": "New User",
  "email": "newuser@example.com",
  "password": "securepassword123"
}

### Refresh token
POST {{baseUrl}}/auth/refresh
Content-Type: application/json
Authorization: Bearer {{authToken}}

{
  "refreshToken": "{{refreshToken}}"
}

### Logout
POST {{baseUrl}}/auth/logout
Authorization: Bearer {{authToken}}

### Forgot password
POST {{baseUrl}}/auth/forgot-password
Content-Type: application/json

{
  "email": "user@example.com"
}

### Reset password
POST {{baseUrl}}/auth/reset-password
Content-Type: application/json

{
  "token": "{{resetToken}}",
  "password": "newpassword123"
}
```

## Advanced Features

### Response Variables

```http
### Login and capture token
# @name login
POST {{baseUrl}}/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}

### Use captured token
@token = {{login.response.body.token}}
@userId = {{login.response.body.user.id}}

### Make authenticated request
GET {{baseUrl}}/users/{{userId}}
Authorization: Bearer {{token}}
```

### Dynamic Variables

```http
### Create with random data
POST {{baseUrl}}/users
Content-Type: application/json

{
  "id": "{{$guid}}",
  "email": "user-{{$randomInt 1000 9999}}@example.com",
  "createdAt": "{{$timestamp}}"
}

### Available dynamic variables:
# {{$guid}} - UUID v4
# {{$randomInt min max}} - random integer
# {{$timestamp}} - Unix timestamp
# {{$timestamp offset option}} - with offset
# {{$datetime rfc1123}} - formatted date
# {{$localDatetime iso8601}} - local datetime
# {{$processEnv VAR_NAME}} - environment variable
```

### GraphQL Requests

```http
### GraphQL Query
POST {{baseUrl}}/graphql
Content-Type: application/json
Authorization: Bearer {{authToken}}
X-REQUEST-TYPE: GraphQL

{
  "query": "query GetUsers($first: Int) { users(first: $first) { id name email } }",
  "variables": {
    "first": 10
  }
}

### GraphQL Mutation
POST {{baseUrl}}/graphql
Content-Type: application/json
Authorization: Bearer {{authToken}}
X-REQUEST-TYPE: GraphQL

{
  "query": "mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id name } }",
  "variables": {
    "input": {
      "name": "New User",
      "email": "new@example.com"
    }
  }
}
```

## VS Code Settings

```json
// .vscode/settings.json
{
  "rest-client.environmentVariables": {
    "$shared": {
      "version": "v1",
      "contentType": "application/json"
    },
    "local": {
      "baseUrl": "http://localhost:3000/api",
      "authToken": "",
      "userId": "1"
    },
    "staging": {
      "baseUrl": "https://staging-api.example.com",
      "authToken": "",
      "userId": "test-123"
    },
    "production": {
      "baseUrl": "https://api.example.com",
      "authToken": "",
      "userId": ""
    }
  },
  "rest-client.previewResponseInUntitledDocument": true,
  "rest-client.timeoutinmilliseconds": 10000,
  "rest-client.followRedirect": true,
  "rest-client.defaultHeaders": {
    "Accept": "application/json",
    "User-Agent": "rest-client"
  }
}
```

## CLI Script

```typescript
#!/usr/bin/env node
// scripts/http-gen.ts
import * as fs from "fs";
import { program } from "commander";

program
  .name("http-gen")
  .description("Generate .http files from API routes")
  .option("-f, --framework <type>", "Framework type", "express")
  .option("-s, --source <path>", "Source directory", "./src")
  .option("-o, --output <path>", "Output directory", "./http")
  .option("--single-file", "Generate single file instead of per-resource")
  .option("-a, --auth <type>", "Auth type (bearer|basic|apikey)")
  .parse();

const options = program.opts();

async function main() {
  const routes = await scanRoutes(options.framework, options.source);

  const httpOptions = {
    baseUrlVar: "baseUrl",
    authType: options.auth,
    authVar: "authToken",
  };

  if (options.singleFile) {
    const content = generateHttpFile(routes, httpOptions);
    fs.writeFileSync(path.join(options.output, "api.http"), content);
  } else {
    generateHttpFilesByResource(routes, options.output, httpOptions);
  }

  console.log(`Generated .http files in ${options.output}`);
}

main();
```

## Best Practices

1. **Use named requests**: Add `# @name requestName` for variable capture
2. **Organize by resource**: One .http file per API resource
3. **Environment switching**: Configure multiple environments in settings
4. **Include examples**: Pre-fill bodies with realistic sample data
5. **Add comments**: Document each request's purpose
6. **Response chaining**: Capture values from responses for subsequent requests
7. **Version control**: Commit .http files to repository
8. **Share settings**: Include .vscode/settings.json in repo

## Output Checklist

- [ ] All routes converted to HTTP requests
- [ ] Path parameters use `{{param}}` syntax
- [ ] Request bodies included for POST/PUT/PATCH
- [ ] Headers configured (Content-Type, Authorization)
- [ ] Environment variables defined in settings.json
- [ ] Requests organized by resource or in single file
- [ ] Named requests for response chaining
- [ ] Sample data in request bodies
- [ ] Comments/descriptions for each request
