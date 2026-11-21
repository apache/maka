---
name: bruno-collection-generator
description: Generates Bruno collection files (.bru) from Express, Next.js, Fastify, or other API routes. Creates organized collections with environments, authentication, and folder structure for the open-source Bruno API client. Use when users request "generate bruno collection", "bruno api testing", "create bru files", or "bruno import".
---

# Bruno Collection Generator

Generate Bruno collection files for the open-source, Git-friendly API client.

## Core Workflow

1. **Scan routes**: Find all API route definitions
2. **Extract metadata**: Methods, paths, params, bodies
3. **Create collection**: Initialize bruno.json manifest
4. **Generate .bru files**: One file per request
5. **Organize folders**: Group by resource
6. **Add environments**: Dev, staging, production

## Bruno Collection Structure

```
collection/
├── bruno.json              # Collection manifest
├── environments/
│   ├── Development.bru
│   ├── Staging.bru
│   └── Production.bru
├── users/
│   ├── folder.bru
│   ├── get-users.bru
│   ├── get-user.bru
│   ├── create-user.bru
│   ├── update-user.bru
│   └── delete-user.bru
├── auth/
│   ├── folder.bru
│   ├── login.bru
│   ├── register.bru
│   └── logout.bru
└── products/
    ├── folder.bru
    └── ...
```

## bruno.json Manifest

```json
{
  "version": "1",
  "name": "My API",
  "type": "collection",
  "ignore": ["node_modules", ".git"]
}
```

## .bru File Syntax

```bru
meta {
  name: Get Users
  type: http
  seq: 1
}

get {
  url: {{baseUrl}}/users
  body: none
  auth: bearer
}

auth:bearer {
  token: {{authToken}}
}

query {
  page: 1
  limit: 10
}

headers {
  Accept: application/json
}

docs {
  Retrieve a paginated list of users.
}
```

## Generator Script

