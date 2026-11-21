---
name: azure-kusto-graph
description: "Build and query Kusto graphs from natural language. Covers transient graphs (make-graph), persistent graph models/snapshots, pattern matching (graph-match), shortest paths, connected components, and graph-to-table export. Generates the edges-first thinking: define edges, define node lookups, union, make-graph. WHEN: make-graph, graph-match, graph-shortest-paths, graph-to-table, graph-mark-components, persistent graph, graph model, graph snapshot, build a graph from data, find paths between nodes, pattern matching in graph, connected components, transient graph, Kusto graph, KQL graph."
license: MIT
metadata:
  author: Microsoft
  version: "1.2.1"
---

# Kusto Graph Semantics

Build transient and persistent graphs from tabular data using KQL graph operators. This skill translates natural language into the edges-first graph construction pattern and graph query operators.

## Activation Triggers

Use this skill when the user:

- Wants to build a graph from tabular data (`make-graph`)
- Asks to find patterns, paths, or relationships in data
- Mentions `graph-match`, `graph-shortest-paths`, `graph-to-table`, `graph-mark-components`
- Wants to create a persistent graph model or snapshot
- Says "build a graph", "find the shortest path", "find connected components", "show relationships"
- Asks about transient vs persistent graphs

**Not a natural-language-to-KQL converter.** The input should generally be a working KQL query whose results the user wants converted to a graph, plus a natural-language description of the desired graph structure. Basic NL source requests are supported only when they map directly to a known table with obvious columns. For general NL-to-KQL conversion, use a dedicated query-generation skill (available separately).

**Complementary skills:**

- `azure-kusto-irql` -- composable security query primitives that produce the tabular inputs for graphs
- `azure-kusto-irql-graph` -- IRQL's `Lift_To_Graph` JSON mapping system for richly-typed, icon-decorated graphs in Kusto Explorer

## The Edges-First Approach

The fundamental pattern for building graphs in Kusto:

```
1. Define your EDGES       -> src --> dest, with relationship type/properties
2. Define your NODE LOOKUPS -> display names, types, properties for each node ID
3. Union edge types         -> if you have multiple relationship types
4. Union node lookups       -> if you have multiple node types
5. Call make-graph          -> edges | make-graph Source --> Target with nodes on nodeId
```

This is how to think in `make-graph`. Edges are the relationships you care about. Nodes are lookup tables that give those IDs a face -- display names, types, properties.

## Graph Operators Reference

### `make-graph` -- Build a graph from tables

```kql
Edges | make-graph SourceId --> TargetId with Nodes on NodeId
```

- `Edges`: tabular source where each row is an edge
- `SourceId --> TargetId`: columns containing source and target node IDs
- `with Nodes on NodeId`: optional node property table joined by ID
- Supports multiple node tables: `with Nodes1 on Id1, Nodes2 on Id2`
- Nodes appearing in edges but missing from the node table get empty properties

### `graph-match` -- Find patterns

```kql
G | graph-match (a)-[e]->(b) where <constraints> project <output>
```

Pattern notation:

| Element          | Named         | Anonymous    |
| ---------------- | ------------- | ------------ |
| Node             | `(n)`         | `()`         |
| Edge left->right | `-[e]->`      | `-->`        |
| Edge right->left | `<-[e]-`      | `<--`        |
| Any direction    | `-[e]-`       | `--`         |
| Variable length  | `-[e*1..5]->` | `-[*1..5]->` |

Multi-hop patterns: `(a)-[e1]->(b)-[e2]->(c)`
Star patterns: `(a)--(center)--(b), (c)--(center)--(d)`
Cycles control: `cycles = all | none | unique_edges` (default: `unique_edges`)

### `graph-shortest-paths` -- Find shortest paths

```kql
G | graph-shortest-paths (start)-[e*1..20]->(end)
      where start.name == "Alice" and end.name == "Server01"
      project Path = e, Length = array_length(e)
```

- Requires at least one variable-length edge
- `output = any` (default, one path per pair) or `output = all` (all equal-length shortest paths)
- Variable-length edge properties returned as dynamic arrays

### `graph-to-table` -- Export graph to tables

```kql
G | graph-to-table nodes                                     // export nodes
G | graph-to-table edges                                     // export edges
G | graph-to-table nodes as N, edges as E                    // export both
G | graph-to-table nodes with_node_id=Id                     // include node hash ID
G | graph-to-table edges with_source_id=Src with_target_id=Tgt  // include edge endpoint IDs
```

### `graph-mark-components` -- Find connected components

```kql
G | graph-mark-components with_component_id=ComponentId
  | graph-to-table nodes
  | summarize Members = make_list(name) by ComponentId
```

Assigns a `ComponentId` to each node. Nodes in the same connected component share the same ID.

### `graph()` function -- Query persistent graphs

