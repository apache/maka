# Terraform Best Practices

Auto-loaded when editing .tf files.

## Naming

```hcl
# snake_case, descriptive names
resource "aws_instance" "web_server" {}
resource "aws_security_group" "allow_https" {}

variable "instance_type" {}
variable "enable_monitoring" {}
```

## File Structure

```
module/
├── main.tf          # Resources
├── variables.tf     # Inputs
├── outputs.tf       # Outputs
├── versions.tf      # Version constraints
└── README.md        # Docs
```

Add new resources to the `main.tf` file. Once this file contains more than 15 resources, put additional resources into their own separate .tf files. For example, if adding OpenSearch resources, put them in a file named, `opensearch.tf`.

Always add new outputs to the `outputs.tf` file.

## Variables

```hcl
variable "environment" {
  description = "Deployment environment"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Must be dev, staging, or prod."
  }
}

variable "database_password" {
  description = "DB password"
  type        = string
  sensitive   = true
}
```

## Modules

```hcl
# Pin versions
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.0"

  name = "my-vpc"
  cidr = "10.0.0.0/16"
}
```

## Patterns

```hcl
# count for on/off
resource "aws_nat_gateway" "main" {
  count = var.enable_nat ? 1 : 0
}

# for_each for collections
resource "aws_subnet" "private" {
  for_each          = toset(var.availability_zones)
  availability_zone = each.value
}

# locals for computed values
locals {
  common_tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
```

## Security

```hcl
# Use data sources for secrets
data "aws_secretsmanager_secret_version" "db" {
  secret_id = "prod/database/password"
}

# Least privilege IAM
data "aws_iam_policy_document" "lambda" {
  statement {
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:log-group:/aws/lambda/${var.function_name}:*"]
  }
}
```

## Do / Don't

**Do:** Pin versions, use modules, validate inputs, use remote state, review plans

**Don't:** Hardcode secrets, use wildcards in IAM, skip version constraints, commit .tfvars with secrets
