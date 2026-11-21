---
name: launching-ec2-instance-with-best-practices
description: Launches an EC2 instance with secure, cost-efficient defaults including AMI selection, burstable instance sizing, least-privilege IAM roles, hardened security groups, encrypted EBS volumes, and comprehensive tagging. Use when deploying new EC2 instances following AWS best practices for security and cost optimization.
version: 1
---

# Launching EC2 Instances with Best Practices

## Overview

Domain expertise for launching EC2 instances with sensible defaults optimized for security, cost-efficiency, and operational best practices. Covers AMI selection, instance type recommendation, network configuration, IAM role creation, security group hardening, storage configuration, tagging strategy, and post-launch verification.

## Launch an EC2 instance

To launch a fully configured EC2 instance with best-practice defaults, follow the procedure exactly.
See [EC2 instance launch procedure](references/launch-ec2-instance-with-best-practices.md).

The procedure handles:

- Intelligent defaults based on workload type and environment
- Network validation (VPC, subnet, public/private placement)
- AMI selection with architecture compatibility checks
- Least-privilege IAM roles for required AWS service access
- Hardened security groups with minimal port exposure
- Encrypted gp3 storage with environment-appropriate retention
- Comprehensive tagging for cost tracking and organization
- Post-launch verification and connection instructions

## Troubleshooting

### Insufficient instance capacity

Try a different availability zone or instance type (e.g., t3a instead of t3). See the full troubleshooting guide in the [launch procedure](references/launch-ec2-instance-with-best-practices.md).

### Instance immediately terminates

Check console output with `aws ec2 get-console-output`. Verify EBS volume size is sufficient and AMI is compatible with the instance type.

### Cannot connect via SSH

Verify the security group allows SSH from your IP, key file permissions are `400`, and the instance is running. Consider AWS Systems Manager Session Manager as an alternative.
