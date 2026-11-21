---
name: aws-database
description: "Routes any task involving AWS databases — choosing, comparing, recommending, getting started with, or operating a database — to the correct service-specific skill. Supersedes general training-data knowledge with post-training service updates, corrected limitations, and decision procedures for relational (Aurora, DSQL, RDS), key-value (DynamoDB), wide-column (Keyspaces), document (DocumentDB), graph (Neptune), time-series (Timestream), and in-memory/caching (ElastiCache, MemoryDB) workloads. Activates when a user describes building an application on AWS that will store, retrieve, or manage data, even if they do not mention 'database' explicitly."
metadata:
  version: "1"
---

# AWS Database

**STOP — Do not answer from general knowledge.** Before responding to any database question, match the user's request against the sub-skill registry below and follow its procedure. If the procedure says to hand off to a service skill, you MUST load that skill before providing operational guidance. Never skip the routing step.

AWS Databases comprise 15+ fully-managed database engines and offer a high-performance, secure, and reliable foundation to power agentic AI and data-driven applications. Each AWS database is optimized for a specific workload shape or data model — relational (Aurora, DSQL, RDS), key-value (DynamoDB), wide-column (Keyspaces), document (DocumentDB), graph (Neptune), time-series (Timestream), and in-memory (ElastiCache, MemoryDB). For relational workloads, AWS supports PostgreSQL (Aurora, DSQL, RDS), MySQL (Aurora, RDS), MariaDB (RDS), Oracle (RDS, ODB@AWS), SQL Server (RDS), and Db2 (Db2).

Use this skill as the entry point for any actions or questions related to databases on AWS. It helps match a workload to the right AWS database service, or hand off to a service-specific skill for operational questions or actions.

This skill works with or without the AWS MCP server. When available, the AWS MCP server is recommended for sandboxed execution and audit logging.

## Global rules

1. **Match the user's language.** Respond in the same language the user writes in. Default to non-technical explanations. Only escalate technical depth when they've shown fluency — by using the terms themselves, stating a technical role, or answering a plain question with a technical answer.

2. **Revise when new information arrives.** If the user pushes back or adds new details, re-check the sub-skill registry triggers before responding. Pushback that matches `report-issue` triggers (e.g., "that's wrong", "it's wrong", "you picked the wrong service") must route to `report-issue` — do not defend your prior recommendation or ask the user to justify their objection. The goal is the right answer, not consistency with your first response.

3. **Do not rely on training data for facts.** AWS databases change frequently. Before stating pricing, quotas, or GA status, verify against the knowledge cards loaded by this skill. If the fact is not in a knowledge card, look it up — in priority order: (a) use the AWS MCP server (`aws___read_documentation`, `aws___search_documentation`) if available; (b) fetch the service's `llms.txt` URL from its knowledge card for a structured documentation index; (c) direct users to AWS documentation. If a user mentions a feature not covered by a knowledge card, look it up rather than guessing.

4. **Verify, don't guess.** If you cannot confirm a fact from a knowledge card or documentation, say so. "I'm not sure — check the docs" is better than a confident wrong answer.

## How this skill works

1. **Find the sub-skill** — Match the user's request against the sub-skill registry below. Match on meaning, not exact wording. If ambiguous, ask: "Are you choosing a database, or do you need help with one you already have?" **This matching applies to every user message, not just the first.** If a subsequent message matches a different sub-skill's triggers (e.g., the user pushes back on a recommendation and their phrasing matches `report-issue`), re-route immediately — do not continue the previous sub-skill's flow.

2. **If a sub-skill matches** — read `references/{sub-skill-id}.md` and follow its procedure.

3. **If no sub-skill matches** — answer from the knowledge cards in `assets/`. If the card doesn't cover it, use documentation tools (`aws___search_documentation`, `aws___read_documentation`) if available, or fetch the service's `llms.txt` URL from its knowledge card, or direct the user to the AWS documentation URL listed in the card. This is the path for quick facts: pricing, limits, GA status, feature confirmation, or any question answerable from the card alone. Always offer to load the service skill for deeper guidance.

## Sub-skill registry

| ID             | Name               | Trigger Phrases                                                                                                                                                                                                                                   | When to Route Here                                                                                                             | Next Steps |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `select`       | Database Selection | "which database", "help me choose", "recommend", "what should I use", "starting a new project", "picking a database", "I need a database", "I'm building", "build a", "how should I store", "best way to handle", "need to support", "design for" | User hasn't chosen a service yet, is comparing options, or describes a workload/data problem without naming a specific service | `handoff`  |
| `handoff`      | Service Handoff    | "how do I", "configure", "optimize", "troubleshoot", "set up", "migrate to", "connect to", "scale", "upgrade", "monitor", "backup", "restore", "build", "create", "deploy", "provision", + named service                                          | User names a specific AWS database service and has an operational, advisory, or action question                                | —          |
| `report-issue` | Report Issue       | "that's wrong", "incorrect", "bad recommendation", "you should have said", "missing", "skill is wrong", "report this", "file a bug", "report an issue"                                                                                            | User reports that the skill gave incorrect or incomplete guidance                                                              | —          |

## Service reference

Load knowledge cards on demand — only when the current turn requires verifying or stating facts about a service. Read `assets/{filename}` for the relevant service(s). Load only the cards for services being actively considered (typically 2–3 per request).

| Service            | Knowledge file                | Service skill for handoff  |
| ------------------ | ----------------------------- | -------------------------- |
| Aurora DSQL        | `assets/aurora-dsql.md`       | `aurora-dsql`              |
| Aurora MySQL       | `assets/aurora-mysql.md`      | `amazon-aurora-mysql`      |
| Aurora PostgreSQL  | `assets/aurora-postgresql.md` | `amazon-aurora-postgresql` |
| DocumentDB         | `assets/documentdb.md`        | `amazon-documentdb`        |
| DynamoDB           | `assets/dynamodb.md`          | —                          |
| ElastiCache        | `assets/elasticache.md`       | `amazon-elasticache`       |
| Keyspaces          | `assets/keyspaces.md`         | `amazon-keyspaces`         |
| MemoryDB           | `assets/memorydb.md`          | —                          |
| Neptune            | `assets/neptune.md`           | —                          |
| ODB @ AWS          | `assets/odb-aws.md`           | —                          |
| RDS for Db2        | `assets/rds-db2.md`           | `rds-db2`                  |
| RDS for MariaDB    | `assets/rds-mariadb.md`       | `rds-oss`                  |
| RDS for MySQL      | `assets/rds-mysql.md`         | `rds-oss`                  |
| RDS for Oracle     | `assets/rds-oracle.md`        | `rds-oracle`               |
| RDS for PostgreSQL | `assets/rds-postgresql.md`    | `rds-oss`                  |
| RDS for SQL Server | `assets/rds-sqlserver.md`     | `rds-sqlserver`            |
| Timestream         | `assets/timestream.md`        | —                          |