```kql
graph("MyGraphModel")                              // latest snapshot
graph("MyGraphModel", "Snapshot_2025_01")           // specific snapshot
graph("MyGraphModel", true)                         // transient from model definition
```

## Transient Graphs

Created dynamically during query execution. No setup required. Ideal for ad-hoc analysis, exploration, and prototyping.

### Template: Basic two-entity graph

```kql
// 1. Define edges
let edges = <SourceTable>
    | summarize <aggregations> by SourceCol, TargetCol;
// 2. Define node lookups
let source_nodes = edges
    | distinct SourceCol
    | project nodeId = SourceCol, label = SourceCol, nodeType = "<SourceType>";
let target_nodes = edges
    | distinct TargetCol
    | project nodeId = TargetCol, label = TargetCol, nodeType = "<TargetType>";
let all_nodes = union source_nodes, target_nodes;
// 3. Build and query the graph
edges
| make-graph SourceCol --> TargetCol with all_nodes on nodeId
| graph-match (s)-[e]->(t)
    where <constraints>
    project Source = s.label, Target = t.label, <edge properties>
```

### Template: Multi-relationship graph

```kql
// Multiple edge types -> union them with a common schema
let auth_edges = AuthEvents
    | project Source = username, Target = hostname, edgeType = "authenticates", ts = timestamp;
let net_edges = NetworkEvents
    | project Source = src_ip, Target = url, edgeType = "connects", ts = timestamp;
let all_edges = union auth_edges, net_edges;
// Node lookups from all sources
let user_nodes = Employees | project nodeId = username, label = name, nodeType = "User";
let host_nodes = AuthEvents | distinct hostname | project nodeId = hostname, label = hostname, nodeType = "Host";
let all_nodes = union user_nodes, host_nodes;
all_edges
| make-graph Source --> Target with all_nodes on nodeId
```

## Persistent Graphs

For large-scale, reusable graphs. Stored in database metadata. Support snapshots for historical comparison.

> **Safety:** Creating or altering graph models and snapshots modifies the database. Always show the exact command and confirm with the user before executing `.create-or-alter graph_model` or `.make graph_snapshot`.

### Step 1: Create a graph model

```kql
.create-or-alter graph_model SecurityGraph
{
  "Schema": {
    "Nodes": {
      "User": {"name": "string", "role": "string"},
      "Host": {"hostname": "string"},
      "IP":   {"ip": "string"}
    },
    "Edges": {
      "AuthenticatesTo": {"timestamp": "datetime", "result": "string"},
      "ConnectsFrom":    {"timestamp": "datetime"}
    }
  },
  "Definition": {
    "Steps": [
      {
        "Kind": "AddNodes",
        "Query": "Employees | project name, role",
        "NodeIdColumn": "name",
        "Labels": ["User"]
      },
      {
        "Kind": "AddNodes",
        "Query": "AuthenticationEvents | distinct hostname | project hostname",
        "NodeIdColumn": "hostname",
        "Labels": ["Host"]
      },
      {
        "Kind": "AddEdges",
        "Query": "AuthenticationEvents | project username, hostname, timestamp, result",
        "SourceColumn": "username",
        "TargetColumn": "hostname",
        "Labels": ["AuthenticatesTo"]
      }
    ]
  }
}
```

### Step 2: Create a snapshot

```kql
.make graph_snapshot SecurityGraph Snapshot_2025_07
```

### Step 3: Query the snapshot

```kql
graph("SecurityGraph")
| graph-match (user)-[auth]->(host)
    where user.role == "Admin" and auth.result == "Failed Login"
    project User = user.name, Host = host.hostname, Time = auth.timestamp
```

### Management commands

> **Safety:** All control commands below modify or delete database objects. Never execute `.drop`, `.create-or-alter graph_model`, or `.make graph_snapshot` automatically. Always show the exact command, cluster, database, and affected object, then require explicit user confirmation before execution.

```kql
.show graph_models                        // list all models
.show graph_model SecurityGraph           // show model details
.show graph_snapshots SecurityGraph       // list snapshots
.drop graph_snapshot SecurityGraph Snapshot_2025_07  // delete a snapshot (CONFIRM FIRST)
.drop graph_model SecurityGraph           // delete model and all snapshots (CONFIRM FIRST)
```

## Transient vs Persistent: When to Use Which

| Factor         | Transient (`make-graph`)  | Persistent (`graph()`)           |
| -------------- | ------------------------- | -------------------------------- |
| Setup          | None -- inline in query   | Create model + snapshot          |
| Lifetime       | Query execution only      | Stored in database metadata      |
| Data freshness | Always current            | Snapshot at creation time        |
| Scale          | Limited by query memory   | Enterprise-scale                 |
| Reuse          | Rebuilt every query       | Shared across users/queries      |
| Best for       | Ad-hoc hunts, prototyping | Production workflows, dashboards |

