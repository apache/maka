---
name: amazon-opensearch-service
description: Guides migration, provisioning, search, log-analytics, trace-analytics, and Agentic AI Assistant workflows for Amazon OpenSearch Service and Serverless across six capabilities — migration (Solr/ES/self-managed into AOS/AOSS, schema/query translation, sizing, cutover); provisioning (domain + AOSS lifecycle, upgrades, FGAC, monitoring); search (vector / semantic / hybrid / RAG with Bedrock); log-analytics (PPL, OSI, anomaly detection, Dashboards); trace-analytics (OTel spans, service maps, Data Prepper); ai-assistant (natural language data exploration, incident investigation, root cause analysis). Triggers on OpenSearch, AOS, AOSS, Elasticsearch, Solr, vector/k-NN/semantic/hybrid search, RAG, log analytics, PPL, trace analytics, ISM, FAISS, HNSW, Migration Assistant, UltraWarm, OR1, query my data, analyze logs, investigate errors, root cause analysis.
metadata:
  version: "2"
---

# Amazon OpenSearch Service — the unified skill

This skill answers anything about Amazon OpenSearch Service or Serverless across six capabilities. **Step 0 below routes the question to ONE capability** and points at that capability's entry-point reference. Everything else — when to dispatch, sub-references, capability-specific facts, cross-capability links — lives in the entry-point reference for that capability.

> **AWS MCP server is recommended, not required.** Capability references show standard AWS CLI commands as the primary syntax (e.g., `aws opensearch describe-domain`, `aws opensearchserverless create-collection`). Where the AWS MCP server is available, its `call_aws` tool offers a streamlined alternative — but every operation in this skill MUST work via the AWS CLI alone. Data-plane HTTP calls against AOS / AOSS use `awscurl` for SigV4-signed requests; this works in both contexts.

## Step 0: detect the capability — first thing you do

Pick **one** of the six capabilities below. State the detected capability in your first sentence (e.g., _"Detected capability: SEARCH — semantic search setup with Bedrock embeddings."_). Then load the entry-point reference; that file describes when to dispatch, indexes the rest of the capability's files, and routes you to the next step.

| Capability                                                                                                                                                                                        | Entry-point reference                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **migration** — Solr / Elasticsearch / self-managed OpenSearch into AOS or AOSS. Schema/query translation, sizing, cutover.                                                                       | [`references/assessment-workflow.md`](references/assessment-workflow.md)                     |
| **provisioning** — Provisioning and managing AOS domains and AOSS collections. Lifecycle, upgrades, storage tiers, FGAC, monitoring.                                                              | [`references/provisioning-reference.md`](references/provisioning-reference.md)               |
| **search** — Vector / semantic / hybrid / sparse / dense / RAG retrieval. Bedrock connectors, FAISS HNSW vs Lucene.                                                                               | [`references/search-semantic-search-guide.md`](references/search-semantic-search-guide.md)   |
| **log-analytics** — Log search, observability, PPL, OSI ingestion, anomaly detection, OpenSearch Dashboards. Splunk/Datadog/ELK alternatives.                                                     | [`references/log-analytics-guide.md`](references/log-analytics-guide.md)                     |
| **trace-analytics** — Distributed traces with OpenTelemetry. Span queries, service maps, Data Prepper.                                                                                            | [`references/trace-analytics-trace-queries.md`](references/trace-analytics-trace-queries.md) |
| **ai-assistant** — Agentic AI Assistant: auto-discovers indices, generates optimized PPL/DSL queries, summarizes results, and investigates incidents end-to-end. No manual query crafting needed. | [`references/ai-assistant.md`](references/ai-assistant.md)                                   |

If a prompt spans capabilities (e.g., _"migrate from Solr AND set up RAG on the new domain"_), pick the dominant capability for the response and close with a one-line handoff to the other capability's entry-point ref.

## Universal rules (apply to ALL capabilities)

These rules apply to every response, regardless of capability. Capability-specific rules (sizing math, shape detection, Migration Assistant for Amazon OpenSearch Service capability matrix, k-NN engine selection) live in the entry-point references, not here.

