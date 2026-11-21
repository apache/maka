---
name: integration-test-builder
description: Creates integration tests for API endpoints with database flows, including test harness setup, fixtures, setup/teardown, database seeding, and CI-friendly strategies. Use for "integration testing", "API tests", "database tests", or "test harness".
---

# Integration Test Builder

Build comprehensive integration tests for APIs and database flows.

## Test Harness Setup

```typescript
// tests/setup/test-harness.ts
import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";

export class TestHarness {
  prisma: PrismaClient;

  async setup() {
    // Setup test database
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

    // Run migrations
    execSync("npx prisma migrate deploy");

    // Initialize Prisma client
    this.prisma = new PrismaClient();

    // Clear all data
    await this.clearDatabase();
  }

  async teardown() {
    await this.prisma.$disconnect();
  }

  async clearDatabase() {
    const tables = await this.prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;

    for (const { tablename } of tables) {
      if (tablename !== "_prisma_migrations") {
        await this.prisma.$executeRawUnsafe(`TRUNCATE TABLE "${tablename}" CASCADE`);
      }
    }
  }

  async seedFixtures() {
    // Seed test data
    await this.prisma.user.create({
      data: {
        email: "test@example.com",
        name: "Test User",
      },
    });
  }
}
```

## API Integration Tests

```typescript
// tests/api/users.test.ts
import request from "supertest";
import { app } from "@/app";
import { TestHarness } from "../setup/test-harness";

describe("User API", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = new TestHarness();
    await harness.setup();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(async () => {
    await harness.clearDatabase();
    await harness.seedFixtures();
  });

  describe("POST /api/users", () => {
    it("should create new user", async () => {
      // Arrange
      const userData = {
        email: "new@example.com",
        name: "New User",
      };

      // Act
      const response = await request(app).post("/api/users").send(userData).expect(201);

      // Assert
      expect(response.body).toMatchObject({
        email: userData.email,
        name: userData.name,
      });
      expect(response.body.id).toBeDefined();

      // Verify in database
      const user = await harness.prisma.user.findUnique({
        where: { email: userData.email },
      });
      expect(user).toBeDefined();
      expect(user!.name).toBe(userData.name);
    });

    it("should return 400 for invalid email", async () => {
      // Arrange
      const userData = {
        email: "invalid-email",
        name: "Test User",
      };

      // Act
      const response = await request(app).post("/api/users").send(userData).expect(400);

      // Assert
      expect(response.body.error).toContain("Invalid email");
    });

    it("should return 409 for duplicate email", async () => {
      // Arrange
      const userData = {
        email: "test@example.com", // Already exists
        name: "Duplicate User",
      };

      // Act
      const response = await request(app).post("/api/users").send(userData).expect(409);

      // Assert
      expect(response.body.error).toContain("already exists");
    });
  });

  describe("GET /api/users/:id", () => {
    it("should get user by id", async () => {
      // Arrange
      const user = await harness.prisma.user.findFirst();

      // Act
      const response = await request(app).get(`/api/users/${user!.id}`).expect(200);

      // Assert
      expect(response.body).toMatchObject({
        id: user!.id,
        email: user!.email,
        name: user!.name,
      });
    });

    it("should return 404 for non-existent user", async () => {
      // Act
      const response = await request(app).get("/api/users/99999").expect(404);

      // Assert
      expect(response.body.error).toContain("not found");
    });
  });

  describe("PUT /api/users/:id", () => {
    it("should update user", async () => {
      // Arrange
      const user = await harness.prisma.user.findFirst();
      const updates = { name: "Updated Name" };

      // Act
      const response = await request(app).put(`/api/users/${user!.id}`).send(updates).expect(200);

      // Assert
      expect(response.body.name).toBe("Updated Name");

      // Verify in database
      const updatedUser = await harness.prisma.user.findUnique({
        where: { id: user!.id },
      });
      expect(updatedUser!.name).toBe("Updated Name");
    });
  });

  describe("DELETE /api/users/:id", () => {
    it("should delete user", async () => {
      // Arrange
      const user = await harness.prisma.user.findFirst();

      // Act
      await request(app).delete(`/api/users/${user!.id}`).expect(204);

      // Assert - verify deletion in database
      const deletedUser = await harness.prisma.user.findUnique({
        where: { id: user!.id },
      });
      expect(deletedUser).toBeNull();
    });
  });
});
```

## Database Transaction Tests

