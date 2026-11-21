---
name: db-performance-watchlist
description: Defines database performance monitoring strategy with slow query detection, resource usage alerts, query execution thresholds, and automated alerting. Use for "database monitoring", "performance alerts", "slow queries", or "DB metrics".
---

# DB Performance Watchlist

Monitor database performance and prevent regressions.

## Key Performance Metrics

```typescript
// performance-metrics.ts
export interface DBMetrics {
  // Query Performance
  slowQueries: {
    threshold: number; // ms
    count: number;
    queries: SlowQuery[];
  };

  // Connection Pool
  connections: {
    active: number;
    idle: number;
    total: number;
    maxConnections: number;
    utilizationPercent: number;
  };

  // Resource Usage
  resources: {
    cpuPercent: number;
    memoryPercent: number;
    diskUsagePercent: number;
    iops: number;
  };

  // Query Statistics
  queryStats: {
    selectsPerSecond: number;
    insertsPerSecond: number;
    updatesPerSecond: number;
    deletesPerSecond: number;
  };

  // Cache Performance
  cache: {
    hitRate: number; // %
    size: number; // MB
    evictions: number;
  };

  // Index Usage
  indexes: {
    unusedIndexes: string[];
    missingIndexes: string[];
  };
}

interface SlowQuery {
  query: string;
  duration: number;
  calls: number;
  avgDuration: number;
  table: string;
}
```

## Slow Query Detection

```typescript
// scripts/detect-slow-queries.ts
async function detectSlowQueries(thresholdMs: number = 100) {
  // Enable slow query logging (PostgreSQL)
  await prisma.$executeRaw`
    ALTER DATABASE mydb
    SET log_min_duration_statement = ${thresholdMs};
  `;

  // Query pg_stat_statements for slow queries
  const slowQueries = await prisma.$queryRaw<SlowQuery[]>`
    SELECT
      query,
      calls,
      total_exec_time / 1000 as total_time_ms,
      mean_exec_time / 1000 as avg_time_ms,
      max_exec_time / 1000 as max_time_ms,
      (total_exec_time / sum(total_exec_time) OVER()) * 100 as percent_of_total
    FROM pg_stat_statements
    WHERE mean_exec_time > ${thresholdMs}
    ORDER BY mean_exec_time DESC
    LIMIT 20
  `;

  console.log("🐌 Slow Queries Detected:\n");

  slowQueries.forEach((q, i) => {
    console.log(`${i + 1}. ${q.query.substring(0, 80)}...`);
    console.log(`   Calls: ${q.calls}`);
    console.log(`   Avg: ${q.avg_time_ms.toFixed(2)}ms`);
    console.log(`   Max: ${q.max_time_ms.toFixed(2)}ms`);
    console.log(`   % of total time: ${q.percent_of_total.toFixed(1)}%\n`);
  });

  return slowQueries;
}
```

## Connection Pool Monitoring

```typescript
async function monitorConnectionPool() {
  const stats = await prisma.$queryRaw<any[]>`
    SELECT
      sum(numbackends) as total_connections,
      sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END) as active,
      sum(CASE WHEN state = 'idle' THEN 1 ELSE 0 END) as idle,
      max_connections
    FROM pg_stat_database
    CROSS JOIN (SELECT setting::int as max_connections FROM pg_settings WHERE name = 'max_connections')
    WHERE datname = current_database()
    GROUP BY max_connections
  `;

  const { total_connections, active, idle, max_connections } = stats[0];
  const utilization = (total_connections / max_connections) * 100;

  console.log("🔌 Connection Pool Status:");
  console.log(`  Total: ${total_connections}/${max_connections} (${utilization.toFixed(1)}%)`);
  console.log(`  Active: ${active}`);
  console.log(`  Idle: ${idle}`);

  // Alert if > 80% utilization
  if (utilization > 80) {
    console.warn("⚠️  Connection pool >80% utilized!");
    await sendAlert({
      title: "High connection pool usage",
      message: `${utilization.toFixed(1)}% of connections in use`,
    });
  }
}
```

