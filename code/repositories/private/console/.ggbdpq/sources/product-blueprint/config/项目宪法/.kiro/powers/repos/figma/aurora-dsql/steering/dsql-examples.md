# Aurora DSQL Implementation Examples

This file contains code examples for working with Aurora DSQL. Only load this when actively implementing database code.

For constraints and mandates, see [steering.md](./steering.md).

---

## Query Execution

### Direct psql Execution (Ad-Hoc Queries)

```bash
# Direct query execution
PGPASSWORD="$(aws dsql generate-db-connect-admin-auth-token \
  --hostname ${CLUSTER}.dsql.${REGION}.on.aws \
  --region ${REGION})" \
psql -h ${CLUSTER}.dsql.${REGION}.on.aws -U admin -d postgres \
  -c "SELECT COUNT(*) FROM objectives WHERE tenant_id = 'tenant-123';"

# List tables
PGPASSWORD="$(aws dsql generate-db-connect-admin-auth-token \
  --hostname ${CLUSTER}.dsql.${REGION}.on.aws \
  --region ${REGION})" \
psql -h ${CLUSTER}.dsql.${REGION}.on.aws -U admin -d postgres \
  -c "\dt"

# Query with formatting
PGPASSWORD="$TOKEN" psql -h ${CLUSTER}.dsql.${REGION}.on.aws \
  -U admin -d postgres \
  -c "SELECT tenant_id, COUNT(*) as count FROM objectives GROUP BY tenant_id;"
```

---

## Schema Design

### Table Creation

```sql
-- Correct: Simple types, tenant isolation
CREATE TABLE entities (
  entity_id VARCHAR(255) PRIMARY KEY,
  tenant_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  tags TEXT,                    -- NOT array type
  metadata TEXT,                -- NOT json/jsonb
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP
);

-- Async indexes (always)
CREATE INDEX ASYNC idx_entities_tenant ON entities(tenant_id);
CREATE INDEX ASYNC idx_entities_tenant_name ON entities(tenant_id, name);
CREATE INDEX ASYNC idx_entities_created ON entities(tenant_id, created_at DESC);

-- Partial index for sparse data
CREATE INDEX ASYNC idx_entities_deleted
  ON entities(tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL;
```

### ALTER TABLE Operations

```sql
-- Correct: One column at a time
ALTER TABLE entities ADD COLUMN status VARCHAR(50);
ALTER TABLE entities ADD COLUMN priority INTEGER;
ALTER TABLE entities ADD COLUMN description TEXT;

-- Wrong examples (for reference)
-- ALTER TABLE entities ADD COLUMN col1 TEXT, ADD COLUMN col2 TEXT;  -- No multi-column
-- ALTER TABLE entities ADD COLUMN status VARCHAR(50) DEFAULT 'active';  -- No DEFAULT
-- CREATE INDEX idx_sync ON entities(name);  -- Must be ASYNC
```

### Setting Column Defaults

```sql
-- Pattern: Add column, then update
ALTER TABLE entities ADD COLUMN status VARCHAR(50);
UPDATE entities SET status = 'active' WHERE status IS NULL;

-- For NOT NULL, handle in application layer (cannot alter existing column)
```

---

## Application-Layer Referential Integrity

### Repository Pattern with Validation

```typescript
class EntityRepository {
  async create(tenantId: string, data: CreateEntityRequest) {
    // MANDATORY: Validate parent reference
    if (data.parentId) {
      const parent = await this.findById(tenantId, data.parentId);
      if (!parent) {
        throw new Error('Invalid parent reference');
      }
    }

    // MANDATORY: Validate category reference
    if (data.categoryId) {
      const category = await this.categoryRepo.findById(
        tenantId,
        data.categoryId
      );
      if (!category) {
        throw new Error('Invalid category reference');
      }
    }

    return await this.insert(tenantId, data);
  }

  async delete(tenantId: string, id: string) {
    // MANDATORY: Check for dependent records
    const children = await this.findByParentId(tenantId, id);
    if (children.length > 0) {
      throw new Error(
        `Cannot delete entity: has ${children.length} dependent records`
      );
    }

    const references = await this.findReferences(tenantId, id);
    if (references.length > 0) {
      throw new Error('Cannot delete: entity is referenced by other records');
    }

    return await this.deleteById(tenantId, id);
  }

  private async findReferences(tenantId: string, entityId: string) {
    // Check all tables that might reference this entity
    const tables = ['objectives', 'key_results', 'initiatives'];
    const references = [];

    for (const table of tables) {
      const result = await this.query(
        `SELECT COUNT(*) as count FROM ${table}
         WHERE tenant_id = $1 AND entity_id = $2`,
        [tenantId, entityId]
      );
      if (result.rows[0].count > 0) {
        references.push({ table, count: result.rows[0].count });
      }
    }

    return references;
  }
}
```

