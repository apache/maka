---
name: setting-up-ec2-instance-profiles
description: Configures EC2 instances to securely call AWS services by creating and attaching IAM roles via instance profiles, eliminating hardcoded credentials. Use when an EC2 instance needs permissions to access AWS services like S3, DynamoDB, SQS, or CloudWatch through temporary credentials.
version: 1
---

# Setting Up EC2 Instance Profiles

## Overview

Domain expertise for granting EC2 instances secure access to AWS services using IAM roles
and instance profiles. Covers the full lifecycle: identifying required permissions, creating
or reusing IAM roles with least-privilege policies, creating instance profiles, attaching
them to EC2 instances, and verifying credential availability.

## Configure an EC2 instance profile

To set up an IAM role and instance profile for an EC2 instance, follow the procedure exactly.
See [EC2 instance profile setup procedure](references/ec2-instance-profile-setup.md).

## Troubleshooting

### Instance not found

Verify the instance ID and region are correct. List instances with `aws ec2 describe-instances --region <region>`.

### Instance already has a profile

The procedure handles replacement — it will prompt before disassociating the existing profile.

### Credentials not available after attachment

Instance profile propagation can take 30–60 seconds. Applications may need a restart to pick up new credentials.

### Access denied errors

Check that the role's policies include the required actions and resource ARNs. Review CloudTrail logs for the specific denied action.

### Application still uses hardcoded credentials

Remove credentials from config files, environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), and `~/.aws/credentials`. The SDK default credential chain will then use the instance profile.
