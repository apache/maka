---
name: "aws-infrastructure-as-code"
displayName: "Build AWS infrastructure with CDK and CloudFormation"
description: "Build well-architected AWS infrastructure with CDK using latest documentation, best practices, and code samples. Validate CloudFormation templates, check resource configuration security compliance, and troubleshoot deployments."
keywords: ["aws", "cdk", "cloudformation", "troubleshoot", "validate", "compliance", "cfn-lint", "cfn-guard", "infrastructure", "iac", "template", "stack", "construct", "resource", "deployment"]
author: "AWS"
---

# AWS Infrastructure as Code

## Overview

Build well-architected CDK applications using the latest documentation on constructs and best practices, and improved correctness with CloudFormation resource configuration syntax validation, compliance and troubleshooting tools.

## When to Use This Power

**Build high-quality CDK applications**
Use this power to create or update high-quality CDK applications by accessing the latest construct documentation, applying CDK best practices, and learning from gold-standard code samples across TypeScript, Python, Java, C#, and Go. The power helps you build infrastructure that follows established patterns and CDK-NAG security checks from the start.

**Ensure CloudFormation template reliability and security**
Use this power to validate templates before deployment, check security compliance against AWS Guard Rules and Control Tower controls, get pre-deployment validation guidance, and troubleshoot failed deployments with intelligent failure analysis. The power helps you catch issues early and resolve problems quickly with CloudTrail deep links and pattern-based diagnostics.

## Onboarding

### Prerequisites

**Most features work without AWS credentials:**
- CDK documentation search and code samples
- Writing CDK code
- Synthesizing CDK to CloudFormation (`cdk synth`)
- CloudFormation template validation (cfn-lint)
- Security compliance checking (cfn-guard)
- Documentation reading

**AWS credentials are required for:**
- Deploying CDK applications (`cdk deploy`)
- Troubleshooting failed CloudFormation deployments (uses AWS APIs to read stack events and CloudTrail)

### AWS Credentials Setup (Optional)

**Skip this section if you only need CDK development and template validation.**

If you plan to troubleshoot CloudFormation deployments, configure AWS credentials:

**Step 1: Configure AWS CLI**
```bash
aws configure
```

Provide:
- AWS Access Key ID
- AWS Secret Access Key
- Default region (e.g., us-east-1)
- Output format (json recommended)

**Step 2: Verify credentials**
```bash
aws sts get-caller-identity
```

**Step 3: Ensure IAM permissions**

Your AWS credentials need these permissions for troubleshooting:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudtrail:LookupEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

## CDK Development Workflow

Follow this workflow when building AWS infrastructure with CDK:

### 1. Research and Design

Search for constructs, patterns, and working examples:

```javascript
// Find construct APIs and usage patterns
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "search_cdk_documentation", {
  "query": "Lambda function with DynamoDB"
})

// Get code samples in your language (typescript, python, java, csharp, go)
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "search_cdk_samples_and_constructs", {
  "query": "Lambda DynamoDB CRUD",
  "language": "python"
})

// Read complete construct documentation if needed
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "read_iac_documentation_page", {
  "url": "https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda-readme.html"
})
```

### 2. Apply Best Practices

Learn recommended patterns before writing code:

```javascript
// Get comprehensive CDK best practices
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "cdk_best_practices", {})
```

Key principles:
- Prefer L2 constructs, use L3 for patterns, avoid L1 unless necessary
- Follow language-specific idioms (TypeScript, Python, Java, C#, Go)
- Apply CDK-NAG security checks from the start
- Use meaningful construct IDs and logical names

### 3. Write CDK Code

Implement your infrastructure using the patterns and examples from steps 1-2.

### 4. Synthesize and Validate

**Always synthesize your CDK code first** to validate it generates valid CloudFormation:

```bash
# Synthesize CDK code to CloudFormation template
cdk synth

# Or save to file for validation
cdk synth > template.yaml
```

This step validates your CDK code compiles correctly and generates valid CloudFormation. Then validate the full generated template:

```javascript

// Validate syntax and schema
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "validate_cloudformation_template", {
  "template_content": "<your-full-synthesized-template-as-YAML-or-JSON-string>",
  "regions": ["us-east-1"]
})

// Check security compliance
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "check_cloudformation_template_compliance", {
  "template_content": "<your-full-synthesized-template-as-YAML-or-JSON-string>"
})

// Get pre-deployment validation guidance
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "get_cloudformation_pre_deploy_validation_instructions", {})
```

### 5. Deploy

```bash
cdk deploy
```

### 6. Troubleshoot (If Needed)

If deployment fails, use intelligent failure analysis:

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "troubleshoot_cloudformation_deployment", {
  "stack_name": "your-stack-name",
  "region": "us-east-1",
  "include_cloudtrail": true
})

