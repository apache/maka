---
name: aws-security
description: "Covers AWS security services and workflows — Security Hub V2 (OCSF) findings, connectors, aggregators, automation rules, and security posture summaries; Security Hub CSPM (V1/ASFF) controls and compliance standards; GuardDuty threat findings; Inspector vulnerability findings; Macie sensitive data findings; Detective investigation; and Security Lake configuration and data aggregation. Applicable when questions involve security posture, Exposure findings, CSPM failed controls, threat findings, vulnerability findings, sensitive data findings, automation rules, or cross-service security configuration across AWS environments. Procedures use standard AWS CLI syntax and work with or without the AWS MCP server."
metadata:
  version: "1"
---

# AWS Security

**STOP — Do not answer from general knowledge.** Before responding to any security service question, match the user's request against the sub-skill registry below and follow its procedure. If the procedure says to load a reference file, you MUST read it before providing operational guidance. Never skip the routing step.

AWS Security services provide threat detection (GuardDuty), vulnerability management (Inspector), unified security dashboard and exposure analysis (Security Hub), compliance posture management (Security Hub CSPM), sensitive data discovery (Macie), investigation (Detective), and centralized log storage (Security Lake). Each service has dedicated reference procedures for configuration review and findings/investigation summarization.

This skill works with or without the AWS MCP server. When available, the AWS MCP server is recommended for sandboxed execution and audit logging. Procedures use standard AWS CLI syntax (`aws <service> <command>`).

See `references/services-overview.md` for service relationships, data formats, and cross-service integration patterns.

## Global rules

1. **Read-only APIs only.** This skill and all its references use exclusively non-mutating APIs. NEVER reference, recommend, or invoke any API that creates, modifies, deletes, enables, disables, or otherwise mutates resource state or configuration — not even in prose recommendations. See service reference files for the complete allowed API list.

2. **No severity judgements on configuration state.** Present what is and is not configured factually. Do not assign severity labels, gap assessments, or editorial framing (e.g., "critical gap", "security issue") to configuration state.

3. **No false-positive suppression recommendations.** Focus on helping customers understand findings. Do not recommend suppression filters, archival rules, or finding dismissal.

4. **Prioritize Attack Sequences in GuardDuty.** Findings with type prefix `AttackSequence:` represent correlated multi-step attacks. Always surface these first, before severity breakdown.

5. **Prioritize Exposure findings in Security Hub.** Exposure findings (attack paths, resource exposure) represent Security Hub's unique cross-service correlation. Surface these first in any findings summary.

6. **Expensive operations require explicit request.** MUST NOT paginate through all member accounts by default. Per-account enumeration only executes if the user explicitly requests detailed account-level information. Use statistics/count APIs where available (e.g., `get-coverage-statistics`).

7. **Match the user's language.** Respond in the same language the user writes in.

8. **Verify, don't guess.** If you cannot confirm a fact from a reference file or API output, say so.

9. **Sensitive data disclosure.** When a procedure produces output that may contain sensitive information (full finding bodies, IP addresses, resource identifiers, network configurations, threat intelligence details), present a summary first. Note what sensitive data the full output contains. Display the complete raw response only when the caller explicitly requests it.

## How this skill works

1. **Find the sub-skill** — Match the user's request against the sub-skill registry below. Match on meaning, not exact wording. If ambiguous, ask: "Are you checking configuration, or do you need a findings summary?"

2. **If a sub-skill matches** — read `references/{sub-skill-id}.md` and follow its procedure.

3. **If no sub-skill matches** — answer from the service reference files listed below. Load `references/services-overview.md` for cross-service context, or the relevant service reference file (e.g., `references/guardduty.md`) for API scope and severity scoring questions.

4. **Cross-service overview** — When the user asks about overall security posture across multiple services, start with `references/services-overview.md`, then route to relevant sub-skills.

## Sub-skill registry

