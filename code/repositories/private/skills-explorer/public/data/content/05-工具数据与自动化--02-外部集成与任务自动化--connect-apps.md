---
name: connect-apps
description: Connect Claude to external apps via the Composio CLI. Use this skill when the user wants to send emails, create issues, post messages, or take actions across Gmail, Slack, GitHub, Notion, and 1000+ services from the terminal.
---

# Connect Apps

Connect Claude to 1000+ apps using the [Composio CLI](https://docs.composio.dev/docs/cli). Actually send emails, create issues, post messages - not just generate text about it.

## Quick Start

### Step 1: Install the Composio CLI

```bash
curl -fsSL https://composio.dev/install | bash
```

### Step 2: Log In

```bash
composio login
composio whoami
```

Opens a browser for auth, then prompts you to pick a default org and project. Use `-y` to skip prompts in scripts.

### Step 3: Link the Apps You Need

```bash
composio link gmail
composio link slack
composio link github
```

Each command walks OAuth once; the connection then persists.

### Step 4: Try It

```bash
composio execute GMAIL_SEND_EMAIL -d '{
  "recipient_email": "YOUR_EMAIL@example.com",
  "subject": "Composio test",
  "body": "Hello from the CLI"
}'
```

If the email arrives, you're connected.

## What You Can Do

| Ask Claude to...                                | Claude runs                                       |
| ----------------------------------------------- | ------------------------------------------------- |
| "Send email to sarah@acme.com about the launch" | `composio execute GMAIL_SEND_EMAIL -d '{...}'`    |
| "Create GitHub issue: fix login bug"            | `composio execute GITHUB_CREATE_ISSUE -d '{...}'` |
| "Post to Slack #general: deploy complete"       | `composio execute SLACK_SEND_MESSAGE -d '{...}'`  |
| "Add meeting notes to Notion"                   | `composio execute NOTION_CREATE_PAGE -d '{...}'`  |

## Core Workflow

1. **Know the tool slug?** → `composio execute <SLUG> -d '{...}'`
2. **Don't know it?** → `composio search "what you want"`
3. **Need inputs?** → `composio execute <SLUG> --get-schema` or `--dry-run`
4. **Not connected?** → `composio link <toolkit>` and retry
5. **Multi-step?** → `composio run` for JS/TS workflows, `composio proxy` for raw API

## Supported Apps

**Email:** Gmail, Outlook, SendGrid
**Chat:** Slack, Discord, Teams, Telegram
**Dev:** GitHub, GitLab, Jira, Linear
**Docs:** Notion, Google Docs, Confluence
**Data:** Sheets, Airtable, PostgreSQL
**And 1000+ more...**

## Handy Commands

```bash
# Discover tools
composio search "create a github issue"
composio tools list gmail
composio tools info GITHUB_CREATE_ISSUE

# Inspect / dry-run before executing
composio execute GITHUB_CREATE_ISSUE --get-schema
composio execute GITHUB_CREATE_ISSUE --dry-run -d '{"owner":"acme","repo":"app","title":"Bug"}'

# Execute in parallel
composio execute --parallel \
  GMAIL_FETCH_EMAILS -d '{"max_results": 2}' \
  GITHUB_GET_THE_AUTHENTICATED_USER -d '{}'

# Multi-step workflow
composio run '
  const issue = await execute("GITHUB_CREATE_ISSUE", {
    owner: "acme", repo: "app", title: "Bug", body: "..."
  });
  console.log(issue);
'

# Raw API call when no dedicated tool exists
composio proxy https://gmail.googleapis.com/gmail/v1/users/me/profile --toolkit gmail
```

## Configuration

**Environment variables:**

- `COMPOSIO_API_KEY` - auth credential for non-interactive use
- `COMPOSIO_BASE_URL` - custom API endpoint
- `COMPOSIO_SESSION_DIR` - override artifact storage
- `COMPOSIO_DISABLE_TELEMETRY=true` - opt out

**Global flags:** `--log-level <all|trace|debug|info|warning|error|fatal|none>`, `--help`.

## Troubleshooting

- **`Not logged in`** → run `composio login`
- **`Connection required for <toolkit>`** → run `composio link <toolkit>`
- **Unknown slug** → `composio search "<goal>"` or `composio tools list <toolkit>`
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
