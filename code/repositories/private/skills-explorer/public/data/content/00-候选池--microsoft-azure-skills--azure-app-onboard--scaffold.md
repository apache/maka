# Azure App Onboard Scaffold — IaC Generation + Self-Review

Generate deployment-ready infrastructure code from an architecture plan, verify it with adversarial self-review, and bridge to validation — all without deploying.

## Quick Reference

| Property          | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Parent            | [azure-app-onboard](../SKILL.md)                                                                  |
| Best for          | Turning `prepare-plan.json` service list into Bicep templates with secure-by-default patterns     |
| Inputs            | `prepare-plan.json` (services, naming, quotas), `context.json` (overrides, components, repo info) |
| Outputs           | `scaffold-manifest.json`, generated IaC files in `infra/`                                         |
| Pipeline position | Phase 3 of 4: prereq → prepare → **scaffold** → deploy                                            |
| IaC format        | Bicep (v1 default). Terraform when existing `.tf` detected or user override.                      |

## When to Use This Skill

Invoked by the `azure-app-onboard` orchestrator at Phase 3 when `prepare-plan.json` exists with `services[]`. Not directly user-routable in v1.

> **Return to orchestrator:** When complete, return control to `azure-app-onboard`. Do NOT directly invoke deploy — the orchestrator manages phase transitions.

## When NOT to Use

| Scenario                                    | Use Instead                                             |
| ------------------------------------------- | ------------------------------------------------------- |
| User-triggered IaC (no `prepare-plan.json`) | `azure-prepare`                                         |
| Subscription-scope landing zones            | `azure-enterprise-infra-planner`                        |
| Execute deployment (`azd up`)               | `azure-deploy` (do NOT invoke from AppOnboard pipeline) |

## MCP Tools

> See [shared tools](../references/mcp-tool-reference.md) for cross-phase tools and global parameters. See [scaffold tools](references/mcp-tools.md) for full parameter tables.

| Tool                                        | Sub-command                    | Purpose                                  | Parameters                                             |
| ------------------------------------------- | ------------------------------ | ---------------------------------------- | ------------------------------------------------------ |
| `mcp_azure_mcp_bicepschema`                 | `bicepschema_get`              | ARM resource type schemas                | `resource_type` (Required), `api_version` (Optional)   |
| `mcp_bicep_list_avm_metadata`               | _(flat)_                       | AVM module catalog                       | None                                                   |
| `mcp_bicep_get_bicep_best_practices`        | _(flat)_                       | Bicep best practices                     | None                                                   |
| `mcp_bicep_get_az_resource_type_schema`     | _(flat)_                       | ARM resource type JSON schema            | `azResourceType`, `apiVersion` (Required)              |
| `mcp_bicep_build_bicep`                     | _(flat)_                       | Validate `.bicep` files (self-review L3) | `filePath` (Required)                                  |
| `mcp_bicep_format_bicep_file`               | _(flat)_                       | Format `.bicep` files (LF enforcement)   | `filePath` (Required)                                  |
| `mcp_azure_mcp_deploy`                      | `deploy_iac_rules_get`         | IaC best practices and rules             | `deployment-tool`, `iac-type`, `resource-types`        |
| `mcp_azure_mcp_deploy`                      | `deploy_pipeline_guidance_get` | CI/CD pipeline config                    | `is-azd-project`, `pipeline-platform`, `deploy-option` |
| `mcp_azure_mcp_get_azure_bestpractices`     | `get_azure_bestpractices_get`  | SDK/Functions best practices             | `resource`, `action`                                   |
| `mcp_azure_mcp_azureterraformbestpractices` | _(flat)_                       | Terraform patterns (TF path only)        | `resource_type` (Required)                             |

## Workflow

**Session folder:** `.copilot-azure/sessions/{uuid}/` — reads `prepare-plan.json` + `context.json`, writes `scaffold-manifest.json`.

### DETECT (Steps 1–4)

