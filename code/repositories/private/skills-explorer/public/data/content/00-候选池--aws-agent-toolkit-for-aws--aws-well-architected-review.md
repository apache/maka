---
name: aws-well-architected-review
description: Performs a full AWS Well-Architected Framework review evaluating every framework question across all pillars discovered from the live AWS documentation by analyzing code, IaC, and configurations to produce evidence-backed findings with Eisenhower-prioritized remediation. Supports full reviews (every framework best practice with BP ID citations), quick reviews (question-level), pillar-scoped reviews, score-mode reviews (a maturity scorecard with per-pillar scores and filtered findings), and lens-specific reviews using lenses discovered from the live AWS documentation. Triggers on mentions of Well-Architected review, WA review, WAR, pillar assessment, architecture review across pillars, workload assessment, cloud readiness evaluation, or a Well-Architected score, grade, or scorecard request. Does not apply to single-pillar deep-dives, learning WA concepts, ADRs, or migration readiness assessments.
---

# Well-Architected Review

## Overview

Guides a systematic AWS Well-Architected Framework (WA Framework) review: discover the workload from code and IaC, acquire the live corpus inventory, evaluate every framework question and best practice against evidence, and deliver a risk-ranked, Eisenhower-prioritized report inline.

Framework content is fetched from the live AWS documentation at review time rather than embedded as a snapshot. The AWS MCP server's documentation reader (`aws___read_documentation`) is recommended for reliable retrieval; when it is unavailable, fetch the same `docs.aws.amazon.com` pages over HTTPS with the environment's web-fetch tool, and if no documentation access exists at all, proceed from internal knowledge and disclose that the framework inventory could not be verified live. Do not depend on any non-public or internal best-practice/WA-guidance MCP; those are unavailable in supported runtimes.

Detailed procedures live in reference files — read each one when its step says to:

- [Review modes](references/review-modes.md) — mode selection (full / quick / pillar-scoped / score), trigger phrases, score output format
- [Discovery procedure](references/discovery-procedure.md) — infrastructure and application architecture discovery
- [Live corpus inventory](references/phase-live-inventory.md) — the gated `ACQUIRE_CORPUS` stage: deterministic read-only traversal of the framework, the corpus records, and the validation gate
- [Evaluation procedure](references/evaluation-procedure.md) — evaluating every BP against the frozen manifest, per-pillar passes, aggregation rules, coverage audit
- [Lens guidance](references/lens-guidance.md) — when and how to apply Well-Architected Lenses
- [Risk assessment](references/risk-assessment.md) — impact × likelihood matrix and cross-pillar trade-offs
- [Report template](assets/report-template.md) — the full report structure for the report step
- [Security considerations](references/security-considerations.md) — secure handling of workload data, review tooling, findings, and persisted artifacts

## Execution model

**Before beginning any step**, read and follow [security considerations](references/security-considerations.md) — secrets redaction, HTTPS-only retrieval, least privilege, and confidentiality handling must be loaded before you operate on workload code or review tooling.

A full review runs as a gated sequence. Each step has a transition gate; you MUST NOT advance to the next step, or skip a step, when its gate has not passed. The single user-visible deliverable is one complete inline report — scratch files (a run-local working directory) are execution state only, never the delivered artifact, and their paths MUST NOT appear in the report.

**Non-interactive by default.** When the user has explicitly requested a review and supplied sufficient scope, execute every step to completion **without pausing for confirmation between steps**. The discovery and risk-assessment checkpoints are **internal validation gates**, not user stops: validate them yourself and proceed. Pause for the user only when the user explicitly asked for interactive checkpoints, or when a required scope decision genuinely cannot be inferred (e.g. an ambiguous pillar-scoped request).

**Non-negotiable invariants — ALL modes (full / quick / pillar-scoped / score):**

- Step 4 (`ACQUIRE_CORPUS`) is **mode-independent**: every mode acquires and **validates** the live corpus inventory before any assessment and reads its questions/BPs against that frozen manifest. Assessment MUST NOT begin against an incomplete or unvalidated manifest, and no mode may skip Step 4.
- Canonical IDs only — never fabricate a `PILLAR##-BP##` ID. If corpus acquisition cannot produce an ID, that is a surfaced error, not a gap to invent around.

**Non-negotiable invariants — full review only:**

- Every BP in the frozen manifest receives exactly one status from the five-value vocabulary.
- **All sections of [the report template](assets/report-template.md) are present** (it is the authoritative list — the numbered items in Step 7 are the recall-critical subset, NOT the complete set: the template also mandates the Executive Summary, Architecture Overview, Cross-Pillar Trade-offs, Next Steps, and others). The report is emitted **inline**, first line `# Well-Architected Review:`. No "see file", attachment, or scratch-path deferral.

## Step 1: Define the workload scope

Establish the workload from what the user provided:

> - **Workload name** and brief description
> - **Code packages/directories** to analyze (IaC, application code, CI/CD configs)
> - **Business criticality** (critical, high, standard, low)
> - **Current pain points** (optional)

If the user has already provided architecture details or you are in a codebase with IaC, proceed with discovery without prompting. When no code or IaC is available (the user describes their architecture verbally), proceed using the description as evidence; mark findings you cannot verify in code as "Based on description — verify in code." Do NOT ask for code when the user has already given enough context for a meaningful review.

