---
name: aws-sms-voice
description: >
  Onboards RCS Business Messaging and Notify OTP via the pinpoint-sms-voice-v2
  AWS CLI. Covers creating a branded RCS test agent (logo, banner, rich cards,
  suggested replies), adding verified testers, and sending/receiving the first RCS
  message; and configuring AWS End User Messaging Notify to send one-time-passcode
  (OTP) verification codes through AWS-managed phone numbers without buying a
  number or completing carrier registration. Also discovers which registration type a
  country requires from live API definitions and runs the universal registration
  lifecycle (create, derive fields, fill, submit, recover from denial, resubmit) shared
  by 10DLC, toll-free, short code, sender ID, RCS country launch, and Notify tier
  upgrade. Applicable to RCS agent setup, RCS message send/receive, Notify OTP
  configuration, verification-code delivery, registration requirements by country, and
  registration submission. Does not cover WhatsApp (see aws-social-messaging).
version: 1
---

# AWS End User Messaging — SMS, Voice, RCS & Notify

## Overview

AWS End User Messaging SMS and Voice (the `pinpoint-sms-voice-v2` API) is the
control and data plane for SMS, Voice, RCS Business Messaging, and Notify (OTP).
This skill covers the two fastest onboarding paths — each reaches
a real message on a real phone in about five minutes, with no phone-number
purchase and no carrier registration:

1. **Create an RCS test agent and send your first branded message** — a branded
   RCS Business Messaging agent, a verified test device, and a rich outbound +
   inbound message. See [references/hello-rcs-test-agent.md](references/hello-rcs-test-agent.md).
2. **Send an OTP with Notify** — a one-time-passcode text through
   AWS-managed sending identities and pre-approved templates. See
   [references/hello-notify-otp.md](references/hello-notify-otp.md).

Beyond onboarding, this skill takes an identity to production registration in three steps:

1. **Find which registration a country requires** — discover the registration type and
   its live field set for a target country and identity type, reconciled with the
   official docs. See [references/registration-requirements-by-country.md](references/registration-requirements-by-country.md).
2. **Run the registration lifecycle** — the universal engine (create, derive fields,
   fill, submit, poll, recover from denial, resubmit) shared by every registration type,
   including RCS country launch. See [references/registration-core-engine.md](references/registration-core-engine.md).
3. **Take an identity to production** — exit the SMS sandbox, launch RCS in a country with
   carrier monitoring and SMS fallback, upgrade Notify to Advanced, and apply production
   hygiene (keywords, configuration sets, protect configurations). See
   [references/customer-go-to-production-guide.md](references/customer-go-to-production-guide.md).

## Guardrail — where this skill's files live (MCP vs local install)

This skill can be loaded two ways, and the `references/` files resolve differently:

- **Loaded through the AWS MCP `retrieve_skill` tool.** Reference files do not
  exist on the local filesystem. Fetch them via `retrieve_skill` with the `file`
  parameter (e.g., `file="references/hello-rcs-test-agent.md"`). Do NOT
  `file_read` these paths locally — they are not there.
- **Installed locally** (e.g., `.kiro/skills/aws-sms-voice/`). Read references
  from the local skill directory using the relative paths shown in this file.

This applies only to the skill's own packaged files. User-created artifacts
(brand-assets/, temp files) are always in the user's working directory.

Execute commands using available tools from the AWS MCP server when connected —
it provides sandboxed execution, audit logging, and observability. When the MCP
server is not available, fall back to the AWS CLI or shell as needed.

## Choosing a path

| You want to…                                                                                           | Go to                                                                                         |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Send rich, branded messages (cards, logo, two-way) to your own test phone                              | [hello-rcs-test-agent.md](references/hello-rcs-test-agent.md)                                 |
| Send a verification code / OTP to any supported phone, fastest possible path                           | [hello-notify-otp.md](references/hello-notify-otp.md)                                         |
| Find out which registration a country needs and what fields it requires                                | [registration-requirements-by-country.md](references/registration-requirements-by-country.md) |
| Create and submit a registration of any type (10DLC, toll-free, sender ID, RCS launch, Notify tier)    | [registration-core-engine.md](references/registration-core-engine.md)                         |
| Take an identity to production (sandbox exit, RCS carrier launch + fallback, Notify Advanced, hygiene) | [customer-go-to-production-guide.md](references/customer-go-to-production-guide.md)           |

