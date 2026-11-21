---
name: azure-validate
description: "Pre-deployment validation for Azure readiness. Run deep checks on configuration, infrastructure (Bicep or Terraform), RBAC role assignments, managed identity permissions, and prerequisites before deploying. WHEN: validate my app, check deployment readiness, run preflight checks, verify configuration, check if ready to deploy, validate azure.yaml, validate Bicep, test before deploying, troubleshoot deployment errors, validate Azure Functions, validate function app, validate serverless deployment, verify RBAC roles, check role assignments, review managed identity permissions, what-if analysis, validate Container Apps deployment."
license: MIT
metadata:
  author: Microsoft
  version: "1.2.2"
---

# Azure Validate

> **AUTHORITATIVE GUIDANCE** — Follow these instructions exactly unless they contradict security policies given to you.

> **⛔ STOP — PREREQUISITE CHECK REQUIRED**
>
> Before proceeding, verify this prerequisite is met:
>
> **azure-prepare** was invoked and completed → `.azure/deployment-plan.md` exists with status `Approved` or later
>
> If the plan is missing, **STOP IMMEDIATELY** and invoke **azure-prepare** first.
>
> The complete workflow ensures success:
>
> `azure-prepare` → `azure-validate` → `azure-deploy`

## Triggers

- Check if app is ready to deploy
- Validate azure.yaml or Bicep
- Run preflight checks
- Troubleshoot deployment errors

## Rules

1. Run after azure-prepare, before azure-deploy
2. All checks must pass—do not deploy with failures
3. ⛔ **Destructive actions require `ask_user`** — [global-rules](references/global-rules.md)

## Steps

Run the workflow script and follow its instructions. It walks you through each validation step one at a time, recording progress in `.azure/validate-status.json`. Use [references/scripts/workflow.ps1](references/scripts/workflow.ps1) on Windows or [references/scripts/workflow.sh](references/scripts/workflow.sh) on macOS/Linux.

Start by calling the script **without** the completed-step argument:

```bash
pwsh references/scripts/workflow.ps1 -WorkspacePath <workspace-path>
# macOS/Linux: bash references/scripts/workflow.sh --workspace-path <workspace-path>
```

Each run prints the next action and the value to pass next. Perform the action, then re-run with that value (`-CompletedStep <value>` for pwsh, `--completed-step <value>` for bash). Repeat until it reports the azure-validate workflow is complete.

The steps reference recipe details in [references/recipes/README.md](references/recipes/README.md) and role checks in [references/role-verification.md](references/role-verification.md).

> **⛔ VALIDATION AUTHORITY**
>
> This skill is the officially verified way to set plan status to `Validated`. You MUST follow the script's instructions to completion before setting status to `Validated`.
> Do NOT set status to `Validated` without doing so.

---

> **⚠️ NEXT STEP — DEPENDS ON USER INTENT**
>
> After ALL validations pass, check whether the user asked to deploy:
>
> - **If the user explicitly requested deployment**, you **MUST** invoke **azure-deploy** to execute it. Do NOT run `azd up`, `azd deploy`, or any deployment commands directly — let azure-deploy handle execution.
> - **If the user only asked to validate or prepare** (not deploy), STOP after recording proof and setting status to `Validated`. Report the validation results and do NOT invoke azure-deploy.
>
> If any validation failed, fix the issues and re-run azure-validate before proceeding.