## Security & Threat Hunting Examples

### Authentication graph: who logged into what from where

```kql
let auth_edges = AuthenticationEvents
    | summarize
        logins = count(),
        fails = countif(result == "Failed Login")
      by src_ip, username, hostname;
let ip_nodes = auth_edges | distinct src_ip
    | project nodeId = src_ip, label = src_ip, nodeType = "IP";
let user_nodes = auth_edges | distinct username
    | project nodeId = username, label = username, nodeType = "User";
let host_nodes = auth_edges | distinct hostname
    | project nodeId = hostname, label = hostname, nodeType = "Host";
let all_nodes = union ip_nodes, user_nodes, host_nodes;
// IP -> User edges
let ip_user = auth_edges
    | project Source = src_ip, Target = username, logins, fails;
// User -> Host edges
let user_host = auth_edges
    | project Source = username, Target = hostname, logins, fails;
union ip_user, user_host
| make-graph Source --> Target with all_nodes on nodeId
| graph-match (ip)-[e1]->(user)-[e2]->(host)
    where e2.fails > 20
    project
        IP = ip.label,
        User = user.label,
        Host = host.label,
        Failures = e2.fails
| order by Failures desc
```

### Lateral movement detection: users sharing compromised hosts

```kql
// Pattern: (user1)-[auth1]->(host)<-[auth2]-(user2)
// Two users both failing on the same host = possible credential spray
let edges = AuthenticationEvents
    | summarize fails = countif(result == "Failed Login"), logins = count()
      by username, hostname;
let nodes = union
    (edges | distinct username | project nodeId = username, nodeType = "User"),
    (edges | distinct hostname | project nodeId = hostname, nodeType = "Host");
edges
| make-graph username --> hostname with nodes on nodeId
| graph-match (u1)-[e1]->(h)<-[e2]-(u2)
    where u1.nodeId != u2.nodeId and e1.fails > 10 and e2.fails > 10
    project
        User1 = u1.nodeId, User2 = u2.nodeId,
        SharedHost = h.nodeId,
        User1Fails = e1.fails, User2Fails = e2.fails
| distinct User1, SharedHost, User2, User1Fails, User2Fails
| order by User1Fails + User2Fails desc
```

### Shortest attack path

```kql
let edges = SecurityEvents
    | project Source = source_entity, Target = target_entity, action, timestamp;
let nodes = union
    (edges | distinct Source | project nodeId = Source),
    (edges | distinct Target | project nodeId = Target);
edges
| make-graph Source --> Target with nodes on nodeId
| graph-shortest-paths (start)-[e*1..10]->(end)
    where start.nodeId == "ExternalIP_1.2.3.4" and end.nodeId == "DatabaseServer"
    project
        PathLength = array_length(e),
        Actions = e.action,
        Hops = e.Target
```

### Connected components: find isolated clusters

```kql
let edges = NetworkFlows
    | project Source = src_ip, Target = dst_ip;
let nodes = union
    (edges | distinct Source | project nodeId = Source),
    (edges | distinct Target | project nodeId = Target);
edges
| make-graph Source --> Target with nodes on nodeId
| graph-mark-components with_component_id = ComponentId
| graph-to-table nodes
| summarize Members = make_list(nodeId), Size = count() by ComponentId
| order by Size desc
```

### Visualize in Kusto Explorer

End a query at `make-graph` (without piping to `graph-match`) to trigger Kusto Explorer's interactive graph visualization window:

```kql
edges
| make-graph Source --> Target with all_nodes on nodeId
// <- stop here. Kusto Explorer renders the graph visually.
```

To flatten back to a table for dashboards or export, pipe through `graph-match | project` or `graph-to-table`.

## Using with IRQL

When working with security data, consider using IRQL selectors (`Get_*`) from the `azure-kusto-irql` skill as the data source. IRQL gives you a unified schema without memorizing raw table names or column mappings. For rich visualization with icons and node folding, the `azure-kusto-irql-graph` skill's `Lift_To_Graph` is the faster path.

| Approach                                               | Best For                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Raw `make-graph` (this skill)                          | Full control, persistent models, shortest paths, connected components, custom schemas |
| `Lift_To_Graph` (`azure-kusto-irql-graph`)             | Quick icon-decorated visualization in Kusto Explorer, node folding                    |
| IRQL `Get_*` -> `make-graph`                           | IRQL's unified schema as input, then raw graph operators for analysis                 |
| IRQL `Get_*` -> `Lift_To_Graph` -> `Graph_Render_View` | Fastest path from question to visual graph                                            |

> **Note:** `Lift_To_Graph`, `Graph_Render_View`, and `Graph_Fold_By_Property` are stored functions, not built-in operators. They are pre-deployed on the kc7001 example cluster but may need deployment on other clusters. See `azure-kusto-irql-graph/references/DEPLOY_IRQL_FUNCTIONS.md` for function definitions and deployment instructions.

