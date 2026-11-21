---
name: querying-data-lake
description: >-
  Execute and manage Athena SQL queries across default and federated catalogs (Glue,
  S3 Tables, Redshift). Triggers on phrases like: query data, run SQL, athena query,
  analyze table, SQL query, workgroup status, profile table, query Redshift catalog,
  query S3 Tables. Do NOT use for finding specific data assets (use finding-data-lake-assets),
  full catalog audits (use exploring-data-catalog), importing data (use ingesting-into-data-lake).
metadata:
  version: "1"
  argument-hint: "'[SQL-query|query-name|workgroup-name|catalog-name|''profile TABLE_NAME'']'"
---

# Query Data Lake

Execute SQL queries on Amazon Athena across default and federated catalogs (Glue, S3 Tables, Redshift) with workgroup selection, statement classification, and error recovery.

## Overview

Executes and manages Athena SQL queries across default and federated catalogs. Selects a workgroup, resolves target assets (delegating fuzzy references to `finding-data-lake-assets`), classifies statements for safety, and reports cost and data scanned. Use the AWS MCP server for sandboxed execution and audit logging; the same AWS CLI commands work directly when the MCP server is not available.

**Constraints for parameter acquisition:**

- You MUST accept a single optional argument: SQL text, a named-query name, a workgroup name, a catalog name, or `profile TABLE_NAME`
- You MUST accept the argument as direct text or a pointer to a file containing SQL
- You MUST ask the user for the target AWS region if not already set
- You MUST confirm the output S3 location before executing any non-trivial query
- You MUST respect the user's decision to abort at any step

## Common Tasks

### 1. Verify Dependencies

Check for required tools and AWS access before running queries.

**Constraints:**

- You MUST verify AWS MCP server tools are available (`aws___call_aws`) and run queries through them when present; fall back to AWS CLI only if the MCP server is unavailable
- You MUST NOT fall back to shell or Bash for query execution — results must be captured via the MCP tool or `aws athena` CLI so output location and cost are tracked
- You MUST confirm credentials with `aws sts get-caller-identity` and inform the user about any missing tools

### 2. Resolve Workgroup

Check caller identity, list workgroups, auto-select the best one (see [workgroup-selection.md](references/workgroup-selection.md)).

**Constraints:**

- You MUST select a workgroup before submitting any query (prevents output-location errors)
- You MUST present the selected workgroup and its output location to the user
- You MUST NOT auto-escalate to a different workgroup on failure without user confirmation

### 3. Resolve the Target Asset

If the user refers to a table by name, by business concept ("our quarterly report", "the sales data"), by S3 path, or by catalog without specifying the table, delegate to `finding-data-lake-assets` to return the concrete `database.table` (and catalog if non-default).

**Constraints:**

- You MUST NOT attempt to resolve fuzzy asset references with `athena list-data-catalogs` or by iterating `get-tables` — those miss federated catalogs and waste tokens
- You SHOULD skip this step only when the user provides a fully-qualified reference (exact `database.table`) or raw SQL they want executed as-is
- You MUST state the resolved asset explicitly before building the query: "Found [table] in [catalog]. Using this for the query."
- You SHOULD default to the default Glue catalog unless the user mentions "federated", "Redshift", "S3 Tables", or `finding-data-lake-assets` returns a different catalog

### 4. Discover Schema

For analytical queries, You SHOULD profile the target table before building the final query. You MUST show sample rows (`SELECT ... LIMIT 5`) as part of profiling.

### 5. Build Query

Table addressing depends on catalog type:

- Default Glue catalog: `database.table` (omit the catalog prefix for single-catalog queries). In cross-catalog queries, qualify default-catalog tables with `"awsdatacatalog".database.table`.
- Registered data source: `datasource.database.table`
- Unregistered Glue catalog: `"catalog/subcatalog".database.table`

### 6. Classify and Execute

Classify the SQL statement before executing:

| Statement                                                                    | Behavior                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`                                      | Safe — execute                                                |
| `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `MERGE` | Destructive — warn the user and require explicit confirmation |
| Unsure                                                                       | Treat as destructive; confirm                                 |

Example tool call (via AWS MCP server):

```
aws___call_aws(command="aws athena start-query-execution --work-group <WORKGROUP_NAME> --query-string '<sql>' --query-execution-context Database=<db>")
```

For federated or S3 Tables catalogs, also set `Catalog=<CATALOG_PATH>` in the execution context (e.g. `Catalog=s3tablescatalog/<BUCKET_NAME>`).

**Constraints:**

- You MUST warn the user before executing when the target is Redshift-federated ("No partition pruning — every query scans the full table")
- You MUST warn the user before executing a cross-catalog join ("Cross-catalog joins incur network overhead and may be slow")
- You MUST confirm the output S3 location before executing
- You MUST explain which tool is being called before executing
- You MUST respect the user's decision to abort

### 7. Present and Recover

Present results with cost, data scanned, duration, and actionable insights. On failure, list available workgroups and let the user choose which to retry with.

### Argument Routing

Resolve in this order; stop at the first match:

1. Contains SQL keywords (`SELECT`, `SHOW`, `DESCRIBE`, `INSERT`, etc.) — SQL text, execute directly
2. `profile TABLE_NAME` — run comprehensive table profiling (see [query-patterns.md](references/query-patterns.md))
3. Matches a known named query — look up and execute
4. Matches a known workgroup — show workgroup status and recent queries
5. Matches a known catalog — delegate to `exploring-data-catalog` to enumerate databases and tables
6. No args — show recent query activity and available tables

### Principles

- Always select workgroup before executing (prevents output-location errors)
- Profile unfamiliar tables before running analytical queries
- Present cost alongside results so users build cost awareness
- Suggest `LIMIT` for exploratory queries on large tables
- Never ask domain questions with obvious answers, but always confirm security-relevant actions (workgroup switches, output location changes, non-SELECT statements)

## Troubleshooting

| Error                                               | Cause                                       | Fix                                                                                                             |
| --------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Redshift identifier error with mixed case           | Redshift-federated names are lowercase only | Lowercase the identifier                                                                                        |
| `CatalogId` validation failure                      | ARN passed instead of catalog name          | Pass the catalog name, not the ARN                                                                              |
| Cross-catalog `information_schema` returns nothing  | Missing catalog qualifier                   | Use catalog-qualified path: `"catalog".information_schema.tables`                                               |
| Query fails with output-location error              | Workgroup has no output location configured | Select a different workgroup with an output location, or configure one                                          |
| Destructive statement executed without confirmation | Statement classification skipped            | Always classify `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE`/`TRUNCATE`/`MERGE` and confirm with the user |

## Additional Resources

- [Workgroup selection logic](references/workgroup-selection.md)
- [Common query patterns](references/query-patterns.md)
- [Athena best practices](https://docs.aws.amazon.com/athena/latest/ug/performance-tuning.html)
- [Athena federated query](https://docs.aws.amazon.com/athena/latest/ug/connect-to-a-data-source.html)
