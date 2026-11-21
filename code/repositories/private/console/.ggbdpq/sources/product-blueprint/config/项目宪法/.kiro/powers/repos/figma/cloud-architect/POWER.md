---
name: "cloud-architect"
displayName: "Build infrastructure on AWS"
description: "Build AWS infrastructure with CDK in Python following AWS Well-Architected framework best practices"
keywords: ["aws", "cdk", "python", "infrastructure", "iac", "cloudformation","lambda", "well-architected"]
author: "Christian Bonzelet"
---

# Cloud Architect Power

A specialized power for building AWS infrastructure with CDK in Python, following AWS Well-Architected framework best practices.

## Overview

The CDK power provides AI assistance for designing, implementing, and optimizing AWS infrastructure as code using the AWS CDK with Python. It combines multiple AWS MCP servers with curated steering files to help you build well-architected cloud services.

## Features

- **AWS Service Integration**: Access to AWS APIs, pricing, and knowledge base
- **Documentation Access**: Fetch boto3 and AWS CDK for Python documentation via Context7
- **Best Practices**: Built-in guidance for CDK patterns, Python conventions, and AWS Well-Architected principles
- **Cost Analysis**: Real-time AWS pricing information
- **Web Content**: Retrieve and process web documentation

## MCP Servers

This power includes the following MCP servers:

### awspricing
- **Purpose**: Access real-time AWS pricing information and cost analysis
- **Command**: `uvx awslabs.aws-pricing-mcp-server@latest`
- **Timeout**: 120 seconds

### awsknowledge
- **Purpose**: Discover AWS best practices, API documentation, and service announcements
- **Type**: HTTP server
- **URL**: https://knowledge-mcp.global.api.aws

### awsapi
- **Purpose**: Execute AWS CLI commands with validation and error handling
- **Command**: `uvx awslabs.aws-api-mcp-server@latest`
- **Region**: us-east-2 (configurable via AWS_REGION env var)

### context7
- **Purpose**: Fetch documentation and code examples for boto3 and AWS CDK for Python
- **Command**: `npx -y @upstash/context7-mcp`
- **Timeout**: 120 seconds

### fetch
- **Purpose**: Retrieve and process web content, converting HTML to markdown
- **Command**: `uvx mcp-server-fetch`

## Steering Files

The power includes comprehensive steering guidance covering:

### Core Principles
- AWS CDK with Python specialization
- AWS Well-Architected framework adherence
- Security and code convention compliance
- AWS Powertools for Lambda integration

### Development Guidelines
- **Naming Conventions**: snake_case for functions, PascalCase for classes, logical resource IDs
- **Project Organization**: Service-based structure with single CDK app per deployable service
- **Code Structure**: Pythonic programming following the Zen of Python
- **Lambda Design**: Layered architecture (handler, service, model layers)
- **CDK Stacks**: Single stack per app for deployment atomicity
- **CDK Constructs**: L2 constructs as default, L3 for patterns, L1 only when necessary

### Testing Strategy
- **Remocal Testing**: Combines local execution speed with real AWS service integration
- **Unit Tests**: Pure business logic with mocks (<1s execution)
- **Integration Tests**: Lambda code locally with real AWS services (1-5s execution)
- **CDK Testing**: Fine-grained assertions and snapshot testing

## Usage

This power is designed to assist with:

1. **Infrastructure Design**: Help select appropriate AWS services and design architecture
2. **CDK Implementation**: Generate CDK constructs and stacks following best practices
3. **Lambda Functions**: Create layered Lambda implementations with AWS Powertools
4. **Cost Optimization**: Analyze pricing and suggest cost-effective alternatives
5. **Security**: Apply security best practices and validate configurations
6. **Testing**: Generate unit and integration tests following the remocal testing approach

## Configuration

The power is pre-configured with:
- Default AWS region: us-east-2 (modify AWS_REGION in awsapi server config)
- Error logging level: ERROR for FastMCP servers
- Timeouts: 120 seconds for stdio servers

## Requirements

- **uv/uvx**: Python package manager for running MCP servers
- **npx**: Node package runner for Context7
- **AWS Credentials**: Configured for awsapi server access
- **Python 3.x**: For CDK development

## Best Practices

When using this power:

1. Start with clear service boundaries and bounded contexts
2. Use single stacks unless you have specific reasons for multiple stacks
3. Prefer L2 constructs, use L3 for patterns, avoid L1 unless necessary
4. Follow the layered architecture for Lambda functions
5. Write integration tests that run locally against real AWS services
6. Use keyword arguments extensively for clarity
7. Keep code self-documenting through clear naming
8. Apply CDK aspects for cross-cutting concerns like tagging

## Example Workflow

```python
# 1. Define stack props with clear interface
class ServiceStackProps(StackProps):
    instance_type: str
    capacity: int

# 2. Create stack with single responsibility
class ServiceStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, props: ServiceStackProps):
        super().__init__(scope, construct_id, **props)
        # Initialize resources

# 3. Configure environments in app entry point
app = cdk.App()
ServiceStack(app, "service-dev",
    env=cdk.Environment(account="1234", region="us-east-1"),
    config=dev_config)
```

## Support

For issues or questions about this power:
- Check AWS CDK documentation via Context7
- Query AWS best practices via awsknowledge
- Fetch latest AWS announcements and service updates
- Analyze costs with awspricing tools
