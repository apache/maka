# Terraform Code Style Guidelines

HashiCorp's official Terraform style guide for consistent, maintainable infrastructure-as-code.

## Module Structure

```
├── README.md
├── main.tf
├── variables.tf
├── outputs.tf
├── modules/
│   ├── nestedA/
│   │   ├── README.md
│   │   ├── variables.tf
│   │   ├── main.tf
│   │   ├── outputs.tf
├── examples/
│   ├── exampleA/
│   │   ├── main.tf
```

### Required Files
- `main.tf` – Primary resource and data source definitions
- `variables.tf` – Input variable definitions (alphabetical order)
- `outputs.tf` – Output value definitions (alphabetical order)
- `README.md` – Module purpose, usage, examples

### Recommended Files
- `providers.tf` – Provider configurations
- `terraform.tf` – Terraform version requirements
- `backend.tf` – Backend configuration (root modules only)
- `locals.tf` – Local value definitions

## Code Formatting

- Indent two spaces for each nesting level
- Align equals signs for consecutive single-line arguments
- Arguments first, then nested blocks with blank line separation
- Meta-arguments (count, for_each) first
- lifecycle blocks last, separated by blank lines
- One blank line between top-level blocks
- Run `terraform fmt` before every commit

## Resource Organization

- Define data sources before resources that reference them
- Group related resources (networking, compute, storage)
- Order: meta-arguments → resource parameters → nested blocks → lifecycle → depends_on

## Resource Naming

```hcl
# Good: descriptive nouns, underscores, no type in name
resource "aws_instance" "web_server" {}

# Bad: type in name
resource "aws_instance" "webserver_instance" {}
```

## Variables and Outputs

```hcl
variable "instance_type" {
  type        = string
  description = "EC2 instance type"
  default     = "t3.micro"
  sensitive   = false
}

output "instance_id" {
  description = "ID of the EC2 instance"
  value       = aws_instance.web_server.id
  sensitive   = false
}
```

Order: type → description → default → sensitive → validation

## Comments

- Use `#` for comments (not `//` or `/* */`)
- Write self-documenting code
- Comment only to clarify complexity or business logic

## Dynamic Resources

```hcl
# count for on/off or identical resources
resource "aws_instance" "web" {
  count = var.enable_web ? var.instance_count : 0
}

# for_each for distinct values
resource "aws_subnet" "private" {
  for_each = toset(var.availability_zones)
  availability_zone = each.value
}
```

## Version Management

```hcl
terraform {
  required_version = ">= 1.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"  # Pessimistic constraint
    }
  }
}
```

- Use `~>` for modules/providers (allows safe updates)
- Document rationale for strict constraints
- Avoid open-ended constraints (`>`, `>=` without upper bound)

## Security

- Never commit `terraform.tfstate` or `.terraform/`
- Use dynamic provider credentials when possible
- Access secrets from external secret management
- Set `sensitive = true` for sensitive variables
- Use environment variables for provider credentials

## Testing

- Write Terraform tests for modules
- Run tests in CI/CD pipelines
- Use validation blocks with meaningful error messages
- Validate inputs before resource creation

## State Management

- Use remote state storage (S3, HCP Terraform, etc.)
- Use `tfe_outputs` data source for cross-workspace data
- Separate environments into different workspaces/directories
