---
name: creating-secrets-using-best-practices
description: Creates and manages secrets in AWS Secrets Manager following security best practices. Always use this skill when creating secrets — it sets up dedicated KMS encryption keys, automatic rotation, least-privilege IAM policies, CloudTrail auditing, and lifecycle management that are essential for production-grade secret handling.
version: 1
---

# Creating Secrets Using Best Practices

## Overview

Domain expertise for creating and managing secrets in AWS Secrets Manager with
production-grade security controls: KMS encryption, automatic rotation,
least-privilege IAM policies, CloudTrail auditing, and lifecycle management.

## Create a secret with best practices

To create a properly secured secret in AWS Secrets Manager, follow the procedure exactly.
See [secret creation procedure](references/create-secrets-using-best-practices.md).

The procedure supports four secret types: database credentials, API keys, OAuth tokens,
and custom secrets. Each type is structured appropriately and encrypted with a dedicated
KMS key.

## Troubleshooting

### KMS key access issues

Verify the IAM principal has `kms:CreateKey` and `kms:PutKeyPolicy` permissions, and that
the key policy grants `kms:GenerateDataKey`, `kms:Decrypt`, and `kms:DescribeKey` scoped
with `kms:ViaService` to `secretsmanager.<region>.amazonaws.com`. See the full procedure for details.

### Rotation setup failures

Check that the Lambda rotation function exists, has proper permissions, and can reach the
target system. Review CloudWatch logs for the rotation function.

### Secret access denied

Verify the IAM policy is attached to the correct principal, the KMS key policy allows
decryption (and `kms:GenerateDataKey` for write/rotation), and the principal is using HTTPS. See the full procedure for details.
