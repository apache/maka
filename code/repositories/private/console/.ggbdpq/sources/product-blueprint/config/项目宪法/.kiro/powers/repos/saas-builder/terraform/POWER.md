---
name: "terraform"
displayName: "Deploy infrastructure with Terraform"
description: "Build and manage Infrastructure as Code with Terraform - access registry providers, modules, policies, and HCP Terraform workflow management"
keywords: ["terraform", "hashicorp", "infrastructure", "iac", "hcp", "providers", "modules", "registry"]
author: "HashiCorp"
---

# Terraform Power

## Overview

Access Terraform Registry APIs and HCP Terraform for IaC development. Search provider docs, discover modules, manage workspaces, and execute runs.

**Key capabilities:**
- **Provider Documentation**: Search and retrieve docs for resources, data sources, functions
- **Module Discovery**: Find verified and community modules from the Registry
- **HCP Terraform**: Workspace management, runs, variables, private registry
- **Sentinel Policies**: Access governance and compliance policies

## Available Steering Files

- **getting-started** - Interactive setup guide for new projects
- **terraform-best-practices** - Coding conventions and patterns (auto-loads for .tf files)

## Available MCP Servers

### terraform
**Package:** `hashicorp/terraform-mcp-server` | **Connection:** Docker stdio

**Provider Tools:**

| Tool | Purpose | Returns |
|------|---------|---------|
| `search_providers` | Find provider documentation by service name | List of available documentation with IDs, titles, and categories |
| `get_provider_details` | Retrieve complete documentation for a specific provider component | Full documentation content in markdown format |
| `get_latest_provider_version` | Retrieve the latest version of a specific provider | The latest version of a provider |

**Module Tools:**

| Tool | Purpose | Returns |
|------|---------|---------|
| `search_modules` | Find modules by name or functionality | Module details including names, descriptions, download counts, and verification status |
| `get_module_details` | Get comprehensive module information | Complete documentation with inputs, outputs, examples, and submodules |
| `get_latest_module_version` | Retrieve the latest version of a specific module | The latest version of a module |

**Policy Tools:**

| Tool | Purpose | Returns |
|------|---------|---------|
| `search_policies` | Find Sentinel policies by topic or requirement | Policy listings with IDs, names, and download statistics |
| `get_policy_details` | Retrieve detailed policy documentation | Policy implementation details and usage instructions |

**HCP Terraform/Enterprise Tools** (require `TFE_TOKEN`):

| Tool | Purpose | Returns |
|------|---------|---------|
| `list_terraform_orgs` | Fetch all Terraform organizations | List of organizations with their details |
| `list_terraform_projects` | Fetch all Terraform projects | List of projects with their metadata |
| `list_workspaces` | Search and list workspaces in an organization | Workspace details including configuration and status |
| `get_workspace_details` | Get comprehensive workspace information | Complete workspace configuration, variables, and state information |
| `create_workspace` | Create a new Terraform workspace | Confirmation of workspace creation (destructive operation) |
| `update_workspace` | Update workspace configuration | Updated workspace configuration (potentially destructive) |
| `delete_workspace_safely` | Delete workspace if it manages no resources | Confirmation of deletion (requires `ENABLE_TF_OPERATIONS`) |
| `list_runs` | List or search runs in a workspace | Run details with optional filtering |
| `get_run_details` | Get detailed information about a specific run | Complete run information including logs and status |
| `create_run` | Create a new Terraform run | Run creation confirmation with available run types |
| `action_run` | Perform actions on runs (apply, discard, cancel) | Action confirmation (requires `ENABLE_TF_OPERATIONS`) |
| `search_private_modules` | Find private modules in your organization | List of private modules matching search criteria |
| `get_private_module_details` | Get detailed private module information | Complete module details including inputs, outputs, and examples |
| `search_private_providers` | Find private providers in your organization | List of private providers matching search criteria |
| `get_private_provider_details` | Get detailed private provider information | Provider details including usage and version information |

**Variable Management Tools** (require `TFE_TOKEN`):

| Tool | Purpose | Returns |
|------|---------|---------|
| `list_variable_sets` | List all variable sets in an organization | Variable set details and configurations |
| `create_variable_set` | Create a new variable set | Confirmation of variable set creation |
| `create_variable_in_variable_set` | Add a variable to a variable set | Variable creation confirmation |
| `delete_variable_in_variable_set` | Remove a variable from a variable set | Variable deletion confirmation |
| `attach_variable_set_to_workspaces` | Attach variable set to workspaces | Attachment confirmation |
| `detach_variable_set_from_workspaces` | Detach variable set from workspaces | Detachment confirmation |
| `list_workspace_variables` | List all variables in a workspace | Workspace variable details |
| `create_workspace_variable` | Create a variable in a workspace | Variable creation confirmation |
| `update_workspace_variable` | Update an existing workspace variable | Updated variable configuration |

