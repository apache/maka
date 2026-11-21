---
name: data-seeding-fixtures-builder
description: Generates deterministic seed data for development and testing with factory functions, realistic fixtures, and database reset scripts. Use for "data seeding", "test fixtures", "database seeding", or "mock data generation".
---

# Data Seeding & Fixtures Builder

Generate realistic, deterministic seed data for development and testing.

## Seed Data Strategy

```typescript
// prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import { faker } from "@faker-js/faker";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // Clear existing data
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();

  // Seed users
  const users = await seedUsers(10);
  console.log(`✅ Created ${users.length} users`);

  // Seed orders
  const orders = await seedOrders(users, 50);
  console.log(`✅ Created ${orders.length} orders`);

  console.log("✅ Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

## Factory Functions

```typescript
// factories/user.factory.ts
import { faker } from "@faker-js/faker";
import { PrismaClient, User } from "@prisma/client";

const prisma = new PrismaClient();

export interface UserFactoryOptions {
  email?: string;
  name?: string;
  role?: "USER" | "ADMIN";
}

export class UserFactory {
  static async create(options: UserFactoryOptions = {}): Promise<User> {
    return prisma.user.create({
      data: {
        email: options.email || faker.internet.email(),
        name: options.name || faker.person.fullName(),
        role: options.role || "USER",
        createdAt: faker.date.past(),
      },
    });
  }

  static async createMany(count: number, options: UserFactoryOptions = {}): Promise<User[]> {
    return Promise.all(Array.from({ length: count }, () => this.create(options)));
  }

  static async createAdmin(): Promise<User> {
    return this.create({ role: "ADMIN" });
  }
}

// Usage:
// const user = await UserFactory.create();
// const admin = await UserFactory.createAdmin();
// const users = await UserFactory.createMany(10);
```

## Realistic Fixtures

```typescript
// fixtures/products.ts
import { Product } from "@prisma/client";

export const PRODUCT_FIXTURES: Omit<Product, "id" | "createdAt" | "updatedAt">[] = [
  {
    name: 'MacBook Pro 16"',
    description: "Powerful laptop for developers",
    price: 2499.99,
    stock: 50,
    category: "Electronics",
  },
  {
    name: "iPhone 15 Pro",
    description: "Latest flagship smartphone",
    price: 999.99,
    stock: 100,
    category: "Electronics",
  },
  {
    name: "AirPods Pro",
    description: "Wireless earbuds with noise cancellation",
    price: 249.99,
    stock: 200,
    category: "Electronics",
  },
];

// Seed products
async function seedProducts() {
  return Promise.all(PRODUCT_FIXTURES.map((product) => prisma.product.create({ data: product })));
}
```

## Deterministic Seeding

```typescript
// Use fixed seed for reproducibility
import { faker } from "@faker-js/faker";

// Set seed for deterministic data
faker.seed(12345);

// Same data every time
const user1 = {
  email: faker.internet.email(), // Always same email
  name: faker.person.fullName(), // Always same name
};

// Reset for different test
faker.seed(67890);
```

## Relationship Building

```typescript
// factories/order.factory.ts
export class OrderFactory {
  static async create(userId: number): Promise<Order> {
    const products = await prisma.product.findMany({ take: 3 });

    const order = await prisma.order.create({
      data: {
        userId,
        status: faker.helpers.arrayElement(["pending", "paid", "shipped"]),
        total: faker.number.float({ min: 10, max: 1000, precision: 0.01 }),
      },
    });

    // Create order items
    await Promise.all(
      products.map((product) =>
        prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            quantity: faker.number.int({ min: 1, max: 5 }),
            price: product.price,
          },
        }),
      ),
    );

    return order;
  }

  static async createForUser(user: User, count: number): Promise<Order[]> {
    return Promise.all(Array.from({ length: count }, () => this.create(user.id)));
  }
}
```

## Environment-Specific Seeds

```typescript
// seeds/development.ts
export async function seedDevelopment() {
  // Development: Few records, easy to debug
  const users = await UserFactory.createMany(5);
  const products = await ProductFactory.createMany(10);

  for (const user of users) {
    await OrderFactory.createForUser(user, 2);
  }
}

