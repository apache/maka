# Terraform MCP Server Usage Instructions

Guidelines for using the Terraform MCP server to generate high-quality Terraform code.

## Core Capabilities

- **Registry Integration**: Access public and private Terraform registries for module/provider info
- **Style Guide Compliance**: Consistent HCL/TF file generation
- **Workflow Automation**: HCP Terraform and Terraform Enterprise API operations

## Operational Guidelines

### Pre-Generation Phase

**ALWAYS** consult the MCP server before generating Terraform code to:

1. Retrieve latest provider documentation and constraints
2. Access organization-specific styling guidelines
3. Identify available modules and their requirements
4. Understand enterprise-specific policies

### Registry Search Priority

When enterprise tools are enabled AND a Terraform token is provided:

1. **First**: Search private registries for modules and providers
2. **Second**: Fall back to public registry if no results
3. **Document**: Note the source registry in comments

### Provider Consistency Rules

**CRITICAL**: Maintain provider version consistency across all modules:

- Verify provider requirements before module creation
- Ensure compatible provider version constraints
- Flag any provider version conflicts before code generation
- Use explicit version pinning when required

### Validation Workflow

Execute validation in this order:

1. **terraform validate**: Run immediately after code generation
   - Verify syntax correctness
   - Check resource attribute validity
   - Ensure provider configuration completeness

2. **terraform plan**: Only after successful validation
   - Review resource changes
   - Identify potential issues before apply

### User Confirmation Requirements

**MANDATORY**: Request explicit user confirmation before:

- `create_run`: Initiates a new Terraform run
- `apply_run`: Applies changes to infrastructure
- `discard_run`: Discards a planned run
- `cancel_run`: Cancels an in-progress run

**Confirmation prompt should include**:
- Clear description of the operation
- List of resources to be affected
- Potential risks or impacts
- Request for explicit "yes/no" confirmation

## Error Handling

1. **Registry Access Failure**: Log error, attempt fallback, inform user
2. **Validation Errors**: Parse messages, provide remediation steps, re-validate
3. **Plan Failures**: Analyze output, suggest adjustments, document assumptions

## Best Practices

### Context Preservation
- Maintain state of previous MCP server queries within session
- Track which registries have been searched
- Remember user preferences stated earlier

### Progressive Enhancement
- Start with minimal viable configuration
- Iteratively add complexity based on validation results
- Use MCP server feedback to refine generated code

### Documentation Generation
- Include inline comments explaining non-obvious configurations
- Document registry sources for modules
- Add README sections for complex modules

### Security Considerations
- Never expose Terraform tokens in outputs
- Sanitize sensitive data in error messages
- Follow principle of least privilege for API operations

## Troubleshooting Checklist

- [ ] MCP server connection verified
- [ ] Appropriate registry searched based on token availability
- [ ] Style guide resources retrieved and applied
- [ ] Provider consistency validated across modules
- [ ] terraform validate executed successfully
- [ ] terraform plan reviewed (if applicable)
- [ ] User confirmation obtained for destructive operations
