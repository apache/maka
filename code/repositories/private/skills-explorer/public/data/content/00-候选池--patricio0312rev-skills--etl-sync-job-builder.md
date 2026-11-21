---
name: etl-sync-job-builder
description: Designs reliable ETL and data synchronization jobs with incremental updates, idempotency guarantees, watermark tracking, error handling, and retry logic. Use for "ETL jobs", "data sync", "incremental sync", or "data pipeline".
---

# ETL/Sync Job Builder

Build reliable, incremental data synchronization pipelines.

## ETL Job Pattern

```typescript
// jobs/sync-users.ts
interface SyncJob {
  name: string;
  source: "database" | "api" | "file";
  destination: "database" | "warehouse" | "s3";
  schedule: string;
}

export class ETLJob {
  constructor(
    private name: string,
    private watermarkKey: string,
  ) {}

  async run() {
    console.log(`🔄 Starting ${this.name}...`);

    try {
      // 1. Get last watermark
      const lastSync = await this.getWatermark();
      console.log(`  Last sync: ${lastSync}`);

      // 2. Extract data
      const data = await this.extract(lastSync);
      console.log(`  Extracted ${data.length} records`);

      // 3. Transform data
      const transformed = await this.transform(data);

      // 4. Load data
      await this.load(transformed);

      // 5. Update watermark
      await this.updateWatermark(new Date());

      console.log(`✅ ${this.name} complete`);
    } catch (error) {
      console.error(`❌ ${this.name} failed:`, error);
      throw error;
    }
  }

  private async extract(since: Date) {
    // Extract logic
    return [];
  }

  private async transform(data: any[]) {
    // Transform logic
    return data;
  }

  private async load(data: any[]) {
    // Load logic
  }

  private async getWatermark(): Promise<Date> {
    const watermark = await prisma.syncWatermark.findUnique({
      where: { key: this.watermarkKey },
    });
    return watermark?.lastSync || new Date(0);
  }

  private async updateWatermark(timestamp: Date) {
    await prisma.syncWatermark.upsert({
      where: { key: this.watermarkKey },
      create: { key: this.watermarkKey, lastSync: timestamp },
      update: { lastSync: timestamp },
    });
  }
}
```

## Watermark Strategy

```prisma
// Track sync progress
model SyncWatermark {
  key      String   @id
  lastSync DateTime
  metadata Json?

  @@index([lastSync])
}
```

```typescript
// Incremental sync using watermark
async function syncOrdersIncremental() {
  // Get last sync time
  const watermark = await prisma.syncWatermark.findUnique({
    where: { key: "orders_sync" },
  });

  const lastSync = watermark?.lastSync || new Date(0);

  // Fetch only new/updated records
  const newOrders = await sourceDb.order.findMany({
    where: {
      updated_at: { gt: lastSync },
    },
    orderBy: { updated_at: "asc" },
  });

  console.log(`📦 Syncing ${newOrders.length} orders...`);

  // Process in batches
  for (let i = 0; i < newOrders.length; i += 100) {
    const batch = newOrders.slice(i, i + 100);

    await destinationDb.order.createMany({
      data: batch,
      skipDuplicates: true, // Idempotency
    });
  }

  // Update watermark to latest record
  if (newOrders.length > 0) {
    const latestTimestamp = newOrders[newOrders.length - 1].updated_at;

    await prisma.syncWatermark.upsert({
      where: { key: "orders_sync" },
      create: { key: "orders_sync", lastSync: latestTimestamp },
      update: { lastSync: latestTimestamp },
    });
  }

  console.log(`✅ Sync complete`);
}
```

## Idempotent Upsert Pattern

```typescript
// Idempotent sync - safe to run multiple times
async function syncUsersIdempotent(users: User[]) {
  for (const user of users) {
    await prisma.user.upsert({
      where: { id: user.id },
      create: user,
      update: {
        email: user.email,
        name: user.name,
        updated_at: user.updated_at,
      },
    });
  }
}

// Batch upsert for better performance
async function syncUsersBatch(users: User[]) {
  // PostgreSQL: Use ON CONFLICT
  await prisma.$executeRaw`
    INSERT INTO users (id, email, name, updated_at)
    SELECT * FROM UNNEST(
      ${users.map((u) => u.id)}::bigint[],
      ${users.map((u) => u.email)}::text[],
      ${users.map((u) => u.name)}::text[],
      ${users.map((u) => u.updated_at)}::timestamp[]
    )
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      updated_at = EXCLUDED.updated_at
    WHERE users.updated_at < EXCLUDED.updated_at
  `;
}
```

## Retry Logic with Exponential Backoff

```typescript
async function syncWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`  Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }

  throw new Error("Max retries exceeded");
}

// Usage
await syncWithRetry(
  async () => {
    return await syncOrders();
  },
  3,
  1000,
);
```

## Change Data Capture (CDC)

```typescript
// Listen to database changes
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// PostgreSQL: Listen to logical replication
async function setupCDC() {
  await prisma.$executeRaw`
    CREATE PUBLICATION orders_publication FOR TABLE orders;
  `;

  // Subscribe to changes (using pg library)
  const client = await pg.connect();

  client.query("LISTEN orders_changed;");

  client.on("notification", async (msg) => {
    const change = JSON.parse(msg.payload);

    if (change.operation === "INSERT" || change.operation === "UPDATE") {
      await syncOrder(change.data);
    }
  });
}
```

## Conflict Resolution

```typescript
interface ConflictResolution {
  strategy: "source-wins" | "dest-wins" | "latest-wins" | "merge";
}

