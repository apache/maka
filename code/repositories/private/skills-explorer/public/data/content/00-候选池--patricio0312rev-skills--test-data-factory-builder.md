---
name: test-data-factory-builder
description: Creates factories and builders for generating consistent, composable test data with realistic values and relationship handling. Use for "test factories", "test data builders", "fixture factories", or "test data generation".
---

# Test Data Factory Builder

Create composable factories for consistent test data.

## Factory Pattern

```typescript
// factories/UserFactory.ts
import { faker } from "@faker-js/faker";

export class UserFactory {
  private data: Partial<User> = {};

  static create(overrides?: Partial<User>): User {
    return new UserFactory().with(overrides).build();
  }

  with(overrides: Partial<User>): this {
    this.data = { ...this.data, ...overrides };
    return this;
  }

  withEmail(email: string): this {
    this.data.email = email;
    return this;
  }

  withRole(role: UserRole): this {
    this.data.role = role;
    return this;
  }

  asAdmin(): this {
    this.data.role = "ADMIN";
    return this;
  }

  build(): User {
    return {
      id: this.data.id || faker.string.uuid(),
      email: this.data.email || faker.internet.email(),
      name: this.data.name || faker.person.fullName(),
      role: this.data.role || "USER",
      createdAt: this.data.createdAt || faker.date.past(),
      ...this.data,
    };
  }
}

// Usage
const user = UserFactory.create();
const admin = UserFactory.create().asAdmin().build();
const specific = UserFactory.create({ email: "test@example.com" });
```

## Builder Pattern

```typescript
// builders/OrderBuilder.ts
export class OrderBuilder {
  private user?: User;
  private items: OrderItem[] = [];
  private status: OrderStatus = "PENDING";

  forUser(user: User): this {
    this.user = user;
    return this;
  }

  withItem(product: Product, quantity: number = 1): this {
    this.items.push({
      id: faker.string.uuid(),
      productId: product.id,
      quantity,
      price: product.price,
    });
    return this;
  }

  withStatus(status: OrderStatus): this {
    this.status = status;
    return this;
  }

  asPaid(): this {
    this.status = "PAID";
    return this;
  }

  async build(): Promise<Order> {
    if (!this.user) {
      throw new Error("User is required");
    }

    const total = this.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    return {
      id: faker.string.uuid(),
      userId: this.user.id,
      items: this.items,
      total,
      status: this.status,
      createdAt: new Date(),
    };
  }
}

// Usage
const order = await new OrderBuilder()
  .forUser(user)
  .withItem(laptop, 2)
  .withItem(phone, 1)
  .asPaid()
  .build();
```

## Relationship Handling

```typescript
// factories/OrderFactory.ts
export class OrderFactory {
  static async createWithUser(overrides?: Partial<Order>): Promise<Order> {
    // Create user if not provided
    const user = UserFactory.create();

    // Create products
    const products = [
      ProductFactory.create({ price: 99.99 }),
      ProductFactory.create({ price: 199.99 }),
    ];

    // Create order with relationships
    return {
      id: faker.string.uuid(),
      userId: user.id,
      user,
      items: products.map((product) => ({
        id: faker.string.uuid(),
        productId: product.id,
        product,
        quantity: 1,
        price: product.price,
      })),
      total: products.reduce((sum, p) => sum + p.price, 0),
      status: "PENDING",
      createdAt: new Date(),
      ...overrides,
    };
  }
}
```

## Database Persistence

```typescript
// factories/UserFactory.ts with persistence
export class UserFactory {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(overrides?: Partial<User>): Promise<User> {
    const data = {
      email: faker.internet.email(),
      name: faker.person.fullName(),
      role: "USER",
      ...overrides,
    };

    return this.prisma.user.create({ data });
  }

  async createMany(count: number): Promise<User[]> {
    return Promise.all(Array.from({ length: count }, () => this.create()));
  }

  async createAdmin(): Promise<User> {
    return this.create({ role: "ADMIN" });
  }
}

// Usage in tests
test("should list users", async () => {
  const userFactory = new UserFactory(prisma);
  await userFactory.createMany(5);

  const users = await userService.list();
  expect(users).toHaveLength(5);
});
```

## Traits Pattern

```typescript
// factories/UserFactory.ts with traits
export class UserFactory {
  private traits: string[] = [];

  withTrait(trait: string): this {
    this.traits.push(trait);
    return this;
  }

  build(): User {
    let user: User = {
      id: faker.string.uuid(),
      email: faker.internet.email(),
      name: faker.person.fullName(),
      role: "USER",
      createdAt: new Date(),
    };

    // Apply traits
    if (this.traits.includes("verified")) {
      user.emailVerified = true;
      user.verifiedAt = new Date();
    }

    if (this.traits.includes("suspended")) {
      user.status = "SUSPENDED";
      user.suspendedAt = new Date();
    }

    if (this.traits.includes("premium")) {
      user.subscription = "PREMIUM";
      user.subscriptionExpiresAt = faker.date.future();
    }

    return user;
  }
}

// Usage
const verifiedUser = new UserFactory().withTrait("verified").build();

const suspendedPremiumUser = new UserFactory().withTrait("suspended").withTrait("premium").build();
```

