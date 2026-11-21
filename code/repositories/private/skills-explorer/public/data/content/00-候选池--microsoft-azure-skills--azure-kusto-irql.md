---
name: azure-kusto-irql
description: "Compose IRQL (Incident Response Query Language) queries for Kusto cybersecurity investigations. Translates natural language hunting questions into composable IRQL pipelines using Get_*, Extract_*, and Enrich_* functions. WHEN: IRQL query, security hunt, threat hunting KQL, incident response query, compose hunting pipeline, failed logins, phishing investigation, lateral movement, process execution, file creation events."
license: MIT
metadata:
  author: Microsoft
  version: "1.2.1"
---

# IRQL -- Incident Response Query Language

Compose IRQL function pipelines from selector, extractor, and enricher building blocks. IRQL wraps raw KQL security tables behind intent-revealing, composable functions so analysts (and LLMs) can express hunts without memorizing schemas, cluster locations, or join keys.

## Activation Triggers

Use this skill when the user:

- Explicitly mentions IRQL, `Get_*`, `Extract_*`, or `Enrich_*` functions
- Says "use IRQL" or "write an IRQL query"
- Requests a composable hunting pipeline using known IRQL selectors

Do **not** activate for generic security queries (e.g. "find failed logins") unless the user explicitly asks for IRQL. Route those to `azure-kusto` instead.

**Not a natural-language-to-IRQL converter.** This skill composes IRQL function pipelines and may handle basic natural-language requests that map directly to known selectors and simple filters. For general NL-to-KQL or NL-to-IRQL conversion, use a dedicated query-generation skill (available separately).

## IRQL Function Preflight

Before generating a pipeline, verify IRQL is available on the target database:

```kql
.show functions
| where Name startswith "Get_" or Name startswith "Extract_" or Name startswith "Enrich_"
| project Name
```

If no IRQL functions are found, inform the user that IRQL is not deployed on the target database and suggest using `azure-kusto` for raw KQL queries instead. IRQL functions are a prerequisite -- this skill does not deploy base IRQL selectors.

## What IRQL Is

IRQL is a **function-based dialect on top of KQL**. It provides:

1. **Unified schema** -- disparate security tables project into consistent column names regardless of the underlying data source
2. **Composability** -- small functions chain via `| invoke` to build complex hunts from simple steps
3. **Portability** -- the same IRQL pipeline works across different clusters/databases; only the `Get_*` primitives need re-pointing

IRQL is not a separate language. It's KQL functions you invoke. Any valid KQL works alongside IRQL functions.

## Deploying IRQL

IRQL functions are stored KQL functions (`.create-or-alter function`). They must already be deployed to the target database before this skill can generate pipelines.

**Public example cluster** (functions pre-deployed):

- Cluster: `https://kc7001.eastus.kusto.windows.net`
- Databases: `ValdyTimes`, `JoJosHospital`

To port IRQL to a new cluster/database, create `Get_*` selectors that project your source tables into the unified schema (column names below), then deploy extractors and enrichers. The extractors and enrichers work unchanged as long as the input schema matches.

## Function Catalog

### 1. Selectors -- `Get_*`

Return projected, schema-unified views of source tables. Use the minimal form by default; use `_All` when extra columns are needed.

