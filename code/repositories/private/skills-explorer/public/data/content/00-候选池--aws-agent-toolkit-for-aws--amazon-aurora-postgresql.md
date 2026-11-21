---
name: amazon-aurora-postgresql
description: >-
  Amazon Aurora PostgreSQL — creates, modifies, and advises on Aurora PostgreSQL clusters
  specifically (PostgreSQL-compatible engine, Aurora serverless, express configuration,
  pgvector, Babelfish). Trigger for Aurora PostgreSQL cluster operations, express-configuration
  quick-start, ACU sizing, I/O-Optimized storage, commitment pricing, or PostgreSQL
  upgrade planning. For Aurora MySQL, use amazon-aurora-mysql instead. Contains safety
  guardrails, express-first routing, and response templates that override defaults.
version: 1
---

# Amazon Aurora PostgreSQL

A modular toolkit for **Aurora PostgreSQL** organized as a registry of sub-skills. Each sub-skill handles one domain of Aurora PostgreSQL work. The router matches user intent to the right sub-skill, then loads only the references needed. (For Aurora MySQL, use the `amazon-aurora-mysql` skill.)

## Operating procedure (follow in order)

1. **Route** — match the request to a sub-skill using the **Trigger phrases** column (match on meaning, not exact wording), then confirm with the **When to route here** column.
2. **Load** — `file_read` the matched sub-skill's `references/{id}-instructions.md` and announce the path. Do not answer a matched sub-skill from general knowledge alone.
3. **Analyze / advise** — perform the sub-skill's work; run a bundled script when the user supplies the inputs (see Scripts).
4. **If a mutation is requested** — classify against the Safety guardrails tier, confirm with the user, apply resource tags, then execute (MCP-preferred, CLI fallback).
5. **Present results** — tables with dollar/ACU figures and a recommendation label; no derivation or arithmetic steps.

Edge cases: if the request spans multiple sub-skills, run them in sequence (load each instructions.md in turn). If **no** sub-skill matches, answer directly from Aurora PostgreSQL knowledge. If a script or MCP/CLI call fails, show the error and suggest a fix before retrying. The numbered Global rules below are details that hang off these steps.

## Sub-skill registry

**Column semantics:** **Trigger phrases** = the keyword index you match the request against (step 1). **When to route here** = the decision logic confirming the match. **Next steps** = sub-skills to _offer the user as a natural follow-up_ after this one completes (not auto-chained); **Reached from** = sub-skills that typically route into this one. Next-steps/Reached-from are suggestions for guiding the user, never automatic execution.

| ID                    | Name                       | When to route here                                                                                                                                                                                                                                                                                                                                                                                                   | Trigger phrases                                                                                                                                                                                | Reached from                     | Next steps                                              |
| --------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| `create`              | Create Cluster             | Routes Aurora PostgreSQL cluster creation requests. Express configuration (single API call, no VPC) is the default — routes to `express-create`. Routes to full configuration when VPC, custom KMS, custom params, or a specific engine version is required.                                                                                                                                                         | create a cluster, new database, set up Aurora PostgreSQL, get started, need a PostgreSQL database, provision                                                                                   | —                                | `express-create`, `serverless-advisory`, `io-optimized` |
| `express-create`      | Express Configuration      | Provisions Aurora PostgreSQL serverless via the single-API-call express flow. AWS-managed connectivity (no customer VPC). **IAM-only authentication via Internet Access Gateway — no master password.** Post-creation connection is via IAM auth token (`aws rds generate-db-auth-token`). Use when no VPC, custom KMS, or custom parameter group is required. Routes back to `create` for full configuration needs. | express configuration, express create, internet access gateway, single API call, Aurora PostgreSQL serverless quick start, no VPC, IAM auth token, how to connect to express cluster           | `create`                         | —                                                       |
| `serverless-advisory` | Aurora serverless Advisory | All Aurora serverless questions: ACU sizing, scale-to-zero behavior and compatibility, provisioned→serverless migration, capacity planning, and feature constraints.                                                                                                                                                                                                                                                 | ACU sizing, Aurora serverless, scale-to-zero, provisioned to serverless, how many ACUs, capacity, auto-scaling, RDS Proxy compatibility, scale-to-zero incompatibility, serverless limitations | `create` (optional)              | `commitment-pricing`                                    |
| `io-optimized`        | I/O-Optimized Storage      | Evaluates whether to switch from Aurora Standard to I/O-Optimized (aurora-iopt1). Uses the 25% I/O cost threshold rule.                                                                                                                                                                                                                                                                                              | I/O-Optimized, aurora-iopt1, storage type switch, 25% threshold, I/O costs too high, storage comparison                                                                                        | —                                | —                                                       |
| `commitment-pricing`  | Commitment Pricing         | Compares Reserved Instances vs Database Savings Plans for provisioned clusters, and DSP-only for Aurora serverless. 1yr vs 3yr analysis.                                                                                                                                                                                                                                                                             | Reserved Instance, RI, Savings Plan, DSP, 1yr vs 3yr, commitment, cost optimization, overpaying                                                                                                | `serverless-advisory` (optional) | —                                                       |
| `upgrade-planning`    | Upgrade Planning           | Major and minor version upgrade planning for Aurora PostgreSQL. LTS version guidance, pre/post-upgrade checklists, blue/green deployment recommendations.                                                                                                                                                                                                                                                            | upgrade, version, LTS, pre-upgrade checklist, post-upgrade, major version, minor version, end of life, deprecation                                                                             | —                                | —                                                       |

