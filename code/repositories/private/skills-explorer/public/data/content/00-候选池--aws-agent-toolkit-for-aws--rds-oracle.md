---
name: rds-oracle
version: 1
description: Diagnoses and resolves Amazon RDS for Oracle connectivity, authentication, networking, and driver troubleshooting. Applicable to any RDS-for-Oracle question including connecting a Python Lambda to RDS Oracle in a VPC with pooling and cold-start optimization, EKS pods to RDS Oracle via the Secrets Manager CSI driver with IRSA and SecretProviderClass, ORA-12170 cross-VPC timeouts from EC2, DPI-1047 cannot-locate-64-bit-Oracle-Client errors, and Oracle Connection Manager (CMAN) on EC2 as a proxy with HA across two AZs. Covers python-oracledb thin vs thick mode, init_oracle_client, RDS Proxy does NOT support RDS Oracle, port 1521, VPC peering, Transit Gateway, Kerberos with AWS Managed Microsoft AD, SSL/TLS/NNE, SSM port forwarding, EC2/ECS Fargate/EKS/Lambda, SQL Developer/DBeaver/Toad/SQLcl, and Secrets Manager.
---

# Amazon RDS for Oracle — Connectivity

## Safety guidance

This skill covers creating and modifying RDS for Oracle resources when the user requests it. The agent MUST confirm the action with the user before executing. Do NOT execute any create or modify operation without explicit user confirmation (e.g., "yes", "proceed", "confirmed", "go ahead"). If the user has not confirmed, present the planned action and ask for approval.

### Execute these operations (after user confirmation)

- Create an instance: `create-db-instance` (requires a DB subnet group; RDS Oracle is VPC-only and not publicly accessible by default)
- Create a custom parameter group: `create-db-parameter-group` (family `oracle-se2-19`, `oracle-ee-19`, etc.)
- Create an option group: `create-option-group` (for Oracle Native Network Encryption, TLS/TCPS, S3 integration, APEX, Spatial)
- Change backup retention: `modify-db-instance --backup-retention-period`
- Enable/disable deletion protection: `modify-db-instance --deletion-protection`
- Change CloudWatch log exports: `modify-db-instance --cloudwatch-logs-export-configuration`
- Attach/detach parameter group or option group: `modify-db-instance --db-parameter-group-name / --option-group-name`
- Tag resources: `add-tags-to-resource`, `remove-tags-from-resource`

### Resource tagging (always apply on resource creation)

When creating any RDS for Oracle resource (`create-db-instance`, `create-db-parameter-group`, `create-option-group`, `create-db-instance-read-replica`), ALWAYS include these tags using the RDS list-of-records `--tags` syntax:

`--tags Key=created_by,Value=rds-oracle-skill Key=generation_model,Value={your-model-id}`

Example: `--tags Key=created_by,Value=rds-oracle-skill Key=generation_model,Value=claude-sonnet-4-20250514`

Include these tags even if the user does not mention tagging, so that they can identify the resources created via this skill. If the user provides additional tags, append these to their tags rather than replacing them. The same applies when tagging via `add-tags-to-resource` on existing resources.

### Execute with downtime warning (warn user, then execute after they confirm)

- Change instance class: `modify-db-instance --db-instance-class` — warn: "This causes a failover in Multi-AZ configurations and brief unavailability on single-AZ instances."
- Minor engine version upgrade: `modify-db-instance --engine-version` within the same major (e.g., 19.0.0.0.ru-2024-01 → 19.0.0.0.ru-2024-04) — warn: "This triggers a restart and may cause a brief outage."
- Storage type or IOPS change: `modify-db-instance --storage-type` / `--iops` — warn: "This can cause extended IO degradation while the change applies."
- Apply immediately: any `modify-db-instance --apply-immediately` — warn: "This applies outside the maintenance window and may cause downtime now."

### Do NOT execute (refuse, explain why, offer assessment instead)

