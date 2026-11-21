# Get Started with Terraform

## Overview

Interactive guide for setting up Terraform in a new project.

## Trigger

When user says "Get started with Terraform" or similar.

---

## Step 1: Check Existing Setup

Look for `*.tf` files, `.terraform/`, `terraform.tfstate`.

**If found:** Ask to continue or start fresh.
**If not:** Proceed to Step 2.

## Step 2: Determine Provider

Ask: "Which cloud provider? (AWS, Azure, GCP, other)"

Use MCP to get provider info:
```javascript
search_providers({
  "provider_name": "aws",
  "provider_namespace": "hashicorp",
  "service_slug": "aws",
  "provider_document_type": "overview"
})

get_latest_provider_version({ "namespace": "hashicorp", "name": "aws" })
```

## Step 3: Create Base Files

**versions.tf:**
```hcl
terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"  # Use version from MCP
    }
  }
}
```

**provider.tf:**
```hcl
provider "aws" {
  region = var.aws_region
}
```

**variables.tf:**
```hcl
variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}
```

## Step 4: First Resource

Ask what to create. Use MCP to get docs:

```javascript
// Search for resource
search_providers({
  "provider_name": "aws",
  "provider_namespace": "hashicorp",
  "service_slug": "s3_bucket",
  "provider_document_type": "resources"
})

// Get full docs with provider_doc_id from results
get_provider_details({ "provider_doc_id": "..." })
```

Or find a module:
```javascript
search_modules({ "module_query": "vpc aws" })
get_module_details({ "module_id": "terraform-aws-modules/vpc/aws/6.5.1" })
```

## Step 5: Initialize

Guide through:
1. `terraform init`
2. `terraform validate`
3. `terraform plan`

## Step 6: What's Next

Offer help with:
- Adding resources/modules
- Multiple environments
- HCP Terraform setup
- CI/CD pipelines

---

## Quick Reference

```bash
terraform init      # Initialize
terraform fmt       # Format
terraform validate  # Validate
terraform plan      # Preview
terraform apply     # Apply
```

## File Structure

```
project/
├── versions.tf      # Terraform/provider versions
├── provider.tf      # Provider config
├── variables.tf     # Input variables
├── main.tf          # Resources
├── outputs.tf       # Outputs
└── terraform.tfvars # Values (don't commit secrets)
```
