---
name: "aurora-dsql"
displayName: "Deploy a distributed SQL database on AWS"
description: "PostgreSQL-compatible serverless distributed SQL database with Aurora DSQL - manage schemas, execute queries, and handle migrations with DSQL-specific constraints"
keywords: ["aurora", "dsql", "postgresql", "serverless", "database", "sql", "aws", "distributed"]
author: "Rolf Koski"
---

# Amazon Aurora DSQL Power

## Overview

The Amazon Aurora DSQL Power provides access to Aurora DSQL, a serverless, PostgreSQL-compatible distributed SQL database with specific constraints and capabilities. Execute queries, manage schemas, handle migrations, and work with multi-tenant data while respecting DSQL's unique limitations.

Aurora DSQL is a true serverless database with scale-to-zero capability, zero operations overhead, and consumption-based pricing. It uses the PostgreSQL wire protocol but has specific limitations around foreign keys, array types, JSON columns, and transaction sizes.

**Key capabilities:**
- **Direct Query Execution**: Run SQL queries directly against your DSQL cluster
- **Schema Management**: Create tables, indexes, and manage DDL operations
- **Migration Support**: Execute schema migrations with DSQL constraints
- **Multi-Tenant Patterns**: Built-in tenant isolation and data scoping
- **Token-Based Auth**: Automatic AWS IAM authentication with 15-minute tokens
- **Constraint Awareness**: Guidance on DSQL limitations and workarounds

**Authentication**: Uses AWS IAM credentials with automatic token generation.

## Available Steering Files

This power includes the following steering files:
- **dsql** - Critical constraints, operational rules, and DSQL mandates (always loaded)
- **dsql-examples** - Code examples and implementation patterns (load when implementing)

## Available MCP Servers

### aurora-dsql
**Package:** `awslabs.aurora-dsql-mcp-server@latest`
**Connection:** uvx-based MCP server
**Authentication:** AWS IAM credentials with automatic token generation

**Configuration Required:**
- `CLUSTER` - Your DSQL cluster identifier
- `REGION` - AWS region (e.g., us-east-1)
- `AWS_PROFILE` - AWS CLI profile name (optional, uses default if not set)

**Tools:**

1. **query** - Execute SQL queries against Aurora DSQL
   - Required: `sql` (string) - SQL query to execute
   - Optional: `parameters` (array) - Parameterized query values
   - Returns: Query results with rows and metadata
   - Use for: SELECT queries, data exploration, ad-hoc analysis

2. **execute** - Execute SQL statements (DDL/DML)
   - Required: `sql` (string) - SQL statement to execute
   - Optional: `parameters` (array) - Parameterized values
   - Returns: Execution result with affected rows
   - Use for: INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE

3. **list_tables** - List all tables in the database
   - Optional: `schema` (string) - Schema name (default: public)
   - Returns: Array of table names
   - Use for: Schema exploration, validation

4. **describe_table** - Get table schema details
   - Required: `table_name` (string) - Name of table to describe
   - Optional: `schema` (string) - Schema name (default: public)
   - Returns: Column definitions, types, constraints, indexes
   - Use for: Understanding table structure, planning migrations

### aws-core (Optional)
**Package:** `awslabs.core-mcp-server@latest`
**Connection:** uvx-based MCP server
**Authentication:** AWS IAM credentials

Provides additional AWS context and documentation access for DSQL operations.

## Tool Usage Examples

### Querying Data

**Simple SELECT query:**
```javascript
usePower("dsql", "aurora-dsql", "query", {
  "sql": "SELECT * FROM entities WHERE tenant_id = $1 LIMIT 10",
  "parameters": ["tenant-123"]
})
// Returns: { rows: [...], rowCount: 10 }
```

**Aggregate query:**
```javascript
usePower("dsql", "aurora-dsql", "query", {
  "sql": "SELECT tenant_id, COUNT(*) as count FROM objectives GROUP BY tenant_id"
})
```

**Join query (no foreign keys needed):**
```javascript
usePower("dsql", "aurora-dsql", "query", {
  "sql": `
    SELECT e.entity_id, e.name, o.title
    FROM entities e
    INNER JOIN objectives o ON e.entity_id = o.entity_id
    WHERE e.tenant_id = $1
  `,
  "parameters": ["tenant-123"]
})
```

### Schema Operations

