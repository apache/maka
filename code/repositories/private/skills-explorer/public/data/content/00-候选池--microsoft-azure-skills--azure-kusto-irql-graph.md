---
name: azure-kusto-irql-graph
description: "Apply IRQL graph functions to KQL or IRQL query results for Kusto Explorer visualization. Generates Lift_To_Graph mappings and composes Graph_Render_View, Graph_Fold_By_Property, Extract_Node_*, Enrich_Node_*, and Enrich_Graph_* calls. Accepts a supplied query or limited basic natural-language source request; it is not a general natural-language-to-KQL/IRQL skill. WHEN: Lift_To_Graph, Graph_Render_View, Graph_Fold_By_Property, IRQL graph enrichment, graph mapping for existing query results, icon-decorated graph, fold graph nodes. Use azure-kusto-graph for native make-graph analysis, graph-match, shortest paths, components, or persistent graphs."
license: MIT
metadata:
  author: Microsoft
  version: "1.2.1"
---

# IRQL Graph Functions -- Query Results to Visualization

Apply the IRQL graph function family to tabular results. Given a KQL or IRQL query and the user's graph description, generate a `Lift_To_Graph` mapping and compose only the stored graph functions needed to visualize, fold, extract, or enrich the graph in Kusto Explorer. The source query does not need to use IRQL.

## Scope and Routing

| Request                                                                                           | Use                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Turn supplied KQL/IRQL rows into an icon-decorated visual graph                                   | This skill: `Lift_To_Graph` + `Graph_Render_View`       |
| Fold nodes or apply `Extract_Node_*`, `Enrich_Node_*`, or `Enrich_Graph_*`                        | This skill                                              |
| Use `make-graph`, `graph-match`, shortest paths, connected components, graph models, or snapshots | `azure-kusto-graph`                                     |
| Author a non-trivial KQL/IRQL investigation from natural language                                 | A Kusto or IRQL query-generation skill, then this skill |

If a request mixes visualization and native graph analysis, use this skill for the lift/render portion and `azure-kusto-graph` for operator semantics. Do not replace graph-lift functions with a hand-built edges-first graph unless the user asks for native graph operators.

## Input Contract

- **Preferred input**: a working KQL/IRQL query that produces tabular results, plus a natural-language description of the desired nodes, edges, labels, icons, extracts, enrichments, or folds.
- This skill is **not a natural-language-to-KQL or NL-to-IRQL converter**. It transforms existing query results into graph visualizations. For general NL-to-KQL or NL-to-IRQL conversion, use a dedicated query-generation skill (available separately).
- Preserve the supplied query's retrieval, joins, filters, and aggregations. Add only projections or synthetic IDs required by the graph mapping.
- A basic natural-language source request is supported only when it maps directly to one known table or IRQL `Get_*` selector with obvious columns and simple filters. State the assumed source, and do not invent joins, schema, or investigation logic.
- For non-trivial query construction, use a separate Kusto/IRQL query-generation skill first, then apply this skill to its output.
- If no query or output schema is available and the source is not trivial, request the KQL query or its result columns before generating a mapping.

## Activation Triggers

Use this skill when the user:

- Supplies KQL/IRQL results and asks for an IRQL graph visualization or mapping
- Mentions `Lift_To_Graph`, `Graph_Render_View`, or `Graph_Fold_By_Property`
- Asks for icon-decorated node/edge mappings in Kusto Explorer
- Wants to fold/collapse nodes by a shared property
- Requests graph extraction or enrichment through `Extract_Node_*`, `Enrich_Node_*`, or `Enrich_Graph_*`

Do not activate this skill solely for `graph-match`, graph paths/components, persistent graphs, or generic `make-graph` construction; those belong to `azure-kusto-graph`.

**Not a natural-language-to-KQL/IRQL converter.** The input should generally be a working KQL or IRQL query whose results need graph visualization. Basic NL source requests work only for trivial single-table/selector cases. For general NL-to-KQL or NL-to-IRQL, use a dedicated query-generation skill (available separately).

## Environment

- **Cluster**: `https://kc7001.eastus.kusto.windows.net`
- **Databases**: `ValdyTimes`, `JoJosHospital` (graph functions pre-deployed)
- **Rendering**: Kusto Explorer desktop app (make-graph visualization window)
- **Tool**: `kusto_query` (via Azure MCP Server)

### Function Preflight

`Lift_To_Graph` and `Graph_Render_View` are stored functions, not built-in Kusto operators. Before generating or running a lift pipeline against a target database, check what is deployed:

```kql
.show functions
| where Name in~ ("Lift_To_Graph", "Graph_Render_View", "Graph_Fold_By_Property")
| project Name
```

