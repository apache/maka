---
name: sql-query-optimizer
description: Analyzes and optimizes SQL queries using EXPLAIN plans, index recommendations, query rewrites, and performance benchmarking. Use for "query optimization", "slow queries", "database performance", or "EXPLAIN analysis".
---

# SQL Query Optimizer

Optimize SQL queries for maximum performance.

## EXPLAIN Analysis

```sql
-- Original slow query
EXPLAIN ANALYZE
SELECT u.*, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01'
GROUP BY u.id
ORDER BY order_count DESC
LIMIT 10;

-- Output analysis:
/*
Sort  (cost=15234.32..15234.34 rows=10 width=120) (actual time=245.123..245.125 rows=10 loops=1)
  Sort Key: (count(o.id)) DESC
  ->  HashAggregate  (cost=15000.00..15100.00 rows=1000 width=120) (actual time=244.891..245.023 rows=1000 loops=1)
        Group Key: u.id
        ->  Hash Left Join  (cost=1234.56..14500.00 rows=50000 width=112) (actual time=12.345..230.456 rows=50000 loops=1)
              Hash Cond: (o.user_id = u.id)
              ->  Seq Scan on orders o  (cost=0.00..10000.00 rows=100000 width=8) (actual time=0.012..180.234 rows=100000 loops=1)
              ->  Hash  (cost=1000.00..1000.00 rows=5000 width=112) (actual time=10.234..10.234 rows=5000 loops=1)
                    Buckets: 8192  Batches: 1  Memory Usage: 456kB
                    ->  Seq Scan on users u  (cost=0.00..1000.00 rows=5000 width=112) (actual time=0.008..5.123 rows=5000 loops=1)
                          Filter: (created_at > '2024-01-01'::date)
                          Rows Removed by Filter: 1000
Planning Time: 0.234 ms
Execution Time: 245.234 ms
*/

-- Issues identified:
-- 1. Seq Scan on orders (no index on user_id)
-- 2. Seq Scan on users (no index on created_at)
-- 3. Full table scans expensive
```

## Index Recommendations

```sql
-- Problem: Sequential scans
EXPLAIN ANALYZE
SELECT * FROM orders WHERE user_id = 123;
/*
Seq Scan on orders  (cost=0.00..10000.00 rows=50 width=100) (actual time=0.012..89.456 rows=50 loops=1)
  Filter: (user_id = 123)
  Rows Removed by Filter: 99950
*/

-- Solution: Add index
CREATE INDEX idx_orders_user_id ON orders(user_id);

-- After index:
/*
Index Scan using idx_orders_user_id on orders  (cost=0.29..45.32 rows=50 width=100) (actual time=0.023..0.089 rows=50 loops=1)
  Index Cond: (user_id = 123)
*/

-- Performance: 89ms → 0.09ms (990x faster!)
```

## Query Rewrites

### 1. Avoid SELECT \*

```sql
-- ❌ Bad: Fetches all columns
SELECT * FROM users WHERE id = 123;

-- ✅ Good: Fetch only needed columns
SELECT id, email, name FROM users WHERE id = 123;

-- Performance: 50% faster, less network transfer
```

### 2. Use EXISTS Instead of IN

```sql
-- ❌ Slow: Subquery executed fully
SELECT * FROM users
WHERE id IN (SELECT user_id FROM orders WHERE total > 100);

-- ✅ Fast: Short-circuits on first match
SELECT * FROM users u
WHERE EXISTS (
  SELECT 1 FROM orders o
  WHERE o.user_id = u.id AND o.total > 100
);

-- Performance: 3x faster on large datasets
```

### 3. Avoid Functions on Indexed Columns

```sql
-- ❌ Bad: Index not used
SELECT * FROM users WHERE LOWER(email) = 'john@example.com';

-- ✅ Good: Index scan possible
SELECT * FROM users WHERE email = 'john@example.com';

-- Or create functional index:
CREATE INDEX idx_users_email_lower ON users(LOWER(email));
```

### 4. Use Covering Indexes

```sql
-- Query needs: id, email, name
SELECT id, email, name FROM users WHERE email = 'john@example.com';

-- Create covering index (includes all needed columns)
CREATE INDEX idx_users_email_covering ON users(email) INCLUDE (id, name);

-- Result: Index-only scan (no table access needed)
```

### 5. Optimize JOIN Order

```sql
-- ❌ Bad: Large table first
SELECT * FROM orders o
JOIN users u ON u.id = o.user_id
WHERE u.email = 'john@example.com';

-- ✅ Good: Filter first, join second
SELECT * FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.email = 'john@example.com';

-- Or use CTE for clarity:
WITH filtered_users AS (
  SELECT id FROM users WHERE email = 'john@example.com'
)
SELECT o.* FROM orders o
JOIN filtered_users u ON u.id = o.user_id;
```

## Composite Indexes

