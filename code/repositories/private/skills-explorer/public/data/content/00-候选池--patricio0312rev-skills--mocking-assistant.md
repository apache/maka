---
name: mocking-assistant
description: Creates stable mocks for APIs, services, and UI components using MSW (Mock Service Worker), fixture conventions, and example patterns. Use for "API mocking", "MSW", "test mocks", or "service mocking".
---

# Mocking Assistant

Create reliable mocks for APIs and services in tests.

## MSW API Mocking

```typescript
// mocks/handlers.ts
import { http, HttpResponse } from "msw";

export const handlers = [
  // GET endpoint
  http.get("/api/users/:id", ({ params }) => {
    const { id } = params;

    return HttpResponse.json({
      id,
      name: "John Doe",
      email: "john@example.com",
    });
  }),

  // POST endpoint
  http.post("/api/users", async ({ request }) => {
    const body = await request.json();

    return HttpResponse.json(
      {
        id: Math.random().toString(),
        ...body,
        createdAt: new Date().toISOString(),
      },
      { status: 201 },
    );
  }),

  // Error response
  http.get("/api/products/:id", ({ params }) => {
    const { id } = params;

    if (id === "404") {
      return HttpResponse.json({ error: "Product not found" }, { status: 404 });
    }

    return HttpResponse.json({
      id,
      name: "MacBook Pro",
      price: 2499.99,
    });
  }),

  // Delayed response
  http.get("/api/slow-endpoint", async () => {
    await delay(2000);
    return HttpResponse.json({ data: "Slow response" });
  }),
];
```

## MSW Setup

```typescript
// mocks/server.ts
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);

// tests/setup.ts
import { beforeAll, afterEach, afterAll } from "vitest";
import { server } from "../mocks/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

## Fixture Conventions

```typescript
// mocks/fixtures/users.ts
export const userFixtures = {
  admin: {
    id: "1",
    email: "admin@example.com",
    name: "Admin User",
    role: "ADMIN",
  },
  customer: {
    id: "2",
    email: "customer@example.com",
    name: "Customer User",
    role: "USER",
  },
  guest: {
    id: "3",
    email: "guest@example.com",
    name: "Guest User",
    role: "GUEST",
  },
};

// mocks/fixtures/products.ts
export const productFixtures = {
  laptop: {
    id: "100",
    name: "MacBook Pro",
    price: 2499.99,
    stock: 10,
    category: "Electronics",
  },
  phone: {
    id: "101",
    name: "iPhone 15",
    price: 999.99,
    stock: 50,
    category: "Electronics",
  },
  outOfStock: {
    id: "102",
    name: "Sold Out Item",
    price: 499.99,
    stock: 0,
    category: "Electronics",
  },
};

// Usage in handlers
http.get("/api/users/:id", ({ params }) => {
  const user = Object.values(userFixtures).find((u) => u.id === params.id);

  if (!user) {
    return HttpResponse.json({ error: "User not found" }, { status: 404 });
  }

  return HttpResponse.json(user);
});
```

## Test-Specific Mocks

```typescript
// tests/components/UserProfile.test.tsx
import { server } from "../mocks/server";
import { http, HttpResponse } from "msw";

test("should display user profile", async () => {
  // Override handler for this test
  server.use(
    http.get("/api/users/123", () => {
      return HttpResponse.json({
        id: "123",
        name: "Test User",
        email: "test@example.com",
      });
    })
  );

  render(<UserProfile userId="123" />);

  await waitFor(() => {
    expect(screen.getByText("Test User")).toBeInTheDocument();
  });
});

test("should handle API error", async () => {
  // Mock error response
  server.use(
    http.get("/api/users/123", () => {
      return HttpResponse.json({ error: "Server error" }, { status: 500 });
    })
  );

  render(<UserProfile userId="123" />);

  await waitFor(() => {
    expect(screen.getByText("Failed to load user")).toBeInTheDocument();
  });
});
```

## Service Mocking

```typescript
// src/services/paymentService.ts
export interface PaymentService {
  processPayment(amount: number, cardToken: string): Promise<PaymentResult>;
  refund(transactionId: string): Promise<void>;
}

