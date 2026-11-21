---
name: pr-link-issue
description: Append a GitHub issue link and its Linear ticket to the current PR's description. Use when asked to "link issue to pr", "fill in issue and linear in pr", "add issue refs to pr", or when given a GitHub issue URL and asked to attach it to the current PR. Resolves the Linear ticket automatically from the issue's linear-linkback comment.
---

# Link a GitHub Issue + Linear Ticket on a PR

Appends a Sentry-style `#### Issues` block to a PR description, referencing both the GitHub issue and the Linear ticket pulled from the issue's `linear-linkback` comment.

## Inputs

- `<issue-url>` — GitHub issue URL like `https://github.com/<owner>/<repo>/issues/<n>`. Issue number alone is fine if the PR is in the same repo.
- (optional) `<pr-number>` — defaults to the open PR for the current branch.

## Steps

1. **Resolve the PR number** — skip if user supplied one:

   ```bash
   gh pr view --json number,body -q '.number'
   ```

   If no PR exists on the branch, stop and tell the user.

2. Extract issue number + repo from the input URL, or accept a bare `#1234` for current repo.

3. Fetch the Linear ticket from the issue's linear-linkback comment:

   ```bash
   gh issue view <n> --repo <owner>/<repo> --json comments \
     -q '.comments[] | select(.author.login=="linear-code") | .body' \
     | grep -Eioe '[a-z]+-[0-9]+' | head -1
   ```

   If no match, fall back to asking the user for the Linear key, or omit it.

4. Read the existing PR body so you can append rather than overwrite:

   ```bash
   gh pr view <pr-number> --json body -q '.body'
   ```

5. Construct the new body. If the body is empty, use just the `#### Issues` block. Otherwise, append it after a blank line. Don't duplicate — if `#### Issues` is already present, replace that section instead of adding a second one.

   Format:

   ```markdown
   #### Issues

   - Resolves: #<n>
   - Resolves: <linear-key>
   ```

6. Update the PR with a heredoc to preserve newlines:

   ```bash
   gh pr edit <pr-number> --body "$(cat <<'EOF'
   <new body>
   EOF
   )"
   ```

7. Confirm by echoing the resulting PR URL:

   ```bash
   gh pr view <pr-number> --json url -q '.url'
   ```

## Notes

- Linear linkback comments are posted by the GitHub user `linear-code`. The body contains a markdown link whose text is the Linear key, e.g. `PY-2357`.
- Project keys vary per repo (`PY-…` for sentry-python, `JS-…` for sentry-javascript, etc.) — the regex `[a-z]+-[0-9]+` covers them.
- Don't strip existing PR content. Always read first, append/replace second.
- If the issue doesn't have a Linear linkback yet (newly filed), proceed with just the GitHub issue reference and tell the user the Linear key is missing.
