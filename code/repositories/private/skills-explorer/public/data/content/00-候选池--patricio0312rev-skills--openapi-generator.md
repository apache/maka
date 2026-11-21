---
name: openapi-generator
description: Generates OpenAPI 3.0/3.1 specifications from Express, Next.js, Fastify, Hono, or NestJS routes. Creates complete specs with schemas, examples, and documentation that can be imported into Postman, Insomnia, or used with Swagger UI. Use when users request "generate openapi", "create swagger spec", "openapi documentation", or "api specification".
---

# OpenAPI Generator

Generate OpenAPI 3.0/3.1 specifications from your API codebase automatically.

## Core Workflow

1. **Scan routes**: Find all API route definitions
2. **Extract schemas**: Types, request/response bodies, params
3. **Build paths**: Convert routes to OpenAPI path objects
4. **Generate schemas**: Create component schemas from types
5. **Add documentation**: Descriptions, examples, tags
6. **Export spec**: YAML or JSON format

## OpenAPI 3.1 Base Template

```yaml
openapi: 3.1.0
info:
  title: API Title
  version: 1.0.0
  description: API description
  contact:
    email: api@example.com
  license:
    name: MIT
    url: https://opensource.org/licenses/MIT

servers:
  - url: http://localhost:3000/api
    description: Development
  - url: https://api.example.com
    description: Production

tags:
  - name: Users
    description: User management endpoints
  - name: Products
    description: Product catalog endpoints

paths: {}

components:
  schemas: {}
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    apiKey:
      type: apiKey
      in: header
      name: X-API-Key

security:
  - bearerAuth: []
```

## TypeScript to OpenAPI Schema Converter

```typescript
// scripts/type-to-schema.ts
import * as ts from "typescript";

interface OpenAPISchema {
  type?: string;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  items?: OpenAPISchema;
  $ref?: string;
  enum?: string[];
  format?: string;
  description?: string;
  example?: unknown;
}

function typeToOpenAPISchema(checker: ts.TypeChecker, type: ts.Type): OpenAPISchema {
  // Handle primitives
  if (type.flags & ts.TypeFlags.String) {
    return { type: "string" };
  }
  if (type.flags & ts.TypeFlags.Number) {
    return { type: "number" };
  }
  if (type.flags & ts.TypeFlags.Boolean) {
    return { type: "boolean" };
  }

  // Handle arrays
  if (checker.isArrayType(type)) {
    const elementType = (type as ts.TypeReference).typeArguments?.[0];
    return {
      type: "array",
      items: elementType ? typeToOpenAPISchema(checker, elementType) : {},
    };
  }

  // Handle object types
  if (type.flags & ts.TypeFlags.Object) {
    const properties: Record<string, OpenAPISchema> = {};
    const required: string[] = [];

    type.getProperties().forEach((prop) => {
      const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration!);
      properties[prop.name] = typeToOpenAPISchema(checker, propType);

      // Check if required (no ? modifier)
      if (!(prop.flags & ts.SymbolFlags.Optional)) {
        required.push(prop.name);
      }
    });

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  // Handle union types (enums)
  if (type.isUnion()) {
    const enumValues = type.types
      .filter((t) => t.isStringLiteral())
      .map((t) => (t as ts.StringLiteralType).value);

    if (enumValues.length > 0) {
      return { type: "string", enum: enumValues };
    }
  }

  return {};
}
```

## Express Route Scanner with JSDoc

```typescript
// scripts/express-openapi.ts
import * as fs from "fs";
import * as path from "path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

interface RouteMetadata {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
  requestBody?: object;
  responses?: Record<string, object>;
  parameters?: object[];
  security?: object[];
}

function extractJSDocMetadata(comments: string): Partial<RouteMetadata> {
  const metadata: Partial<RouteMetadata> = {};

  // @summary
  const summaryMatch = comments.match(/@summary\s+(.+)/);
  if (summaryMatch) metadata.summary = summaryMatch[1].trim();

  // @description
  const descMatch = comments.match(/@description\s+(.+)/);
  if (descMatch) metadata.description = descMatch[1].trim();

  // @tags
  const tagsMatch = comments.match(/@tags\s+(.+)/);
  if (tagsMatch) metadata.tags = tagsMatch[1].split(",").map((t) => t.trim());

  return metadata;
}

function scanExpressWithOpenAPI(sourceDir: string): RouteMetadata[] {
  const routes: RouteMetadata[] = [];

  // Implementation: traverse files and extract routes with JSDoc comments
  // Similar to postman generator but with OpenAPI-specific metadata

  return routes;
}
```