| ID                                | Name                             | Trigger Phrases                                                                                                                                                             | When to Route Here                                                  | Reference                                       |
| --------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| `guardduty-configuration`         | GuardDuty Config Review          | "is GuardDuty configured", "check detector", "GuardDuty features enabled", "runtime monitoring setup"                                                                       | User wants to verify GuardDuty deployment completeness              | `references/guardduty-configuration.md`         |
| `guardduty-findings`              | GuardDuty Findings Summary       | "summarize GuardDuty findings", "what threats", "GuardDuty severity breakdown", "attack sequences"                                                                          | User wants a findings posture snapshot                              | `references/guardduty-findings.md`              |
| `inspector-configuration`         | Inspector Config Review          | "is Inspector scanning", "Inspector enabled", "scan types", "coverage gaps"                                                                                                 | User wants to verify Inspector deployment                           | `references/inspector-configuration.md`         |
| `inspector-findings`              | Inspector Findings Summary       | "vulnerabilities found", "Inspector findings", "CVE summary", "vulnerability posture"                                                                                       | User wants vulnerability overview                                   | `references/inspector-findings.md`              |
| `security-hub-configuration`      | Security Hub Config Review       | "Security Hub integrations", "aggregation configured", "connectors", "automation rules", "V2 automation rules", "OCSF automation rules"                                     | User wants to verify Security Hub V2 (OCSF) setup                   | `references/security-hub-configuration.md`      |
| `security-hub-findings`           | Security Hub Findings Summary    | "risk overview", "exposure findings", "attack paths", "OCSF findings", "security posture trends"                                                                            | User wants Security Hub V2 (OCSF) findings overview                 | `references/security-hub-findings.md`           |
| `security-hub-cspm-configuration` | CSPM Config Review               | "standards enabled", "controls", "FSBP", "CIS", "PCI-DSS", "NIST", "compliance setup", "AI security", "AI best practices", "CSPM automation rules", "ASFF automation rules" | User wants to verify compliance standards setup                     | `references/security-hub-cspm-configuration.md` |
| `security-hub-cspm-findings`      | CSPM Compliance Summary          | "compliance posture", "failed controls", "pass rate", "ASFF findings", "third-party findings"                                                                               | User wants compliance findings overview                             | `references/security-hub-cspm-findings.md`      |
| `macie-configuration`             | Macie Config Review              | "Macie configured", "data discovery setup", "classification jobs", "Macie enabled"                                                                                          | User wants to verify Macie deployment                               | `references/macie-configuration.md`             |
| `macie-findings`                  | Macie Findings Summary           | "sensitive data found", "Macie findings", "data classification results", "PII detected"                                                                                     | User wants sensitive data overview                                  | `references/macie-findings.md`                  |
| `detective-configuration`         | Detective Config Review          | "Detective configured", "behavior graph", "Detective members", "data sources"                                                                                               | User wants to verify Detective deployment                           | `references/detective-configuration.md`         |
| `detective-investigations`        | Detective Investigations Summary | "Detective investigations", "investigation status", "indicators", "finding groups"                                                                                          | User wants investigation landscape overview                         | `references/detective-investigations.md`        |
| `security-lake-configuration`     | Security Lake Config Review      | "Security Lake configured", "log sources enabled", "subscribers", "data lake setup"                                                                                         | User wants to verify Security Lake deployment                       | `references/security-lake-configuration.md`     |
| `security-lake-sources`           | Security Lake Sources Summary    | "what's flowing into Security Lake", "ingestion status", "source health", "data lake exceptions"                                                                            | User wants data lake health overview                                | `references/security-lake-sources.md`           |
| `organization-policies`           | Organization Policies Review     | "organization policies", "org policies", "SECURITYHUB_POLICY", "INSPECTOR_POLICY", "list-policies", "policy targets", "policy enforcement"                                  | User wants to review or discover AWS Organizations service policies | `references/organization-policies.md`           |

## Disambiguation