1. **Read `prepare-plan.json`** — verify `services[]` exists, read `naming` config (especially `naming.resourcePrefix`, `naming.suffix`, `naming.resources[]`). Read resource group name from `context.json.azure.resourceGroup`. ⛔ **Use EXACTLY these names in generated IaC — do NOT invent names, derive them from `environmentName`, or append your own suffixes.** ⛔ **Use EXACTLY the names from `prepare-plan.json.naming.resources[]` as Bicep parameters. Do NOT derive names with `take()`, `substring()`, or string manipulation. The plan is the source of truth.** Missing → trigger prepare backfill via `azure-app-onboard` orchestrator.
2. **Read `context.json`** — check `overrides[]` for `iacFormat` preference, `detectedInfra[]` for existing `.tf`, `detectedInfraProvider` for cloud provider classification.
3. **Check workspace for existing IaC** — ⛔ **Skip** if `context.json.overrides[]` contains `ignoreExistingInfra: true`. Otherwise:
   - **Azure IaC** (`.bicep`, `azure.yaml`, `.tf` with `azurerm`): `ask_user` → "Start fresh" (rename `infra/` to `infra.bak/`) or "Use existing" (route to `azure-prepare`, stop pipeline).
   - **Non-Azure IaC** (`.tf` with GCP/AWS): respect `context.json.overrides[].iacFormat` from prepare. Default: Bicep alongside existing TF.
   - **Unknown TF** (`detectedInfraProvider.terraform` == `"unknown"`): ask user which provider before routing.
   - **No IaC**: continue.
4. **Determine compute targets** — Check which compute targets are in the plan (App Service/Functions, Container Apps, or both) and whether PostgreSQL/Redis is present. Do NOT read any reference files — pass this info to the sub-agent at Step 5.
   4b. **Pre-check API versions (main thread)** — MCP tool access is unreliable in `task` agents — call these in the main thread before dispatching. Call `mcp_bicep_list_az_resource_types_for_provider` (or `bicep-list_az_resource_types_for_provider`) once per provider namespace in `prepare-plan.json.services[]` (e.g., `Microsoft.Web`, `Microsoft.App`, `Microsoft.DBforPostgreSQL`, `Microsoft.Cache`, `Microsoft.KeyVault`, `Microsoft.ContainerRegistry`). Extract the latest GA API version (no `-preview`) for each resource type. Build an `apiVersions` map and pass it to the IaC gen sub-agent at Step 5. Fallback: if MCP unavailable, run `az provider show --namespace {ns} --query "resourceTypes[?resourceType=='{type}'].apiVersions[?!contains(@, 'preview')] | [0][0]" -o tsv` per resource type — this filters to GA-only and picks the latest. Pass `"MCP unavailable"` only if both MCP AND CLI fail. Sub-agent still validates generated Bicep via `az bicep build`.

### ACTION (Steps 5–12)

> ⛔ **File boundary:** NEVER modify files outside `infra/`, `.copilot-azure/`. Scaffold only writes files — no install/build commands.

> ⛔ **Sub-agent delegation is MANDATORY for Steps 5, 6–9, and 10–12.** Each step reads its `subagent-*.md` template, then dispatches a `task` call. Do NOT read any reference file not explicitly named in these steps.
>
> ⛔ **Dispatch type: `task` ONLY — NEVER `general-purpose`.** `general-purpose` leaks sub-agent context into the main thread, accelerating compaction and evicting the orchestrator workflow. `task` isolates sub-agent context.
>
> ⛔ **How to dispatch — VERBATIM COPY required:**
>
> 1. `view` the `subagent-*.md` template file
> 2. Your **NEXT action MUST be a `task` tool call** — not `view`, `powershell`, `create`, or ANY other tool
> 3. The task prompt MUST contain the **COMPLETE and UNMODIFIED** template text. Copy the template between `<<<TEMPLATE_START>>>` / `<<<TEMPLATE_END>>>` delimiters exactly as shown below. Do NOT summarize, paraphrase, reword, or omit ANY part of it — the sub-agent needs every "Read [file]" and "Do:" instruction to produce correct output
> 4. AFTER the template block, append the data sections (plan JSON, overrides, etc.)
>
> **Anti-pattern (causes regressions):** Writing your OWN prompt that lists workflow steps or describes what to generate. The template already contains the complete workflow — your job is to COPY it, not rewrite it.

