---
name: connecting-lambda-to-dynamodb
description: Connects an AWS Lambda function to DynamoDB with IAM roles, stream event source mapping, and read/write permissions. Use when setting up Lambda-DynamoDB integration, processing DynamoDB stream events, or deploying serverless event-driven architectures.
version: 1
---

# Connecting Lambda to DynamoDB

## Overview

Domain expertise for connecting AWS Lambda functions to DynamoDB tables, including
IAM execution role creation, function deployment, DynamoDB stream configuration,
and event source mapping setup.

## Connect a Lambda function to DynamoDB

To set up end-to-end Lambda-DynamoDB integration with IAM roles, streams, and
event source mapping, follow the procedure exactly.
See [Lambda-DynamoDB connection procedure](references/lambda-dynamodb-connection.md).

## Troubleshooting

### Lambda function not triggering

Verify the event source mapping is active, DynamoDB streams are enabled with the
correct view type, and the execution role has proper permissions. See the full
[procedure](references/lambda-dynamodb-connection.md) for details.

### Permission denied errors

Check the IAM role has `AWSLambdaDynamoDBExecutionRole` attached and the trust
policy allows Lambda to assume it.

### Function timeout issues

Increase the timeout setting or adjust the batch size in the event source mapping.
