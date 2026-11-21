---
inclusion: always
---

# Development Guidelines for CDK with Python

## Naming Conventions

- Functions and variables: `snake_case`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Private attributes: `_leading_underscore`
- Modules: `snake_case.py`
- Test files: `test_*.py` or `*_test.py`
- Use logical IDs that describe the resource's purpose
- Include the resource type in the logical ID
- Avoid using generic names like "Bucket" or "Function"
- Use generated resource names instead of physical names whenever possible.
- If the construct has only one or a single main child resource, call it "Resource" to use the defaultChild functionality of CDK

## Project Organization

### Service-Based Structure

```
service-name/            # One CDK app per deployable service
├── src/                 # Main CDK constructs and stack
│   ├── constructs/      # Service-specific L3 constructs
│   ├── functions/       # Lambda function implementations
│   ├── app.py           # Entry point for CDK app
│   └── stack.py         # Single stack for the service
├── tests/               # Test files
└── utilities/           # Helper functions and scripts
```

- A CDK app is a independently deployable service
- Keep the service specific and focused on a single bounded context
- Shared resources across multiple services (VPC, DNS zones) should be in their own CDK apps in separate repositories

## Code Structure

### Pythonic Programming

Follow the Zen of Python and modern Python idioms:
- Explicit is better than implicit - use clear names and avoid magic
- Flat is better than nested - prefer early returns and guard clauses
- Simple is better than complex - don't over-engineer solutions
- Readability counts - code is read more often than written
- Use list/dict comprehensions judiciously - prefer clarity over cleverness
- Use early returns instead of nested if/else statements
- Leverage Python's truthiness but be explicit when dealing with falsy values
- Keep functions small and focused on a single responsibility
- Use dataclasses or Pydantic for structured data
- Prefer composition over inheritance
- Code should be self-documenting through clear naming and structure. Comments indicate that the code itself is not clear enough. Exception: Docstrings for public APIs are required and should follow Google or NumPy style. Type hints should make the docstring parameter descriptions unnecessary in most cases.
- Use keyword arguments extensively for clarity, especially for functions with multiple parameters

### Lambda Function Design

- The implementation and design of Lambda functions is following a layered architecture consisting of a handler layer, a service layer and a model layer
- The handler layer is responsible for initializing AWS Powertools for Lambda utilities, loading configurations, input validation, passing inputs to the service layer, return output from the service layer back to the caller (ID: HANDLER_LAYER_RESPONSIBILITIES)
- The service layer consists all business logic as well as integration code to process a request. The service layer can and should be shared across multiple Lambda handlers
- The model layer contains pydantic models relevant to process a request handled by a lambda function. Models can and should be shared across multiple Lambda handlers and services

### CDK Stacks Design

- Use a single stack for this CDK app to maintain deployment atomicity
- Avoid splitting related resources across multiple stacks to prevent cross-stack reference issues and preserve rollback capabilities
- Use constructs (L3) for logical grouping instead of multiple stacks
- Only create multiple stacks when:
  - Deploying to different regions
  - Exceeding CloudFormation resource limits (500 resources)
- Define clear interfaces for stack configuration
- Pass environment-specific configuration through stack properties

```python
from aws_cdk import Stack, StackProps
from constructs import Construct

class ServiceStackProps(StackProps):
    instance_type: str
    capacity: int

class ServiceStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, props: ServiceStackProps) -> None:
        super().__init__(scope, construct_id, **props)
```

### CDK Construct Design

- Use L1 constructs only when L2 or L3 constructs are not available for a specific resource
- Use L2 constructs as the default choice for most resources
- Use L3 constructs (patterns) when implementing common architectural patterns or combine multiple resources to solve specific use cases

#### Construct Classes

- Follow the standard construct initialization pattern
- Accept `scope`, `id`, and `props` parameters
- Call `super().__init__(scope, construct_id, **props)` in the constructor
- Initialize resources in the constructor
- Define a clear interface for construct props
- Mark required properties as non-optional
- Provide sensible defaults for optional properties
- Validate props in the constructor
- Throw clear error messages for invalid props
- Extend existing constructs when there's an "is a" relationship
- Use extension to add default properties or behaviors to existing constructs
- Override methods only when necessary to change behavior
- Use composition when there's a "has a" relationship
- Compose constructs to create higher-level abstractions as L3 constructs
- Expose only the necessary properties and methods to consumers
- Use escape hatches only when necessary
- Use them to access features not yet available in higher-level constructs
- Document why the escape hatch is needed
- Use `node.default_child` to access the underlying L1 construct
- Cast to the appropriate type
- Set properties directly on the L1 construct

### CDK Aspects

- Use CDK aspects to modify, validate, or enforce standards across all constructs within a given scope.
- Use CDK aspects to apply consistent tags across all resources
- Use CDK aspects to apply removal policies for ephemeral environments

### Environment Configuration

- Define environment configurations through stack properties
- Configure environments in the CDK app entry point (src/main.ts)
- Avoid using CDK context or environment variables for configuration
- Synthesize all environment configurations simultaneously

Example:

```python
import aws_cdk as cdk
from lib.stack import ServiceStack

app = cdk.App()

ServiceStack(app, "service-dev",
    env=cdk.Environment(account="1234", region="us-east-1"),
    config=dev_config)

ServiceStack(app, "service-prod",
    env=cdk.Environment(account="5678", region="us-east-1"),
    config=prod_config)
```