### Example: IRQL selectors -> make-graph -> shortest path

IRQL handles the data retrieval; `make-graph` handles the graph analysis. This finds the shortest path from an external IP to a mail server through auth events:

```kql
// IRQL provides unified columns (ClientIp, Hostname, Username, Result)
let auth = Get_Event_Authentication_All
    | where Result == "Failed Login";
let edges = auth
    | summarize Failures = count() by ClientIp, Hostname;
let nodes = union
    (edges | distinct ClientIp | project nodeId = ClientIp, nodeType = "IP"),
    (edges | distinct Hostname | project nodeId = Hostname, nodeType = "Host");
edges
| make-graph ClientIp --> Hostname with nodes on nodeId
| graph-shortest-paths (src)-[e*1..5]->(dest)
    where src.nodeType == "IP" and dest.nodeId == "MAIL-SERVER01"
    project
        SourceIP = src.nodeId,
        PathLength = array_length(e),
        Hops = e.Hostname
```

### Example: IRQL selectors -> make-graph -> connected components

Find clusters of IPs and domains that are interconnected -- potential C2 infrastructure:

```kql
let dns = Get_Dns_All;
let edges = dns | project Source = ClientIp, Target = Domain;
let nodes = union
    (edges | distinct Source | project nodeId = Source, nodeType = "IP"),
    (edges | distinct Target | project nodeId = Target, nodeType = "Domain");
edges
| make-graph Source --> Target with nodes on nodeId
| graph-mark-components with_component_id = ComponentId
| graph-to-table nodes
| summarize
    IPs = make_set_if(nodeId, nodeType == "IP"),
    Domains = make_set_if(nodeId, nodeType == "Domain"),
    Size = count()
  by ComponentId
| where Size > 3
| order by Size desc
```

### Example: IRQL + make-graph integration

See [references/EXAMPLES.md](references/EXAMPLES.md) for multi-source investigation graphs combining IRQL selectors with `make-graph`, and `Lift_To_Graph` visual graph examples.

## Practical Usage Scenarios

See [references/SCENARIOS.md](references/SCENARIOS.md) for full worked examples including:

- Reachability analysis (shortest paths to critical assets)
- Network segmentation validation (connected components)
- Blast radius of compromised accounts (variable-length path matching)
- Persistent graph models for SOC teams (graph_model + snapshots)

## MCP Tools Used

| Tool                     | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `kusto_query`            | Execute KQL queries including `make-graph`, `graph-match`, and management commands |
| `kusto_table_schema_get` | Discover table columns before building edge/node projections                       |
| `kusto_cluster_list`     | List available ADX clusters                                                        |
| `kusto_database_list`    | List databases in a cluster                                                        |

## Opening Queries in Kusto Explorer (Windows Only)

> **Optional convenience feature.** The default workflow is to output the KQL in chat and let the user copy it into Kusto Explorer or the VS Code Kusto extension manually. Auto-launch is opt-in only.

### Default: Output KQL in Chat

Always output the complete KQL with Step 1 (connect) and Step 2 (query) clearly labeled:

```
// Step 1: Connect to your cluster (skip if already connected)
// Example: uncomment to connect to the KC7 training cluster
// #connect cluster('kc7001.eastus.kusto.windows.net').database('ValdyTimes')
// Or replace with your own cluster:
// #connect cluster('<YOUR_CLUSTER>').database('<YOUR_DATABASE>')

// Step 2: Run the query below
<KQL_QUERY ending at make-graph>
```

Then immediately below, output an **ADX Web Explorer version** that appends `| graph-to-table nodes as N, edges as E` since ADX Web Explorer cannot render `make-graph` directly:

```
// ADX Web Explorer version (tabular output):
<SAME_QUERY>
| graph-to-table nodes as N, edges as E
```

This ensures the output works in both Kusto Explorer (graph visualization) and ADX Web Explorer (tabular results) without the user having to modify anything.

### Optional: Save and Launch

If the user asks to save or open the query in Kusto Explorer, follow the procedure in [references/KUSTO_EXPLORER_LAUNCH.md](references/KUSTO_EXPLORER_LAUNCH.md). Key rules:

- **Always** use `ask_user` to confirm before writing files or launching executables
- **Always** display the file contents in chat so the user can review before opening
- **Never** use shell interpolation or here-strings — write files via `Set-Content`/`Add-Content`
- **Never** encode queries into browser URLs
- On macOS/Linux, save the `.kql` file and suggest the VS Code Kusto extension or ADX Web Explorer

For `make-graph` visualization (the graph window), the query must **end at `make-graph`** — do not pipe to `graph-match`. Kusto Explorer only opens the graph visualization window when the output is a graph object, not a table.