// mocks/services/mockPaymentService.ts
export class MockPaymentService implements PaymentService {
  async processPayment(amount: number, cardToken: string): Promise<PaymentResult> {
    // Simulate successful payment
    if (cardToken.startsWith("tok_success")) {
      return {
        transactionId: "txn_" + Math.random().toString(36),
        status: "success",
        amount,
      };
    }

    // Simulate failed payment
    if (cardToken.startsWith("tok_fail")) {
      throw new Error("Payment failed");
    }

    // Simulate slow payment
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return {
      transactionId: "txn_" + Math.random().toString(36),
      status: "success",
      amount,
    };
  }

  async refund(transactionId: string): Promise<void> {
    // Mock refund
    console.log(`Refunding transaction: ${transactionId}`);
  }
}

// tests/checkout.test.ts
const mockPaymentService = new MockPaymentService();

test("should process payment successfully", async () => {
  const result = await mockPaymentService.processPayment(100, "tok_success_123");

  expect(result.status).toBe("success");
  expect(result.transactionId).toBeDefined();
});
```

## Function Mocking with Vitest

```typescript
// src/utils/analytics.ts
export const trackEvent = (event: string, data: any) => {
  // Send to analytics service
};

// tests/component.test.ts
import { vi } from "vitest";
import * as analytics from "@/utils/analytics";

test("should track button click", () => {
  // Mock function
  const trackEventSpy = vi.spyOn(analytics, "trackEvent");

  render(<Button onClick={handleClick} />);
  fireEvent.click(screen.getByRole("button"));

  expect(trackEventSpy).toHaveBeenCalledWith("button_click", {
    buttonId: "submit",
  });
});
```

## Date/Time Mocking

```typescript
// tests/date-sensitive.test.ts
import { vi } from "vitest";

test("should show correct greeting based on time", () => {
  // Mock date to morning
  vi.setSystemTime(new Date("2024-01-01 09:00:00"));

  render(<Greeting />);
  expect(screen.getByText("Good morning!")).toBeInTheDocument();

  // Mock date to evening
  vi.setSystemTime(new Date("2024-01-01 19:00:00"));

  render(<Greeting />);
  expect(screen.getByText("Good evening!")).toBeInTheDocument();

  // Restore real time
  vi.useRealTimers();
});
```

## Module Mocking

```typescript
// src/lib/database.ts
export const db = {
  user: {
    findById: (id: string) => {
      // Real database query
    },
  },
};

// tests/mocks/database.ts
export const mockDb = {
  user: {
    findById: vi.fn((id: string) => ({
      id,
      name: "Mock User",
      email: "mock@example.com",
    })),
  },
};

// tests/userService.test.ts
vi.mock("@/lib/database", () => ({
  db: mockDb,
}));

test("should fetch user from database", async () => {
  const user = await userService.getUser("123");

  expect(mockDb.user.findById).toHaveBeenCalledWith("123");
  expect(user.name).toBe("Mock User");
});
```

## GraphQL Mocking

```typescript
// mocks/graphql-handlers.ts
import { graphql, HttpResponse } from "msw";

export const graphqlHandlers = [
  graphql.query("GetUser", ({ variables }) => {
    return HttpResponse.json({
      data: {
        user: {
          id: variables.id,
          name: "John Doe",
          email: "john@example.com",
        },
      },
    });
  }),

  graphql.mutation("CreateUser", ({ variables }) => {
    return HttpResponse.json({
      data: {
        createUser: {
          id: Math.random().toString(),
          ...variables.input,
        },
      },
    });
  }),
];
```

## Best Practices

1. **Use MSW for HTTP**: More realistic than mocking fetch
2. **Centralize fixtures**: Single source of truth
3. **Test-specific overrides**: Override defaults per test
4. **Mock at boundaries**: Services, APIs, not internals
5. **Realistic data**: Fixtures should match production
6. **Error scenarios**: Test failure cases
7. **Timing control**: Mock delays for loading states

## Output Checklist

- [ ] MSW handlers created
- [ ] Fixture conventions established
- [ ] Common fixtures defined
- [ ] Test-specific mock overrides
- [ ] Service mocks implemented
- [ ] Function spies used appropriately
- [ ] Date/time mocking when needed
- [ ] Error scenarios mocked
- [ ] GraphQL mocks (if applicable)
- [ ] Documentation for mock usage