## OpenAPI Path Generator

```typescript
// scripts/generate-openapi.ts
import * as yaml from "js-yaml";

interface OpenAPISpec {
  openapi: string;
  info: object;
  servers: object[];
  paths: Record<string, object>;
  components: {
    schemas: Record<string, object>;
    securitySchemes?: object;
  };
  tags?: object[];
  security?: object[];
}

function generateOpenAPISpec(
  routes: RouteMetadata[],
  options: {
    title: string;
    version: string;
    description?: string;
    servers: { url: string; description: string }[];
  },
): OpenAPISpec {
  const spec: OpenAPISpec = {
    openapi: "3.1.0",
    info: {
      title: options.title,
      version: options.version,
      description: options.description,
    },
    servers: options.servers,
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    tags: [],
  };

  // Collect unique tags
  const tagSet = new Set<string>();

  // Generate paths
  for (const route of routes) {
    const openAPIPath = route.path.replace(/:(\w+)/g, "{$1}");

    if (!spec.paths[openAPIPath]) {
      spec.paths[openAPIPath] = {};
    }

    spec.paths[openAPIPath][route.method.toLowerCase()] = {
      summary: route.summary || `${route.method} ${route.path}`,
      description: route.description,
      tags: route.tags || [extractResourceTag(route.path)],
      parameters: generateParameters(route),
      requestBody: route.requestBody,
      responses: route.responses || generateDefaultResponses(route.method),
      security: route.security,
    };

    // Collect tags
    (route.tags || [extractResourceTag(route.path)]).forEach((t) => tagSet.add(t));
  }

  // Add tags to spec
  spec.tags = Array.from(tagSet).map((name) => ({ name }));

  return spec;
}

function generateParameters(route: RouteMetadata): object[] {
  const params: object[] = [];

  // Extract path parameters
  const pathParamRegex = /:(\w+)/g;
  let match;

  while ((match = pathParamRegex.exec(route.path)) !== null) {
    params.push({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
      description: `${match[1]} parameter`,
    });
  }

  return params;
}

function generateDefaultResponses(method: string): object {
  const responses: Record<string, object> = {
    "200": {
      description: "Successful response",
      content: {
        "application/json": {
          schema: { type: "object" },
        },
      },
    },
    "400": {
      description: "Bad request",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Error" },
        },
      },
    },
    "401": {
      description: "Unauthorized",
    },
    "404": {
      description: "Not found",
    },
    "500": {
      description: "Internal server error",
    },
  };

  if (method === "POST") {
    responses["201"] = {
      description: "Created successfully",
      content: {
        "application/json": {
          schema: { type: "object" },
        },
      },
    };
  }

  if (method === "DELETE") {
    responses["204"] = {
      description: "Deleted successfully",
    };
  }

  return responses;
}

function extractResourceTag(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[0] || "default";
}
```

## Common Schema Components

```yaml
components:
  schemas:
    Error:
      type: object
      required:
        - code
        - message
      properties:
        code:
          type: string
          example: "VALIDATION_ERROR"
        message:
          type: string
          example: "Invalid request data"
        details:
          type: object
          additionalProperties:
            type: array
            items:
              type: string

    Pagination:
      type: object
      properties:
        page:
          type: integer
          minimum: 1
          example: 1
        limit:
          type: integer
          minimum: 1
          maximum: 100
          example: 10
        total:
          type: integer
          example: 156
        total_pages:
          type: integer
          example: 16

    PaginatedResponse:
      type: object
      properties:
        success:
          type: boolean
          example: true
        data:
          type: array
          items: {}
        meta:
          $ref: "#/components/schemas/Pagination"

    User:
      type: object
      required:
        - id
        - email
        - name
      properties:
        id:
          type: string
          format: uuid
          example: "123e4567-e89b-12d3-a456-426614174000"
        email:
          type: string
          format: email
          example: "user@example.com"
        name:
          type: string
          example: "John Doe"
        created_at:
          type: string
          format: date-time
          example: "2024-01-15T10:30:00Z"

    CreateUserRequest:
      type: object
      required:
        - email
        - name
        - password
      properties:
        email:
          type: string
          format: email
        name:
          type: string
          minLength: 2
          maxLength: 100
        password:
          type: string
          format: password
          minLength: 8
```

