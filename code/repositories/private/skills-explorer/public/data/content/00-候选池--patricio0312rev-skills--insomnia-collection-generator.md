---
name: insomnia-collection-generator
description: Generates Insomnia collection export files from Express, Next.js, Fastify, or other API routes. Creates organized workspaces with request groups, environments, and authentication. Use when users request "generate insomnia collection", "export to insomnia", "create insomnia workspace", or "insomnia import".
---

# Insomnia Collection Generator

Generate importable Insomnia workspaces from your API codebase automatically.

## Core Workflow

1. **Scan routes**: Find all API route definitions
2. **Extract metadata**: Methods, paths, params, bodies
3. **Create workspace**: Organize into request groups
4. **Configure environments**: Base URLs, auth tokens
5. **Add authentication**: Bearer, Basic, API Key
6. **Export collection**: Insomnia v4 JSON format

## Insomnia Export v4 Schema

```json
{
  "_type": "export",
  "__export_format": 4,
  "__export_date": "2024-01-15T10:30:00.000Z",
  "__export_source": "insomnia.desktop.app:v2023.5.8",
  "resources": []
}
```

## Resource Types

```typescript
interface InsomniaWorkspace {
  _id: string;
  _type: "workspace";
  name: string;
  description: string;
  scope: "collection" | "design";
}

interface InsomniaRequestGroup {
  _id: string;
  _type: "request_group";
  name: string;
  parentId: string;
  description?: string;
}

interface InsomniaRequest {
  _id: string;
  _type: "request";
  name: string;
  parentId: string;
  method: string;
  url: string;
  body: InsomniaBody;
  headers: InsomniaHeader[];
  parameters: InsomniaParameter[];
  authentication: InsomniaAuth;
}

interface InsomniaEnvironment {
  _id: string;
  _type: "environment";
  name: string;
  parentId: string;
  data: Record<string, string>;
}
```

## Collection Generator

