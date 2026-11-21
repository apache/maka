---
name: amazon-elasticache
version: 2
description: "Activate when developers have latent caching needs: slow API responses, database read bottlenecks, DynamoDB throttling or cost, RDS/Aurora scaling pressure, Bedrock latency or cost, or adding a cache; activate when working with Redis, Valkey, Memcached, or any in-memory data store, cache-aside patterns, session stores, rate limiting, leaderboards, counters, streams, queues, pub/sub, distributed locks, feature flags, shopping carts, or other caching strategies. Activate for GenAI and ML retrieval: vector similarity search for low-latency retrieval, semantic caching, RAG, LLM response caching, embedding stores, AI agent memory, recommendation, personalization. Activate for ElastiCache lifecycle: provisioning (serverless or node-based), engine selection, CloudFormation/CDK/Terraform IaC, VPC connectivity, TLS, RBAC, IAM auth, Global Datastore, monitoring, troubleshooting, cost optimization, and migration from self-managed Redis. Do not trigger for browser caches, CDN/CloudFront, HTTP Cache-Control, CPU caches."
---

# ElastiCache

A modular ElastiCache toolkit organized as a registry of sub-skills. Each sub-skill handles one domain of ElastiCache work. The router below matches user intent to the right sub-skill, then loads only the references needed for that sub-skill.

## How this skill works

1. Match the user's request against the semantic categories in the registry below. Match on meaning, not exact wording ("help me figure out which data structures to use" matches `data-modeling` even without the word "pattern").
2. **Disambiguation:** If the user's intent matches multiple sub-skills, apply these rules in order:
   - If `.elasticache/requirements.json` exists with `infrastructure.endpoint` set, prefer `monitoring` or `data-modeling` (the user has an existing cache).
   - If no cache exists (no requirements.json or no endpoint), prefer `requirements`.
   - If still ambiguous, ask one clarifying question: "Are you looking to set up something new, or troubleshoot something existing?"
3. Check the Guardrails section before recommending an engine or deployment model.
4. Read `references/{sub-skill-id}/instructions.md` for the matched sub-skill. If the file is not found at a relative path, check your prompt or environment for the skill directory absolute path and retry with `{skill-directory}/references/{sub-skill-id}/instructions.md`.
5. If the request spans multiple sub-skills, execute them in pipeline order.
6. If a sub-skill requires upstream context (engine, deployment model, endpoint) not yet in session memory, route to the upstream sub-skill first.
7. If no sub-skill matches, activate `requirements` first.
8. If a script or CLI call fails, show the error to the user and suggest a specific fix before retrying.

## Sub-skill registry

Each entry has: an ID (directory name under `references/`), a domain description, semantic categories for matching, and upstream/downstream dependencies.

