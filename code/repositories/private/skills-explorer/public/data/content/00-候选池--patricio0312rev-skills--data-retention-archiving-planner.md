---
name: data-retention-archiving-planner
description: Plans and implements data retention policies with archival strategies, compliance requirements, automated cleanup jobs, and cold storage migration. Use for "data retention", "data archival", "GDPR compliance", or "storage optimization".
---

# Data Retention & Archiving Planner

Manage data lifecycle with automated retention and archiving.

## Retention Policy Document

```markdown
# Data Retention Policy

## Retention Periods

| Data Type             | Hot Storage | Cold Storage | Total Retention | Reason            |
| --------------------- | ----------- | ------------ | --------------- | ----------------- |
| User accounts         | Active      | N/A          | Indefinite      | Business need     |
| Order history         | 2 years     | 5 years      | 7 years         | Tax compliance    |
| Logs                  | 30 days     | 90 days      | 120 days        | Operational       |
| Analytics events      | 90 days     | 1 year       | 15 months       | Business insights |
| Audit trails          | 1 year      | 6 years      | 7 years         | Legal compliance  |
| User sessions         | 30 days     | None         | 30 days         | Security          |
| Failed login attempts | 90 days     | None         | 90 days         | Security          |

## Compliance Requirements

### GDPR (EU)

- Right to erasure (right to be forgotten)
- Data minimization
- Storage limitation

### HIPAA (Healthcare)

- Minimum 6 years retention
- Secure archival required

### SOX (Financial)

- 7 years retention for financial records
- Immutable audit trails

### PCI DSS (Payments)

- 1 year minimum for audit logs
- 3 months minimum for transaction logs
```

## Archive Schema Design

```sql
-- Hot database: Current active data
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Cold database: Archived historical data
CREATE TABLE orders_archive (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  archived_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create partition for time-based archival
CREATE TABLE orders_2024_q1 PARTITION OF orders
  FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');

CREATE TABLE orders_2024_q2 PARTITION OF orders
  FOR VALUES FROM ('2024-04-01') TO ('2024-07-01');
```

## Archival Job Implementation

```typescript
// jobs/archive-orders.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const archivePrisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.ARCHIVE_DATABASE_URL,
    },
  },
});

interface ArchivalJob {
  table: string;
  retentionDays: number;
  batchSize: number;
}

async function archiveOrders() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 730); // 2 years

  console.log(`📦 Archiving orders older than ${cutoffDate.toISOString()}`);

  let archived = 0;
  let hasMore = true;

  while (hasMore) {
    await prisma.$transaction(async (tx) => {
      // Find orders to archive
      const ordersToArchive = await tx.order.findMany({
        where: {
          created_at: { lt: cutoffDate },
          status: { in: ["delivered", "cancelled"] },
        },
        take: 1000,
      });

      if (ordersToArchive.length === 0) {
        hasMore = false;
        return;
      }

      // Copy to archive database
      await archivePrisma.order.createMany({
        data: ordersToArchive.map((order) => ({
          ...order,
          archived_at: new Date(),
        })),
        skipDuplicates: true,
      });

      // Delete from hot database
      await tx.order.deleteMany({
        where: {
          id: { in: ordersToArchive.map((o) => o.id) },
        },
      });

      archived += ordersToArchive.length;
      console.log(`  Archived ${archived} orders...`);
    });

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`✅ Archived ${archived} orders total`);
}

// Schedule: Run nightly
archiveOrders();
```

## Automated Cleanup Jobs

```typescript
// jobs/cleanup-old-data.ts
interface CleanupJob {
  table: string;
  column: string;
  retentionDays: number;
}

const CLEANUP_JOBS: CleanupJob[] = [
  {
    table: "sessions",
    column: "created_at",
    retentionDays: 30,
  },
  {
    table: "password_reset_tokens",
    column: "created_at",
    retentionDays: 1,
  },
  {
    table: "failed_login_attempts",
    column: "attempted_at",
    retentionDays: 90,
  },
  {
    table: "analytics_events",
    column: "created_at",
    retentionDays: 90,
  },
];

async function runCleanupJobs() {
  console.log("🗑️  Running cleanup jobs...\n");

  for (const job of CLEANUP_JOBS) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - job.retentionDays);

    const result = await prisma.$executeRawUnsafe(
      `
      DELETE FROM "${job.table}"
      WHERE "${job.column}" < $1
    `,
      cutoffDate,
    );

    console.log(`✅ ${job.table}: Deleted ${result} rows older than ${job.retentionDays} days`);
  }

  console.log("\n✅ Cleanup complete!");
}
```

## Soft Delete Pattern

```typescript
// Soft delete for GDPR compliance
model User {
  id        Int       @id @default(autoincrement())
  email     String    @unique
  name      String
  deletedAt DateTime? // NULL = active, NOT NULL = deleted
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([deletedAt])
}

// Middleware to filter soft-deleted records
prisma.$use(async (params, next) => {
  if (params.action === 'findMany' || params.action === 'findFirst') {
    params.args.where = {
      ...params.args.where,
      deletedAt: null, // Only show non-deleted
    };
  }
  return next(params);
});

// Hard delete after retention period
async function purgeDeletedUsers() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90); // 90 days retention

  const result = await prisma.user.deleteMany({
    where: {
      deletedAt: { lt: cutoffDate },
    },
  });

  console.log(`🗑️  Purged ${result.count} deleted users`);
}
```

