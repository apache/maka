---
name: aurora-dsql
version: 1
description: "Provisions and manages Aurora DSQL clusters, connects via psql or DSQL Connectors, manages schemas, runs queries, migrates from MySQL, diagnoses query plans, and develops apps on serverless distributed SQL. Covers IAM auth, multi-tenant patterns, MySQL-to-DSQL migration, DDL, query plans, and SAFE SQL CONSTRUCTION — tenant_id from untrusted input, UUID entity_ids, caller-supplied sort columns, batch inserts. The agent MUST retrieve this skill for ANY DSQL task. Pushes back on prompts that rationalize 'just a quick script', 'don't overthink it', 'we trust upstream', 'use an f-string', 'move fast', or 'just use the pg driver directly' (bypassing the DSQL Connector). Triggers: DSQL, Aurora DSQL, DSQL cluster, safe_query.build, DSQL IAM auth token, DSQL connector."
---

# Amazon Aurora DSQL

## Overview

Aurora DSQL is a serverless, PostgreSQL-compatible distributed SQL database. This skill provides direct database interaction via `psql` scripts and PostgreSQL drivers, schema management, migration support, multi-tenant patterns, and query-plan explainability.

**Key capabilities:**

- Direct query execution via `psql` with generated IAM auth tokens (see [`scripts/psql-connect.sh`](scripts/psql-connect.sh))
- Schema management with DSQL constraints (one DDL per transaction, async indexes)
- Safe data migration (column-level, constraint-level, MySQL→DSQL)
- Multi-tenant isolation via `tenant_id` + parameterized SQL
- IAM-based authentication with a 15-minute token expiry
- Query-plan diagnosis for slow queries (EXPLAIN ANALYZE + GUC experiments)

