---
name: signing-in-to-aws
description: |
  Gets AWS credentials for CLI/SDK access via `aws login`. Activates when a developer needs to authenticate to AWS for local development, when an AWS operation fails due to missing or expired credentials, or when someone asks about setting up AWS access. Triggers: "set up AWS", "configure AWS", "aws login", "get credentials", "authenticate", "session expired", "token expired", "no credentials", "AccessDeniedException" with no configured credentials.
---

# Sign In — Get CLI/SDK Credentials

Help developers get AWS credentials for local development using `aws login`. This provides short-term, auto-rotating credentials that refresh every 15 minutes and remain valid for up to 12 hours.

**Important:**

- You MUST run `aws login` and `aws --version` in the user's local shell — NOT via MCP/API tools.
- You MUST ask the user for confirmation before running `aws login`. Do not tell the user to run the command themselves — ask if YOU should run it (e.g., "Ready for me to run `aws login`?" or "Shall I proceed with `aws login`?"). Wait for their response before proceeding.

## Prerequisites

The `aws login` command requires **AWS CLI version 2.32.0 or later**.

Check the installed version:

```bash
aws --version
```

If the CLI is not installed or is below 2.32.0, inform the user and ask if they'd like to install/update (link them to the [AWS CLI installation guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)), or if they'd prefer to continue without this skill's guidance. If they choose to continue without upgrading, respond to their original request as you normally would without this skill.

## Flow

### Lead with the recommendation

In your first response, always tell the user that `aws login` is the fix — explain that it provides short-term, auto-rotating credentials and that it requires AWS CLI 2.32.0 or later. Do not stop at "let me check your CLI version" — name the remediation up front so the user knows where this is going, then describe the precondition checks you'll run before invoking it.

### Precondition checks (run silently before asking confirmation)

Run these via the local shell to inform your plan. Report what you find, but do not gate the recommendation on user-supplied output:

1. `aws --version` — confirm the CLI is 2.32.0 or later. If not installed or too old, point the user to the [AWS CLI installation guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and stop.
2. `aws sts get-caller-identity` — check current credentials.
   - **Succeeds**: Show the user their Account and Arn. Ask whether to keep these or set up different credentials. If they want to switch, recommend `aws login --profile <name>` so the existing default isn't overwritten.
   - **Fails** (missing or expired): proceed with `aws login` on the default profile.
3. _(Only if Step 2 succeeded and the user wants different credentials)_ `aws configure list` — if `access_key` starts with `AKIA`, explain that long-term access keys are less secure (never expire, persist on disk as secrets, grant indefinite access if leaked) and that `aws login` provides short-term credentials that auto-rotate every 15 minutes, expire automatically, and require no manual rotation.

### Confirm and run aws login

Once preconditions are clear, ask the user for confirmation specifically for the `aws login` invocation — and only there. Do not tell the user to run the command themselves; ask if you should run it (e.g., "Ready for me to run `aws login`?" or "Shall I proceed with `aws login --profile staging`?"). Wait for their response, then run `aws login` (or `aws login --profile <name>`).

### Verify

After `aws login` completes, run `aws sts get-caller-identity` (with `--profile` if used) to confirm success. If a named profile was used, remind the user to pass `--profile` or set `AWS_PROFILE`.

## Handling Errors

### "command not found" or version too old

The CLI is not installed or below 2.32.0. Direct the user to install or update: [AWS CLI installation guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).

### Browser doesn't open

Suggest `aws login --remote` which provides a URL and code for cross-device authentication (e.g., when using a remote server without a browser).

### Permission error after login

The IAM identity needs the `SignInLocalDevelopmentAccess` managed policy attached (to the user, role, or group). Root users do not need it. Tell the user to ask their administrator to add it, or attach it themselves if they have IAM permissions.

### GovCloud or China regions

`aws login` is not available in AWS GovCloud (US) or AWS China regions. Do not mention this exception proactively — only relevant if the user explicitly states they are in one of these partitions.

## Users With Existing `aws sso login` Workflows

If the user mentions `aws sso login` or has an existing SSO configuration, do NOT redirect them to `aws login`. These are different commands for different situations:

- `aws sso login` is for users whose organization has configured AWS IAM Identity Center (SSO). They have profiles in `~/.aws/config` pointing at an SSO start URL. Respect their established workflow.
- If their `aws sso login` is failing, help troubleshoot within their context: expired SSO session, revoked authorization, cached token issues (`~/.aws/sso/cache/`), or Identity Center configuration changes.

## Fallback to `aws configure`

Do NOT mention `aws configure` in your initial response or include it as a table row alongside `aws login`. Only offer it as an alternative if:

1. The user explicitly declines `aws login` or asks for alternatives
2. The user states they are in GovCloud or China regions (where `aws login` is unavailable)

When offering it, explain that long-term access keys are less secure: they persist on disk as plaintext, never expire automatically, and grant indefinite access if leaked.

## When NOT to Use This Skill

- User is setting up CI/CD credentials — they need IAM roles or OIDC federation, not `aws login`

## Key Points

- Do not front-load troubleshooting — keep the initial response simple and address errors only if they occur
- `aws login` works with root users, IAM users and federation with IAM

## Additional Resources

- [Sign in through the AWS CLI](https://docs.aws.amazon.com/signin/latest/userguide/command-line-sign-in.html)
- [Installing or updating the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [SignInLocalDevelopmentAccess managed policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/SignInLocalDevelopmentAccess.html)
- [IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
