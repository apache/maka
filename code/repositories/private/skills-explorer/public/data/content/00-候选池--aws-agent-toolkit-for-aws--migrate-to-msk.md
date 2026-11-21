---
name: migrate-to-msk
description: >-
  Helps migrate self-managed Apache Kafka workloads to Amazon MSK Express. Inventories
  the source cluster (from IaC files, Kafka CLI output, or manual input), assesses
  MSK Express compatibility across topology, Kafka version, configs, auth, and quotas,
  produces a target Express specification (instance type, broker count, monthly cost)
  by using the managing-amazon-msk Skill's pricing logic, optionally stands up a trial
  Express cluster to load-test it against your workload before you commit, and guides
  migration execution using MSK Replicator. Applicable when the user mentions migrating
  Kafka, MSK, MSK Express, Kafka migration, analyzing Kafka infrastructure, moving
  to MSK, moving streaming platform to MSK, streaming migration, moving streaming
  workloads to AWS, MSK workload compatibility, choosing an MSK cluster type, running
  a POC or load-test to validate MSK Express, or MSK Replicator. Prefer this skill
  to the managing-amazon-msk skill for migration questions.
version: 3
---

# Migrating to MSK Express

## Overview

This skill helps customers migrate self-managed Apache Kafka workloads to Amazon MSK
Express. It provides three phases — **Discovery**, **Assessment**, and an optional
**Simulation** — that can be run end-to-end or individually depending on the customer's needs.

## Scope

This skill covers migrations from **self-managed Apache Kafka** (on-premises, EC2,
Docker, Kubernetes, or other non-MSK deployments) to MSK Express. Migrations from
**MSK Standard (Provisioned) to MSK Express** are out of scope.

## Prerequisites

The AWS MCP server is recommended for documentation lookups and informational
questions, but is not required. The assessment scripts are pure file processors
with no AWS API calls.

## Intent Routing

Route the customer's request based on their intent:

### 1. Open/exploratory question ("How do I migrate to MSK?")

Explain what this skill offers:

> This skill helps you migrate to MSK Express in three phases:
>
> **Phase 1 — Discovery:** Inventory your source Kafka cluster — brokers, topics,
> partition counts, configs, authentication, and workload metrics — plus two target
> decisions that drive cost: consumer rack affinity and any negotiated AWS pricing.
> I can discover this from IaC files (Terraform, CDK, Docker Compose, Kubernetes
> manifests), provide commands for you to run on your cluster, or you can provide the
> information manually. Output: `migrate-to-msk-skill-artifacts/<cluster_name>/cluster-config.json`.
>
> **Phase 2 — Assessment:** Validate your cluster against MSK Express across 5
> compatibility pillars (topology, Kafka version, configs, auth, quotas) and produce
> a target Express specification using the managing-amazon-msk Skill's pricing logic.
> I'll flag what Express will refuse vs what Express will silently convert. Outputs:
> `compatibility.<cluster_name>.json`, the pricing results in Markdown `msk_sizing_pricing.md`,
> and `msk-sizing-inputs.<cluster_name>.json`.
>
> **Phase 3 — Simulation:** Spin up an MSK Express cluster with load-testing
> infrastructure to see how Express performs on your own workload, then run a vended
> test (End-to-End Latency or Broker Restart Under Load) and review the results on a
> CloudWatch dashboard.
>
> **Data replication:** For migrating data to your Express cluster, you can use
> MSK Replicator. I can provide guidance on setup and configuration.
>
> Where would you like to start? I can begin with discovery if you point me to your
> infrastructure code or describe your cluster, or jump to assessment if you already have a
> `cluster-config.json` file, or go straight to simulation if you already know your target
> Express configuration.

**Guardrails for this overview response:**

- This response is an overview and a routing question only. Do NOT begin, simulate, or pre-empt any phase.
- Do NOT produce or estimate assessment output here — no verdicts, pillar findings, compatibility conclusions, broker counts, instance recommendations, or cost figures. Those values exist only after you run the Phase 2 scripts against a real `cluster-config.json`.
- Do NOT open, read, or summarize the internals of `compatibility.py`, `simulation_load_test_config.py`, or the reference files to explain how a phase works. Describe the phases at the level shown above; do not walk the customer through the implementation.
- When the customer chooses a phase, run that phase's scripts or flow to produce real results. Always operate the skill to answer — never answer from having read its source. For the exact commands, see "Running the assessment" in [references/assessment-compatibility.md](references/assessment-compatibility.md) for Phase 2, and [references/simulation.md](references/simulation.md) for Phase 3.