- `Lift_To_Graph` and `Graph_Render_View` are required.
- `Graph_Fold_By_Property` is required only when folding is requested.
- Check any `Extract_Node_*`, `Enrich_Node_*`, or `Enrich_Graph_*` function before using it; omit optional enrichment when unavailable unless the user wants it deployed.
- If a required function is missing and you have permission to alter the database, **ask the user for confirmation before deploying**. Then use the `.create-or-alter function` definitions in [references/DEPLOY_IRQL_FUNCTIONS.md](references/DEPLOY_IRQL_FUNCTIONS.md). Run the relevant `.create-or-alter` block, then rerun the preflight check to confirm.
- If you do not have alter permissions, tell the user which functions are missing and point them to `references/DEPLOY_IRQL_FUNCTIONS.md` for manual deployment.

## IRQL Graph Function Family

### `Lift_To_Graph(T, mappingJson)`

Transforms any tabular KQL result into a unified node + edge table.

**Input**: Any table `T` + a JSON mapping string.
**Output**: Rows with `EntityType` = `"node"` or `"edge"`, ready for `make-graph`.

### `Graph_Render_View(T)`

Takes `Lift_To_Graph` output, splits nodes/edges, and calls `make-graph` to open Kusto Explorer's graph window.

### `Graph_Fold_By_Property(T, NodeType, PropertyName)`

Collapses nodes of a given type sharing a property value into a single node. Rewires edges automatically.

### Graph Extraction and Enrichment Functions

These are additional stored functions that must already be deployed on the target database. They are **not** bundled in `references/DEPLOY_IRQL_FUNCTIONS.md`. Use `.show functions` to verify availability before including in a pipeline.

| Function                                                     | Operation                         | Key Property  |
| ------------------------------------------------------------ | --------------------------------- | ------------- |
| `Extract_Node_Email_Sender_Domain(T, displayName)`           | Adds `Domain` to node props       | `EmailSender` |
| `Extract_Node_Employee_Firstname(T, displayName)`            | Adds `Firstname` to node props    | `Name`        |
| `Extract_Node_Event_Network_Domain(T, displayName)`          | Adds `DomainName` to node props   | `Url`         |
| `Enrich_Node_Ip_Employee(T, displayName)`                    | Adds employee info to IP nodes    | `ClientIp`    |
| `Enrich_Node_Username_Employee(T, displayName)`              | Adds employee info to user nodes  | `Username`    |
| `Enrich_Node_Event_Authentication_Username(T, displayName)`  | Adds auth context                 | `Username`    |
| `Enrich_Node_Ip_Domain(T, displayName)`                      | Adds DNS domains                  | `ClientIp`    |
| `Enrich_Node_Ip_Event_NetworkOutbound(T, displayName)`       | Adds outbound events              | `ClientIp`    |
| `Enrich_Graph_Ip_Employee(T, mappingJson)`                   | Expands graph with employee nodes | `ClientIp`    |
| `Enrich_Graph_Username_Employee(T, mappingJson)`             | Expands graph with employee nodes | `Username`    |
| `Enrich_Graph_Event_Authentication_Username(T, mappingJson)` | Expands with auth nodes           | `Username`    |

## Mapping JSON Schema

The JSON mapping has two arrays: `node_types` and `edges`.

### `node_types[]`

| Field         | Required | Description                                         |
| ------------- | -------- | --------------------------------------------------- |
| `type`        | Yes      | Node type label (e.g. `"User"`, `"Host"`, `"IP"`)   |
| `id`          | Yes      | Prefix for node ID; usually same as type            |
| `key`         | Yes      | Column name whose value becomes the node's identity |
| `props`       | Yes      | Array of columns to carry as node properties        |
| `defaults`    | No       | Object of fallback values for null/empty properties |
| `defIcon`     | No       | Default icon URL for this node type                 |
| `displayName` | No       | Column to use for display label (defaults to `id`)  |
| `color`       | No       | Column to source color from                         |
| `size`        | No       | Column to source size from                          |

### `edges[]`

| Field         | Required | Description                                               |
| ------------- | -------- | --------------------------------------------------------- |
| `type`        | Yes      | Edge type label (e.g. `"AuthenticatesTo"`, `"SentEmail"`) |
| `source`      | Yes      | `{"id": "<prefix>", "type": "<NodeType>"}`                |
| `target`      | Yes      | `{"id": "<prefix>", "type": "<NodeType>"}`                |
| `props`       | No       | Array of columns to carry as edge properties              |
| `displayName` | No       | Column for edge label                                     |
| `color`       | No       | Column for edge color                                     |

### Icon Repository

Use icons from `https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/`:

