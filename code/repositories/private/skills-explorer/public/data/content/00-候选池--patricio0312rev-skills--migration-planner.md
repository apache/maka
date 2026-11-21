---
name: migration-planner
description: Builds phased data and system migrations using feature flags, dual writes, backfills, and validation. Includes rollback plans and risk mitigation. Use for "data migration", "system migration", "database migration", or "platform migration".
---

# Migration Planner

Execute safe, zero-downtime migrations with validation and rollback plans.

## Migration Patterns

### 1. Feature Flag Migration (Safest)

```
Phase 1: Deploy new code (disabled)
Phase 2: Enable for 1% traffic
Phase 3: Ramp to 10%, 50%, 100%
Phase 4: Remove old code
```

### 2. Dual Write Migration

```
Phase 1: Write to both old and new
Phase 2: Backfill old → new
Phase 3: Read from new (write both)
Phase 4: Stop writing to old
Phase 5: Decommission old
```

### 3. Blue-Green Deployment

```
Blue (current) → Green (new)
Switch traffic: Blue → Green
Rollback available: Green → Blue
```

## Complete Migration Plan Template

````markdown
# Migration Plan: MySQL → PostgreSQL

## Overview

**What:** Migrate user database from MySQL to PostgreSQL
**Why:** Better JSON support, improved performance
**When:** Q1 2024
**Owner:** Database Team
**Risk Level:** HIGH

## Current State

- MySQL 8.0
- 500GB data
- 100K users
- 1000 writes/min
- 10,000 reads/min

## Target State

- PostgreSQL 15
- Same data model
- No downtime
- Data validation 100% match

## Phases

### Phase 1: Dual Write (Week 1-2)

**Goal:** Write to both databases

**Steps:**

1. Deploy PostgreSQL cluster
2. Create schema in PostgreSQL
3. Deploy dual-write code
4. Enable dual writes (MySQL primary, PostgreSQL secondary)

**Code:**

```typescript
async function createUser(data: CreateUserDto) {
  // Write to MySQL (primary)
  const mysqlUser = await mysql.users.create(data);

  // Write to PostgreSQL (secondary, fire and forget)
  postgres.users.create(data).catch((err) => {
    logger.error("PostgreSQL write failed", err);
  });

  return mysqlUser; // Still trust MySQL
}
```
````

**Validation:**

- Monitor PostgreSQL write success rate
- Compare row counts daily
- Alert if drift >0.1%

**Rollback:** Disable PostgreSQL writes

### Phase 2: Backfill (Week 3-4)

**Goal:** Copy historical data

**Steps:**

1. Take MySQL snapshot
2. Run backfill script in batches
3. Validate data integrity
4. Resume from failure automatically

**Script:**

```python
def backfill():
    last_id = get_last_migrated_id()
    batch_size = 1000

    while True:
        users = mysql.query(
            "SELECT * FROM users WHERE id > %s LIMIT %s",
            [last_id, batch_size]
        )

        if not users:
            break

        postgres.bulk_insert(users)
        last_id = users[-1]['id']
        save_checkpoint(last_id)

        time.sleep(0.1)  # Rate limit
```

**Validation:**

- Row count match
- Random sample comparison (1000 rows)
- Checksum comparison

**Rollback:** Delete PostgreSQL data

### Phase 3: Dual Read (Week 5)

**Goal:** Validate PostgreSQL reads

**Steps:**

1. Deploy shadow read code
2. Read from both (MySQL primary)
3. Compare results
4. Log mismatches

**Code:**

```typescript
async function getUser(id: string) {
  const mysqlUser = await mysql.users.findById(id);

  // Shadow read from PostgreSQL
  postgres.users.findById(id).then((pgUser) => {
    if (!deepEqual(mysqlUser, pgUser)) {
      logger.warn("Data mismatch", { id, mysqlUser, pgUser });
      metrics.increment("migration.mismatch");
    }
  });

  return mysqlUser; // Still trust MySQL
}
```

**Validation:**

- Mismatch rate <0.01%
- PostgreSQL query performance acceptable

**Rollback:** Remove shadow reads

### Phase 4: Flip Read Traffic (Week 6)

**Goal:** Read from PostgreSQL

**Steps:**

