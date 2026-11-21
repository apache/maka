---
name: api-test-suite-generator
description: Generates comprehensive API test suites using Jest, Vitest, or Supertest from Express, Next.js, Fastify, or other API routes. Creates integration tests, contract tests, and edge case coverage. Use when users request "generate api tests", "create endpoint tests", "api test suite", or "integration tests for api".
---

# API Test Suite Generator

Generate comprehensive API test suites automatically from your route definitions.

## Core Workflow

1. **Scan routes**: Find all API route definitions
2. **Analyze contracts**: Extract request/response schemas
3. **Generate tests**: Create test files for each resource
4. **Add assertions**: Status codes, response structure, headers
5. **Include edge cases**: Invalid inputs, auth, not found
6. **Setup fixtures**: Test data and database seeding

## Test Structure

```
tests/
├── setup.ts              # Global test setup
├── fixtures/             # Test data
│   ├── users.ts
│   └── products.ts
├── integration/          # API integration tests
│   ├── users.test.ts
│   ├── products.test.ts
│   └── auth.test.ts
└── helpers/              # Test utilities
    ├── api-client.ts
    └── auth.ts
```

## Test Setup (Vitest/Jest)

```typescript
// tests/setup.ts
import { beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer } from "../src/server";
import { prisma } from "../src/db";

let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  server = await createServer();
  await server.listen({ port: 0 }); // Random port
  process.env.TEST_BASE_URL = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean database before each test
  await prisma.$executeRaw`TRUNCATE TABLE users CASCADE`;
});

afterEach(async () => {
  // Cleanup after each test
});

export { server };
```

## API Test Client

```typescript
// tests/helpers/api-client.ts
import supertest from "supertest";

const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3000";

export const api = supertest(baseUrl);

export async function authenticatedApi(token?: string) {
  const authToken = token || (await getTestAuthToken());
  return {
    get: (url: string) => api.get(url).set("Authorization", `Bearer ${authToken}`),
    post: (url: string) => api.post(url).set("Authorization", `Bearer ${authToken}`),
    put: (url: string) => api.put(url).set("Authorization", `Bearer ${authToken}`),
    patch: (url: string) => api.patch(url).set("Authorization", `Bearer ${authToken}`),
    delete: (url: string) => api.delete(url).set("Authorization", `Bearer ${authToken}`),
  };
}

async function getTestAuthToken(): Promise<string> {
  const response = await api.post("/api/auth/login").send({
    email: "test@example.com",
    password: "testpassword",
  });
  return response.body.token;
}
```

## Test Generator Script

```typescript
// scripts/generate-api-tests.ts
import * as fs from "fs";
import * as path from "path";

interface RouteInfo {
  method: string;
  path: string;
  name: string;
  params?: { name: string; type: "path" | "query" }[];
  requestBody?: object;
  responseSchema?: object;
  auth?: boolean;
}

interface TestCase {
  name: string;
  description: string;
  method: string;
  path: string;
  body?: object;
  expectedStatus: number;
  expectedBody?: object;
  headers?: Record<string, string>;
  auth?: boolean;
}

function generateTestFile(resource: string, routes: RouteInfo[]): string {
  const lines: string[] = [];

  // Imports
  lines.push(`import { describe, it, expect, beforeEach, afterEach } from "vitest";`);
  lines.push(`import { api, authenticatedApi } from "../helpers/api-client";`);
  lines.push(`import { create${capitalize(resource)} } from "../fixtures/${resource}";`);
  lines.push("");

  // Test suite
  lines.push(`describe("${capitalize(resource)} API", () => {`);

  for (const route of routes) {
    const testCases = generateTestCases(route);

    lines.push(`  describe("${route.method} ${route.path}", () => {`);

    for (const testCase of testCases) {
      lines.push(generateTestCase(testCase, route));
    }

    lines.push(`  });`);
    lines.push("");
  }

  lines.push(`});`);

  return lines.join("\n");
}

function generateTestCases(route: RouteInfo): TestCase[] {
  const cases: TestCase[] = [];

  // Success case
  cases.push({
    name: `should ${getActionVerb(route.method)} successfully`,
    description: `Happy path for ${route.method} ${route.path}`,
    method: route.method,
    path: route.path,
    body: route.requestBody,
    expectedStatus: getExpectedStatus(route.method),
    auth: route.auth,
  });

  // Auth failure case (if auth required)
  if (route.auth) {
    cases.push({
      name: "should return 401 without auth token",
      description: "Unauthorized access attempt",
      method: route.method,
      path: route.path,
      expectedStatus: 401,
      auth: false,
    });
  }

  // Not found case (if has path params)
  if (route.params?.some((p) => p.type === "path")) {
    cases.push({
      name: "should return 404 for non-existent resource",
      description: "Resource not found",
      method: route.method,
      path: route.path.replace(/:(\w+)/g, "non-existent-id"),
      expectedStatus: 404,
      auth: route.auth,
    });
  }

  // Validation error case (for POST/PUT/PATCH)
  if (["POST", "PUT", "PATCH"].includes(route.method)) {
    cases.push({
      name: "should return 400 for invalid request body",
      description: "Validation failure",
      method: route.method,
      path: route.path,
      body: {},
      expectedStatus: 400,
      auth: route.auth,
    });
  }

  return cases;
}

function generateTestCase(testCase: TestCase, route: RouteInfo): string {
  const lines: string[] = [];
  const indent = "    ";

  lines.push(`${indent}it("${testCase.name}", async () => {`);

  // Setup
  if (route.params?.some((p) => p.type === "path")) {
    lines.push(`${indent}  // Setup: Create test resource`);
    lines.push(`${indent}  const resource = await createTestResource();`);
    lines.push(`${indent}  const url = "${route.path}".replace(":id", resource.id);`);
  } else {
    lines.push(`${indent}  const url = "${route.path}";`);
  }

  // Make request
  lines.push("");
  if (testCase.auth) {
    lines.push(`${indent}  const client = await authenticatedApi();`);
    lines.push(`${indent}  const response = await client.${testCase.method.toLowerCase()}(url)`);
  } else {
    lines.push(`${indent}  const response = await api.${testCase.method.toLowerCase()}(url)`);
  }

  if (testCase.body) {
    lines.push(
      `${indent}    .send(${JSON.stringify(testCase.body, null, 2).replace(/\n/g, `\n${indent}    `)})`,
    );
  }

  lines.push(`${indent}    .expect(${testCase.expectedStatus});`);

  // Assertions
  lines.push("");
  if (testCase.expectedStatus < 400) {
    lines.push(`${indent}  expect(response.body).toBeDefined();`);
    if (testCase.method === "POST") {
      lines.push(`${indent}  expect(response.body.id).toBeDefined();`);
    }
  } else {
    lines.push(`${indent}  expect(response.body.error).toBeDefined();`);
  }

  lines.push(`${indent}});`);
  lines.push("");

  return lines.join("\n");
}