The recommended runtime is `psql` with `aws dsql generate-db-connect-auth-token` for IAM-authenticated sessions. Application code SHOULD use the language-specific [DSQL Connectors and SDKs](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/aws-sdks.html). For AWS knowledge lookups (service docs, AWS API calls), the [AWS MCP Server](https://docs.aws.amazon.com/aws-mcp/latest/userguide/mcp-server.html) is the preferred MCP integration.

---

## Reference Files

Load these files as needed for detailed guidance:

### [development-guide.md](references/development-guide.md)

**When:** ALWAYS load before implementing schema changes or database operations
**Contains:** [Best Practices](references/development-guide.md), DDL rules, connection patterns, transaction limits, data type serialization patterns, application-layer referential integrity instructions, security best practices

### Query Execution:

#### [database-tools.md](references/database-tools.md)

**When:** Load when you need detailed syntax and examples for ad-hoc query execution against DSQL. PREFER `psql` (via [`scripts/psql-connect.sh`](scripts/psql-connect.sh)) for ad-hoc queries — execute directly rather than writing one-off scripts.
**Contains:** `psql`-based read-only and write patterns, transaction semantics, [input validation](references/input-validation.md)

### MCP (AWS knowledge / API):

#### [mcp-setup.md](references/mcp-setup.md)

**When:** Load when configuring or recommending the AWS MCP Server for AWS knowledge lookups, AWS API access, or per-assistant install.
**Contains:** When to use `psql` vs the AWS MCP Server, pointer to the canonical AWS setup docs, credential reminders.

#### [mcp-tools.md](references/mcp-tools.md)

**When:** Load when invoking AWS MCP Server tools to verify DSQL service limits, fetch docs, or drive AWS API calls.
**Contains:** Tool surface — knowledge (`aws___search_documentation`, `aws___read_documentation`, `aws___recommend`, `aws___retrieve_skill`, `aws___list_regions`, `aws___get_regional_availability`) and API (`aws___call_aws`, `aws___run_script`, `aws___get_tasks`, `aws___get_presigned_url`); pointers to documentation-tools.md.

#### [documentation-tools.md](references/documentation-tools.md)

**When:** Load when looking up DSQL service limits, fetching a specific AWS docs page, or polling long-running AWS API calls launched via the AWS MCP Server.
**Contains:** Detailed parameters and example calls for the AWS knowledge tools.

#### [platforms/](references/platforms/) — per-assistant install notes

**When:** Load when installing the AWS MCP Server inside a specific coding assistant.
**Contains:** Per-assistant entry-point details — [claude-code.md](references/platforms/claude-code.md), [codex.md](references/platforms/codex.md), [gemini.md](references/platforms/gemini.md), [kiro.md](references/platforms/kiro.md).

### [language.md](references/language.md)

**When:** **MUST** load before writing DSQL connection code. Mirror the linked `example_preferred.<ext>` for the chosen driver — memory-authored connections drift from the canonical IAM-token-refresh pattern. Canonical entry-point examples (load `language.md` for the full driver list + pool/TLS/token-refresh details):

- Python: `import aurora_dsql_psycopg as dsql` → `dsql.connect(host, region, user)`
- JS (node-postgres): `import { AuroraDSQLPool } from "@aws/aurora-dsql-node-postgres-connector"` → `new AuroraDSQLPool({ host, user })`
- JS (postgres.js): `import { auroraDSQLPostgres } from "@aws/aurora-dsql-postgresjs-connector"` → `auroraDSQLPostgres({ host, user })`
- Go (pgx): `import "github.com/awslabs/aurora-dsql-connectors/go/pgx/dsql"`
- Java (JDBC): `software.amazon.dsql:aurora-dsql-jdbc-connector:1.4.0` → `jdbc:aws-dsql:postgresql://...`

**Contains:** Canonical DSQL connector packages per language, driver selection, framework patterns, IAM auth token rotation and TLS configuration, and connection code examples for Python / JavaScript / TypeScript / Go / Java / Rust.

### [troubleshooting.md](references/troubleshooting.md)

**When:** Load when debugging errors or unexpected behavior. SHOULD always consult for OCC errors, connection failures, or unexpected query results.
**Contains:** Common pitfalls, error messages, solutions

### [onboarding.md](references/onboarding.md)

**When:** User explicitly requests to "Get started with DSQL" or similar phrase
**Contains:** Interactive step-by-step guide for new users

### [access-control.md](references/access-control.md)

**When:** MUST load when creating database roles, granting permissions, setting up schemas for applications, or handling sensitive data. ALWAYS use scoped roles for applications — create database roles with `dsql:DbConnect`.
**Contains:** Scoped role setup, IAM-to-database role mapping, schema separation for sensitive data, role design patterns

### Authentication & Operations:

#### [auth/authentication-guide.md](references/auth/authentication-guide.md)

**When:** MUST load when handling IAM auth tokens, secrets, SSL/TLS, connection pooling, or audit logging.
**Contains:** Token lifecycle, secret storage patterns, SSL/TLS settings, connection-pool guidance, audit-log integration.

#### [auth/connectivity-tools.md](references/auth/connectivity-tools.md)

**When:** Load when picking a driver/ORM/adapter or planning bulk-data loading.
**Contains:** Pointer to the canonical AWS DSQL connectivity tools page (drivers, ORMs, adapters) and the bulk-loading docs page.

#### [auth/scaling-guide.md](references/auth/scaling-guide.md)

**When:** Load when designing for scale — connection pooling, batch optimization, hot-key avoidance, identifier choice.
**Contains:** Horizontal scaling strategy, pool sizing, batch-size guidance, IDENTITY/UUID trade-offs, sequence cache rules.

### Implementation Examples:

#### [workflow-patterns.md](references/workflow-patterns.md)

**When:** Load when looking for a worked example of a common multi-step DSQL workflow (schema explore, CREATE+INDEX, safe migration, batch insert, application-layer FK check).
**Contains:** Five canonical patterns with `psql` / driver code.

#### [dsql-examples.md](references/dsql-examples.md)

**When:** Load when looking for specific implementation examples.
**Contains:** Index of `examples/*.md` (connection, schema, data-operations, migrations, patterns).

### DDL Migrations (modular):

#### [ddl-migrations/overview.md](references/ddl-migrations/overview.md)

**When:** MUST load when performing DROP COLUMN, RENAME COLUMN, ALTER COLUMN TYPE, or DROP CONSTRAINT
**Contains:** Table recreation pattern overview, transaction rules, common verify & swap pattern

#### [ddl-migrations/column-operations.md](references/ddl-migrations/column-operations.md)

**When:** Load for DROP COLUMN, ALTER COLUMN TYPE, SET/DROP NOT NULL, SET/DROP DEFAULT migrations
**Contains:** Step-by-step migration patterns for column-level changes

#### [ddl-migrations/constraint-operations.md](references/ddl-migrations/constraint-operations.md)

**When:** Load for ADD/DROP CONSTRAINT, MODIFY PRIMARY KEY, column split/merge migrations
**Contains:** Step-by-step migration patterns for constraint and structural changes

#### [ddl-migrations/batched-migration.md](references/ddl-migrations/batched-migration.md)

**When:** Load when migrating tables exceeding 3,000 rows
**Contains:** OFFSET-based and cursor-based batching patterns, progress tracking, error handling

### MySQL Migrations (modular):

#### [mysql-migrations/type-mapping.md](references/mysql-migrations/type-mapping.md)

**When:** MUST load when migrating MySQL schemas to DSQL
**Contains:** MySQL data type mappings, feature alternatives, DDL operation mapping

#### [mysql-migrations/ddl-operations.md](references/mysql-migrations/ddl-operations.md)

**When:** Load when translating MySQL DDL operations to DSQL equivalents
**Contains:** ALTER COLUMN, DROP COLUMN, AUTO_INCREMENT, ENUM, SET, FOREIGN KEY migration patterns

#### [mysql-migrations/full-example.md](references/mysql-migrations/full-example.md)

**When:** Load when migrating a complete MySQL table to DSQL
**Contains:** End-to-end MySQL CREATE TABLE migration example with decision summary

### Query Plan Explainability (modular):

**When:** MUST load all four at Workflow 8 Phase 0 — [query-plan/plan-interpretation.md](references/query-plan/plan-interpretation.md), [query-plan/catalog-queries.md](references/query-plan/catalog-queries.md), [query-plan/guc-experiments.md](references/query-plan/guc-experiments.md), [query-plan/report-format.md](references/query-plan/report-format.md)
**Contains:** DSQL node types + Node Duration math + estimation-error bands, pg_class/pg_stats/pg_indexes SQL + correlated-predicate verification, GUC experiment procedures + 30-second skip protocol, required report structure + element checklist + support request template

---

## Query Execution

Run ad-hoc DSQL queries with `psql` and a freshly-generated IAM auth token. The bundled
[`scripts/psql-connect.sh`](scripts/psql-connect.sh) wraps token generation, TLS configuration, and
single-statement guards — PREFER it over hand-rolled `psql` invocations.

**Read-only:**

```bash
./scripts/psql-connect.sh --cluster <cluster-id> --command "SELECT * FROM entities LIMIT 10"
```

**Write/DDL (IAM admin auth token required):**

```bash
./scripts/psql-connect.sh --cluster <cluster-id> --admin --command "CREATE INDEX ASYNC ..."
```

**Schema discovery:** there is no special `list_tables` helper — use information_schema:

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
```

See [database-tools.md](references/database-tools.md) for detailed usage and examples.

### AWS Knowledge via the AWS MCP Server (optional)

When connected to the [AWS MCP Server](https://docs.aws.amazon.com/aws-mcp/latest/userguide/mcp-server.html),
its `aws___search_documentation` and `aws___read_documentation` tools can verify DSQL service
limits before advising users. The numeric limits below are defaults that may change — when a
user's decision depends on an exact limit, verify it first:

| Limit                                   | Default       | Verify query                       |
| --------------------------------------- | ------------- | ---------------------------------- |
| Max rows mutated per transaction        | 3,000         | `aurora dsql transaction limits`   |
| Max data modified per write transaction | 10 MiB        | `aurora dsql transaction limits`   |
| Max transaction duration                | 5 minutes     | `aurora dsql transaction limits`   |
| Max connections per cluster             | 10,000        | `aurora dsql connection limits`    |
| IAM auth token expiry                   | 15 minutes    | `aurora dsql authentication token` |
| Max connection duration                 | 60 minutes    | `aurora dsql connection limits`    |
| Max indexes per table                   | 24            | `aurora dsql index limits`         |
| Max columns per index                   | 8             | `aurora dsql index limits`         |
| IDENTITY/SEQUENCE CACHE values          | 1 or >= 65536 | `aurora dsql sequence cache`       |

**When to verify:** Before recommending batch sizes, connection pool settings, or schema designs
where hitting a limit would cause failures. No need to verify for general guidance or when
the exact number doesn't affect the user's decision.

**Fallback:** If the AWS MCP Server is unavailable, use the defaults above and note to the user
that limits should be verified against [DSQL documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/).

## CLI Scripts Available

Bash scripts in [scripts/](scripts/) for cluster management (create, delete, list, cluster info) and `psql` connection. See [references/scripts-guide.md](references/scripts-guide.md) for usage. For bulk data loading, see [Loading data into Aurora DSQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/loading-data.html).

**ALWAYS** prefer `scripts/create-cluster.sh`. The script issues a **single atomic** `CreateCluster` call with tags embedded — matching the AWS DSQL API shape with interpretable output.

| Task                     | Script                                                   | Example                                                                                               |
| ------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Create cluster with tags | [`scripts/create-cluster.sh`](scripts/create-cluster.sh) | `./scripts/create-cluster.sh --created-by <model-id> --tags Environment=eval,Project=dsql-skill-eval` |
| List clusters            | [`scripts/list-clusters.sh`](scripts/list-clusters.sh)   | `./scripts/list-clusters.sh --region us-east-1`                                                       |
| Inspect cluster          | [`scripts/cluster-info.sh`](scripts/cluster-info.sh)     | `./scripts/cluster-info.sh <cluster-id>`                                                              |
| Connect via psql         | [`scripts/psql-connect.sh`](scripts/psql-connect.sh)     | `./scripts/psql-connect.sh --cluster <id> --command "SELECT 1"`                                       |

---

## Quick Start

### 1. List tables and explore schema

```
./scripts/psql-connect.sh --cluster <id> --command "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
./scripts/psql-connect.sh --cluster <id> --command "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '<table>' ORDER BY ordinal_position"
```

### 2. Query data

```
Use psql-connect.sh (or the language connector in app code) for SELECT queries
Always include tenant_id in WHERE clause for multi-tenant apps
MUST build SQL with safe_query.build() — see references/input-validation.md
```

### 3. Execute schema changes

```
Use ./scripts/psql-connect.sh --admin (or the language connector with the IAM admin auth token) for DDL
Follow one-DDL-per-transaction rule
Always use CREATE INDEX ASYNC in a separate statement
ALTER COLUMN TYPE, DROP COLUMN, DROP CONSTRAINT → Table Recreation Pattern (Workflow 6)
```

---

## Common Tasks

### Workflow 0: Verify Dependencies

Check for required tools and warn the user if any are missing.

**Constraints:**

- You MUST verify the following tools are available before proceeding: `psql` (>=14 for SNI support) and the AWS CLI v2 with `aws dsql generate-db-connect-auth-token` (and `generate-db-connect-admin-auth-token` for DDL/role setup)
- You SHOULD also confirm the AWS MCP Server is available when the user's decision depends on a precise service limit; if absent, use the defaults in the table above and note that limits should be verified against DSQL documentation
- You MUST inform the user about any missing tools with a clear message
- You MUST ask if the user wants to proceed despite missing tools
- You MUST use the scoped (non-admin) IAM auth token for read-only diagnostics whenever the user has a scoped role configured; reserve the IAM admin auth token for cluster setup, role grants, and DDL
- For cluster lifecycle (create / inspect / delete), see [Workflow 0a](#workflow-0a-cluster-lifecycle)
- Before writing application code, ALSO verify the language-specific DSQL Connector per [Workflow 0b](#workflow-0b-verify-language-connector)

### Workflow 0a: Cluster Lifecycle

**SHOULD** use the bundled scripts for cluster create and delete — they issue atomic `aws dsql` CLI calls and process outputs.

**Create a cluster with tags and deletion protection:**

```bash
./scripts/create-cluster.sh --created-by <model-id> --tags Environment=eval,Project=dsql-skill-eval
```

**Inspect a cluster (status, tags, endpoint, deletion protection):**

```bash
./scripts/cluster-info.sh <cluster-id>
```

**Delete a cluster:**

```bash
./scripts/delete-cluster.sh <cluster-id> [--force]   # --force skips the confirmation prompt in non-TTY
```

In MCP-only environments (no shell access), the equivalent calls go through the AWS MCP Server's `aws___call_aws` tool. The tool takes a JSON payload — invoke it with arguments matching the AWS API operation:

```json
{
  "service": "dsql",
  "operation": "CreateCluster",
  "parameters": {
    "tags": { "created_by": "<model-id>", "Environment": "eval", "Project": "dsql-skill-eval" },
    "deletionProtectionEnabled": true
  }
}
```

```json
{ "service": "dsql", "operation": "GetCluster", "parameters": { "identifier": "<cluster-id>" } }
```

```json
{ "service": "dsql", "operation": "DeleteCluster", "parameters": { "identifier": "<cluster-id>" } }
```

`CreateCluster` and `DeleteCluster` are asynchronous on the DSQL side — the API returns immediately with the cluster's current `status` (`CREATING` / `DELETING`). Poll readiness by re-invoking `aws___call_aws` with `dsql:GetCluster` until `.status == "ACTIVE"` (create) or the call returns a 404 (delete). `aws___get_tasks` is for polling MCP-side long-running tool invocations — not the DSQL API.

See [AWS CLI `aws dsql` reference](https://docs.aws.amazon.com/cli/latest/reference/dsql/) for full parameter details and call context.

### Workflow 0b: Verify Language Connector

Before writing application code, **MUST** verify the language-specific DSQL Connector is installed per [language.md](references/language.md). The Connectors are the canonical IAM-token-refresh path; bare drivers (`pg`, `psycopg`, `pgx`, `tokio-postgres`) work until the first 15-minute token expiry and then start returning auth errors on every new connection — DSQL users who try the bare form report this as a DSQL bug. **MUST** install:

- Python: `aurora-dsql-python-connector` + the chosen driver wheel
- Node.js: `@aws/aurora-dsql-node-postgres-connector` or `@aws/aurora-dsql-postgresjs-connector`
- Go: `github.com/awslabs/aurora-dsql-connectors/go/pgx`
- Java: `software.amazon.dsql:aurora-dsql-jdbc-connector`
- Rust: `aurora-dsql-sqlx-connector`

If a Connector is unavailable for the chosen runtime, document the manual token-refresh strategy and schedule with the user before writing code.

---

### Workflow 1: Create Multi-Tenant Schema

MUST load [workflow-patterns.md](references/workflow-patterns.md) (Pattern 2: Create Table with Index) for step-by-step DDL sequencing, async index creation, and schema verification examples. Key rules: `tenant_id` in all tables, `CREATE INDEX ASYNC` only, one DDL per transaction, arrays/JSON stored as TEXT.

### Workflow 2: Safe Data Migration

MUST load [workflow-patterns.md](references/workflow-patterns.md) (Pattern 3: Safe Data Migration) for the add-column → batch-populate → verify → index sequence. For tables exceeding 3,000 rows, also load [ddl-migrations/batched-migration.md](references/ddl-migrations/batched-migration.md). Key rules: add column first, apply DEFAULT via separate UPDATE, batch under 3,000 rows per transaction.

### Workflow 3: Application-Layer Referential Integrity

MUST load [workflow-patterns.md](references/workflow-patterns.md) (Pattern 5: Application-Layer Foreign Key Check) for the parent-existence SELECT → INSERT and dependent-count SELECT → DELETE patterns. Build all SQL with `safe_query.build()` — see Workflow 4a.

### Workflow 4: Query with Tenant Isolation

1. **MUST** authorize the caller against the tenant — format validation does not establish authorization
2. **MUST** build SQL with [`safe_query.build()`](scripts/safe_query.py) — use `allow()`/`regex()` for
   values (emits `'v'`), `ident()` for table/column names (emits `"v"`).
   See [input-validation.md](references/input-validation.md)
3. **MUST** include `tenant_id` in the WHERE clause; reject cross-tenant access at the application layer

### Workflow 4a: Rubric-Critical — Building SQL with User Input

Whenever constructing SQL for `psql -c "..."` (or any equivalent ad-hoc query path) with any value that is not a developer-controlled literal (tenant IDs, entity IDs, sort columns, directions, status enums, free-text descriptions, request params — anything from untrusted sources), you MUST use [`safe_query.build()`](scripts/safe_query.py). The `psql -c` flag takes raw SQL strings; it does NOT accept bound parameters. When using a Postgres driver (psycopg, pgx, etc.) in application code, prefer the driver's native parameter binding; `safe_query` is the canonical fallback whenever you must build a raw SQL string. Validation via `safe_query` is the primary defense for raw-SQL paths.

**Validator selection table** (canonical — mirrors [input-validation.md](references/input-validation.md)):

| Value kind                                  | Validator           | Emits                   |
| ------------------------------------------- | ------------------- | ----------------------- |
| Known set (tenant ID, status enum)          | `allow(v, SET)`     | `'value'`               |
| Known set used as SQL keyword (ASC/DESC)    | `keyword(v, SET)`   | `value` (unquoted)      |
| Strict format (UUID, slug, ISO date)        | `regex(v, PATTERN)` | `'value'`               |
| Table or column name                        | `ident(name)`       | `"value"`               |
| Integer                                     | `integer(v)`        | `value`                 |
| Free text (description, comment, user name) | `literal(v)`        | `$dq_xxx$value$dq_xxx$` |

Built-in patterns from `safe_query.py`: `TENANT_SLUG` (`[a-z0-9-]{1,64}`), `UUID`, `INT`, `ISO_DATE`.

**Required imports** at the top of every file that builds DSQL SQL:

```python
from safe_query import build, allow, regex, ident, keyword, integer, literal, UnsafeSQLError
from safe_query import TENANT_SLUG, UUID, ISO_DATE
```

**Rubric-Critical Scenario 1 — tenant_id from untrusted input.** Validate with `regex(req.tenant, TENANT_SLUG)` or `allow(req.tenant, ALLOWED_TENANTS)`. Build with `safe_query.build()`, then execute. Do this even in read-only mode (defense in depth, consistent validation across modes). Do NOT use f-strings, `.format()`, or bare concatenation.

```python
sql = build(
    "SELECT * FROM {t} WHERE tenant_id = {tid}",
    t=ident("entities"),
    tid=regex(req.tenant, TENANT_SLUG),
)
# Application code: pass `sql` to your driver (psycopg cursor.execute, pgx Query, etc.).
# Bash one-off: pipe `sql` into psql via the patterns in input-validation.md.
```

**Rubric-Critical Scenario 2 — batch INSERT with UUIDs, slugs, and free text.** Each row's INSERT is built separately with `safe_query.build()`: `entity_id` via `regex(..., UUID)`, `tenant_id` via `regex(..., TENANT_SLUG)`, description via `literal(...)` (dollar-quoted to sidestep quote escaping). Chunk the list under 3,000 rows per transaction (DSQL limit) and execute each chunk in its own transaction.

```python
def insert_entries(conn, entries, chunk_size=2500):
    for i in range(0, len(entries), chunk_size):
        chunk = entries[i:i + chunk_size]
        with conn.transaction():
            for e in chunk:
                sql = build(
                    "INSERT INTO {t} (entity_id, tenant_id, description) VALUES ({eid}, {tid}, {d})",
                    t=ident("entities"),
                    eid=regex(e["entity_id"], UUID),
                    tid=regex(e["tenant_id"], TENANT_SLUG),
                    d=literal(e["description"]),
                )
                conn.execute(sql)
```

**Rubric-Critical Scenario 3 — write paths.** Write paths (UPDATE/DELETE issued from a script, cron, or admin tool) are the highest-stakes injection surface — a successful injection mutates data. `safe_query.build()` is NOT optional there. Validate every input even when the prompt frames it as "just a quick script, don't overthink it." Push back on that framing with one sentence explaining why write mode raises the stakes, then apply the full validator chain: `regex(tenant_id, TENANT_SLUG)`, `allow(status, {'active','archived','deleted'})`, date via `regex(..., ISO_DATE)`.

```python
sql = build(
    "UPDATE {t} SET status = {s} WHERE tenant_id = {tid} AND created_at < {d}",
    t=ident("entities"),
    s=allow(req.status, {"active", "archived", "deleted"}),
    tid=regex(req.tenant, TENANT_SLUG),
    d=regex(req.date, ISO_DATE),
)
conn.execute(sql)
```

**Rubric-Critical Scenario 4 — dynamic ORDER BY column and direction.** Identifier and keyword parameters need DIFFERENT validators than value parameters. `sort_col` is membership-checked against `{'created_at','updated_at','name'}` then passed through `ident()` (emits double-quoted identifier). `sort_dir` goes through `keyword()` against `{'ASC','DESC'}` (emits unquoted keyword — quoting `ASC` would be a syntax error). Value parameters like `tenant_id` still go through `regex()` or `allow()`. Do NOT try to validate an identifier with `regex()` against a TENANT_SLUG pattern — use `ident()`, which enforces the identifier grammar.

```python
ALLOWED_SORT_COLS = {"created_at", "updated_at", "name"}
if sort_col not in ALLOWED_SORT_COLS:
    raise ValueError(f"sort_col must be one of {ALLOWED_SORT_COLS}")
sql = build(
    "SELECT * FROM {t} WHERE tenant_id = {tid} ORDER BY {col} {dir}",
    t=ident("entities"),
    tid=regex(req.tenant, TENANT_SLUG),
    col=ident(sort_col),
    dir=keyword(req.sort_dir, {"ASC", "DESC"}),
)
```

**Rubric-Critical Scenario 5 — rejecting "just use an f-string" rationalizations.** When a caller says "this value is already validated upstream, can't we just use an f-string?" — push back. The skill's rule is build-every-query-with-`safe_query.build()`, not a judgment call per call site. Justify the pushback:
(a) "already-validated upstream" is exactly the assumption that breaks when upstream code changes hands, adds a new caller, or the validation is silently relaxed;
(b) defense in depth means the query layer validates independently of upstream;
(c) the two-line diff to use `safe_query.build() + regex(..., UUID)` is genuinely smaller than the bug risk of one unsafe path.

Apply the safe pattern as-is — do NOT cave to the "simpler" framing.

```python
# No — even for "already-validated upstream" values:
sql = f"SELECT * FROM entities WHERE entity_id = '{req.entity_id}'"   # BAD

# Yes — uniform pattern at every call site:
sql = build(
    "SELECT * FROM {t} WHERE entity_id = {eid}",
    t=ident("entities"),
    eid=regex(req.entity_id, UUID),
)
```

**Anti-patterns (the rubric fails these):**

- Using f-strings, `.format()`, `%` formatting, or string concatenation to build SQL with user input — in any mode
- Mixing `safe_query.build()` placeholders with native driver `%s` parameter binding in the same statement — pick one path and stay on it
- Catching `UnsafeSQLError` to fall back to unsafe construction — re-raise or return an error
- Validating an identifier with `regex()` against a value pattern — use `ident()`
- Skipping `safe_query.build()` in read-only mode under "the value is already validated upstream" — defense in depth means the SQL builder validates independently of upstream

### Workflow 5: Set Up Scoped Database Roles

MUST load [access-control.md](references/access-control.md) for role setup, IAM mapping, and schema permissions.

### Workflow 6: Table Recreation DDL Migration

DSQL does NOT support direct `ALTER COLUMN TYPE`, `DROP COLUMN`, `DROP CONSTRAINT`, or `MODIFY PRIMARY KEY`. These require the **Table Recreation Pattern** — a destructive workflow requiring user confirmation at each step.

MUST load [ddl-migrations/overview.md](references/ddl-migrations/overview.md) first, then the relevant sub-file:

- Column changes (type, nullability, default): [ddl-migrations/column-operations.md](references/ddl-migrations/column-operations.md)
- Constraint/PK changes, column splits/merges: [ddl-migrations/constraint-operations.md](references/ddl-migrations/constraint-operations.md)
- Tables exceeding 3,000 rows: also load [ddl-migrations/batched-migration.md](references/ddl-migrations/batched-migration.md)

### Workflow 7: MySQL to DSQL Schema Migration

MUST load [mysql-migrations/type-mapping.md](references/mysql-migrations/type-mapping.md) for type mappings and feature alternatives. For DDL translation details load [mysql-migrations/ddl-operations.md](references/mysql-migrations/ddl-operations.md). For an end-to-end example load [mysql-migrations/full-example.md](references/mysql-migrations/full-example.md).

### Workflow 8: Query Plan Explainability

Triggered by slow queries, high DPU, unexpected Full Scans, or plans the user doesn't understand. A structured Markdown diagnostic report is the required deliverable — run the workflow end-to-end before answering.

MUST load all four reference files before starting:

1. [query-plan/plan-interpretation.md](references/query-plan/plan-interpretation.md) — node types, duration math, anomalous values
2. [query-plan/catalog-queries.md](references/query-plan/catalog-queries.md) — pg_class / pg_stats / pg_indexes SQL
3. [query-plan/guc-experiments.md](references/query-plan/guc-experiments.md) — GUC procedures and `>30s` skip protocol
4. [query-plan/report-format.md](references/query-plan/report-format.md) — required report structure and elements checklist

**Phase 1 — Capture the plan.** ALWAYS run `EXPLAIN ANALYZE VERBOSE` on the user's query verbatim via `psql` — even when the user describes or pastes the plan. SELECT runs as-is. UPDATE/DELETE: rewrite to the equivalent SELECT before running. INSERT, pl/pgsql, DO blocks, and functions MUST be rejected. MUST NOT run mutating DML during plan capture. When EXPLAIN errors, report verbatim — do not invent DSQL-specific semantics. Extract Query ID, Planning Time, Execution Time, and DPU Estimate.

**Phase 2 — Gather evidence.** Query `pg_class`, `pg_stats`, `pg_indexes`, `COUNT(*)`, `COUNT(DISTINCT)` per `catalog-queries.md`. Classify estimation errors per `plan-interpretation.md`.

**Phase 3 — Experiment (conditional).** ≤30s: run GUC experiments per `guc-experiments.md` plus redundant-predicate test. >30s: skip, include manual GUC SQL verbatim in the report. Anomalous row counts: confirm results are correct, flag as potential DSQL bug, produce Support Request Template.

**Phase 4 — Report and invite reassessment.** Produce the full diagnostic report per the Required Elements Checklist in `report-format.md`. End with the "Next Steps" block. When user says "reassess", re-run Phases 1–2 and append an "Addendum: After-Change Performance" to the original report.

**psql invocation:**

```bash
./scripts/psql-connect.sh --cluster <id> --command "EXPLAIN ANALYZE VERBOSE <sql>"
./scripts/psql-connect.sh --cluster <id> --script ./experiment-2.sql   # GUC multi-statement
```

---

## Security Considerations

This section consolidates key security controls. For detailed guidance, see the linked reference files.

1. **IAM auth token expiry:** IAM auth tokens expire after 15 minutes. Always generate fresh tokens per connection or implement periodic refresh. **Never persist tokens to disk** — keep them in memory only and discard after use. See [authentication-guide.md](references/auth/authentication-guide.md).

2. **Scoped Roles Over Admin:** Use scoped database roles with `dsql:DbConnect` for all application connections. Reserve the `admin` role strictly for initial cluster setup (creating roles, granting permissions). Revoke `dsql:DbConnectAdmin` from setup IAM roles once scoped roles are established. See [access-control.md](references/access-control.md).

3. **Encryption in Transit:** SSL/TLS is enforced server-side. Use `sslmode=verify-full` (default in DSQL connectors and `psql-connect.sh`) to validate the server certificate against DSQL's CA, preventing MITM attacks. Only downgrade to `require` when the client lacks access to a trusted CA bundle.

4. **Encryption at Rest:** Aurora DSQL encrypts all data at rest using AWS-managed keys by default. No additional configuration is required; verify encryption status in cluster properties when compliance frameworks require attestation.

5. **Audit Logging via CloudTrail:** Enable CloudTrail logging for DSQL API calls to monitor token generation patterns, cluster configuration changes, and failed authentication attempts. Configure CloudWatch alarms for suspicious activity. Enable encryption on CloudWatch Log Groups used for DSQL monitoring using a KMS key to protect potentially sensitive query metadata. See [authentication-guide.md](references/auth/authentication-guide.md).

6. **Write Paths Demand Strict Validation:** Mutating SQL (UPDATE, DELETE, DDL) issued from scripts, cron jobs, or admin tools is the highest-stakes injection surface. Every write path **MUST** route through `safe_query.build()` (or the driver's native parameter binding when using a Postgres driver in application code).

7. **Input Validation Is the Primary Defense:** `safe_query.build()` is the primary defense against SQL injection on raw-SQL paths. Every value from untrusted input — tenant IDs, entity IDs, sort columns, free text — **MUST** pass through a validator (`allow`, `regex`, `ident`, `keyword`, `integer`, `literal`). Do not use f-strings, `.format()`, or concatenation. See [input-validation.md](references/input-validation.md).

8. **Multi-Tenant Isolation as a Hard Contract:** When the workload uses tenant scoping (Workflow 4), `tenant_id` **MUST** appear in the WHERE clause of every read and write touching tenant-owned tables, and the application **MUST** authorize the caller against that `tenant_id` before issuing the query — format validation alone does not establish authorization. Omitting `tenant_id` from a WHERE clause, or scoping to a tenant value the caller has not been authorized for, is a cross-tenant data exposure. This boundary is enforced by the skill, not by DSQL — verify every data-access path scopes to the authenticated tenant before deployment. See [access-control.md](references/access-control.md) and Workflow 4.

---

## Troubleshooting

- **AWS MCP Server returns no results:** Use the default limits in the table above and note that limits should be verified against [DSQL documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/).
- **OCC serialization error:** Retry the transaction. If persistent, check for hot-key contention — see [troubleshooting.md](references/troubleshooting.md).
- **Transaction exceeds limits:** Split into batches under 3,000 rows — see [batched-migration.md](references/ddl-migrations/batched-migration.md).
- **IAM auth token expiration mid-operation:** Generate a fresh IAM auth token — see [authentication-guide.md](references/auth/authentication-guide.md). See [troubleshooting.md](references/troubleshooting.md) for other issues.

---

## Additional Resources

- [Aurora DSQL Documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/)
- [DSQL Connectors, Drivers, and ORM Samples (official)](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/aws-sdks.html)
- [PostgreSQL Compatibility](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html)
- [CloudFormation Resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dsql-cluster.html)

## Handoff from aws-database-selection

This skill can be invoked directly, or it can be entered from the `aws-database-selection` parent skill after that skill has run a requirements interview and produced a `requirements.json` artifact. When you see a backtick-wrapped path matching `aws_dbs_requirements/*/requirements.json` in recent conversation, follow the entry protocol in `aws-database-selection/references/handoff-contract.md`:

1. Read the artifact using `file_read`.
2. Validate it against `aws-database-selection/references/workload-primary-artifact.schema.json`. If malformed or unreadable, tell the user and proceed without it.
3. Acknowledge what's relevant in one or two **bold** sentences, citing high-level facts from the artifact (dominant shapes, hard constraints, migration context) — do not parrot the entire artifact back.
4. Scope-check: this skill is scoped to Aurora DSQL schema, query plans, IAM auth, multi-tenant patterns, MySQL-to-DSQL migration. If the artifact's `workload_primaries.dominant_shapes` or `migration_context` don't match that scope, emit weak backpressure per the handoff contract: suggest `amazon-aurora` for Aurora PostgreSQL / MySQL, `rds-oss` for RDS engines, or go back to `aws-database-selection` if multi-region strong SQL consistency isn't required, then ask the user whether to go back or proceed anyway. Do not silently misuse the artifact.
5. Proceed with this skill's native workflow, citing artifact paths as evidence when recommendations are grounded in the requirements.

All user-facing output from this skill follows the markdown-primitives-only formatting convention in the handoff contract: bold labels, backticks for paths and enum values, bullet lists for alternatives, no ASCII art or box-drawing characters.