RCS test agents deliver **only to verified test devices** and require a short
brand registration (auto-reviewed in minutes). Notify sends to any recipient in
its supported countries immediately, but is limited to AWS-managed OTP templates.
Pick RCS to explore rich messaging; pick Notify for the shortest path to a
production-grade verification text.

## Before you start (both paths)

The **AWS MCP server is recommended** for the best experience here — it runs the many
`pinpoint-sms-voice-v2` and `sts` calls with sandboxed execution, audit logging, and
observability. It is not a hard requirement: every step also works with the plain AWS CLI or the
AWS Agent Toolkit when the MCP server is not available.

1. **Credentials.** Run `aws sts get-caller-identity --region <REGION>` (pass `--region` to use
   the regional STS endpoint; the global `sts.amazonaws.com` endpoint is legacy). If it fails,
   configure the user's auth (named profile / SSO / access keys — `--profile <PROFILE>` on every
   command if a profile is in play) and prefer an assumed IAM role with ephemeral credentials. Each
   reference file's Prerequisites carry the full auth, CloudTrail-audit, and CLI-freshness steps.
2. **Least-privilege access.** These tasks need a small set of specific
   `sms-voice:` actions in the target account (the reference files enumerate the
   read/write actions each step uses — for example `sms-voice:DescribeRcsAgents`,
   `CreateRcsAgent`, `CreateRegistration`, `CreateNotifyConfiguration`, and
   `SendNotifyTextMessage`). Scope the policy to exactly the actions the chosen
   path uses; do not grant `sms-voice:*` or `*FullAccess`.
3. **Don't trust the CLI version.** Treat any `Invalid choice '<operation>'` on a
   `pinpoint-sms-voice-v2` command, at any step, as a stale/partial local service model (not a
   permissions or account problem). The RCS and Notify reference files (prerequisite 3) carry the
   full reactive resolution: clear a stale `~/.aws/models/pinpoint-sms-voice-v2/` override, else
   upgrade the AWS CLI, with a boto3 fallback. `AccessDeniedException` means the identity is
   missing the required `sms-voice:` permissions.

Each reference file is self-contained: it tracks the IDs you collect as session
state, audits required inputs against the service before any submit, and ends
with a **Failure modes** table and a **Cleanup** section. Follow the file for the
path the user chose rather than improvising the API sequence — several steps fail
silently or depend on service-version-specific field sets that must be read live.

## Security Considerations

- **Least-privilege IAM.** Scope policies to specific `sms-voice:` actions; never
  use `*FullAccess` or `sms-voice:*` in production. The reference files enumerate
  the minimal read/write actions each onboarding path needs.
- **Ephemeral credentials.** Assume an IAM role with ephemeral credentials;
  never embed long-lived access keys in code, config, or environment variables.
- **No secrets in messages or fields.** OTP codes and message bodies can surface
  in CloudTrail and downstream logs — treat them as sensitive and never hardcode
  real codes. Enable CloudTrail logging for `sms-voice` API calls and encrypt
  CloudTrail logs and CloudWatch Log groups with a KMS CMK. Attach a
  configuration set with an event destination (CloudWatch Logs or Kinesis) for
  delivery monitoring before production traffic. Create CloudWatch alarms on
  key security signals (repeated `AccessDeniedException`, unusual send volumes,
  spend limit approaching threshold) for proactive alerting. Registration contact fields (email, phone, URLs) are submitted to
  partner review; use real but non-sensitive business contacts.
- **Consent and opt-out.** Only message recipients who have opted in. Honor STOP /
  opt-out state; the RCS path shows how to check the opt-out list before sending.
  Test agents intentionally restrict delivery to verified test devices — do not
  work around that to reach unconsented numbers.
- **Spend limits and abuse.** Default account spend limits are intentionally low;
  raise them deliberately and monitor. Notify enforces a non-adjustable per-day
  cap per destination — do not attempt to bypass it.
- **Destructive cleanup.** The teardown steps delete agents, registrations, and
  configurations. They are irreversible — confirm with the user before running
  cleanup, and note RCS agents have deletion protection enabled by default in the
  onboarding flow.

## Additional Resources

- [AWS End User Messaging SMS User Guide](https://docs.aws.amazon.com/sms-voice/latest/userguide/what-is-service.html)
- [AWS CLI pinpoint-sms-voice-v2 Reference](https://docs.aws.amazon.com/cli/latest/reference/pinpoint-sms-voice-v2/)
- [RCS messaging on AWS End User Messaging](https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs.html)
- [AWS End User Messaging Notify](https://docs.aws.amazon.com/sms-voice/latest/userguide/notify.html)
- [IAM Security Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
