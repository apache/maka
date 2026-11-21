---
inclusion: always
---

# Testing Strategy

The testing strategy is built upon the **remocal testing** concept, combining the speed of local execution with the confidence of real AWS service integration. This approach enables effective TDD while maintaining high confidence in our serverless infrastructure.

## Testing Pyramid

1. **Unit Tests** (`tests/unit/`): Pure business logic with mocks
   - Fast execution (<1s)
   - Test individual functions and classes

2. **Integration Tests** (`tests/integration/`): AWS Services such as lambda functions that integrate with other AWS services
   - Execute Lambda code locally (1-5s)
   - Connect to real DynamoDB, S3, SNS, etc.
   - Enable full debugging with breakpoints
   - Test AWS service integrations without deployment

### Test Organization

- Save unit tests within the `tests/unit` folder in the project root
- Save integration tests within the `tests/integration` folder in the project root
- Organize the tests with the same folder structure like the files that are being tested in the `src` folder

## CDK Testing

### General

- Keep tests simple and focused on one aspect of behavior
- Use the AWS CDK assertions module for testing CDK constructs
- Use the Arrange-Act-Assert pattern
- Organize tests by construct or stack
- Use descriptive test names that explain the expected behavior
- Focus on testing critical infrastructure components
- Ensure all resource properties are tested

### CDK Unit Tests

- Use fine-grained assertions to test specific aspects of resources
- Use `has_resource_properties` for partial matching and `template_matches` for exact matching
- Use snapshot testing to detect unintended changes in CloudFormation templates
- Update snapshots only when changes are intentional
- Don't rely solely on snapshots; combine with fine-grained assertions

### CDK Integration Tests

- Use the `integ-tests-alpha` module for CDK integration testing
- Define integration tests as CDK applications
- Test that resources are created successfully
- Test interactions between resources
- Clean up resources after tests complete

## Lambda Testing

- Lambda handlers are covered by an integration test that enables us to run a test locally against real cloud resources