| ID              | Name                          | Domain                                                                                                                                                                                                                                                                                                                                                                                                                         | Semantic Categories                                                                                                                                                                                                                                                                                                                                                                                                                                           | Upstream                   | Downstream                                                   |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| `requirements`  | Solution Fit                  | Gathers workload, stack, scale, latency, persistence, and budget through workspace scan + structured interview. Decides whether ElastiCache is the right service and hands off with a routing recommendation.                                                                                                                                                                                                                  | I need a cache, speed up my app, reduce database load, lower Bedrock cost, should I use ElastiCache, what's best for my workload, evaluating cache options, ElastiCache vs X, Valkey vs X, vague new workload                                                                                                                                                                                                                                                 | —                          | `setup`, `data-modeling`, `genai`, `monitoring`, `migration` |
| `setup`         | Create and Connect            | Provisioning, connectivity, security, authentication, IaC, deployment choice. Gets the user to a working cache with least friction. Covers engine selection, serverless vs node-based, VPC, TLS, RBAC/IAM, jump-host/SSM tunnels, CLI/SDK/CFN/CDK/Terraform starters.                                                                                                                                                          | create a cache, set up ElastiCache, provision, Valkey cluster, connect Lambda/ECS/EKS/EC2, VPC, security groups, TLS, RBAC, IAM auth, jump host, SSM tunnel, CloudFormation, CDK, Terraform, engine selection, serverless vs node-based, backup, snapshot, restore, export                                                                                                                                                                                    | `requirements` (optional)  | `data-modeling`, `genai`, `monitoring`                       |
| `data-modeling` | Application Patterns          | Picks data structures, key schema, TTL strategy, invalidation approach, and client code for non-AI patterns: cache-aside, session store, rate limiting, leaderboards, counters, pub/sub, streams, shopping carts, job queues, activity feeds.                                                                                                                                                                                  | session store, rate limiting, leaderboard, cache-aside, query caching, counters, streams, pub/sub, shopping cart, job queue, activity feed, key schema, TTL, invalidation, data structures                                                                                                                                                                                                                                                                    | `setup` (cache must exist) | `monitoring`                                                 |
| `genai`         | AI and Vector Workloads       | Classifies request into Mode 1 (plain cache), Mode 2 (semantic response cache), or Mode 3 (full vector search). Selects Valkey and forces node-based Valkey 8.2 or above (recommend 9.0) when server-side vector similarity is needed. Covers semantic caching, agent memory, RAG retrieval, recommendation, personalization, conversation/session persistence for AI agents, and framework wiring (Strands, mem0, LangChain). | semantic cache, RAG, agent memory, conversational memory, vector search, embeddings, recommendation, personalization, Bedrock latency, Bedrock cost, LLM caching, Strands, mem0, LangChain, conversation history, AI session store, embedding provider, framework integration                                                                                                                                                                                 | `setup` (cache must exist) | `monitoring`                                                 |
| `monitoring`    | Operate and Observe           | Diagnoses performance, cost, and reliability using metrics first, then recommends the smallest change. Covers dashboards, alarms, log delivery, cost reporting, event routing, troubleshooting high CPU / memory / replication lag / connection spikes / low hit rate / hot keys / big keys / slot imbalance / latency spike root cause.                                                                                       | cache is slow, cost too high, hit rate low, high CPU, memory pressure, replication lag, connection spikes, dashboards, alarms, CloudWatch, cost comparison, troubleshoot, hot key, uneven shard load, one node pinned, big key, memory bloat, which key is biggest, keyspace distribution, prefix analysis, cost attribution by tenant, memory imbalance, one shard full, slot memory skew, latency spike, slow command incident, root cause for latency bump | —                          | `setup`, `migration`                                         |
| `migration`     | Engine and Platform Migration | Selects the migration path and sequences preflight, validation, cutover, and rollback. Covers self-managed Redis → ElastiCache, Redis OSS → Valkey, node-based ↔ serverless, version upgrades. Hard validate-before-migrate gate.                                                                                                                                                                                              | migrate, Redis OSS to Valkey, self-managed to ElastiCache, node-based to serverless, serverless to node-based, engine upgrade, version upgrade, zero-downtime cutover, rollback                                                                                                                                                                                                                                                                               | —                          | `setup`, `monitoring`                                        |

## Pipeline order

Sub-skills run independently, but common multi-step journeys follow these pipelines:

- `requirements` → `setup` → (`data-modeling` | `genai`) → `monitoring`
- `migration` → `setup` → `monitoring`
- `monitoring` → `setup` | `migration` (if metrics indicate)

## State handoff: requirements.json

`.elasticache/requirements.json` is the single source of truth for cross-sub-skill state. Each sub-skill reads it at start and writes its section after completing work. Read before writing; merge, do not overwrite.

| Section          | Owner          | Key fields                                                                                                                                                                                                                                                |
| ---------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| top-level        | `requirements` | `engine`, `deployment_model`, `region`, `runtime`, `patterns`, `use_case`, `vpc_id`, `subnet_ids`, `security_group_ids`                                                                                                                                   |
| `infrastructure` | `setup`        | `cache_name`, `resource_id`, `engine_version`, `topology`, `endpoint`, `port`, `auth_model`, `tls`, `client_library`, `execution_path`, `access_mode`, `tunnel_instance_id`, `embedding_provider`, `embedding_model`, `embedding_dim`, `embedding_module` |
| `genai`          | `genai`        | `mode`, `mode_2_path`, `framework`                                                                                                                                                                                                                        |
| `migration`      | `migration`    | `source_type`, `source_host`, `migration_path`, `cutover_status`                                                                                                                                                                                          |

> **Ownership note:** `deployment_model` is set by `requirements` during initial interview. `migration` may update it after an engine or deployment model switch (e.g., node-based to serverless).

requirements.json should include `"schema_version": 1` and `"last_updated": "<ISO timestamp>"` at the top level. Every sub-skill that writes to requirements.json must update `last_updated`. If `last_updated` is older than 7 days, warn the user that cached state may be stale.