**Workspace Tagging Tools** (require `TFE_TOKEN`):

| Tool | Purpose | Returns |
|------|---------|---------|
| `create_workspace_tags` | Add tags to a workspace | Tag creation confirmation |
| `read_workspace_tags` | Read all tags from a workspace | List of workspace tags |

## Examples

```javascript
// 1. Search for S3 bucket resource docs
search_providers({
  "provider_name": "aws",
  "provider_namespace": "hashicorp",
  "service_slug": "s3_bucket",
  "provider_document_type": "resources"
})
// Returns: provider_doc_id like "10735923"

// 2. Get full documentation
get_provider_details({ "provider_doc_id": "10735923" })

// 3. Search for VPC modules
search_modules({ "module_query": "vpc" })
// Returns: module_id like "terraform-aws-modules/vpc/aws/6.5.1"

// 4. Get module details
get_module_details({ "module_id": "terraform-aws-modules/vpc/aws/6.5.1" })

// 5. Get latest provider version
get_latest_provider_version({ "namespace": "hashicorp", "name": "aws" })
```

## Workflow: Research → Write Config

```javascript
// Step 1: Search provider docs
const results = search_providers({
  "provider_name": "aws",
  "provider_namespace": "hashicorp", 
  "service_slug": "lambda_function",
  "provider_document_type": "resources"
})

// Step 2: Get detailed docs using provider_doc_id from results
const docs = get_provider_details({ "provider_doc_id": "..." })

// Step 3: Get version for constraint
const version = get_latest_provider_version({ "namespace": "hashicorp", "name": "aws" })

// Now write accurate Terraform config
```

## Configuration

**Prerequisites:** Docker installed and running

### Enabling HCP Terraform Features

By default, this power only includes Terraform Registry tools (providers, modules, policies). To enable HCP Terraform workspace management, runs, and variables, you need to configure your API token.

**Step 1:** Generate an API token from [HCP Terraform](https://app.terraform.io/app/settings/tokens) or your Terraform Enterprise instance.

**Step 2:** Update the `mcp.json` in this power to include your token:

```json
{
  "mcpServers": {
    "terraform": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e", "TFE_TOKEN",
        "hashicorp/terraform-mcp-server"
      ],
      "env": {
        "TFE_TOKEN": "${TFE_TOKEN}"
      },
      "disabled": false
    }
  }
}
```

This uses shell expansion to read the token from your environment. Set it with `export TFE_TOKEN=your-api-token-here` before launching Kiro.

> ⚠️ **IMPORTANT: Docker Container Restart Required**
> 
> After adding or changing `TFE_TOKEN`, `TFE_ADDRESS`, or any other environment variables, you **must restart the Docker container** for the changes to take effect. The MCP server runs inside Docker and only reads environment variables at container startup.
> 
> To restart: Stop the running container and reconnect the MCP server in Kiro, or restart Kiro entirely.

### Terraform Enterprise (Custom Endpoint)

For organizations using Terraform Enterprise with a custom endpoint, add the `TFE_ADDRESS` environment variable:

```json
{
  "mcpServers": {
    "terraform": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e", "TFE_TOKEN",
        "-e", "TFE_ADDRESS",
        "hashicorp/terraform-mcp-server"
      ],
      "env": {
        "TFE_TOKEN": "${TFE_TOKEN}",
        "TFE_ADDRESS": "${TFE_ADDRESS}"
      },
      "disabled": false
    }
  }
}
```

### Environment Variables Reference

| Variable | Description |
|----------|-------------|
| `TFE_TOKEN` | HCP Terraform or Terraform Enterprise API token (required for workspace/run tools) |
| `TFE_ADDRESS` | Custom Terraform Enterprise URL (omit for HCP Terraform at `app.terraform.io`) |
| `ENABLE_TF_OPERATIONS` | Set to `true` to enable destructive operations (apply/destroy) |

## Best Practices

**Do:** Always `search_*` before `get_*_details`, pin versions, use modules, review plans

**Don't:** Hardcode credentials, skip plan review, use `auto_approve` blindly

## Troubleshooting

| Error | Solution |
|-------|----------|
| Provider/Module not found | Use `search_*` first to get valid IDs |
| Unauthorized | Set `TFE_TOKEN` env var |
| Token set but still unauthorized | **Restart the Docker container** - env vars are only read at startup |
| Docker not running | Start Docker daemon |
| Changed TFE_ADDRESS but still hitting wrong endpoint | **Restart the Docker container** after changing any env vars |

## Resources

[Terraform MCP Docs](https://developer.hashicorp.com/terraform/mcp-server/reference) · [Registry](https://registry.terraform.io) · [HCP Terraform](https://app.terraform.io) · [MCP Server repo](https://github.com/hashicorp/terraform-mcp-server)

---

**Package:** `hashicorp/terraform-mcp-server` | **License:** MPL-2.0
