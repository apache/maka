---
name: aws-cleanrooms
description: Troubleshoots and debugs AWS Clean Rooms collaboration issues related to IAM roles, S3 bucket policies, KMS keys, Lake Formation permissions, and CloudWatch logging for custom ML model training and inference jobs. Use when a customer reports permission failures, access errors, or log publishing issues in Clean Rooms.
version: 1
---

# AWS Clean Rooms

## Overview

Domain expertise for troubleshooting AWS Clean Rooms collaborations and custom ML modeling. Covers permission debugging, data access issues, and CloudWatch logging configuration.

## Common tasks

### Debugging Clean Rooms errors

Determine the failure type:

**Access denied or permission error?** → See [permission debugging procedure](references/permission-debugging.md). Covers IAM role policies (inline + attached managed), S3 bucket policies, KMS key policies, Lake Formation permissions, and cross-account trust.

**Missing CloudWatch logs for custom model jobs?** → See [custom model logging debugging procedure](references/custom-model-logging-debugging.md). Covers Configured Model Algorithm Association privacy configuration, ML Configuration role permissions, and log group verification.

## Additional resources

- [Clean Rooms Service Role Setup](https://docs.aws.amazon.com/clean-rooms/latest/userguide/setting-up-roles.html)
- [Cross-service Confused Deputy Prevention](https://docs.aws.amazon.com/clean-rooms/latest/userguide/cross-service-confused-deputy-prevention.html)
- [ML Roles Documentation](https://docs.aws.amazon.com/clean-rooms/latest/userguide/ml-roles.html)
- [Lake Formation Onboarding](https://docs.aws.amazon.com/lake-formation/latest/dg/onboarding-lf-permissions.html)
