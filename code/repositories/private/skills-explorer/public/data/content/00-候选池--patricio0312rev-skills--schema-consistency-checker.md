---
name: schema-consistency-checker
description: Audits database schemas for naming conventions, type consistency, nullability patterns, and missing constraints. Provides violations report with recommended fixes. Use for "schema validation", "database linting", "schema standards", or "consistency checks".
---

# Schema Consistency Checker

Enforce schema consistency and best practices across your database.

## Consistency Rules

### 1. Naming Conventions

```typescript
// naming-rules.ts
export const NAMING_RULES = {
  tables: {
    pattern: /^[A-Z][a-zA-Z0-9]*$/, // PascalCase
    examples: ["User", "OrderItem", "ProductCategory"],
  },
  columns: {
    pattern: /^[a-z][a-zA-Z0-9]*$/, // camelCase
    examples: ["id", "firstName", "createdAt"],
  },
  indexes: {
    pattern: /^idx_[a-z_]+$/, // idx_table_column
    examples: ["idx_users_email", "idx_orders_user_id"],
  },
  foreignKeys: {
    pattern: /^fk_[a-z_]+$/, // fk_table_column
    examples: ["fk_orders_user_id", "fk_products_category_id"],
  },
  constraints: {
    pattern: /^(chk|unq)_[a-z_]+$/, // chk_ or unq_prefix
    examples: ["chk_age_positive", "unq_users_email"],
  },
};
```

### 2. Type Consistency

```sql
-- ❌ Bad: Inconsistent types for IDs
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,  -- ❌ Different ID type
  user_id TEXT            -- ❌ Wrong type for FK
);

-- ✅ Good: Consistent types
CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  email TEXT
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT REFERENCES users(id)
);
```

### 3. Nullability Patterns

```sql
-- ❌ Bad: Inconsistent NULL handling
CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  email TEXT,              -- ❌ No NOT NULL on critical field
  name TEXT,               -- ❌ Should be NOT NULL
  phone TEXT NULL,         -- ⚠️ Explicit NULL unnecessary
  created_at TIMESTAMP     -- ❌ Missing NOT NULL
);

-- ✅ Good: Clear nullability
CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,              -- Optional field
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### 4. Missing Constraints

```sql
-- ❌ Bad: Missing constraints
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT,          -- ❌ Missing FK
  status TEXT,             -- ❌ No CHECK constraint
  total DECIMAL(10,2),     -- ❌ No CHECK for positive
  created_at TIMESTAMP
);

