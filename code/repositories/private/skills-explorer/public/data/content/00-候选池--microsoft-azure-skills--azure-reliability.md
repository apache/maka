---
name: azure-reliability
description: 'Assess and improve the reliability posture of PaaS Applications (Azure Functions and Azure App Service). Scans deployed resources for zone redundancy, ZRS storage, health probes, and multi-region failover. Presents a feature-pivoted checklist, then drives staged remediation (CLI or IaC patches) end-to-end with user confirmation. WHEN: "assess reliability", "check reliability", "zone redundant", "multi-region failover", "high availability", "disaster recovery", "single points of failure", "reliability posture", "resiliency".'
license: MIT
metadata:
  author: Microsoft
  version: "1.1.1"
---

# Azure Reliability Assessment & Configuration

## Quick Reference

| Property             | Details                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Best for             | Reliability posture assessment, zone redundancy enablement, multi-region failover setup  |
| Primary capabilities | Reliability assessment table, Zone Redundancy Configuration, Multi-Region IaC Generation |
| Supported services   | Azure Functions, App Service (Container Apps planned for a future version)               |
| MCP tools            | Azure Resource Graph queries, Azure CLI commands                                         |

## When to Use This Skill

Activate this skill when user wants to:

- "Assess my Function app's reliability"
- "Assess my Web app's reliability"
- "Check the reliability of my resource group" (App Service and Functions resources only)
- "Is my app zone redundant?" (App Service and Functions resources only)
- "Is my app service plan zone redundant?"
- "Make my app zone redundant" (App Service and Functions resources only)
- "Make my app service plan zone redundant"
- "Set up multi-region failover for my app" (App Service and Functions resources only)
- "Check my reliability posture"
- "Find single points of failure" (App Service and Functions resources only)
- "Enable high availability for my app" (App Service and Functions resources only)
- "Check disaster recovery readiness"
- "Improve my app's resilience" (App Service and Functions resources only)

> **Scope note:** This skill currently covers **Azure Functions and Azure App Service** only. If the user asks about Azure Container Apps reliability, acknowledge that support is planned but not yet available, and only proceed with the parts that apply to App Service and Functions resources in scope.

## Prerequisites

- Authentication: user is logged in to Azure via `az login`
- Permissions: Reader access on target subscription/resource group (for assessment)
- Permissions: Contributor access (for configuration changes)
- Azure Resource Graph extension: `az extension add --name resource-graph`

## MCP Tools

| Tool                                   | Purpose                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `mcp_azure_mcp_extension_cli_generate` | Generate `az` CLI commands for resource queries and configuration |
| `mcp_azure_mcp_subscription_list`      | List available subscriptions                                      |
| `mcp_azure_mcp_group_list`             | List resource groups                                              |

Primary query method: Azure Resource Graph via `az graph query` (requires `az extension add --name resource-graph`).

## Assessment Workflow

### Phase 1: Discover Resources

