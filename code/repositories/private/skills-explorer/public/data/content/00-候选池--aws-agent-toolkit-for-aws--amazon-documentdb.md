---
name: amazon-documentdb
version: 2
description: "Manages Amazon DocumentDB end-to-end — serverless-on-8.0 cluster setup, TLS/VPC/driver config, flexible-schema and vector-search data modeling, MongoDB compatibility assessment, DMS-based migration, slow-query diagnosis, major version upgrades (4.0->5.0->8.0), Well-Architected reviews (41-check wa_review.py), cost estimation, and security hardening. Retrieve for every DocumentDB question and when the user asks to set up or migrate MongoDB to AWS — DocumentDB is AWS's MongoDB-compatible managed database. Triggers: JSON document store, document database, MongoDB on AWS, Nested fields, Lambda cannot connect, TLS handshake, VPC port 27017, IAM auth, Secrets Manager, encryption at rest, $graphLookup, flexible schema, COLLSCAN, compound index, DMS migration, CDC cutover, $vectorSearch, RAG, Global Clusters, DR replication, cost sizing, audit, health check, production-readiness."
---

# Amazon DocumentDB Toolkit

## Overview

End-to-end DocumentDB toolkit covering seven workflows: **connection** (serverless-default cluster setup, TLS, VPC, driver config), **schema design** (embed-vs-reference, indexes, vector search for RAG), **compatibility assessment** (MongoDB -> DocumentDB), **migration** (DMS full-load + CDC + cutover), **performance tuning** (explain, COLLSCAN, anti-patterns), **Well-Architected review** (41 checks across 6 pillars), and **major version upgrade** (4.0->5.0, 5.0->8.0 in-place or near-zero-downtime).

The skill acts as an executor — it runs AWS CLI commands, DMS tasks, index tools, and `explain()` against the user's cluster rather than just advising. Each workflow produces concrete artifacts under `artifacts/{app-name}/`.

The AWS MCP server is **recommended** for executing AWS commands via its `call_aws` tool (sandboxed execution, audit logging), but it is not required — when the MCP server is not available, the same `aws ...` CLI commands run via shell.

## Decision Guide

