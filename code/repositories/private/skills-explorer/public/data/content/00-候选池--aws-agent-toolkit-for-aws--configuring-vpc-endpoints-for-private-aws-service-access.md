---
name: configuring-vpc-endpoints-for-private-aws-service-access
description: Configures VPC endpoints (interface and gateway) for private AWS service access using AWS PrivateLink. Use when setting up secure private connectivity to S3, DynamoDB, and other AWS services without internet gateway, NAT device, or public IP addresses. Covers endpoint creation, security groups, route tables, and DNS configuration.
version: 1
---

# Configuring VPC Endpoints for Private AWS Service Access

## Overview

Domain expertise for configuring VPC endpoints to enable private access to AWS services
without routing traffic through the internet. Covers both gateway endpoints (S3, DynamoDB)
and interface endpoints (EC2, SSM, Secrets Manager, etc.) powered by AWS PrivateLink.

## Configure VPC endpoints

To create and configure VPC endpoints for private AWS service access, follow the procedure exactly.
See [VPC endpoints configuration procedure](references/configure-vpc-endpoints-for-private-aws-service-access.md).

## Troubleshooting

### Endpoint not available

Check security group rules, subnet configurations, and service availability in the region.

### DNS resolution issues

Verify DNS hostnames and DNS resolution are enabled on the VPC and that the DHCP options set has correct domain name servers.

### Connection timeouts

Verify security group rules allow HTTPS traffic (port 443) and route tables are properly configured for gateway endpoints.

### Policy restrictions

Review endpoint policies — default policies allow all access, but custom policies may be restrictive.
