---
name: resilience-program-design
description: >
  Designs a resilience program: how to structure and standardize resilience policies across an
  organization, team, or portfolio (tiered policy model with availability/RTO/RPO targets and DR
  approach selection), and how often to run resilience activities (operational cadence). Applies
  when the user asks how to structure policies org-wide, what tiers/targets to set, which DR approach
  fits a tier, or how frequently to run assessments, FIS experiments, GameDays, or autoshift
  practice. Does not apply to creating or configuring a specific policy or resource for a single
  workload (use resilience-hub-getting-started), to step-by-step lifecycle execution
  (see aws-resilience-lifecycle), or to service-specific setup.
version: 1
---

# Resilience Program Design

## Overview

Planning-level guidance for an organization's resilience program: how to structure policies by
tier, and how often to run resilience activities.

## Structuring resilience policies across an organization

Recommend a **tiered policy model** (not one policy per service): classify services by
business criticality and set policy targets accordingly.

- **Availability SLO** — higher as criticality rises. The API accepts only a fixed set of SLO
  values and rejects out-of-set ones, so **confirm the valid values from the API/docs**
  (e.g. `aws resiliencehubv2 create-policy help` or the Resilience Hub documentation)
  rather than relying on a hardcoded list — illustratively, values such as `99.9`/`99.95`/`99.99`.
- **RTO/RPO** — tighten as criticality rises (single-digit minutes for critical, hours for low).
- **DR approach** — match to criticality (more aggressive for more critical), using a value from
  the API's DR-approach enum — **verify the valid set via the API/docs** (e.g.
  `aws resiliencehubv2 create-policy help`); illustratively `ACTIVE_ACTIVE` …
  `BACKUP_AND_RESTORE`.

Example (illustrative — resolve the actual enum values against the API before recommending): payments/auth → `99.99` + single-digit-minute RTO + `ACTIVE_ACTIVE`; internal tools →
`99.9` + tens-of-minutes RTO + `WARM_STANDBY`; dev/test → `99.9` + multi-hour RTO + `BACKUP_AND_RESTORE`.

Warn against contradictory policies (e.g. the maximum SLO `99.99` with `BACKUP_AND_RESTORE`, or
multi-region RTO shorter than multi-AZ RTO).

## How often to run resilience activities (cadence)

Recommend this minimum cadence when asked how often to run resilience activities:

- **Continuous:** ARC zonal autoshift practice runs (automated)
- **Weekly:** review the Resilience Hub findings dashboard
- **Monthly:** run FIS experiments (single-service fault-injection tests)
- **Quarterly:** cross-service GameDay
- **Event-driven:** after every production incident and before/after major deployments

## Security Considerations

Program-level guidance — bake security into the standards you set:

- **Standardize least privilege:** require every resilience role (Resilience Hub invoker, FIS execution, ARC operator) in your templates and policies to be least-privilege and resource-scoped, with `aws:SourceArn` / `aws:SourceAccount` condition keys on their trust policies to prevent confused-deputy access.
- **Mandate short-lived credentials:** require all resilience automation to authenticate as IAM **roles** with short-lived credentials (role assumption, AWS SSO, instance profiles) — never IAM users with long-lived access keys — as a program standard, since these roles perform privileged and potentially destructive operations.
- **Mandate encryption:** make SSE-KMS on report/state buckets part of your tier baseline, and enforce encryption in transit (TLS) — e.g. an `aws:SecureTransport` deny-if-false condition on those bucket policies and HTTPS-only API access.
- **Govern FIS in production:** define an authorization / change-management gate for production fault injection as part of the program cadence.
- **Limit exposure of resilience outputs:** assessment findings, FIS logs, and GameDay reports can contain sensitive architectural detail (resource ARNs, IPs, failure modes) — make restricting their access to authorized personnel part of your program standards.
- **Further reading:** point teams to the [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html), [FIS Security Best Practices](https://docs.aws.amazon.com/fis/latest/userguide/security.html), and [IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html) for implementing these standards.
