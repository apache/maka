---
name: "aws-mcp"
displayName: "Work with AWS"
description: "Perform complex, multi-step AWS tasks by combining real-time access to AWS documentation, syntactically correct API calls and executions, and pre-built workflows called Agent SOPs that follow AWS best practices"
keywords: ["aws", "aws-mcp", "aws-automation", "aws-best-practices", "agent-sops",  "aws-workflows", "aws-troubleshooting", "aws-resource-management", "aws-cost-management", "aws-cli-alternative", "aws-security", "aws-docs", "aws-cli",  "aws-apis", "multi-step-aws-tasks", "aws-tasks", "security", "aws-sops"]
author: "AWS"
---

# Work with AWS Power

The Work with AWS Power provides secure, authenticated access to AWS services through an intelligent interface that combines documentation, API execution, and guided workflows.

## What Can You Do?

### 1. Execute Multi-Step AWS Workflows (Agent SOPs)
Use pre-built, tested workflows that follow AWS best practices:
- Set up production VPCs with proper networking
- Deploy serverless applications
- Configure monitoring and alerting
- Troubleshoot common AWS issues
- Implement security best practices

**Example:** "Help me set up a production VPC with public and private subnets"

### 2. Get Real-Time AWS Knowledge
- Best practices: Discover best practices around using AWS APIs and services
- API documentation: Learn about how to call APIs including required and optional parameters and flags
- Getting started: Find out how to quickly get started using AWS services while following best practices
- The latest information: Access the latest announcements about new AWS services and features
- Regional availability information: Access which AWS APIs and CloudFormation resources are available in which regions
- Full-stack development: Learn how to build complete applications using AWS Amplify with frontend and backend integration guidance
- Infrastructure as code development: Access the latest CDK and CloudFormation guidance, best practices, and code examples to model your infrastructure in code

**Example:** "What are the best practices for Lambda function configuration?"

### 3. Make Authenticated AWS API Calls
Execute AWS APIs securely through your existing credentials:
- 15,000+ AWS APIs available
- Automatic SigV4 authentication
- Syntax validation before execution
- Structured error handling

**Example:** "List all my Lambda functions" or "Create an S3 bucket with encryption"

### 4. Troubleshoot AWS Issues
Debug and resolve problems efficiently:
- Analyze CloudWatch logs
- Review CloudTrail events
- Investigate permission errors
- Diagnose performance issues
- Get actionable recommendations

**Example:** "Why is my Lambda function timing out?"

### 5. Provision and Configure Infrastructure
Create and manage AWS resources:
- VPCs, subnets, and networking
- Compute instances (EC2, Lambda, ECS)
- Databases (RDS, DynamoDB)
- Storage (S3, EFS)
- Security groups and IAM roles

**Example:** "Create a Lambda function that processes S3 events"

### 6. Manage Costs
Monitor and optimize AWS spending:
- Set up billing alerts
- Analyze resource usage
- Understand cost allocation
- Get optimization recommendations

**Example:** "Show me my highest cost resources this month"

---

## Quick Start

**Already have AWS CLI configured?** Try these commands right away:

```
"List my Lambda functions"
"Show me my S3 buckets"
"What's my current AWS identity?"
"Search AWS docs for VPC best practices"
```

**New to AWS?** Follow the onboarding section below for complete setup.

---

## Onboarding

### Prerequisites

Before using the Work with AWS Power, ensure you have:

1. **AWS CLI** (version 2.32.0 or later recommended)
   - Check: `aws --version`
   - Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

2. **UV** (Python package manager)
   - Check: `uv --version`
   - Install: https://docs.astral.sh/uv/getting-started/installation/

### Step 1: Configure AWS Credentials

You must ensure that there is valid aws credential. This is required for the aws-mcp to function properly.

**Configure credentials using one of these methods:**

#### Option A: AWS CLI Configure
```bash
aws configure
```
Enter your Access Key ID, Secret Access Key, default region, and output format.

#### Option B: Environment Variables
```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_DEFAULT_REGION=us-east-1
```

#### Option C: AWS SSO
```bash
aws configure sso
```

**Verify credentials:**
```bash
AWS_PAGER="" aws sts get-caller-identity
```