## Fastify Integration

```typescript
// Fastify with @fastify/swagger
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

const fastify = Fastify({ logger: true });

await fastify.register(swagger, {
  openapi: {
    info: {
      title: "My API",
      version: "1.0.0",
    },
    servers: [{ url: "http://localhost:3000" }],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: "/docs",
});

// Routes with schema
fastify.get(
  "/users/:id",
  {
    schema: {
      params: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
        },
        required: ["id"],
      },
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            email: { type: "string" },
          },
        },
      },
    },
  },
  async (request, reply) => {
    // Handler
  },
);
```

## NestJS Integration

```typescript
// NestJS with @nestjs/swagger
import { Controller, Get, Post, Body, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from "@nestjs/swagger";

@ApiTags("users")
@Controller("users")
export class UsersController {
  @Get()
  @ApiOperation({ summary: "Get all users" })
  @ApiResponse({ status: 200, description: "List of users", type: [UserDto] })
  findAll() {
    // Implementation
  }

  @Get(":id")
  @ApiOperation({ summary: "Get user by ID" })
  @ApiResponse({ status: 200, description: "User found", type: UserDto })
  @ApiResponse({ status: 404, description: "User not found" })
  findOne(@Param("id") id: string) {
    // Implementation
  }

  @Post()
  @ApiOperation({ summary: "Create new user" })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, description: "User created", type: UserDto })
  create(@Body() createUserDto: CreateUserDto) {
    // Implementation
  }
}
```

## CLI Script

```typescript
#!/usr/bin/env node
// scripts/openapi-gen.ts
import * as fs from "fs";
import * as yaml from "js-yaml";
import { program } from "commander";

program
  .name("openapi-gen")
  .description("Generate OpenAPI specification from API routes")
  .option("-f, --framework <type>", "Framework (express|nextjs|fastify)", "express")
  .option("-s, --source <path>", "Source directory", "./src")
  .option("-o, --output <path>", "Output file", "./openapi.yaml")
  .option("-t, --title <name>", "API title", "My API")
  .option("-v, --version <version>", "API version", "1.0.0")
  .option("--json", "Output as JSON instead of YAML")
  .parse();

const options = program.opts();

async function main() {
  const routes = await scanRoutes(options.framework, options.source);

  const spec = generateOpenAPISpec(routes, {
    title: options.title,
    version: options.version,
    servers: [{ url: "http://localhost:3000/api", description: "Development" }],
  });

  const output = options.json ? JSON.stringify(spec, null, 2) : yaml.dump(spec, { lineWidth: -1 });

  fs.writeFileSync(options.output, output);
  console.log(`Generated ${options.output} with ${routes.length} endpoints`);
}

main();
```

## Validation Script

```typescript
// scripts/validate-openapi.ts
import SwaggerParser from "@apidevtools/swagger-parser";

async function validateSpec(specPath: string): Promise<void> {
  try {
    const api = await SwaggerParser.validate(specPath);
    console.log(`API name: ${api.info.title}, Version: ${api.info.version}`);
    console.log("OpenAPI specification is valid!");
  } catch (err) {
    console.error("Validation failed:", err.message);
    process.exit(1);
  }
}
```

## Best Practices

1. **Use $ref**: Reference shared schemas to avoid duplication
2. **Add examples**: Include realistic examples for all schemas
3. **Document errors**: Define all possible error responses
4. **Use tags**: Organize endpoints by resource/feature
5. **Version control**: Commit spec to repository
6. **Validate**: Run validation before publishing
7. **Generate SDKs**: Use openapi-generator for client SDKs
8. **Serve UI**: Host Swagger UI or Redoc for documentation

## Output Checklist

- [ ] All routes converted to OpenAPI paths
- [ ] Path parameters use {param} syntax
- [ ] Request bodies defined with schemas
- [ ] Response schemas for all status codes
- [ ] Common schemas in components/schemas
- [ ] Security schemes configured
- [ ] Tags applied to all endpoints
- [ ] Examples included for schemas
- [ ] Spec validates without errors
- [ ] YAML/JSON exported successfully
