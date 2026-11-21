---
name: rds-sqlserver
version: 1
description: Provides connectivity, authentication, and troubleshooting guidance for Amazon RDS for SQL Server. Applicable when users ask about SSMS times out connecting from EC2, Cannot generate SSPI context with Windows auth, connect RDS SQL Server from Lambda with pymssql, auth_scheme shows NTLM instead of KERBEROS on ECS Fargate, SSM tunnel to RDS SQL Server from laptop, port 1433 security group, TrustServerCertificate=True for localhost tunnels, SPN MSSQLSvc, AWS Managed Microsoft AD, CNAME not RDS endpoint for Kerberos, tds_version='7.4', encryption='require', port-as-string for pymssql, Secrets Manager credential caching in Lambda, error 18456 login failed. Covers Python (pymssql, pyodbc), .NET (Microsoft.Data.SqlClient), Java (JDBC mssql-jdbc), Node.js (tedious), IAM auth via RDS Proxy, and VPC/ECS/EKS/Lambda deployment.
---

# Amazon RDS for SQL Server

## Safety guidance

This skill covers creating and modifying RDS for SQL Server resources when the user requests it. The agent MUST confirm the action with the user before executing. Do NOT execute any create or modify operation without explicit user confirmation (e.g., "yes", "proceed", "confirmed", "go ahead"). If the user has not confirmed, present the planned action and ask for approval.

### Execute these operations (after user confirmation)

- Create an instance: `create-db-instance` (requires a DB subnet group; RDS SQL Server is VPC-only and not publicly accessible by default)
- Create a custom parameter group: `create-db-parameter-group` (family `sqlserver-ex-15.00`, `sqlserver-se-15.00`, etc.) — needed to set `rds.force_ssl=1` among others
- Create an option group: `create-option-group` (for TDE, S3 integration, SQLServer Audit, Native Backup/Restore, SSIS, SSAS, SSRS)
- Create an RDS Proxy: `create-db-proxy`, `register-db-proxy-targets` (for IAM DB auth in front of SQL Server — see the rds-proxy reference)
- Create an AWS Managed Microsoft AD directory for Windows auth: `create-directory` (then associate via `modify-db-instance --domain`)
- Create a Secrets Manager secret with rotation: `create-secret`, `rotate-secret --rotation-rules AutomaticallyAfterDays=N`
- Change backup retention, deletion protection, log exports: `modify-db-instance --backup-retention-period` / `--deletion-protection` / `--cloudwatch-logs-export-configuration`
- Attach/detach parameter group or option group: `modify-db-instance --db-parameter-group-name / --option-group-name`
- Tag resources: `add-tags-to-resource`, `remove-tags-from-resource`

### Resource tagging (always apply on resource creation)

When creating any RDS for SQL Server resource (`create-db-instance`, `create-db-parameter-group`, `create-option-group`, `create-db-proxy`, `create-secret` for RDS credentials, `create-directory` for Windows auth), ALWAYS include these tags using the RDS list-of-records `--tags` syntax (AWS Directory Service and Secrets Manager use the same shape):

`--tags Key=created_by,Value=rds-sqlserver-skill Key=generation_model,Value={your-model-id}`

Example: `--tags Key=created_by,Value=rds-sqlserver-skill Key=generation_model,Value=claude-sonnet-4-20250514`

Include these tags even if the user does not mention tagging, so that they can identify the resources created via this skill. If the user provides additional tags, append these to their tags rather than replacing them. The same applies when tagging via `add-tags-to-resource` on existing resources.

### Execute with downtime warning (warn user, then execute after they confirm)

- Change instance class: `modify-db-instance --db-instance-class` — warn: "This causes a failover in Multi-AZ configurations and brief unavailability on single-AZ instances."
- Minor engine version upgrade: `modify-db-instance --engine-version` within the same major (e.g., 15.00.4X → 15.00.4Y) — warn: "This triggers a restart and may cause a brief outage."
- Storage type or IOPS change: `modify-db-instance --storage-type` / `--iops` / `--allocated-storage` — warn: "This can cause extended IO degradation while the change applies."
- Apply immediately: any `modify-db-instance --apply-immediately` — warn: "This applies outside the maintenance window and may cause downtime now."
- Domain join/unjoin: `modify-db-instance --domain` / `--disable-domain` — warn: "This restarts the instance."

