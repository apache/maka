---
name: amazon-ses
description: "Guides Amazon SES onboarding for domain-based email sending. Covers identity configuration, production access, an optional first test send, and troubleshooting setup, authentication, or sending failures. Use when setting up SES, resuming incomplete onboarding, or leaving the sandbox. Does not cover inbound email or Mail Manager, SMS/voice, WhatsApp, SNS, Pinpoint, or WorkMail."
version: 2
---

# Amazon SES

## Overview

> **Recommended**: Use the [AWS MCP Server](https://docs.aws.amazon.com/aws-mcp/latest/userguide/what-is-mcp-server.html) with SES permissions for sandboxed execution and CloudTrail audit logging.
> **Without MCP**: All operations use standard AWS CLI syntax (`aws sesv2 ...`).

Takes a developer who is not an email authentication expert from an empty AWS account to a
real, authenticated email in their inbox, and on to production sending if AWS approves the
request.

Read the account and identity state before touching anything, and complete only the parts of
domain setup that are actually missing. Request production access only after domain setup is
complete and the user has given explicit consent. A test send is optional: run it when the user
asks for one, to a recipient the account's current state permits.

## Routing

| If the user wants to...                                                                                                                                       | Read                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Get started with SES, set up email sending, send a first or test email, move out of the sandbox, or diagnose `MessageRejected: Email address is not verified` | [SES onboarding: zero to first delivered email](references/onboarding.md)      |
| Set up a domain for sending, configure email authentication, or troubleshoot DKIM                                                                             | [Setting up SES domain identity](references/setting-up-ses-domain-identity.md) |

## Guardrail — where this skill's own files live (MCP vs local install)

This skill can be loaded two ways, and they resolve its own bundled files from different places. Determine how the skill was loaded before reading a reference:

- **Loaded through the AWS MCP `retrieve_skill` tool:** the skill is not on the local filesystem. **You MUST fetch each reference** via `retrieve_skill` with the `file` parameter (e.g. `file="references/onboarding.md"`). Do NOT `file_read` these paths locally — they do not exist on disk.
- **Installed locally** (e.g. `~/.kiro/skills/amazon-ses/`, `.kiro/skills/amazon-ses/`, or `~/.claude/skills/amazon-ses/`): read files from the local skill directory using the relative paths above.

This distinction applies only to the skill's own packaged files. User data and session artifacts are always read from and written to the user's working directory — never fetch or write customer data through `retrieve_skill`.

## Critical Rules

- **MUST** use the SES v2 API: `aws sesv2 ...`, never the v1 `aws ses ...` commands. A v1
  command reports no error signalling the wrong API was chosen, so the mistake is silent, and
  the operations this journey needs — production-access requests, and DKIM plus MAIL FROM
  attributes in a single identity read — exist only in v2. Models trained on published CLI
  examples tend to default to the v1 syntax.
- **MUST NOT** volunteer API version mechanics, internal limit figures, or other plumbing.
  Explain only what the user has to decide, consent to, pay for, or act on. Surface the rest
  only when they ask, when their problem turns on it, or when a reference file names the
  disclosure as required.
- **MUST** ask for missing inputs in ONE question set rather than one at a time — and **MUST NOT**
  ask for inputs the request does not need. Scope the questions to what the user asked for: a
  request that already names the domain and MAIL FROM subdomain is a complete domain-setup
  request, so read state and execute rather than stalling for send-time or production-access
  inputs. If nothing is missing for the chosen scope, ask nothing.
- **MUST NOT** ask which AWS CLI profile or Region to use while either can still be resolved.
  Honour `--profile` only if the user names one. **Resolve the Region in this order, taking the
  first that yields a value:** a Region the user named; `AWS_REGION`; `AWS_DEFAULT_REGION`;
  `aws configure get region`, adding `--profile '{PROFILE}'` when the user named a profile, since
  a profile can carry its own Region. That last command reads the CLI configuration files only and
  does **not** see the environment, which is why the two environment variables are checked
  separately and ahead of it. **State the resolved Region before any mutation**, because SES state
  is per-Region, and report the account and principal from `aws sts get-caller-identity`. Two
  cases, and only these two, are where you do ask: nothing in that chain yields a Region, because
  every `aws sesv2` call fails without one; and `aws sts get-caller-identity` fails on expired or
  invalid credentials, in which case ask which account (profile) and Region to use once they are
  refreshed, because the configured defaults are no longer trustworthy. Fold either into the one
  question set rather than spending an extra turn on it.
- **MUST** pass request payloads (change batches and message content) to the CLI as inline JSON
  strings, never as `file://` paths — `file://` is AWS-CLI-specific and does not resolve when
  the CLI is executed through the AWS MCP server.
- **MUST** read current state before each step and skip steps already satisfied. In particular:
  never call `create-email-identity` for an identity that already exists (it returns
  `AlreadyExistsException`), and never re-run `put-email-identity-dkim-signing-attributes` on an
  identity whose `DkimAttributes.Status` is `SUCCESS`, because re-initialising can change its
  tokens. **Gate that call on status, not on whether the published CNAMEs resolve** — on a
  `FAILED` identity the records often do resolve and are simply not being honoured, which is
  what `FAILED` means, so resolving records are not a reason to withhold the recovery. The
  status-gated recovery paths, and the BYODKIM check that precedes them, are owned by
  `setting-up-ses-domain-identity.md`.
- **For domain setup, create a domain identity.** Create an email-address identity only when the
  user explicitly chooses verification of that individual address.

## Invariants

These hold everywhere in this skill. The reference files apply them, and may add
workflow-specific detail on top of them — a reference may state how an invariant is checked at a
particular step, or narrow it for that step's state. None of them may contradict or relax what is
written here.

- **Domain setup complete** means all three of these are true in one
  `aws sesv2 get-email-identity` response: `VerifiedForSendingStatus` is `true`, **and**
  `DkimAttributes.Status` is `SUCCESS`, **and** `MailFromAttributes.MailFromDomainStatus` is
  `SUCCESS`. Two of the three is not complete. While `MailFromDomainStatus` is `PENDING`,
  `FAILED` or `TEMPORARY_FAILURE`, AWS documents that SES uses the custom MAIL FROM fallback
  setting: with `USE_DEFAULT_VALUE` it sends using a subdomain of `amazonses.com`, so SPF
  validates but the envelope sender does not align with the `From` domain and DMARC cannot
  pass on its SPF leg; with `REJECT_MESSAGE` SES returns `MailFromDomainNotVerified` and does
  not attempt delivery. This is the gate the rest of the skill calls "domain setup complete".
- **Sandbox recipient rule.** While `ProductionAccessEnabled` is `false`, AWS documents that
  you can only send **to** verified email addresses and domains, or to the Amazon SES mailbox
  simulator. That means, in the order this skill always presents them: (1) an address verified
  as its own email identity, (2) the Amazon SES mailbox simulator, or (3) any address at **any**
  verified domain in the account — not only the domain just set up. The restriction is on the
  **recipient**, not the sender: a fully verified sending domain does not lift it, and you must
  never attempt to work around it. **Production access is governed by `ProductionAccessEnabled`
  alone** — while it is `false`, these three options apply whatever `Details.ReviewDetails.Status`
  says. When you explain the restriction to a user, you MUST name all three recipient options that
  work right now, in that same numbering, before proposing production access as the remedy, and you MUST NOT
  describe the restriction as "each recipient must be individually verified": a verified **domain**
  covers every address at that domain.
- **The sender must be verified too, in every account state.** AWS documents that after an
  account moves into production "you still have to verify all identities that you use as
  'From', 'Source', 'Sender', or 'Return-Path' addresses." So `MessageRejected: Email address
is not verified` has two causes: an unpermitted recipient in the sandbox, and an unverified
  sending identity in any state. Read the address named in the error before choosing a fix,
  and check that the From address is at a domain or address verified in this Region.
- **A verified sender is the SES service minimum; this skill's journey asks for more.** SES
  itself will accept a send from an identity that is verified for sending even when DKIM has not
  reached `SUCCESS`. This skill deliberately does not stop there: its goal is a **delivered,
  authenticated** first email, so it requires `DkimAttributes.Status: SUCCESS` before it claims
  domain setup or authentication is complete, and before it sends. That stricter bar is stated
  once, as the send prerequisite in `onboarding.md`'s domain-verification step, and every send
  path applies it. The two are not in conflict — one is what the service enforces, the other is
  what this journey promises the user.
- **Validate every substituted value, then quote it for its context.** A value interpolated
  directly into a shell command is single-quoted; a value placed inside inline JSON is
  JSON-encoded (double quotes, per JSON rules), and only the whole JSON blob is single-quoted
  for the shell — never shell-quote an individual value inside JSON. This applies to **every** user-supplied value this skill substitutes —
  `DOMAIN`, the MAIL FROM subdomain, `FROM_ADDRESS`, `TEST_RECIPIENT`, `CHOSEN_RECIPIENT`,
  `MAIL_TYPE`, `WEBSITE_URL`, `REGION`, `PROFILE` — not only the DNS names. Reject any value
  containing a
  single or double quote, a backtick, `$`, `;`, a backslash, or whitespace, and ask the user to
  re-provide it; never escape a rejected value into shape. Per-value shapes: `DOMAIN` and the
  MAIL FROM subdomain — DNS labels only, letters, digits, hyphens and dots; From address and
  **every recipient value, `TEST_RECIPIENT` and `CHOSEN_RECIPIENT` alike** — a single address
  with one `@`, and reject a comma-separated list (put multiple
  recipients in the `ToAddresses` array instead); `MAIL_TYPE` — exactly `TRANSACTIONAL` or
  `MARKETING`; `WEBSITE_URL` — an `http`/`https` URL of 1–1000 characters, which need **not** be
  at the verified domain, since any business site the mail relates to is acceptable to AWS, so
  the question set may offer `https://{DOMAIN}` as a suggested default only; `REGION` — an AWS
  Region code; `PROFILE` — a CLI profile name. A `CHOSEN_RECIPIENT` bound from an option the
  skill supplies rather than the user — the mailbox simulator address — is validated the same
  way. JSON-encode any user-supplied subject or body
  text with a serialiser rather than pasting it between quotes.

## IAM Permissions

Grant only the actions the workflow being run actually calls, and nothing more — never `ses:*`
or `*FullAccess`. Each reference file has a `Required IAM actions` section listing exactly what
it calls; use that list, not a wildcard.

Scope per-identity actions to the identity each call actually acts on:

- `arn:aws:ses:{region}:{account-id}:identity/{domain}` for domain operations.
- `arn:aws:ses:{region}:{account-id}:identity/{address}` for an email-address identity — the
  identity used for sandbox recipient verification, and equally the From identity when the
  sender is a separately verified email address rather than an address at the domain. A policy
  scoped only to the domain denies those calls. **Reads are scoped the same way:** the
  `ses:GetEmailIdentity` statement must carry the ARN of every identity actually read, which
  includes a recipient address identity and — for sandbox recipient option 3 — the exact identity
  ARN of the other verified domain the user names. A policy scoped only to the sending domain
  denies that read, which reads as a broken permission rather than as a missing recipient.
  **A send is authorized by the identity that
  covers its From address**, so scope `ses:SendEmail` to whichever identity that is; the three cases are
  listed in `onboarding.md`'s `Required IAM actions`.
- Route 53 zone actions (`route53:GetHostedZone`, `route53:ListResourceRecordSets`,
  `route53:ChangeResourceRecordSets`) to `arn:aws:route53:::hostedzone/{hosted_zone_id}`, using the
  **bare** zone ID — `list-hosted-zones-by-name` returns `/hostedzone/Z123ABC`, so strip that prefix
  before building the ARN or the result is double-prefixed and matches nothing. The zone **reads** are
  needed whenever the agent checks whether Route 53 hosts the domain; only
  `route53:ChangeResourceRecordSets` is conditional on the user approving a write.

Only genuinely account-level and list actions (`sts:GetCallerIdentity`, `ses:GetAccount`,
`ses:ListEmailIdentities`, `route53:ListHostedZonesByName`, `route53:TestDNSAnswer`) have no
resource-level scoping and must be granted on `*`. Grant `ses:PutAccountDetails` deliberately,
because it changes account-wide sending posture.

## Security Considerations

- **Ephemeral credentials.** Use IAM roles with STS — never long-lived access keys.
- **Consent gates.** Opening a production-access review and sending a real message both commit
  the user in ways no API can undo, and a Route 53 change can affect live traffic. Each gate —
  the production-access consent gate, the send confirmation, and the DNS-write permission — is owned by the
  reference file that performs the action; never proceed past one because this file summarises it.
- **Delivery TLS is opportunistic by default.** AWS documents that SES always attempts a secure
  connection to the receiving mail server and sends the message unencrypted if it cannot establish
  one, and that requiring TLS means setting a configuration set's `TlsPolicy` to `REQUIRE` — a
  configuration-set workflow outside this skill's scope.
- **Validate and quote every user-supplied value** before it enters a shell command or inline
  JSON. The rules and character sets are under Invariants above.
- **Never place message bodies or recipient lists in logs.**
- **Never hardcode credentials, endpoints, or secrets in examples.** Store any application
  credentials in AWS Secrets Manager or Parameter Store.
- **Enable CloudTrail** for SES API call auditing, and alarm on repeated
  `AccessDeniedException` and unusual send volume. Encrypt the trail's log files with an AWS KMS
  key (SSE-KMS) and restrict access to the trail's S3 bucket and CloudWatch Logs group, and
  encrypt that log group with a KMS key (`--kms-key-id` on `create-log-group`) — SES CloudTrail
  entries carry email addresses, domain names, and account details.

## Additional Resources

- [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [SES Domain Verification](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [DKIM in SES](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim.html)
- [Custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [DMARC Authentication](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
- [SESv2 API Reference](https://docs.aws.amazon.com/ses/latest/APIReference-V2/Welcome.html)