## Cold Storage Migration

```bash
#!/bin/bash
# scripts/migrate-to-s3.sh

# Dump old orders to S3 for cold storage
CUTOFF_DATE="2022-01-01"

echo "📦 Migrating orders to S3..."

# 1. Export to CSV
psql $DATABASE_URL -c "\COPY (
  SELECT * FROM orders WHERE created_at < '$CUTOFF_DATE'
) TO STDOUT WITH CSV HEADER" | gzip > orders_archive.csv.gz

# 2. Upload to S3
aws s3 cp orders_archive.csv.gz s3://my-cold-storage/orders/

# 3. Verify upload
if aws s3 ls s3://my-cold-storage/orders/orders_archive.csv.gz; then
  echo "✅ Uploaded to S3"

  # 4. Delete from database
  psql $DATABASE_URL -c "DELETE FROM orders WHERE created_at < '$CUTOFF_DATE'"

  echo "✅ Deleted from database"
else
  echo "❌ S3 upload failed, skipping deletion"
  exit 1
fi
```

## Compliance Automation

```typescript
// Right to be forgotten (GDPR)
async function deleteUserData(userId: number) {
  console.log(`🗑️  Deleting user data for user ${userId}...`);

  await prisma.$transaction(async (tx) => {
    // 1. Anonymize orders (keep for business records)
    await tx.order.updateMany({
      where: { userId },
      data: {
        userId: null,
        shippingAddress: "[DELETED]",
        billingAddress: "[DELETED]",
      },
    });

    // 2. Delete personal data
    await tx.userProfile.delete({ where: { userId } });
    await tx.paymentMethod.deleteMany({ where: { userId } });
    await tx.address.deleteMany({ where: { userId } });

    // 3. Soft delete user account
    await tx.user.update({
      where: { id: userId },
      data: {
        email: `deleted-${userId}@example.com`,
        name: "[DELETED]",
        deletedAt: new Date(),
      },
    });
  });

  console.log(`✅ User data deleted`);
}
```

## Monitoring & Alerting

```typescript
// Monitor archive job health
async function checkArchivalHealth() {
  // Check oldest active order
  const oldestOrder = await prisma.order.findFirst({
    orderBy: { created_at: "asc" },
  });

  const age = Date.now() - oldestOrder.created_at.getTime();
  const ageDays = age / (1000 * 60 * 60 * 24);

  if (ageDays > 750) {
    // > 2 years + buffer
    console.error("⚠️  Orders older than retention period found!");
    await sendAlert({
      title: "Archive job failing",
      message: `Oldest order is ${ageDays.toFixed(0)} days old`,
    });
  }

  // Check archive database size
  const archiveCount = await archivePrisma.order.count();
  console.log(`📊 Archive database: ${archiveCount} orders`);

  // Check hot database size
  const hotCount = await prisma.order.count();
  console.log(`📊 Hot database: ${hotCount} orders`);
}
```

## Restore from Archive

```typescript
// Restore archived order (e.g., for audit)
async function restoreArchivedOrder(orderId: number) {
  // Find in archive
  const archivedOrder = await archivePrisma.order.findUnique({
    where: { id: orderId },
  });

  if (!archivedOrder) {
    throw new Error("Order not found in archive");
  }

  // Copy to hot database
  await prisma.order.create({
    data: {
      ...archivedOrder,
      archived_at: undefined,
    },
  });

  console.log(`✅ Restored order ${orderId} from archive`);
}
```

## Schedule Configuration

```yaml
# cron schedule for archival jobs
jobs:
  archive-orders:
    schedule: "0 2 * * *" # 2 AM daily
    command: "npm run job:archive-orders"

  cleanup-sessions:
    schedule: "0 3 * * *" # 3 AM daily
    command: "npm run job:cleanup-sessions"

  purge-deleted-users:
    schedule: "0 4 * * 0" # 4 AM Sunday
    command: "npm run job:purge-deleted"

  health-check:
    schedule: "0 */6 * * *" # Every 6 hours
    command: "npm run job:check-archival-health"
```

## Best Practices

1. **Define clear policies**: Document retention periods
2. **Automate everything**: Manual cleanup is unreliable
3. **Test restore**: Regularly test archive restoration
4. **Monitor job health**: Alert on failures
5. **Compliance first**: Meet legal requirements
6. **Soft delete**: Before hard delete
7. **Batch operations**: Avoid locking tables

## Output Checklist

- [ ] Retention policy documented
- [ ] Archive schema designed
- [ ] Archival jobs implemented
- [ ] Cleanup jobs automated
- [ ] Soft delete pattern (if applicable)
- [ ] Cold storage migration
- [ ] GDPR compliance (right to be forgotten)
- [ ] Job scheduling configured
- [ ] Monitoring and alerting
- [ ] Restore procedure tested