1. Feature flag: read from PostgreSQL (1% traffic)
2. Monitor errors, latency
3. Ramp: 1% → 10% → 50% → 100%
4. Still writing to both

**Code:**

```typescript
async function getUser(id: string) {
  if (featureFlags.readFromPostgres) {
    return postgres.users.findById(id);
  }
  return mysql.users.findById(id);
}
```

**Validation:**

- Error rate unchanged
- Latency p95 <500ms
- No user complaints

**Rollback:** Flip feature flag off

### Phase 5: Stop MySQL Writes (Week 7)

**Goal:** PostgreSQL is now primary

**Steps:**

1. Stop writing to MySQL
2. Keep MySQL running (read-only)
3. Monitor for issues

**Code:**

```typescript
async function createUser(data: CreateUserDto) {
  return postgres.users.create(data);
  // No longer writing to MySQL
}
```

**Validation:**

- All operations working
- MySQL not receiving writes

**Rollback:** Re-enable MySQL writes

### Phase 6: Decommission (Week 8)

**Goal:** Remove MySQL

**Steps:**

1. Archive MySQL data
2. Shutdown MySQL cluster
3. Remove MySQL client code

**Rollback:** Not available (point of no return)

## Validation Strategy

### Data Integrity Checks

```python
def validate_migration():
    # Row counts
    mysql_count = mysql.query("SELECT COUNT(*) FROM users")[0]
    pg_count = postgres.query("SELECT COUNT(*) FROM users")[0]
    assert mysql_count == pg_count

    # Random sampling
    sample = mysql.query("SELECT * FROM users ORDER BY RAND() LIMIT 1000")
    for row in sample:
        pg_row = postgres.query("SELECT * FROM users WHERE id = %s", [row['id']])
        assert row == pg_row

    # Checksums
    mysql_checksum = mysql.query("SELECT MD5(GROUP_CONCAT(id, email)) FROM users")
    pg_checksum = postgres.query("SELECT MD5(STRING_AGG(id::text || email, '')) FROM users")
    assert mysql_checksum == pg_checksum
```

## Rollback Plans

### Phase 1-3 Rollback (Easy)

- Disable PostgreSQL writes
- No impact to users
- Data in MySQL still valid

### Phase 4 Rollback (Medium)

- Flip feature flag
- Route reads back to MySQL
- Minor user impact (seconds)

### Phase 5+ Rollback (Hard)

- Must re-enable MySQL writes
- Potential data loss (writes since phase 5)
- Requires dual-write resumption

## Risk Mitigation

### Risk 1: Data Loss

**Mitigation:**

- Dual writes until validated
- Transaction logs captured
- Continuous backups

### Risk 2: Performance Degradation

**Mitigation:**

- Load test PostgreSQL
- Query optimization
- Connection pooling

### Risk 3: Schema Differences

**Mitigation:**

- Schema validation script
- Test migrations in staging
- Document data type differences

## Communication Plan

### Stakeholder Updates

```markdown
**Week 0:** Migration announced
**Week 2:** Phase 1 complete (dual writes)
**Week 4:** Backfill complete
**Week 6:** Traffic shifted to PostgreSQL
**Week 8:** Migration complete
```

### Status Dashboard

- Current phase
- Data sync status (%)
- Validation results
- Error rates

## Testing Plan

### Pre-Migration Testing

1. Test in development
2. Full migration in staging
3. Load test PostgreSQL
4. Validate rollback procedures

### During Migration

1. Continuous monitoring
2. Automated validation
3. Manual spot checks
4. User acceptance testing

## Best Practices

1. **Small batches**: Migrate incrementally
2. **Dual write**: Keep both systems synchronized
3. **Feature flags**: Control rollout
4. **Validate continuously**: Don't trust, verify
5. **Rollback ready**: Plan for worst case
6. **Monitor closely**: Track metrics
7. **Communicate often**: Keep stakeholders informed

## Output Checklist

- [ ] Migration phases defined (5-7 phases)
- [ ] Dual write implementation
- [ ] Backfill script ready
- [ ] Validation strategy
- [ ] Feature flags configured
- [ ] Rollback plans per phase
- [ ] Risk mitigation strategies
- [ ] Communication plan
- [ ] Monitoring dashboard
- [ ] Testing checklist