## Resource Monitoring

```typescript
async function monitorResources() {
  // CPU Usage
  const cpuStats = await prisma.$queryRaw<any[]>`
    SELECT
      (sum(total_exec_time) / (extract(epoch from (now() - stats_reset)) * 1000 * 100)) as cpu_percent
    FROM pg_stat_statements, pg_stat_database
    WHERE datname = current_database()
  `;

  // Memory Usage
  const memStats = await prisma.$queryRaw<any[]>`
    SELECT
      pg_size_pretty(pg_database_size(current_database())) as db_size,
      pg_size_pretty(sum(pg_relation_size(schemaname||'.'||tablename))) as tables_size
    FROM pg_tables
    WHERE schemaname = 'public'
  `;

  // Cache Hit Rate
  const cacheStats = await prisma.$queryRaw<any[]>`
    SELECT
      sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) * 100 as cache_hit_rate
    FROM pg_statio_user_tables
  `;

  console.log("📊 Resource Usage:");
  console.log(`  CPU: ${cpuStats[0].cpu_percent.toFixed(1)}%`);
  console.log(`  Database Size: ${memStats[0].db_size}`);
  console.log(`  Cache Hit Rate: ${cacheStats[0].cache_hit_rate.toFixed(1)}%`);

  // Alert if cache hit rate < 90%
  if (cacheStats[0].cache_hit_rate < 90) {
    console.warn("⚠️  Cache hit rate below 90%!");
    await sendAlert({
      title: "Low cache hit rate",
      message: `Cache hit rate: ${cacheStats[0].cache_hit_rate.toFixed(1)}%`,
    });
  }
}
```

## Index Usage Analysis

```typescript
async function analyzeIndexUsage() {
  // Find unused indexes
  const unusedIndexes = await prisma.$queryRaw<any[]>`
    SELECT
      schemaname,
      tablename,
      indexname,
      idx_scan
    FROM pg_stat_user_indexes
    WHERE idx_scan = 0
    AND indexname NOT LIKE '%_pkey'
    ORDER BY pg_relation_size(indexrelid) DESC
  `;

  console.log("🗂️  Unused Indexes:\n");
  unusedIndexes.forEach((idx) => {
    console.log(`  ${idx.tablename}.${idx.indexname} (0 scans)`);
  });

  // Find missing indexes (sequential scans on large tables)
  const missingIndexes = await prisma.$queryRaw<any[]>`
    SELECT
      schemaname,
      tablename,
      seq_scan,
      seq_tup_read,
      idx_scan,
      n_live_tup
    FROM pg_stat_user_tables
    WHERE seq_scan > 1000
    AND n_live_tup > 10000
    ORDER BY seq_scan * n_live_tup DESC
    LIMIT 10
  `;

  console.log("\n📉 Tables with High Sequential Scans:\n");
  missingIndexes.forEach((table) => {
    console.log(`  ${table.tablename}:`);
    console.log(`    Sequential scans: ${table.seq_scan}`);
    console.log(`    Rows: ${table.n_live_tup}`);
    console.log(`    Index scans: ${table.idx_scan}`);
  });
}
```

## Alert Thresholds

```typescript
const ALERT_THRESHOLDS = {
  slowQuery: {
    avgDuration: 500, // ms
    maxDuration: 2000, // ms
    callsPerMinute: 100,
  },
  connections: {
    utilizationWarning: 70, // %
    utilizationCritical: 85, // %
  },
  resources: {
    cpuWarning: 70, // %
    cpuCritical: 85, // %
    memoryWarning: 80, // %
    memoryCritical: 90, // %
    diskWarning: 75, // %
    diskCritical: 85, // %
  },
  cache: {
    hitRateWarning: 90, // %
    hitRateCritical: 80, // %
  },
  queryRate: {
    maxSelectsPerSecond: 10000,
    maxWritesPerSecond: 1000,
  },
};

async function checkThresholds() {
  const metrics = await gatherMetrics();

  // Check slow queries
  if (metrics.slowQueries.count > 10) {
    await sendAlert({
      level: "warning",
      title: "Slow queries detected",
      message: `${metrics.slowQueries.count} queries exceeding ${ALERT_THRESHOLDS.slowQuery.avgDuration}ms`,
    });
  }

  // Check connection pool
  if (metrics.connections.utilizationPercent > ALERT_THRESHOLDS.connections.utilizationCritical) {
    await sendAlert({
      level: "critical",
      title: "Connection pool critical",
      message: `${metrics.connections.utilizationPercent.toFixed(1)}% utilization`,
    });
  }

  // Check cache hit rate
  if (metrics.cache.hitRate < ALERT_THRESHOLDS.cache.hitRateCritical) {
    await sendAlert({
      level: "critical",
      title: "Cache hit rate critical",
      message: `${metrics.cache.hitRate.toFixed(1)}% hit rate`,
    });
  }
}
```

