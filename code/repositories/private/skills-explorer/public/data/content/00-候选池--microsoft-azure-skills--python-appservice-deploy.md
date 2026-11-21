---
name: python-appservice-deploy
description: 'Deploy Python (Flask/Django/FastAPI) code to Azure App Service Linux. WHEN: "Flask App Service", "Django App Service", "FastAPI App Service", "deploy Python to App Service". DO NOT USE FOR: Container Apps, Functions, non-Python, Terraform/Bicep/IaC, full infra — use azure-prepare.'
license: MIT
metadata:
  author: Microsoft
  version: "1.1.1"
---

# Python on Azure App Service — Code Deploy

Deploys Python (Flask, Django, FastAPI, generic) code to Azure App Service Linux (P0v3, Python 3.14). Creates RG + Plan + Web App if missing. Hand off to `azure-prepare` for VNet, Key Vault, databases, or IaC.

**MCP tools used**: `mcp_azure_mcp_subscription_list`, `mcp_azure_mcp_group_list`, `mcp_azure_mcp_appservice`, `mcp_azure_mcp_azd` (when `azure.yaml` is present).

## Workflow

1. **Resolve context — smart defaults, minimal prompts.** Only the app name is interactive; RG (`<app>-rg`), Plan (`<app>-plan`), region (current `az` default or `eastus2`), subscription are derived. [create-app.md](references/create-app.md) §1.
2. **Detect framework** (advisory, never blocks). [detect.md](references/detect.md).
3. **Choose path** — `azure.yaml` host: appservice → [deploy-azd.md](references/deploy-azd.md); else [deploy-azcli.md](references/deploy-azcli.md).
4. **Ensure RG → Plan (`P0v3 --is-linux`) → Web App (`--runtime "PYTHON:3.14"`)** exist. On transient ARM errors, follow [transient-retry.md](references/transient-retry.md). [create-app.md](references/create-app.md).
5. **Set startup** — Flask/Django: none (Oryx auto-detects). FastAPI: always `python -m uvicorn main:app --host 0.0.0.0`. Other: warn. [startup-commands.md](references/startup-commands.md).
6. **Set `SCM_DO_BUILD_DURING_DEPLOYMENT=true`**.
7. **Deploy** — `azd deploy` or `az webapp deploy --type zip --track-status false`.
8. **STOP. Print the post-deploy message** ([post-deploy-message.md](references/post-deploy-message.md)) and end the turn.

### Hard rules

- ⛔ **NO POST-DEPLOY VERIFICATION** — after deploy returns, do not run `az webapp log tail`, `curl`, `Invoke-WebRequest`, or any health probe. App Service needs 2–3 min to warm; a quiet log or early 5xx is not failure.
- ⛔ **SHELL SAFETY** — for `--runtime` always use `"PYTHON:3.14"` (colon). Never `"PYTHON|3.14"` (pipe is a shell operator).
- ⛔ **NEVER `az webapp up`** — deprecated. Use Step 7 commands.
- ✅ **URL FORMAT** — present endpoints as `https://...` URLs.

## Error Handling

See [errors.md](references/errors.md) for the full symptom → cause → fix matrix. Quick triage: missing plan/app → re-run Step 4; container ping timeout on 8000 → fix startup (Step 5); `ModuleNotFoundError` after deploy → ensure Step 6 ran, redeploy.
