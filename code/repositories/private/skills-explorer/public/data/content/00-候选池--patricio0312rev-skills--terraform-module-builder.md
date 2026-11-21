---
name: terraform-module-builder
description: Creates reusable Terraform modules with proper structure, variables, outputs, and state management for infrastructure as code. Use when users request "Terraform setup", "infrastructure as code", "IaC module", "cloud provisioning", or "Terraform module".
---

# Terraform Module Builder

Build reusable, production-ready Terraform modules for cloud infrastructure.

## Core Workflow

1. **Define module structure**: Organize files properly
2. **Declare variables**: Input parameters with validation
3. **Create resources**: Infrastructure definitions
4. **Configure outputs**: Export useful values
5. **Setup state**: Remote backend configuration
6. **Document**: README and examples

## Module Structure

```
modules/
└── vpc/
    ├── main.tf           # Primary resources
    ├── variables.tf      # Input variables
    ├── outputs.tf        # Output values
    ├── versions.tf       # Provider versions
    ├── locals.tf         # Local values
    ├── data.tf           # Data sources
    ├── README.md         # Documentation
    └── examples/
        └── complete/
            ├── main.tf
            └── outputs.tf
```

## VPC Module Example

### Main Configuration

```hcl
# modules/vpc/main.tf

resource "aws_vpc" "main" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = var.enable_dns_hostnames
  enable_dns_support   = var.enable_dns_support

  tags = merge(
    var.tags,
    {
      Name = var.name
    }
  )
}

resource "aws_internet_gateway" "main" {
  count = var.create_igw ? 1 : 0

  vpc_id = aws_vpc.main.id

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-igw"
    }
  )
}

resource "aws_subnet" "public" {
  count = length(var.public_subnets)

  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnets[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-public-${var.availability_zones[count.index]}"
      Tier = "public"
    }
  )
}

resource "aws_subnet" "private" {
  count = length(var.private_subnets)

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnets[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-private-${var.availability_zones[count.index]}"
      Tier = "private"
    }
  )
}

resource "aws_eip" "nat" {
  count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(var.public_subnets)) : 0

  domain = "vpc"

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-nat-${count.index + 1}"
    }
  )

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(var.public_subnets)) : 0

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-nat-${count.index + 1}"
    }
  )

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-public-rt"
    }
  )
}

resource "aws_route" "public_internet" {
  count = var.create_igw ? 1 : 0

  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  count = length(var.public_subnets)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(var.private_subnets)) : 0

  vpc_id = aws_vpc.main.id

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-private-rt-${count.index + 1}"
    }
  )
}

resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(var.private_subnets)) : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = length(var.private_subnets)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[var.single_nat_gateway ? 0 : count.index].id
}
```

### Variables

```hcl
# modules/vpc/variables.tf

variable "name" {
  description = "Name prefix for all resources"
  type        = string

  validation {
    condition     = length(var.name) <= 32
    error_message = "Name must be 32 characters or less."
  }
}

variable "cidr_block" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.cidr_block, 0))
    error_message = "Must be a valid CIDR block."
  }
}

variable "availability_zones" {
  description = "List of availability zones"
  type        = list(string)
}

variable "public_subnets" {
  description = "List of public subnet CIDR blocks"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.public_subnets : can(cidrhost(cidr, 0))])
    error_message = "All public subnets must be valid CIDR blocks."
  }
}

variable "private_subnets" {
  description = "List of private subnet CIDR blocks"
  type        = list(string)
  default     = []
}

variable "enable_dns_hostnames" {
  description = "Enable DNS hostnames in the VPC"
  type        = bool
  default     = true
}

variable "enable_dns_support" {
  description = "Enable DNS support in the VPC"
  type        = bool
  default     = true
}

variable "create_igw" {
  description = "Create Internet Gateway"
  type        = bool
  default     = true
}

variable "enable_nat_gateway" {
  description = "Enable NAT Gateway for private subnets"
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = "Use a single NAT Gateway (cost savings)"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
```

### Outputs

```hcl
# modules/vpc/outputs.tf

output "vpc_id" {
  description = "The ID of the VPC"
  value       = aws_vpc.main.id
}

output "vpc_cidr_block" {
  description = "The CIDR block of the VPC"
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "List of public subnet IDs"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "List of private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "public_subnet_cidr_blocks" {
  description = "List of public subnet CIDR blocks"
  value       = aws_subnet.public[*].cidr_block
}

output "private_subnet_cidr_blocks" {
  description = "List of private subnet CIDR blocks"
  value       = aws_subnet.private[*].cidr_block
}

output "nat_gateway_ids" {
  description = "List of NAT Gateway IDs"
  value       = aws_nat_gateway.main[*].id
}

output "internet_gateway_id" {
  description = "The ID of the Internet Gateway"
  value       = try(aws_internet_gateway.main[0].id, null)
}
```

### Versions

```hcl
# modules/vpc/versions.tf

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}
```

## Remote State Configuration

```hcl
# backend.tf

terraform {
  backend "s3" {
    bucket         = "my-terraform-state"
    key            = "production/vpc/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

# State locking table
resource "aws_dynamodb_table" "terraform_locks" {
  name         = "terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
```

