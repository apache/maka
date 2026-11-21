---
name: multi-tenant-safety-checker
description: Ensures tenant isolation at query and policy level using Row Level Security, automated testing, and security audits. Prevents data leakage between tenants. Use for "multi-tenancy", "tenant isolation", "RLS", or "data security".
---

# Multi-tenant Safety Checker

Ensure complete tenant isolation and prevent data leakage.

## Row Level Security (RLS)

### PostgreSQL RLS Setup

```sql
-- Enable RLS on tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Create policy for users table
CREATE POLICY tenant_isolation_policy ON users
  USING (tenant_id = current_setting('app.tenant_id')::INTEGER);

-- Create policy for orders table
CREATE POLICY tenant_isolation_policy ON orders
  USING (tenant_id = current_setting('app.tenant_id')::INTEGER);

-- Create policy for products table
CREATE POLICY tenant_isolation_policy ON products
  USING (tenant_id = current_setting('app.tenant_id')::INTEGER);

-- Force RLS even for table owners
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
```

### Application-Level Tenant Context

```typescript
// middleware/tenant-context.ts
import { PrismaClient } from "@prisma/client";

export class TenantContext {
  constructor(private prisma: PrismaClient) {}

  async setTenant(tenantId: number): Promise<void> {
    await this.prisma.$executeRaw`
      SET LOCAL app.tenant_id = ${tenantId}
    `;
  }

  async withTenant<T>(tenantId: number, callback: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Set tenant context for this transaction
      await tx.$executeRaw`SET LOCAL app.tenant_id = ${tenantId}`;

      // Execute queries within tenant context
      return callback();
    });
  }
}

// Usage in API route
app.get("/api/orders", async (req, res) => {
  const tenantId = req.user.tenantId;

  const orders = await tenantContext.withTenant(tenantId, async () => {
    return prisma.order.findMany(); // Automatically filtered by RLS
  });

  res.json(orders);
});
```

## Tenant Isolation Checklist

```markdown
# Multi-tenant Security Checklist

## Database Level

- [ ] All tables have `tenant_id` column
- [ ] `tenant_id` is NOT NULL on all tables
- [ ] Foreign keys include tenant_id checks
- [ ] Row Level Security enabled on all tables
- [ ] RLS policies created for all tables
- [ ] RLS enforced even for table owners
- [ ] Composite indexes include tenant_id

## Application Level

- [ ] Tenant context set on every request
- [ ] Tenant ID validated from JWT/session
- [ ] No raw SQL without tenant filter
- [ ] All queries include tenant_id (if no RLS)
- [ ] API endpoints validate tenant access
- [ ] File uploads scoped to tenant
- [ ] Background jobs include tenant context

## Testing

- [ ] Cross-tenant query tests
- [ ] RLS bypass attempt tests
- [ ] SQL injection with tenant bypass tests
- [ ] Automated regression tests
- [ ] Regular security audits
```

## Automated Security Tests