## Express vs Full configuration — decision matrix

When routing a create request (sub-skill `create`), pick the path with this matrix. **Express is the default** for Aurora PostgreSQL; route to Full configuration only if ANY "Full" trigger is present. Don't present the choice to the user — decide, then state which path and why.

| Requirement / signal                                   | Express    | Full config                                    |
| ------------------------------------------------------ | ---------- | ---------------------------------------------- |
| Default PostgreSQL create, no special networking       | ✅ default | —                                              |
| Quick start / "no VPC setup" / "ready in seconds"      | ✅         | —                                              |
| Customer VPC, subnet group, or specific security group | —          | ✅ required                                    |
| Customer-managed KMS key (CMK)                         | —          | ✅ required                                    |
| Custom DB cluster parameter group **at creation**      | —          | ✅ required                                    |
| Specific engine version pinned by the user             | —          | ✅ required (intent to pin = not express)      |
| Aurora MySQL                                           | n/a        | use `amazon-aurora-mysql` (express is PG-only) |

Notes: any single Full trigger disqualifies express — name every trigger you matched in the routing statement. Express clusters are still customizable _after_ creation (e.g. a custom parameter group can be applied post-create), so a future need isn't itself a reason to start with Full. Full depth on the flow lives in `references/express-create-instructions.md` and `references/create-instructions.md` — load those for the actual steps.

## Global rules (apply to every sub-skill)

1. **Execute, don't just suggest.** When the user requests an action and confirms, EXECUTE it rather than handing back a command to run. The AWS MCP server is the recommended execution path when available (sandboxed, IAM-authenticated, audit-logged) — prefer it. When MCP tools are not available (e.g. Claude Code, Cursor, or other non-MCP hosts), use the AWS CLI / SDK directly with the same `aws rds ...` operation. Only if execution is genuinely not possible in the current environment, present the complete CLI command for the user to run.

2. **Confirmation before mutation.** MUST confirm with the user before any create or modify operation. Do NOT execute without explicit confirmation ("yes", "proceed", "confirmed", "go ahead").

3. **Resource tagging (always apply on resource creation).** When creating any cluster or instance, ALWAYS include these tags:
   `--tags Key=created_by,Value=aurora-skill Key=generation_model,Value={your-model-id}`
   Use your model id if known; if you cannot reliably determine it, use `Value=unknown` — never let tagging block the create. Include these tags even if the user does not mention tagging. If the user provides additional tags, append these to their tags.