function getActionVerb(method: string): string {
  const verbs: Record<string, string> = {
    GET: "retrieve",
    POST: "create",
    PUT: "update",
    PATCH: "partially update",
    DELETE: "delete",
  };
  return verbs[method] || "process";
}

function getExpectedStatus(method: string): number {
  const statuses: Record<string, number> = {
    GET: 200,
    POST: 201,
    PUT: 200,
    PATCH: 200,
    DELETE: 204,
  };
  return statuses[method] || 200;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
```

## Example Generated Tests

```typescript
// tests/integration/users.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { api, authenticatedApi } from "../helpers/api-client";
import { createUser, createUsers } from "../fixtures/users";

describe("Users API", () => {
  describe("GET /api/users", () => {
    it("should return paginated list of users", async () => {
      // Setup
      await createUsers(15);

      // Request
      const client = await authenticatedApi();
      const response = await client.get("/api/users").query({ page: 1, limit: 10 }).expect(200);

      // Assertions
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(10);
      expect(response.body.meta.total).toBe(15);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.total_pages).toBe(2);
    });

    it("should return 401 without auth token", async () => {
      const response = await api.get("/api/users").expect(401);

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("GET /api/users/:id", () => {
    it("should return user by ID", async () => {
      const user = await createUser({ name: "Test User" });

      const client = await authenticatedApi();
      const response = await client.get(`/api/users/${user.id}`).expect(200);

      expect(response.body.data.id).toBe(user.id);
      expect(response.body.data.name).toBe("Test User");
    });

    it("should return 404 for non-existent user", async () => {
      const client = await authenticatedApi();
      const response = await client.get("/api/users/non-existent-id").expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("POST /api/users", () => {
    it("should create new user", async () => {
      const client = await authenticatedApi();
      const response = await client
        .post("/api/users")
        .send({
          name: "New User",
          email: "new@example.com",
          role: "user",
        })
        .expect(201);

      expect(response.body.data.id).toBeDefined();
      expect(response.body.data.name).toBe("New User");
      expect(response.body.data.email).toBe("new@example.com");
    });

    it("should return 400 for invalid request body", async () => {
      const client = await authenticatedApi();
      const response = await client.post("/api/users").send({}).expect(400);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details).toBeDefined();
    });

    it("should return 409 for duplicate email", async () => {
      await createUser({ email: "existing@example.com" });

      const client = await authenticatedApi();
      const response = await client
        .post("/api/users")
        .send({
          name: "New User",
          email: "existing@example.com",
        })
        .expect(409);

      expect(response.body.error.code).toBe("CONFLICT");
    });
  });

  describe("PUT /api/users/:id", () => {
    it("should update user", async () => {
      const user = await createUser({ name: "Original Name" });

      const client = await authenticatedApi();
      const response = await client
        .put(`/api/users/${user.id}`)
        .send({
          name: "Updated Name",
          email: user.email,
        })
        .expect(200);

      expect(response.body.data.name).toBe("Updated Name");
    });

    it("should return 404 for non-existent user", async () => {
      const client = await authenticatedApi();
      const response = await client
        .put("/api/users/non-existent-id")
        .send({ name: "Test" })
        .expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("DELETE /api/users/:id", () => {
    it("should delete user", async () => {
      const user = await createUser();

      const client = await authenticatedApi();
      await client.delete(`/api/users/${user.id}`).expect(204);

      // Verify deletion
      await client.get(`/api/users/${user.id}`).expect(404);
    });

    it("should return 404 for non-existent user", async () => {
      const client = await authenticatedApi();
      await client.delete("/api/users/non-existent-id").expect(404);
    });
  });
});
```

## Test Fixtures

```typescript
// tests/fixtures/users.ts
import { prisma } from "../../src/db";
import { faker } from "@faker-js/faker";

interface CreateUserOptions {
  name?: string;
  email?: string;
  role?: string;
}

export async function createUser(options: CreateUserOptions = {}) {
  return prisma.user.create({
    data: {
      name: options.name ?? faker.person.fullName(),
      email: options.email ?? faker.internet.email(),
      role: options.role ?? "user",
      password: await hashPassword("testpassword"),
    },
  });
}

export async function createUsers(count: number) {
  const users = Array.from({ length: count }, () => ({
    name: faker.person.fullName(),
    email: faker.internet.email(),
    role: "user",
    password: "hashed-password",
  }));

  return prisma.user.createMany({ data: users });
}

export async function createAdminUser() {
  return createUser({ role: "admin" });
}
```

## Contract Testing

```typescript
// tests/contract/users.contract.test.ts
import { describe, it, expect } from "vitest";
import { api, authenticatedApi } from "../helpers/api-client";
import { z } from "zod";

// Response schemas
const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  role: z.enum(["user", "admin"]),
  createdAt: z.string().datetime(),
});

const PaginatedUsersSchema = z.object({
  success: z.literal(true),
  data: z.array(UserSchema),
  meta: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    total_pages: z.number(),
  }),
});

describe("Users API Contract", () => {
  it("GET /api/users should match contract", async () => {
    const client = await authenticatedApi();
    const response = await client.get("/api/users").expect(200);

    // Validate against schema
    const result = PaginatedUsersSchema.safeParse(response.body);
    expect(result.success).toBe(true);
  });

  it("GET /api/users/:id should match contract", async () => {
    const user = await createUser();

    const client = await authenticatedApi();
    const response = await client.get(`/api/users/${user.id}`).expect(200);

    // Validate against schema
    const result = UserSchema.safeParse(response.body.data);
    expect(result.success).toBe(true);
  });
});
```

## CLI Script

```typescript
#!/usr/bin/env node
// scripts/test-gen.ts
import * as fs from "fs";
import * as path from "path";
import { program } from "commander";

program
  .name("test-gen")
  .description("Generate API test suite from routes")
  .option("-f, --framework <type>", "Framework (express|nextjs|fastify)", "express")
  .option("-s, --source <path>", "Source directory", "./src")
  .option("-o, --output <path>", "Output directory", "./tests/integration")
  .option("-t, --test-runner <type>", "Test runner (vitest|jest)", "vitest")
  .parse();

const options = program.opts();

async function main() {
  const routes = await scanRoutes(options.framework, options.source);
  const groupedRoutes = groupRoutesByResource(routes);

  if (!fs.existsSync(options.output)) {
    fs.mkdirSync(options.output, { recursive: true });
  }

  for (const [resource, resourceRoutes] of Object.entries(groupedRoutes)) {
    const content = generateTestFile(resource, resourceRoutes);
    const filePath = path.join(options.output, `${resource}.test.ts`);
    fs.writeFileSync(filePath, content);
    console.log(`Generated ${filePath}`);
  }
}

main();
```

## Best Practices

1. **Isolate tests**: Each test should be independent
2. **Clean state**: Reset database between tests
3. **Use fixtures**: Create reusable test data factories
4. **Test edge cases**: Invalid input, auth, not found
5. **Contract testing**: Validate response schemas
6. **Descriptive names**: Tests should read like documentation
7. **Fast execution**: Use transactions for database cleanup
8. **CI integration**: Run tests on every PR

## Output Checklist

- [ ] Test setup with server lifecycle
- [ ] API client helper with auth support
- [ ] Test files for each resource
- [ ] Happy path tests for all endpoints
- [ ] Authentication failure tests
- [ ] Validation error tests
- [ ] Not found tests for path params
- [ ] Conflict/duplicate tests where applicable
- [ ] Contract/schema validation tests
- [ ] Test fixtures for each resource