| Function                        | Columns                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `Get_Event_Authentication`      | `EnvTime`, `Hostname`, `ClientIp`, `Username`, `Result`                                      |
| `Get_Event_Authentication_All`  | + `Description`, `UserAgent`, `PasswordHash`                                                 |
| `Get_Email`                     | `EnvTime`, `EmailSender`, `EmailRecipient`, `Subject`, `Url`                                 |
| `Get_Email_All`                 | + `ReplyTo`, `Verdict`                                                                       |
| `Get_Employees`                 | `Name`, `ClientIp`, `Email`, `Username`, `Hostname`, `Role`                                  |
| `Get_Employees_All`             | + `HireDate`, `UserAgent`, `Domain`                                                          |
| `Get_Event_FileCreation`        | `EnvTime`, `Hostname`, `Filename`, `Path`                                                    |
| `Get_Event_FileCreation_All`    | + `Username`, `Sha256`, `ProcessName`                                                        |
| `Get_Event_NetworkInbound`      | `EnvTime`, `ClientIp`, `Url`                                                                 |
| `Get_Event_NetworkInbound_All`  | + `Method`, `UserAgent`, `StatusCode`                                                        |
| `Get_Event_NetworkOutbound`     | `EnvTime`, `ClientIp`, `Url`                                                                 |
| `Get_Event_NetworkOutbound_All` | + `Method`, `UserAgent`                                                                      |
| `Get_Dns_All`                   | `EnvTime`, `Domain`, `ClientIp`                                                              |
| `Get_Event_Process`             | `EnvTime`, `ProcessCommandLine`, `ProcessName`, `Hostname`, `Username`                       |
| `Get_Event_Process_All`         | + `ParentProcessName`, `ParentProcessHash`, `ProcessHash`                                    |
| `Get_SecurityAlerts_All`        | `EnvTime`, `AlertType`, `Severity`, `Description`, `Indicators`                              |
| `Get_Network_Connection_All`    | `EnvTime`, `SourceIp`, `SourcePort`, `DestinationIp`, `DestinationPort`, `Protocol`, `Bytes` |

### 2. Extractors -- `Extract_*`

Derive a new column from an existing one. Invoke after a selector.

| Function                          | Input Column  | Adds         |
| --------------------------------- | ------------- | ------------ |
| `Extract_Email_Sender_Domain(T)`  | `EmailSender` | `Domain`     |
| `Extract_Employee_Firstname(T)`   | `Name`        | `Firstname`  |
| `Extract_Event_Network_Domain(T)` | `Url`         | `DomainName` |

### 3. Enrichers -- `Enrich_*`

Left-join helpers that attach context from a related table.

| Function                                  | Key Column | Enriches With                   |
| ----------------------------------------- | ---------- | ------------------------------- |
| `Enrich_Event_Authentication_Username(T)` | `Username` | Auth events for user            |
| `Enrich_Ip_Employee(T)`                   | `ClientIp` | Employee identity from IP       |
| `Enrich_Username_Employee(T)`             | `Username` | Employee identity from username |
| `Enrich_Ip_Domain(T)`                     | `ClientIp` | DNS domains resolved to IP      |
| `Enrich_Ip_Event_NetworkOutbound(T)`      | `ClientIp` | Outbound network from IP        |
| `Enrich_Ip_Network_Connection(T)`         | `ClientIp` | Network flows from IP           |

### 4. External Enrichment

| Function                                | Source                 | Requirement              |
| --------------------------------------- | ---------------------- | ------------------------ |
| `Enrich_Sha256_VirusTotal(T)`           | VirusTotal file report | API key + callout policy |
| `Get_CISA_KEV()` / `Enrich_CISA_KEV(T)` | CISA KEV catalog       | Callout policy           |

## Composition Rules

```
Selector -> Extract -> Filter -> Enrich -> Summarize/Project
```

1. **Start with a Selector**: `Get_Event_Authentication`, `Get_Email`, etc.
2. **Extract** derived fields: `| invoke Extract_Email_Sender_Domain()`
3. **Filter** to the signal: `| where Result == "Failed Login"`
4. **Enrich** with context: `| invoke Enrich_Username_Employee()`
5. **Summarize / project** the answer

Always pipe (`|`) between steps. Extractors and Enrichers use `| invoke FunctionName()`.

## Query Generation Guidelines

- Use the **minimal selector** unless extra columns are needed -> then `_All`
- Chain extractors before enrichers (extractors add columns enrichers may key on)
- Place `where` filters as early as possible
- Use `summarize` for aggregations, `project` for final column selection
- End with `order by` + `take` to limit output

## Examples

For additional prompts and worked examples, see [references/EXAMPLES.md](references/EXAMPLES.md).