**Create table with proper DSQL types:**
```javascript
usePower("dsql", "aurora-dsql", "execute", {
  "sql": `
    CREATE TABLE IF NOT EXISTS entities (
      entity_id VARCHAR(255) PRIMARY KEY,
      tenant_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      tags TEXT,
      metadata TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `
})
```

**Create async index (REQUIRED):**
```javascript
usePower("dsql", "aurora-dsql", "execute", {
  "sql": "CREATE INDEX ASYNC idx_entities_tenant ON entities(tenant_id)"
})
```

**Add column (one at a time):**
```javascript
// Step 1: Add column
usePower("dsql", "aurora-dsql", "execute", {
  "sql": "ALTER TABLE entities ADD COLUMN status VARCHAR(50)"
})

// Step 2: Set default values
usePower("dsql", "aurora-dsql", "execute", {
  "sql": "UPDATE entities SET status = 'active' WHERE status IS NULL"
})
```

### Data Manipulation

**Insert with tenant isolation:**
```javascript
usePower("dsql", "aurora-dsql", "execute", {
  "sql": `
    INSERT INTO entities (entity_id, tenant_id, name, tags)
    VALUES ($1, $2, $3, $4)
  `,
  "parameters": ["entity-456", "tenant-123", "My Entity", "tag1,tag2,tag3"]
})
```

**Batch update (under 3,000 row limit):**
```javascript
usePower("dsql", "aurora-dsql", "execute", {
  "sql": `
    UPDATE entities
    SET status = 'archived', updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = $1 AND created_at < $2
  `,
  "parameters": ["tenant-123", "2024-01-01"]
})
```

**Delete with validation:**
```javascript
// First check for dependents
const dependents = await usePower("dsql", "aurora-dsql", "query", {
  "sql": "SELECT COUNT(*) FROM objectives WHERE entity_id = $1 AND tenant_id = $2",
  "parameters": ["entity-456", "tenant-123"]
})

// Then delete if safe
if (dependents.rows[0].count === 0) {
  usePower("dsql", "aurora-dsql", "execute", {
    "sql": "DELETE FROM entities WHERE entity_id = $1 AND tenant_id = $2",
    "parameters": ["entity-456", "tenant-123"]
  })
}
```

### Schema Exploration

**List all tables:**
```javascript
usePower("dsql", "aurora-dsql", "list_tables", {})
// Returns: ["entities", "objectives", "key_results", ...]
```

**Describe table structure:**
```javascript
usePower("dsql", "aurora-dsql", "describe_table", {
  "table_name": "entities"
})
// Returns: { columns: [...], indexes: [...], constraints: [...] }
```

## Combining Tools (Workflows)

### Workflow 1: Create Multi-Tenant Schema

```javascript
// Step 1: Create main table
usePower("dsql", "aurora-dsql", "execute", {
  "sql": `
    CREATE TABLE IF NOT EXISTS entities (
      entity_id VARCHAR(255) PRIMARY KEY,
      tenant_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `
})

// Step 2: Create tenant index (ASYNC required)
usePower("dsql", "aurora-dsql", "execute", {
  "sql": "CREATE INDEX ASYNC idx_entities_tenant ON entities(tenant_id)"
})

// Step 3: Create composite index for common queries
usePower("dsql", "aurora-dsql", "execute", {
  "sql": "CREATE INDEX ASYNC idx_entities_tenant_created ON entities(tenant_id, created_at DESC)"
})

// Step 4: Verify schema
usePower("dsql", "aurora-dsql", "describe_table", {
  "table_name": "entities"
})
```

### Workflow 2: Safe Data Migration

```javascript
// Step 1: Add new column
usePower("dsql", "aurora-dsql", "execute", {
  "sql": "ALTER TABLE entities ADD COLUMN status VARCHAR(50)"
})

// Step 2: Populate with default (in batches if needed)
usePower("dsql", "aurora-dsql", "execute", {
  "sql": "UPDATE entities SET status = 'active' WHERE status IS NULL AND tenant_id = $1",
  "parameters": ["tenant-123"]
})

// Step 3: Verify migration
const result = await usePower("dsql", "aurora-dsql", "query", {
  "sql": "SELECT COUNT(*) as total, COUNT(status) as with_status FROM entities WHERE tenant_id = $1",
  "parameters": ["tenant-123"]
})

// Step 4: Create index for new column
usePower("dsql", "aurora-dsql", "execute", {
  "sql": "CREATE INDEX ASYNC idx_entities_status ON entities(tenant_id, status)"
})
```

### Workflow 3: Application-Layer Foreign Key Validation

```javascript
// Step 1: Validate parent exists
const parent = await usePower("dsql", "aurora-dsql", "query", {
  "sql": "SELECT entity_id FROM entities WHERE entity_id = $1 AND tenant_id = $2",
  "parameters": ["parent-123", "tenant-123"]
})

if (parent.rows.length === 0) {
  throw new Error("Invalid parent reference")
}

// Step 2: Insert child record
usePower("dsql", "aurora-dsql", "execute", {
  "sql": `
    INSERT INTO objectives (objective_id, entity_id, tenant_id, title)
    VALUES ($1, $2, $3, $4)
  `,
  "parameters": ["obj-456", "parent-123", "tenant-123", "My Objective"]
})
```

## Best Practices

### ✅ Do:

- **Execute queries directly** - Use MCP tools for ad-hoc queries, not temporary scripts
- **Always use ASYNC indexes** - `CREATE INDEX ASYNC` is mandatory
- **Validate references in code** - Foreign keys aren't enforced, validate in application
- **Serialize arrays/JSON as TEXT** - Store as comma-separated or JSON.stringify
- **Execute DDL individually** - One DDL statement per operation, no transactions
- **Include tenant_id everywhere** - First parameter in all queries for isolation
- **Batch under 3,000 rows** - Stay well under transaction limits
- **Generate fresh tokens** - Tokens expire in 15 minutes
- **Use parameterized queries** - Prevent SQL injection with $1, $2 placeholders
- **Check dependents before delete** - Implement cascade logic in application

### ❌ Don't:

- **Never rely on foreign keys** - They're not enforced in DSQL
- **Never use array/JSON columns** - Use TEXT with serialization instead
- **Never mix DDL statements** - Execute one at a time
- **Never use DEFAULT in ADD COLUMN** - Add column, then UPDATE separately
- **Never create synchronous indexes** - Must use ASYNC
- **Never cache tokens long-term** - 15-minute expiry
- **Never allow cross-tenant queries** - Always filter by tenant_id
- **Never use TRUNCATE** - Not supported, use DELETE
- **Never exceed 3,000 rows** - Per transaction limit
- **Never write throwaway scripts** - Execute queries directly

## Troubleshooting

### Error: "Foreign key constraint not supported"
**Cause:** Attempting to create FOREIGN KEY constraint
**Solution:**
1. Remove FOREIGN KEY from DDL
2. Implement validation in application code
3. Check parent exists before INSERT
4. Check dependents before DELETE

### Error: "Datatype array not supported"
**Cause:** Using TEXT[] or other array types
**Solution:**
1. Change column to TEXT
2. Store as comma-separated: `"tag1,tag2,tag3"`
3. Or use JSON.stringify: `"["tag1","tag2","tag3"]"`
4. Deserialize in application layer

### Error: "Please use CREATE INDEX ASYNC"
**Cause:** Creating index without ASYNC keyword
**Solution:**
```sql
-- Wrong
CREATE INDEX idx_name ON table(column);

-- Correct
CREATE INDEX ASYNC idx_name ON table(column);
```

### Error: "Transaction exceeds 3000 rows"
**Cause:** Modifying too many rows in single transaction
**Solution:**
1. Batch operations into chunks of 500-1000 rows
2. Process each batch separately
3. Add WHERE clause to limit scope

### Error: "Token has expired"
**Cause:** Authentication token older than 15 minutes
**Solution:**
1. Tokens auto-regenerate on each query
2. Don't cache connections longer than 15 minutes
3. Reconnect if seeing auth errors

### Error: "OC001 - Concurrent DDL operation"
**Cause:** Multiple DDL operations on same resource
**Solution:**
1. Wait for current DDL to complete
2. Retry with exponential backoff
3. Execute DDL operations sequentially

## Configuration

**Authentication Required**: AWS IAM credentials

**Environment Variables:**
- `CLUSTER` - Your DSQL cluster identifier (e.g., "abc123def456")
- `REGION` - AWS region (e.g., "us-east-1")
- `AWS_PROFILE` - AWS CLI profile (optional, uses default if not set)

**Setup Steps:**
1. Create Aurora DSQL cluster in AWS Console
2. Note your cluster identifier from the console
3. Ensure AWS credentials are configured (`aws configure`)
4. Install this power and configure environment variables
5. Test connection with `list_tables` tool

**Permissions Required:**
- `dsql:DbConnect` - Connect to DSQL cluster
- `dsql:DbConnectAdmin` - Admin access for DDL operations

**Database Name**: Always use `postgres` (only database available in DSQL)

## Critical DSQL Constraints

### Transaction Limits
- **3,000 rows** maximum per transaction
- **10 MiB** data size per write transaction
- **5 minutes** maximum duration
- **Repeatable Read** isolation only (cannot change)

### Unsupported Features
- Foreign key enforcement (can define but not enforced)
- Array column types (TEXT[], INTEGER[])
- JSON/JSONB columns
- Triggers and stored procedures
- Sequences (use UUIDs instead)
- TRUNCATE command
- Temporary tables
- Materialized views
- PostgreSQL extensions

### DDL Requirements
- One DDL statement per operation
- No DDL in transactions
- All indexes must use ASYNC
- Cannot add DEFAULT in ADD COLUMN
- Cannot add NOT NULL in ADD COLUMN
- No multi-column ALTER TABLE

### Connection Limits
- 15-minute token expiry
- 60-minute connection maximum
- 10,000 connections per cluster
- SSL required

## Tips

1. **Execute directly** - Use MCP tools for queries, not temporary scripts
2. **Read constraints first** - Check dsql.md steering file before schema changes
3. **Validate in application** - Implement foreign key logic in your code
4. **Serialize complex types** - Store arrays/JSON as TEXT
5. **Batch carefully** - Keep well under 3,000 row limit
6. **Index strategically** - Use ASYNC, focus on tenant_id and common filters
7. **Test migrations** - Verify DDL on dev cluster before production
8. **Monitor token expiry** - Reconnect if seeing auth errors
9. **Use partial indexes** - For sparse data with WHERE clause
10. **Plan for scale** - DSQL is built for massive scale, design accordingly

---

**Package:** awslabs.aurora-dsql-mcp-server
**Source:** AWS Labs
**License:** Apache-2.0