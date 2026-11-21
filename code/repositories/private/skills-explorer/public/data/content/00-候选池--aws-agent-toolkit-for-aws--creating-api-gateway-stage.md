---
name: creating-api-gateway-stage
description: Creates an API Gateway stage with CloudWatch logging, X-Ray tracing, throttling, WAF integration, and IAM roles following AWS best practices. Use when deploying a REST API to different environments such as dev, test, or production.
version: 1
---

# Creating an API Gateway Stage

## Overview

Domain expertise for creating and configuring API Gateway stages with comprehensive
logging, monitoring, security, and throttling controls. Covers CloudWatch logging
setup, X-Ray tracing, WAF web ACL association, method-level configuration, and
authorization options.

## Create an API Gateway stage

To create a fully configured API Gateway stage with logging, throttling, WAF, and
authorization, follow the procedure exactly.
See [API Gateway stage creation procedure](references/create-api-gateway-stage.md).

## Troubleshooting

### CloudWatch logs not appearing

Verify the CloudWatch role permissions, log group existence, and that logging is
enabled at both stage and method levels. See the
[full procedure](references/create-api-gateway-stage.md) for details.

### Stage creation fails

Check REST API ID, deployment ID, IAM permissions, and stage naming conventions.

### WAF blocking legitimate requests

Review WAF logs, adjust rules or add exceptions, and consider count mode for testing.