```sql
-- Query pattern: WHERE user_id = X AND status = 'active' ORDER BY created_at DESC
CREATE INDEX idx_orders_user_status_created
ON orders(user_id, status, created_at DESC);

-- Index column order matters!
-- Rule: Equality filters → Range filters → Sort columns

-- Example queries that use this index:
-- 1. SELECT * FROM orders WHERE user_id = 123;  ✅
-- 2. SELECT * FROM orders WHERE user_id = 123 AND status = 'active';  ✅
-- 3. SELECT * FROM orders WHERE user_id = 123 ORDER BY created_at DESC;  ✅
-- 4. SELECT * FROM orders WHERE status = 'active';  ❌ (doesn't start with user_id)
```

## Query Performance Benchmarking

```typescript
// scripts/benchmark-queries.ts
import { PrismaClient } from "@prisma/client";
import { performance } from "perf_hooks";

const prisma = new PrismaClient();

async function benchmarkQuery(name: string, query: () => Promise<any>, iterations: number = 10) {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await query();
    const end = performance.now();
    times.push(end - start);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`\n${name}:`);
  console.log(`  Avg: ${avg.toFixed(2)}ms`);
  console.log(`  Min: ${min.toFixed(2)}ms`);
  console.log(`  Max: ${max.toFixed(2)}ms`);

  return { avg, min, max };
}

// Compare queries
async function compareQueries() {
  console.log("🔍 Benchmarking queries...\n");

  // Query 1: Original
  const result1 = await benchmarkQuery("Original Query", async () => {
    return prisma.$queryRaw`
      SELECT u.*, COUNT(o.id) as order_count
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id
      GROUP BY u.id
      LIMIT 10
    `;
  });

  // Query 2: Optimized
  const result2 = await benchmarkQuery("Optimized Query", async () => {
    return prisma.$queryRaw`
      SELECT u.id, u.email, u.name,
             (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as order_count
      FROM users u
      LIMIT 10
    `;
  });

  // Comparison
  const improvement = (((result1.avg - result2.avg) / result1.avg) * 100).toFixed(1);
  console.log(`\n📊 Improvement: ${improvement}% faster`);
}

compareQueries();
```

## Query Optimization Checklist

```typescript
interface QueryOptimization {
  query: string;
  issues: string[];
  recommendations: string[];
  estimatedImprovement: string;
}

const optimizations: QueryOptimization[] = [
  {
    query: "SELECT * FROM orders WHERE user_id = $1",
    issues: ["Missing index on user_id", "SELECT * fetches unnecessary columns"],
    recommendations: [
      "CREATE INDEX idx_orders_user_id ON orders(user_id)",
      "SELECT id, total, status instead of *",
    ],
    estimatedImprovement: "90% faster",
  },
  {
    query: "SELECT COUNT(*) FROM orders",
    issues: ["Full table scan", "No WHERE clause filtering"],
    recommendations: [
      "Add WHERE clause to filter rows",
      "Consider approximate count for large tables",
    ],
    estimatedImprovement: "70% faster",
  },
];
```

## Automated Slow Query Detection

```typescript
// scripts/detect-slow-queries.ts
async function detectSlowQueries() {
  // Enable slow query logging in PostgreSQL
  await prisma.$executeRaw`
    ALTER DATABASE mydb SET log_min_duration_statement = 100;
  `;

  // Query pg_stat_statements for slow queries
  const slowQueries = await prisma.$queryRaw<any[]>`
    SELECT
      query,
      calls,
      total_exec_time / 1000 as total_time_seconds,
      mean_exec_time / 1000 as mean_time_ms,
      max_exec_time / 1000 as max_time_ms
    FROM pg_stat_statements
    WHERE mean_exec_time > 100  -- > 100ms
    ORDER BY mean_exec_time DESC
    LIMIT 20
  `;

  console.log("🐌 Slow Queries Detected:\n");
  slowQueries.forEach((q, i) => {
    console.log(`${i + 1}. ${q.query.substring(0, 80)}...`);
    console.log(`   Calls: ${q.calls}`);
    console.log(`   Avg: ${q.mean_time_ms.toFixed(2)}ms`);
    console.log(`   Max: ${q.max_time_ms.toFixed(2)}ms\n`);
  });
}
```

## Best Practices

1. **Always use EXPLAIN**: Understand query plans
2. **Index foreign keys**: Essential for joins
3. **Avoid SELECT \***: Fetch only needed columns
4. **Use composite indexes**: Multi-column queries
5. **Consider covering indexes**: Eliminate table access
6. **Batch operations**: Reduce round trips
7. **Monitor regularly**: Track slow queries

## Output Checklist

- [ ] EXPLAIN plan analyzed
- [ ] Missing indexes identified
- [ ] Query rewrite suggestions
- [ ] Performance benchmarks
- [ ] Before/after metrics
- [ ] Index creation scripts
- [ ] Slow query monitoring
- [ ] Optimization priority list