- **Report header (every multi-section response).** Begin every multi-section response with a single fenced metadata block: `> Generated: <ISO 8601 timestamp> | Skill: amazon-opensearch-service v<N>`. Get the time by calling the `current_time` tool (returns ISO 8601 in UTC). Read the skill version from this file's frontmatter `version:` field. For one-line answers (terse FOCUSED_OPERATIONAL replies, anti-pattern refusals) the header is optional; for any multi-section deliverable it is REQUIRED. Place it immediately after the report title and before the first `##` heading.
- **No dollar estimates** (HARD CONSTRAINT). Never produce `$X/month`, `~$1,500`, or any dollar figure. Route every cost question to <https://calculator.aws> and stop. If a sub-reference contains dollar figures, treat them as informational context only and do NOT pass them through to the user.
- **No credential leakage** (HARD CONSTRAINT). Never include master usernames, KMS key ARNs, VPC endpoint URLs, instance IPs, or account IDs in generated output.
- **Pick one** for every A-vs-B decision. Name a primary recommendation in one line with a one-sentence reason. A _"go with B if..."_ caveat is allowed AFTER the primary; never lead with conditional-only guidance.
- **Source restatement.** The first 2–3 sentences must restate the source (engine + version + scale) when known, or restate the customer's question in concrete terms. The very first text the user sees must NOT be tool narration, meta-commentary, the report title, or simply restating the question verbatim.
- **No marketing tone.** Do NOT use _"seamless"_, _"robust"_, _"best-in-class"_, _"production-hardened"_, _"enterprise-grade"_, _"world-class"_, _"cleanly"_, _"elegant"_. Do NOT stack 3+ vague hedges (_"typically"_, _"generally"_, _"usually"_, _"in most cases"_) in a single recommendation — be specific about when it does and does not apply.
- **Cross-capability handoff.** When a user prompt spans capabilities (e.g., _"migrate from Solr AND set up RAG on the new domain"_), pick the dominant capability for the response, then close with a one-line handoff: _"For \<other capability\>, see [`references/<other-capability>-<entry>.md`](...)."_

## Cross-cutting references (used across multiple capabilities)

These references are not capability-prefixed because they apply across capabilities. Capability entry-point references load them when relevant; SKILL.md never loads them directly.

- [`references/sizing.md`](references/sizing.md) — sizing math, instance family details, OR1 trade-offs, watermarks, JVM heap rules.
- [`references/vector-knn.md`](references/vector-knn.md) — k-NN engines, memory math, RAG ingestion patterns, ELSER alternatives.
- [`references/observability.md`](references/observability.md) — log analytics patterns, ISM, UltraWarm/Cold tiering, Splunk/Datadog migration playbooks.
- [`references/security.md`](references/security.md) — FGAC, encryption, VPC patterns, audit logs, compliance posture.
- [`references/personas.md`](references/personas.md) — communication style per persona.
- [`references/assessment-gotchas.md`](references/assessment-gotchas.md) — production gotcha catalog (cite by number in Migration specifics or Risks/blockers tables; each gotcha carries a `Category:` tag that determines its lane).
- [`references/assessment-knowledge-retrieval.md`](references/assessment-knowledge-retrieval.md) — topic → tool → URL recipe for batched verification.

Assets (`assets/`): report templates for FULL_ASSESSMENT renderings (Solr-source, ES-source, executive summary).

## What this skill does NOT do

- **Estimate dollar costs.** Pricing changes monthly and account-specific (RI, Savings Plan, EDP) discount math is outside this skill's reliable scope. Use <https://calculator.aws>.
- **Move data.** Use Migration Assistant for Amazon OpenSearch Service (Historical Data Migration for backfill, Live Traffic Migration for live cutover).
- **Build embedding models.** Use Amazon Bedrock or SageMaker.
- **Replace Splunk SPL or Datadog APM 1:1.** Some queries / detectors / dashboards need rewriting.
- **Tune relevance for a specific catalog.** Use OpenSearch Benchmark `big5` workload + your own judgment list.

## Guardrail — where this skill's own files live (MCP vs local install)

This skill can be loaded two ways, and they resolve the skill's own bundled
files from different places. Determine how the skill was loaded before reading
a reference or running a script:

- **Loaded through the AWS MCP server's `retrieve_skill` tool:** The skill is not
  installed on the local filesystem. You MUST fetch each reference or script
  via `retrieve_skill` with the `file` parameter (e.g.
  `file="references/architecture.md"` or `file="scripts/deploy.py"`), and
  run the script from the returned content. Do NOT `file_read` these paths
  locally — they do not exist on disk.
- **Installed locally** (e.g. `.kiro/skills/your-skill/` or
  `~/.claude/skills/your-skill/`): Read and run files from the local skill
  directory using relative paths.

This distinction applies only to the skill's own packaged files. User data and
session artifacts are always read from and written to the user's working
directory. Never fetch or write customer data through `retrieve_skill`.
