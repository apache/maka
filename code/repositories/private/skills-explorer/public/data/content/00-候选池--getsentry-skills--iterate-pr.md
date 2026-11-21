---
name: iterate-pr
description: Iterate on a PR until actionable CI passes and high/medium review feedback is addressed. Use for PR CI failures, review feedback, or green-check loops; do not wait for human approval, draft status, or merge gates.
disable-model-invocation: false
---

# Iterate on PR Until CI Passes

Goal: fix actionable CI failures and high/medium review feedback. Stop and report human approval, draft-readiness, and merge-readiness gates.

Requires:

- authenticated `gh`
- `uv`
- target repository root as cwd
- skill-root-relative script paths, for example `scripts/fetch_pr_checks.py`

## Bundled Scripts

| Script                         | Run                                                      | Output                                                   |
| ------------------------------ | -------------------------------------------------------- | -------------------------------------------------------- |
| `scripts/fetch_pr_checks.py`   | `uv run scripts/fetch_pr_checks.py [--pr NUMBER]`        | JSON: `pr`, `summary`, `checks`, failure snippets        |
| `scripts/fetch_pr_feedback.py` | `uv run scripts/fetch_pr_feedback.py [--pr NUMBER]`      | JSON buckets: `high`, `medium`, `low`, `bot`, `resolved` |
| `scripts/monitor_pr_checks.py` | `uv run scripts/monitor_pr_checks.py [--pr NUMBER]`      | terminal marker plus tab-separated checks                |
| `scripts/reply_to_thread.py`   | `uv run scripts/reply_to_thread.py THREAD_ID BODY [...]` | JSON reply results                                       |

Check summary fields include `failed`, `pending`, `actionable_pending`, and `human_gate_pending`.

Monitor markers:

- `ALL_CHECKS_PASSED`
- `CHECKS_DONE_WITH_FAILURES`
- `NO_CHECKS_REGISTERED`
- `DRAFT_PR_WITH_NO_CHECKS`
- `CHECKS_BLOCKED_BY_REVIEW_GATE`

## Workflow

### 1. Identify PR

Run:

```bash
gh pr view --json number,url,headRefName,isDraft,reviewDecision
```

Stop when:

- no PR exists
- draft PR has no checks after monitor grace period: report `DRAFT_PR_WITH_NO_CHECKS`

Draft rule: inspect existing checks/feedback only. Do not mark ready for review unless asked.

### 2. Handle Feedback

Run `uv run scripts/fetch_pr_feedback.py [--pr NUMBER]`.

| Bucket     | Action                      |
| ---------- | --------------------------- |
| `high`     | fix                         |
| `medium`   | fix                         |
| `low`      | ask user which to address   |
| `bot`      | skip informational comments |
| `resolved` | skip                        |

Feedback fix checklist:

- verify root cause
- search related code
- fix all instances
- for `review_bot: true`: fix real issues, explain false positives

Low-priority prompt format:

```text
Found 3 low-priority suggestions:
1. [l] "Consider renaming this variable" - @reviewer in api.py:42
2. [nit] "Could use a list comprehension" - @reviewer in utils.py:18
3. [style] "Add a docstring" - @reviewer in models.py:55

Which should I address? ("1,3", "all", or "none")
```

### 3. Check CI Status

Run `uv run scripts/fetch_pr_checks.py [--pr NUMBER]`.

| State                                       | Action                                                     |
| ------------------------------------------- | ---------------------------------------------------------- |
| `failed > 0` and `actionable_pending == 0`  | fix failures                                               |
| `actionable_pending > 0`                    | wait; poll feedback while waiting                          |
| `pending > 0` and `actionable_pending == 0` | report `CHECKS_BLOCKED_BY_REVIEW_GATE`                     |
| no checks after grace period                | report `NO_CHECKS_REGISTERED` or `DRAFT_PR_WITH_NO_CHECKS` |
| all actionable checks passed                | run post-CI feedback check                                 |

Wait for actionable review bots: sentry, warden, cursor, bugbot, seer, codeql.
Do not wait for approval, `isDraft`, `REVIEW_REQUIRED`, Codecov, or informational bots.

### 4. Fix CI Failures

For each failure:

1. read full log: `gh run view <run-id> --log-failed`
2. trace from assertion/exception/lint rule to source
3. state the cause before editing: "fails because X, affected by Y"
4. search related call sites/patterns
5. fix root cause, not symptom
6. add focused test coverage when needed

### 5. Verify Locally, Then Commit and Push

Before commit:

- test fix: rerun specific test
- lint/type fix: rerun affected checker
- code fix: rerun covering tests
- local failure: fix before pushing

```bash
git add <files>
git commit -m "fix: <descriptive message>"
git push
```

### 6. Monitor CI and Address Feedback

Loop:

1. run `uv run scripts/fetch_pr_checks.py`
2. handle table in step 3
3. while `actionable_pending > 0`, run `uv run scripts/fetch_pr_feedback.py`
4. fix new high/medium feedback immediately
5. if changed, verify, commit, push, restart loop
6. otherwise sleep 30 seconds and repeat
7. after checks pass, wait 10 seconds, fetch feedback once more
8. if new high/medium feedback exists, return to step 4

Claude Code optional: run `uv run scripts/monitor_pr_checks.py` through `MonitorTool` with `persistent: false`; set timeout to normal repo CI duration. Restart the monitor after every push.

## Exit Conditions

| Exit     | Conditions                                                                      |
| -------- | ------------------------------------------------------------------------------- |
| Success  | actionable CI passed; post-CI feedback clean; low-priority choice handled       |
| Ask user | same failure after 2 attempts; feedback unclear; infrastructure issue           |
| Stop     | no PR; branch needs rebase; no checks; draft no-checks; only human gates remain |

## Fallback

If scripts fail, use `gh` CLI directly:

- `gh pr view --json number,url,headRefName,isDraft,reviewDecision`
- `gh pr checks --json name,state,bucket,description,link`
- `gh run view <run-id> --log-failed`
- `gh api repos/{owner}/{repo}/pulls/{number}/comments`
