---
name: aws-social-messaging
description: Manages WhatsApp messaging through AWS End User Messaging Social. Covers managing templates (create, update, delete, library), sending messages (utility/marketing/auth templates and freeform), uploading and managing media, configuring event destinations for delivery tracking, and troubleshooting delivery failures. Applicable when a user needs to send WhatsApp messages, create or manage templates, upload media, configure delivery notifications, or diagnose messaging issues.
version: 1
---

# AWS End User Messaging Social — WhatsApp

## Overview

WhatsApp messaging via AWS End User Messaging Social: template management, sending, media handling, event destinations, and delivery troubleshooting.

**Recommended setup:** Use the [AWS MCP server](https://docs.aws.amazon.com/agent-toolkit/latest/userguide/mcp-server.html) for sandboxed execution, audit logging, and enterprise controls.

**Without AWS MCP:** This skill works with any agent that has AWS CLI access. All commands use standard AWS CLI syntax.

## Common Tasks

### 1. Verify Dependencies

**Constraints:**

- The AWS MCP server is recommended for seamless API execution but not required — all commands use standard AWS CLI syntax
- You MUST verify the AWS CLI is installed and configured with appropriate credentials
- You SHOULD recommend the user assume an IAM role with ephemeral credentials
- You MUST inform the user if any required tool is missing and how to install/configure it
- You MUST ask the user if they want to proceed despite any missing tools
- If the `aws socialmessaging` subcommand is not recognized, the user must update to the latest AWS CLI version
- Required IAM permissions (scope to specific WABA and phone number ARNs):
  - Templates: `social-messaging:CreateWhatsAppMessageTemplate`, `social-messaging:GetWhatsAppMessageTemplate`, `social-messaging:ListWhatsAppMessageTemplates`, `social-messaging:UpdateWhatsAppMessageTemplate`, `social-messaging:DeleteWhatsAppMessageTemplate`, `social-messaging:ListWhatsAppTemplateLibrary`, `social-messaging:CreateWhatsAppMessageTemplateFromLibrary`
  - Sending: `social-messaging:SendWhatsAppMessage`
  - Media: `social-messaging:PostWhatsAppMessageMedia`, `social-messaging:CreateWhatsAppMessageTemplateMedia`, `social-messaging:GetWhatsAppMessageMedia`, `social-messaging:DeleteWhatsAppMessageMedia`
  - Events: `social-messaging:PutWhatsAppBusinessAccountEventDestinations`
  - Diagnostics: `social-messaging:GetLinkedWhatsAppBusinessAccount`, `social-messaging:GetLinkedWhatsAppBusinessAccountPhoneNumber`, `social-messaging:ListLinkedWhatsAppBusinessAccounts`
  - Supporting: `sns:ListSubscriptionsByTopic`, `iam:PassRole` (for event destination role)

### 2. Manage Templates

Create, update, and delete message templates (utility, marketing, authentication).

- `create-whatsapp-message-template`: base64-encode `--template-definition` (blob type)
- `create-whatsapp-message-template-from-library`: use pre-approved Meta library templates
- `list-whatsapp-template-library`: browse available library templates
- `get-whatsapp-message-template`: retrieve template details by `--id` (WABA) and `--meta-template-id`
- `update-whatsapp-message-template`: modify existing template content
- `delete-whatsapp-message-template`: requires `--template-name` (NOT `--meta-template-name`); always include `--delete-all-languages`
- `list-whatsapp-message-templates`: response fields are `templateStatus` and `templateCategory` (NOT `status`/`category`)
- Templates with `{{N}}` parameters MUST include `"parameter_format": "positional"` (exception: AUTHENTICATION — Meta handles OTP parameters automatically) and `"example"`
- Meta reviews all templates (minutes to 24h); MUST NOT send with PENDING/REJECTED
- Choosing the wrong category causes reclassification (UTILITY → MARKETING) which changes pricing — see [managing-templates.md — Choosing the Right Category](references/managing-templates.md) for guidance on selecting UTILITY vs MARKETING vs AUTHENTICATION
- You MUST confirm the intended category (UTILITY, MARKETING, or AUTHENTICATION) with the user before creating a template — explain the categorization criteria and reclassification risk if the choice is ambiguous

See [managing-templates.md](references/managing-templates.md).

### 3. Send Messages

#### Template Messages (no 24h restriction)

- Use for: transactional updates (utility), promotions (marketing), verification codes (authentication)
- Collect: phone number ID, recipient (E.164 with `+`), template name, language, parameters
- Marketing templates may include image headers
- `--message` is blob type — MUST base64-encode JSON

#### Freeform Messages (24h window required)

- Use for: customer service replies within 24h of customer's last inbound message
- Supports: text, image, document, video, audio — see [WhatsApp Cloud API media reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media) for supported format and size constraints
- No API to check window status — user must confirm from logs or event history
- Media URLs MUST be publicly accessible HTTPS and remain available for the full 30-day message availability window (Meta can re-fetch anytime). For sensitive content (receipts, invoices, PII), upload via `post-whatsapp-message-media` and reference by media ID instead — presigned URLs cannot satisfy the 30-day availability requirement

**Constraints for all sends:**

- Before executing any API call, validate parameter formats:
  - Phone number IDs match `phone-number-id-*` pattern
  - WABA IDs match `waba-*` pattern
  - Recipient numbers are E.164 with `+` prefix (e.g., `+14155551234`), or Business-Scoped User ID (BSUID) via the `"recipient"` field
  - Template names contain only lowercase letters, numbers, and underscores
  - Language codes use Meta's locale format with underscores (e.g., `en_US`, `pt_BR`)
  - `--meta-api-version` is `v{Major}.{Minor}` format (e.g., `v21.0`)
- `"messaging_product"` MUST be `"whatsapp"` in the JSON body; check [Meta's Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog) for the supported Meta Graph API version
- `--message` is blob type — MUST base64-encode the JSON payload
- A successful `messageId` means queued, not delivered
- You MUST ask for all required parameters upfront in a single prompt
- You MUST accept parameters as individual values, JSON objects, or file references
- You MUST explain each step before executing
- You SHOULD confirm all parameters with the user before executing
- You MUST respect the user's decision to abort
- You MUST NOT send more than 5 messages per batch without user confirmation
- You MUST NOT create or access credentials directly

See [sending-messages.md](references/sending-messages.md).

### 4. Manage Media

Upload, retrieve, and delete media for messages and template headers.

- `post-whatsapp-message-media`: upload media, returns reusable media ID
- `create-whatsapp-message-template-media`: upload media specifically for template headers
- `get-whatsapp-message-media`: retrieve media metadata/URL by ID
- `delete-whatsapp-message-media`: remove uploaded media

See [managing-media.md](references/managing-media.md).

### 5. Configure Event Destinations

Set up delivery tracking, template status notifications, and reclassification alerts.

Set up delivery tracking, template status notifications, and reclassification alerts. A WABA can only have one event destination. See [configuring-event-destinations.md](references/configuring-event-destinations.md) for prerequisites (IAM role, SNS topic with KMS encryption, HTTPS-only subscription endpoints, condition keys) and full security controls.

### 6. Troubleshoot Delivery

Diagnostic flow: WABA status → phone number → templates → event destinations → quotas.

- `get-linked-whatsapp-business-account`: registration MUST be COMPLETE
- `get-linked-whatsapp-business-account-phone-number`: verify phone number health
- `list-linked-whatsapp-business-accounts`: list all WABAs
- Template reclassified: detectable via event destinations (real-time) or by listing templates and comparing categories; delete and recreate
- 24h window expired: use template message instead
- Rate limiting: new WABAs have lower limits; increases with quality
- Recipient without WhatsApp: silently dropped

See [troubleshooting-delivery.md](references/troubleshooting-delivery.md).

## Quick Reference — Common Errors

- **Access denied**: verify IAM permissions scoped to WABA/phone number ARNs
- **Template rejected**: body must match category; include `parameter_format` and `example`
- **Template reclassified**: configure event destinations to detect; delete and recreate
- **24h window expired**: use template message instead of freeform
- **Send fails**: `--origination-phone-number-id` is the ID (not phone number); recipient E.164 with `+`
- **Queued but not delivered**: 200 = queued; configure event destinations for status
- **Media URL inaccessible**: must be publicly accessible HTTPS

## Security Considerations

- Use least-privilege IAM policies scoped to specific `social-messaging:` actions and WABA/phone number ARNs
- Use ephemeral credentials (IAM roles) instead of long-lived access keys
- Store secrets in AWS Secrets Manager or Parameter Store — never in code or environment variables
- Enable CloudTrail for auditing all `social-messaging` API calls; encrypt logs with KMS CMK
- Encrypt SNS topics for event destinations with KMS (callbacks contain recipient metadata)
- Encrypt CloudWatch Logs with KMS if monitoring social-messaging activity
- Avoid sensitive data in template parameters and freeform message content (they appear in CloudTrail logs)
- Validate recipient phone numbers to prevent unauthorized messaging
- Verify SNS subscription endpoints are authorized by your team — validate that all subscribed email addresses and systems belong to personnel/systems that should receive sensitive delivery status and recipient metadata before confirming subscriptions. Use HTTPS-only endpoints
- Add condition keys (`aws:SourceArn`, `aws:SourceAccount`) to SNS topic policies to prevent confused deputy attacks
- Implement rate limiting via service quotas and CloudWatch alarms on send rates

## Additional Resources

- [AWS End User Messaging Social User Guide](https://docs.aws.amazon.com/social-messaging/latest/userguide/what-is-service.html)
- [AWS CLI socialmessaging Reference](https://docs.aws.amazon.com/cli/latest/reference/socialmessaging/)
- [Getting Started with WhatsApp](https://docs.aws.amazon.com/social-messaging/latest/userguide/getting-started-whatsapp.html)
- [Managing Event Destinations](https://docs.aws.amazon.com/social-messaging/latest/userguide/managing-event-destinations-add.html)
- [Service Quotas](https://docs.aws.amazon.com/social-messaging/latest/userguide/quotas.html)
- [IAM Security Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [Confused Deputy Prevention](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)
- [SNS Data Protection Best Practices](https://docs.aws.amazon.com/sns/latest/dg/sns-security-best-practices.html)
- [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