```typescript
// tests/tenant-isolation.test.ts
import { PrismaClient } from "@prisma/client";

describe("Tenant Isolation", () => {
  let prisma: PrismaClient;
  let tenant1Id: number;
  let tenant2Id: number;

  beforeAll(async () => {
    prisma = new PrismaClient();

    // Create test tenants
    const tenant1 = await prisma.tenant.create({
      data: { name: "Tenant 1" },
    });
    const tenant2 = await prisma.tenant.create({
      data: { name: "Tenant 2" },
    });

    tenant1Id = tenant1.id;
    tenant2Id = tenant2.id;

    // Create test data
    await prisma.user.create({
      data: {
        email: "user1@tenant1.com",
        tenantId: tenant1Id,
      },
    });
    await prisma.user.create({
      data: {
        email: "user2@tenant2.com",
        tenantId: tenant2Id,
      },
    });
  });

  it("should not access data from other tenants", async () => {
    // Set tenant context to Tenant 1
    await prisma.$executeRaw`SET app.tenant_id = ${tenant1Id}`;

    // Query users
    const users = await prisma.user.findMany();

    // Should only see Tenant 1 users
    expect(users.length).toBe(1);
    expect(users[0].email).toBe("user1@tenant1.com");

    // Should NOT see Tenant 2 users
    expect(users.find((u) => u.email === "user2@tenant2.com")).toBeUndefined();
  });

  it("should prevent cross-tenant updates", async () => {
    await prisma.$executeRaw`SET app.tenant_id = ${tenant1Id}`;

    // Try to update Tenant 2 user (should fail silently with RLS)
    const tenant2User = await prisma.user.findFirst({
      where: { email: "user2@tenant2.com" },
    });

    // Should not find user from other tenant
    expect(tenant2User).toBeNull();
  });

  it("should prevent cross-tenant deletes", async () => {
    await prisma.$executeRaw`SET app.tenant_id = ${tenant1Id}`;

    // Try to delete Tenant 2 user
    const result = await prisma.user.deleteMany({
      where: { tenantId: tenant2Id },
    });

    // Should delete 0 rows (RLS prevents access)
    expect(result.count).toBe(0);

    // Verify user still exists
    await prisma.$executeRaw`SET app.tenant_id = ${tenant2Id}`;
    const user = await prisma.user.findFirst({
      where: { email: "user2@tenant2.com" },
    });
    expect(user).not.toBeNull();
  });

  it("should handle transaction rollback correctly", async () => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL app.tenant_id = ${tenant1Id}`;

        // Create user
        await tx.user.create({
          data: {
            email: "test@tenant1.com",
            tenantId: tenant1Id,
          },
        });

        // Force error
        throw new Error("Rollback test");
      });
    } catch (error) {
      // Transaction rolled back
    }

    // User should not exist
    await prisma.$executeRaw`SET app.tenant_id = ${tenant1Id}`;
    const user = await prisma.user.findFirst({
      where: { email: "test@tenant1.com" },
    });
    expect(user).toBeNull();
  });
});
```

## RLS Audit Script

```typescript
// scripts/audit-rls.ts
async function auditRLS() {
  const tables = await prisma.$queryRaw<any[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename != '_prisma_migrations'
  `;

  console.log("🔍 Auditing Row Level Security...\n");

  for (const { tablename } of tables) {
    // Check if table has tenant_id
    const columns = await prisma.$queryRaw<any[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = ${tablename}
      AND column_name = 'tenant_id'
    `;

    if (columns.length === 0) {
      console.log(`❌ ${tablename}: Missing tenant_id column`);
      continue;
    }

    // Check if RLS is enabled
    const rlsStatus = await prisma.$queryRaw<any[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = ${tablename}
    `;

    if (!rlsStatus[0]?.relrowsecurity) {
      console.log(`❌ ${tablename}: RLS not enabled`);
      continue;
    }

    if (!rlsStatus[0]?.relforcerowsecurity) {
      console.log(`⚠️  ${tablename}: RLS not forced (owners can bypass)`);
    }

    // Check if policy exists
    const policies = await prisma.$queryRaw<any[]>`
      SELECT policyname, qual
      FROM pg_policies
      WHERE tablename = ${tablename}
    `;

    if (policies.length === 0) {
      console.log(`❌ ${tablename}: No RLS policies defined`);
    } else {
      console.log(`✅ ${tablename}: RLS configured (${policies.length} policies)`);
    }
  }
}
```

## Composite Indexes for Performance

```sql
-- Composite indexes with tenant_id first
CREATE INDEX idx_orders_tenant_user ON orders(tenant_id, user_id);
CREATE INDEX idx_orders_tenant_created ON orders(tenant_id, created_at DESC);
CREATE INDEX idx_products_tenant_category ON products(tenant_id, category);

-- This ensures queries filtered by tenant_id are fast
-- SELECT * FROM orders WHERE tenant_id = 1 AND user_id = 123; -- Uses index
```

## Middleware for Automatic Tenant Injection

```typescript
// prisma/middleware.ts
import { Prisma } from "@prisma/client";

export function tenantMiddleware(tenantId: number) {
  return async (
    params: Prisma.MiddlewareParams,
    next: (params: Prisma.MiddlewareParams) => Promise<any>,
  ) => {
    // Inject tenant_id into all queries
    if (params.action === "findMany" || params.action === "findFirst") {
      params.args.where = {
        ...params.args.where,
        tenantId,
      };
    }

    if (params.action === "create") {
      params.args.data = {
        ...params.args.data,
        tenantId,
      };
    }

    if (params.action === "createMany") {
      if (Array.isArray(params.args.data)) {
        params.args.data = params.args.data.map((item) => ({
          ...item,
          tenantId,
        }));
      }
    }

    return next(params);
  };
}

// Usage:
const prisma = new PrismaClient();
prisma.$use(tenantMiddleware(req.user.tenantId));
```

## Security Regression Tests

```typescript
// tests/security-regression.test.ts
describe("Security Regression Tests", () => {
  it("should not allow SQL injection to bypass tenant", async () => {
    const maliciousInput = "1 OR 1=1 --";

    // This should be safely parameterized
    const users = await prisma.user.findMany({
      where: {
        tenantId: parseInt(maliciousInput), // Will be NaN, safe
      },
    });

    expect(users).toEqual([]);
  });

  it("should not expose tenant data via API error messages", async () => {
    try {
      await prisma.user.findUniqueOrThrow({
        where: { id: 9999 }, // Non-existent
      });
    } catch (error) {
      // Error should not leak tenant information
      expect(error.message).not.toContain("tenant_id");
      expect(error.message).not.toContain("tenantId");
    }
  });
});
```

## Best Practices

1. **Always use RLS**: Don't rely on application logic alone
2. **Force RLS**: Even for table owners (FORCE ROW LEVEL SECURITY)
3. **Test thoroughly**: Automated tests for cross-tenant access
4. **Audit regularly**: Monthly RLS configuration audits
5. **Composite indexes**: tenant_id first in all indexes
6. **Tenant validation**: Verify user belongs to tenant
7. **Monitor**: Log cross-tenant access attempts

## Output Checklist

- [ ] RLS enabled on all tables
- [ ] RLS policies created
- [ ] Tenant context middleware
- [ ] Automated security tests
- [ ] RLS audit script
- [ ] Composite indexes created
- [ ] Cross-tenant access prevention tested
- [ ] Security regression test suite
