---
name: debugging-lambda-timeouts
description: Debugs AWS Lambda function timeout failures by systematically analyzing function configuration, CloudWatch logs and metrics, VPC/networking, cold starts, memory constraints, and downstream dependencies to identify root causes with actionable fixes. Use when a Lambda function is timing out or approaching its timeout limit.
version: 1
---

# Debugging Lambda Timeouts

## Overview

Domain expertise for systematically investigating AWS Lambda function timeout failures
by analyzing function configuration, CloudWatch logs, metrics, dependencies, cold start
patterns, and code. Identifies common causes such as insufficient timeout settings,
external service delays, database connection issues, memory constraints, and inefficient
code patterns, then provides prioritized recommendations.

## Debug a Lambda timeout

To investigate and resolve Lambda timeout issues, follow the procedure exactly.
See [Lambda timeout debugging procedure](references/lambda-timeout-debugging.md).

The procedure collects function configuration, CloudWatch metrics and logs, dependency
analysis, and cold start patterns. If Lambda code is provided, it also reviews the code
for timeout-prone patterns. Results are compiled into a structured debugging report with
prioritized recommendations.

## Troubleshooting

### Function not found

Verify the function name and region. Use `aws lambda list-functions --region <region>`
to list available functions.

### No logs available

The function may not have been invoked recently or logging may be disabled. Check the
function's log group configuration and invocation metrics.

### Access denied errors

Verify AWS credentials have permissions for Lambda, CloudWatch Logs, and CloudWatch
Metrics. See the full procedure for details.

### Log query time range issues

If CloudWatch Logs Insights queries fail with time range errors, reduce the analysis
window or check log group retention settings. See the full procedure for details.