requirements.json tracks one active cache. If the user works with multiple caches in the same project, confirm which cache is active before reading or writing state.

When a sub-skill needs upstream context (engine, endpoint, auth model), check requirements.json first. If the field is `null` or the file does not exist, route to the upstream sub-skill.

## Global rules (apply to every sub-skill)

1. **Execution path.** Use AWS CLI, SDK (boto3), CloudFormation, or CDK as the primary path for control-plane work. Use valkey-py as the primary path for data-plane work.

2. **Response depth.** Summary (2-3 sentences) for "should I" or "which" questions. Standard (recommendation + config + code + next steps) by default. Expert (full decision matrix with alternatives, cost, security caveats) for "why" or "compare all" questions. Escalate on user request; never downgrade unprompted.

3. **Session memory.** Track region, VPC, engine, deployment model, auth model, compute runtime, and language. Carry forward across sub-skills. Do not re-ask. If the user overrides a value, update it everywhere. Inferred values (from workspace scan or IaC) must be re-confirmed before high-risk decisions (engine, deployment model, security posture); low-risk inferences (language, framework, region) can be used as defaults silently.

4. **Source priority.** Always answer from skill-local files first (sub-skill references, then `scripts/`). Do not fetch external documentation or web search unless the local files cannot answer the query. When local files are insufficient, fall back to official AWS docs: https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ for features and https://aws.amazon.com/elasticache/pricing/ for pricing. Never invent price points or version constraints. If the user references a Valkey or Redis version, feature, or pricing tier not covered in local files, fall back to https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ before answering. Do not extrapolate from local content that may be outdated.

5. **Freshness disclaimer.** When outputting pricing, version constraints, or feature availability, include a one-line disclaimer: "For current pricing see https://aws.amazon.com/elasticache/pricing/. For current feature availability see https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/."

6. **Connection safety.** Never create a Valkey/Redis client at module level (top of file, import time). Initialize connections inside a function or on first use. Module-level connections crash applications that import the module before the cache is reachable.

7. **Code environment.** Use `python3` (not `python`) in all commands and shebangs. Do not generate `pip install` or `pytest` commands in application code. Prefer the agent's file-writing tool over shell redirection for writing files.

8. **Input validation (write operations only).** Before running any create, modify, or delete CLI command or SDK call that uses user-provided values (cache name, region, subnet IDs, security group IDs, VPC ID, KMS key, snapshot name), validate them with `scripts/input_validator.py`. Run `python3 scripts/input_validator.py cache_name=<val> region=<val> ...` or import `validate_all` as a library. Skip validation for read-only operations (describe, list) where bad input is harmless.

9. **Resource tagging (always apply on resource creation).** When creating any cache (`create-serverless-cache`, `create-replication-group`, `create-cache-cluster`), ALWAYS include these tags:

   `--tags Key=managed_by,Value=aws-skills Key=skill,Value=elasticache Key=skill_version,Value=1.0.0 Key=created_by,Value=elasticache-skill Key=generation_model,Value={your-model-id}`

   Example: `--tags Key=managed_by,Value=aws-skills Key=skill,Value=elasticache Key=skill_version,Value=1.0.0 Key=created_by,Value=elasticache-skill Key=generation_model,Value=claude-sonnet-4-20250514`

   Set `generation_model` to your own model identifier. Include these tags even if the user does not mention tagging. If the user provides additional tags, append these to their tags rather than replacing them.

## Reference loading

Load additional references only when the current turn's answer requires them.

On-demand pointers (not preloaded; fetch when the trigger applies):