- IP: `Public-IP-Addresses-(Classic).svg`
- Host/VM: `Virtual-Machine.svg`
- User: `Users.svg`
- Email: `Mailbox.svg` (or `azure-cds/command-1070-Mail.svg`)
- Process: `App-Services.svg`
- File: `Storage-Accounts.svg`
- Alert: `Activity-Log.svg`
- Domain: `DNS-Zones.svg`

## Mapping Generation Rules

Given the supplied query columns and the user's graph description, generate the mapping JSON by:

1. **Identify entities** -> each distinct noun becomes a `node_type`
2. **Identify relationships** -> each verb/preposition becomes an `edge`
3. **Map to columns** -> use actual columns produced by the supplied query; never assume unavailable columns
4. **Set direction** -> source is the actor, target is the acted-upon
5. **Add properties** -> include columns relevant to investigation (timestamps, results, hashes)
6. **Assign icons** -> pick from the icon set above based on entity type

### Column Reference (IRQL unified schema)

| Entity        | Key Column       | Available Props                                               |
| ------------- | ---------------- | ------------------------------------------------------------- |
| User          | `Username`       | `Username`, `Name`, `Role`, `Email`                           |
| Host          | `Hostname`       | `Hostname`                                                    |
| IP            | `ClientIp`       | `ClientIp`                                                    |
| Email Message | `Subject`        | `EnvTime`, `Subject`, `Verdict`, `Url`                        |
| Sender        | `EmailSender`    | `EmailSender`, `Domain`                                       |
| Recipient     | `EmailRecipient` | `EmailRecipient`                                              |
| Process       | `ProcessName`    | `EnvTime`, `ProcessName`, `ProcessCommandLine`, `ProcessHash` |
| File          | `Filename`       | `EnvTime`, `Filename`, `Path`, `Sha256`                       |
| Domain        | `DomainName`     | `DomainName`                                                  |
| Auth Event    | (synthetic ID)   | `EnvTime`, `UserAgent`, `Result`, `Description`               |

## Function Selection

1. Start with the supplied KQL/IRQL tabular pipeline.
2. Use `Lift_To_Graph(mapping)` to create graph entities.
3. Add `Extract_Node_*`, `Enrich_Node_*`, or `Enrich_Graph_*` only when requested and compatible with the mapped keys.
4. Add `Graph_Fold_By_Property()` only when grouping/collapse is requested.
5. End visual output with `Graph_Render_View()`.
6. Preflight the exact stored functions selected for the pipeline.

## Pipeline Pattern

```kql
// 1. Preserve the supplied KQL or IRQL query
<input query>
// 2. Lift to graph
| invoke Lift_To_Graph(<mapping_json>)
// 3. Optionally extract or enrich graph entities
| invoke <Extract_Node_* | Enrich_Node_* | Enrich_Graph_*>()
// 4. Optionally fold nodes when requested
| invoke Graph_Fold_By_Property("<NodeType>", "<PropertyName>")
// 5. Render
| invoke Graph_Render_View()
```

## Examples

For additional prompts and worked examples, see [references/EXAMPLES.md](references/EXAMPLES.md).

### Authentication graph: IP -> AuthEvent -> User -> Host

**Input query**: `Get_Event_Authentication_All | where Result == "Failed Login" | take 200`

**Graph request**: "Show IPs, authentication events, users, and hosts; fold events by result."

```kql
let auth_mapping = '{"node_types":[{"type":"SrcIp","id":"SrcIp","key":"ClientIp","props":["ClientIp"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Public-IP-Addresses-(Classic).svg"},{"type":"Host","id":"Host","key":"Hostname","props":["Hostname"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Virtual-Machine.svg"},{"type":"User","id":"User","key":"Username","props":["Username"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Users.svg"},{"type":"AuthEvent","id":"AuthEvent","key":"AuthEventId","props":["AuthEventId","EnvTime","UserAgent","Result","Description"],"defaults":{"Result":"unknown"},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Activity-Log.svg"}],"edges":[{"type":"RequestsAuth","source":{"id":"SrcIp","type":"SrcIp"},"target":{"id":"AuthEvent","type":"AuthEvent"},"props":["EnvTime"]},{"type":"TargetsUser","source":{"id":"AuthEvent","type":"AuthEvent"},"target":{"id":"User","type":"User"},"props":["EnvTime"]},{"type":"AgainstHost","source":{"id":"AuthEvent","type":"AuthEvent"},"target":{"id":"Host","type":"Host"},"props":["EnvTime"]}]}';
Get_Event_Authentication_All
| extend AuthEventId = strcat(Username, "_", Hostname, "_", EnvTime)
| where Result == "Failed Login"
| take 200
| invoke Lift_To_Graph(auth_mapping)
| invoke Graph_Fold_By_Property("AuthEvent", "Result")
| invoke Graph_Render_View()
```

