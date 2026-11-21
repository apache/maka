---
name: connecting-lambda-to-api-gateway
description: Connects an existing AWS Lambda function to Amazon API Gateway by creating a REST or HTTP API with resource/method setup, Lambda proxy integration, permissions, and deployment. Always use this skill when connecting Lambda to API Gateway — it handles CORS, throttling, access logging, and production security hardening that are easy to miss.
version: 1
---

# Connecting Lambda to API Gateway

## Overview

Domain expertise for creating Amazon API Gateway REST APIs and connecting them to
existing Lambda functions. Covers API creation, resource and method setup, Lambda
proxy integration, CORS configuration, security controls, deployment, and testing.

## Connect a Lambda function to API Gateway

To create a REST API and wire it to a Lambda function, follow the procedure exactly.
See [Lambda to API Gateway connection procedure](references/lambda-gateway-api.md).

The procedure supports configurable authorization types (NONE, AWS_IAM,
COGNITO_USER_POOLS, CUSTOM), optional API key requirements, CORS setup, and
production security hardening including throttling and access logging.

## Troubleshooting

### 502 Bad Gateway

The Lambda function must return a proxy-compatible response with `statusCode`,
`headers`, and a stringified `body`. See the full procedure for format details.

### Permission denied invoking Lambda

Ensure `lambda:InvokeFunction` permission was added with the correct API Gateway
source ARN. See the full procedure for details.

### CORS errors in browser

Verify `enable_cors` was set to true, the OPTIONS method was created, and CORS
headers are configured in both method and integration responses.