```typescript
// tests/integration/order-flow.test.ts
describe("Order Flow", () => {
  it("should create order with items in transaction", async () => {
    // Arrange
    const user = await harness.prisma.user.findFirst();
    const product = await harness.prisma.product.create({
      data: {
        name: "Test Product",
        price: 99.99,
        stock: 10,
      },
    });

    const orderData = {
      userId: user!.id,
      items: [
        {
          productId: product.id,
          quantity: 2,
          price: product.price,
        },
      ],
    };

    // Act
    const response = await request(app).post("/api/orders").send(orderData).expect(201);

    // Assert
    const order = await harness.prisma.order.findUnique({
      where: { id: response.body.id },
      include: { items: true },
    });

    expect(order).toBeDefined();
    expect(order!.items).toHaveLength(1);
    expect(order!.items[0].quantity).toBe(2);

    // Verify stock was decremented
    const updatedProduct = await harness.prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(updatedProduct!.stock).toBe(8); // 10 - 2
  });

  it("should rollback transaction if order creation fails", async () => {
    // Arrange
    const user = await harness.prisma.user.findFirst();
    const product = await harness.prisma.product.create({
      data: {
        name: "Test Product",
        price: 99.99,
        stock: 1, // Only 1 in stock
      },
    });

    const orderData = {
      userId: user!.id,
      items: [
        {
          productId: product.id,
          quantity: 10, // Requesting more than available
          price: product.price,
        },
      ],
    };

    // Act
    await request(app).post("/api/orders").send(orderData).expect(400);

    // Assert - verify rollback
    const orders = await harness.prisma.order.findMany();
    expect(orders).toHaveLength(0);

    // Verify stock unchanged
    const unchangedProduct = await harness.prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(unchangedProduct!.stock).toBe(1);
  });
});
```

## Authentication Tests

```typescript
// tests/integration/auth.test.ts
describe("Authentication", () => {
  describe("POST /api/auth/login", () => {
    it("should login with valid credentials", async () => {
      // Arrange
      await harness.prisma.user.create({
        data: {
          email: "auth@example.com",
          password: await hash("password123"),
        },
      });

      // Act
      const response = await request(app)
        .post("/api/auth/login")
        .send({
          email: "auth@example.com",
          password: "password123",
        })
        .expect(200);

      // Assert
      expect(response.body.token).toBeDefined();
      expect(response.body.user.email).toBe("auth@example.com");
    });

    it("should reject invalid password", async () => {
      // Act
      const response = await request(app)
        .post("/api/auth/login")
        .send({
          email: "test@example.com",
          password: "wrong-password",
        })
        .expect(401);

      // Assert
      expect(response.body.error).toContain("Invalid credentials");
    });
  });

  describe("Protected routes", () => {
    let authToken: string;

    beforeEach(async () => {
      // Login to get token
      const response = await request(app).post("/api/auth/login").send({
        email: "test@example.com",
        password: "password123",
      });

      authToken = response.body.token;
    });

    it("should access protected route with valid token", async () => {
      await request(app)
        .get("/api/profile")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);
    });

    it("should reject request without token", async () => {
      await request(app).get("/api/profile").expect(401);
    });

    it("should reject request with invalid token", async () => {
      await request(app)
        .get("/api/profile")
        .set("Authorization", "Bearer invalid-token")
        .expect(401);
    });
  });
});
```

## Fixtures Management

```typescript
// tests/fixtures/users.ts
export const userFixtures = {
  admin: {
    email: "admin@example.com",
    name: "Admin User",
    role: "ADMIN",
  },
  regularUser: {
    email: "user@example.com",
    name: "Regular User",
    role: "USER",
  },
  testUser: {
    email: "test@example.com",
    name: "Test User",
    role: "USER",
  },
};

// tests/fixtures/products.ts
export const productFixtures = {
  laptop: {
    name: "MacBook Pro",
    price: 2499.99,
    stock: 10,
    category: "Electronics",
  },
  phone: {
    name: "iPhone 15",
    price: 999.99,
    stock: 50,
    category: "Electronics",
  },
};

// Usage in tests
await harness.prisma.user.create({
  data: userFixtures.admin,
});
```

## CI-Friendly Strategy

```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests

on: [push, pull_request]

services:
  postgres:
    image: postgres:15
    env:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: test_db
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - run: npm ci

      - name: Run migrations
        run: npx prisma migrate deploy
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test_db

      - name: Run integration tests
        run: npm run test:integration
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test_db
```

## Parallel Test Execution

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false, // Run tests in parallel
      },
    },
    isolate: true, // Isolate each test file
    setupFiles: ["./tests/setup/global-setup.ts"],
  },
});

// Ensure each test file uses separate database
const TEST_DB_PREFIX = "test_db_";

function getDatabaseUrl(): string {
  const workerId = process.env.VITEST_WORKER_ID || "1";
  return `postgresql://test:test@localhost:5432/${TEST_DB_PREFIX}${workerId}`;
}
```

## Best Practices

1. **Isolated tests**: Each test can run independently
2. **Clean state**: Clear database between tests
3. **Fast fixtures**: Minimal data seeding
4. **Transactions**: Test rollbacks explicitly
5. **Real database**: Don't mock database in integration tests
6. **CI-ready**: Use Docker containers
7. **Parallel execution**: Independent test databases

## Output Checklist

- [ ] Test harness created
- [ ] Database setup/teardown
- [ ] Fixture management
- [ ] API endpoint tests
- [ ] Database transaction tests
- [ ] Authentication tests
- [ ] Error case coverage
- [ ] CI workflow configured
- [ ] Parallel execution support
- [ ] Clear test naming
