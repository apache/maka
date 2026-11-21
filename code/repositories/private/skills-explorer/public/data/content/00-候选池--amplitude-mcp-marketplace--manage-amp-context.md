---
name: manage-amp-context
description: Lists projects for an employee-accessible organization or writes organization/project AI context with `manage_amp_context`; use `get_amplitude_context` for reads.
x-amp-flags: [mcp-consolidate-context]
---

# Manage Amp Context

## Choose an action

- `list_projects`: list projects for a customer organization when the caller is an Amplitude employee with an admin grant.
- `set_org_context`: replace organization-level AI context.
- `set_project_context`: replace project-level AI context.
- For all context reads and accessible-project discovery, use `get_amplitude_context`, not this tool.

## Required inputs

- `list_projects`: pass the customer `orgId`.
- `set_org_context`: pass non-empty `context` up to 10,000 characters; org-admin access is required.
- `set_project_context`: pass `projectId` and non-empty `context` up to 10,000 characters; project manager/admin access is required.

## Output and guardrails

Context writes overwrite the existing value. Confirm the target scope and exact replacement text before writing, and do not use `list_projects` for ordinary customer project discovery.
