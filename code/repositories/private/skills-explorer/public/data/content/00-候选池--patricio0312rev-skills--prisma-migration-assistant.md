---
name: prisma-migration-assistant
description: Plans and executes safe Prisma schema migrations with data backfills, rollback strategies, and SQL preview. Handles complex schema changes including data transformations. Use for "Prisma migrations", "schema changes", "database migrations", or "data backfills".
---

# Prisma Migration Assistant

Plan and execute safe Prisma migrations with confidence.

## Migration Planning Workflow

```typescript
// 1. Update schema.prisma
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  // NEW: Split name into firstName and lastName
  firstName String?
  lastName  String?
  // OLD: name      String  // Will remove this
  createdAt DateTime @default(now())
}

// 2. Create migration
// npx prisma migrate dev --name split_user_name --create-only

// 3. Review generated SQL
// 4. Add data migration
// 5. Test migration
// 6. Apply to production
```

## Migration Types

### 1. Additive Migration (Safe)

```prisma
// Adding new optional field - safe!
model Product {
  id          Int     @id @default(autoincrement())
  name        String
  description String?
  price       Float
  newField    String? // NEW - optional, no backfill needed
}
```

```bash
# Generate migration
npx prisma migrate dev --name add_product_new_field

# SQL generated:
# ALTER TABLE "Product" ADD COLUMN "newField" TEXT;
```

### 2. Column Rename (Needs Data Copy)

```prisma
model User {
  id         Int    @id @default(autoincrement())
  emailAddr  String @unique // Renamed from 'email'
}
```

```sql
-- migrations/20240115_rename_email/migration.sql

-- Step 1: Add new column
ALTER TABLE "User" ADD COLUMN "emailAddr" TEXT;

-- Step 2: Copy data
UPDATE "User" SET "emailAddr" = "email";

-- Step 3: Make new column required
ALTER TABLE "User" ALTER COLUMN "emailAddr" SET NOT NULL;

-- Step 4: Add unique constraint
CREATE UNIQUE INDEX "User_emailAddr_key" ON "User"("emailAddr");

-- Step 5: Drop old column
ALTER TABLE "User" DROP COLUMN "email";
```

### 3. Data Transformation (Complex)

```prisma
// Before: Single name field
// After: First and last name
model User {
  id        Int     @id @default(autoincrement())
  firstName String
  lastName  String
  // name   String  // Removed
}
```

```sql
-- migrations/20240115_split_name/migration.sql

-- Step 1: Add new columns
ALTER TABLE "User" ADD COLUMN "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN "lastName" TEXT;

-- Step 2: Data migration (split name)
-- PostgreSQL
UPDATE "User"
SET
  "firstName" = SPLIT_PART("name", ' ', 1),
  "lastName" = CASE
    WHEN array_length(string_to_array("name", ' '), 1) > 1
    THEN array_to_string((string_to_array("name", ' '))[2:], ' ')
    ELSE ''
  END
WHERE "name" IS NOT NULL;

-- Step 3: Handle NULL values
UPDATE "User"
SET
  "firstName" = COALESCE("firstName", ''),
  "lastName" = COALESCE("lastName", '');

-- Step 4: Make columns required
ALTER TABLE "User" ALTER COLUMN "firstName" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "lastName" SET NOT NULL;

-- Step 5: Drop old column
ALTER TABLE "User" DROP COLUMN "name";
```

### 4. Type Change (Risky)

```prisma
model Product {
  id    Int    @id @default(autoincrement())
  price Decimal @db.Decimal(10, 2) // Changed from Float
}
```

```sql
-- migrations/20240115_price_to_decimal/migration.sql

-- Step 1: Add new column with correct type
ALTER TABLE "Product" ADD COLUMN "price_new" DECIMAL(10,2);

-- Step 2: Copy and convert data
UPDATE "Product"
SET "price_new" = CAST("price" AS DECIMAL(10,2));

-- Step 3: Drop old column
ALTER TABLE "Product" DROP COLUMN "price";

-- Step 4: Rename new column
ALTER TABLE "Product" RENAME COLUMN "price_new" TO "price";

-- Step 5: Make NOT NULL if required
ALTER TABLE "Product" ALTER COLUMN "price" SET NOT NULL;
```

## Migration Sequencing

```markdown
# Migration Sequence: Add User Roles

## Phase 1: Additive (Week 1)

1. Add optional `role` field
2. Deploy application code that handles NULL roles
3. Backfill existing users with default role

## Phase 2: Enforcement (Week 2)

1. Make `role` field required
2. Deploy code that requires role on creation
3. Add database constraint

## Phase 3: Cleanup (Week 3)

1. Remove old permission checking code
2. Verify all users have roles
```

