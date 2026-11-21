---
name: "spark-troubleshooting-agent"
displayName: "Troubleshoot Spark applications on AWS"
description: "Troubleshoot Spark applications on AWS EMR, Glue, and SageMaker - analyze failures, identify bottlenecks, get code recommendations. For more info, please see: https://docs.aws.amazon.com/emr/latest/ReleaseGuide/spark-troubleshoot.html"
keywords: ["spark", "emr", "glue", "sagemaker", "troubleshooting", "pyspark", "scala", "performance", "debugging", "aws"]
author: "AWS"
---

# Onboarding

## Step 1: Validate Prerequisites

Before proceeding, ensure the following are installed:

- **AWS CLI**: Required for AWS authentication
  - Verify with: `aws --version`
  - Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

- **Python 3.10+**: Required for MCP proxy
  - Verify with: `python3 --version`

- **uv package manager**: Required for MCP Proxy for AWS
  - Verify with: `uv --version`
  - Install: https://docs.astral.sh/uv/getting-started/installation/

- **AWS Credentials**: Must be configured
  - Verify with: `aws sts get-caller-identity`
  - Verify this role has permissions to deploy Cloud Formation stacks
  - Identify the AWS Profile that the creds are configured for
    - You can do this with `echo ${AWS_PROFILE}`. No response likely means they are using the `default` profile
    - use this profile later when configuring the `smus-mcp-profile`

**CRITICAL**: If any prerequisites are missing, DO NOT proceed. Install missing components first.

## Step 2: Deploy CloudFormation Stack

**Note**: If you already have a role configured with `sagemaker-unified-studio-mcp` permissions, please ignore. However, it is recommended to deploy the stack as will contain latest updatest for permissions and role policies