5. **IaC generation** — ⛔ **You MUST dispatch [`subagent-iac-gen.md`](references/subagent-iac-gen.md) as a `task`.** ⛔ agent_type: `"task"` — NEVER `"general-purpose"`.
   ```
   <<<TEMPLATE_START>>>
   {paste the ENTIRE content of subagent-iac-gen.md here — unmodified}
   <<<TEMPLATE_END>>>

   ## Data (appended by orchestrator)
   ### prepare-plan.json
   {full JSON}
   ### context.json.overrides
   {overrides array}
   ### prereq-output.json.buildRequirements
   {buildRequirements object}
   ### prereq-output.json.warnings[]
   {warnings array}
   ### Compute targets
   {App Service/Functions, Container Apps, or both + whether PostgreSQL/Redis present}
   ### apiVersions
   {map from Step 4b, e.g. {"Microsoft.KeyVault/vaults": "2023-07-01", ...} — or "MCP unavailable" if skipped}
   ### Working directory
   {absolute path}
   ```
   - **Expect:** IaC files written to `infra/`, file list returned for `scaffold-manifest.json.files[]`
   - The tag `app-onboard-skill: 'true'` MUST appear verbatim in generated Bicep.

5b. **Deploy checklist (parallel with Step 5)** — Dispatch as a `task` **in parallel** with the IaC gen subagent above. ⛔ agent_type: `"task"` — NEVER `"general-purpose"`.

```
<<<TEMPLATE_START>>>
You are a deploy-checklist generator. Do NOT invoke any skills.

1. Read the deploy-checklist-template at: plugin/skills/azure-app-onboard/deploy/references/deploy-checklist-template.md
2. Fill in {placeholders} with real values from prepare-plan.json (appName, rgName, subscriptionId, sessionId).
3. Delete sections that don't apply to this deployment's compute target (e.g., remove App Service section for Container Apps deploys). The template section headers indicate which to delete.
4. Write the result to the session folder using the `create` tool. This file survives conversation compaction — deploy re-reads it after every long-running command.
<<<TEMPLATE_END>>>

## Data (appended by orchestrator)
### prepare-plan.json
{full JSON}
### Session path
{.copilot-azure/sessions/{uuid}/}
### Compute targets
{App Service, Container Apps, Static Web Apps, or combination}
```

- **Expect:** `deploy-checklist.md` written to session folder. If this subagent fails, the validate subagent (Steps 10b–12.5) will catch the missing file.

6–9. **Self-review** — ⛔ **You MUST dispatch [`subagent-review.md`](references/subagent-review.md) as a `task`.** ⛔ agent_type: `"task"` — NEVER `"general-purpose"`.

```
<<<TEMPLATE_START>>>
{paste the ENTIRE content of subagent-review.md here — unmodified}
<<<TEMPLATE_END>>>

## Data (appended by orchestrator)
### Generated IaC files
{full content of every .bicep/.tf file}
### prepare-plan.json (services, naming, deploymentVariables)
{relevant sections}
### prereq-output.json.warnings[]
{warnings array}
```

- **Expect:** findings JSON → write to `scaffold-manifest.json.selfReview`
- FLAGGED at L1/L3 → fix IaC before proceeding

### VALIDATE → MANIFEST → APPROVE (Steps 10–12.5)

10a. **Format IaC (main thread)** — For each `.bicep` file in `infra/` (including `modules/`): call `mcp_bicep_format_bicep_file` (or `bicep-format_bicep_file`) with `{ filePath: "<absolute path>" }`.This enforces LF line endings via the `bicepconfig.json` written during IaC generation. Fallback: skip if unavailable.