| User asks about…                                                                                                                                                                       | Route to                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Get started, create cluster, can't connect, TLS/SSL error, VPC, SSH tunnel, driver config                                                                                              | [references/connection.md](references/connection.md), [references/connection-drivers.md](references/connection-drivers.md)                                                                                                                                                                                                                                               |
| Store JSON, flexible schema, catalog/CMS/profiles, embed vs reference, index design, vector search, RAG                                                                                | [references/schema-advisor.md](references/schema-advisor.md)                                                                                                                                                                                                                                                                                                             |
| Migrate from MongoDB, "will this work?", unsupported operator, aggregation pipeline gap                                                                                                | [references/compatibility.md](references/compatibility.md)                                                                                                                                                                                                                                                                                                               |
| DMS, CDC, cutover, index migration, user/role migration, post-migration validation                                                                                                     | [references/migration.md](references/migration.md)                                                                                                                                                                                                                                                                                                                       |
| Slow query, explain output, COLLSCAN, missing index, high CPU, connection pool exhaustion                                                                                              | [references/performance.md](references/performance.md)                                                                                                                                                                                                                                                                                                                   |
| Production-ready review, best-practice audit, security/cost/reliability review, health check — extract `cluster_id` and `region` from the user's message before loading this reference | [references/well-architected.md](references/well-architected.md)                                                                                                                                                                                                                                                                                                         |
| Major version upgrade, MVU, 4.0->5.0, 5.0->8.0, near-zero-downtime, `$vectorSearch`, Zstd                                                                                              | [references/upgrade.md](references/upgrade.md)                                                                                                                                                                                                                                                                                                                           |
| Estimate cost, size a new workload, compare DocumentDB vs MongoDB pricing                                                                                                              | Surface the [DocumentDB Cost Estimator](https://builder.aws.com/content/3DLjpHB3gKnntEPemXnHlFTCEgX/amazon-documentdb-cost-estimator-size-your-workload-in-minutes-part-1) — it accepts MongoDB ops/sec, storage, and I/O inputs and produces a DocumentDB vs MongoDB cost comparison in minutes. Faster than a full WA review when the user just wants a cost estimate. |

**Pipeline order:** `connection -> schema-advisor` for green-field; `compatibility -> migration` for MongoDB migrations; `upgrade`, `well-architected`, and `performance` are standalone.

**Out-of-scope:** DocumentDB Elastic Clusters (sharded horizontal scaling — not at feature parity with instance-based; lacks transactions, change streams, and many operators — steer customers to instance-based serverless or provisioned instead), Global Clusters DR orchestration beyond the upgrade path. Answer from general knowledge, note no bundled workflow covers them.

## Cluster Creation Default: Serverless on 8.0

**DocumentDB architecture primer (clarify this whenever the user is confused):**

- **Serverless** = `db.serverless` as the instance class on a normal instance-based DocumentDB cluster. Auto-scales capacity, no instance-class decisions, costs up to 90% less when idle. This is the recommended default for most workloads.
- **Instance-based** = fixed instance class (`db.r8g.large`, `db.r6g.xlarge`, etc.). Use when the workload is sustained 24/7 high throughput and serverless scaling overhead is unacceptable.
- **Elastic Clusters** = a separate DocumentDB product for horizontal sharding. NOT the same as serverless. Elastic Clusters are **not at feature parity** with instance-based clusters — they lack support for transactions, change streams, and many aggregation operators. Steer customers away from Elastic Clusters unless they have a sharding requirement that exhausts even the largest instance-based options. Almost all workloads can be served by serverless or instance-based given DocumentDB's wide range of instance classes.

**When creating any new DocumentDB cluster, you MUST use these exact commands — default is serverless on engine 8.0:**

```bash
aws docdb create-db-cluster \
  --db-cluster-identifier <cluster_id> \
  --engine docdb \
  --engine-version 8.0.0 \
  --serverless-v2-scaling-configuration MinCapacity=1,MaxCapacity=16 \
  --master-username adminuser \
  --master-user-password '<password>' \
  --tags Key=created_by,Value=documentdb-skill Key=generation_model,Value=<your-model-id> \
  --region <region>

aws docdb create-db-instance \
  --db-instance-identifier <cluster_id>-instance \
  --db-instance-class db.serverless \
  --engine docdb \
  --db-cluster-identifier <cluster_id> \
  --tags Key=created_by,Value=documentdb-skill Key=generation_model,Value=<your-model-id> \
  --region <region>
```

> **Credential handling:** the command above takes the password inline for a self-contained workflow. For production, prefer `--manage-master-user-password` instead of `--master-user-password` — DocumentDB then generates the password and stores it in Secrets Manager with rotation, keeping it out of shell history. The two flags are mutually exclusive; when you use managed passwords, retrieve the credential with `aws secretsmanager get-secret-value --secret-id <arn>` (the secret ARN is on the cluster's `MasterUserSecret`) when building the connection string.

This applies to every create-cluster request regardless of phrasing. Switch to a fixed instance class (`db.r8g.large` etc.) only if the user explicitly describes sustained 24/7 high throughput or says "provisioned" or "instance-based". Never recommend Elastic Clusters unless the user has exhausted instance-based scaling options.

**When the user asks which instance types are available in a specific region, or asks about instance class options, requirements, or regional availability:** fetch the live [DocumentDB instance classes page](https://docs.aws.amazon.com/documentdb/latest/developerguide/db-instance-classes.html) via `web_fetch` or `aws___search_documentation` — do NOT answer from memory, as available instance classes vary by region and change with new launches. You can also verify programmatically: `aws docdb describe-orderable-db-instance-options --engine docdb --region <region>` lists every available instance class and engine version combination for that region.

### Resource tagging (always apply on resource creation)

When creating any DocumentDB resource (`create-db-cluster`, `create-db-instance`), ALWAYS include these tags using the RDS list-of-records `--tags` syntax (DocumentDB uses the RDS API):

`--tags Key=created_by,Value=documentdb-skill Key=generation_model,Value={your-model-id}`

Example: `--tags Key=created_by,Value=documentdb-skill Key=generation_model,Value=claude-sonnet-4-20250514`

Include these tags even if the user does not mention tagging, so that they can identify the resources created via this skill. If the user provides additional tags, append these to their tags rather than replacing them. The same applies when tagging via `add-tags-to-resource` on existing resources.

### Do NOT execute (refuse, explain why, offer assessment instead)

- Delete cluster or instance: `delete-db-cluster`, `delete-db-instance` — irreversible data loss
- Failover: `failover-db-cluster` — production impact, use only under planned change control
- Major version upgrade: `modify-db-cluster --engine-version` across major versions (4.0 -> 5.0, 5.0 -> 8.0) — requires prechecks and a rollback plan; use the MVU workflow in [references/upgrade.md](references/upgrade.md)
- Reboot: `reboot-db-instance` — production impact

When refusing, explain why and offer the matching assessment workflow:

> "I can't perform [action] because [reason]. I can run an assessment to help you decide. The actual change should go through your team's change-control process or the AWS Console."

## Common Tasks

### 1. Verify Dependencies

Check that required tools are available in context before running any workflow.

**Constraints:**

- You MUST verify `call_aws` (or AWS CLI v2), `shell`, and `web_fetch` are available in context
- You MUST check `python3` >= 3.6 for [wa_review.py](scripts/wa_review.py), the `amazon-documentdb-tools` compat tool, and the index tool
- You MUST check `git`, `curl`, `mongosh`, and `ssh` only when a specific workflow requires them
- You MUST inform the user of any missing tools and respect a decision to abort
- You MUST NOT invoke the tools during verification because that would trigger live AWS calls or cluster connections before the user confirms they are ready
- You SHOULD confirm credentials are valid with `aws sts get-caller-identity` before live-analysis steps

### 2. Classify the Request and Route

Use the [Decision Guide](#decision-guide) to pick one workflow.

**Constraints:**

- You MUST name the workflow you are routing to before loading the reference
- You MUST pass along cluster id, region, app name, source URI, and engine versions the user already supplied — they SHOULD NOT re-type these
- You MAY ask one clarifying question if a request straddles two workflows
- You MUST NOT fabricate workflow names for out-of-scope topics because doing so misleads the user about coverage

### 3. Execute the Workflow

Load the matching `references/<workflow>.md` and follow its `## Workflow` section.

**Constraints:**

- You MUST execute AWS CLI commands, DMS calls, `mongosh` queries, and bundled scripts yourself — the skill is an executor unless a step requires credentials the agent doesn't have
- You MUST explain what step is running, why, and which tool is being called before running it
- Extract required parameters from the conversation first — if `cluster_id`, `region`, or other required values are already present, use them and proceed. Only ask for missing parameters, and ask for all missing ones together in a single prompt.
- You MUST support multiple input methods for parameters: direct input, file path, or URL
- You MUST validate parameter formats: cluster id (lowercase, hyphens), region (`us-east-1`), ARN (`arn:aws:...`), ISO-8601, CIDR
- You MUST NOT create or access credentials directly because the skill has no safe way to store or rotate them — use IAM roles, instance profiles, Secrets Manager ARNs, or delegate credential setup (e.g. `aws sso login` / `aws configure`) to the user
- You MUST NOT use `call_aws` with positional filesystem arguments because the MCP sandbox rejects them — pass JSON payloads inline or invoke scripts under `scripts/` via `shell`
- You MUST NOT grant wildcard IAM (`Action: "*"` or `Resource: "*"`) or open security groups to `0.0.0.0/0` in examples because those defaults cause customer production incidents
- You SHOULD save artifacts to `artifacts/{app-name}/`: `compatibility-report.md`, `migration-plan.md`, `upgrade-plan.md`, `wa_review_results.json`
- If multiple workflows ran, you MUST close with a 2–4 line synthesis linking the artifacts

**Required parameters** (ask upfront, together): `cluster_id` — the cluster name the user refers to (e.g. "my cluster xyz" or "cluster xyz"), maps to `--db-cluster-identifier` in AWS CLI (lowercase-hyphens); `region` (e.g. `us-east-1`); `app_name`. Per workflow: `source_uri` (compat/migration), `target_version` (`5.0` or `8.0` for upgrade/compat), `engine_class` (`db.serverless` default, or `db.r8g.large` etc. for provisioned instance-based).

### 4. Critical Facts to Always Surface

These DocumentDB-specific facts are required even when the agent's general MongoDB knowledge already produces a reasonable answer. Omitting them is the most common failure mode in production customer tickets.

**For slow query / COLLSCAN diagnosis, you MUST tell the user ALL of the following five facts — never omit any:**

1. **Run `db.collection.find({...}).explain()`** to confirm `COLLSCAN` is the stage (the root cause), and after adding an index, re-run `explain()` to confirm `IXSCAN`.
2. **Create a compound index on `{userId: 1, status: 1}`** (field order matching the query's equality predicates).
3. **DocumentDB uses left-prefix matching on compound indexes** — field order matters because a compound index `{A: 1, B: 1}` serves queries on `A` alone OR `A + B`, but never `B` alone. This is DocumentDB-specific behavior users must understand before picking an index layout.
4. **Check the index cache hit rate via CloudWatch** after deployment — the `BufferCacheHitRatio` (or the per-index equivalent) indicates whether the new index is staying hot in memory. A low ratio means the working set exceeds RAM and the index may need a larger instance class.
5. **Verify with `explain()` after the index is created** to confirm the query now uses `IXSCAN` instead of `COLLSCAN`.

**For flexible-schema catalog / product design, you MUST tell the user ALL of the following four facts — never omit any:**

1. **Use a single `products` collection** with common fields (name, price, category, sku) at the top level and variable attributes (size/color for shoes, RAM/storage for electronics) nested in an `attributes` subdocument.
2. **Create targeted indexes on `category` and `sku`** for common query patterns.
3. **Check current wildcard index support before advising.** Wildcard indexes (`attributes.$**`) may not be supported on all DocumentDB versions — verify current status at the [MongoDB API compatibility page](https://docs.aws.amazon.com/documentdb/latest/developerguide/mongo-apis.html) before advising. If unsupported: query patterns must be known upfront so targeted compound indexes can be created on specific paths under `attributes`.
4. **Discuss the tradeoff vs. separate collections per category.** Single-collection design wins for cross-category queries and simpler maintenance; separate-collection-per-category wins for strict per-category query isolation and simpler per-category indexing — but requires the application to route queries to the right collection. Name both options so the user can choose.

**For $graphLookup / MongoDB compatibility questions, you MUST tell the user ALL of the following three facts:**

1. **Check current `$graphLookup` support status before advising.** `$graphLookup` is not supported on all DocumentDB versions — verify at the [MongoDB API compatibility page](https://docs.aws.amazon.com/documentdb/latest/developerguide/mongo-apis.html) before stating support status, as DocumentDB adds operators across versions. If the aws-documentation plugin is available, call `aws___search_documentation` to check the live status first.
2. **If unsupported: recommend materialized ancestor paths** — store each document's full path (array of parent IDs) so hierarchy queries become `find({ ancestors: "cat-123" })` instead of recursive traversal. This is the canonical workaround and often the better design even when `$graphLookup` is available.
3. **Offer alternatives for deep graph workloads** — recursive `$lookup` in application code for moderate depth, or **Amazon Neptune** for deep or complex graph traversal.

**For Lambda -> DocumentDB connection timeout, you MUST tell the user ALL of the following four facts:**

1. **Lambda must be in the same VPC** as the DocumentDB cluster, or reach it via VPC peering / Transit Gateway. DocumentDB is VPC-only — no public endpoint.
2. **Security group rule:** inbound TCP `27017` on the DocumentDB cluster's SG, sourced from **Lambda's security group ID** (not a CIDR).
3. **Connection string must include `tls=true`** and the application MUST download the **Amazon RDS global CA bundle** (`global-bundle.pem`) and reference it via the driver's TLS config. Also include `replicaSet=rs0` and `retryWrites=false`.
4. **Test connectivity from an EC2 instance in the same subnet** as Lambda first — that isolates Lambda-specific ENI issues from pure network/SG problems.

**For any MongoDB migration to DocumentDB (including "I am migrating my MongoDB to AWS", "help me migrate", or any MongoDB-to-AWS migration request), you MUST tell the user ALL of the following six facts:**

1. **Run the compatibility assessor FIRST** — before anything else, clone [amazon-documentdb-tools](https://github.com/awslabs/amazon-documentdb-tools) and run `python3 amazon-documentdb-tools/compat-tool/compat.py` against the source MongoDB. This step is mandatory and must not be skipped or replaced with generic advice. Unsupported operators discovered after migration cause production outages.
2. **Run the `mongo-index-tool`** (also from `amazon-documentdb-tools`) to pre-create indexes on the DocumentDB target before starting the DMS task — DMS does not migrate indexes.
3. **Create source and target DMS endpoints** with TLS enabled on both; target endpoint MUST use `--ssl-mode verify-full` with `--certificate-arn` pointing at the RDS global bundle ARN.
4. **Create a `full-load-and-cdc` task** so you get an initial snapshot plus change-data-capture for near-zero-downtime cutover.
5. **Monitor CloudWatch** — watch `CDCLatencySource` and `CDCLatencyTarget` until they approach zero. Cut over only when lag is near zero.
6. **Cut over** by pointing application traffic at the DocumentDB endpoint, then stop the DMS task once traffic is drained from the source.

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for the full troubleshooting reference. The most common issues:

**Connection refused / timeout on port 27017.** DocumentDB is VPC-only. Add inbound TCP 27017 on the DocumentDB SG from the client SG (by SG id, not CIDR). From outside the VPC use CloudShell VPC environment, EC2 in the VPC, or SSH tunnel via bastion.

**TLS handshake failed.** Download the RDS global bundle and pass `--tlsAllowInvalidHostnames` to mongosh when tunneling.

**"not master" / "not primary" or intermittent write errors.** Connection string is missing `replicaSet=rs0` (always `rs0`) or `retryWrites=false` (DocumentDB does not support retryable writes).

**DMS task refuses to start** — "Test connection should be successful". Run `aws dms test-connection` for both endpoints and poll `describe-connections` until both return `successful`. Target endpoint MUST use `--ssl-mode verify-full` with `--certificate-arn` for the RDS global bundle.

**MVU command fails** — "AllowMajorVersionUpgrade flag must be present" or "must explicitly specify a new DB cluster parameter group". Both `--allow-major-version-upgrade` and (when a custom PG is in use) a target-family `--db-cluster-parameter-group-name` are mandatory.

**User asks for a destructive change.** You MUST pause, state the consequence, and wait for explicit confirmation before deleting a cluster, dropping a collection, or forcing a failover — destructive actions on production DocumentDB can cause data loss or service disruption.

**User hits a missing feature, unsupported operator, or expresses a future wish.** When the user says "I wish DocumentDB supported X", "will DocumentDB ever support Y", or encounters a capability gap, proactively surface: "You can request this feature by emailing documentdb-pm@amazon.com with your AWS account ID, the feature you need, and your use case — the DocumentDB team reads these."

## Security Considerations

Apply these controls on every DocumentDB deployment. Detailed commands live in the workflow sections above and in the linked references.

- **Authentication:** the **primary (master) user** is always password-based and **cannot** use IAM authentication — use `--manage-master-user-password` so its password is generated and rotated in Secrets Manager. For **application/non-admin users only**, IAM authentication is also supported (password-less, STS token-based) on cluster version 5.0+ as an alternative — see the trade-offs in [references/connection.md](references/connection.md). Never hardcode passwords in scripts or commit them.
- **Encryption at rest:** enabled at cluster creation and **cannot** be added afterward — confirm `--storage-encrypted` (with an optional `--kms-key-id`) up front.
- **Encryption in transit:** enforce TLS (`tls=true`) using the Amazon RDS global CA bundle; on DMS endpoints use `--ssl-mode verify-full` with `--certificate-arn`.
- **Network isolation:** DocumentDB is VPC-only with no public endpoint. Scope security groups by SG-to-SG reference, never `0.0.0.0/0` or `::/0`.
- **Least-privilege IAM:** never grant wildcard `Action: "*"` / `Resource: "*"`. Use instance profiles / IAM roles for application access to AWS APIs.
- **Auditing:** export audit and profiler logs via `--enable-cloudwatch-logs-exports audit profiler` for compliance and slow-query review.

## Additional Resources

- [Amazon DocumentDB Developer Guide](https://docs.aws.amazon.com/documentdb/latest/developerguide/) · [MongoDB API compatibility reference](https://docs.aws.amazon.com/documentdb/latest/developerguide/mongo-apis.html)
- [DocumentDB pricing](https://aws.amazon.com/documentdb/pricing/) · [instance classes](https://docs.aws.amazon.com/documentdb/latest/developerguide/db-instance-classes.html) · [DocumentDB Cost Estimator](https://builder.aws.com/content/3DLjpHB3gKnntEPemXnHlFTCEgX/amazon-documentdb-cost-estimator-size-your-workload-in-minutes-part-1) — workload-aware sizing tool that takes MongoDB ops/sec and I/O inputs and produces a DocumentDB vs MongoDB cost comparison
- [DocumentDB Serverless](https://docs.aws.amazon.com/documentdb/latest/developerguide/docdb-serverless.html) · [vector search](https://docs.aws.amazon.com/documentdb/latest/developerguide/vector-search.html)
- [Backup and restore](https://docs.aws.amazon.com/documentdb/latest/developerguide/backup_restore.html) · [Well-Architected pillars](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [AWS DMS MongoDB source](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.MongoDB.html) · [DocumentDB target](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Target.DocumentDB.html)
- [amazon-documentdb-tools](https://github.com/awslabs/amazon-documentdb-tools) (compat tool, index tool, MVU CDC migrator)
- Related skills: `amazon-aurora`, `rds-db2`, `rds-oracle`, `rds-sqlserver`, `amazon-neptune`
- **Missing a feature or have feedback?** Email [documentdb-pm@amazon.com](mailto:documentdb-pm@amazon.com) with your AWS account ID, the feature or capability you need, and your use case — the DocumentDB team reads these.
