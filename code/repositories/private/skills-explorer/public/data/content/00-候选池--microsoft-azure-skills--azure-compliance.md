---
name: azure-compliance
description: "Run Azure compliance and security audits with azqr plus Key Vault expiration checks. Covers best-practice assessment, resource review, policy/compliance validation, and security posture checks. WHEN: compliance scan, security audit, BEFORE running azqr (compliance cli tool), Azure best practices, Key Vault expiration check, expired certificates, expiring secrets, orphaned resources, compliance assessment."
license: MIT
metadata:
  author: Microsoft
  version: "1.2.2"
---

# Azure Compliance & Security Auditing

## Quick Reference

| Property             | Details                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| Best for             | Compliance scans, security audits, Key Vault expiration checks           |
| Primary capabilities | Comprehensive Resources Assessment, Key Vault Expiration Monitoring      |
| MCP tools            | azqr, subscription and resource group listing, Key Vault item inspection |

## Prerequisites

- Authentication: user is logged in to Azure via `az login`
- Permissions to read resource configuration and Key Vault metadata

## Assessments

| Assessment                      | Reference                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Comprehensive Compliance (azqr) | [references/azure-quick-review.md](references/azure-quick-review.md)                           |
| Key Vault Expiration            | [references/azure-keyvault-expiration-audit.md](references/azure-keyvault-expiration-audit.md) |
| Resource Graph Queries          | [references/azure-resource-graph.md](references/azure-resource-graph.md)                       |

## MCP Tools

| Tool                              | Purpose                                      |
| --------------------------------- | -------------------------------------------- |
| `mcp_azure_mcp_extension_azqr`    | Run azqr compliance scans                    |
| `mcp_azure_mcp_subscription_list` | List available subscriptions                 |
| `mcp_azure_mcp_group_list`        | List resource groups                         |
| `keyvault_key_list`               | List all keys in vault                       |
| `keyvault_key_get`                | Get key details including expiration         |
| `keyvault_secret_list`            | List all secrets in vault                    |
| `keyvault_secret_get`             | Get secret details including expiration      |
| `keyvault_certificate_list`       | List all certificates in vault               |
| `keyvault_certificate_get`        | Get certificate details including expiration |

## Assessment Workflow

1. Select scope (subscription or resource group) for Comprehensive Resources Assessment.
2. Run azqr and capture output artifacts.
3. Analyze Scan Results and summarize findings and recommendations.
4. Review Key Vault Expiration Monitoring output for keys, secrets, and certificates.
5. Classify issues and propose remediation or fix steps for each finding.

### Priority Classification

| Priority | Guidance                                                |
| -------- | ------------------------------------------------------- |
| Critical | Immediate remediation required for high-impact exposure |
| High     | Resolve within days to reduce risk                      |
| Medium   | Plan a resolution in the next sprint                    |
| Low      | Track and fix during regular maintenance                |

## Error Handling

| Error                   | Message        | Remediation                                      |
| ----------------------- | -------------- | ------------------------------------------------ |
| Authentication required | "Please login" | Run `az login` and retry                         |
| Access denied           | "Forbidden"    | Confirm permissions and fix role assignments     |
| Missing resource        | "Not found"    | Verify subscription and resource group selection |

## Best Practices

- Run compliance scans on a regular schedule (weekly or monthly)
- Track findings over time and verify remediation effectiveness
- Separate compliance reporting from remediation execution
- Keep Key Vault expiration policies documented and enforced

## SDK Quick References

For programmatic Key Vault access, see the condensed SDK guides:

- **Key Vault (Python)**: [Secrets/Keys/Certs](references/sdk/azure-keyvault-py.md)
- **Secrets**: [TypeScript](references/sdk/azure-keyvault-secrets-ts.md) | [Rust](references/sdk/azure-keyvault-secrets-rust.md) | [Java](references/sdk/azure-security-keyvault-secrets-java.md)
- **Keys**: [.NET](references/sdk/azure-security-keyvault-keys-dotnet.md) | [Java](references/sdk/azure-security-keyvault-keys-java.md) | [TypeScript](references/sdk/azure-keyvault-keys-ts.md) | [Rust](references/sdk/azure-keyvault-keys-rust.md)
- **Certificates**: [Rust](references/sdk/azure-keyvault-certificates-rust.md)
