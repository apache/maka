---
name: data-integrity-auditor
description: Detects data integrity issues including orphaned records, broken foreign key relationships, constraint violations, and provides automated fix migrations. Use for "data integrity", "orphaned records", "broken relationships", or "data quality".
---

# Data Integrity Auditor

Detect and fix data integrity issues automatically.

## Integrity Check Types

### 1. Orphaned Records

```sql
-- Find orphaned orders (no matching user)
SELECT o.id, o.user_id
FROM orders o
LEFT JOIN users u ON u.id = o.user_id
WHERE u.id IS NULL;

-- Find orphaned order items (no matching order)
SELECT oi.id, oi.order_id
FROM order_items oi
LEFT JOIN orders o ON o.id = oi.order_id
WHERE o.id IS NULL;
```

### 2. Broken Foreign Keys

```typescript
// scripts/check-foreign-keys.ts
async function checkForeignKeys() {
  const issues: string[] = [];

  // Orders → Users
  const orphanedOrders = await prisma.$queryRaw<any[]>`
    SELECT o.id, o.user_id
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE u.id IS NULL
    LIMIT 100
  `;

  if (orphanedOrders.length > 0) {
    issues.push(`❌ Found ${orphanedOrders.length} orders with invalid user_id`);
    console.log(
      "  Sample IDs:",
      orphanedOrders.slice(0, 5).map((o) => o.id),
    );
  }

  // Order Items → Orders
  const orphanedItems = await prisma.$queryRaw<any[]>`
    SELECT oi.id, oi.order_id
    FROM order_items oi
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE o.id IS NULL
    LIMIT 100
  `;

  if (orphanedItems.length > 0) {
    issues.push(`❌ Found ${orphanedItems.length} order items with invalid order_id`);
  }

  // Products → Categories
  const orphanedProducts = await prisma.$queryRaw<any[]>`
    SELECT p.id, p.category_id
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.category_id IS NOT NULL
    AND c.id IS NULL
    LIMIT 100
  `;

  if (orphanedProducts.length > 0) {
    issues.push(`❌ Found ${orphanedProducts.length} products with invalid category_id`);
  }

  return issues;
}
```

### 3. Constraint Violations

```typescript
async function checkConstraints() {
  const issues: string[] = [];

  // Check email uniqueness (should be caught by DB, but verify)
  const duplicateEmails = await prisma.$queryRaw<any[]>`
    SELECT email, COUNT(*) as count
    FROM users
    GROUP BY email
    HAVING COUNT(*) > 1
  `;

  if (duplicateEmails.length > 0) {
    issues.push(`❌ Found ${duplicateEmails.length} duplicate emails`);
  }

  // Check negative quantities
  const negativeStock = await prisma.$queryRaw<any[]>`
    SELECT id, name, stock
    FROM products
    WHERE stock < 0
  `;

  if (negativeStock.length > 0) {
    issues.push(`❌ Found ${negativeStock.length} products with negative stock`);
  }

  // Check negative prices
  const negativePrices = await prisma.$queryRaw<any[]>`
    SELECT id, name, price
    FROM products
    WHERE price < 0
  `;

  if (negativePrices.length > 0) {
    issues.push(`❌ Found ${negativePrices.length} products with negative prices`);
  }

  // Check invalid order status
  const invalidStatus = await prisma.$queryRaw<any[]>`
    SELECT id, status
    FROM orders
    WHERE status NOT IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')
  `;

  if (invalidStatus.length > 0) {
    issues.push(`❌ Found ${invalidStatus.length} orders with invalid status`);
  }

  return issues;
}
```

### 4. Missing Required Fields

```typescript
async function checkMissingFields() {
  const issues: string[] = [];

  // Users missing required fields
  const usersNoEmail = await prisma.user.count({
    where: { email: null },
  });

  if (usersNoEmail > 0) {
    issues.push(`❌ Found ${usersNoEmail} users without email`);
  }

  // Orders with NULL totals
  const ordersNoTotal = await prisma.order.count({
    where: { total: null },
  });

  if (ordersNoTotal > 0) {
    issues.push(`❌ Found ${ordersNoTotal} orders without total`);
  }

  return issues;
}
```

## Comprehensive Audit Script