## Backfill Strategies

### Small Table (< 10k rows)

```typescript
// scripts/backfill-user-roles.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function backfillUserRoles() {
  const usersWithoutRoles = await prisma.user.findMany({
    where: { role: null },
  });

  console.log(`Backfilling ${usersWithoutRoles.length} users...`);

  // Single transaction for small dataset
  await prisma.$transaction(
    usersWithoutRoles.map((user) =>
      prisma.user.update({
        where: { id: user.id },
        data: { role: "USER" }, // Default role
      }),
    ),
  );

  console.log("✅ Backfill complete");
}

backfillUserRoles();
```

### Large Table (> 10k rows)

```typescript
// scripts/backfill-large-table.ts
async function backfillBatched() {
  const batchSize = 1000;
  let processed = 0;
  let hasMore = true;

  while (hasMore) {
    const batch = await prisma.user.findMany({
      where: { role: null },
      take: batchSize,
      select: { id: true },
    });

    if (batch.length === 0) {
      hasMore = false;
      break;
    }

    // Process batch
    await prisma.$transaction(
      batch.map((user) =>
        prisma.user.update({
          where: { id: user.id },
          data: { role: "USER" },
        }),
      ),
    );

    processed += batch.length;
    console.log(`Processed ${processed} users...`);

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`✅ Backfilled ${processed} users`);
}
```

## Rollback Guidance

```sql
-- migrations/20240115_add_role/rollback.sql

-- Rollback Step 1: Add back old structure (if needed)
ALTER TABLE "User" DROP COLUMN "role";

-- Rollback Step 2: Restore old logic
-- (Deploy previous application version)

-- Note: Data loss consideration
-- If you backfilled data, document what was lost
```

## Migration Testing

```typescript
// tests/migrations/split-name.test.ts
import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";

describe("Split name migration", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Setup test database
    execSync("npx prisma migrate deploy", {
      env: { DATABASE_URL: process.env.TEST_DATABASE_URL },
    });
    prisma = new PrismaClient();
  });

  it("should split name correctly", async () => {
    // Create user with old schema
    await prisma.$executeRaw`
      INSERT INTO "User" (name) VALUES ('John Doe')
    `;

    // Run migration
    execSync("npx prisma migrate deploy");

    // Verify split
    const user = await prisma.user.findFirst();
    expect(user?.firstName).toBe("John");
    expect(user?.lastName).toBe("Doe");
  });

  it("should handle single name", async () => {
    await prisma.$executeRaw`
      INSERT INTO "User" (name) VALUES ('Madonna')
    `;

    execSync("npx prisma migrate deploy");

    const user = await prisma.user.findFirst({
      where: { firstName: "Madonna" },
    });
    expect(user?.lastName).toBe("");
  });
});
```

## Pre-Migration Checklist

```markdown
- [ ] Backup database
- [ ] Test migration on staging
- [ ] Verify data transformation logic
- [ ] Check for referential integrity issues
- [ ] Estimate migration time
- [ ] Plan rollback strategy
- [ ] Schedule maintenance window (if needed)
- [ ] Notify team of deployment
```

## SQL Preview Script

```bash
#!/bin/bash
# scripts/preview-migration.sh

echo "🔍 Previewing migration..."

# Create migration without applying
npx prisma migrate dev --name "$1" --create-only

# Show SQL
echo ""
echo "📄 Generated SQL:"
echo "=================="
cat prisma/migrations/*_$1/migration.sql

# Analyze impact
echo ""
echo "📊 Impact Analysis:"
echo "=================="
echo "Tables affected: $(cat prisma/migrations/*_$1/migration.sql | grep -c 'ALTER TABLE')"
echo "Rows to update: [Run COUNT query manually]"
echo "Estimated time: [Estimate based on table size]"
```

## Best Practices

1. **Create migration, don't apply**: Use `--create-only` flag
2. **Review SQL carefully**: Check generated migration
3. **Test on staging**: Always test before production
4. **Batch large updates**: Avoid locking tables
5. **Add before removing**: Additive migrations first
6. **Version application code**: Deploy code that handles both schemas
7. **Monitor performance**: Watch query times during migration
8. **Have rollback plan**: Document reversal steps

## Output Checklist

- [ ] Migration SQL generated and reviewed
- [ ] Data backfill strategy planned
- [ ] Rollback procedure documented
- [ ] Migration sequencing defined
- [ ] Testing plan created
- [ ] Impact analysis completed
- [ ] Staging deployment successful
- [ ] Production deployment scheduled