## Monitoring Dashboard

```typescript
// Generate monitoring report
async function generatePerformanceReport() {
  console.log("📊 Database Performance Report\n");
  console.log("=".repeat(50) + "\n");

  // Slow queries
  const slowQueries = await detectSlowQueries(100);
  console.log(`Slow Queries (>100ms): ${slowQueries.length}\n`);

  // Connection pool
  await monitorConnectionPool();
  console.log();

  // Resources
  await monitorResources();
  console.log();

  // Index usage
  await analyzeIndexUsage();
  console.log();

  // Query rates
  const queryStats = await prisma.$queryRaw<any[]>`
    SELECT
      sum(xact_commit + xact_rollback) as transactions,
      sum(tup_returned) as rows_read,
      sum(tup_inserted) as rows_inserted,
      sum(tup_updated) as rows_updated,
      sum(tup_deleted) as rows_deleted
    FROM pg_stat_database
    WHERE datname = current_database()
  `;

  console.log("📈 Query Statistics:");
  console.log(`  Transactions: ${queryStats[0].transactions}`);
  console.log(`  Rows read: ${queryStats[0].rows_read}`);
  console.log(`  Rows inserted: ${queryStats[0].rows_inserted}`);
  console.log(`  Rows updated: ${queryStats[0].rows_updated}`);
  console.log(`  Rows deleted: ${queryStats[0].rows_deleted}`);
}
```

## Automated Monitoring Script

```typescript
// scripts/monitor-db.ts
import cron from "node-cron";

// Run every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  await checkThresholds();
});

// Generate report every hour
cron.schedule("0 * * * *", async () => {
  await generatePerformanceReport();
});

// Analyze indexes weekly
cron.schedule("0 0 * * 0", async () => {
  await analyzeIndexUsage();
});
```

## Grafana Dashboard Queries

```sql
-- Query latency over time
SELECT
  bucket,
  AVG(mean_exec_time) as avg_latency,
  MAX(max_exec_time) as max_latency,
  SUM(calls) as total_calls
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
GROUP BY time_bucket('5 minutes', queryid)
ORDER BY bucket;

-- Connection count over time
SELECT
  now() as time,
  count(*) as total,
  count(*) FILTER (WHERE state = 'active') as active,
  count(*) FILTER (WHERE state = 'idle') as idle
FROM pg_stat_activity;

-- Cache hit rate
SELECT
  sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) * 100 as cache_hit_rate
FROM pg_statio_user_tables;
```

## Best Practices

1. **Monitor continuously**: Don't wait for problems
2. **Set appropriate thresholds**: Based on your SLAs
3. **Alert on trends**: Not just absolute values
4. **Review regularly**: Weekly performance reviews
5. **Automate everything**: No manual checks
6. **Document baselines**: Know what's normal
7. **Test alerts**: Ensure they work

## Output Checklist

- [ ] Slow query detection configured
- [ ] Connection pool monitoring
- [ ] Resource usage tracking
- [ ] Cache hit rate monitoring
- [ ] Index usage analysis
- [ ] Alert thresholds defined
- [ ] Monitoring dashboard setup
- [ ] Automated checks scheduled
- [ ] Grafana/alerting integration
- [ ] Performance baseline documented