```typescript
// scripts/generate-insomnia.ts
import { v4 as uuidv4 } from "uuid";

interface RouteInfo {
  method: string;
  path: string;
  name: string;
  body?: object;
  params?: { name: string; type: "path" | "query" }[];
}

interface InsomniaExport {
  _type: "export";
  __export_format: 4;
  __export_date: string;
  __export_source: string;
  resources: InsomniaResource[];
}

type InsomniaResource =
  InsomniaWorkspace | InsomniaRequestGroup | InsomniaRequest | InsomniaEnvironment;

function generateInsomniaCollection(
  routes: RouteInfo[],
  options: {
    name: string;
    baseUrl: string;
    description?: string;
  },
): InsomniaExport {
  const workspaceId = `wrk_${uuidv4().replace(/-/g, "")}`;
  const baseEnvId = `env_${uuidv4().replace(/-/g, "")}`;
  const devEnvId = `env_${uuidv4().replace(/-/g, "")}`;

  const resources: InsomniaResource[] = [];

  // Create workspace
  resources.push({
    _id: workspaceId,
    _type: "workspace",
    name: options.name,
    description: options.description || "Auto-generated API collection",
    scope: "collection",
  });

  // Create base environment
  resources.push({
    _id: baseEnvId,
    _type: "environment",
    name: "Base Environment",
    parentId: workspaceId,
    data: {},
  });

  // Create development environment
  resources.push({
    _id: devEnvId,
    _type: "environment",
    name: "Development",
    parentId: baseEnvId,
    data: {
      base_url: options.baseUrl,
      auth_token: "",
    },
  });

  // Group routes by resource
  const groupedRoutes = groupRoutesByResource(routes);

  for (const [resource, resourceRoutes] of Object.entries(groupedRoutes)) {
    // Create request group (folder)
    const groupId = `fld_${uuidv4().replace(/-/g, "")}`;

    resources.push({
      _id: groupId,
      _type: "request_group",
      name: capitalize(resource),
      parentId: workspaceId,
      description: `${resource} endpoints`,
    });

    // Create requests in group
    for (const route of resourceRoutes) {
      resources.push(createInsomniaRequest(route, groupId));
    }
  }

  return {
    _type: "export",
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: "api-generator:v1.0.0",
    resources,
  };
}

function createInsomniaRequest(route: RouteInfo, parentId: string): InsomniaRequest {
  const requestId = `req_${uuidv4().replace(/-/g, "")}`;

  // Convert :param to {{ _.param }} for Insomnia
  const url = route.path.replace(/:(\w+)/g, "{{ _.$1 }}");

  const request: InsomniaRequest = {
    _id: requestId,
    _type: "request",
    name: route.name,
    parentId,
    method: route.method,
    url: `{{ _.base_url }}${url}`,
    body: {
      mimeType: "application/json",
      text: route.body ? JSON.stringify(route.body, null, 2) : "",
    },
    headers: [
      {
        name: "Content-Type",
        value: "application/json",
      },
    ],
    parameters:
      route.params
        ?.filter((p) => p.type === "query")
        .map((p) => ({
          name: p.name,
          value: "",
          disabled: false,
        })) || [],
    authentication: {
      type: "bearer",
      token: "{{ _.auth_token }}",
      disabled: true,
    },
  };

  return request;
}

function groupRoutesByResource(routes: RouteInfo[]): Record<string, RouteInfo[]> {
  const groups: Record<string, RouteInfo[]> = {};

  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    const resource = parts[0] || "root";

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

## Complete Export Example

```json
{
  "_type": "export",
  "__export_format": 4,
  "__export_date": "2024-01-15T10:30:00.000Z",
  "__export_source": "api-generator:v1.0.0",
  "resources": [
    {
      "_id": "wrk_abc123",
      "_type": "workspace",
      "name": "My API",
      "description": "Auto-generated API collection",
      "scope": "collection"
    },
    {
      "_id": "env_base123",
      "_type": "environment",
      "name": "Base Environment",
      "parentId": "wrk_abc123",
      "data": {}
    },
    {
      "_id": "env_dev123",
      "_type": "environment",
      "name": "Development",
      "parentId": "env_base123",
      "data": {
        "base_url": "http://localhost:3000/api",
        "auth_token": ""
      }
    },
    {
      "_id": "env_prod123",
      "_type": "environment",
      "name": "Production",
      "parentId": "env_base123",
      "data": {
        "base_url": "https://api.example.com",
        "auth_token": ""
      }
    },
    {
      "_id": "fld_users123",
      "_type": "request_group",
      "name": "Users",
      "parentId": "wrk_abc123"
    },
    {
      "_id": "req_getusers",
      "_type": "request",
      "name": "Get All Users",
      "parentId": "fld_users123",
      "method": "GET",
      "url": "{{ _.base_url }}/users",
      "body": {},
      "headers": [{ "name": "Content-Type", "value": "application/json" }],
      "parameters": [
        { "name": "page", "value": "1", "disabled": false },
        { "name": "limit", "value": "10", "disabled": false }
      ],
      "authentication": {
        "type": "bearer",
        "token": "{{ _.auth_token }}"
      }
    },
    {
      "_id": "req_getuser",
      "_type": "request",
      "name": "Get User by ID",
      "parentId": "fld_users123",
      "method": "GET",
      "url": "{{ _.base_url }}/users/{{ _.user_id }}",
      "body": {},
      "headers": [],
      "authentication": {}
    },
    {
      "_id": "req_createuser",
      "_type": "request",
      "name": "Create User",
      "parentId": "fld_users123",
      "method": "POST",
      "url": "{{ _.base_url }}/users",
      "body": {
        "mimeType": "application/json",
        "text": "{\n  \"name\": \"John Doe\",\n  \"email\": \"john@example.com\"\n}"
      },
      "headers": [{ "name": "Content-Type", "value": "application/json" }],
      "authentication": {
        "type": "bearer",
        "token": "{{ _.auth_token }}"
      }
    }
  ]
}
```

## Authentication Types

```typescript
// Bearer Token
{
  "type": "bearer",
  "token": "{{ _.auth_token }}",
  "prefix": "Bearer"
}