Determine the review mode (full / quick / pillar-scoped / score) from the user's phrasing — read [review modes](references/review-modes.md). Determine whether the workload matches a live lens — read [lens guidance](references/lens-guidance.md) when one does.

## Step 2: Infrastructure Discovery

Read and follow [the discovery procedure](references/discovery-procedure.md).

## Step 3: Application Architecture Discovery

Continue following [the discovery procedure](references/discovery-procedure.md), including its internal completeness gate before evaluation.

## Step 4: Acquire and freeze the live corpus inventory (ACQUIRE_CORPUS gate)

Read and follow [the live corpus inventory procedure](references/phase-live-inventory.md). First create the run-local working directory this review uses for scratch state — the `corpus/` folder that holds `questions.jsonl`, `best-practices.jsonl`, and `manifest.json` referenced below. Then build the complete live corpus inventory (the question + best-practice manifest) by a bounded, read-only traversal of the canonical framework pages (prefer `aws___read_documentation`; see the reference for the non-MCP HTTPS fallback), reduce each page to structured records immediately, and validate the manifest.

**Gate:** you MUST NOT begin Step 5 until `corpus/manifest.json` reports `valid: true`. The frozen manifest is the sole authority for the expected question and BP sets used by evaluation, the coverage audit, and the report.

## Step 5: Evaluate EVERY BP against the frozen manifest

**CRITICAL — DO NOT PRODUCE A SHORT REVIEW.** The most common failure is citing a subset of BPs and stopping. A full review MUST evaluate every BP in the frozen manifest, each with a status from the five-value vocabulary (with rationale).

Read and follow [the evaluation procedure](references/evaluation-procedure.md). It defines per-pillar passes against the frozen manifest, aggregation, per-mode adjustments, and the coverage audit (its sub-steps are labelled 5a–5d). For each BP assess:

- **Status**: exactly one of "Implemented", "Partially Implemented", "Not Implemented", "Not Applicable", "Cannot Determine"
- **Evidence**: specific file paths and line numbers (or "Based on description")
- **Gaps**: what is missing or could be improved
- **Risk**: what could go wrong due to the gap

Evaluate every pillar in the frozen manifest, using its pillar names, prefixes, and question categories.

## Step 6: Risk Assessment

Read and follow [the risk assessment procedure](references/risk-assessment.md), including its internal gate.

## Step 7: Produce the report

**Mode gate:** For **score mode**, emit only the scorecard output from [review modes](references/review-modes.md). For **quick** and **pillar-scoped** reviews, apply the mode adjustments from [review modes](references/review-modes.md). For a **lens-only** request (the user named a single WA Lens and did not ask for a full framework review), produce a standalone lens report — the core framework tables are omitted and the deliverable is the **Lens Findings** section plus a lens scorecard, following [lens guidance](references/lens-guidance.md); when a lens is applied **on top of** a full review, keep the full structure and add the Lens Findings section. Otherwise — a **full review** — read [the report template](assets/report-template.md) and produce the report with that exact structure. [The report template](assets/report-template.md) is the authoritative list of mandatory sections; the following are the recall-critical ones that a weaker model most often drops (do NOT treat them as the complete set):

1. **Coverage audit** (from the evaluation procedure, Step 5d) before the executive summary
2. **Pillar scorecard** with per-pillar scores (1-5)
3. **Per-question assessment table** — every question in the frozen manifest, no truncation
4. **Full BP Ledger** — one row per evaluated BP, concatenated verbatim from the pillar passes
5. **Risk-classified findings** (Critical/High expanded, Medium condensed, Low tabular)
6. **Eisenhower-prioritized remediation plan** (Do First / Plan / Delegate / Defer) with SMART goals

Emit the report inline as the final response, first line `# Well-Architected Review:`. Do not defer any section to a file.

## Step 8: Offer follow-up

After delivering the report, offer:

> Would you like me to:
>
> - Deep-dive into a specific pillar with expanded analysis?
> - Generate IaC templates to remediate a specific finding?
> - Create a migration plan for a specific architectural change?
> - Compare your workload against a specific WA Lens in detail?
> - Generate automated checks (Config rules, custom metrics) for ongoing compliance?
> - Produce a WA Tool import for tracking in the AWS console?

## Calibration Guidance

- A workload with multi-AZ, encryption, CI/CD with rollback, monitoring, and auto-scaling is MATURE — most findings should be improvements, not Critical
- Do NOT manufacture Critical findings for a well-built workload — accuracy over alarm
- When business criticality is "low"/"standard", accept simpler architectures (single-region is fine for internal tools)
- When business criticality is "critical", apply stricter standards (multi-region DR, chaos testing, sub-minute RTO expected)
- Every finding MUST have code evidence — no generic recommendations without backing
- If something cannot be determined from code, say "Cannot Determine" and explain what runtime/interview data is needed
- Acknowledge strengths prominently — a mature workload should feel validated, not just criticized

## Security Considerations

Read and follow [security considerations](references/security-considerations.md) before using review tooling, sharing findings, or persisting artifacts.