---

## Data Serialization

### Array and JSON Serialization

```typescript
class DataSerializer {
  // Array serialization (comma-separated)
  static serializeArray(items: string[]): string {
    return items.join(',');
  }

  static deserializeArray(text: string): string[] {
    return text ? text.split(',').map(item => item.trim()) : [];
  }

  // Array serialization (JSON for complex items)
  static serializeComplexArray<T>(items: T[]): string {
    return JSON.stringify(items);
  }

  static deserializeComplexArray<T>(text: string): T[] {
    try {
      return text ? JSON.parse(text) : [];
    } catch (error) {
      console.error('Failed to parse array:', error);
      return [];
    }
  }

  // JSON object serialization
  static serializeJSON(obj: any): string {
    return JSON.stringify(obj);
  }

  static deserializeJSON<T>(text: string): T | null {
    try {
      return text ? JSON.parse(text) : null;
    } catch (error) {
      console.error('Failed to parse JSON:', error);
      return null;
    }
  }
}

// Usage in repository
class EntityRepository {
  private mapRowToEntity(row: any): Entity {
    return {
      id: row.entity_id,
      tenantId: row.tenant_id,
      name: row.name,
      tags: DataSerializer.deserializeArray(row.tags),
      metadata: DataSerializer.deserializeJSON(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapEntityToRow(tenantId: string, entity: Entity): any {
    return {
      entity_id: entity.id,
      tenant_id: tenantId,
      name: entity.name,
      tags: DataSerializer.serializeArray(entity.tags),
      metadata: DataSerializer.serializeJSON(entity.metadata),
      created_at: entity.createdAt,
      updated_at: entity.updatedAt
    };
  }
}
```

---

## Connection Management

### Token-Based Authentication

```typescript
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { Client } from 'pg';

class DSQLConnection {
  private region: string;
  private clusterId: string;
  private hostname: string;

  constructor(clusterId: string, region: string = 'us-east-1') {
    this.clusterId = clusterId;
    this.region = region;
    this.hostname = `${clusterId}.dsql.${region}.on.aws`;
  }

  async getConnection(): Promise<Client> {
    const token = await this.generateAuthToken();

    return new Client({
      host: this.hostname,
      port: 5432,
      database: 'postgres',  // Always 'postgres'
      user: 'admin',
      password: token,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 3000
    });
  }

  private async generateAuthToken(): Promise<string> {
    const signer = new DsqlSigner({
      region: this.region,
      hostname: this.hostname,
      port: 5432,
      username: 'admin'
    });

    // Token expires in 15 minutes
    return await signer.getDbConnectAdminAuthToken();
  }
}
```

---

## Migration Execution

### Migration Runner

```typescript
interface Migration {
  id: string;
  description: string;
  statements: string[];  // Each DDL separate
}

class MigrationRunner {
  private client: Client;

  async run(migrations: Migration[]) {
    for (const migration of migrations) {
      console.log(`Running migration: ${migration.id} - ${migration.description}`);

      // Execute each DDL statement individually (no transactions)
      for (const statement of migration.statements) {
        if (statement.trim()) {
          try {
            await this.client.query(statement);
            console.log(`  ✓ Executed: ${statement.substring(0, 60)}...`);
          } catch (error) {
            console.error(`  ✗ Failed: ${statement.substring(0, 60)}...`);
            throw error;
          }
        }
      }

      console.log(`✓ Completed migration: ${migration.id}`);
    }
  }
}

// Example migrations
const migrations: Migration[] = [
  {
    id: '001_initial_schema',
    description: 'Create initial tables',
    statements: [
      'CREATE TABLE IF NOT EXISTS tenants (tenant_id VARCHAR(255) PRIMARY KEY, name VARCHAR(255) NOT NULL)',
      'CREATE INDEX ASYNC idx_tenants_name ON tenants(name)',
      'CREATE TABLE IF NOT EXISTS entities (entity_id VARCHAR(255) PRIMARY KEY, tenant_id VARCHAR(255) NOT NULL)',
      'CREATE INDEX ASYNC idx_entities_tenant ON entities(tenant_id)'
    ]
  },
  {
    id: '002_add_status_columns',
    description: 'Add status tracking columns',
    statements: [
      'ALTER TABLE entities ADD COLUMN IF NOT EXISTS status VARCHAR(50)',
      'ALTER TABLE entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP',
      'UPDATE entities SET status = \'active\' WHERE status IS NULL',
      'CREATE INDEX ASYNC idx_entities_status ON entities(tenant_id, status)'
    ]
  }
];
```