```typescript
// scripts/audit-data-integrity.ts
interface IntegrityIssue {
  severity: "critical" | "warning" | "info";
  category: string;
  message: string;
  count: number;
  query?: string;
  fix?: string;
}

async function auditDataIntegrity(): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];

  console.log("🔍 Auditing data integrity...\n");

  // 1. Check orphaned records
  const orphanedOrders = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*) as count FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE u.id IS NULL
  `;

  if (orphanedOrders[0].count > 0) {
    issues.push({
      severity: "critical",
      category: "orphaned-records",
      message: "Orders with invalid user references",
      count: orphanedOrders[0].count,
      query:
        "SELECT id, user_id FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE u.id IS NULL",
      fix: "DELETE FROM orders WHERE id IN (...)",
    });
  }

  // 2. Check duplicate unique constraints
  const duplicateEmails = await prisma.$queryRaw<any[]>`
    SELECT email, COUNT(*) as count
    FROM users
    GROUP BY email
    HAVING COUNT(*) > 1
  `;

  if (duplicateEmails.length > 0) {
    issues.push({
      severity: "critical",
      category: "constraint-violation",
      message: "Duplicate email addresses",
      count: duplicateEmails.length,
      fix: "Keep newest record, delete duplicates",
    });
  }

  // 3. Check data inconsistencies
  const invalidPrices = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*) as count FROM products WHERE price < 0
  `;

  if (invalidPrices[0].count > 0) {
    issues.push({
      severity: "warning",
      category: "data-quality",
      message: "Products with negative prices",
      count: invalidPrices[0].count,
      fix: "UPDATE products SET price = ABS(price) WHERE price < 0",
    });
  }

  // 4. Check referential integrity
  const brokenOrderItems = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*) as count FROM order_items oi
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE o.id IS NULL
  `;

  if (brokenOrderItems[0].count > 0) {
    issues.push({
      severity: "critical",
      category: "referential-integrity",
      message: "Order items referencing non-existent orders",
      count: brokenOrderItems[0].count,
      fix: "DELETE FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)",
    });
  }

  return issues;
}

async function generateReport() {
  const issues = await auditDataIntegrity();

  console.log("\n📊 Data Integrity Report\n");
  console.log(`Total issues: ${issues.length}\n`);

  const grouped = issues.reduce(
    (acc, issue) => {
      if (!acc[issue.severity]) acc[issue.severity] = [];
      acc[issue.severity].push(issue);
      return acc;
    },
    {} as Record<string, IntegrityIssue[]>,
  );

  (["critical", "warning", "info"] as const).forEach((severity) => {
    const items = grouped[severity] || [];
    if (items.length === 0) return;

    console.log(`\n${severity.toUpperCase()} (${items.length})\n`);

    items.forEach((issue, i) => {
      console.log(`${i + 1}. [${issue.category}] ${issue.message}`);
      console.log(`   Count: ${issue.count}`);
      if (issue.query) {
        console.log(`   Query: ${issue.query.substring(0, 80)}...`);
      }
      if (issue.fix) {
        console.log(`   Fix: ${issue.fix}`);
      }
      console.log();
    });
  });

  // Exit with error if critical issues
  process.exit(grouped.critical?.length > 0 ? 1 : 0);
}

generateReport();
```

## Automated Fixes

```typescript
// scripts/fix-integrity-issues.ts
async function fixOrphanedRecords() {
  console.log("🔧 Fixing orphaned records...\n");

  // Delete orphaned orders
  const deletedOrders = await prisma.$executeRaw`
    DELETE FROM orders
    WHERE id IN (
      SELECT o.id FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE u.id IS NULL
    )
  `;
  console.log(`✅ Deleted ${deletedOrders} orphaned orders`);

  // Delete orphaned order items
  const deletedItems = await prisma.$executeRaw`
    DELETE FROM order_items
    WHERE id IN (
      SELECT oi.id FROM order_items oi
      LEFT JOIN orders o ON o.id = oi.order_id
      WHERE o.id IS NULL
    )
  `;
  console.log(`✅ Deleted ${deletedItems} orphaned order items`);
}

async function fixDuplicates() {
  console.log("🔧 Fixing duplicate records...\n");

  // Keep newest user, delete old duplicates
  await prisma.$executeRaw`
    DELETE FROM users
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY email ORDER BY created_at DESC) as rn
        FROM users
      ) t
      WHERE rn > 1
    )
  `;
  console.log(`✅ Fixed duplicate emails`);
}