## EKS Module Example

```hcl
# modules/eks/main.tf

resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  version  = var.cluster_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = var.endpoint_private_access
    endpoint_public_access  = var.endpoint_public_access
    security_group_ids      = [aws_security_group.cluster.id]
  }

  encryption_config {
    provider {
      key_arn = var.kms_key_arn
    }
    resources = ["secrets"]
  }

  enabled_cluster_log_types = var.enabled_log_types

  depends_on = [
    aws_iam_role_policy_attachment.cluster_policy,
    aws_iam_role_policy_attachment.vpc_resource_controller,
  ]

  tags = var.tags
}

resource "aws_eks_node_group" "main" {
  for_each = var.node_groups

  cluster_name    = aws_eks_cluster.main.name
  node_group_name = each.key
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.subnet_ids

  instance_types = each.value.instance_types
  capacity_type  = each.value.capacity_type
  disk_size      = each.value.disk_size

  scaling_config {
    desired_size = each.value.desired_size
    max_size     = each.value.max_size
    min_size     = each.value.min_size
  }

  update_config {
    max_unavailable_percentage = 25
  }

  labels = each.value.labels

  dynamic "taint" {
    for_each = each.value.taints
    content {
      key    = taint.value.key
      value  = taint.value.value
      effect = taint.value.effect
    }
  }

  tags = merge(var.tags, each.value.tags)

  depends_on = [
    aws_iam_role_policy_attachment.node_policy,
    aws_iam_role_policy_attachment.cni_policy,
    aws_iam_role_policy_attachment.ecr_policy,
  ]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}

# modules/eks/variables.tf

variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
}

variable "cluster_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.28"
}

variable "node_groups" {
  description = "Map of node group configurations"
  type = map(object({
    instance_types = list(string)
    capacity_type  = string
    disk_size      = number
    desired_size   = number
    max_size       = number
    min_size       = number
    labels         = map(string)
    taints = list(object({
      key    = string
      value  = string
      effect = string
    }))
    tags = map(string)
  }))
}
```

## Environment Configuration

```hcl
# environments/production/main.tf

terraform {
  required_version = ">= 1.0"

  backend "s3" {
    bucket         = "company-terraform-state"
    key            = "production/main.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Environment = "production"
      ManagedBy   = "terraform"
      Project     = var.project_name
    }
  }
}

module "vpc" {
  source = "../../modules/vpc"

  name               = "${var.project_name}-production"
  cidr_block         = "10.0.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
  public_subnets     = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  private_subnets    = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]
  enable_nat_gateway = true
  single_nat_gateway = false

  tags = var.tags
}

module "eks" {
  source = "../../modules/eks"

  cluster_name    = "${var.project_name}-production"
  cluster_version = "1.28"
  subnet_ids      = module.vpc.private_subnet_ids

  node_groups = {
    general = {
      instance_types = ["m6i.xlarge"]
      capacity_type  = "ON_DEMAND"
      disk_size      = 100
      desired_size   = 3
      max_size       = 10
      min_size       = 2
      labels         = { workload = "general" }
      taints         = []
      tags           = {}
    }
    spot = {
      instance_types = ["m6i.xlarge", "m5.xlarge"]
      capacity_type  = "SPOT"
      disk_size      = 50
      desired_size   = 2
      max_size       = 20
      min_size       = 0
      labels         = { workload = "batch" }
      taints = [{
        key    = "spot"
        value  = "true"
        effect = "NO_SCHEDULE"
      }]
      tags = {}
    }
  }

  tags = var.tags
}
```

## Locals and Data Sources

```hcl
# modules/vpc/locals.tf

locals {
  az_count = length(var.availability_zones)

  subnet_bits = ceil(log(local.az_count * 2, 2))

  public_subnet_cidrs = [
    for i in range(local.az_count) :
    cidrsubnet(var.cidr_block, local.subnet_bits, i)
  ]

  private_subnet_cidrs = [
    for i in range(local.az_count) :
    cidrsubnet(var.cidr_block, local.subnet_bits, i + local.az_count)
  ]

  common_tags = merge(
    var.tags,
    {
      Module    = "vpc"
      CreatedBy = "terraform"
    }
  )
}

# modules/vpc/data.tf

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
```

## Best Practices

1. **Version constraints**: Pin provider versions
2. **Variable validation**: Add validation rules
3. **Consistent naming**: Use name prefixes
4. **Default tags**: Apply common tags
5. **Remote state**: Use S3 + DynamoDB locking
6. **Module composition**: Small, focused modules
7. **Documentation**: README with examples
8. **Output everything**: Useful values for consumers

## Output Checklist

Every Terraform module should include:

- [ ] Proper file structure (main, variables, outputs, versions)
- [ ] Variable validation rules
- [ ] Meaningful default values
- [ ] Comprehensive outputs
- [ ] Version constraints
- [ ] Remote state configuration
- [ ] Tags for all resources
- [ ] README with examples
- [ ] Locals for computed values
- [ ] Data sources for dynamic values