---

## Multi-Tenant Isolation

### Base Repository with Tenant Scoping

```typescript
abstract class TenantRepository<T> {
  protected client: Client;
  protected tableName: string;
  protected idColumn: string;

  // tenantId is ALWAYS first parameter
  async findAll(tenantId: string, limit = 100): Promise<T[]> {
    const query = `
      SELECT * FROM ${this.tableName}
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const result = await this.client.query(query, [tenantId, limit]);
    return result.rows.map(row => this.mapRow(row));
  }

  async findById(tenantId: string, id: string): Promise<T | null> {
    const query = `
      SELECT * FROM ${this.tableName}
      WHERE tenant_id = $1 AND ${this.idColumn} = $2
    `;
    const result = await this.client.query(query, [tenantId, id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async create(tenantId: string, data: Partial<T>): Promise<T> {
    // Always include tenant_id
    const values = { tenant_id: tenantId, ...data };

    const columns = Object.keys(values);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const query = `
      INSERT INTO ${this.tableName} (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

    const result = await this.client.query(query, Object.values(values));
    return this.mapRow(result.rows[0]);
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const query = `
      DELETE FROM ${this.tableName}
      WHERE tenant_id = $1 AND ${this.idColumn} = $2
    `;
    const result = await this.client.query(query, [tenantId, id]);
    return result.rowCount > 0;
  }

  protected abstract mapRow(row: any): T;
}
```

---

## Batch Operations

### Safe Batching Under Limits

```typescript
class BatchProcessor {
  private readonly BATCH_SIZE = 500;  // Well under 3,000 limit

  async batchInsert(tenantId: string, items: any[]) {
    const chunks = this.chunkArray(items, this.BATCH_SIZE);
    const results = [];

    for (const chunk of chunks) {
      await withDatabase(async (client) => {
        await client.query('BEGIN');

        try {
          for (const item of chunk) {
            const result = await client.query(
              `INSERT INTO items (tenant_id, name, data)
               VALUES ($1, $2, $3) RETURNING *`,
              [tenantId, item.name, item.data]
            );
            results.push(result.rows[0]);
          }

          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    }

    return results;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
```

---

## Hierarchical Queries

### Recursive CTEs

```sql
-- Get all descendants of an entity
WITH RECURSIVE entity_tree AS (
  -- Anchor: Start with root entity
  SELECT
    entity_id,
    parent_id,
    name,
    0 as level,
    entity_id::TEXT as path
  FROM entities
  WHERE entity_id = $1
    AND tenant_id = $2

  UNION ALL

  -- Recursive: Get children
  SELECT
    e.entity_id,
    e.parent_id,
    e.name,
    et.level + 1,
    et.path || '/' || e.entity_id
  FROM entities e
  INNER JOIN entity_tree et ON e.parent_id = et.entity_id
  WHERE e.tenant_id = $2
    AND et.level < 10  -- Prevent infinite recursion
)
SELECT * FROM entity_tree ORDER BY path;
```

```typescript
// Usage in repository
async findDescendants(tenantId: string, entityId: string): Promise<Entity[]> {
  const query = `
    WITH RECURSIVE entity_tree AS (
      SELECT entity_id, parent_id, name, 0 as level
      FROM entities
      WHERE entity_id = $1 AND tenant_id = $2

      UNION ALL

      SELECT e.entity_id, e.parent_id, e.name, et.level + 1
      FROM entities e
      INNER JOIN entity_tree et ON e.parent_id = et.entity_id
      WHERE e.tenant_id = $2 AND et.level < 10
    )
    SELECT * FROM entity_tree
  `;

  const result = await this.client.query(query, [entityId, tenantId]);
  return result.rows.map(row => this.mapRow(row));
}
```

---

## References

- **Constraints:** [steering.md](./steering.md)
- **AWS Documentation:** [Aurora DSQL User Guide](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/)