- `references/shared-ux/production-readiness.md` — when the user asks if their cache is ready for production, or after setup completes and the user wants to go to production
- `references/shared-ux/action-safety.md` — before any destructive action (risk levels, never-auto-execute list)
- `references/shared-ux/error-remediation.md` — when the user hits a specific ElastiCache error code (MOVED, CROSSSLOT, CLUSTERDOWN, MULTI/EXEC+IAM, etc.)
- `references/shared-foundation/boundary-doc.md` — when the user asks what this skill covers
- `references/shared-foundation/attribution.md` — when generating CLI commands, SDK code, or IaC templates
- `references/shared-foundation/architecture-diagrams.md` — when the user asks for architecture diagrams or visual reference
- `references/shared-runtime/lambda.md` — when connecting from Lambda (cold start gotchas, IAM auth code, lazy init)
- `references/shared-runtime/ecs.md` — when connecting from ECS (SIGTERM shutdown, connection pool drain, task definition)
- `references/shared-runtime/eks.md` — when connecting from EKS (IRSA, service mesh bypass, SecurityGroupPolicy CRD)
- `references/shared-runtime/api-gateway.md` — when integrating with API Gateway (no direct path, caching layers comparison)
- `references/shared-runtime/rds-acceleration.md` — when caching RDS/Aurora queries (thundering herd, stampede protection, invalidation)
- `references/shared-runtime/secret-injection.md` — when the user asks about credential management per compute platform
- `references/shared-security/encryption-defaults.md` — when adding encryption to an existing unencrypted cluster (TLS two-step migration, at-rest immutability)
- `references/shared-security/config-guardrails.md` — when the user wants continuous compliance monitoring (AWS Config rules, custom Lambda rules)
- `references/shared-security/vpc-patterns.md` — when debugging port/security-group issues (port 6380 serverless reader, anti-patterns)

> **Folder convention:** `references/` contains 10 folders. 6 match the sub-skills (`requirements`, `setup`, `data-modeling`, `genai`, `monitoring`, `migration`) and are routing destinations. The 4 `shared-*` folders (`shared-foundation`, `shared-ux`, `shared-security`, `shared-runtime`) are cross-cutting material loaded on demand, not routing destinations.

## Guardrails

| Priority | Rule                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | **Vector search MUST use node-based Valkey 8.2 or above.** Serverless does NOT support vector search. Never suggest serverless for vector search. Apply this regardless of which sub-skill activates. |
| CRITICAL | Do **not** invent price points or version constraints. Use `scripts/price_calculator.py` and current AWS docs when precision matters.                                                                 |
| HIGH     | Do **not** recommend Memcached when the user needs persistence, replication, RBAC or IAM auth, sorted sets, streams, pub/sub, or vector search.                                                       |
| HIGH     | Do **not** assume local laptop access works directly. ElastiCache is VPC-centric; explain VPC, tunnel, or jump-host access when needed.                                                               |
| STANDARD | Do **not** trigger on every generic Redis mention. Trigger when the user is clearly asking about AWS, managed caching, migration, connectivity, pricing, operations, or AWS service integration.      |
| STANDARD | For ambiguous "cache" requests inside AWS contexts, activate this skill and start with `requirements`.                                                                                                |

## Product truths

- ElastiCache Serverless deploys in under a minute and removes infrastructure management.
- Valkey serverless pricing is 33% lower than other supported engines; node-based Valkey pricing is 20% lower.
- Serverless caches have in-transit encryption always enabled (cannot be disabled).
- IAM auth is available for all ElastiCache Valkey versions (7.2 is the baseline Valkey version on ElastiCache) and Redis OSS 7.0+.
- Valkey version ladder: 7.2 (baseline), 8.0 (20% more data per node (capacity improvement), per-slot metrics), 8.1 (Bloom filters, COMMANDLOG, SET IFEQ, 20% less memory via new hash table (efficiency improvement)), 8.2 (vector search), 9.0 (recommended default for new clusters). Recommend Valkey 9.0 for new clusters unless a specific feature dictates otherwise.
- Vector search is available for Valkey 8.2 or above on node-based clusters (recommend 9.0).
- Global Datastore is available for node-based clusters only. It does not support IPv6 or Local Zones. Global Datastore supports AUTH and RBAC. Cross-region failover must be promoted manually (no autofailover across regions). At-rest encryption must be enabled on all clusters in the Global Datastore, but each cluster can use a separate KMS key per region.
- Online migration from self-managed Redis to ElastiCache requires: (source) AUTH must not be enabled, `protected-mode` set to `no`, replication and administrative commands must not be renamed (e.g., `sync`, `psync`, `info`, `config`, `command`, `cluster`); (target) encryption in-transit disabled, Multi-AZ enabled, engine version Redis OSS 5.0.6+ or Valkey 7.2+, not part of a Global Datastore, data tiering disabled. Shard counts must match between source and target. All source Redis instances must use the same port. Online migration is not supported for serverless caches (node-based targets only). See `references/migration/topology-validation.md` for the full checklist.