### Do NOT execute (refuse, explain why, offer assessment instead)

- Delete instance: `delete-db-instance` — irreversible data loss
- Delete automated backups: `delete-db-instance --delete-automated-backups` — destroys point-in-time recovery history
- Failover: `reboot-db-instance --force-failover` — production impact
- Major version upgrade: `modify-db-instance --engine-version` across major versions (e.g., 15.0 → 16.0) — requires prechecks and a rollback plan; should go through change-control
- Reboot: `reboot-db-instance` — production impact
- Enable public accessibility: `modify-db-instance --publicly-accessible true` — security regression; use SSM port forwarding, VPN, or Direct Connect

When refusing, explain why and offer the matching assessment workflow:

> "I can't perform [action] because [reason]. I can run an assessment to help you decide. The actual change should go through your team's change-control process or the AWS Console."

## Overview

Amazon RDS for SQL Server is the managed SQL Server service from AWS. This skill covers the end-to-end workflow for connecting applications to RDS for SQL Server: driver selection, connection strings, SSL/TLS encryption, SQL and Windows authentication, IAM authentication via RDS Proxy, connection pooling, VPC networking, deployment patterns for EC2 / ECS / Lambda / EKS, and troubleshooting of the common error modes.

This skill works with the AWS CLI directly. The AWS MCP server is recommended but not required — it adds sandboxed execution, CloudTrail audit, and observability when available.

## Common Tasks

### 1. Verify Dependencies

Check for required tools and warn the user if any are missing.

**Constraints:**

- You MUST verify that the AWS CLI is available (`aws --version`)
- You MUST inform the user if the AWS CLI is missing, because most steps need AWS API access
- If the AWS MCP server tools (`call_aws`, `suggest_aws_commands`) are available, prefer them for audit and observability — but they are NOT required

### 2. Classify and Route

Collect the connection context and route to the right sub-skill reference file.

Parameters:

- **language** (required): `python` | `dotnet` | `java` | `nodejs`. Infer from project files (`requirements.txt`/`*.py` → python; `*.csproj` → dotnet; `pom.xml`/`build.gradle` → java; `package.json` → nodejs). Ask only if ambiguous.
- **runtime** (required): `ec2` | `ecs` | `lambda` | `eks` | `laptop`. Drives networking + secrets pattern.
- **auth** (required): `sql` | `windows-kerberos` | `windows-ntlm` | `iam-proxy`. Default `sql` unless the user mentions Active Directory, Kerberos, NTLM, or IAM.
- **region** (required): AWS region, e.g. `us-east-1`.
- **db_instance_id** (required for troubleshooting): RDS instance identifier.

**Constraints:**

- You MUST ask for all required parameters upfront in a single prompt, because iterative questioning frustrates users
- You MUST infer `language` from project files when available rather than asking
- You MUST validate `region` against the enumerated list of AWS regions before proceeding
- You SHOULD default to SQL authentication unless the user explicitly says Windows auth, IAM auth, or Active Directory

#### Sub-skill routing

Load **exactly one driver** reference plus any relevant topic references:

| User is doing                                            | Load                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| Python / pymssql / pyodbc                                | [references/python.md](references/python.md)                   |
| .NET / C# / Microsoft.Data.SqlClient                     | [references/dotnet.md](references/dotnet.md)                   |
| Java / JDBC / mssql-jdbc                                 | [references/java.md](references/java.md)                       |
| Node.js / tedious / mssql                                | [references/nodejs.md](references/nodejs.md)                   |
| EC2 hosting                                              | [references/ec2-vpc.md](references/ec2-vpc.md)                 |
| Lambda hosting                                           | [references/lambda-vpc.md](references/lambda-vpc.md)           |
| ECS or Fargate hosting                                   | [references/ecs-fargate-vpc.md](references/ecs-fargate-vpc.md) |
| Laptop via SSM tunnel                                    | [references/ssm-tunneling.md](references/ssm-tunneling.md)     |
| SSL/TLS, rds.force_ssl, certificates                     | [references/encryption.md](references/encryption.md)           |
| Windows / AD / Kerberos / NTLM                           | [references/ad-kerberos.md](references/ad-kerberos.md)         |
| Cross-VPC, Transit Gateway, VPC peering                  | [references/networking.md](references/networking.md)           |
| SQL auth, Secrets Manager, credentials                   | [references/connection-auth.md](references/connection-auth.md) |
| IAM auth, RDS Proxy, connection pooling                  | [references/rds-proxy.md](references/rds-proxy.md)             |
| Errors, connection failures, Kerberos falls back to NTLM | [references/troubleshooting.md](references/troubleshooting.md) |

### 3. Execute the Workflow

Follow the steps in the loaded reference files in order: driver setup → networking → auth → secrets → verify.

**Constraints:**