4. **Safety guardrails.**

   **Tier 1 — Confirm (a yes/no confirmation is enough; no risk briefing required):**
   - `create-db-cluster`, `create-db-cluster --with-express-configuration`
   - `create-db-instance`
   - `modify-db-cluster --serverless-v2-scaling-configuration` (ACU scaling)
   - `modify-db-cluster --backup-retention-period`
   - `modify-db-cluster --deletion-protection` / `--no-deletion-protection`
   - `modify-db-cluster --enable-cloudwatch-logs-exports`
   - `modify-db-cluster --preferred-backup-window`
   - `modify-db-cluster --enable-http-endpoint` (Data API)
   - `add-tags-to-resource`, `remove-tags-from-resource`

   **Tier 2 — High-impact: state the specific risk, THEN confirm (spell out the impact before asking; do not call any API until the user confirms with that risk in front of them):**
   - `modify-db-cluster --storage-type` — no downtime for most instance classes; requires restart for NVMe/Optimized Reads instances (r6gd, r6id, r8gd). Switching from Aurora Standard to Aurora I/O-Optimized is limited to once every 30 days; switching from Aurora I/O-Optimized back to Aurora Standard can be done at any time.
   - `modify-db-instance --db-instance-class` — causes failover in multi-AZ
   - `modify-db-cluster --engine-version` for a **minor** version upgrade — applied in the maintenance window (or immediately with `--apply-immediately`); brief failover/restart. State the target version and the restart impact, then confirm. (For a **major** version upgrade, see Block below — route to `upgrade-planning` first.)
   - Any modify with `--apply-immediately` — bypasses maintenance window

   **Tier 3 — Block (refuse, explain why, redirect to console/change-control):**
   - `delete-db-cluster`, `delete-db-instance` — irreversible
   - `failover-db-cluster`, `switchover-blue-green-deployment` — production impact
   - `modify-db-cluster --engine-version` across major versions — requires prechecks and rollback plan
   - `modify-db-cluster --master-user-password`, `--manage-master-user-password` — credential management must be performed by the customer directly. **Express clusters use IAM-only auth via the Internet Access Gateway and have no master password — these flags do not apply on express clusters and must NOT be used as a workaround for connection issues.** For full-config clusters, use AWS Secrets Manager rotation or the AWS Console.
   - `modify-db-cluster --vpc-security-group-ids` — network security posture change
   - `modify-db-cluster --db-cluster-parameter-group-name` — can break applications
   - `create-db-instance --publicly-accessible`, `modify-db-instance --publicly-accessible` — NEVER make Aurora instances publicly accessible. This exposes the database directly to the internet and is never the correct solution for connectivity. See secure connection alternatives below.
   - `purchase-reserved-db-instances-offering`, `create-savings-plan` — financial commitment
   - `reboot-db-instance`, `reboot-db-cluster` — production impact

   When blocking, you MUST refuse immediately. Do NOT call any AWS API. Your response MUST have exactly two paragraphs:

   Paragraph 1 — refuse: "I can't perform [action] because [reason]. This should go through your team's change-control process or the AWS Console."

   Paragraph 2 — alternative (from the table below, always included):
   - `purchase-reserved-db-instances-offering`, `create-savings-plan` → "I can run a commitment pricing assessment (RI vs DSP comparison) so you have the numbers to bring to procurement."
   - `delete-db-cluster`, `delete-db-instance` → "I can help with snapshot creation or final-snapshot validation before deletion."
   - `modify-db-cluster --engine-version` (major version) → "I can run an upgrade assessment — target version recommendation, prechecks, and pre/post checklists."
   - `failover-db-cluster`, `switchover-blue-green-deployment` → "I can validate the cluster's state and review the failover/switchover plan with you."
   - `reboot-db-instance`, `reboot-db-cluster` → "I can check for pending modifications and recommend a maintenance window."
   - `modify-db-cluster --master-user-password` / `--manage-master-user-password` → "If this is an express cluster, there's no master password — express uses IAM-only auth via the Internet Access Gateway. I can walk you through generating an IAM auth token to connect. If this is a full-config cluster, rotate the password via AWS Secrets Manager or the AWS Console; both are safer than a direct API call."
   - `--publicly-accessible` → "Making the instance publicly accessible exposes the database directly to the internet — this is a security anti-pattern even for prototypes. Instead: (1) Use express configuration — internet-accessible via IAM auth with no VPC; (2) Enable RDS Data API — query over HTTPS with IAM auth; (3) EC2 bastion with SSH tunnel. I can help you set up any of these."
   - `modify-db-cluster --vpc-security-group-ids` → "I can describe the cluster's current security-group configuration and help you draft the intended change so you can apply it through your team's change-control process or the AWS Console."
   - `modify-db-cluster --db-cluster-parameter-group-name` → "I can review the current parameter group and compare it against the target group (highlighting reboot-required parameters) so you can prepare the change for your team's change-control process or the AWS Console."

   Never omit paragraph 2. A refusal without an alternative is incomplete.

5. **Reference loading.** Before responding to any matched sub-skill request, you MUST read `references/{id}-instructions.md` using your file-read tool (`file_read` if available, otherwise whatever your runtime exposes). Do not answer a matched sub-skill from the registry summary alone. Announce the path in your reply.

6. **Express is a single CLI call.** When using express configuration: `create-db-cluster --with-express-configuration`. Do NOT separately specify `--engine-mode`, `--serverless-v2-scaling-configuration`, `--master-username`, or `--manage-master-user-password`. The express flag sets all of these automatically.

7. **Stay in scope.** Once this skill is active, recommend the best Aurora configuration for the workload. Do not suggest non-AWS alternatives. For light workloads, recommend express with scale-to-zero.

8. **Never fabricate.** Do NOT invent AWS API results, pricing numbers, version lists, or instance metadata. If a live call fails, report the blocker and offer offline mode with user-supplied numbers.

