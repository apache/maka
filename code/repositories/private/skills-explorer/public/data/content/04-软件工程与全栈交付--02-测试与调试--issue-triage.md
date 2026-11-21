---
name: issue-triage
description: Triage Linear or Jira backlogs and run bug sweeps via the Composio CLI. Bulk-fetch issues, dedupe, relabel, reassign, and post summaries — all from the shell without clicking through the UI.
metadata:
  short-description: Linear/Jira triage + bug sweeps via the Composio CLI
---

# Issue Triage (Linear / Jira)

Drive triage sessions and bug sweeps across Linear or Jira with the [Composio CLI](https://docs.composio.dev/docs/cli). Pull the backlog, cluster duplicates, apply labels, and hand a clean list back to the team.

## When to Use

- Weekly triage: "what's unassigned, stale, or missing a priority?"
- Bug sweep after a release: "cluster all P1/P2 bugs, dedupe, assign owners."
- Cross-tool sync: Sentry → Linear, PagerDuty → Jira.

## Prereqs

```bash
curl -fsSL https://composio.dev/install | bash
composio login
composio link linear        # or: composio link jira
```

## Discover Tools

```bash
composio search "list issues" --toolkits linear
composio search "search issues" --toolkits jira
composio tools list linear
composio tools list jira
```

Common slugs (verify with `--get-schema`):

**Linear**

- `LINEAR_LIST_ISSUES`
- `LINEAR_CREATE_ISSUE`
- `LINEAR_UPDATE_ISSUE`
- `LINEAR_CREATE_COMMENT`

**Jira**

- `JIRA_SEARCH_FOR_ISSUES_USING_JQL`
- `JIRA_CREATE_ISSUE`
- `JIRA_EDIT_ISSUE`
- `JIRA_ADD_COMMENT`
- `JIRA_ASSIGN_ISSUE`

## Triage Workflow

1. **Pull the backlog slice:**
   ```bash
   # Linear
   composio execute LINEAR_LIST_ISSUES -d '{
     "filter": { "state": { "type": { "eq": "unstarted" } }, "assignee": { "null": true } },
     "first": 100
   }'

   # Jira
   composio execute JIRA_SEARCH_FOR_ISSUES_USING_JQL -d '{
     "jql": "project = APP AND statusCategory != Done AND assignee is EMPTY ORDER BY updated DESC",
     "maxResults": 100,
     "fields": ["summary","priority","labels","updated","reporter"]
   }'
   ```
2. **Cluster** by title similarity and labels. The agent groups likely duplicates locally.
3. **Apply updates in one pass** (label, priority, assignee):
   ```bash
   composio execute LINEAR_UPDATE_ISSUE -d '{
     "id":"abc-123","priority":2,"labelIds":["label-bug","label-p1"],"assigneeId":"user-42"
   }'

   composio execute JIRA_EDIT_ISSUE -d '{
     "issueIdOrKey":"APP-482",
     "fields":{"priority":{"name":"High"},"labels":["bug","p1"]}
   }'
   ```
4. **Link duplicates** with comments referencing the canonical issue.
5. **Post a digest** of what changed to Slack so the team sees the sweep results.

## Bug Sweep (Post-Release)

```bash
# Jira: every bug filed in the last 7 days, sorted by severity
composio execute JIRA_SEARCH_FOR_ISSUES_USING_JQL -d '{
  "jql":"type = Bug AND created >= -7d ORDER BY priority DESC, created ASC",
  "fields":["summary","priority","labels","reporter","components"]
}' | jq -r '.issues[] | "\(.fields.priority.name)\t\(.key)\t\(.fields.summary)"'
```

## Workflow File

`scripts/triage-linear.ts`, run with `composio run --file scripts/triage-linear.ts`:

```ts
const { nodes: issues } = await execute("LINEAR_LIST_ISSUES", {
  filter: { state: { type: { eq: "unstarted" } }, assignee: { null: true } },
  first: 100,
});

const stale = issues.filter((i) => {
  const age = (Date.now() - new Date(i.updatedAt).getTime()) / 86400000;
  return age > 14;
});

for (const i of stale) {
  await execute("LINEAR_CREATE_COMMENT", {
    issueId: i.id,
    body: "Auto-triage: stale for 14+ days. Please assign or close.",
  });
}

await execute("SLACK_SEND_MESSAGE", {
  channel: "triage",
  text: `Weekly triage: pinged ${stale.length} stale issues.`,
});
```

## Cross-Tool: Sentry → Linear

```bash
composio run '
  const hot = await execute("SENTRY_LIST_A_PROJECTS_ISSUES", {
    organization_slug:"acme", project_slug:"api",
    query:"is:unresolved", sort:"freq", limit:5
  });
  for (const s of hot) {
    await execute("LINEAR_CREATE_ISSUE", {
      teamId: "TEAM_ID",
      title: `[Sentry] ${s.title}`,
      description: `${s.permalink}\nCount: ${s.count}`,
      labelIds: ["label-bug","label-from-sentry"]
    });
  }
'
```

## Troubleshooting

- **Unknown field names** → `composio execute <SLUG> --get-schema` shows the exact filter shape (Linear uses nested objects; Jira uses JQL strings).
- **`403` on Linear** → re-run `composio link linear` with the right workspace.
- **Jira custom fields missing** → request them explicitly in the `fields` array.
- **Bulk edits rate-limited** → insert a 250ms sleep in the `composio run` loop; don't use `--parallel`.

Full CLI reference: [docs.composio.dev/docs/cli](https://docs.composio.dev/docs/cli)