// Basic Auth
{
  "type": "basic",
  "username": "{{ _.username }}",
  "password": "{{ _.password }}"
}

// API Key
{
  "type": "apikey",
  "key": "X-API-Key",
  "value": "{{ _.api_key }}",
  "addTo": "header"
}

// OAuth 2.0
{
  "type": "oauth2",
  "grantType": "authorization_code",
  "authorizationUrl": "https://auth.example.com/authorize",
  "accessTokenUrl": "https://auth.example.com/token",
  "clientId": "{{ _.client_id }}",
  "clientSecret": "{{ _.client_secret }}",
  "scope": "read write"
}
```

## Request Body Types

```typescript
// JSON Body
{
  "mimeType": "application/json",
  "text": "{\"name\": \"value\"}"
}

// Form URL Encoded
{
  "mimeType": "application/x-www-form-urlencoded",
  "params": [
    { "name": "field1", "value": "value1" },
    { "name": "field2", "value": "value2" }
  ]
}

// Multipart Form (file upload)
{
  "mimeType": "multipart/form-data",
  "params": [
    { "name": "file", "type": "file", "fileName": "" },
    { "name": "description", "value": "File description" }
  ]
}

// GraphQL
{
  "mimeType": "application/graphql",
  "text": "query { users { id name } }"
}
```

## CLI Script

```typescript
#!/usr/bin/env node
// scripts/insomnia-gen.ts
import * as fs from "fs";
import { program } from "commander";

program
  .name("insomnia-gen")
  .description("Generate Insomnia collection from API routes")
  .option("-f, --framework <type>", "Framework type", "express")
  .option("-s, --source <path>", "Source directory", "./src")
  .option("-o, --output <path>", "Output file", "./insomnia-collection.json")
  .option("-n, --name <name>", "Workspace name", "API Collection")
  .option("-b, --base-url <url>", "Base URL", "http://localhost:3000/api")
  .parse();

const options = program.opts();

async function main() {
  const routes = await scanRoutes(options.framework, options.source);

  const collection = generateInsomniaCollection(routes, {
    name: options.name,
    baseUrl: options.baseUrl,
  });

  fs.writeFileSync(options.output, JSON.stringify(collection, null, 2));
  console.log(`Generated ${options.output} with ${routes.length} requests`);
}

main();
```

## Environment Templates

```json
{
  "_id": "env_development",
  "_type": "environment",
  "name": "Development",
  "data": {
    "base_url": "http://localhost:3000/api",
    "auth_token": "",
    "user_id": "1"
  }
}
```

```json
{
  "_id": "env_staging",
  "_type": "environment",
  "name": "Staging",
  "data": {
    "base_url": "https://staging-api.example.com",
    "auth_token": "",
    "user_id": "test-user-123"
  }
}
```

```json
{
  "_id": "env_production",
  "_type": "environment",
  "name": "Production",
  "data": {
    "base_url": "https://api.example.com",
    "auth_token": "",
    "user_id": ""
  }
}
```

## Best Practices

1. **Use environments**: Store base URLs and tokens as variables
2. **Organize folders**: Group requests by resource/feature
3. **Template syntax**: Use `{{ _.variable }}` for dynamic values
4. **Authentication**: Configure at workspace level when possible
5. **Add descriptions**: Document each request's purpose
6. **Include examples**: Pre-fill request bodies with realistic data
7. **Version control**: Commit export JSON to repository
8. **Multiple envs**: Create dev, staging, production environments

## Output Checklist

- [ ] All routes scanned from codebase
- [ ] Workspace created with proper scope
- [ ] Request groups organized by resource
- [ ] Requests include proper methods and URLs
- [ ] Path parameters converted to `{{ _.param }}` syntax
- [ ] Request bodies included for POST/PUT/PATCH
- [ ] Headers configured (Content-Type, etc.)
- [ ] Environments created (dev, staging, prod)
- [ ] Authentication configured
- [ ] Export validates in Insomnia