### Step 2: Start Using the Power

Once credentials are configured, you can immediately start using the power:
- "List my Lambda functions"
- "Search AWS docs for S3 bucket policies"
- "Help me create a VPC"

---

## Available Tools

The Work with AWS Power provides these core tools:

### Documentation & Knowledge
- **search_documentation** - Search AWS docs, best practices, and guides
- **read_documentation** - Read specific AWS documentation pages
- **recommend** - Get related documentation recommendations
- **get_regional_availability** - Check service availability by region
- **list_regions** - List all AWS regions

### AWS API Execution
- **call_aws** - Execute AWS CLI commands with validation
- **suggest_aws_commands** - Get command suggestions for unclear requests

### Guided Workflows
- **retrieve_agent_sop** - Get step-by-step procedures for complex tasks

Available SOPs include:
- VPC setup and networking
- Lambda deployment and configuration
- EC2 instance management
- S3 bucket security
- CloudWatch monitoring
- RDS database setup
- And many more...

---

## Common Workflows

### Getting Started
```
"What AWS services are available in us-west-2?"
"Show me the AWS Lambda best practices"
"List all my EC2 instances"
```

### Infrastructure Management
```
"Create a new VPC with public and private subnets"
"Launch an EC2 instance with best practices"
"Set up a Lambda function with DynamoDB access"
"Create an S3 bucket with versioning and encryption"
```

### Troubleshooting
```
"Why is my Lambda function failing?"
"Analyze CloudWatch logs for errors in the last hour"
"Check my IAM permissions for S3"
"Debug why my EC2 instance won't start"
```

### Cost Management
```
"Show me my AWS spending this month"
"Create a billing alert for $100"
"Which resources are costing the most?"
"Find unused EBS volumes to save costs"
```

---

## Best Practices

### Security
- Always use least-privilege IAM policies
- Enable MFA for AWS accounts
- Regularly rotate credentials
- Use AWS SSO when available

### Cost Optimization
- Tag all resources for cost tracking
- Use billing alerts
- Review unused resources regularly
- Consider Reserved Instances for steady workloads

### Operations
- Follow AWS best practices
- Use Agent SOPs for complex tasks
- Test in non-production environments first
- Document your infrastructure

---

## Tips for Effective Use

1. **Be Specific**: Instead of "help with Lambda", try "create a Lambda function that processes S3 events"

2. **Use Natural Language**: You don't need to know exact AWS CLI syntax - describe what you want to do

3. **Leverage SOPs**: For complex tasks, ask "Is there an SOP for..." to get guided workflows

4. **Search First**: Before making changes, search documentation to understand best practices

5. **Verify Credentials**: If commands fail, check `aws sts get-caller-identity` to ensure credentials are valid

---

## Troubleshooting

### "Access Denied" Errors
- Verify credentials are valid: `AWS_PAGER="" aws sts get-caller-identity`
- If credentials are valid, verify that your AWS user/role has the required permissions to access the AWS MCP server. Your credentials need the following IAM policy:
  ```json
  {
      "Version": "2012-10-17",
      "Statement": [
          {
              "Effect": "Allow",
              "Action": [
                  "aws-mcp:InvokeMcp",
                  "aws-mcp:CallReadOnlyTool",
                  "aws-mcp:CallReadWriteTool"
              ],
              "Resource": "*"
          }
      ]
  }
  ```
- Additionally, ensure you have permissions for the specific AWS services you want to interact with (EC2, Lambda, S3, etc.)
- Ensure you're in the correct AWS region

### "Command Not Found"
- Verify AWS CLI is installed: `aws --version`
- Check your PATH includes AWS CLI
### "Invalid Credentials"
- Re-run credential configuration
- Check if credentials have expired (especially SSO)
- Verify MFA token if required

---

## Learn More

- AWS Documentation: https://docs.aws.amazon.com
- AWS CLI Reference: https://docs.aws.amazon.com/cli/latest/reference/

---

## Support

For issues with the Work with AWS Power:
1. Check your AWS credentials are valid
2. Verify AWS CLI and UV are installed
3. Review the troubleshooting section above