1. **Identify scope** — Ask user for resource group, subscription, or app name
2. **Query Azure Resource Graph** to discover all resources in scope
3. **Classify resources** by service type (Functions, Storage, etc.). If non-Functions compute (App Service sites that aren't Function Apps, Container Apps) is found, **note it but do not deep-dive** — those services are planned for a future version of this skill.

**Important:** Always scope queries to the user's specified resource group or subscription. Add these filters to every Resource Graph query:

- Resource group: `| where resourceGroup =~ '<rg-name>'`
- Subscription: Use `--subscriptions <sub-id>` flag on `az graph query`
- App name: `| where name =~ '<app-name>'`

### Phase 2: Assess Reliability

Two-step assessment: **platform-level discovery first, then per-service deep dive.**

**Step 1 — Platform discovery (find what's there).** Use these to enumerate resources in scope and detect cross-cutting reliability gaps:

| Platform check                                     | Reference                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Zone redundancy — discovery                        | [references/zone-redundancy-checks.md](references/zone-redundancy-checks.md)       |
| Storage redundancy (cross-service)                 | [references/storage-redundancy-checks.md](references/storage-redundancy-checks.md) |
| Multi-region & global load balancers               | [references/multi-region-checks.md](references/multi-region-checks.md)             |
| Front Door / Traffic Manager / App Insights probes | [references/health-probe-checks.md](references/health-probe-checks.md)             |

**Step 2 — Per-service deep dive.** For each compute resource discovered in Step 1, load the matching service reference. The service reference is the single source of truth for that service's plan/SKU rules, assessment queries, CLI commands, IaC patches (Bicep + Terraform + AVM), and reporting hints.

This skill version ships **only the Azure Functions and App Service** per-service references. Other compute services are listed below explicitly so the dispatch logic is unambiguous: if a resource matches an unsupported row, do **not** attempt to load a reference, fabricate CLI commands, or generate IaC patches for it.

| Service detected                                                                                                                                                        | Reference                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Azure Functions (`microsoft.web/serverfarms` with `kind contains 'functionapp'`)                                                                                        | [references/services/functions/reliability.md](references/services/functions/reliability.md)     |
| Azure App Service (non-Functions sites: `microsoft.web/sites` without `kind contains 'functionapp'`, `microsoft.web/serverfarms` without `kind contains 'functionapp'`) | [references/services/app-service/reliability.md](references/services/app-service/reliability.md) |
| Azure Container Apps (`microsoft.app/containerapps`, `microsoft.app/managedenvironments`)                                                                               | ⚪ Not yet shipped — planned for a future version                                                |

> **Handling unsupported services:** If a resource matches an unsupported row above, surface it in the discovery summary, mark it as `⚪ not assessed (planned)` in the Phase 3 table, and skip the per-service remediation steps for it. Do **not** attempt to fabricate CLI commands or IaC patches for those services.

### Phase 3: Generate Reliability Checklist

Present findings as a **feature-pivoted** table: one row per reliability feature (Zone redundancy on compute, Zone-redundant storage, Health probes, Multi-region failover), with a single status indicator and the **specific resources** that are relevant to that feature. This avoids the noise of one-row-per-resource with mostly `n/a` cells. Do **not** assign numeric scores or grades.

```
🔍 Reliability Assessment — {scope}
─────────────────────────────────────────────────────────────────────────────────────────────
Reliability Feature              Status      Resources
─────────────────────────────────────────────────────────────────────────────────────────────
Zone redundancy — compute        🔴 OFF      • plan-web-ii5trxva2ark4 (P1v3)
                                              • plan-ii5trxva2ark4 (FC1)

Zone-redundant storage           🔴 GRS      • stii5trxva2ark4 (defaulted; no SKU set in IaC)

Health probes                    🔴 OFF      • func-api-ii5trxva2ark4 — needs code change (FC1)
                                              • app-web-ii5trxva2ark4 — no health check path

Multi-region failover            🔴 OFF      • Single region (eastus) only — Front Door not configured
─────────────────────────────────────────────────────────────────────────────────────────────

Want me to fix the 🔴 items? I'll do the quick wins first (App
plan zone redundancy + health checks on supported plans), then ask before
storage migration and multi-region setup. (yes/no)
```

**Rules for the table:**

- **Four feature rows, in this order:** Zone redundancy — compute · Zone-redundant storage · Health probes · Multi-region failover. Omit a row entirely only if no resource in scope could ever apply to it.
- **Status column** is one symbol + one short word, no other characters:
  - `🟢 ON` — feature is fully enabled across all relevant resources in scope
  - `🟡 PARTIAL` — some resources have it, some don't (or partial config like liveness-only)
  - `🔴 OFF` — feature is missing on all relevant resources
  - For storage, replace `OFF` with the current SKU when relevant (`🔴 LRS`, `🔴 GRS`, `🟢 ZRS`, `🟢 GZRS`). When no SKU is set in IaC, label as `🔴 GRS` (ARM/AVM default) and note that in the resource line.
- **Resources column** lists only what's relevant to that feature, one bullet per resource:
  - For "needs fixing" resources, include a short inline reason (`(FC1)`, `(defaulted; no SKU set)`, `liveness only`, `needs code change (FC1)`).
  - For resources that are **already ON** for that feature, mention them on the same row with `— already ON` so the user sees credit for what's right.
- **Do not** include `n/a`, `—`, or empty cells. If a feature doesn't apply to any resource in scope, drop the row.
- **Do not** include numeric scores, grades, or point totals.
- End the assessment with a **single yes/no question** that kicks off the staged remediation flow. Do not enumerate the per-resource fix list here — the user will see it after they say yes (Configuration Workflow Step 1).

> **UX Note:** If the assessment finds the app **already has** all core reliability features (zone redundancy, ZRS/GZRS storage, health probes), skip the fix-it question and jump straight to Configuration Workflow [Step 3](#step-3-both-paths-multi-region-followup--ask-and-wait) (Multi-region follow-up). Do **NOT** start any multi-region work without explicit consent.

## Configuration Workflow

When user wants to **fix** findings from the assessment:

> **⛔ ALWAYS confirm with user before executing changes.** Show what will change, any cost implications, and any destructive actions (e.g., environment recreation).

### Step 1: Present Fix Plan + Choose Path

After assessment, if user says "fix it" / "improve my reliability" / "enable zone redundancy":

1. List each fixable finding with the specific action
2. Flag any cost implications or breaking changes
3. **Ask user which path they want:**

```
I'll start with the quick wins (no downtime, fast):

1. ✏️  Enable zone redundancy on plan-ii5trxva2ark4 (Flex Consumption — no cost change)
2. ✏️  Set health check path to /api/health on func-api-ii5trxva2ark4

Then, separately, I'll ask if you want to upgrade storage:

3. 🕒  Upgrade stii5trxva2ark4 from LRS → ZRS (small cost increase, migration takes hours)
   — Required for full zone redundancy, but I'll confirm with you before starting.

How would you like to apply these changes?

  A) Fix now — Run az CLI commands against your live resources (immediate, one-time)
  B) Patch my IaC — Update your Bicep/Terraform files so changes persist across deploys

(If you use azd or Terraform, option B is recommended so `azd up` won't overwrite changes.)
```

### Path A: Fix Now (CLI)

Run fixes against live resources using `az` CLI commands. **Quick wins first, then ask before the slow storage migration.**

The exact CLI commands per service live in the per-service references — pick the one(s) matching the resources discovered in Phase 2:

| Fix                                                            | Reference                                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enable zone redundancy / configure health probes (Functions)   | [references/services/functions/reliability.md](references/services/functions/reliability.md)                                                                       |
| Enable zone redundancy / configure health probes (App Service) | [references/services/app-service/reliability.md](references/services/app-service/reliability.md)                                                                   |
| Upgrade storage replication (cross-service)                    | [references/configure-storage.md](references/configure-storage.md)                                                                                                 |
| Set up multi-region (cross-service)                            | [references/configure-multi-region.md](references/configure-multi-region.md)                                                                                       |
| Platform overview / verification                               | [references/configure-zone-redundancy.md](references/configure-zone-redundancy.md), [references/configure-health-probes.md](references/configure-health-probes.md) |

**Execution order — always quick wins first:**

1. **Zone redundancy on compute** (fast, in-place property update on the App's plan).
2. **Health probes** (Premium / Dedicated only — in-place; for FC1 / Consumption, follow the consent gate in [configure-health-probes.md](references/configure-health-probes.md)).
3. **Verify** the compute changes succeeded before doing anything else.
4. **⛔ STOP — Ask about storage upgrade.** Compute is now zone-redundant, but storage may still be LRS or GRS. Ask the user explicitly:

   ```
   ✅ Compute is now zone-redundant.

   To be **fully zone-redundant**, your storage account also needs to be upgraded:
     • stii5trxva2ark4: currently `Standard_LRS` → needs `Standard_ZRS`

   ⚠️  This is a live storage redundancy conversion:
      • Takes hours to days depending on data volume
      • Small ongoing cost increase (~$0.01/GB/month more)
      • Only supported for Standard general-purpose v2 accounts

   Do you want me to start the storage migration now? (yes / no / later)
   ```

   - **yes** → run `az storage account update --sku Standard_ZRS` (or `migration start` if needed); poll `az storage account show --query sku.name` until it reports `Standard_ZRS`.
   - **no / later** → leave storage as-is; note in the re-assessment that ZR storage remains a gap.

5. **Multi-region** — do NOT auto-run. Handled in **Step 3** below as an explicit follow-up after re-assessment.

> **⚠️ Warning:** If the user uses `azd up` or `terraform apply` later, CLI-only changes may be overwritten by the IaC definitions. Recommend also patching IaC after CLI fixes.

### Path B: Patch IaC

Update the user's Bicep or Terraform files so reliability settings are persistent.

**Step 1: Detect IaC type**

1. Look for `infra/` folder in project root
2. If not found, check project root for `*.bicep` or `*.tf` files
3. If still not found, ask user: "Where are your IaC files located?"
4. Check for `*.bicep` files → use Bicep patching
5. Check for `*.tf` files → use Terraform patching
6. If both exist, ask user which to patch
7. If no IaC exists, fall back to Path A (CLI) and inform user

**Step 2: Classify each fix by risk level**

| Fix                                                    | Risk Level                | What Happens                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zone redundancy (App plan)                             | 🟢 Safe patch             | In-place property update on next deploy                                                                                                                                                                                              |
| Storage LRS → ZRS                                      | 🟡 Pre-migration required | Live storage migration must complete before the IaC SKU change can deploy. **Never bundle with safe patches** — use the two-deploy flow in Steps 3–5.                                                                                |
| Health check path (Basic/Standard/Premium / Dedicated) | 🟢 Safe patch             | In-place update, but causes app restart                                                                                                                                                                                              |
| Health check path (FC1 / Consumption)                  | ⚪ Code-only — ask first  | `healthCheckPath` is unsupported. Adding a health endpoint requires adding an HTTP-triggered `/api/health` function to **app code**. **Always ask the user for explicit consent before touching source code.** Do **not** patch IaC. |

**Step 3: Apply patches in two deploys (quick wins first)**

The IaC patching framework (detection, AVM-module guidance, deploy-order rule, storage SKU patch) lives in:

| IaC Type  | Framework reference                                                          |
| --------- | ---------------------------------------------------------------------------- |
| Bicep     | [references/iac-patching-bicep.md](references/iac-patching-bicep.md)         |
| Terraform | [references/iac-patching-terraform.md](references/iac-patching-terraform.md) |

The actual **per-service compute patches** (Function App plan ZR, App Service Plan ZR, etc.) live in the per-service references — load the matching service file from Phase 2 for the exact Bicep / Terraform / AVM snippets. Only Azure Functions and App Service have per-service references in this skill version; Container Apps is out of scope.

**Deploy 1 — Quick wins only.** Patch the 🟢 Safe items (zone redundancy on the App Service/Function App plan, health probes on Basic/Standard/Premium / Dedicated). Do **NOT** include the storage SKU patch in this deploy.

After patching, **the skill runs the deploy itself** (do not stop and tell the user to run it). Detect the deployment tool and confirm once before executing:

```
📦 Patches applied to your IaC. Ready to deploy:
   Tool detected: azd (found azure.yaml)
   Command:       azd up

Proceed with deployment? (yes / no)
```

On **yes**, run the appropriate command, stream output back to the user, and continue to the next step on success:

- AZD project (has `azure.yaml`): `azd up`
- Bicep-only: `az deployment group create --resource-group <rg> --template-file infra/main.bicep --parameters @infra/main.parameters.json`
- Terraform: `terraform plan -out tfplan` → (show plan summary) → `terraform apply tfplan`

On **no**, stop and report the patched files; do not proceed to Step 4 / Re-Assess.

If deployment fails, surface the error and stop — do not continue to the storage step.

**⛔ STOP — Ask about storage upgrade before Deploy 2.** After Deploy 1 succeeds, ask the user explicitly:

```
✅ Quick-win patches deployed. Compute is now zone-redundant.

To be **fully zone-redundant**, your storage account also needs to be upgraded:
  • stii5trxva2ark4: currently `Standard_LRS` → needs `Standard_ZRS`

⚠️  This is a two-part change:
   1. Live storage migration (`az storage account migration start`) — takes hours to days
   2. A second deploy to update your IaC's storage SKU to match

Do you want me to start the storage migration now? (yes / no / later)
```

- **yes** → the skill runs the migration command itself, polls until complete, then patches the storage SKU in IaC and runs **Deploy 2** (now a no-op confirmation). The user does not need to run anything manually.
- **no / later** → leave the storage SKU patch unapplied. Note in the re-assessment that ZR storage remains a gap; suggest revisiting later.

**Step 4: Storage migration (only if user said yes in Step 3)**

The skill runs these commands itself — do not ask the user to run them. Show progress as you go:

```
🔄 Starting storage migration (this can take up to 72 hours)...

   az storage account migration start --name stii5trxva2ark4 \
     --resource-group rg-example --sku Standard_ZRS --no-wait

   Polling: az storage account show --name stii5trxva2ark4 --query sku.name
   ...
   ✅ Migration complete: sku.name = Standard_ZRS
```

For very long migrations, you may surface a checkpoint to the user ("this is still running, check back later") rather than blocking the entire conversation.

**Step 5: Deploy 2 — storage SKU patch**

After the migration completes, the skill patches the storage SKU in IaC and runs the same deploy command as Step 3 (e.g. `azd up`). This deploy is a no-op confirmation that the IaC matches the live state. Confirm once with the user before executing, then run it directly.

### Step 2 (both paths): Re-Assess

After changes are applied (CLI) or deployed (IaC), automatically re-run the assessment and show the **same feature-pivoted table** as Phase 3, with each feature row's status updated to reflect the new state. Briefly call out what changed since the previous run.

```
🔄 Reliability Re-Assessment — rg-eventhubs-python-jan13 (eastus)
───────────────────────────────────────────────────────────────────────────────────────
Reliability Feature              Status      Resources
───────────────────────────────────────────────────────────────────────────────────────
Zone redundancy — compute        🟢 ON       • plan-ii5trxva2ark4 (FC1)              — now ON
                                             • plan-web-ii5trxva2ark4 (P1v3)         — now ON

Zone-redundant storage           🟢 ZRS      • stii5trxva2ark4                       — GRS → ZRS

Health probes                    🟡 PARTIAL  • func-api-ii5trxva2ark4                — still off (FC1, code change declined)
                                             • app-web-ii5trxva2ark4                 — now ON

Multi-region failover            🔴 OFF      • Single region (eastus) only
───────────────────────────────────────────────────────────────────────────────────────

What changed: Function App and App Service plan zone redundancy, storage replication and health probes on App Service.
(Multi-region offered next — see Step 3.)
```

### Step 3 (both paths): Multi-region follow-up — ASK and WAIT

Multi-region is a significant cost/complexity step. Do **NOT** start it automatically. After re-assessment, only if **all core single-region reliability features are 🟢 ON** (zone-redundant compute, ZRS/GZRS storage, health probes), explicitly ask the user and **wait for their response** before doing anything:

```
🟢 Your app is now fully zone-redundant in {region}.

The next step (optional) is multi-region failover with Azure Front Door:
   • Deploys compute + storage in a second region (paired region recommended)
   • Adds Azure Front Door for global load balancing with health-probe-driven failover
   • Protects against full region outages
   • Estimated additional cost: ~2x compute (active-passive); Front Door ~$35/month base

Do you want me to set up multi-region failover now? (yes / no / later)
```

- **yes** → proceed with [references/configure-multi-region.md](references/configure-multi-region.md). Confirm secondary region choice with the user, then:
  1. Generate the multi-region IaC (Bicep / Terraform additions for the secondary region + Front Door).
  2. Confirm once with the user: `📦 Multi-region IaC generated. Ready to deploy with \`azd up\`. Proceed? (yes / no)`
  3. On **yes**, **the skill runs the deploy itself** (`azd up` / `az deployment group create` / `terraform apply`) and streams output. Do not stop and tell the user to run it.
  4. After successful deploy, run a final re-assessment so the user sees Multi-region failover flip to 🟢 ON.
- **no / later** → leave the deployment as-is. Note that single-region zone-redundant is a reliable end state; multi-region can be revisited anytime.

> **⛔ Do not skip the wait.** Do not generate multi-region IaC, deploy a Front Door, or modify any files until the user has explicitly said yes. If core reliability is not yet all 🟢, do **not** ask about multi-region — finish the core gaps first.

## Priority Classification

| Priority | Criteria                                           | Action               |
| -------- | -------------------------------------------------- | -------------------- |
| Critical | No zone redundancy AND production workload         | Fix immediately      |
| High     | LRS storage on zone-redundant compute              | Fix within days      |
| Medium   | No multi-region (single region but zone-redundant) | Plan for next sprint |
| Low      | Missing health probes or monitoring gaps           | Track and fix        |

## Error Handling

| Error                     | Message             | Remediation                                   |
| ------------------------- | ------------------- | --------------------------------------------- |
| Authentication required   | "Please login"      | Run `az login` and retry                      |
| Access denied             | "Forbidden"         | Confirm Reader/Contributor role assignment    |
| Plan doesn't support ZR   | "Upgrade required"  | Inform user of plan upgrade path + cost delta |
| Region doesn't support AZ | "Region limitation" | Suggest supported regions                     |

## Best Practices

- Run reliability assessments after every significant infrastructure change
- Test failover scenarios periodically (at least quarterly)

## Skill Boundaries

| Action                                | This skill does                                                                              | Hand off to                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Assess reliability posture            | ✅ Yes                                                                                       | —                                                  |
| Recommend improvements                | ✅ Yes                                                                                       | —                                                  |
| Enable zone redundancy (CLI commands) | ✅ Yes                                                                                       | —                                                  |
| Patch Bicep/Terraform for reliability | ✅ Yes                                                                                       | —                                                  |
| Generate multi-region IaC             | ✅ Yes (additions for the secondary region + Front Door)                                     | `azure-prepare` for full new-app IaC scaffolding   |
| Deploy IaC for reliability changes    | ✅ Yes (runs `azd up` / `terraform apply` / `az deployment` itself, after user confirmation) | `azure-deploy` for general/non-reliability deploys |
| Validate pre-deployment               | Reliability checks only                                                                      | `azure-validate` for full validation               |
