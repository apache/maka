---
name: postman-collection-generator
description: Generates Postman collection JSON files from Express, Next.js, Fastify, Hono, or other API routes. Scans route definitions, extracts endpoints, methods, params, and creates importable collections. Use when users request "generate postman collection", "export to postman", "create postman file", or "postman import".
---

# Postman Collection Generator

Generate importable Postman collections from your API codebase automatically.

## Core Workflow

1. **Scan routes**: Find all API route definitions in the codebase
2. **Extract metadata**: Methods, paths, params, request bodies, headers
3. **Organize endpoints**: Group by resource or folder structure
4. **Generate collection**: Create Postman Collection v2.1 JSON
5. **Add examples**: Include request/response examples
6. **Configure variables**: Environment variables for base URL, auth tokens

## Supported Frameworks

| Framework | Route Pattern                   | Detection                     |
| --------- | ------------------------------- | ----------------------------- |
| Express   | `app.get()`, `router.post()`    | Method chaining on app/router |
| Next.js   | `app/api/**/route.ts`           | File-based routing            |
| Fastify   | `fastify.get()`, route schema   | Method + schema decorators    |
| Hono      | `app.get()`, `app.post()`       | Similar to Express            |
| NestJS    | `@Get()`, `@Post()` decorators  | Decorator-based               |
| Koa       | `router.get()`, `router.post()` | Koa-router patterns           |

## Postman Collection v2.1 Schema

```json
{
  "info": {
    "name": "API Collection",
    "description": "Auto-generated from codebase",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [],
  "variable": [],
  "auth": {}
}
```

## Express Route Scanner

```typescript
// scripts/generate-postman.ts
import * as fs from "fs";
import * as path from "path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

interface RouteInfo {
  method: string;
  path: string;
  name: string;
  description?: string;
  params?: ParamInfo[];
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface ParamInfo {
  name: string;
  type: "path" | "query";
  description?: string;
  example?: string;
}

function scanExpressRoutes(filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const code = fs.readFileSync(filePath, "utf-8");

  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript"],
  });

  traverse(ast, {
    CallExpression(nodePath) {
      const callee = nodePath.node.callee;

      if (callee.type === "MemberExpression") {
        const method = callee.property.name;
        const httpMethods = ["get", "post", "put", "patch", "delete"];

        if (httpMethods.includes(method)) {
          const args = nodePath.node.arguments;
          if (args[0]?.type === "StringLiteral") {
            const routePath = args[0].value;

            routes.push({
              method: method.toUpperCase(),
              path: routePath,
              name: generateRouteName(method, routePath),
              params: extractParams(routePath),
            });
          }
        }
      }
    },
  });

  return routes;
}

function extractParams(routePath: string): ParamInfo[] {
  const params: ParamInfo[] = [];
  const pathParamRegex = /:(\w+)/g;
  let match;

  while ((match = pathParamRegex.exec(routePath)) !== null) {
    params.push({
      name: match[1],
      type: "path",
      example: `{{${match[1]}}}`,
    });
  }

  return params;
}

function generateRouteName(method: string, path: string): string {
  const cleanPath = path.replace(/[/:]/g, " ").trim();
  return `${method.toUpperCase()} ${cleanPath}`;
}
```

## Next.js App Router Scanner

```typescript
// scripts/scan-nextjs-routes.ts
import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";

interface NextApiRoute {
  method: string;
  path: string;
  filePath: string;
}

async function scanNextJsRoutes(appDir: string): Promise<NextApiRoute[]> {
  const routes: NextApiRoute[] = [];
  const routeFiles = await glob(`${appDir}/**/route.{ts,js}`);

  for (const file of routeFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const relativePath = path.relative(appDir, path.dirname(file));
    const apiPath = "/" + relativePath.replace(/\\/g, "/");

    // Detect exported HTTP methods
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

    for (const method of methods) {
      if (
        content.includes(`export async function ${method}`) ||
        content.includes(`export function ${method}`) ||
        content.includes(`export const ${method}`)
      ) {
        routes.push({
          method,
          path: convertNextPathToPostman(apiPath),
          filePath: file,
        });
      }
    }
  }

  return routes;
}

function convertNextPathToPostman(nextPath: string): string {
  // Convert [param] to :param
  return nextPath
    .replace(/\[\.\.\.(\w+)\]/g, ":$1*") // [...slug] -> :slug*
    .replace(/\[(\w+)\]/g, ":$1"); // [id] -> :id
}
```