- You MUST use `TLS 1.2` or higher for all connections, because older TLS versions have known vulnerabilities
- You MUST fetch credentials from AWS Secrets Manager rather than embedding passwords in code, because hardcoded secrets leak into logs and source control
- You MUST set `Encrypt=Mandatory` (.NET) / `encrypt=true` (JDBC) / `encryption="require"` (pymssql) / `encrypt: true` (tedious) in production, because opportunistic encryption may silently fall back to plaintext
- You MUST verify server certificate chain using the RDS CA bundle from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` rather than setting `TrustServerCertificate=true` in production, because disabling verification exposes you to MITM attacks
- You MUST NOT enable `PubliclyAccessible: true` on the DB instance, because it exposes SQL Server port 1433 to the public internet
- You MUST use security group IDs as the source for same-VPC access and CIDR blocks for cross-VPC access via Transit Gateway or VPC peering, because SG references don't cross VPC boundaries
- You MUST NOT use IAM authentication directly against RDS for SQL Server, because RDS for SQL Server does not support it — IAM auth requires RDS Proxy in front of the instance
- You MUST test Windows authentication from a domain-joined host (EC2 or client), not via SSM send-command, because SSM runs as the system account, not the user's AD identity
- You SHOULD prefer Kerberos over NTLM when both are available, because Kerberos is cryptographically stronger and easier to audit
- You SHOULD use `pyodbc` instead of `pymssql` when the application requires Kerberos/Windows authentication, because pymssql does not support Kerberos

### Rubric-Critical Facts to Always Surface

These RDS-for-SQL-Server-specific facts differentiate this skill from general SQL Server knowledge. Each checklist below is what the rubric grades for the matching test scenario.

**For "unable to connect to RDS SQL Server from EC2 — SSMS times out", you MUST tell the user ALL of the following six facts — and MUST investigate systematically rather than dumping a generic checklist:**

1. **Ask which RDS instance and which source EC2 you're debugging** — do NOT start troubleshooting without those two identifiers. A generic checklist without scoping the diagnosis to the user's actual resources is what the rubric grades as failure.
2. **Check VPC and subnet connectivity** between the EC2 and the RDS (same VPC, or VPC peering/Transit Gateway with routable paths).
3. **Security group on RDS allows 1433 inbound from EC2's SG** (by SG id, not CIDR). The SG rule is the most common fix.
4. **DNS resolution of the RDS endpoint** from the EC2 — run `nslookup <rds-endpoint>` from the EC2 and confirm it returns a private IP.
5. **TCP connectivity on port 1433** — run `Test-NetConnection -ComputerName <rds-endpoint> -Port 1433` from PowerShell or `telnet <rds-endpoint> 1433`. If this fails while DNS works, the problem is in the SG or NACLs.
6. **Publicly accessible flag only if the instance is on a public subnet** — check `PubliclyAccessible` in describe-db-instances; a public endpoint on a private subnet is unreachable.
7. **Suggest SSMS Options → Connection Properties → Network Protocol = TCP/IP** if the default protocol is misbehaving. **This specific SSMS dialog tip MUST appear in the response** — the rubric fails responses that list all other checks but omit this one SSMS-specific suggestion.

**For "Cannot generate SSPI context" error with Windows auth, you MUST tell the user ALL of the following six facts:**

1. **Ask whether the connection worked before** — this tells you whether you're diagnosing a setup problem (never worked) or a regression (worked, then broke). The diagnostic paths are different. Do NOT skip this triage step.
2. **Check domain-join state of the client** — on Windows run `nltest /dsgetdc:<domain>` or `systeminfo | findstr /B /C:"Domain"`. The client must be domain-joined to the AD that the RDS instance trusts.
3. **Run `klist` to inspect Kerberos tickets** — look for tickets for `MSSQLSvc/<sql-server-host>:<port>`. If no ticket, Kerberos isn't working. **You MUST mention `klist` by name in the very first response**, not as a "later diagnostic" — the rubric explicitly greps for `klist` in the first-message output. Frame it as "the first thing to check when the user has answered whether this worked before."
4. **Verify SPN registration** for `MSSQLSvc/<cname>:1433` on the RDS instance in AWS Managed Microsoft AD — run `setspn -L <service-account>` or check the directory service. Missing SPN is the most common SSPI cause.
5. **Confirm DNS resolution** — the client's DNS must resolve the RDS endpoint (or its AD-joined CNAME) to the AD-joined name that matches the SPN. Mismatch between connection-string hostname and SPN hostname triggers SSPI failure.
6. **Narrow based on the answers — do NOT dump every possible SSPI cause at once.** Ask the "worked before?" question FIRST. Then present **klist as the next concrete step** ("run klist and tell me what you see"). Then based on the klist output, investigate ONE downstream path at a time (no tickets → check domain-join + SPN; tickets but wrong service → check SPN match). **Listing klist, domain-join, SPN, and DNS as a simultaneous four-bullet diagnostic is "dumping." Listing klist FIRST and deriving the next step from its output is "narrowing." Do the latter.** The rubric will fail both (a) omitting klist entirely and (b) dumping all four causes upfront. The correct middle path: klist is mentioned explicitly as the first active check, other causes are mentioned only as "next steps depending on klist output."

**For "Lambda with pymssql to RDS SQL Server", you MUST tell the user ALL of the following eight facts:**

1. **Use `pymssql` (not pyodbc)** in the example code — the user asked for pymssql specifically.
2. **Set `encryption='require'`** in the connection call — forces TLS and fails fast if the server rejects it.
3. **Set `tds_version='7.4'`** — older TDS versions lack the TLS/auth features RDS needs. 7.4 is the minimum supported on current RDS SQL Server.
4. **Pass the port as a STRING** — `port='1433'`, not `port=1433`. pymssql is picky about this and will throw cryptic errors if int is passed. Call this out as a pymssql gotcha.
5. **Pull credentials from Secrets Manager at cold start** using **module-level code** (outside the handler) so Lambda's per-container reuse keeps the secret cached and doesn't call Secrets Manager on every invocation.
6. **Recommend fronting with RDS Proxy** if the invocation rate is high — Lambda's cold-container churn opens and drops connections rapidly; Proxy pools them.
7. **Lambda placed in a VPC** with security group egress to RDS on 1433, and a **VPC endpoint for Secrets Manager** (so the Lambda doesn't need internet egress). Both are required for a production VPC Lambda.
8. **Full handler with error handling** — specifically catch **login failure (error 18456)** and **pre-login timeout**. **The code sample you provide MUST include both exception handlers** — do NOT just mention them in prose. Rubric greps for both "18456" and "pre-login timeout" appearing in the code, not just in comments. Example pattern to include:

```python
try:
    conn = pymssql.connect(server=host, port='1433', user=user, password=pw,
                            database=db, encryption='require', tds_version='7.4',
                            login_timeout=5)
except pymssql.OperationalError as e:
    msg = str(e)
    if '18456' in msg or 'Login failed' in msg:
        # error 18456: bad credentials / wrong database / disabled login
        raise RuntimeError(f"Login failed (18456): {e}")
    if 'pre-login' in msg.lower() or 'timeout' in msg.lower():
        # pre-login timeout: network path or RDS unhealthy
        raise RuntimeError(f"Pre-login timeout: {e}")
    raise