| Keywords                                                                             | Route to                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "automation rules" (ambiguous)                                                       | Both Security Hub and Security Hub CSPM have automation rules. If customer uses Security Hub V2 (OCSF), route to Security Hub config. If customer uses Security Hub CSPM (ASFF), route to CSPM config. Ask if unclear. |
| "standards", "controls", "compliance", "FSBP", "CIS", "PCI", "NIST", "ASFF"          | Security Hub CSPM skills                                                                                                                                                                                               |
| "integrations", "risk score", "attack path", "OCSF", "exposure", "connectors"        | Security Hub skills                                                                                                                                                                                                    |
| "threat detection", "GuardDuty", "detector", "runtime monitoring", "attack sequence" | GuardDuty skills                                                                                                                                                                                                       |
| "vulnerability", "CVE", "Inspector", "scanning", "code vulnerability"                | Inspector skills                                                                                                                                                                                                       |
| "sensitive data", "classification", "Macie", "PII", "data discovery"                 | Macie skills                                                                                                                                                                                                           |
| "investigation", "behavior graph", "Detective", "indicators"                         | Detective skills                                                                                                                                                                                                       |
| "data lake", "log sources", "Security Lake", "subscribers", "ingestion"              | Security Lake skills                                                                                                                                                                                                   |
| "organization policies", "org policies", "policy type", "list-policies --filter"     | Organization Policies (cross-service)                                                                                                                                                                                  |

**Note:** If a customer is using Security Hub V2 (OCSF), they should use Security Hub automation rules (`list-automation-rules-v2`) and should NOT use Security Hub CSPM features for new rules, even though CSPM remains technically available.

## Service reference

Load service reference files on demand — only when the current turn requires context about service capabilities, API scope, or severity scoring.

| Reference                             | Content                                                                                        | When to Load                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `references/services-overview.md`     | Cross-service relationships, data formats, membership models, admin discovery, API conventions | Cross-service questions, general security posture, "which services should I enable" |
| `references/guardduty.md`             | GuardDuty APIs, severity scoring, service notes                                                | GuardDuty-specific questions about APIs or severity                                 |
| `references/inspector.md`             | Inspector APIs, severity scoring, service notes                                                | Inspector-specific questions about APIs or severity                                 |
| `references/security-hub.md`          | Security Hub V2 (OCSF) APIs, severity scoring, service notes                                   | Security Hub V2-specific questions about APIs or severity                           |
| `references/security-hub-cspm.md`     | Security Hub CSPM (V1/ASFF) APIs, severity scoring, service notes                              | CSPM-specific questions about APIs or severity                                      |
| `references/macie.md`                 | Macie APIs, severity scoring, service notes                                                    | Macie-specific questions about APIs or severity                                     |
| `references/detective.md`             | Detective APIs, severity scoring, service notes                                                | Detective-specific questions about APIs or severity                                 |
| `references/security-lake.md`         | Security Lake APIs, service notes                                                              | Security Lake-specific questions about APIs                                         |
| `references/organization-policies.md` | Organization policies discovery pattern, policy types, Organizations APIs                      | Questions about org-level policy enforcement across security services               |

## Security considerations

- **Logging and monitoring**: Verify CloudTrail is enabled for security service and Organizations API calls, CloudTrail log file validation is active, and CloudWatch metric filters or alarms exist for anomalous privileged read patterns such as unexpected volume, unusual principals, or unexpected regions.
- **Encryption and destinations**: Verify publishing or export destinations such as S3 buckets, SNS topics, and CloudWatch Logs use KMS encryption at rest and TLS in transit. For downstream S3 or SNS destinations, verify resource policies use `aws:SourceArn` and `aws:SourceAccount` condition keys where applicable.
- **Notification recipients**: Verify SNS topic subscriptions and other security alarm recipients are restricted to authorized security personnel, and periodically audit subscription endpoints.
- **Credential management**: Confirm CLI execution is using temporary credentials such as IAM roles or AWS SSO. Verify third-party integration credentials, API tokens, or connector secrets are stored in AWS Secrets Manager or AWS Systems Manager Parameter Store rather than plaintext configuration files or environment variables.
- **Security references**: Consult [AWS Security Hub best practices](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-v2-recommendations.html), [AWS CloudTrail security best practices](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html), [IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html), and the [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/) for current service guidance.
- **Sensitive data**: Security service outputs may contain sensitive information such as IP addresses, resource identifiers, account IDs, vulnerability details, exposure paths, and threat intelligence. Classification and handling requirements are customer-specific; do not store or share outputs in unprotected channels without verifying organizational data handling policies.
