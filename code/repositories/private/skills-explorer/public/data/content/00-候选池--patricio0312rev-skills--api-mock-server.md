---
name: api-mock-server
description: Creates mock API servers for testing and development with MSW, json-server, or custom handlers. Use when users request "API mocking", "mock server", "MSW setup", "test fixtures", or "mock API responses".
---

# API Mock Server

Create realistic mock APIs for testing and development.

## Core Workflow

1. **Choose approach**: MSW, json-server, custom
2. **Define handlers**: Mock endpoints
3. **Setup fixtures**: Test data
4. **Configure scenarios**: Success/error states
5. **Integrate tests**: Use in test suites
6. **Document mocks**: API contract

## MSW (Mock Service Worker)

### Installation

```bash
npm install -D msw
npx msw init ./public --save
```

### Handler Definition

```typescript
// mocks/handlers.ts
import { http, HttpResponse, delay } from "msw";

// Types
interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
}

interface CreateUserInput {
  name: string;
  email: string;
}

// Fixtures
const users: User[] = [
  { id: "1", name: "John Doe", email: "john@example.com", role: "admin" },
  { id: "2", name: "Jane Smith", email: "jane@example.com", role: "user" },
];

// Handlers
export const handlers = [
  // GET /api/users
  http.get("/api/users", async () => {
    await delay(100);
    return HttpResponse.json(users);
  }),

  // GET /api/users/:id
  http.get("/api/users/:id", async ({ params }) => {
    await delay(50);
    const user = users.find((u) => u.id === params.id);

    if (!user) {
      return new HttpResponse(null, { status: 404 });
    }

    return HttpResponse.json(user);
  }),

  // POST /api/users
  http.post("/api/users", async ({ request }) => {
    await delay(100);
    const body = (await request.json()) as CreateUserInput;

    const newUser: User = {
      id: String(users.length + 1),
      name: body.name,
      email: body.email,
      role: "user",
    };

    users.push(newUser);

    return HttpResponse.json(newUser, { status: 201 });
  }),

  // PUT /api/users/:id
  http.put("/api/users/:id", async ({ params, request }) => {
    await delay(50);
    const body = (await request.json()) as Partial<User>;
    const index = users.findIndex((u) => u.id === params.id);

    if (index === -1) {
      return new HttpResponse(null, { status: 404 });
    }

    users[index] = { ...users[index], ...body };

    return HttpResponse.json(users[index]);
  }),

  // DELETE /api/users/:id
  http.delete("/api/users/:id", async ({ params }) => {
    await delay(50);
    const index = users.findIndex((u) => u.id === params.id);

    if (index === -1) {
      return new HttpResponse(null, { status: 404 });
    }

    users.splice(index, 1);

    return new HttpResponse(null, { status: 204 });
  }),
];
```

### Setup for Browser

```typescript
// mocks/browser.ts
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);
```

```typescript
// main.tsx or app entry
async function enableMocking() {
  if (process.env.NODE_ENV === "development") {
    const { worker } = await import("./mocks/browser");
    return worker.start({
      onUnhandledRequest: "bypass",
    });
  }
}

enableMocking().then(() => {
  // Render app
});
```

### Setup for Node (Tests)

```typescript
// mocks/server.ts
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
```

```typescript
// tests/setup.ts (Jest or Vitest)
import { beforeAll, afterEach, afterAll } from "vitest";
import { server } from "../mocks/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

### Test-Specific Handlers

```typescript
// tests/users.test.ts
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render, screen, waitFor } from '@testing-library/react';
import { UserList } from '../components/UserList';

describe('UserList', () => {
  it('displays users', async () => {
    render(<UserList />);

    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });
  });

  it('handles empty state', async () => {
    server.use(
      http.get('/api/users', () => {
        return HttpResponse.json([]);
      })
    );

    render(<UserList />);

    await waitFor(() => {
      expect(screen.getByText('No users found')).toBeInTheDocument();
    });
  });

  it('handles server error', async () => {
    server.use(
      http.get('/api/users', () => {
        return new HttpResponse(null, { status: 500 });
      })
    );

    render(<UserList />);

    await waitFor(() => {
      expect(screen.getByText('Error loading users')).toBeInTheDocument();
    });
  });

  it('handles network error', async () => {
    server.use(
      http.get('/api/users', () => {
        return HttpResponse.error();
      })
    );

    render(<UserList />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });
});
```

### GraphQL Mocking

```typescript
// mocks/graphql-handlers.ts
import { graphql, HttpResponse } from "msw";

export const graphqlHandlers = [
  graphql.query("GetUsers", () => {
    return HttpResponse.json({
      data: {
        users: [
          { id: "1", name: "John", email: "john@example.com" },
          { id: "2", name: "Jane", email: "jane@example.com" },
        ],
      },
    });
  }),

  graphql.mutation("CreateUser", ({ variables }) => {
    return HttpResponse.json({
      data: {
        createUser: {
          id: "3",
          name: variables.input.name,
          email: variables.input.email,
        },
      },
    });
  }),

  graphql.query("GetUser", ({ variables }) => {
    if (variables.id === "not-found") {
      return HttpResponse.json({
        data: { user: null },
        errors: [{ message: "User not found" }],
      });
    }

    return HttpResponse.json({
      data: {
        user: { id: variables.id, name: "John", email: "john@example.com" },
      },
    });
  }),
];
```

## Json-Server

### Configuration

```json
// db.json
{
  "users": [
    { "id": "1", "name": "John Doe", "email": "john@example.com" },
    { "id": "2", "name": "Jane Smith", "email": "jane@example.com" }
  ],
  "posts": [
    { "id": "1", "title": "Hello World", "authorId": "1" },
    { "id": "2", "title": "Another Post", "authorId": "2" }
  ],
  "comments": [{ "id": "1", "text": "Great post!", "postId": "1" }]
}
```

```javascript
// json-server.config.js
module.exports = {
  port: 3001,
  watch: true,
  delay: 100,
  routes: "routes.json",
};
```

```json
// routes.json
{
  "/api/*": "/$1",
  "/users/:id/posts": "/posts?authorId=:id"
}
```

### Custom Routes

```javascript
// server.js
const jsonServer = require("json-server");
const server = jsonServer.create();
const router = jsonServer.router("db.json");
const middlewares = jsonServer.defaults();