### 2. Discovery intent (DEFAULT when IaC files are provided)

If the customer provides a directory path, IaC files, or says "here's our infra" —
this is discovery intent. Run ONLY Phase 1 (Discovery). Do NOT run assessment,
do NOT suggest migration steps, do NOT mention blockers or compatibility.
Produce the `migrate-to-msk-skill-artifacts/<cluster_name>/cluster-config.json` file and stop.

### 3. Assessment intent

Customer explicitly asks to assess or has a `migrate-to-msk-skill-artifacts/<cluster_name>/cluster-config.json` file
already produced. Run Phase 2 (Assessment) only.

### 4. Simulation intent

Customer wants to test MSK Express with their workload. They can provide cluster
sizing directly (instance type, broker count, Kafka version) or reference an earlier
assessment. Proceed directly to [Phase 3 — Simulation](#phase-3--simulation-optional).
An assessment is helpful but not required — the simulation asks for sizing inputs
directly.

### 5. Informational questions

Customer asks about Express capabilities, constraints, configuration differences,
authentication support, pricing, or compaction behavior without providing
cluster-specific data. Use AWS documentation tools (`aws___search_documentation`,
`aws___read_documentation`) if available to look up the answer from MSK Express
documentation. If MCP tools are not available, reference the
[MSK Express documentation](https://docs.aws.amazon.com/msk/latest/developerguide/msk-broker-types-express.html)
and answer based on knowledge of AWS MSK.

### 6. Migration strategy questions

Customer asks about MSK Replicator compatibility, version upgrade paths, MirrorMaker 2,
or migration strategies. MSK Replicator is the native AWS-supported solution for data
replication and works for both MSK-to-MSK and non-MSK-to-MSK migrations. Use AWS
documentation tools (`aws___search_documentation`, `aws___read_documentation`) if
available to retrieve current requirements and supported configurations. If MCP tools
are not available, reference the
[MSK Replicator documentation](https://docs.aws.amazon.com/msk/latest/developerguide/msk-replicator.html)
and answer based on knowledge of AWS MSK.

---

## Phase 1 — Discovery

**Purpose:** Inventory the source cluster to build a migration profile.

**Input:** One of:

- A directory path containing IaC files (CDK, CloudFormation, Docker Compose, Kubernetes manifests, Terraform)
- Output from Kafka CLI commands the customer runs on their cluster
- Manual information provided by the customer in conversation

**Output:** `migrate-to-msk-skill-artifacts/<cluster_name>/cluster-config.json` — saved to the working directory.

### Discovery rules

- Before doing ANYTHING else in discovery, you MUST read
  [references/discovery.md](references/discovery.md) in full. It defines the
  input methods, the REQUIRED response template, the forbidden content, and the
  `cluster-config.json` schema. Do NOT respond until you have read it, and follow
  its template EXACTLY.
- ALWAYS save `migrate-to-msk-skill-artifacts/<cluster_name>/cluster-config.json` in the working directory.
- Do NOT proceed to Phase 2 without explicit customer confirmation.

---

## Phase 2 — Assessment

**Purpose:** Assess the cluster against MSK Express requirements and produce a target
Express specification (instance type, broker count, monthly cost projection).

**Input:** `migrate-to-msk-skill-artifacts/<cluster_name>/cluster-config.json` from Phase 1.

**Outputs:**

- `migrate-to-msk-skill-artifacts/<cluster_name>/compatibility.<cluster_name>.json` — five-pillar verdict.
- `migrate-to-msk-skill-artifacts/<cluster_name>/msk_sizing_pricing.md` — the managing-amazon-msk Skill's pricing report with broker count and cost recommendations.
- `migrate-to-msk-skill-artifacts/<cluster_name>/msk-sizing-inputs.<cluster_name>.json` — a record of the six input values for sizing logic.

Assessment has two independent halves; run them in either order, and a failure in
one does not block the other:

- **Compatibility** — `scripts/compatibility.py`, a pure file processor (no live
  AWS API calls) run via `uv run` with PEP 723 inline dependencies. It validates
  the source across five pillars — topology, Kafka version, configs, auth, and
  quotas — and emits one verdict per pillar (`INFO`, `ADVISORY`, or
  `ACTION_REQUIRED`, worst-of for the overall). Use those three strings verbatim.
- **Sizing** — not a script in this skill. Load the managing-amazon-msk Skill and
  run its `scripts/msk_sizing.py` with the workload inputs derived from
  `cluster-config.json`, passing `--broker-classes express`.

### Assessment rules

- Read [references/assessment-compatibility.md](references/assessment-compatibility.md)
  before responding. It carries the invocation commands, the per-pillar thresholds
  and evidence codes, the verdict definitions, the full forbidden-behavior list,
  and the **required response template** covering both artifacts. Do not freestyle
  the post-script summary.
- Read [references/assessment-sizing.md](references/assessment-sizing.md) before
  running sizing. It carries the input derivations (several are not one-to-one —
  getting them wrong silently produces a wrong broker count), the `target`-block
  flags for rack affinity and negotiated discounts, the Express-only presentation
  rule, and the source-footprint comparison.
- Surface any `ACTION_REQUIRED` evidence to the user for awareness, but do not gate further phases on it. Express may still accept the workload with mitigations.
- **Do NOT pivot back into discovery.** Assessment operates on the existing
  `cluster-config.json` as-is. Partial data is fine — the scripts emit ADVISORY
  evidence (`METRICS_MISSING`, `AZ_COUNT_UNKNOWN`, etc.) for missing fields;
  surface those findings and stop. Do not propose Kafka CLI commands, IaC walks,
  scripts, or questionnaires to fill the gaps.
- Report broker counts and costs only as read verbatim from the sizing script
  output. Never round, re-derive, or estimate them.

---

## Phase 3 — Simulation (optional)

Deploy a temporary, isolated MSK Express cluster and client fleet in the
customer's account so they can see how Express performs on their own workload, then
run one of two vended tests (End-to-End Latency, Broker Restart Under Load) and hand
over a CloudWatch dashboard. Follow the 12-step conversational flow and all deploy,
sizing, and guardrail details in [references/simulation.md](references/simulation.md);
the deterministic artifacts it drives are
[scripts/simulation_load_test_config.py](scripts/simulation_load_test_config.py) and the
static [assets/simulation-stack.yaml](assets/simulation-stack.yaml).

---

## Execution model

Scripts run on the customer's local machine via `uv run`. They declare their own
dependencies (PEP 723) and are pure file processors — no AWS API calls, no
network access, and no third-party dependencies (standard library only).

## Security Considerations

Apply these controls at every phase. For additional detail, see
[MSK Security best practices](https://docs.aws.amazon.com/msk/latest/developerguide/security.html)
and [MSK IAM access control](https://docs.aws.amazon.com/msk/latest/developerguide/iam-access-control.html).

1. **Encryption in transit (mandatory).** Enforce TLS for client-broker traffic
   on the MSK Express target (`EncryptionInTransit.ClientBroker = TLS`).

2. **Encryption at rest (mandatory).** Provision the target cluster with a
   customer-managed KMS key (or AWS-managed if your compliance posture allows).

3. **Authentication — prefer IAM over long-lived credentials.** Configure the
   MSK Express target with IAM authentication as the sole client auth method.
   This gives ephemeral, role-based credentials with full CloudTrail coverage.

4. **Credential storage — use AWS Secrets Manager.** Store SASL/SCRAM and TLS
   credentials for source cluster access in Secrets Manager. Never pass passwords
   as CLI arguments.

5. **Network isolation.** Deploy MSK clusters in private subnets. Use security
   groups scoped to specific CIDR ranges or security group references. Do NOT use
   0.0.0.0/0 ingress rules.

6. **CloudTrail logging and CloudWatch alarms.** Ensure CloudTrail is enabled in
   the target account and covers `kafka.amazonaws.com` API calls. Configure alarms:
   - `ClientAuthenticationFailure` — surge indicates credential problems or attack
   - `ConnectionCloseCount` — abnormal spike may indicate connection-flooding
   - CloudTrail metric filters for denied `kafka-cluster:*` actions
   - Connection-rate alarms approaching the 100 conn/sec/broker IAM limit

7. **Sensitive data handling.** Discovery and assessment outputs contain broker
   addresses, auth hints, and broker config values. Treat these as sensitive — do
   not paste into public channels or ticketing systems without redaction.

## Troubleshooting

Per-pillar findings, including the source topology and out-of-range config cases,
are explained in
[references/assessment-compatibility.md](references/assessment-compatibility.md).