10a-conf. **Conformance gate (main thread — MANDATORY for Bicep)** — ⛔ **Skip this entire step when the scaffold emitted Terraform** (`infra/main.bicep` absent) — these checks are Bicep-only (Terraform is syntax-validated via `terraform validate` in the validate subagent). Otherwise run the conformance script from this skill's `scripts/` dir; it deterministically catches ARM-rejected values `az bicep build` can't (invalid Bicep values, wrong DB version, reserved DB login, `enablePurgeProtection`):

```
{scaffoldDir}/scripts/scaffold-conformance.ps1 -SessionPath ".copilot-azure/sessions/{uuid}" -InfraPath infra   # pwsh (preferred)
bash {scaffoldDir}/scripts/scaffold-conformance.sh ".copilot-azure/sessions/{uuid}" infra                       # bash (only if pwsh unavailable; needs jq for the plan-dependent checks)
```

⛔ **Prefer the `.ps1` when `pwsh` is available** — it runs every check unconditionally. The `.sh` twin skips the plan-dependent checks (`DB-VERSION-MATCH`, `SERVICES-COMPLETE`, `DB-NAME-PRESENT`, `WARN-FIXED`) when `jq` is absent.
⛔ Any BLOCK failure → fix the IaC, re-run (max 3); never present the deploy gate with an open BLOCK. Run it here in the main thread — do NOT delegate to the validate subagent or hand-judge the result when a shell exists. Pass the JSON to the validate subagent for `scaffold-manifest.json.conformance`.

10b–12.5. **Validation + manifest** — ⛔ **You MUST dispatch [`subagent-validate.md`](references/subagent-validate.md) as a `task`.** ⛔ agent_type: `"task"` — NEVER `"general-purpose"`.

```
<<<TEMPLATE_START>>>
{paste the ENTIRE content of subagent-validate.md here — unmodified}
<<<TEMPLATE_END>>>

## Data (appended by orchestrator)
### IaC file paths
{list of generated files}
### Self-review findings (from Steps 6–9)
{findings JSON}
### prepare-plan.json
{full JSON}
### prereq-output.json.warnings[]
{warnings array}
### prereq-output.json.healthEndpoint
{detected health path string or null}
### Conformance result
{JSON from Step 10a-conf}
### Session path
{.copilot-azure/sessions/{uuid}/}
```

- **Expect:** `scaffold-manifest.json` with `validationResult`, deploy checklist generated
- Verify `deploy-checklist.md` exists (written at Step 5b) — if missing, create NOW from [`deploy-checklist-template.md`](../deploy/references/deploy-checklist-template.md). Verify `deploy-result.json` exists — if missing, create from [`deploy-schemas.ts`](../deploy/references/deploy-schemas.ts).
- ⛔ **Verify `context.json` update (main-thread — do NOT delegate).** Read `.copilot-azure/sessions/{uuid}/context.json`. If `completedPhases` does not include `"scaffold"` OR `currentPhase` is not `"deploy"`, write it yourself via `edit` / `create`: append `"scaffold"` to `completedPhases`, set `currentPhase` to `"deploy"`, update `lastModifiedUtc` to current UTC ISO 8601. This is a phase-boundary write required by [pipeline-rules.md](../references/pipeline-rules.md) — do not skip it.
- ⛔ **Return to orchestrator for Step 8 (Deploy Approval Gate).** YOUR NEXT ACTION MUST BE presenting the Deploy Gate per orchestrator SKILL.md — do NOT write a "summary of generated files" message, do NOT emit a completion report. The Deploy Gate prompt (`🚀 Ready to deploy? ...`) is the ONLY correct next output.

## Self-Healing Loop

On validation failure → read [`scaffold-healing-rules.md`](references/scaffold-healing-rules.md) (healing cadence, PLAN_LEVEL_CHANGE, artifact consistency). Do NOT pre-read.

## Error Handling

- **Missing `prepare-plan.json`:** trigger backfill via orchestrator.
- **Existing IaC:** handled in DETECT Step 3.
- **MCP unavailable:** fall back to reference patterns, flag as "unverified."
- FLAGGED findings and healing exhaustion: see [scaffold-healing-rules.md](references/scaffold-healing-rules.md).