9. **Carry context forward.** Pass along cluster ID, region, and workload details the user already supplied. They SHOULD NOT have to re-type information already in the conversation.

10. **Broad requests.** If the user says "help me with Aurora" or "analyze my cluster" without specifying a domain (create, sizing, I/O, commitment, upgrade), present the sub-skill domains as one line each and ask which they want to focus on. Do NOT silently pick a sub-skill and run it. Acknowledge any cluster ID and region so the user doesn't need to repeat them.

11. **Out-of-scope topics.** If the user asks about an Aurora feature not covered by a sub-skill (e.g., Global Database, Blue/Green Deployments, RDS Proxy), note that it is not covered by a specific sub-skill, answer from general Aurora knowledge, and link to the relevant AWS documentation page.

12. **Credential safety.** Do not create, store, or display long-lived credentials or DB passwords. However, `aws rds generate-db-auth-token` is approved — it produces a short-lived (15-minute) IAM token. This is the required connection method for express clusters. For non-express clusters, use user-supplied secret ARNs or pre-configured tunnels.

13. **Present results clearly.** Use tables with dollar figures, ACU numbers, and recommendation labels. Do NOT show derivation or arithmetic steps. Exception: when consolidating across multiple analyses ("summarize", "what should I do"), respond in 2-4 lines of plain prose — no headers, no bullets, no tables.

## Scripts

Bundled scripts in `scripts/` for offline analysis. MUST use these when the user provides the required inputs — do NOT hand-calculate. Each script documents its full flags/usage in its own `--help` and header docstring; read those on demand rather than relying only on the one-line usage below.

**Script execution model:** If a shell is available, execute the script directly and present the output. If no shell is available, print the exact command as a fenced bash code block with all flags resolved to user-supplied values, then present results computed inline from the reference file's pricing tables. (Result-presentation format is governed by the Operating procedure / Global rules — no derivation steps.)

| Script                           | Purpose                      | Usage                                                                                                                                                                                |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acu_calculator.py`              | Aurora serverless ACU sizing | `python3 scripts/acu_calculator.py estimate --instance <type> --cpu-p95 <val> --cpu-max <val> --storage <val>`                                                                       |
| `io_optimized_analyzer.py`       | I/O-Optimized breakeven      | `python3 scripts/io_optimized_analyzer.py offline --instance <type> --num-instances <n> --storage-gib <val> --monthly-io-millions <val>`                                             |
| `commitment_pricing_analyzer.py` | RI vs DSP cost comparison    | `python3 scripts/commitment_pricing_analyzer.py offline --instance <type> --num-instances <n> --region <region>` (provisioned) or `--serverless --avg-acu <val>` (Aurora serverless) |

## Troubleshooting

- **AccessDenied**: Attach `AmazonRDSReadOnlyAccess` + `CloudWatchReadOnlyAccess` for reads. For creates/modifies, use a custom policy scoped to `rds:CreateDBCluster`, `rds:CreateDBInstance`, `rds:ModifyDBCluster`, `rds:ModifyDBInstance`, `rds:AddTagsToResource`, and `rds:Describe*`. See [Identity and access management for Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAM.html).
- **ExpiredToken / credentials**: Refresh your AWS credentials using whatever mechanism you use (e.g. re-run your SSO/`aws sso login`, `ada credentials update`, assume-role, or refresh the profile), then retry. Do not assume a specific credential tool.
- **DBClusterNotFoundFault**: Verify region and cluster ID.
- **Throttling**: Retry once, then narrow scope.

## Additional Resources

- [Aurora User Guide](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/)
- [Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/)
- [Aurora serverless](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html)
- [Aurora PostgreSQL upgrades](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_UpgradeDBInstance.PostgreSQL.html)

## Handoff from aws-database-selection

This skill can be entered from `aws-database-selection` after it produces a `requirements.json`. When you see a path matching `aws_dbs_requirements/*/requirements.json` in conversation:

1. Read the artifact. Sanity-check it has the fields you'll use — at minimum `engine` (or workload type), `region`, and the workload signals you route on (capacity/ACU hints, storage size, connectivity/VPC needs, version). If those are present and parseable, use them; if it's missing them or won't parse, proceed without it (don't block on a formal schema).
2. Acknowledge relevant facts in 1-2 bold sentences.
3. Scope-check: if the artifact doesn't match Aurora (e.g., key-access → DynamoDB, graph → Neptune, multi-region strong SQL → DSQL), suggest the right skill and ask whether to proceed anyway.
4. Continue with this skill's sub-skill routing.
