# Aurora DSQL Strategic Mandate

## Non-Negotiable Decision

**Aurora DSQL is the MANDATORY relational database.** This decision is final and not subject to debate.

### Prohibited Alternatives
- ❌ **NEVER propose removing DSQL** due to constraints (e.g., lack of foreign keys)
- ❌ **NEVER suggest** RDS PostgreSQL, Aurora Serverless v1/v2, or any other database
- ❌ **NEVER implement** workarounds using different databases
- ❌ **ALWAYS adapt** application code to work within DSQL constraints

---

## Critical Constraints

### Transaction Limits
- **3,000 row modifications** per transaction maximum
- **10 MiB data size** per write transaction
- **5-minute duration** maximum per transaction
- **Repeatable Read isolation** only (fixed, cannot change)

### DDL Restrictions
- **One DDL per transaction** - Never mix DDL statements
- **No DDL/DML mixing** - Separate schema changes from data changes
- **No rollback** - DDL changes are permanent
- **Async execution** - All DDL runs asynchronously
- **No transactions** - Execute each DDL individually

### Unsupported PostgreSQL Features

#### Critical Missing Features
- **NO Foreign Key enforcement** (can define but not enforced)
- **NO Arrays as column types** (use TEXT with serialization)
- **NO JSON/JSONB columns** (store as TEXT)
- **NO Triggers**
- **NO Stored Procedures** (PL/pgSQL not supported)
- **NO Sequences** (use UUIDs)
- **NO TRUNCATE**
- **NO Temporary tables**
- **NO Materialized views**
- **NO Extensions** (PostGIS, PGVector, etc.)

#### ALTER TABLE Limitations
- **One column at a time** - No multi-column ALTER
- **No DEFAULT in ADD COLUMN** - Add column, then UPDATE
- **No NOT NULL in ADD COLUMN** - Add nullable, handle in app
- **No DROP CONSTRAINT** - Constraints are permanent

#### Index Requirements
- **MUST use CREATE INDEX ASYNC** - No synchronous creation
- **24 indexes per table** maximum
- **8 columns per index** maximum

### Connection Management
- **15-minute token expiry** - Generate fresh tokens
- **SSL required** - All connections must use SSL
- **60-minute connection limit** - Maximum connection duration

---

## Operational Rules

### Query Execution (CRITICAL)

**For Ad-Hoc Queries and Data Exploration:**
- ✅ Execute DIRECTLY using MCP server or psql one-liners
- ✅ Return results immediately
- ❌ **NEVER write temporary .ts/.js/.sql files** for ad-hoc queries

**When to Write Scripts:**
- ✅ Permanent migrations in database/migrations
- ✅ Reusable database utilities
- ✅ When user EXPLICITLY asks for a script

**When NOT to Write Scripts:**
- ❌ Ad-hoc data queries
- ❌ Exploring database contents
- ❌ One-time data verification
- ❌ Testing query performance

### Schema Design Rules

- Use simple PostgreSQL types: VARCHAR, TEXT, INTEGER, BOOLEAN, TIMESTAMP
- Store arrays as TEXT (comma-separated or JSON.stringify)
- Store JSON objects as TEXT
- Always include tenant_id in tables for multi-tenant isolation
- Create async indexes for tenant_id and common query patterns
- Use partial indexes for sparse data (WHERE column IS NOT NULL)

### Application-Layer Patterns

**MANDATORY for Referential Integrity:**
- Validate parent references before INSERT
- Check for dependents before DELETE
- Implement cascade logic in application code
- Handle orphaned records in application layer

**MANDATORY for Multi-Tenant Isolation:**
- tenantId is ALWAYS first parameter in repository methods
- ALL queries include WHERE tenant_id = ?
- NEVER allow cross-tenant data access
- Validate tenant ownership before operations

### Migration Patterns

- One DDL statement per migration step
- Use IF NOT EXISTS for idempotency
- Add column first, then UPDATE with defaults
- Cannot use DEFAULT or NOT NULL in ADD COLUMN
- Each DDL executes separately (no BEGIN/COMMIT)

---

## Best Practices

### Do's ✅
- Execute queries directly (MCP server or psql)
- Always use ASYNC for indexes
- Validate references in application code
- Serialize arrays/JSON as TEXT
- Execute DDL individually
- Generate fresh tokens for connections
- Batch under 3,000 rows per transaction
- Include tenant_id in all queries

### Don'ts ❌
- Never propose removing DSQL
- Never create throwaway scripts for queries
- Never rely on foreign keys
- Never use array/JSON column types
- Never mix DDL statements
- Never cache tokens beyond 15 minutes
- Never allow cross-tenant queries
- Never use TRUNCATE

---

## Quick Reference

### Schema Operations
```sql
CREATE INDEX ASYNC idx_name ON table(column);         ← ALWAYS ASYNC
ALTER TABLE t ADD COLUMN c VARCHAR(50);                ← ONE AT A TIME
ALTER TABLE t ADD COLUMN c2 INTEGER;                   ← SEPARATE STATEMENT
UPDATE table SET c = 'default' WHERE c IS NULL;        ← AFTER ADD COLUMN
```

### Data Types
```
✅ VARCHAR, TEXT, INTEGER, DECIMAL, BOOLEAN, TIMESTAMP, UUID
❌ TEXT[], JSON, JSONB (use TEXT + app serialization)
```

### Constraints
```
✅ PRIMARY KEY, UNIQUE, NOT NULL, CHECK, DEFAULT (in CREATE TABLE)
❌ FOREIGN KEY (not enforced), NO DEFAULT in ADD COLUMN
```

### Transaction Limits
```
Rows: 3,000 max
Size: 10 MiB max
Duration: 5 minutes max
Isolation: Repeatable Read (fixed)
```