### Brute-force detection

```kql
Get_Event_Authentication
| where Result == "Failed Login"
| summarize FailedCount = count() by Username
| where FailedCount > 19
| invoke Enrich_Username_Employee()
| project Username, Name, Role, Email, FailedCount
| order by FailedCount desc
```

### Phishing triage by recipient seniority

```kql
Get_Email
| invoke Extract_Email_Sender_Domain()
| project EnvTime, EmailSender, Domain, Username = EmailRecipient, Subject, Url
| invoke Enrich_Username_Employee()
| extend Seniority = case(
    Role has_any ("CEO", "Chief", "Director", "VP", "President"), 3,
    Role has_any ("Manager", "Lead", "Senior"), 2,
    1)
| summarize
    TotalEmails = count(),
    SeniorityScore = sum(Seniority),
    Recipients = make_set(Name, 50),
    DistinctRecipients = dcount(Username)
  by Domain
| where DistinctRecipients >= 2
| order by SeniorityScore desc
| take 20
```

### Post-exploitation pivot from an indicator

```kql
let victims =
    Get_Event_FileCreation_All
    | where Filename has "<INDICATOR>"
    | distinct Hostname;
Get_Event_Process
| where Hostname in (victims)
| where ProcessCommandLine has_any ("rundll32", "regsvr32", "powershell", "systeminfo")
| project EnvTime, Hostname, Username, ProcessName, ProcessCommandLine
| order by EnvTime asc
```

### Suspicious outbound traffic enriched with identity

```kql
Get_Event_NetworkOutbound
| invoke Extract_Event_Network_Domain()
| where DomainName has_any ("<SUSPICIOUS_DOMAIN_1>", "<SUSPICIOUS_DOMAIN_2>")
| invoke Enrich_Ip_Employee()
| project EnvTime, Name, Role, DomainName, Url, ClientIp
| order by EnvTime desc
```

### External IP authentication anomaly

```kql
Get_Event_Authentication_All
| where not(ClientIp startswith "10.") and not(ClientIp startswith "192.168.")
| summarize
    Attempts = count(),
    Failures = countif(Result == "Failed Login"),
    Users = make_set(Username)
  by ClientIp
| order by Failures desc
| take 20
```

## MCP Tools Used

| Tool                     | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `kusto_query`            | Execute IRQL pipelines against a Kusto database |
| `kusto_table_schema_get` | Discover available tables and columns           |
| `kusto_cluster_list`     | List available ADX clusters                     |
| `kusto_database_list`    | List databases in a cluster                     |

## Opening Queries in Kusto Explorer (Windows Only)

> **Optional convenience feature.** The default workflow is to output the KQL in chat and let the user copy it into Kusto Explorer or the VS Code Kusto extension manually. Auto-launch is opt-in only.

Always output the complete KQL query in the chat response with Step 1 (connect) and Step 2 (query) clearly labeled:

```
// Step 1: Connect to your cluster (skip if already connected)
// Example: uncomment to connect to the KC7 training cluster
// #connect cluster('kc7001.eastus.kusto.windows.net').database('ValdyTimes')
// Or replace with your own cluster:
// #connect cluster('<YOUR_CLUSTER>').database('<YOUR_DATABASE>')

// Step 2: Run the query below
<KQL_QUERY>
```

If the user asks to save or open in Kusto Explorer, follow the procedure in [references/KUSTO_EXPLORER_LAUNCH.md](references/KUSTO_EXPLORER_LAUNCH.md). Key rules:

- Use `ask_user` to confirm before writing files or launching executables
- Display file contents in chat so the user can review before opening
- Never use shell interpolation or here-strings — write files via `Set-Content`/`Add-Content`
- Never encode queries into browser URLs
- On macOS/Linux, save the `.kql` file and suggest the VS Code Kusto extension or ADX Web Explorer
- For graph visualization from IRQL data, see `azure-kusto-graph` and `azure-kusto-irql-graph`