// seeds/staging.ts
export async function seedStaging() {
  // Staging: Moderate data, realistic scenarios
  const users = await UserFactory.createMany(50);
  const products = await ProductFactory.createMany(100);

  for (const user of users) {
    await OrderFactory.createForUser(user, faker.number.int({ min: 1, max: 10 }));
  }
}

// seeds/testing.ts
export async function seedTesting() {
  // Testing: Minimal, predictable data
  faker.seed(12345); // Deterministic

  const user = await UserFactory.create({
    email: "test@example.com",
    name: "Test User",
  });

  const product = await ProductFactory.create({
    name: "Test Product",
    price: 99.99,
  });

  return { user, product };
}

// Main seed file
async function main() {
  const env = process.env.NODE_ENV;

  if (env === "development") {
    await seedDevelopment();
  } else if (env === "staging") {
    await seedStaging();
  } else if (env === "test") {
    await seedTesting();
  }
}
```

## Database Reset Script

```typescript
// scripts/reset-db.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function resetDatabase() {
  console.log("🗑️  Resetting database...");

  // Disable foreign key checks (PostgreSQL)
  await prisma.$executeRaw`SET session_replication_role = 'replica';`;

  // Get all tables
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public';
  `;

  // Truncate all tables
  for (const { tablename } of tables) {
    if (tablename !== "_prisma_migrations") {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${tablename}" CASCADE;`);
      console.log(`  Truncated ${tablename}`);
    }
  }

  // Re-enable foreign key checks
  await prisma.$executeRaw`SET session_replication_role = 'origin';`;

  console.log("✅ Database reset complete");
}

resetDatabase()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

## Test Fixtures for E2E Tests

```typescript
// tests/fixtures/e2e.fixture.ts
import { test as base } from "@playwright/test";
import { UserFactory, ProductFactory } from "../factories";

type Fixtures = {
  authenticatedUser: User;
  products: Product[];
};

export const test = base.extend<Fixtures>({
  authenticatedUser: async ({ page }, use) => {
    // Create user
    const user = await UserFactory.create();

    // Login
    await page.goto("/login");
    await page.fill('[name="email"]', user.email);
    await page.fill('[name="password"]', "password123");
    await page.click('button[type="submit"]');

    await use(user);

    // Cleanup
    await prisma.user.delete({ where: { id: user.id } });
  },

  products: async ({}, use) => {
    const products = await ProductFactory.createMany(5);
    await use(products);

    // Cleanup
    await prisma.product.deleteMany({
      where: { id: { in: products.map((p) => p.id) } },
    });
  },
});

// Usage:
test("should add product to cart", async ({ authenticatedUser, products }) => {
  // Test with pre-seeded data
});
```

## Package.json Scripts

```json
{
  "scripts": {
    "db:seed": "tsx prisma/seed.ts",
    "db:seed:dev": "NODE_ENV=development tsx prisma/seed.ts",
    "db:seed:staging": "NODE_ENV=staging tsx prisma/seed.ts",
    "db:reset": "tsx scripts/reset-db.ts && npm run db:seed",
    "db:reset:test": "tsx scripts/reset-db.ts && NODE_ENV=test tsx prisma/seed.ts"
  }
}
```

## Best Practices

1. **Use factories**: Reusable data generation
2. **Deterministic in tests**: Fixed seed values
3. **Realistic fixtures**: Production-like data
4. **Environment-specific**: Different needs per environment
5. **Cleanup after tests**: Avoid pollution
6. **Relationship integrity**: Proper foreign keys
7. **Performance**: Batch inserts for large datasets

## Output Checklist

- [ ] Seed script created
- [ ] Factory functions for each model
- [ ] Realistic fixtures defined
- [ ] Deterministic seeding (tests)
- [ ] Relationship building logic
- [ ] Environment-specific seeds
- [ ] Database reset script
- [ ] E2E test fixtures