## Fastify Route Scanner

```typescript
// scripts/scan-fastify-routes.ts
interface FastifyRoute {
  method: string;
  path: string;
  schema?: {
    body?: object;
    querystring?: object;
    params?: object;
    response?: object;
  };
}

function scanFastifyRoutes(filePath: string): FastifyRoute[] {
  const routes: FastifyRoute[] = [];
  const code = fs.readFileSync(filePath, "utf-8");

  // Match fastify.get('/path', { schema: ... }, handler)
  const routeRegex =
    /fastify\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\{[\s\S]*?\})\s*,/g;

  let match;
  while ((match = routeRegex.exec(code)) !== null) {
    const [, method, path, optionsStr] = match;

    routes.push({
      method: method.toUpperCase(),
      path,
      // Parse schema from options if available
    });
  }

  return routes;
}
```

## Collection Generator

```typescript
// scripts/generate-collection.ts
interface PostmanCollection {
  info: {
    name: string;
    description: string;
    schema: string;
  };
  item: PostmanItem[];
  variable: PostmanVariable[];
  auth?: PostmanAuth;
}

interface PostmanItem {
  name: string;
  request: {
    method: string;
    header: PostmanHeader[];
    url: PostmanUrl;
    body?: PostmanBody;
    description?: string;
  };
  response?: PostmanResponse[];
}

interface PostmanUrl {
  raw: string;
  host: string[];
  path: string[];
  query?: PostmanQuery[];
  variable?: PostmanPathVariable[];
}

interface PostmanVariable {
  key: string;
  value: string;
  type: string;
}

function generatePostmanCollection(
  routes: RouteInfo[],
  options: {
    name: string;
    baseUrl: string;
    description?: string;
    auth?: "bearer" | "basic" | "apikey";
  },
): PostmanCollection {
  const collection: PostmanCollection = {
    info: {
      name: options.name,
      description: options.description || "Auto-generated API collection",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [],
    variable: [
      { key: "baseUrl", value: options.baseUrl, type: "string" },
      { key: "authToken", value: "", type: "string" },
    ],
  };

  // Add auth configuration
  if (options.auth === "bearer") {
    collection.auth = {
      type: "bearer",
      bearer: [{ key: "token", value: "{{authToken}}", type: "string" }],
    };
  }

  // Group routes by resource
  const groupedRoutes = groupRoutesByResource(routes);

  for (const [resource, resourceRoutes] of Object.entries(groupedRoutes)) {
    const folder: PostmanItem = {
      name: resource,
      item: resourceRoutes.map((route) => createPostmanRequest(route)),
    };
    collection.item.push(folder);
  }

  return collection;
}

function createPostmanRequest(route: RouteInfo): PostmanItem {
  const pathSegments = route.path.split("/").filter(Boolean);

  const item: PostmanItem = {
    name: route.name,
    request: {
      method: route.method,
      header: [{ key: "Content-Type", value: "application/json", type: "text" }],
      url: {
        raw: `{{baseUrl}}${route.path}`,
        host: ["{{baseUrl}}"],
        path: pathSegments,
        variable: route.params
          ?.filter((p) => p.type === "path")
          .map((p) => ({
            key: p.name,
            value: p.example || "",
            description: p.description,
          })),
      },
      description: route.description,
    },
  };

  // Add request body for POST/PUT/PATCH
  if (["POST", "PUT", "PATCH"].includes(route.method) && route.body) {
    item.request.body = {
      mode: "raw",
      raw: JSON.stringify(route.body, null, 2),
      options: { raw: { language: "json" } },
    };
  }

  return item;
}

function groupRoutesByResource(routes: RouteInfo[]): Record<string, RouteInfo[]> {
  const groups: Record<string, RouteInfo[]> = {};

  for (const route of routes) {
    // Extract resource from path (e.g., /api/users/:id -> users)
    const parts = route.path.split("/").filter(Boolean);
    const resource = parts[1] || parts[0] || "root";

    if (!groups[resource]) {
      groups[resource] = [];
    }
    groups[resource].push(route);
  }

  return groups;
}
```