async function syncWithConflictResolution(
  sourceRecord: any,
  destRecord: any,
  strategy: ConflictResolution["strategy"],
) {
  if (strategy === "source-wins") {
    return sourceRecord;
  }

  if (strategy === "dest-wins") {
    return destRecord;
  }

  if (strategy === "latest-wins") {
    return sourceRecord.updated_at > destRecord.updated_at ? sourceRecord : destRecord;
  }

  if (strategy === "merge") {
    // Merge non-null fields
    return {
      ...destRecord,
      ...Object.fromEntries(Object.entries(sourceRecord).filter(([_, v]) => v != null)),
    };
  }
}
```

## Monitoring & Observability

```typescript
// Track sync job metrics
interface SyncMetrics {
  jobName: string;
  startTime: Date;
  endTime: Date;
  recordsProcessed: number;
  recordsInserted: number;
  recordsUpdated: number;
  recordsSkipped: number;
  errors: number;
  durationMs: number;
}

async function logSyncMetrics(metrics: SyncMetrics) {
  await prisma.syncMetric.create({
    data: metrics,
  });

  console.log(`
📊 Sync Metrics
  Job: ${metrics.jobName}
  Records: ${metrics.recordsProcessed}
  Inserted: ${metrics.recordsInserted}
  Updated: ${metrics.recordsUpdated}
  Errors: ${metrics.errors}
  Duration: ${metrics.durationMs}ms
  `);
}
```

## Full ETL Job Example

```typescript
// jobs/sync-orders-to-warehouse.ts
export class OrdersETLJob extends ETLJob {
  constructor() {
    super("orders-etl", "orders_warehouse_sync");
  }

  async extract(since: Date): Promise<Order[]> {
    return prisma.order.findMany({
      where: {
        updated_at: { gt: since },
      },
      include: {
        items: true,
        user: true,
      },
      orderBy: { updated_at: "asc" },
    });
  }

  async transform(orders: Order[]): Promise<WarehouseOrder[]> {
    return orders.map((order) => ({
      order_id: order.id,
      user_email: order.user.email,
      total_amount: order.total,
      item_count: order.items.length,
      status: order.status,
      order_date: order.created_at,
      synced_at: new Date(),
    }));
  }

  async load(data: WarehouseOrder[]): Promise<void> {
    const batchSize = 100;

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);

      await warehouseDb.$executeRaw`
        INSERT INTO orders_fact (
          order_id, user_email, total_amount, item_count,
          status, order_date, synced_at
        )
        VALUES ${batch
          .map(
            (o) => `(
          ${o.order_id}, '${o.user_email}', ${o.total_amount},
          ${o.item_count}, '${o.status}', '${o.order_date}',
          '${o.synced_at}'
        )`,
          )
          .join(",")}
        ON CONFLICT (order_id) DO UPDATE SET
          total_amount = EXCLUDED.total_amount,
          status = EXCLUDED.status,
          synced_at = EXCLUDED.synced_at
      `;
    }
  }
}

// Run job
new OrdersETLJob().run();
```

## Scheduling

```typescript
// Schedule ETL jobs
import cron from "node-cron";

// Run every hour
cron.schedule("0 * * * *", async () => {
  await new OrdersETLJob().run();
});

// Run every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  await syncUsersIncremental();
});

// Run nightly at 2 AM
cron.schedule("0 2 * * *", async () => {
  await fullDataSync();
});
```

## Error Handling & Recovery

```typescript
async function syncWithErrorHandling() {
  const checkpoint = await getCheckpoint();
  let processedRecords = 0;

  try {
    const records = await fetchRecords(checkpoint);

    for (const record of records) {
      try {
        await processRecord(record);
        processedRecords++;

        // Save checkpoint every 100 records
        if (processedRecords % 100 === 0) {
          await saveCheckpoint(record.id);
        }
      } catch (error) {
        // Log error but continue
        console.error(`Failed to process record ${record.id}:`, error);
        await logFailedRecord(record.id, error);
      }
    }

    await saveCheckpoint("completed");
  } catch (error) {
    // Critical failure - job will retry from checkpoint
    console.error("Job failed:", error);
    throw error;
  }
}
```

## Best Practices

1. **Incremental sync**: Use watermarks, don't full-scan
2. **Idempotent operations**: Safe to retry
3. **Batch processing**: Process 100-1000 records at a time
4. **Checkpointing**: Resume from failure point
5. **Retry with backoff**: Handle transient failures
6. **Monitor metrics**: Track job health
7. **Test thoroughly**: Including failure scenarios

## Output Checklist

- [ ] ETL job class created
- [ ] Watermark tracking implemented
- [ ] Incremental sync logic
- [ ] Idempotent upsert operations
- [ ] Retry logic with backoff
- [ ] Conflict resolution strategy
- [ ] Monitoring and metrics
- [ ] Error handling and recovery
- [ ] Job scheduling configured
- [ ] Testing including failure cases