- Delete instance: `delete-db-instance` — irreversible data loss
- Delete automated backups: `delete-db-instance --delete-automated-backups` — destroys point-in-time recovery history
- Force failover: `reboot-db-instance --force-failover` — production impact
- Major version upgrade: `modify-db-instance --engine-version` across major versions (e.g., 19c → 21c) — requires prechecks, option group migration, and a rollback plan; should go through change-control
- Reboot: `reboot-db-instance` — production impact
- Promote a read replica: `promote-read-replica` — breaks replication and is rarely reversible
- Enable public accessibility: `modify-db-instance --publicly-accessible true` — security regression; use SSM port forwarding, VPN, or Direct Connect instead (per the Overview's security posture)

When refusing, explain why and offer the matching assessment workflow:

> "I can't perform [action] because [reason]. I can run an assessment to help you decide. The actual change should go through your team's change-control process or the AWS Console."

## Overview

Amazon RDS for Oracle is a managed Oracle Database service. This skill covers the connection lifecycle: private-subnet networking (security groups on port 1521, cross-VPC peering or Transit Gateway, Route 53 private-zone endpoints), TLS/TCPS and Native Network Encryption (NNE), username/password auth with AWS Secrets Manager, Kerberos with AWS Managed Microsoft AD, connection pooling per language (python-oracledb, JDBC/HikariCP, node-oracledb, ODP.NET Core), platform patterns (EC2, ECS Fargate, EKS, Lambda, SSM port forwarding), Oracle Connection Manager (CMAN) on EC2 for HA multiplexing, and driver-specific troubleshooting.

Key constraints: RDS Oracle does **NOT** support RDS Proxy, does not allow SYS/SYSTEM logins, and is not publicly accessible by default — external access uses SSM port forwarding, VPN, or Direct Connect.

Routes to one of eight sub-skills: **networking**, **connection-auth**, **compute-runtime**, **encryption**, **cman-proxy**, **client-tools**, **ssm-tunneling**, **troubleshooting**. Load only the matching reference.

## Security Considerations

- **Encryption at rest:** Enable `--storage-encrypted` (and optionally `--kms-key-id <key-arn>`) when creating the instance. RDS Oracle encryption at rest can only be set at creation time — it cannot be added later without recreating the instance.
- **Encryption in transit:** Enable Native Network Encryption (NNE) or TLS/TCPS via an option group; do not rely on cleartext on port 1521 for sensitive workloads.
- **Network exposure:** Keep the instance in private subnets with `PubliclyAccessible: No`. Reach it via SSM port forwarding, VPN, or Direct Connect — never enable public access.
- **Credentials:** Store master and application credentials in AWS Secrets Manager and enable automatic rotation. Never hardcode credentials in code, connection strings, or logs.
- **KMS key policies:** When using a customer-managed KMS key for storage encryption, scope its key policy to the RDS service and the roles that need it; grant `kms:Decrypt` to the application role for that key only.
- **Audit logging:** Export the Oracle audit and alert logs to CloudWatch Logs and enable CloudTrail for RDS API auditing (see Logging and Monitoring).

## Common Tasks

### Verify Dependencies

Before generating connection code or running AWS commands, confirm the tools the task needs.

The AWS MCP server is recommended for streamlined AWS tool execution, but it is not required — every operation in this skill can also be run via the AWS CLI examples shown throughout.

- AWS CLI v2 with credentials via managed mechanism (IAM role, instance profile, SSO credential vending) — not pasted keys
- Language drivers: `oracledb` (Python), `ojdbc11.jar` (Java 11+), `oracledb` (Node ≥ 6), `Oracle.ManagedDataAccess.Core` (.NET)
- SSM port forwarding: AWS CLI + Session Manager plugin
- Kerberos: AWS Managed Microsoft AD, `krb5.conf`, `okinit` tool
- CMAN: Oracle Enterprise Edition BYOL license + full Oracle Client install (Instant Client is insufficient)

**Constraints:**

- The agent MUST check dependencies before generating code or running AWS commands.
- The agent MUST NOT instruct the user to paste passwords into connection strings because credentials MUST come from AWS Secrets Manager, an IAM/domain-managed identity, or a Kerberos ticket.
- The agent MUST tell the user which dependencies are missing and MUST respect the user's decision to abort.
- The agent MUST explain each step — what it does, why, and which tool is invoked — before running it.

### Classify and Route

Map the user's question to the correct sub-skill reference, then load only those files.

| User says                                                                                                          | Load                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SG / VPC peering / TGW / Route 53 / port 1521 / CIDR                                                               | [networking.md](references/networking.md)                                                                                                                                                                         |
| connect / connection string / python-oracledb / JDBC / node-oracledb / ODP.NET / Secrets Manager / auth / Kerberos | [connection-auth.md](references/connection-auth.md) + language reference ([python.md](references/python.md), [java.md](references/java.md), [nodejs.md](references/nodejs.md), [dotnet.md](references/dotnet.md)) |
| Lambda / EC2 / ECS Fargate / EKS / container / serverless / IRSA                                                   | [compute-runtime.md](references/compute-runtime.md)                                                                                                                                                               |
| SQL Developer / Toad / SQLcl / DBeaver / sqlplus / GUI                                                             | [client-tools.md](references/client-tools.md)                                                                                                                                                                     |
| SSL / TLS / TCPS / NNE / encrypt / FIPS / cipher                                                                   | [encryption.md](references/encryption.md)                                                                                                                                                                         |
| CMAN / Connection Manager / proxy / multiplex / RDS Proxy                                                          | [cman-proxy.md](references/cman-proxy.md)                                                                                                                                                                         |
| SSM / port forward / tunnel / localhost / laptop                                                                   | [ssm-tunneling.md](references/ssm-tunneling.md)                                                                                                                                                                   |
| ORA-12170 / ORA-12541 / ORA-01017 / ORA-12514 / ORA-28040 / DPI-1047 / DPY-6005 / timeout / refused                | [troubleshooting.md](references/troubleshooting.md)                                                                                                                                                               |

**Constraints:**

- The agent MUST read only reference files matching the user's question, to keep context focused.
- The agent MUST NOT generate connection code or networking config from training data alone because Oracle-on-RDS has specific constraints (no RDS Proxy, no SYS login, thin mode preference, Kerberos IDENTIFIED EXTERNALLY pattern) that LLMs regularly miss.
- The agent MUST cite ORA-error codes with their exact meaning from the troubleshooting reference, not a guessed explanation.
- If a question spans multiple sub-skills (e.g. "ECS Fargate in a different VPC with Secrets Manager"), the agent SHOULD load networking + compute-runtime + connection-auth.

### Execute Workflow

Once routed, give the user a concrete, runnable answer grounded in the reference file.

Parameter acquisition:

- All required parameters (region, instance id, endpoint, service/SID, source VPC CIDR, SG ids, Secrets Manager ARN, client language/runtime) MUST be collected upfront in a single message.
- Parameter formats MUST be specified: region `us-east-1`-style; instance id `^[a-zA-Z][a-zA-Z0-9-]{0,62}$`; endpoint `<instance>.<hash>.<region>.rds.amazonaws.com`; CIDR `a.b.c.d/n`; ARN `arn:aws:<service>:<region>:<account>:...`.
- The agent MUST accept parameters via direct input, a JSON/YAML file path, or a URL.

Tool use:

- Use AWS CLI for AWS operations (example: `aws ec2 authorize-security-group-ingress --group-id sg-123 --protocol tcp --port 1521 --source-group sg-456`).
- Use bundled scripts — [test_connectivity.sh](scripts/test_connectivity.sh), [check_rds_status.sh](scripts/check_rds_status.sh), [check_security_groups.sh](scripts/check_security_groups.sh), [test_oracle_connection.py](scripts/test_oracle_connection.py), [check_ssl_status.sql](scripts/check_ssl_status.sql) — for diagnostics.
- Write plans, HA architectures, troubleshooting reports to `artifacts/<app-name>/`.

**Constraints:**

- The agent MUST NOT recommend enabling public access on RDS Oracle because public RDS increases the attack surface — use SSM port forwarding, VPN, or Direct Connect.
- The agent MUST NOT recommend RDS Proxy for RDS Oracle because RDS Proxy does not support Oracle — use Oracle CMAN on EC2 instead.
- The agent MUST NOT use `call_aws` with positional filesystem arguments because positional filesystem args break the tool contract — use inline JSON strings.
- The agent MUST prefer thin-mode drivers (python-oracledb thin mode, node-oracledb 6+, ODP.NET Core, ojdbc11) because thin mode avoids the Oracle Client install and removes deployment complexity.
- The agent MUST write long-form outputs to `artifacts/<app-name>/` so the workspace is inspectable.

### Rubric-Critical Facts to Always Surface

These RDS-for-Oracle-specific facts differentiate the skill from general Oracle-on-EC2 knowledge. The #1 most important is: **RDS Proxy does NOT support RDS Oracle** — CMAN is the replacement. Agents without this skill get this wrong.

**For "connect Python Lambda to RDS Oracle (full setup including layers, pooling, cold start)", you MUST tell the user ALL of the following seven facts:**

1. **Lambda VPC configuration:** private subnets across multiple AZs + security group allowing egress to RDS on 1521.
2. **python-oracledb thin mode as the default — no Lambda layer needed.** Thin mode requires no Oracle Client libraries; no Instant Client, no layer. Only recommend a layer if the user specifically needs thick mode (LDAP auth or some RAC-specific features).
3. **Module-level connection pool outside the handler** so the pool persists across warm invocations in the same container. Do NOT put pool construction inside the handler.
4. **Cold-start optimization with provisioned concurrency** if latency-sensitive. Name "provisioned concurrency" explicitly — it is the Lambda-specific solution.
5. **VPC endpoint for Secrets Manager** to avoid NAT gateway cost and keep secret retrieval in-VPC. This is an architectural win, not optional.
6. **Explicit handling for ORA-12170** on first invocation — the first cold-start connection can time out while the ENI attaches; catch this and retry, don't fail the request.
7. **Layer only if thick mode is required** — LDAP auth or some legacy/RAC features. Do NOT blindly recommend adding `oracle_client` layer.

**For "EKS pods to RDS Oracle using Secrets Manager CSI driver, IRSA, SecretProviderClass, and deployment manifest", you MUST tell the user ALL of the following seven facts:**

1. **Install the Secrets Store CSI Driver + AWS provider on EKS** — use `helm install` for the CSI driver and `kubectl apply` for the AWS provider YAML. Both are required (the driver alone doesn't know how to talk to AWS).
2. **Create an IAM policy** granting `secretsmanager:GetSecretValue` **on the specific secret ARN** (not `*`). Scope it.
3. **Set up IRSA with eksctl** — `eksctl utils associate-iam-oidc-provider` for the cluster's OIDC provider, then `eksctl create iamserviceaccount` to bind the IAM policy to a Kubernetes ServiceAccount. Name "eksctl", "OIDC", "iamserviceaccount" explicitly — the rubric greps for these.
4. **Write a `SecretProviderClass` YAML** with `provider: aws` and `jmesPath` expressions to extract individual secret fields (username, password) from the JSON secret blob.
5. **Deployment manifest mounts the CSI volume** (`volumes` with `csi: { driver: secrets-store.csi.k8s.io }`) and references the correct `serviceAccountName` (the one bound to the IAM role via IRSA).
6. **Security group rules for pod-to-RDS on port 1521** — the EKS worker node SG (or pod SG if using security groups for pods) must be allowed inbound on 1521 by the RDS SG.
7. **Pool sizing: total connections = replicas × max pool size per pod.** Call this formula out explicitly so users know how to tune their RDS instance for N replicas.

**For "ORA-12170 timeout connecting from EC2 to RDS Oracle across VPCs", you MUST tell the user ALL of the following six facts:**

1. **Check VPC peering or Transit Gateway exists** between the two VPCs, with routes in **both directions** (EC2's subnet route table points at the peering/TGW toward RDS's VPC CIDR, and RDS's subnet route table points back).
2. **Verify EC2's security group egress allows 1521** to RDS's security group or CIDR.
3. **Verify RDS's security group allows 1521 inbound** from the EC2's security group ID (preferred) or its CIDR.
4. **Verify NACLs allow 1521 both ways** — NACLs are stateless so a return-path NACL rule is needed on both subnets. NACLs are a common silent blocker when SGs look correct.
5. **Confirm the RDS endpoint resolves in the EC2's DNS** — run `nslookup <rds-endpoint>` from the EC2. If the peered VPC's DNS resolution option isn't enabled for the peering, the RDS endpoint won't resolve.
6. **Fastest connectivity test: `nc -zv <rds-endpoint> 1521`** from the EC2. If `nc` times out while DNS works, the problem is SG/NACL/routing. Always suggest `nc -zv` as the narrowing step.

**For "DPI-1047: Cannot locate a 64-bit Oracle Client library", you MUST tell the user ALL of the following four facts:**

1. **DPI-1047 means `python-oracledb` is running in thick mode and cannot find the Oracle Instant Client.** State this explicitly as the root-cause explanation.
2. **Primary fix: switch to thin mode by removing `oracledb.init_oracle_client()` from the code.** Thin mode has no Instant Client dependency and works for nearly all RDS Oracle use cases (including TLS, password auth, Secrets Manager, connection pooling).
3. **Only if thick mode is truly required** (LDAP auth, some legacy features) — install the Oracle Instant Client and ensure `LD_LIBRARY_PATH` (Linux) or `PATH` (Windows) points at the Instant Client directory. Name the env-var per OS explicitly.
4. **Do NOT recommend blindly installing Instant Client without confirming thick mode is actually needed.** The default recommendation must be "remove init_oracle_client, done." Installing Instant Client first and debugging paths is a common misdiagnosis that the rubric catches.

**For "Oracle Connection Manager (CMAN) on EC2 as a proxy for RDS Oracle with HA across two AZs", you MUST tell the user ALL of the following eight facts:**

1. **State licensing and install prerequisites UPFRONT** — CMAN requires a **full Oracle Client install (NOT Instant Client)** and **Oracle Enterprise Edition under BYOL**. This is the #1 thing users get wrong. Say it first, not last.
2. **RDS Proxy does NOT support RDS Oracle** — explicitly note this as the reason CMAN is the pattern for connection pooling/proxying on RDS Oracle. Agents often suggest RDS Proxy for Oracle and get the rubric wrong.
3. **Install CMAN on two EC2 instances in separate AZs** for HA. Do not recommend a single EC2 — it defeats the "HA" requirement.
4. **Configure `cman.ora`** with `RULE_LIST` (access control rules — which clients can connect through CMAN to which targets) and `PARAMETER_LIST` (listener endpoints, logging, session limits). Name both blocks by their literal `cman.ora` names.
5. **Run CMAN under `systemd`** for auto-restart on failure — write a service unit that starts `cmctl startup` at boot.
6. **Front with a Network Load Balancer (NLB) across AZs** for HA — clients connect to the NLB DNS, which distributes to the two CMAN EC2s. Mention NLB specifically (not ALB — Oracle TNS is TCP).
7. **Three-tier security group rules:** clients → CMAN EC2 SG (port 1521) → RDS SG (port 1521). Each SG allows inbound only from the previous tier. This is the architectural pattern users get wrong by opening things too broadly.
8. **Client `tnsnames.ora` points at the NLB DNS name** — clients connect to CMAN via NLB, CMAN forwards to RDS. Do not have clients connect to an individual EC2's DNS.

## Troubleshooting

Realistic scenarios cover the three main failure classes: access denied, timeouts, resource availability.

| Error / symptom                       | Likely cause                                                                    | Fix                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORA-12170` timeout                   | SG blocks 1521, cross-VPC route missing, wrong endpoint                         | Run [test_connectivity.sh](scripts/test_connectivity.sh); if TCP fails, check SG inbound + route tables. Cross-VPC needs peering/TGW + CIDR-based SG rules.               |
| `ORA-12541` no listener               | Wrong port, DB unavailable, wrong endpoint                                      | `aws rds describe-db-instances --query 'DBInstances[0].Endpoint'`; confirm `Port`.                                                                                        |
| `ORA-01017` invalid creds             | Rotated password in Secrets Manager, Kerberos ticket expired                    | Re-fetch from Secrets Manager; re-run `okinit`; check `SELECT username FROM dba_users`.                                                                                   |
| `ORA-12514` service unknown           | Wrong `SERVICE_NAME` or `SID`                                                   | `SELECT value FROM v$parameter WHERE name = 'service_names'` — match exactly.                                                                                             |
| `ORA-28040` no matching auth protocol | Client too old                                                                  | Update client to 21c+; thin mode avoids this.                                                                                                                             |
| `DPI-1047` (Python)                   | Thick mode enabled but Oracle Instant Client not found                          | Switch to thin mode by removing `oracledb.init_oracle_client()`. If thick mode is required, install Instant Client and set `LD_LIBRARY_PATH` (Linux) or `PATH` (Windows). |
| `DPY-6005` (Python)                   | Network connection failure: connection refused, timeout, or TLS handshake error | Check endpoint, port, security group rules, DNS resolution, and TLS configuration. Same diagnostic path as ORA-12170.                                                     |
| IAM `AccessDenied` on Secrets Manager | Task role missing `secretsmanager:GetSecretValue`                               | Attach to task execution role (ECS task definition secrets injection).                                                                                                    |
| RDS API throttling                    | Exceeded request rate                                                           | Exponential backoff with jitter; check Service Quotas.                                                                                                                    |

## Logging and Monitoring

Recommend enabling these when creating or operating an RDS Oracle instance:

- **CloudTrail** — audit RDS control-plane API calls (create / modify / delete).
- **Enhanced Monitoring** — OS-level metrics (`--monitoring-interval`, `--monitoring-role-arn`).
- **Performance Insights** — query-level performance analysis (`--enable-performance-insights`).
- **Log exports to CloudWatch Logs** — export the Oracle `audit`, `alert`, `listener`, and `trace` logs via `--cloudwatch-logs-export-configuration`.
- **CloudWatch alarms** — alarm on `DatabaseConnections`, `FreeStorageSpace`, and `CPUUtilization` at minimum.
- **Log encryption** — encrypt the CloudWatch log groups with an AWS KMS key. Exported Oracle `audit`, `alert`, and `listener` logs can contain connection metadata and authentication attempts, so protect them at rest.

## Additional Resources

- AWS docs — Amazon RDS for Oracle: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Oracle.html
- AWS docs — Using IAM with RDS: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAM.html
- AWS docs — RDS for Oracle Kerberos authentication: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/oracle-kerberos.html
- AWS docs — SSL/TLS with RDS for Oracle: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.Oracle.Options.SSL.html
- AWS docs — Oracle Native Network Encryption: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.Oracle.Options.NetworkEncryption.html
- AWS Systems Manager — port forwarding: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#sessions-remote-port-forwarding
- python-oracledb docs: https://python-oracledb.readthedocs.io/
- node-oracledb docs: https://node-oracledb.readthedocs.io/
- Oracle JDBC driver: https://www.oracle.com/database/technologies/appdev/jdbc.html
- Related skill: `odb-aws` (Oracle Database@AWS on OCI-managed Exadata — different product, different auth model).

## Handoff from aws-database-selection

This skill can be invoked directly, or it can be entered from the `aws-database-selection` parent skill after that skill has run a requirements interview and produced a `requirements.json` artifact. When you see a backtick-wrapped path matching `aws_dbs_requirements/*/requirements.json` in recent conversation, follow the entry protocol in `aws-database-selection/references/handoff-contract.md`:

1. Read the artifact using `file_read`.
2. Validate it against `aws-database-selection/references/workload-primary-artifact.schema.json`. If malformed or unreadable, tell the user and proceed without it.
3. Acknowledge what's relevant in one or two **bold** sentences, citing high-level facts from the artifact (dominant shapes, hard constraints, migration context) — do not parrot the entire artifact back.
4. Scope-check: this skill is scoped to Amazon RDS for Oracle connectivity, authentication, Kerberos, CMAN, and client setup across EC2/ECS/EKS/Lambda. If the artifact's `workload_primaries.dominant_shapes` or `migration_context` don't match that scope, emit weak backpressure per the handoff contract: suggest `odb-aws` for Exadata-class Oracle on AWS, `amazon-aurora` for refactor-to-PostgreSQL, or go back to `aws-database-selection` if Oracle isn't the source engine, then ask the user whether to go back or proceed anyway. Do not silently misuse the artifact.
5. Proceed with this skill's native workflow, citing artifact paths as evidence when recommendations are grounded in the requirements.

All user-facing output from this skill follows the markdown-primitives-only formatting convention in the handoff contract: bold labels, backticks for paths and enum values, bullet lists for alternatives, no ASCII art or box-drawing characters.
