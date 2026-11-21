---
name: migrating-to-amazon-redshift
description: "Guides an end-to-end data-warehouse migration to Amazon Redshift — discovery, schema/SQL/stored-procedure/macro/script conversion, data migration, validation, performance comparison, and reporting. Source-routed via `references/<source>/`; Teradata (Vantage) is the supported source; additional sources are added as their own `references/<source>/` sets. Text-only knowledge (no executable code) — the AI generates all execution at runtime. Applies when a user wants to migrate Teradata to Amazon Redshift, convert Teradata DDL/SQL/stored procedures/macros/BTEQ to Redshift/RSQL, or assess Teradata-to-Redshift migration complexity. Applies only to migrations targeting Amazon Redshift; migrations to other platforms (Snowflake, BigQuery, Databricks, etc.) are out of scope regardless of source. Does not cover general Redshift administration, performance tuning, or troubleshooting of existing Redshift clusters (no migration involved), or sources not listed under references/."
version: 1
---

# Migrating to Amazon Redshift

## What this skill is

This skill is **AI guidance, not an execution framework**. It is **entirely Markdown
knowledge** (rules, mappings, patterns, best practices) — **no executable code**. All
execution — conversion, the discovery/migration/validation runners, dependencies, and
infrastructure — **you (the AI) generate at runtime** from this knowledge, tailored to the
customer's environment.

Principle: **knowledge over shipped code → less drift, nothing for the customer to run or
depend on, reliable first-time results.** Do not look for a pyproject, a tools package, an
orchestrator engine, or shipped scripts — there are none by design; you generate execution.

> **Runtime:** this skill works **with or without the AWS MCP server** — step guidance uses AWS
> CLI syntax. Running it **with the AWS MCP server is recommended** for sandboxed execution and
> audit logging; without it, the AI runs the generated scripts on the host shell (assumes Bash,
> Python 3, and AWS CLI + credentials). Do not assume MCP-only tools are available.

## Source routing

This skill migrates a supported **source data warehouse to Amazon Redshift**. First identify the
**source system**, then load that source's knowledge under `references/<source>/`:

- **Teradata (Vantage)** → `references/teradata/` — supported (all references below).
- _Other sources (e.g. Snowflake, Oracle) — unsupported; each is added as its own `references/<source>/` set when ready._

The **workflow is source-agnostic** (discovery → convert → migrate → validate → performance →
report); only the **conversion knowledge** is source-specific. Everything below is the Teradata set.

## When to use

- Migrating a Teradata system (Vantage) to Amazon Redshift.
- Converting Teradata DDL, SQL, stored procedures, macros, or BTEQ to Redshift/RSQL.
- Assessing Teradata→Redshift migration complexity/effort.

## Operating principles

- **Discovery is strictly read-only (SELECT-only) on the source.** Never change production
  state: no DDL/DML, and never enable logging (`BEGIN/REPLACE QUERY LOGGING`). If DBQL is
  empty, mark it `unavailable` and fall back to always-on `DBC.AMPUsageV` — see
  `references/teradata/discovery-queries.md`.
- **Skill provides knowledge; you generate execution.** Read the `references/` to reason and
  convert — apply the rules in `references/teradata/conversion-rules.md` directly for conversion, and
  generate the discovery/migration/validation runners (and the read-only discovery collector
  from `references/teradata/discovery-queries.md`) tailored to the environment.
- **Generate, don't assume a framework.** Assume the environment has Bash, Python 3, and AWS
  CLI + credentials. Any Python lib a generated script needs (`teradatasql`, `boto3`, …) is
  `pip install`-ed on demand by that script / its run-instructions — pin exact versions.
  Teradata **TTU** (BTEQ/TPT) is **Linux/Windows-only — not macOS**; prefer **WRITE_NOS** +
  **`teradatasql`** (cross-platform, no client) for discovery/extract unless a TTU/Linux host exists.
- **Credentials:** use a **read-only** Teradata user; prefer IAM roles over IAM users. For
  **production**, reference credentials from **AWS Secrets Manager or Systems Manager
  Parameter Store**. For **local development only**, a git-ignored `.env` file or profile may
  be used — never commit it. Never hard-code or echo secrets. In a portable
  bundle, reference a **co-located credentials file** and ship a `credentials.env.example` template — the
  real file is git-ignored.
- **Persist state in files.** All generated output goes under a git-ignored `output/` in the
  user's working dir; keep `output/state.md` current so work is resumable.

## Workflow (phases)

Run in order; each phase's `result/` feeds the next (see `references/teradata/orchestration.md`).

1. **Discovery** — inventory the source. → `references/teradata/discovery-queries.md` (read-only collection SQL + BTEQ driver template the AI generates) → `output/discovery/result/inventory.json`
2. **Conversion** — schema + code. Apply the conversion rules directly, flag the
   manual-rewrite long tail, and fix Redshift errors from the references. →
   `references/teradata/conversion-rules.md`, `references/teradata/data-type-mapping.md`,
   `references/teradata/architecture-mapping.md`, `references/teradata/stored-procedure-migration.md`,
   `references/teradata/bteq-to-rsql.md`, `references/teradata/common-errors.md`