```typescript
// scripts/generate-bruno.ts
import * as fs from "fs";
import * as path from "path";

interface RouteInfo {
  method: string;
  path: string;
  name: string;
  description?: string;
  body?: object;
  queryParams?: { name: string; value: string }[];
  auth?: boolean;
}

interface BrunoOptions {
  collectionName: string;
  outputDir: string;
  baseUrl: string;
  authType?: "bearer" | "basic" | "apikey";
}

function generateBrunoCollection(routes: RouteInfo[], options: BrunoOptions): void {
  const { outputDir, collectionName } = options;

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create bruno.json
  const manifest = {
    version: "1",
    name: collectionName,
    type: "collection",
    ignore: ["node_modules", ".git"],
  };
  fs.writeFileSync(path.join(outputDir, "bruno.json"), JSON.stringify(manifest, null, 2));

  // Create environments
  generateEnvironments(outputDir, options);

  // Group routes by resource
  const groupedRoutes = groupRoutesByResource(routes);

  for (const [resource, resourceRoutes] of Object.entries(groupedRoutes)) {
    const folderPath = path.join(outputDir, resource);

    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Create folder.bru
    const folderBru = `meta {\n  name: ${capitalize(resource)}\n}\n`;
    fs.writeFileSync(path.join(folderPath, "folder.bru"), folderBru);

    // Create request files
    let seq = 1;
    for (const route of resourceRoutes) {
      const fileName = generateFileName(route);
      const content = generateBruFile(route, seq++, options);
      fs.writeFileSync(path.join(folderPath, `${fileName}.bru`), content);
    }
  }
}

function generateBruFile(route: RouteInfo, seq: number, options: BrunoOptions): string {
  const lines: string[] = [];

  // Meta section
  lines.push("meta {");
  lines.push(`  name: ${route.name}`);
  lines.push("  type: http");
  lines.push(`  seq: ${seq}`);
  lines.push("}");
  lines.push("");

  // Request section
  const method = route.method.toLowerCase();
  const urlPath = route.path.replace(/:(\w+)/g, "{{$1}}");

  lines.push(`${method} {`);
  lines.push(`  url: {{baseUrl}}${urlPath}`);

  if (["post", "put", "patch"].includes(method) && route.body) {
    lines.push("  body: json");
  } else {
    lines.push("  body: none");
  }

  if (route.auth && options.authType) {
    lines.push(`  auth: ${options.authType}`);
  } else {
    lines.push("  auth: none");
  }

  lines.push("}");
  lines.push("");

  // Auth section
  if (route.auth && options.authType === "bearer") {
    lines.push("auth:bearer {");
    lines.push("  token: {{authToken}}");
    lines.push("}");
    lines.push("");
  } else if (route.auth && options.authType === "basic") {
    lines.push("auth:basic {");
    lines.push("  username: {{username}}");
    lines.push("  password: {{password}}");
    lines.push("}");
    lines.push("");
  }

  // Query params
  if (route.queryParams?.length) {
    lines.push("query {");
    for (const param of route.queryParams) {
      lines.push(`  ${param.name}: ${param.value}`);
    }
    lines.push("}");
    lines.push("");
  }

  // Headers
  lines.push("headers {");
  lines.push("  Accept: application/json");
  if (["post", "put", "patch"].includes(method)) {
    lines.push("  Content-Type: application/json");
  }
  lines.push("}");
  lines.push("");

  // Body
  if (["post", "put", "patch"].includes(method) && route.body) {
    lines.push("body:json {");
    lines.push(JSON.stringify(route.body, null, 2));
    lines.push("}");
    lines.push("");
  }

  // Docs
  if (route.description) {
    lines.push("docs {");
    lines.push(`  ${route.description}`);
    lines.push("}");
  }

  return lines.join("\n");
}

function generateEnvironments(outputDir: string, options: BrunoOptions): void {
  const envsDir = path.join(outputDir, "environments");

  if (!fs.existsSync(envsDir)) {
    fs.mkdirSync(envsDir, { recursive: true });
  }

  const environments = [
    { name: "Development", baseUrl: "http://localhost:3000/api" },
    { name: "Staging", baseUrl: "https://staging-api.example.com" },
    { name: "Production", baseUrl: "https://api.example.com" },
  ];

  for (const env of environments) {
    const content = `vars {
  baseUrl: ${env.baseUrl}
  authToken:
}

vars:secret [
  authToken
]
`;
    fs.writeFileSync(path.join(envsDir, `${env.name}.bru`), content);
  }
}

function generateFileName(route: RouteInfo): string {
  return route.name.toLowerCase().replace(/\s+/g, "-");
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
```

## Complete Example Files

### bruno.json

```json
{
  "version": "1",
  "name": "My API",
  "type": "collection",
  "ignore": ["node_modules", ".git"]
}
```

### environments/Development.bru

```bru
vars {
  baseUrl: http://localhost:3000/api
  authToken:
  userId: 1
}

vars:secret [
  authToken
]
```

### environments/Production.bru

```bru
vars {
  baseUrl: https://api.example.com
  authToken:
  userId:
}

vars:secret [
  authToken
]
```

### users/folder.bru

```bru
meta {
  name: Users
}
```

### users/get-users.bru

```bru
meta {
  name: Get Users
  type: http
  seq: 1
}

get {
  url: {{baseUrl}}/users
  body: none
  auth: bearer
}

auth:bearer {
  token: {{authToken}}
}

query {
  page: 1
  limit: 10
}

headers {
  Accept: application/json
}

docs {
  Retrieve a paginated list of users.

  ## Query Parameters
  - page: Page number (default: 1)
  - limit: Items per page (default: 10, max: 100)

  ## Response
  Returns paginated user list with metadata.
}
```

### users/get-user.bru

```bru
meta {
  name: Get User by ID
  type: http
  seq: 2
}

get {
  url: {{baseUrl}}/users/{{userId}}
  body: none
  auth: bearer
}

auth:bearer {
  token: {{authToken}}
}

headers {
  Accept: application/json
}

docs {
  Retrieve a single user by their ID.
}
```

### users/create-user.bru

```bru
meta {
  name: Create User
  type: http
  seq: 3
}

post {
  url: {{baseUrl}}/users
  body: json
  auth: bearer
}

auth:bearer {
  token: {{authToken}}
}

headers {
  Accept: application/json
  Content-Type: application/json
}

body:json {
  {
    "name": "John Doe",
    "email": "john@example.com",
    "role": "user"
  }
}

docs {
  Create a new user account.

  ## Request Body
  - name: User's full name (required)
  - email: User's email address (required, unique)
  - role: User role (optional, default: "user")
}
```

### users/update-user.bru

```bru
meta {
  name: Update User
  type: http
  seq: 4
}

put {
  url: {{baseUrl}}/users/{{userId}}
  body: json
  auth: bearer
}

auth:bearer {
  token: {{authToken}}
}

headers {
  Accept: application/json
  Content-Type: application/json
}

body:json {
  {
    "name": "John Updated",
    "email": "john.updated@example.com"
  }
}

docs {
  Update an existing user.
}
```

### users/delete-user.bru

```bru
meta {
  name: Delete User
  type: http
  seq: 5
}

delete {
  url: {{baseUrl}}/users/{{userId}}
  body: none
  auth: bearer
}

auth:bearer {
  token: {{authToken}}
}

headers {
  Accept: application/json
}

docs {
  Delete a user account.
}
```

### auth/login.bru

```bru
meta {
  name: Login
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/auth/login
  body: json
  auth: none
}

headers {
  Accept: application/json
  Content-Type: application/json
}

body:json {
  {
    "email": "user@example.com",
    "password": "password123"
  }
}

script:post-response {
  if (res.body.token) {
    bru.setEnvVar("authToken", res.body.token);
  }
}

docs {
  Authenticate user and receive access token.

  On successful login, the token is automatically saved
  to the authToken environment variable.
}
```

## Pre/Post Request Scripts

```bru
script:pre-request {
  // Set dynamic values before request
  const timestamp = Date.now();
  bru.setVar("requestId", `req-${timestamp}`);
}

script:post-response {
  // Extract values from response
  if (res.body.token) {
    bru.setEnvVar("authToken", res.body.token);
  }

  if (res.body.id) {
    bru.setEnvVar("userId", res.body.id);
  }

  // Log response info
  console.log(`Status: ${res.status}`);
  console.log(`Response time: ${res.responseTime}ms`);
}
```

## Tests in Bruno

```bru
tests {
  test("should return 200", function() {
    expect(res.status).to.equal(200);
  });

  test("should return array of users", function() {
    expect(res.body.data).to.be.an("array");
  });

  test("should include pagination", function() {
    expect(res.body.meta).to.have.property("page");
    expect(res.body.meta).to.have.property("total");
  });
}
```

## CLI Script

```typescript
#!/usr/bin/env node
// scripts/bruno-gen.ts
import * as fs from "fs";
import { program } from "commander";

program
  .name("bruno-gen")
  .description("Generate Bruno collection from API routes")
  .option("-f, --framework <type>", "Framework type", "express")
  .option("-s, --source <path>", "Source directory", "./src")
  .option("-o, --output <path>", "Output directory", "./bruno-collection")
  .option("-n, --name <name>", "Collection name", "My API")
  .option("-b, --base-url <url>", "Base URL", "http://localhost:3000/api")
  .option("-a, --auth <type>", "Auth type (bearer|basic|apikey)")
  .parse();

const options = program.opts();

async function main() {
  const routes = await scanRoutes(options.framework, options.source);

  generateBrunoCollection(routes, {
    collectionName: options.name,
    outputDir: options.output,
    baseUrl: options.baseUrl,
    authType: options.auth,
  });

  console.log(`Generated Bruno collection in ${options.output}`);
  console.log(`Open with: bruno run ${options.output}`);
}

main();
```

## Best Practices

1. **Git-friendly**: Bruno stores everything as plain text files
2. **Use environments**: Store URLs and tokens in environment files
3. **Secret variables**: Mark sensitive vars with `vars:secret`
4. **Add docs**: Document each request with the docs block
5. **Pre/post scripts**: Automate token extraction and setup
6. **Add tests**: Include assertions in test blocks
7. **Organize folders**: Group related requests together
8. **Sequence numbers**: Order requests logically with `seq`

## Output Checklist

- [ ] bruno.json manifest created
- [ ] Environment files for dev/staging/prod
- [ ] Folder structure by resource
- [ ] folder.bru for each folder
- [ ] Request .bru files with proper syntax
- [ ] Path parameters use `{{param}}` syntax
- [ ] Query parameters in query block
- [ ] Request bodies in body:json block
- [ ] Authentication configured
- [ ] Documentation in docs block
- [ ] Pre/post scripts for token handling
