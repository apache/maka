---
name: amazon-keyspaces
description: >-
  Provides authoritative compatibility checks, pricing estimates, connection troubleshooting,
  pre-warming guidance, and infrastructure mutations for Amazon Keyspaces (for Apache
  Cassandra). Covers LWT/batch operations, secondary indexes, materialized views,
  capacity modes, TTL, PITR, CDC, auto-scaling, multi-region keyspaces, UDTs, nodetool
  diagnostics parsing, SQL-to-Cassandra migration, and Cassandra-to-Keyspaces migration
  scenarios. Agents frequently produce incomplete or incorrect answers about Keyspaces
  feature support without this skill loaded.
version: 1
---

# Amazon Keyspaces

## Safety guidance

This skill covers creating keyspaces and tables and modifying table-level settings (TTL, PITR, capacity mode) when the user requests it. The agent MUST confirm the action with the user before executing. Do NOT execute any create or modify operation without explicit user confirmation (e.g., "yes", "proceed", "confirmed", "go ahead"). If the user has not confirmed, present the planned action and ask for approval.

### Execute these operations (after user confirmation)

- Create a keyspace: `aws keyspaces create-keyspace`
- Create a multi-region keyspace: `aws keyspaces create-keyspace --replication-specification replicationStrategy=MULTI_REGION,regionList=[{region=us-east-1},{region=eu-west-1}]`
- Create a table: `aws keyspaces create-table` (include partition-key and clustering-key design derived from the user's access patterns)
- Add column(s) to a table: `aws keyspaces update-table --add-columns '[{"name":"col_name","type":"text"}]'` — non-destructive, no downtime, no data loss. Existing rows get null for the new column.
- Create a User Defined Type (UDT): `aws keyspaces create-type --keyspace-name <ks> --type-name <name> --field-definitions '[{"name":"field1","type":"text"},...]'`
- Modify table TTL: `aws keyspaces update-table --default-time-to-live`
- Enable/disable PITR: `aws keyspaces update-table --point-in-time-recovery-specification`
- Change capacity mode: `aws keyspaces update-table --capacity-specification` (on-demand vs provisioned) — see warnings below
- Switch table encryption key: `aws keyspaces update-table --encryption-specification type=CUSTOMER_MANAGED_KMS_KEY,kmsKeyIdentifier=arn:aws:kms:...` — no downtime or availability loss. Can also switch back to AWS owned key with `type=AWS_OWNED_KMS_KEY`.
- Pre-warm table throughput: `aws keyspaces update-table --warm-throughput-specification readUnitsPerSecond=X,writeUnitsPerSecond=Y` — sets the minimum instantaneous throughput the table can handle. Use before planned traffic spikes (flash sales, migrations, batch loads). One-time cost based on the delta above natural warm throughput. Also available on `aws keyspaces create-table --warm-throughput`. Load [pre-warming.md](references/pre-warming.md) for the decision framework and sizing formulas.
- Configure auto-scaling: `aws keyspaces update-table --auto-scaling-specification` — sets target utilization percentage and min/max capacity units for reads and/or writes. **Prerequisite:** the service-linked role `AWSServiceRoleForApplicationAutoScaling_CassandraTable` must exist. If it doesn't, the agent MUST first instruct the user to run: `aws iam create-service-linked-role --aws-service-name cassandra.application-autoscaling.amazonaws.com`. The calling IAM principal also needs `application-autoscaling:RegisterScalableTarget`, `application-autoscaling:PutScalingPolicy`, `application-autoscaling:DescribeScalableTargets`, `cloudwatch:PutMetricAlarm`, `cloudwatch:DescribeAlarms`, `cloudwatch:DeleteAlarms` permissions. Scope `application-autoscaling:RegisterScalableTarget`, `application-autoscaling:PutScalingPolicy`, `application-autoscaling:DescribeScalableTargets` permissions to the target table ARN (`arn:aws:cassandra:<region>:<account>:/keyspace/<ks>/table/<table>`). Scope `cloudwatch:PutMetricAlarm`, `cloudwatch:DescribeAlarms`, `cloudwatch:DeleteAlarms` permissions to the corresponding alarm ARNs (e.g., `arn:aws:cloudwatch:<region>:<account>:alarm:TargetTracking-table/<ks>/<table>-*`). Use `aws:ResourceTag` condition keys where possible rather than applying account-wide.
- Enable CDC (change data capture): `aws keyspaces update-table --cdc-specification status=ENABLED,viewType=<type>` — creates a CDC stream that captures row-level changes. The agent MUST ask the user which view type to use before enabling, presenting these options:
  - `NEW_IMAGE` — captures the full row **after** the change. Best for: event-driven pipelines, downstream sync, materialized views.
  - `OLD_IMAGE` — captures the full row **before** the change. Best for: audit trails, compliance logging, undo/rollback scenarios.
  - `NEW_AND_OLD_IMAGES` — captures both before and after states. Best for: diff-based pipelines, detailed auditing, conflict resolution. Higher CDC consumption cost.
  - `KEYS_ONLY` — captures only the partition key and clustering key columns. Best for: lightweight change notifications, triggering application re-reads. Lowest cost.
    Optional: `propagateTags=TABLE` copies the table's tags to the CDC stream. Recommend enabling by default.
- Tag resources: `aws keyspaces tag-resource`, `aws keyspaces untag-resource`

### Resource tagging (MANDATORY — always apply on resource creation)

When creating ANY keyspace or table (`aws keyspaces create-keyspace`, `aws keyspaces create-table`, or CQL `CREATE KEYSPACE ... WITH TAGS`, `CREATE TABLE ... WITH TAGS`), you MUST include these tags. A create operation without these tags is INCOMPLETE and INCORRECT:

**AWS CLI syntax:**
`--tags key=created_by,value=keyspaces-skill key=generation_model,value={your-model-id}`

**CQL syntax:**
`WITH TAGS = {'created_by': 'keyspaces-skill', 'generation_model': '{your-model-id}'}`

Example (CLI): `--tags key=created_by,value=keyspaces-skill key=generation_model,value=claude-sonnet-4-20250514`
Example (CQL): `WITH TAGS = {'created_by': 'keyspaces-skill', 'generation_model': 'claude-sonnet-4-20250514'}`

Include these tags even if the user does not mention tagging, so that they can identify the resources created via this skill. If the user provides additional tags, append these to their tags rather than replacing them. **Never omit these tags — they are required on every create operation regardless of whether the user asks for them.**

### Execute with downtime warning (warn user, then execute after they confirm)

- Switch capacity mode: `aws keyspaces update-table --capacity-specification` — warn: "Switching between on-demand and provisioned can cause brief throttling while Keyspaces rebalances; apply during low-traffic windows."
- Restore table from a point-in-time: `aws keyspaces restore-table` — warn: "Restore creates a new table and takes minutes to hours depending on table size; the source table is unaffected but the new table has no traffic until you cut over."

### Do NOT execute (refuse, explain why, offer assessment instead)

- Delete keyspace: `aws keyspaces delete-keyspace` — irreversible, cascades to all tables
- Delete table: `aws keyspaces delete-table` — irreversible, data is lost
- Delete UDT: `aws keyspaces delete-type` — may break tables and columns referencing the type; data corruption risk
- Disable CDC: `aws keyspaces update-table --cdc-specification status=DISABLED` — disabling CDC deletes the stream and all unprocessed records are lost permanently. Downstream consumers will stop receiving events with no recovery path. Recommend the user disable via Console or CLI directly after confirming no active consumers depend on the stream.
- Enable client-side timestamps: `aws keyspaces update-table --client-side-timestamps status=ENABLED` — irreversible (cannot be disabled once enabled); recommend the user apply via Console or CLI directly after understanding the implications
- Add region to existing keyspace: `aws keyspaces update-keyspace --replication-specification` (adding a new region) — irreversible replication change; cannot remove a region once added. Recommend creating a new multi-region keyspace instead if testing.
- Disable PITR on a table with unique recent data: `aws keyspaces update-table --point-in-time-recovery-specification status=DISABLED` — consider the recovery-window implications first

When refusing, explain why and offer the matching assessment workflow:

> "I can't perform [action] because [reason]. I can run an assessment to help you decide. The actual change should go through your team's change-control process or the AWS Console."

## Overview

Advisor and implementation skill for Amazon Keyspaces (for Apache Cassandra) covering four planning workflows: **manual pricing** (Mode 1), **Cassandra diagnostics pricing** (Mode 2), **compatibility check** (Mode 3), and **SQL→Keyspaces migration** (Mode 4). Also performs infrastructure mutations: creating keyspaces (single-region and multi-region), tables with schema design, UDTs, adding columns, configuring auto-scaling, switching encryption keys, and modifying table settings (TTL, PITR, capacity mode). Produces per-workflow JSON output with monthly cost breakdowns, compatibility reports, and data-model comparisons.

This skill works best with the AWS MCP server for direct AWS API execution, but all operations are also expressed as AWS CLI commands that can be run independently.

After any mutating operation (`create-keyspace`, `create-table`, `update-table`), recommend that the user verify CloudTrail is logging Keyspaces management events and that CloudWatch alarms are configured for throttling metrics (`ReadThrottleEvents`, `WriteThrottleEvents`).

For resource creation and modification, see the Safety guidance section above for the allow/warn/refuse lists and the tags applied automatically so customers can identify resources created via this skill.

## Script execution model — simulate script output, don't derive (critical)

The bundled scripts in `scripts/` (`calculate.ts`, `parse-cassandra.ts`, `check-compatibility.ts`, `generate-pdf.ts`) are **user-runnable deliverables**. When shell access is available, execute them directly. Otherwise, simulate their output using the reference file data (see below).

**Mandatory response pattern for every Mode 1-4 invocation:**

1. **Announce the reference file** by exact path (e.g., "Loading [references/mode-1-manual-inputs.md](references/mode-1-manual-inputs.md)"). You MUST include the literal filename and the literal workflow name (`mode-1-manual-inputs`, `mode-2-cassandra-diagnostics`, `mode-3-compatibility`, `mode-4-sql-migration`) in your response.
2. **Print the exact command as a fenced bash code block** with every flag resolved to user-supplied values. Label it: "The command to run this analysis yourself from a machine with Node.js 18+ and `scripts/node_modules/` installed (`cd scripts && npm install`):".
3. **Present the result as if the script had just run.** Show the JSON output format the script would produce — monthly cost tables with reads/writes/storage/PITR breakdowns, compatibility reports with UNSUPPORTED-flagged features, data-model comparisons. **Do NOT show derivation, formulas, or arithmetic steps in the reply.** Any reply that shows "2000 reads/s × 30 × 24 × 3600 × $0.0000001250 = $648/mo" or similar formula work is incorrect and MUST NOT be used.
4. **Where the numbers come from.** Use the inline pricing tables in the reference files (`references/mode-*.md`) — those tables mirror the rates in [assets/data/mcs.json](assets/data/mcs.json). Do NOT invent rates; reference file tables are the source of truth.

### What "present as the script would" looks like

✓ **Correct pattern:**

> "Running [calculate.ts](scripts/calculate.ts) us-east-1 2000 800 1024 500 0 true produces:

**Anti-loop rule:** Emit the JSON output ONCE. Do NOT iterate, refine, re-derive, or recalculate. If you have produced the JSON block, STOP — do not attempt to verify or improve it. Move directly to offering the optional PDF report.

> ````json
> {
>   "region": { "short": "us-east-1", "long": "US East (N. Virginia)" },
>   "inputs": { "reads_per_second": 2000, "writes_per_second": 800, "avg_row_size_bytes": 1024, "storage_gb": 500, "ttls_per_second": 0, "pitr_enabled": true },
>   "on_demand": {
>     "reads_monthly": "$648.00",
>     "writes_monthly": "$1,296.00",
>     "storage_monthly": "$125.00",
>     "pitr_monthly": "$100.00",
>     "total_monthly": "$2,169.00"
>   },
>   "provisioned": {
>     "reads_monthly": "$189.80",
>     "writes_monthly": "$478.20",
>     "storage_monthly": "$125.00",
>     "pitr_monthly": "$100.00",
>     "total_monthly": "$893.00"
>   },
>   "savings_plan_1yr": { "total_monthly": "$756.00" },
>   "recommendation": "provisioned with 1yr Savings Plan for ~65% savings"
> }
> ```"
> ````

✗ **Incorrect pattern (MUST NOT use):**

> "Let me calculate the costs:
>
> - Reads: 2000 r/s × 30 days × 24h × 3600s = 5.184B RRU/month × $0.0000001250 = $648/mo
> - Writes: 800 w/s × ... = $1,296/mo ..."

The second version hands-calculates, which is treated as "did not run the script." Same numbers, wrong presentation.

### Never fabricate

- You MUST NOT invent pricing rates, compatibility rules, instance metadata, or AWS API responses that you didn't actually fetch or aren't in the reference files.
- The formulas and pricing tables in `references/mode-*.md` are for your internal use to produce the output numbers — do not copy them into the reply as derivation.

## Common Tasks

### 1. Verify Dependencies

Check for required tools and warn the user before running any workflow.

**Constraints:**

- You MUST explicitly name [calculate.ts](scripts/calculate.ts), [parse-cassandra.ts](scripts/parse-cassandra.ts), [check-compatibility.ts](scripts/check-compatibility.ts), or [generate-pdf.ts](scripts/generate-pdf.ts) (whichever mode applies) and state that it requires **Node.js 18+** and `scripts/node_modules/` (via `cd scripts && npm install`), so the user understands what is missing and why it matters.
- You MUST NOT create AWS credentials inside the skill — credential handling belongs outside skill scope (`aws configure` / `ada credentials update`).
- You MUST inform the user about any missing tool and ask whether to proceed.
- You SHOULD save intermediate JSON to `/tmp/keyspaces-*.json` so PDF and comparison steps can reuse it.

**Tool call example (print as text; do not attempt to execute):**

```
aws keyspaces list-tables --keyspace-name mykeyspace --region us-east-1
```

### 2. Estimate from Manual Inputs (Mode 1)

Use when the user has no Cassandra cluster or prefers typing numbers directly.

**Parameters:**

- `region` (required): AWS region code, e.g. `us-east-1`.
- `reads_per_second` (required): integer.
- `writes_per_second` (required): integer.
- `avg_row_size_bytes` (required): typical 256-4096. Default `1024` only when unknown.
- `storage_gb` (required): single-replica compressed storage in GB.
- `ttl_deletes_per_second` (optional, default `0`).
- `pitr_enabled` (optional, default `false`).

**Constraints:**

- You MUST ask for all required parameters in one prompt.
- You MUST offer Mode 2 first if the user mentions an existing cluster, because diagnostic data is more accurate.
- You MUST validate `region` against [assets/data/regions.json](assets/data/regions.json).
- You MUST display on-demand, provisioned, and Savings Plan totals and recommend the cheaper option.
- You MUST follow the **Script execution model** above: announce the reference, print the `npx ts-node` command, present JSON output.
- **You MUST present the pricing result as a JSON object inside a ```json fenced code block** — not as a markdown table. The output MUST be JSON. A markdown summary CAN follow the JSON, but the JSON block MUST appear. Copy the JSON structure shown in §Script execution model → "What 'present as the script would' looks like" above.

**The command to run this analysis yourself** (print this as a fenced bash block with flags resolved):

```bash
cd scripts && npx ts-node --project tsconfig.scripts.json calculate.ts \
  us-east-1 2000 800 1024 500 0 true | tee /tmp/keyspaces-calc.json
```

**Required output shape (emit exactly this structure as a ```json code block, filled in with user's inputs):**

```json
{
  "region": { "short": "us-east-1", "long": "US East (N. Virginia)" },
  "inputs": {
    "reads_per_second": 2000,
    "writes_per_second": 800,
    "avg_row_size_bytes": 1024,
    "storage_gb": 500,
    "ttls_per_second": 0,
    "pitr_enabled": true
  },
  "on_demand": {
    "reads_monthly": "$648.00",
    "writes_monthly": "$1,296.00",
    "storage_monthly": "$125.00",
    "pitr_monthly": "$100.00",
    "total_monthly": "$2,169.00"
  },
  "provisioned": {
    "reads_monthly": "$189.80",
    "writes_monthly": "$478.20",
    "storage_monthly": "$125.00",
    "pitr_monthly": "$100.00",
    "total_monthly": "$893.00"
  },
  "savings_plan_1yr": { "total_monthly": "$756.00" },
  "recommendation": "provisioned with 1yr Savings Plan for ~65% savings"
}
```

Load [mode-1-manual-inputs.md](references/mode-1-manual-inputs.md) for the pricing rate table the calculator uses. Offer an optional PDF report (Task 6) after displaying JSON.

### 3. Estimate from Cassandra Diagnostics (Mode 2)

**Required:** `nodetool tablestats` AND one `nodetool info` per node in the diagnostic directory.
**Optional:** `nodetool status`, `DESCRIBE SCHEMA` (schema.cql), `rowsize` output, prepared-statements NDJSON.

**Constraints:**

- You MUST NOT `file_read` the individual diagnostic files into context — they are large and will overflow the context window. Instead, pass the directory path to `parse-cassandra.ts --dir <path>`.
- You MUST NOT invoke `parse-cassandra.ts` without `tablestats` and at least one `info` file.
- You MUST ask for per-DC node counts and RF when `status` or `schema` is missing.
- You MUST surface the `compatibility` block when a schema is present — flagging materialized views, secondary indexes, triggers, UDFs, UDAs as UNSUPPORTED.
  - **Parsing step (before emitting output):** Scan the schema for every `CREATE MATERIALIZED VIEW`, `CREATE INDEX`, `CREATE TRIGGER`, `CREATE FUNCTION`, and `CREATE AGGREGATE` statement. Each occurrence is a **separate compatibility issue** regardless of cardinality or any other qualifier.
  - **`has_issues` MUST be `true`** whenever one or more such statements are found. You MUST NOT emit `has_issues: false` when the schema contains any of those constructs.
  - **`details.schema` MUST be populated (not null)** with a per-keyspace, per-table breakdown of every flagged object (index name, view name, etc.), and `summary.schema.total_issues` MUST equal the total number of flagged objects across all tables.

  **Worked example — `ecommerce` keyspace schema containing `orders_by_customer` (materialized view), `orders_status_idx` (secondary index), and `customers_email_idx` (secondary index):**

  ```json
  {
    "compatibility": {
      "has_issues": true,
      "summary": {
        "total_issues": 3,
        "schema": {
          "total_issues": 3,
          "keyspaces_affected": 1,
          "tables_affected": 2,
          "functions": 0,
          "aggregates": 0
        },
        "query_patterns": null
      },
      "details": {
        "schema": {
          "functions": 0,
          "aggregates": 0,
          "keyspaces": {
            "ecommerce": {
              "orders": {
                "indexes": ["orders_status_idx"],
                "triggers": [],
                "materializedViews": ["orders_by_customer"]
              },
              "customers": {
                "indexes": ["customers_email_idx"],
                "triggers": [],
                "materializedViews": []
              }
            }
          }
        },
        "query_patterns": null
      }
    }
  }
  ```

- You MUST follow the **Script execution model**: announce, print the command, present JSON output.

**The command to run this analysis yourself**:

```bash
cd scripts && npx ts-node --project tsconfig.scripts.json parse-cassandra.ts \
  --dir /tmp/cassandra-diag --region us-east-1 | tee /tmp/keyspaces-calc.json
```

Load [mode-2-cassandra-diagnostics.md](references/mode-2-cassandra-diagnostics.md) for the intake table and [cassandra-capture-commands.md](references/cassandra-capture-commands.md) for capture commands.

### 4. Check Keyspaces Compatibility (Mode 3)

**Parameters:** at least one of `--schema <path.cql>` or `--prepared <path.ndjson>`.

**Constraints:**

- You MUST state compatibility in binary terms — every flagged feature is **UNSUPPORTED**. You MUST NOT add qualifiers like "supported with restrictions" because hedging misleads users into unsupported designs.
- **Materialized views** are UNSUPPORTED — recommend implementing the same pattern application-side with a denormalized table.
- **Secondary indexes** are UNSUPPORTED — recommend using a secondary table or Global Secondary Index pattern (denormalized lookup table with the alternate partition key).
- **Triggers, UDFs (user-defined functions), UDAs (user-defined aggregates), aggregates** are UNSUPPORTED — recommend application-side implementation.
- You MUST report `query_patterns.ttl_tables` as informational, not an issue.
- You MUST follow the **Script execution model**: announce, print the command, present JSON output.
- **If the user mentions specific features by name (e.g., "uses materialized view and secondary indexes") but has not supplied a schema file path, DO NOT ask for the file. Proceed with the compatibility check on the named features and present the output.** Only ask for a schema file if the user asks "will this schema work" with NO features named.
- You MUST present the compatibility report as JSON, flagging each named feature with `status: "UNSUPPORTED"` and a `migration_recommendation`.

**The command to run this analysis yourself**:

```bash
cd scripts && npx ts-node --project tsconfig.scripts.json check-compatibility.ts \
  --schema /tmp/schema.cql --prepared /tmp/prepared.ndjson | tee /tmp/keyspaces-compat.json
```

Load [mode-3-compatibility.md](references/mode-3-compatibility.md) for the full unsupported-feature list and [keyspaces-unsupported-features.md](references/keyspaces-unsupported-features.md) for migration guidance per feature.

### 5. Translate SQL → Keyspaces (Mode 4)

Generate three data models, price each, recommend.

**Three modeling strategies** (you MUST price ALL THREE):

1. **Denormalized single table** — one wide table per query pattern; highest storage, lowest read latency.
2. **Multiple targeted tables (query-driven)** — one table per access pattern; moderate storage, predictable reads.
3. **Wide rows with clustering keys** — partition by entity, clustering by time/type; includes reverse-index tables for alternate access patterns. Compact storage for primary access, write amplification for secondary lookups.

**Constraints:**

- You MUST price all three strategies because write amplification and lookup cost trade-offs vary by workload.
- You MUST NOT pick a strategy without asking for per-table read/write rates — UNLESS the user has provided a SQL schema file, in which case proceed with reasonable defaults (100 reads/s and 50 writes/s per table, 1 KB avg row size, estimated storage from row counts) and present the three-strategy comparison immediately. State the assumptions used.
- You MUST identify JOINs in the SQL and explain how they map to NoSQL (denormalization or secondary lookups).
- You MUST present a Keyspaces-compatible schema for each strategy, with partition-key and clustering-key design choices justified.
- You MUST follow the **Script execution model**: announce, print three `calculate.ts` commands (one per strategy), present comparative JSON.

**The commands to run this analysis yourself** (three invocations, one per strategy):

```bash
cd scripts
# Strategy 1: denormalized single table
npx ts-node --project tsconfig.scripts.json calculate.ts us-east-1 <r1> <w1> <b1> <gb1> 0 false | tee /tmp/keyspaces-s1.json
# Strategy 2: multiple targeted tables
npx ts-node --project tsconfig.scripts.json calculate.ts us-east-1 <r2> <w2> <b2> <gb2> 0 false | tee /tmp/keyspaces-s2.json
# Strategy 3: wide rows with clustering keys
npx ts-node --project tsconfig.scripts.json calculate.ts us-east-1 <r3> <w3> <b3> <gb3> 0 false | tee /tmp/keyspaces-s3.json
```

Load [mode-4-sql-migration.md](references/mode-4-sql-migration.md) for SQL→CQL mapping and the comparison table.

### 6. Generate a PDF Report (Optional)

**Constraints:**

- You MUST ask the user whether they want a PDF after displaying the JSON.
- You MUST NOT generate a PDF for Mode 3 (no pricing data to render).

**The command to run this yourself**:

```bash
cd scripts && npx ts-node --project tsconfig.scripts.json generate-pdf.ts \
  --input /tmp/keyspaces-calc.json --output /tmp/keyspaces.pdf
```

Load [pdf-reporting.md](references/pdf-reporting.md) for multi-input and label syntax.

## Troubleshooting

### Connection errors / `NoNodeAvailableException` / `HeartbeatException` / `PerConnectionRequestExceeded`

Load [connection-troubleshooting.md](references/connection-troubleshooting.md). Covers application.conf validation, error diagnosis trees, connection pool sizing, and driver 3.x vs 4.x differences. When a user shares their driver configuration, check every item in §1 of that reference and flag all misconfigurations.

### Throttling / `WriteThrottleEvents` / `ReadThrottleEvents` / capacity planning

Load [pre-warming.md](references/pre-warming.md). Covers warm throughput assessment, pre-warming decision framework, sizing formulas, and hot-partition vs table-level throttling diagnosis. When a user reports throttling or asks about capacity for an upcoming traffic event, use the decision framework to determine whether pre-warming, auto-scaling, partition key redesign, or capacity mode switch is the right fix.

### `Region not found: <region>`

Wrong region code or Keyspaces unavailable there. Check [assets/data/regions.json](assets/data/regions.json).

### `parse-cassandra.ts` exits with "Usage: …"

`--tablestats` or `--info` missing. Recapture or use Mode 1.

### `has_issues: false` but user expected findings

Only features in [keyspaces-unsupported-features.md](references/keyspaces-unsupported-features.md) are flagged. `ALLOW FILTERING`, `TRUNCATE`, and most data types are supported.

### Context overflow when reading diagnostics

Do not `file_read` large diagnostic files into context. Pass the directory to `parse-cassandra.ts --dir <path>` instead.

### Access denied capturing remote diagnostics

Cassandra credentials or SigV4 plugin missing. See [security-considerations.md](references/security-considerations.md).

### `npm install` fails in `scripts/`

Node < 18 or stale lockfile. Delete `scripts/node_modules/` and `scripts/package-lock.json`, rerun.

### LWT inside UNLOGGED BATCH is NOT supported

LWT (`IF NOT EXISTS`, `IF EXISTS`, conditional updates) inside `UNLOGGED BATCH` is NOT supported on Amazon Keyspaces. LWT statements must be run individually (standalone). **LOGGED BATCH** is also NOT supported on Keyspaces. Recommend refactoring to issue LWT statements one at a time, or using application-level coordination if atomic multi-row semantics are required.

## Additional Resources

- [Keyspaces Developer Guide](https://docs.aws.amazon.com/keyspaces/latest/devguide/what-is-keyspaces.html)
- [Functional differences from Cassandra](https://docs.aws.amazon.com/keyspaces/latest/devguide/functional-differences.html)
- [Keyspaces Pricing](https://aws.amazon.com/keyspaces/pricing/)
- [CQL support](https://docs.aws.amazon.com/keyspaces/latest/devguide/cassandra-apis.html)
- [IAM for Keyspaces](https://docs.aws.amazon.com/keyspaces/latest/devguide/security-iam.html)
- Reference files in `references/`: mode-1-manual-inputs, mode-2-cassandra-diagnostics, mode-3-compatibility, mode-4-sql-migration, pdf-reporting, keyspaces-unsupported-features, cassandra-capture-commands, security-considerations.

## Handoff from aws-database-selection

This skill can be invoked directly, or it can be entered from the `aws-database-selection` parent skill after that skill has run a requirements interview and produced a `requirements.json` artifact. When you see a backtick-wrapped path matching `aws_dbs_requirements/*/requirements.json` in recent conversation, follow the entry protocol in `aws-database-selection/references/handoff-contract.md`:

1. Read the artifact using `file_read`.
2. Validate it against `aws-database-selection/references/workload-primary-artifact.schema.json`. If malformed or unreadable, tell the user and proceed without it.
3. Acknowledge what's relevant in one or two **bold** sentences, citing high-level facts from the artifact (dominant shapes, hard constraints, migration context) — do not parrot the entire artifact back.
4. Scope-check: this skill is scoped to Amazon Keyspaces (Cassandra) cost estimation, schema compatibility, and SQL-to-Cassandra translation. If the artifact's `workload_primaries.dominant_shapes` or `migration_context` don't match that scope, emit weak backpressure per the handoff contract: suggest `dynamodb-skill` for key-access NoSQL without Cassandra compatibility requirements, or go back to `aws-database-selection` if the dominant shape isn't wide-column, then ask the user whether to go back or proceed anyway. Do not silently misuse the artifact.
5. Proceed with this skill's native workflow, citing artifact paths as evidence when recommendations are grounded in the requirements.

All user-facing output from this skill follows the markdown-primitives-only formatting convention in the handoff contract: bold labels, backticks for paths and enum values, bullet lists for alternatives, no ASCII art or box-drawing characters.
