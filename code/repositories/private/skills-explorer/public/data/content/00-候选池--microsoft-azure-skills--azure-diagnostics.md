---
name: azure-diagnostics
description: "Debug Azure production issues on Azure using AppLens, Azure Monitor, resource health, and safe triage. WHEN: debug production issues, troubleshoot app service, app service high CPU, app service deployment failure, troubleshoot container apps, troubleshoot functions, troubleshoot AKS, VM RDP, Linux SSH, VM black screen, can't connect to VM, reset VM password, NSG or firewall blocking, kubectl cannot connect, kube-system/CoreDNS failures, pod pending, crashloop, node not ready, upgrade failures, analyze logs, KQL, insights, image pull failures, cold start issues, health probe failures, resource health, root cause of errors, troubleshoot event hubs, troubleshoot service bus, messaging SDK error, AMQP connection failure, message lock lost, service bus dead letter."
license: MIT
metadata:
  author: Microsoft
  version: "1.2.6"
---

# Azure Diagnostics

> **AUTHORITATIVE GUIDANCE — MANDATORY COMPLIANCE**
>
> This document is the **official source** for debugging and troubleshooting Azure production issues. Follow these instructions to diagnose and resolve common Azure service problems systematically.

## Triggers

Activate this skill when user wants to:

- Debug or troubleshoot production issues
- Diagnose errors in Azure services
- Analyze application logs or metrics
- Fix image pull, cold start, or health probe issues
- Investigate why Azure resources are failing
- Find root cause of application errors
- Troubleshoot App Service issues (high CPU, deployment failures, crashes, slow responses, TLS/custom domains)
- Respond to prompts like "troubleshoot app service", "app service high CPU", or "app service deployment failure"
- Troubleshoot Azure Function Apps (invocation failures, timeouts, binding errors)
- Find the App Insights or Log Analytics workspace linked to a Function App
- Troubleshoot AKS clusters, nodes, pods, ingress, or Kubernetes networking issues
- Troubleshoot Azure VM connectivity issues (RDP/SSH failures, port 3389/22 timeouts, NSG or firewall blocking, credential resets)
- Troubleshoot Azure Messaging SDK issues (Event Hubs, Service Bus connection failures, AMQP errors, message lock issues)

## Rules

1. Start with systematic diagnosis flow
2. Use AppLens (MCP) for AI-powered diagnostics when available
3. Check resource health before deep-diving into logs
4. Select appropriate troubleshooting guide based on service type
5. Document findings and attempted remediation steps
6. Route AKS incidents to the dedicated AKS troubleshooting document

---

## Quick Diagnosis Flow

1. **Identify symptoms** - What's failing?
2. **Check resource health** - Is Azure healthy?
3. **Review logs** - What do logs show?
4. **Analyze metrics** - Performance patterns?
5. **Investigate recent changes** - What changed?

---

## Troubleshooting Guides by Service

| Service            | Common Issues                                                                                 | Reference                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Container Apps** | Image pull failures, cold starts, health probes, port mismatches                              | [container-apps/](references/container-apps/README.md)                           |
| **App Service**    | High CPU, deployment failures, crashes, slow responses, TLS/custom domains                    | [app-service/](references/app-service/README.md)                                 |
| **Function Apps**  | App details, invocation failures, timeouts, binding errors, cold starts, missing app settings | [functions/](references/functions/README.md)                                     |
| **AKS**            | Cluster access, nodes, `kube-system`, scheduling, crash loops, ingress, DNS, upgrades         | [AKS Troubleshooting](troubleshooting/aks/aks-troubleshooting.md)                |
| **Compute**        | VM RDP/SSH connectivity, NSG/firewall blocks, credential resets, VM agent/tooling issues      | [VM Connectivity Troubleshooting](troubleshooting/compute/vm-troubleshooting.md) |
| **Messaging**      | Event Hubs & Service Bus SDK errors, AMQP failures, message lock, connectivity                | [Messaging Troubleshooting](troubleshooting/messaging/README.md)                 |

---

## Routing

- Keep Container Apps and Function Apps diagnostics in this parent skill.
- Route active AKS incidents, AKS-specific intake, evidence gathering, and remediation guidance to [AKS Troubleshooting](troubleshooting/aks/aks-troubleshooting.md).
- Route Azure VM RDP/SSH connectivity, NSG/firewall, credential reset, and VM agent troubleshooting to [VM Connectivity Troubleshooting](troubleshooting/compute/vm-troubleshooting.md).
- Route Azure Messaging SDK troubleshooting (Event Hubs, Service Bus) to [Messaging Troubleshooting](troubleshooting/messaging/README.md).

---

## Quick Reference

### Common Diagnostic Commands

```bash
# Check resource health
az resource show --ids RESOURCE_ID
# View activity log
az monitor activity-log list -g RG --max-events 20
# Container Apps logs
az containerapp logs show --name APP -g RG --follow
# Function App logs (query App Insights traces)
az monitor app-insights query --apps APP-INSIGHTS -g RG \
  --analytics-query "traces | where timestamp > ago(1h) | order by timestamp desc | take 50"
```

### AppLens (MCP Tools)

For AI-powered diagnostics, use:

```
mcp_azure_mcp_applens
  intent: "diagnose issues with <resource-name>"
  command: "diagnose"
  parameters:
    resourceId: "<resource-id>"

Provides:
- Automated issue detection
- Root cause analysis
- Remediation recommendations
```

### Azure Monitor (MCP Tools)

For querying logs and metrics:

```
mcp_azure_mcp_monitor
  intent: "query logs for <resource-name>"
  command: "logs_query"
  parameters:
    workspaceId: "<workspace-id>"
    query: "<KQL-query>"
```

See [kql-queries.md](references/kql-queries.md) for common diagnostic queries.

---

## Check Azure Resource Health

### Using MCP

```
mcp_azure_mcp_resourcehealth
  intent: "check health status of <resource-name>"
  command: "get"
  parameters:
    resourceId: "<resource-id>"
```

### Using CLI

```bash
# Check specific resource health
az resource show --ids RESOURCE_ID

# Check recent activity
az monitor activity-log list -g RG --max-events 20
```

---

## References

- [KQL Query Library](references/kql-queries.md)
- [Azure Resource Graph Queries](references/azure-resource-graph.md)
- [App Service Troubleshooting](references/app-service/README.md)
- [Function Apps Troubleshooting](references/functions/README.md)
- [VM Connectivity Troubleshooting](troubleshooting/compute/vm-troubleshooting.md)
- [Messaging Troubleshooting](troubleshooting/messaging/README.md)