### Email graph: Sender -> Message -> Recipient

**Input query**: `Get_Email_All | take 400`

**Graph request**: "Visualize sender-to-message-to-recipient flow and fold messages by verdict."

```kql
let mail_mapping = '{"node_types":[{"type":"EmailMessage","id":"Message","key":"Subject","props":["EnvTime","Subject","Verdict"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Media-File.svg"},{"type":"Sender","id":"Email","key":"EmailSender","props":["EmailSender"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-cds/command-1070-Mail.svg"},{"type":"Recipient","id":"Email","key":"EmailRecipient","props":["EmailRecipient"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-cds/command-1070-Mail.svg"}],"edges":[{"type":"SentBy","source":{"id":"Message","type":"EmailMessage"},"target":{"id":"Email","type":"Sender"},"props":["EnvTime","Verdict"]},{"type":"DeliveredTo","source":{"id":"Message","type":"EmailMessage"},"target":{"id":"Email","type":"Recipient"},"props":["EnvTime","Verdict"]}]}';
Get_Email_All
| take 400
| invoke Lift_To_Graph(mail_mapping)
| invoke Graph_Fold_By_Property("EmailMessage", "Verdict")
| invoke Graph_Render_View()
```

### Suspicious domain investigation (end-to-end)

**Basic source request**: "Use outbound network events for these suspicious domains and graph IP-to-domain connections enriched with employee names."

This is the limited fallback: one known selector, one extractor, and one direct filter.

```kql
let suspicious_domain_mapping = '{"node_types":[{"type":"IP","id":"IP","key":"ClientIp","props":["ClientIp"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Public-IP-Addresses-(Classic).svg"},{"type":"Domain","id":"Domain","key":"DomainName","props":["DomainName"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/DNS-Zones.svg"}],"edges":[{"type":"ConnectsTo","source":{"id":"IP","type":"IP"},"target":{"id":"Domain","type":"Domain"},"props":["EnvTime"]}]}';
Get_Event_NetworkOutbound
| invoke Extract_Event_Network_Domain()
| where DomainName has_any ("raisinkanes.com", "nothing-to-see-here.net", "totally-legit-domain.com")
| invoke Lift_To_Graph(suspicious_domain_mapping)
| invoke Enrich_Node_Ip_Employee("Name")
| invoke Graph_Fold_By_Property("Domain", "DomainName")
| invoke Graph_Render_View()
```

### Process execution graph: User -> Process -> ParentProcess

**Input query**: `Get_Event_Process_All | where ProcessCommandLine has "powershell" | take 300`

**Graph request**: "Visualize process, parent process, host, and user relationships."

```kql
let proc_mapping = '{"node_types":[{"type":"Process","id":"Proc","key":"ProcessName","props":["ProcessName","ProcessCommandLine","ProcessHash"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/App-Services.svg"},{"type":"ParentProcess","id":"Proc","key":"ParentProcessName","props":["ParentProcessName","ParentProcessHash"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/App-Services.svg"},{"type":"Host","id":"Host","key":"Hostname","props":["Hostname"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Virtual-Machine.svg"},{"type":"User","id":"User","key":"Username","props":["Username"],"defaults":{},"defIcon":"https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Users.svg"}],"edges":[{"type":"SpawnedBy","source":{"id":"Proc","type":"Process"},"target":{"id":"Proc","type":"ParentProcess"},"props":["EnvTime"]},{"type":"RanOn","source":{"id":"Proc","type":"Process"},"target":{"id":"Host","type":"Host"},"props":["EnvTime"]},{"type":"ExecutedBy","source":{"id":"Proc","type":"Process"},"target":{"id":"User","type":"User"},"props":["EnvTime"]}]}';
Get_Event_Process_All
| where ProcessCommandLine has "powershell"
| take 300
| invoke Lift_To_Graph(proc_mapping)
| invoke Graph_Render_View()
```

## Query Results -> Mapping Translation

When the user supplies a query and describes the graph:

1. Inspect the query's final output columns
2. Parse the entity nouns and relationship verbs
3. Generate the mapping JSON using only those columns
4. Preserve the supplied pipeline and append `Lift_To_Graph()`
5. Include `Graph_Render_View()` at the end
6. If the user mentions grouping/collapsing and the function exists, add `Graph_Fold_By_Property()`

Output the complete KQL -- the supplied query plus mapping JSON inline as a string `let` binding -- after the required-function preflight passes. Clearly mark unverified function dependencies when the target database cannot be checked.

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