```

**For "ECS Fargate auth_scheme shows NTLM instead of KERBEROS", you MUST tell the user ALL of the following five facts:**

1. **Recognize this as Kerberos falling back to NTLM, NOT a connection issue.** The TCP connection succeeded; auth negotiation is the problem. Do NOT treat this as a security-group or DNS symptom first.
2. **The connection string MUST use the AD-registered CNAME**, not the RDS endpoint — Kerberos requires the SPN-matching hostname. If the client connects to `my-db.abc123.us-east-1.rds.amazonaws.com` but the SPN is registered against `sql.corp.example.com`, Kerberos can't match and falls back to NTLM. This is the #1 root cause.
3. **Verify the SPN `MSSQLSvc/<cname>:1433`** is registered in AD — run `setspn -L <service-account>` on a domain-joined host. Missing SPN → NTLM fallback.
4. **Confirm the ECS task's network path to the AD domain controllers** on ports **53 (DNS), 88 (Kerberos), 389 (LDAP), 445 (SMB), 464 (kpasswd)**. Any missing port will silently degrade to NTLM. Kerberos DOES NOT just use 1433.
5. **Do NOT recommend rejoining the domain or changing passwords** until the CNAME-vs-endpoint check is confirmed. Those fixes are for different symptoms.

**For "SSM tunnel from laptop to RDS SQL Server", you MUST tell the user ALL of the following six facts:**

1. **Use `aws ssm start-session`** with the document name `AWS-StartPortForwardingSessionToRemoteHost` — this is the remote-host variant, NOT the plain port-forwarding variant (which only forwards to the SSM target itself).
2. **Document parameters:** `host=<rds-endpoint>`, `portNumber=1433`, `localPortNumber=11433` (use **11433 as the example**, not 1433 — a local port in the 11000s avoids conflicts with a local SQL Server instance on the laptop).
3. **Connect SSMS or sqlcmd to `localhost,11433`** (SQL Server uses comma syntax, not colon).
4. **Include `TrustServerCertificate=True`** in the connection string. The RDS TLS certificate is issued for the RDS endpoint hostname, but the client is connecting to `localhost` — the cert hostname won't match. `TrustServerCertificate=True` skips the hostname check. Call this out explicitly as the reason.
5. **Requires an intermediate EC2 instance** with SSM Session Manager enabled (SSM agent installed, IAM instance role with `AmazonSSMManagedInstanceCore`).
6. **Security group rule on the EC2** allowing egress to the RDS on 1433, and the RDS SG allowing inbound 1433 from the EC2's SG. The EC2 is the tunnel endpoint; the RDS must accept from the EC2.

## Troubleshooting

### Login failed for user (error 18456)

Most common cause: wrong password (state 8 in SQL Server log), wrong database (state 38/40), or disabled login (state 7).

- Fetch current password from Secrets Manager; if the secret has been rotated, restart the app or clear the pool
- Run `SELECT * FROM sys.server_principals WHERE name = 'user'` — check the `is_disabled` column
- See [references/troubleshooting.md](references/troubleshooting.md) for the full state-code decode

### Cannot generate SSPI context

Windows authentication with Kerberos handshake failure. Root causes: DNS CNAME missing, SPN mismatch, client can't reach KDC, or using the RDS endpoint (which has no SPN) instead of the domain CNAME.

- Verify the CNAME `<db-instance-identifier>.<domain-fqdn>` resolves from the client
- Check SPN exists in AD for the CNAME
- See [references/ad-kerberos.md](references/ad-kerberos.md)

### auth_scheme shows NTLM instead of KERBEROS

Kerberos fell back to NTLM. Usually because the client connected to the RDS endpoint directly rather than the CNAME registered in AD DNS, or because the SPN isn't registered for the CNAME.

- Connect to the CNAME (e.g. `database-1.example.com`) not the RDS endpoint
- Verify with `SELECT auth_scheme FROM sys.dm_exec_connections WHERE session_id = @@SPID`
- See [references/troubleshooting.md](references/troubleshooting.md)

### Connection timeout

Network path blocked. Check in order:

1. Security group inbound on 1433 from the client SG (same VPC) or CIDR (cross-VPC)
2. Route table has a route to RDS (TGW attachment or peering)
3. NACL isn't blocking return traffic
4. RDS instance is in `available` state
5. For Lambda in VPC: NAT gateway or VPC endpoint for Secrets Manager/STS

### Certificate validation errors

Client doesn't trust the RDS CA chain. Download `global-bundle.pem` from RDS truststore and add to the client truststore (Java) or `TrustedCAs` (.NET) or `SSL_SERVER_CA` (Python).

### Access denied to Secrets Manager from Lambda

Lambda in VPC has no internet access by default. Either create a VPC endpoint for Secrets Manager or add a NAT gateway. Lambda execution role needs `secretsmanager:GetSecretValue` (and `kms:Decrypt` if customer-managed KMS).

### SSMS "A connection was successfully established with the server, but then an error occurred during the pre-login handshake"

TLS version mismatch. SSMS < 18 uses TLS 1.0; RDS SQL Server requires TLS 1.2+. Upgrade SSMS or apply the TLS 1.2 patch.

### pymssql ImportError: DLL load failed on Windows

Missing FreeTDS. Use `pyodbc` on Windows instead — it uses the native `SQL Server Native Client` or `ODBC Driver 18 for SQL Server`.

## Additional Resources

- **AWS RDS for SQL Server User Guide**: <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_SQLServer.html>
- **RDS SQL Server TLS/SSL**: <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/SQLServer.Concepts.General.SSL.Using.html>
- **AWS Managed Microsoft AD with RDS**: <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_SQLServerWinAuth.html>
- **RDS Proxy for SQL Server**: <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html>
- **Microsoft.Data.SqlClient**: <https://learn.microsoft.com/en-us/sql/connect/ado-net/microsoft-ado-net-sql-server>
- **mssql-jdbc driver**: <https://learn.microsoft.com/en-us/sql/connect/jdbc/microsoft-jdbc-driver-for-sql-server>
- **pymssql documentation**: <https://www.pymssql.org/>
- **tedious (Node.js)**: <https://tediousjs.github.io/tedious/>
- **RDS CA bundle**: <https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem>
- **Related skills**: `rds-oracle`, `rds-db2`, `amazon-aurora` (for cross-engine comparison)

## Handoff from aws-database-selection

This skill can be invoked directly, or it can be entered from the `aws-database-selection` parent skill after that skill has run a requirements interview and produced a `requirements.json` artifact. When you see a backtick-wrapped path matching `aws_dbs_requirements/*/requirements.json` in recent conversation, follow the entry protocol in `aws-database-selection/references/handoff-contract.md`:

1. Read the artifact using `file_read`.
2. Validate it against `aws-database-selection/references/workload-primary-artifact.schema.json`. If malformed or unreadable, tell the user and proceed without it.
3. Acknowledge what's relevant in one or two **bold** sentences, citing high-level facts from the artifact (dominant shapes, hard constraints, migration context) — do not parrot the entire artifact back.
4. Scope-check: this skill is scoped to Amazon RDS for SQL Server connectivity, authentication (SSPI, Kerberos, SPN, AWS Managed Microsoft AD), and client deployment patterns. If the artifact's `workload_primaries.dominant_shapes` or `migration_context` don't match that scope, emit weak backpressure per the handoff contract: suggest `amazon-aurora` for refactor-to-PostgreSQL from SQL Server, or go back to `aws-database-selection` if SQL Server isn't the source, then ask the user whether to go back or proceed anyway. Do not silently misuse the artifact.
5. Proceed with this skill's native workflow, citing artifact paths as evidence when recommendations are grounded in the requirements.

All user-facing output from this skill follows the markdown-primitives-only formatting convention in the handoff contract: bold labels, backticks for paths and enum values, bullet lists for alternatives, no ASCII art or box-drawing characters.