## Sequence Generation

```typescript
// factories/sequence.ts
class Sequence {
  private counters = new Map<string, number>();

  next(key: string): number {
    const current = this.counters.get(key) || 0;
    const next = current + 1;
    this.counters.set(key, next);
    return next;
  }

  reset(key?: string): void {
    if (key) {
      this.counters.delete(key);
    } else {
      this.counters.clear();
    }
  }
}

const sequence = new Sequence();

// Usage in factory
export class UserFactory {
  build(): User {
    return {
      id: faker.string.uuid(),
      email: `user${sequence.next("user")}@example.com`,
      name: `Test User ${sequence.next("user")}`,
      // ...
    };
  }
}

// Creates: user1@example.com, user2@example.com, etc.
```

## Composable Factories

```typescript
// factories/index.ts
export const TestDataBuilder = {
  user: (overrides?: Partial<User>) => new UserFactory().with(overrides),
  product: (overrides?: Partial<Product>) => new ProductFactory().with(overrides),
  order: () => new OrderBuilder(),

  // Composite builders
  checkoutScenario: async () => {
    const user = TestDataBuilder.user().build();
    const products = [
      TestDataBuilder.product({ price: 99.99 }).build(),
      TestDataBuilder.product({ price: 199.99 }).build(),
    ];
    const order = await TestDataBuilder.order()
      .forUser(user)
      .withItem(products[0], 2)
      .withItem(products[1], 1)
      .build();

    return { user, products, order };
  },
};

// Usage
test("should process checkout", async () => {
  const { user, order } = await TestDataBuilder.checkoutScenario();

  const result = await checkoutService.process(order);
  expect(result.status).toBe("SUCCESS");
});
```

## Realistic Data Generators

```typescript
// generators/realistic.ts
import { faker } from "@faker-js/faker";

export const RealisticData = {
  creditCard: () => ({
    number: "4242424242424242", // Test card
    expiry: faker.date.future().toISOString().slice(0, 7), // YYYY-MM
    cvc: "123",
    name: faker.person.fullName(),
  }),

  address: () => ({
    street: faker.location.streetAddress(),
    city: faker.location.city(),
    state: faker.location.state(),
    zip: faker.location.zipCode(),
    country: "US",
  }),

  product: () => ({
    name: faker.commerce.productName(),
    description: faker.commerce.productDescription(),
    price: parseFloat(faker.commerce.price()),
    category: faker.commerce.department(),
    sku: faker.string.alphanumeric(10).toUpperCase(),
  }),

  email: {
    valid: () => faker.internet.email(),
    invalid: () => "invalid-email",
    disposable: () => `${faker.string.alphanumeric(8)}@tempmail.com`,
  },
};
```

## Factory Registry

```typescript
// factories/registry.ts
class FactoryRegistry {
  private factories = new Map();

  register<T>(name: string, factory: () => T): void {
    this.factories.set(name, factory);
  }

  create<T>(name: string, overrides?: Partial<T>): T {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Factory not found: ${name}`);
    }
    const instance = factory();
    return { ...instance, ...overrides };
  }
}

const registry = new FactoryRegistry();

// Register factories
registry.register("user", () => UserFactory.create());
registry.register("product", () => ProductFactory.create());

// Usage
const user = registry.create("user", { role: "ADMIN" });
```

## Test Helpers

```typescript
// helpers/test-data.ts
export async function seedTestDatabase(prisma: PrismaClient) {
  const userFactory = new UserFactory(prisma);
  const productFactory = new ProductFactory(prisma);

  // Create base data
  const users = await userFactory.createMany(10);
  const products = await productFactory.createMany(20);

  // Create relationships
  for (const user of users.slice(0, 5)) {
    await new OrderBuilder()
      .forUser(user)
      .withItem(products[0], 2)
      .withItem(products[1], 1)
      .asPaid()
      .build();
  }

  return { users, products };
}

// Usage
beforeEach(async () => {
  await seedTestDatabase(prisma);
});
```

## Best Practices

1. **Deterministic by default**: Use seeded faker
2. **Minimal data**: Only create what's needed
3. **Composable**: Combine factories
4. **Type-safe**: Full TypeScript support
5. **Relationships**: Easy to create related data
6. **Database-agnostic**: Works with or without DB
7. **Clear naming**: Descriptive factory methods

## Output Checklist

- [ ] Factory classes created
- [ ] Builder pattern implemented
- [ ] Relationship handling
- [ ] Database persistence option
- [ ] Traits for variations
- [ ] Sequence generation
- [ ] Composable builders
- [ ] Realistic data generators
- [ ] Factory registry (optional)
- [ ] Test helpers created
