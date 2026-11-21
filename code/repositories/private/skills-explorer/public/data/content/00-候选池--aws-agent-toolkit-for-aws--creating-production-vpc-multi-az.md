---
name: creating-production-vpc-multi-az
description: Creates a production-ready VPC with public and private subnets across multiple Availability Zones, including internet gateway, NAT gateways, route tables, and security groups following AWS Well-Architected principles. Use when deploying multi-AZ VPC infrastructure with automatic CIDR planning and DNS resolution.
version: 1
---

# Creating a Production-Ready VPC Across Multiple Availability Zones

## Overview

Domain expertise for creating production-ready VPC infrastructure distributed across
multiple Availability Zones. Covers VPC creation with DNS support, public and private
subnet layout with automatic CIDR calculation, internet gateway, NAT gateways for
high-availability outbound access, route table configuration, and tiered security
groups following AWS Well-Architected principles.

## Create a production VPC

To create a fully configured multi-AZ VPC with public/private subnets, NAT gateways,
route tables, and security groups, follow the procedure exactly.
See [Production VPC creation procedure](references/create-production-vpc-multi-az.md).

Key parameters:

- `vpc_name` (required): Name prefix for all resources
- `region` (required): Target AWS region
- `allowed_web_cidrs` (required): CIDR blocks allowed for web access — allow 0.0.0.0/0 only if explicitly requested
- `vpc_cidr` (optional, default `10.0.0.0/16`): VPC CIDR block
- `availability_zones` (optional, default 3): Number of AZs (2–6)
- `environment` (required): Environment tag
- `enable_ssh_access` (optional, default false): Whether to create SSH security group

## Troubleshooting

### Insufficient Availability Zones

The target region must have at least 2 available AZs. Use `aws ec2 describe-availability-zones` to verify.

### NAT Gateway creation delays

NAT Gateways can take several minutes to become available. The procedure waits for availability before configuring route tables.

### Security group CIDR warnings

The procedure warns about `0.0.0.0/0` for web access CIDRs and recommends specific IP ranges for production workloads, but allows it if explicitly requested.