3. **Data migration** — extract → S3 → COPY, restartable. → `references/teradata/data-migration-patterns.md`
4. **Validation** — counts/aggregates/sampling. → `references/teradata/validation-patterns.md`
5. **Performance** — baseline vs Redshift; size the target. → `references/teradata/performance.md`, `references/teradata/sizing.md`
6. **Reporting** — aggregate all phases. → `references/teradata/reporting.md`

## Conversion (how the AI applies it)

There is no converter to run — convert by **applying the rules in
`references/teradata/conversion-rules.md` directly** (with the type / architecture / stored-procedure /
BTEQ references): apply the deterministic rules to the well-understood bulk, **flag the
manual-rewrite constructs** with their suggested rewrites, assign a **confidence** per object,
and fix any Redshift errors using `references/teradata/common-errors.md`. The reference docs are the
single source of truth; `conversion-rules.md` includes golden input→output examples to match.

## Execution modes (connectivity)

- **Connected** — your host can reach Teradata/Redshift → run the generated scripts in place.
- **Disconnected** — it can't → generate a self-contained bundle under `output/<phase>/`
  (script + co-located credentials template + relative `result/` + `run-instructions.md`); the
  operator runs it on a reachable host and copies `result/` back. The copied-back `result/` is
  the durable state — read it (+ `state.md`) and continue.

## Project-workspace layout (per migration run)

```
<project-workspace>/
  migration-config.yaml          # operator-authored: endpoints, scope, strategy
  .gitignore                     # ignores output/
  output/                        # everything generated (git-ignored)
    state.md                     # progress cursor
    discovery/   …  result/inventory.json
    conversion/  …  result/{ddl,sql,procedures,rsql}/  manual_review.json
    data_migration/ … result/{extract,load,templates}/  migration_manifest.json
    validation/  …  result/validation_report.json
    performance/ …  result/{perf_baseline,perf_compare}.json
    reporting/      result/migration_report.md
```

## Security considerations

- **No shipped code or dependencies.** This skill is text-only — the customer runs nothing from
  it. Any runner the AI generates MUST pin exact dependency versions, validate/sanitize inputs
  (file paths, SQL, shell args), and never print or log credentials, secrets, or PII.
- **Least privilege + ephemeral credentials.** Use a **read-only** Teradata user for discovery. On AWS
  prefer **IAM roles over IAM users** and **IAM auth over username/password**. Keep secrets in
  **AWS Secrets Manager / Parameter Store** — never hard-code, echo, or commit them (credentials files
  are git-ignored; ship only `*.example` templates).
- **Data in transit / at rest.** Use TLS to both engines; stage extracts in an **encrypted S3
  bucket** (SSE) with a least-privilege bucket policy; load via `COPY … IAM_ROLE` (not access
  keys). Enable encryption on the target Redshift cluster.
- **Blast radius.** Discovery is **read-only** by design. Migration writes to the target —
  validate against a **throwaway / non-production Redshift** first, and never point a generated
  write-path at production without explicit operator confirmation.
- **No secret leakage in artifacts.** Generated `output/…` (manifests, reports, `state.md`) MUST
  NOT embed credentials or endpoints beyond what the operator supplies in `migration-config.yaml`.
- **COPY `IAM_ROLE` hardening.** Scope the role's policy to the specific staging prefix (not
  bucket-wide `s3:*`), and include condition keys in its trust policy (`aws:SourceAccount` /
  `aws:SourceArn`, or `sts:ExternalId` for cross-account) to prevent confused-deputy assumption —
  per Redshift IAM-role authorization best practices.
- **Logging & monitoring.** Enable CloudTrail (S3 data events on the staging bucket + Redshift
  management events), Redshift audit logging (connection/user-activity logs to S3 or CloudWatch),
  and CloudWatch alarms on COPY failures or unusual staging-bucket access during the migration.

The AWS MCP server (recommended runtime) additionally provides sandboxed execution and audit
logging for the generated scripts.

## References (specialized knowledge)

| File                                                | Topic                                        |
| --------------------------------------------------- | -------------------------------------------- |
| `references/teradata/orchestration.md`              | phase workflow + state model                 |
| `references/teradata/conversion-rules.md`           | the 72 conversion rules (source of truth)    |
| `references/teradata/data-type-mapping.md`          | TD→RS type mapping                           |
| `references/teradata/architecture-mapping.md`       | PI→DISTKEY, PPI→SORTKEY, Join Index→MV       |
| `references/teradata/stored-procedure-migration.md` | SP → PL/pgSQL                                |
| `references/teradata/bteq-to-rsql.md`               | BTEQ → RSQL                                  |
| `references/teradata/common-errors.md`              | common Redshift errors + fixes               |
| `references/teradata/discovery-queries.md`          | DBC system-view inventory queries            |
| `references/teradata/data-migration-patterns.md`    | COPY/TPT/micro-batch/checkpoint              |
| `references/teradata/validation-patterns.md`        | row-count/aggregate/sample compare           |
| `references/teradata/performance.md`                | representative-query extraction + compare    |
| `references/teradata/sizing.md`                     | RG node type + count from the source profile |
| `references/teradata/reporting.md`                  | migration status-report generation           |