1. Log into the AWS Console with the role your AWS CLI is configured with - this role must have permissions to deploy Cloud Formation stacks.
1. Navigate to [troubleshooting agent setup page](https://docs.aws.amazon.com/emr/latest/ReleaseGuide/spark-troubleshooting-agent-setup.html#spark-troubleshooting-agent-setup-resources).
1. Deploy Cfn stack / resources to desired region
1. Configure parameters:
   - **TroubleshootingRoleName**: IAM role name
   - **EnableEMREC2**: Enable EMR-EC2 (default: true)
   - **EnableEMRServerless**: Enable EMR Serverless (default: true)  
   - **EnableGlue**: Enable AWS Glue (default: true)
   - **CloudWatchKmsKeyArn**: Optional KMS key for CloudWatch
1. Wait for deployment to succeed.

Region and role ARN will be in the outputs tab. These will be used in the next step

## Step 3: Configure the AWS CLI with the MCP role and Kiro's mcp.json

1. Propmt the user to provide the region and role ARN from the Cfn stack deployment
1. Configure the CLI with the `smus-mcp-profile`
    ```bash
    # run these as a single command so the use doesn't have to approve multiple times
    aws configure set profile.smus-mcp-profile.source_profile <profile with Cloud Formation deployment permissions from earlier>
    aws configure set profile.smus-mcp-profile.role_arn <role arn from Cloud Formation stack, provided by customer>
    aws configure set profile.smus-mcp-profile.region <region from Cloud Formation stack, provided by customer>
    ```
1. then update your MCP json configuration file (typically located at `~/.kiro/settings/mcp.json`) with the region. Only edit your mcp.json, no other local copies, just the one that configures your mcp settings.

# Overview

Troubleshoot Apache Spark applications on Amazon EMR, AWS Glue, and Amazon SageMaker through natural language. The agent analyzes failed jobs, identifies performance bottlenecks, and provides code recommendations.

**Key capabilities:**
- **Failure Analysis**: Analyze failed PySpark and Scala jobs
- **Root Cause Identification**: Correlate telemetry and identify issues
- **Performance Diagnostics**: Find bottlenecks and resource problems
- **Code Recommendations**: Get specific fixes and optimizations
- **Multi-Platform**: EMR EC2, EMR Serverless, Glue, SageMaker

**Note**: Preview service using cross-region inference for AI processing.

## Available MCP Servers

### sagemaker-unified-studio-mcp-troubleshooting
**Connection:** MCP Proxy for AWS
**Authentication:** AWS IAM role assumption
**Timeout:** 180 seconds

Analyzes Spark application failures and identifies root causes through:
- Feature extraction from Spark History Server logs
- Telemetry data collection and analysis
- Root cause identification using AI
- Performance metric correlation
- Error pattern recognition

### sagemaker-unified-studio-mcp-code-rec
**Connection:** MCP Proxy for AWS  
**Authentication:** AWS IAM role assumption
**Timeout:** 180 seconds

Generates code recommendations based on root cause analysis:
- Code pattern analysis
- Optimization recommendations
- Configuration adjustments
- Architectural improvements
- Specific code fixes with examples

## Usage Examples

### Basic Troubleshooting Request

```
"My Spark job on EMR cluster j-XXXXX failed. 
Application ID: application_1234567890_0001
Can you analyze what went wrong?"
```

The agent will:
1. Extract telemetry from Spark History Server
2. Analyze error traces and logs
3. Identify root cause
4. Provide diagnostic explanation

### Request Code Recommendations

```
"Can you suggest code changes to fix this OutOfMemoryError?"
```

The agent will:
1. Analyze code patterns
2. Identify inefficient operations
3. Provide specific code modifications
4. Suggest configuration tuning

## Common Troubleshooting Scenarios

### OutOfMemory Errors

```
"My EMR Serverless job app-XXXXX (job jr-XXXXX) is failing with OutOfMemoryError. 
Can you analyze memory usage and suggest optimizations?"
```

Agent analyzes:
- Executor memory configuration
- Partition sizes and data skew
- Memory-intensive operations
- Provides memory tuning and code optimizations

### Slow Performance

```
"My Glue job glue-job-XXXXX used to complete in 10 minutes but now takes 
over an hour. Can you identify the bottleneck?"
```

Agent analyzes:
- Stage execution times
- Data skew in partitions
- Shuffle operations
- Resource utilization
- Provides partitioning and optimization recommendations

### Data Skew

```
"My SageMaker Spark job has extreme data skew - most tasks finish quickly 
but a few take forever. How can I fix this?"
```

Agent provides:
- Skewed partition identification
- Data distribution analysis
- Salting techniques
- Repartitioning strategies
- Code examples

### Performance Optimization

```
"Can you review my EMR job j-XXXXX configuration and suggest performance optimizations?"
```

Agent reviews:
- Spark configuration settings
- Resource allocation
- Executor and driver sizing
- Dynamic allocation settings
- Shuffle operation tuning

## Best Practices

### ✅ Do:

- **Provide specific identifiers** - Include cluster ID, application ID, or job ID
- **Describe symptoms clearly** - Explain observed vs. expected behavior
- **Include error messages** - Share exact error text
- **Mention the platform** - Specify EMR EC2, EMR Serverless, Glue, or SageMaker
- **Ask follow-up questions** - Dig deeper into recommendations
- **Test in dev first** - Validate changes before production
- **Provide context** - Share data sizes, job frequency, requirements
- **Ask about trade-offs** - Understand performance vs. cost

### ❌ Don't:

- **Skip validation** - Always test code changes before production
- **Ignore root causes** - Address underlying issues, not symptoms
- **Apply blindly** - Consider your specific workload
- **Forget monitoring** - Track metrics after changes
- **Mix issues** - Address one problem at a time
- **Withhold context** - More details = better recommendations

## Troubleshooting

### "Cannot find job or application"
**Cause:** Invalid job ID or inaccessible application
**Solution:**
- Verify job/application ID correct
- Check same region as MCP configuration  
- Ensure IAM role has log access permissions
- Verify logs haven't expired (30 days default for EMR)

### "MCP server timeout"
**Cause:** Analysis exceeds 180-second timeout
**Solution:**
- Break request into smaller parts
- Ask for specific aspects: "analyze memory usage only"
- Request sampling for large jobs: "analyze subset of stages"

### "Insufficient permissions"
**Cause:** IAM role missing permissions
**Solution:**
- Verify CloudFormation stack created successfully
- Check IAM permissions:
  - EMR: `elasticmapreduce:Describe*`, `elasticmapreduce:List*`
  - Glue: `glue:GetJobRun`, `glue:GetJobRuns`
  - S3: `s3:GetObject` for logs
  - CloudWatch: `logs:GetLogEvents`
- Re-deploy CloudFormation if needed

### "No recommendations generated"
**Cause:** No actionable improvements identified
**Solution:**
- Job may be well-optimized
- Ask specific questions: "analyze memory usage"
- Provide more context about expected vs actual performance

## MCP Config Placeholders

**IMPORTANT:** Before using this power, replace the following placeholder in `mcp.json` with your actual value:

- **`{AWS_REGION}`**: The AWS region where you deployed the CloudFormation stack and where your Spark jobs run.
  - **How to get it:** This is the region you selected when deploying the CloudFormation stack in Step 2 of the onboarding process
  - **Examples:** `us-east-1`, `us-west-2`, `eu-west-1`, `ap-southeast-1`
  - **Where to find it:** Check the CloudFormation stack outputs tab for the region, or use the same region where your EMR/Glue/SageMaker resources are located

**After replacing the placeholder, your mcp.json should look like:**
```json
{
  "mcpServers": {
    "sagemaker-unified-studio-mcp-troubleshooting": {
      "type": "stdio",
      "command": "uvx",
      "args": [
        "mcp-proxy-for-aws@latest",
        "https://sagemaker-unified-studio-mcp.us-west-2.api.aws/spark-troubleshooting/mcp",
        "--service",
        "sagemaker-unified-studio-mcp",
        "--profile",
        "smus-mcp-profile",
        "--region",
        "us-west-2",
        "--read-timeout",
        "180"
      ],
      "timeout": 180000,
      "disabled": false
    }
  }
}
```

## Configuration

**Authentication:** AWS IAM role via CloudFormation stack

**Required Permissions:**
- EMR: `elasticmapreduce:Describe*`, `elasticmapreduce:List*`
- Glue: `glue:GetJobRun`, `glue:GetJobRuns`
- SageMaker: `sagemaker:DescribeProcessingJob`
- S3: `s3:GetObject` (logs)
- CloudWatch: `logs:GetLogEvents`

**Supported Platforms:**
- Amazon EMR on EC2
- Amazon EMR Serverless
- AWS Glue (Spark jobs)
- Amazon SageMaker (Spark kernels)

**Supported Languages:**
- PySpark (Python)
- Scala

## Tips

1. **Be specific** - Include cluster ID, application ID, or job run ID
2. **Provide context** - Explain expected vs. actual behavior  
3. **Start with symptoms** - Describe what you're seeing
4. **Ask follow-ups** - Dig deeper into recommendations
5. **Test incrementally** - Apply one change at a time
6. **Monitor results** - Track metrics after changes
7. **Use natural language** - Explain in your own words
8. **Request examples** - Ask for code samples
9. **Consider costs** - Some optimizations use more resources
10. **Review audit logs** - Check CloudTrail for compliance

---

**Service:** Amazon SageMaker Unified Studio MCP (Preview)  
**Provider:** AWS  
**License:** AWS Service Terms
