---
name: service-layer-extractor
description: Refactors route handlers into service layer with clean boundaries, dependency injection, testability, and separation of concerns. Provides service interfaces, folder structure, testing strategy, and migration plan. Use when refactoring "fat controllers", "business logic", "service layer", or "architecture cleanup".
---

# Service Layer Extractor

Extract business logic from controllers into a testable service layer.

## Architecture Layers

```
routes/          → Define endpoints, parse requests
controllers/     → Validate input, call services, format responses
services/        → Business logic, orchestration
repositories/    → Database queries
models/          → Data structures
```

## Before: Fat Controller

```typescript
// ❌ Business logic mixed with HTTP concerns
router.post("/users", async (req, res) => {
  try {
    // Validation
    if (!req.body.email) {
      return res.status(400).json({ error: "Email required" });
    }

    // Check duplicate
    const existing = await db.query("SELECT * FROM users WHERE email = $1", [req.body.email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(req.body.password, 10);

    // Create user
    const result = await db.query(
      "INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING *",
      [req.body.email, hashedPassword, req.body.name],
    );

    // Send welcome email
    await sendEmail(req.body.email, "Welcome!", "Thanks for joining");

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

## After: Service Layer

```typescript
// ✅ Separated concerns

// services/user.service.ts
export class UserService {
  constructor(
    private userRepository: UserRepository,
    private emailService: EmailService,
  ) {}

  async createUser(dto: CreateUserDto): Promise<User> {
    // Business logic only
    const existing = await this.userRepository.findByEmail(dto.email);
    if (existing) {
      throw new ConflictError("Email already exists");
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = await this.userRepository.create({
      ...dto,
      password: hashedPassword,
    });

    await this.emailService.sendWelcome(user.email);

    return user;
  }
}

// controllers/user.controller.ts
export class UserController {
  constructor(private userService: UserService) {}

  create = asyncHandler(async (req, res) => {
    const user = await this.userService.createUser(req.body);
    res.status(201).json({ success: true, data: user });
  });
}

// repositories/user.repository.ts
export class UserRepository {
  async create(data: CreateUserData): Promise<User> {
    const result = await db.query(
      "INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING *",
      [data.email, data.password, data.name],
    );
    return result.rows[0];
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    return result.rows[0] || null;
  }
}
```

## Dependency Injection

```typescript
// container.ts (using tsyringe or manual)
import { UserService } from "./services/user.service";
import { UserRepository } from "./repositories/user.repository";
import { EmailService } from "./services/email.service";

export class Container {
  private static instances = new Map();

  static get<T>(constructor: new (...args: any[]) => T): T {
    if (!this.instances.has(constructor)) {
      // Create dependencies
      const deps = this.resolveDependencies(constructor);
      this.instances.set(constructor, new constructor(...deps));
    }
    return this.instances.get(constructor);
  }

  private static resolveDependencies(constructor: any): any[] {
    // Resolve constructor dependencies
    return [];
  }
}

// Usage
const userService = Container.get(UserService);
```

## Testing Services

```typescript
// user.service.test.ts
describe("UserService", () => {
  let service: UserService;
  let mockRepository: jest.Mocked<UserRepository>;
  let mockEmailService: jest.Mocked<EmailService>;

  beforeEach(() => {
    mockRepository = {
      create: jest.fn(),
      findByEmail: jest.fn(),
    } as any;

    mockEmailService = {
      sendWelcome: jest.fn(),
    } as any;

    service = new UserService(mockRepository, mockEmailService);
  });

  it("creates user successfully", async () => {
    mockRepository.findByEmail.mockResolvedValue(null);
    mockRepository.create.mockResolvedValue({
      id: "1",
      email: "test@example.com",
    });

    const user = await service.createUser({
      email: "test@example.com",
      password: "password123",
      name: "Test User",
    });

    expect(user.id).toBe("1");
    expect(mockEmailService.sendWelcome).toHaveBeenCalled();
  });

  it("throws error if email exists", async () => {
    mockRepository.findByEmail.mockResolvedValue({ id: "1" } as User);

    await expect(
      service.createUser({
        email: "existing@example.com",
        password: "pass",
        name: "Test",
      }),
    ).rejects.toThrow(ConflictError);
  });
});
```

## Folder Structure

```
src/
├── routes/
│   └── users.routes.ts
├── controllers/
│   └── user.controller.ts
├── services/
│   ├── user.service.ts
│   ├── email.service.ts
│   └── payment.service.ts
├── repositories/
│   └── user.repository.ts
├── models/
│   └── user.model.ts
├── types/
│   └── user.types.ts
└── middleware/
    └── validate.ts
```

## Migration Strategy

```markdown
## Phase 1: Create Service Layer (Week 1-2)

- [ ] Create service classes
- [ ] Move business logic to services
- [ ] Keep controllers thin
- [ ] No breaking changes

## Phase 2: Add Tests (Week 3-4)

- [ ] Write service unit tests
- [ ] Mock dependencies
- [ ] Achieve 80%+ coverage

## Phase 3: Extract Repositories (Week 5-6)

- [ ] Create repository layer
- [ ] Move DB queries from services
- [ ] Services depend on repositories

## Phase 4: Dependency Injection (Week 7-8)

- [ ] Set up DI container
- [ ] Remove manual instantiation
- [ ] Wire up dependencies
```

## Benefits

- **Testability**: Services testable without HTTP
- **Reusability**: Logic reused across endpoints
- **Separation**: Clear boundaries between layers
- **Maintainability**: Easier to locate and modify logic

## Output Checklist

- [ ] Service classes created
- [ ] Business logic extracted from controllers
- [ ] Repository layer for data access
- [ ] Dependency injection setup
- [ ] Unit tests for services
- [ ] Folder structure reorganized
- [ ] Migration plan documented
- [ ] Team trained on new patterns