## CLI Script

```typescript
#!/usr/bin/env node
// scripts/postman-gen.ts
import * as fs from "fs";
import * as path from "path";
import { program } from "commander";

program
  .name("postman-gen")
  .description("Generate Postman collection from API routes")
  .option("-f, --framework <type>", "Framework type", "express")
  .option("-s, --source <path>", "Source directory", "./src")
  .option("-o, --output <path>", "Output file", "./postman-collection.json")
  .option("-n, --name <name>", "Collection name", "API Collection")
  .option("-b, --base-url <url>", "Base URL", "http://localhost:3000")
  .option("-a, --auth <type>", "Auth type (bearer|basic|apikey)")
  .parse();

const options = program.opts();

async function main() {
  let routes: RouteInfo[] = [];

  switch (options.framework) {
    case "express":
      routes = await scanExpressProject(options.source);
      break;
    case "nextjs":
      routes = await scanNextJsRoutes(path.join(options.source, "app/api"));
      break;
    case "fastify":
      routes = await scanFastifyProject(options.source);
      break;
    default:
      console.error(`Unsupported framework: ${options.framework}`);
      process.exit(1);
  }

  const collection = generatePostmanCollection(routes, {
    name: options.name,
    baseUrl: options.baseUrl,
    auth: options.auth,
  });

  fs.writeFileSync(options.output, JSON.stringify(collection, null, 2));
  console.log(`Generated ${options.output} with ${routes.length} endpoints`);
}

main();
```

## Environment Template

```json
{
  "name": "Development",
  "values": [
    { "key": "baseUrl", "value": "http://localhost:3000/api", "enabled": true },
    { "key": "authToken", "value": "", "enabled": true, "type": "secret" },
    { "key": "userId", "value": "1", "enabled": true }
  ]
}
```

## Example Output

```json
{
  "info": {
    "name": "My API",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Users",
      "item": [
        {
          "name": "GET users",
          "request": {
            "method": "GET",
            "url": {
              "raw": "{{baseUrl}}/users",
              "host": ["{{baseUrl}}"],
              "path": ["users"],
              "query": [
                { "key": "page", "value": "1" },
                { "key": "limit", "value": "10" }
              ]
            }
          }
        },
        {
          "name": "GET user by ID",
          "request": {
            "method": "GET",
            "url": {
              "raw": "{{baseUrl}}/users/:id",
              "host": ["{{baseUrl}}"],
              "path": ["users", ":id"],
              "variable": [{ "key": "id", "value": "{{userId}}" }]
            }
          }
        },
        {
          "name": "POST create user",
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"name\": \"John Doe\",\n  \"email\": \"john@example.com\"\n}"
            },
            "url": {
              "raw": "{{baseUrl}}/users",
              "host": ["{{baseUrl}}"],
              "path": ["users"]
            }
          }
        }
      ]
    }
  ],
  "variable": [
    { "key": "baseUrl", "value": "http://localhost:3000/api" },
    { "key": "authToken", "value": "" }
  ]
}
```

## Best Practices

1. **Use variables**: `{{baseUrl}}`, `{{authToken}}` for flexibility
2. **Group endpoints**: Organize by resource/feature folders
3. **Add descriptions**: Document each endpoint's purpose
4. **Include examples**: Pre-fill request bodies with realistic data
5. **Set up auth**: Configure collection-level authentication
6. **Add tests**: Include basic response validation scripts
7. **Version control**: Commit collection JSON to repository
8. **CI integration**: Auto-generate on route changes

## Output Checklist

- [ ] All routes scanned from codebase
- [ ] Endpoints grouped by resource
- [ ] Path parameters extracted
- [ ] Request bodies included for POST/PUT/PATCH
- [ ] Environment variables configured
- [ ] Authentication setup (if applicable)
- [ ] Collection exported as v2.1 JSON
- [ ] Environment template created