-- ✅ Good: Proper constraints
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered')),
  total DECIMAL(10,2) NOT NULL CHECK (total >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

## Audit Script

```typescript
// scripts/audit-schema.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface Violation {
  severity: "error" | "warning" | "info";
  category: string;
  table: string;
  column?: string;
  message: string;
  recommendation: string;
}

async function auditSchema(): Promise<Violation[]> {
  const violations: Violation[] = [];

  // Get schema metadata
  const tables = await prisma.$queryRaw<any[]>`
    SELECT
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;

  // Check 1: Naming conventions
  tables.forEach((col) => {
    // Table naming
    if (!/^[A-Z][a-zA-Z0-9]*$/.test(col.table_name)) {
      violations.push({
        severity: "warning",
        category: "naming",
        table: col.table_name,
        message: `Table name '${col.table_name}' doesn't follow PascalCase convention`,
        recommendation: `Rename to PascalCase (e.g., 'UserProfile', 'OrderItem')`,
      });
    }

    // Column naming
    if (!/^[a-z][a-zA-Z0-9]*$/.test(col.column_name)) {
      violations.push({
        severity: "warning",
        category: "naming",
        table: col.table_name,
        column: col.column_name,
        message: `Column '${col.column_name}' doesn't follow camelCase convention`,
        recommendation: `Rename to camelCase (e.g., 'firstName', 'createdAt')`,
      });
    }
  });

  // Check 2: Missing NOT NULL on critical fields
  const criticalFields = ["email", "name", "user_id", "created_at", "updated_at"];
  tables.forEach((col) => {
    if (criticalFields.some((f) => col.column_name.includes(f)) && col.is_nullable === "YES") {
      violations.push({
        severity: "error",
        category: "nullability",
        table: col.table_name,
        column: col.column_name,
        message: `Critical field '${col.column_name}' allows NULL`,
        recommendation: `Add NOT NULL constraint`,
      });
    }
  });

  // Check 3: Type consistency for IDs
  const idTypes = new Map<string, string>();
  tables.forEach((col) => {
    if (col.column_name === "id") {
      idTypes.set(col.table_name, col.data_type);
    }
  });

  const primaryIdType = Array.from(idTypes.values())[0];
  idTypes.forEach((type, table) => {
    if (type !== primaryIdType) {
      violations.push({
        severity: "error",
        category: "type-consistency",
        table,
        column: "id",
        message: `ID type '${type}' inconsistent with primary type '${primaryIdType}'`,
        recommendation: `Standardize all IDs to ${primaryIdType}`,
      });
    }
  });

  // Check 4: Missing indexes on foreign keys
  const foreignKeys = await prisma.$queryRaw<any[]>`
    SELECT
      tc.table_name,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
  `;

  const indexes = await prisma.$queryRaw<any[]>`
    SELECT
      tablename,
      indexname,
      indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
  `;

  foreignKeys.forEach((fk) => {
    const hasIndex = indexes.some(
      (idx) => idx.tablename === fk.table_name && idx.indexdef.includes(fk.column_name),
    );

    if (!hasIndex) {
      violations.push({
        severity: "warning",
        category: "performance",
        table: fk.table_name,
        column: fk.column_name,
        message: `Foreign key '${fk.column_name}' has no index`,
        recommendation: `CREATE INDEX idx_${fk.table_name}_${fk.column_name} ON "${fk.table_name}"("${fk.column_name}")`,
      });
    }
  });

  // Check 5: Missing timestamps
  const tablesGrouped = tables.reduce(
    (acc, col) => {
      if (!acc[col.table_name]) acc[col.table_name] = [];
      acc[col.table_name].push(col.column_name);
      return acc;
    },
    {} as Record<string, string[]>,
  );

  Object.entries(tablesGrouped).forEach(([table, columns]) => {
    if (!columns.includes("created_at")) {
      violations.push({
        severity: "info",
        category: "audit",
        table,
        message: `Table missing 'created_at' timestamp`,
        recommendation: `Add: created_at TIMESTAMP NOT NULL DEFAULT NOW()`,
      });
    }
    if (!columns.includes("updated_at") && !columns.includes("updatedAt")) {
      violations.push({
        severity: "info",
        category: "audit",
        table,
        message: `Table missing 'updated_at' timestamp`,
        recommendation: `Add: updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
      });
    }
  });

  return violations;
}

// Generate report
async function generateReport() {
  const violations = await auditSchema();

  console.log("📊 Schema Audit Report\n");
  console.log(`Total violations: ${violations.length}\n`);

  // Group by severity
  const grouped = violations.reduce(
    (acc, v) => {
      if (!acc[v.severity]) acc[v.severity] = [];
      acc[v.severity].push(v);
      return acc;
    },
    {} as Record<string, Violation[]>,
  );

  // Print by severity
  (["error", "warning", "info"] as const).forEach((severity) => {
    const items = grouped[severity] || [];
    if (items.length === 0) return;

    console.log(
      `\n${
        { error: "❌ Errors", warning: "⚠️  Warnings", info: "ℹ️  Info" }[severity]
      } (${items.length})\n`,
    );

    items.forEach((v, i) => {
      console.log(`${i + 1}. [${v.category}] ${v.table}${v.column ? `.${v.column}` : ""}`);
      console.log(`   Message: ${v.message}`);
      console.log(`   Fix: ${v.recommendation}\n`);
    });
  });

  // Exit code based on errors
  process.exit(grouped.error?.length > 0 ? 1 : 0);
}

generateReport();
```

## Recommended Schema Standards

```prisma
// schema.prisma with best practices

model User {
  // 1. ID: Consistent type (Int or String/cuid)
  id        Int      @id @default(autoincrement())

  // 2. Critical fields: NOT NULL
  email     String   @unique
  name      String

  // 3. Optional fields: Clearly nullable
  phone     String?
  bio       String?

  // 4. Audit timestamps: Always include
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // 5. Relations: Proper foreign keys
  orders    Order[]

  // 6. Indexes: On frequently queried fields
  @@index([email])
  @@index([createdAt])
}

model Order {
  id        Int      @id @default(autoincrement())

  // Foreign key with clear naming
  userId    Int
  user      User     @relation(fields: [userId], references: [id])

  // Enum for status (type safety)
  status    OrderStatus @default(PENDING)

  // Decimal for money
  total     Decimal  @db.Decimal(10, 2)

  // Timestamps
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Indexes on foreign keys
  @@index([userId])
  @@index([status])
  @@index([createdAt])
}

enum OrderStatus {
  PENDING
  PAID
  SHIPPED
  DELIVERED
  CANCELLED
}
```

## Auto-fix Migrations

```typescript
// scripts/fix-schema.ts
async function generateFixMigrations(violations: Violation[]) {
  const migrations: string[] = [];

  violations.forEach((v) => {
    if (v.category === "nullability" && v.column) {
      migrations.push(`ALTER TABLE "${v.table}" ALTER COLUMN "${v.column}" SET NOT NULL;`);
    }

    if (v.category === "performance" && v.recommendation.startsWith("CREATE INDEX")) {
      migrations.push(v.recommendation + ";");
    }

    if (v.category === "audit" && v.message.includes("created_at")) {
      migrations.push(
        `ALTER TABLE "${v.table}" ADD COLUMN "created_at" TIMESTAMP NOT NULL DEFAULT NOW();`,
      );
    }
  });

  console.log("-- Auto-generated fixes\n");
  migrations.forEach((m) => console.log(m));
}
```

## Best Practices

1. **Run regularly**: Weekly schema audits
2. **Enforce in CI**: Fail builds on errors
3. **Document standards**: Team agreement on conventions
4. **Gradual adoption**: Fix incrementally
5. **Use enums**: For status fields
6. **Always timestamp**: created_at and updated_at
7. **Index foreign keys**: Performance best practice

## Output Checklist

- [ ] Naming violations report
- [ ] Type consistency checks
- [ ] Nullability issues identified
- [ ] Missing constraints flagged
- [ ] Performance issues (missing indexes)
- [ ] Recommended fixes generated
- [ ] Auto-fix migrations provided
- [ ] Schema standards documented