// Custom middleware for auth
server.use((req, res, next) => {
  if (req.headers.authorization !== "Bearer valid-token") {
    if (req.method !== "GET") {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

server.use(middlewares);

// Custom routes
server.get("/api/me", (req, res) => {
  res.json({ id: "1", name: "Current User", email: "me@example.com" });
});

server.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  if (email === "test@example.com" && password === "password") {
    res.json({ token: "valid-token", user: { id: "1", email } });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

server.use("/api", router);

server.listen(3001, () => {
  console.log("Mock API running on http://localhost:3001");
});
```

## Fixture Factories

```typescript
// mocks/factories/user.ts
import { faker } from "@faker-js/faker";

interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
}

export function createUser(overrides: Partial<User> = {}): User {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    role: "user",
    createdAt: faker.date.past().toISOString(),
    ...overrides,
  };
}

export function createUsers(count: number, overrides: Partial<User> = {}): User[] {
  return Array.from({ length: count }, () => createUser(overrides));
}

// mocks/factories/index.ts
export * from "./user";
export * from "./post";
export * from "./comment";
```

### Using Factories in Tests

```typescript
// tests/components/UserProfile.test.tsx
import { createUser } from '../mocks/factories';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';

describe('UserProfile', () => {
  it('displays admin badge for admin users', async () => {
    const adminUser = createUser({ role: 'admin', name: 'Admin User' });

    server.use(
      http.get('/api/users/:id', () => {
        return HttpResponse.json(adminUser);
      })
    );

    render(<UserProfile userId={adminUser.id} />);

    await waitFor(() => {
      expect(screen.getByText('Admin User')).toBeInTheDocument();
      expect(screen.getByTestId('admin-badge')).toBeInTheDocument();
    });
  });
});
```

## Scenario-Based Mocking

```typescript
// mocks/scenarios.ts
import { http, HttpResponse, delay } from "msw";
import { createUser, createUsers } from "./factories";

export const scenarios = {
  default: [],

  emptyState: [
    http.get("/api/users", () => HttpResponse.json([])),
    http.get("/api/posts", () => HttpResponse.json([])),
  ],

  loadingState: [
    http.get("/api/users", async () => {
      await delay("infinite");
      return HttpResponse.json([]);
    }),
  ],

  errorState: [
    http.get("/api/users", () => {
      return new HttpResponse(null, { status: 500 });
    }),
  ],

  largeDataset: [
    http.get("/api/users", () => {
      return HttpResponse.json(createUsers(1000));
    }),
  ],

  slowNetwork: [
    http.get("/api/*", async ({ request }) => {
      await delay(2000);
      // Continue to default handler
      return undefined;
    }),
  ],
};

// Usage in tests
describe("UserList scenarios", () => {
  it("empty state", async () => {
    server.use(...scenarios.emptyState);
    // Test empty state
  });

  it("error state", async () => {
    server.use(...scenarios.errorState);
    // Test error handling
  });
});

// Usage in Storybook
export const EmptyState: Story = {
  parameters: {
    msw: {
      handlers: scenarios.emptyState,
    },
  },
};
```

## Playwright Integration

```typescript
// tests/e2e/api-mocking.spec.ts
import { test, expect } from "@playwright/test";

test.describe("API Mocking", () => {
  test("mock successful response", async ({ page }) => {
    await page.route("/api/users", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "1", name: "Mocked User", email: "mock@example.com" }]),
      });
    });

    await page.goto("/users");
    await expect(page.getByText("Mocked User")).toBeVisible();
  });

  test("mock error response", async ({ page }) => {
    await page.route("/api/users", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Server Error" }),
      });
    });

    await page.goto("/users");
    await expect(page.getByText("Error loading users")).toBeVisible();
  });

  test("delay response", async ({ page }) => {
    await page.route("/api/users", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.fulfill({
        status: 200,
        body: JSON.stringify([]),
      });
    });

    await page.goto("/users");
    await expect(page.getByTestId("loading-spinner")).toBeVisible();
  });
});
```

## Best Practices

1. **Use factories**: Generate realistic data
2. **Define scenarios**: Reusable mock configurations
3. **Test edge cases**: Errors, empty states, loading
4. **Keep handlers simple**: One responsibility each
5. **Match production API**: Same contracts
6. **Delay appropriately**: Realistic timing
7. **Document mocks**: API contracts
8. **Reset between tests**: Clean state

## Output Checklist

Every API mock setup should include:

- [ ] MSW/json-server configuration
- [ ] Handler definitions
- [ ] Test setup integration
- [ ] Fixture factories
- [ ] Error scenarios
- [ ] Loading states
- [ ] GraphQL support (if needed)
- [ ] Browser integration
- [ ] E2E test mocking
- [ ] Documentation
