---
name: connect
description: Connect Codex to any app via the Composio CLI. Send emails, create issues, post messages, update databases - take real actions across Gmail, Slack, GitHub, Notion, and 1000+ services from the terminal.
---

# Connect

Connect Codex to any app using the [Composio CLI](https://docs.composio.dev/docs/cli). Stop generating text about what you could do - actually do it from the shell.

## When to Use This Skill

Use this skill when you need Codex to:

- **Send that email** instead of drafting it
- **Create that issue** instead of describing it
- **Post that message** instead of suggesting it
- **Update that database** instead of explaining how

## What Changes

| Without Connect                 | With Connect      |
| ------------------------------- | ----------------- |
| "Here's a draft email..."       | Sends the email   |
| "You should create an issue..." | Creates the issue |
| "Post this to Slack..."         | Posts it          |
| "Add this to Notion..."         | Adds it           |

## Supported Apps

**1000+ integrations** including:

- **Email:** Gmail, Outlook, SendGrid
- **Chat:** Slack, Discord, Teams, Telegram
- **Dev:** GitHub, GitLab, Jira, Linear
- **Docs:** Notion, Google Docs, Confluence
- **Data:** Sheets, Airtable, PostgreSQL
- **CRM:** HubSpot, Salesforce, Pipedrive
- **Storage:** Drive, Dropbox, S3
- **Social:** Twitter, LinkedIn, Reddit

## Setup

### 1. Install the Composio CLI

```bash
curl -fsSL https://composio.dev/install | bash
```

### 2. Log In

```bash
composio login
composio whoami
```

This opens a browser for authentication and lets you pick your default org and project. Use `-y` to skip prompts in automated flows.

### 3. Link the Toolkits You Need

```bash
composio link github
composio link gmail
composio link slack
```

Each command walks through OAuth once, then the connection persists.

Done. Codex can now drive any connected app from the shell.

## Core Workflow

1. **Know the tool slug?** → `composio execute`
2. **Don't know the slug?** → `composio search`
3. **Need clarification on inputs?** → `composio execute --get-schema` or `--dry-run`
4. **Toolkit not connected?** → `composio link <toolkit>` and retry
5. **Multiple steps needed?** → `composio run` for workflows, `composio proxy` for raw API calls

## Examples

### Discover a Tool

```bash
composio search "create a github issue"
composio search "send an email" --toolkits gmail
```

### Inspect Inputs Before Calling

```bash
composio tools info GITHUB_CREATE_ISSUE
composio execute GITHUB_CREATE_ISSUE --get-schema
composio execute GITHUB_CREATE_ISSUE --dry-run -d '{"owner":"acme","repo":"app","title":"Bug"}'
```

### Send an Email

```bash
composio execute GMAIL_SEND_EMAIL -d '{
  "recipient_email": "sarah@acme.com",
  "subject": "Shipped!",
  "body": "v2.0 is live, let me know if issues"
}'
```

### Create a GitHub Issue

```bash
composio execute GITHUB_CREATE_ISSUE -d '{
  "owner": "my-org",
  "repo": "repo",
  "title": "Mobile timeout bug",
  "labels": ["bug"]
}'
```

### Post to Slack

```bash
composio execute SLACK_SEND_MESSAGE -d '{
  "channel": "engineering",
  "text": "Deploy complete - v2.4.0 live"
}'
```

### Run Calls in Parallel

```bash
composio execute --parallel \
  GMAIL_FETCH_EMAILS -d '{"max_results": 2}' \
  GITHUB_GET_THE_AUTHENTICATED_USER -d '{}'
```

### Chain Actions with `composio run`

```bash
composio run '
  const issues = await search("github issues labeled bug this week");
  const summary = issues.map(i => `- ${i.title}`).join("\n");
  await execute("SLACK_SEND_MESSAGE", {
    channel: "bugs",
    text: `This week’s bugs:\n${summary}`
  });
'
```

Load reusable workflows from a file:

```bash
composio run --file ./workflow.ts -- --repo composiohq/composio
```

### Raw API Access (`proxy`)

When no dedicated tool exists, hit the authenticated API directly:

```bash
composio proxy https://gmail.googleapis.com/gmail/v1/users/me/profile \
  --toolkit gmail

composio proxy https://gmail.googleapis.com/gmail/v1/users/me/drafts \
  --toolkit gmail -X POST -H 'content-type: application/json' \
  -d '{"message":{"raw":"..."}}'
```

## How It Works

1. **You ask** Codex to do something
2. **Codex picks a slug** via `composio search` or prior knowledge
3. **CLI checks connection**, prompts `composio link` if missing
4. **Action executes** against the real API and returns JSON to stdout

## Configuration

**Global flags:**

- `--log-level <all|trace|debug|info|warning|error|fatal|none>`
- `--help` for per-command docs

**Environment variables:**

- `COMPOSIO_API_KEY` - auth credential (set for non-interactive use)
- `COMPOSIO_BASE_URL` - custom API endpoint
- `COMPOSIO_SESSION_DIR` - override artifact storage
- `COMPOSIO_DISABLE_TELEMETRY=true` - opt out of telemetry

## Type-Safe SDK (Optional)

Generate typed client code when you want to call tools from an app rather than the shell:

```bash
composio generate ts    # TypeScript types
composio generate py    # Python types
```

Flags: `-o <dir>`, `--toolkits <list>`, `--compact`, `--transpiled`, `--type-tools`.

## Troubleshooting

- **`Not logged in`** → run `composio login`
- **`Connection required for <toolkit>`** → run `composio link <toolkit>`
- **Unknown slug** → `composio search "<what you want>"` or `composio tools list <toolkit>`
- **Bad inputs** → `composio execute <SLUG> --get-schema` then `--dry-run`
- **Action failed** → check permissions in the target app

Full reference: [docs.composio.dev/docs/cli](https://docs.composio.dev/docs/cli)

---

<p align="center">
  <b>Join 20,000+ developers building agents that ship</b>
</p>

<p align="center">
  <a href="https://platform.composio.dev/?utm_source=Github&utm_content=AwesomeSkills">
    <img src="https://img.shields.io/badge/Get_Started_Free-4F46E5?style=for-the-badge" alt="Get Started"/>
  </a>
</p>