async function fixConstraintViolations() {
  console.log("🔧 Fixing constraint violations...\n");

  // Fix negative prices
  const fixedPrices = await prisma.$executeRaw`
    UPDATE products
    SET price = ABS(price)
    WHERE price < 0
  `;
  console.log(`✅ Fixed ${fixedPrices} negative prices`);

  // Fix negative stock
  const fixedStock = await prisma.$executeRaw`
    UPDATE products
    SET stock = 0
    WHERE stock < 0
  `;
  console.log(`✅ Fixed ${fixedStock} negative stock values`);
}
```

## Prevention: Add Missing Constraints

```sql
-- Migration to add missing constraints

-- 1. Add foreign key constraints
ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id) REFERENCES users(id)
  ON DELETE CASCADE;

ALTER TABLE order_items
  ADD CONSTRAINT fk_order_items_order_id
  FOREIGN KEY (order_id) REFERENCES orders(id)
  ON DELETE CASCADE;

-- 2. Add check constraints
ALTER TABLE products
  ADD CONSTRAINT chk_products_price_positive
  CHECK (price >= 0);

ALTER TABLE products
  ADD CONSTRAINT chk_products_stock_non_negative
  CHECK (stock >= 0);

-- 3. Add unique constraints
CREATE UNIQUE INDEX idx_users_email_unique
  ON users(LOWER(email));

-- 4. Add NOT NULL constraints
ALTER TABLE users
  ALTER COLUMN email SET NOT NULL;

ALTER TABLE orders
  ALTER COLUMN total SET NOT NULL;
```

## Automated Testing

```typescript
// tests/data-integrity.test.ts
describe("Data Integrity", () => {
  it("should not allow orphaned orders", async () => {
    // Try to create order with non-existent user
    await expect(
      prisma.order.create({
        data: {
          userId: 99999, // Non-existent
          total: 100,
          status: "pending",
        },
      }),
    ).rejects.toThrow("Foreign key constraint");
  });

  it("should not allow negative prices", async () => {
    await expect(
      prisma.product.create({
        data: {
          name: "Test",
          price: -10, // Invalid
          stock: 100,
        },
      }),
    ).rejects.toThrow("Check constraint");
  });

  it("should not allow duplicate emails", async () => {
    await prisma.user.create({
      data: { email: "test@example.com", name: "Test" },
    });

    await expect(
      prisma.user.create({
        data: { email: "test@example.com", name: "Test 2" },
      }),
    ).rejects.toThrow("Unique constraint");
  });
});
```

## Monitoring Dashboard

```typescript
// Monitor data quality metrics
async function getDataQualityMetrics() {
  return {
    orphanedOrders: await prisma.$queryRaw`
      SELECT COUNT(*) FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE u.id IS NULL
    `,
    duplicateEmails: await prisma.$queryRaw`
      SELECT COUNT(*) FROM (
        SELECT email FROM users GROUP BY email HAVING COUNT(*) > 1
      ) t
    `,
    invalidPrices: await prisma.$queryRaw`
      SELECT COUNT(*) FROM products WHERE price < 0
    `,
    missingData: await prisma.$queryRaw`
      SELECT
        SUM(CASE WHEN email IS NULL THEN 1 ELSE 0 END) as users_no_email,
        SUM(CASE WHEN total IS NULL THEN 1 ELSE 0 END) as orders_no_total
      FROM users
      CROSS JOIN orders
    `,
  };
}
```

## Best Practices

1. **Add constraints**: Prevent issues at database level
2. **Regular audits**: Weekly integrity checks
3. **Automated fixes**: Safe, reversible repairs
4. **Monitor metrics**: Track data quality over time
5. **Test constraints**: Ensure they work
6. **Soft deletes**: Easier recovery
7. **Backup before fixes**: Always

## Output Checklist

- [ ] Orphaned record detection
- [ ] Foreign key integrity checks
- [ ] Constraint violation detection
- [ ] Missing field checks
- [ ] Automated audit script
- [ ] Fix scripts (with dry-run)
- [ ] Prevention migrations (add constraints)
- [ ] Automated tests
- [ ] Monitoring dashboard
- [ ] Regular audit schedule