// Search CloudFormation docs for resource-specific issues
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "search_cloudformation_documentation", {
  "query": "AWS::Lambda::Function error messages"
})
```

## Best Practices

### For CDK Development

- **Search before coding** - Use `search_cdk_documentation` and `search_cdk_samples_and_constructs` to find proven patterns before implementing
- **Learn from examples** - Gold-standard code samples show idiomatic usage across all supported languages (TypeScript, Python, Java, C#, Go)
- **Apply CDK best practices early** - Call `cdk_best_practices` to understand recommended patterns for configuration, coding, constructs, security, and testing
- **Follow language conventions** - Each language (TypeScript, Python, Java, C#, Go) has idiomatic patterns - use code samples to learn them
- **Always synthesize to validate** - Run `cdk synth` after writing CDK code to validate it compiles and generates valid CloudFormation
- **Read complete documentation** - Use `read_iac_documentation_page` when you need full details on construct properties and methods

### For CloudFormation Resource Configuration Validation

- **Validate early and often** - Run `validate_cloudformation_template` on full synthesized templates before deployment to catch syntax errors
- **Check compliance before production** - Use `check_cloudformation_template_compliance` to catch security issues before they reach production
- **Understand pre-deployment validation** - Use `get_cloudformation_pre_deploy_validation_instructions` to learn about CloudFormation's change set validation
- **Validate for target regions** - Specify the regions where you'll deploy to catch region-specific issues
- **Fix issues incrementally** - Address validation errors one at a time, re-validate after each fix

### For CloudFormation Troubleshooting

- **Use pattern-based diagnostics** - `troubleshoot_cloudformation_deployment` matches against 30+ known failure patterns for faster resolution
- **Enable CloudTrail links** - Set `include_cloudtrail: true` to get deep links for detailed event investigation
- **Search documentation for context** - Use `search_cloudformation_documentation` to understand resource-specific error messages
- **Check recent changes** - Failed deployments often relate to recent template or configuration changes
- **Validate before redeploying** - After fixing issues, validate the template again before attempting another deployment

## MCP Servers

This power includes the `awslabs.aws-iac-mcp-server` MCP server which provides the following tools:

### Documentation Tools

- **read_iac_documentation_page** - Fetches and converts CDK or CloudFormation documentation pages to markdown for reading complete resource references, API docs, and implementation guides

### CloudFormation Tools

- **validate_cloudformation_template** - Validates CloudFormation template syntax and schema using cfn-lint, returning specific fix suggestions with line numbers
- **check_cloudformation_template_compliance** - Checks CloudFormation templates against security and compliance rules using cfn-guard with detailed remediation guidance
- **troubleshoot_cloudformation_deployment** - Analyzes failed CloudFormation stacks with pattern matching against 30+ known failure cases and provides CloudTrail deep links
- **search_cloudformation_documentation** - Searches CloudFormation documentation for resource types, properties, template syntax, and best practices
- **get_cloudformation_pre_deploy_validation_instructions** - Returns CLI commands and guidance for CloudFormation's pre-deployment validation during change set creation

### CDK Tools

- **search_cdk_documentation** - Searches CDK API Reference, Best Practices Guide, Code Samples, and CDK-NAG rules for constructs, patterns, and implementation guidance
- **search_cdk_samples_and_constructs** - Finds CDK code samples and community constructs across multiple languages (TypeScript, Python, Java, C#, Go)
- **cdk_best_practices** - Provides comprehensive CDK best practices for application configuration, coding, constructs, security, and testing

## Tool Usage Examples

### Validate CloudFormation Template

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "validate_cloudformation_template", {
  "template_content": `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: my-app-bucket
  `,
  "regions": ["us-east-1"]
})
```

### Check Template Compliance

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "check_cloudformation_template_compliance", {
  "template_content": `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: my-app-bucket
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: AES256
  `
})
```

### Troubleshoot Failed Stack

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "troubleshoot_cloudformation_deployment", {
  "stack_name": "my-app-stack",
  "region": "us-east-1",
  "include_cloudtrail": true
})
```

### Search CloudFormation Documentation

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "search_cloudformation_documentation", {
  "query": "AWS::Lambda::Function properties"
})
```

### Read Full Documentation Page

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "read_iac_documentation_page", {
  "url": "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html"
})
```

### Search CDK Documentation

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "search_cdk_documentation", {
  "query": "S3 bucket encryption best practices"
})
```

### Find CDK Code Samples

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "search_cdk_samples_and_constructs", {
  "query": "Lambda function with VPC",
  "language": "typescript"
})
```

### Get CDK Best Practices

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "cdk_best_practices", {})
```

### Get Pre-Deploy Validation Instructions

```javascript
usePower("aws-infrastructure-as-code", "awslabs.aws-iac-mcp-server", "get_cloudformation_pre_deploy_validation_instructions", {})
```

## AWS Credentials & Permissions

See the [Onboarding](#onboarding) section for AWS credentials setup. Only the `troubleshoot_cloudformation_deployment` tool requires AWS credentials - all other tools work without them.

## Security Considerations

⚠️ **Privacy Notice**: This MCP server executes AWS API calls using your credentials and shares the response data with your third-party AI model provider (e.g., Amazon Q, Claude Desktop, Cursor, VS Code). Users are responsible for understanding your AI provider's data handling practices and ensuring compliance with your organization's security and privacy requirements when using this tool with AWS resources.


