---
name: running-release-tests
description: >-
  Run automated release testing (UI or API) via the AWS DevOps Agent using a
  pre-configured test profile. Use when the user wants to validate multi-step
  workflows, verify features, check for regressions, or test API endpoints.
  Trigger words include run tests, UAT, test my app, test profile, UI test,
  API test, automated testing, regression test, QA, end-to-end test, run the QA agent.
---

# Release Testing

> **AgentSpace routing (SigV4 only):** If `list_agent_spaces` is available in your tool list and the multi-space orchestration skill has NOT been invoked yet this session, invoke it first to determine which `agent_space_id` to use. Then pass `agent_space_id` on all tool calls below. For bearer token auth this is unnecessary — the token is already scoped to one space.

Run automated release testing in the cloud via the AWS DevOps Agent's Release Testing Agent. Supports UI testing (browser-based) and API testing (OpenAPI spec-based). Uses pre-existing test profiles that define target URL, agent type, personas, and credentials.

**Input is a test profile** — the test profile already contains the target URL, agent type (UI or API), test personas, and credentials. Do NOT ask the user for a URL directly; the URL is defined in the test profile.

## Prerequisites

- A pre-existing test profile (Knowledge Item ID like `ki-12345`) created from the AWS DevOps Agent console

## Gathering test parameters

Before starting any workflow, you MUST gather the following parameters. Do NOT proceed to job creation until answered.

### Step 1 — Test profile (required)

Ask the user which test profile to use. The test profile already contains the target URL, agent type (UI or API), test personas, and credentials configuration — these do NOT need to be gathered separately.

**Note:** A pre-existing test profile is a prerequisite. Test profiles are created using the AWS DevOps Agent console or API, not through this tool. If the user asks whether one can be created here, inform them it must already exist.

### Step 2 — Test requirement (optional)

If the user has not already mentioned a test focus, ask:

> "Do you have a specific test requirement or focus area? If not, I'll run a full exploratory test."

Wait for the user's response. If they provide one, use it as the `test_requirement`. If they say no or skip, proceed without it.

**IMPORTANT: You MUST wait for the user to respond before proceeding to job creation.**

## Core workflow

### 1. Select Agent Space

List available agent spaces:

```
aws devops-agent list-agent-spaces --region us-east-1
```

Present the list to the user and ask which agent space they'd like to use. **Do NOT proceed until the user has selected one.** Use the selected `agentSpaceId` as `SPACE_ID` in all subsequent calls.

### 2. Check tool availability

Verify that the following tools are available: `aws_devops_agent__create_release_testing_job`, `aws_devops_agent__get_task`, `aws_devops_agent__list_journal_records`, `aws_devops_agent__get_release_ui_testing_report`, `aws_devops_agent__get_release_api_testing_report`. These tools are NOT deferred/lazy-loaded — if they do not appear in your tool list, they are unavailable. Do NOT search for them via ToolSearch. If any are missing, skip the remaining steps in this section and use the "Fallback (aws-mcp)" path below instead.

### 3. Start the Job

```
aws_devops_agent__create_release_testing_job(
    test_profile_id="ki-12345",
    webhook_event_message="<optional test requirement>"
)
→ {"taskId": "...", "executionId": "...", "status": "started"}
```

Record the **taskId** and **executionId** from the response.

### 4. Poll for Status

Call `aws_devops_agent__get_task(task_id=TASK_ID)` every **30 seconds** until the status transitions to `IN_PROGRESS` or a terminal state.

### 5. Monitor Until Completion

Once `IN_PROGRESS`, poll for progress in a loop:

1. Call `aws_devops_agent__list_journal_records(execution_id=EXEC_ID, order="ASC")` to fetch new findings.
2. Present each record to the user with a friendly progress update.
3. Use `next_token` from the response to fetch only new records on subsequent polls.
4. **Wait 20 seconds** between each poll iteration.
5. Check `aws_devops_agent__get_task(task_id=TASK_ID)` periodically — stop when terminal status (`COMPLETED`, `FAILED`, `CANCELED`, `TIMED_OUT`).

### 6. Present Results

Once the job reaches a terminal status:

- If `COMPLETED`:
  1. Determine the report type from the test profile's agent type (UI or API). Call `aws_devops_agent__get_release_ui_testing_report(execution_id=EXEC_ID)` for UI profiles or `aws_devops_agent__get_release_api_testing_report(execution_id=EXEC_ID)` for API profiles.
  2. Write the report contents to a markdown file:

     ```
     release-testing-report-<YYYY-MM-DD-HHmmss>.md
     ```

  3. Inform the user that the report was saved, including the file path.
- If `FAILED` or `TIMED_OUT`: Present the error information and suggest next steps.
- If `CANCELED`: Inform the user the job was canceled and no report is available.

## Cancelling a job

```
aws_devops_agent__cancel_release_testing_job(task_id=TASK_ID)
```

## Error handling

1. If the task status changes to `FAILED`, stop the workflow and report the error.
2. If the task does not reach `IN_PROGRESS` within 5 minutes, cancel it using `cancel_release_testing_job`.
3. If any output contains "NoCredentialsError", "ExpiredTokenException", or auth failures, suggest the user refresh their credentials or check the bearer token.
4. If throttled (`429` or `ThrottlingException`), wait 30 seconds before retrying. After 3 retries, inform the user.

## Fallback (aws-mcp)

If the `aws-devops-agent` remote server is unavailable, use the AWS CLI directly:

Tell the user: "Remote server unavailable — using direct AWS API fallback."

### 1. Select Agent Space

List available agent spaces:

```
aws devops-agent list-agent-spaces --region us-east-1
```

Present the list to the user and ask which agent space they'd like to use. **Do NOT proceed until the user has selected one.** Use the selected `agentSpaceId` as `SPACE_ID` in all subsequent calls.

### 2. Start the Job

```
aws devops-agent create-backlog-task \
  --agent-space-id SPACE_ID \
  --task-type RELEASE_TESTING \
  --title 'Release Testing' \
  --priority MEDIUM \
  --description '{\"testProfileId\": \"<PROFILE_ID>\", \"webhookEventMessage\": \"<REQUIREMENT>\"}' \
  --region us-east-1
```

If the user provided a test requirement, include it as `webhookEventMessage`. If not, omit the field or leave it empty.

### 3. Poll for Status

```
aws devops-agent get-backlog-task \
  --agent-space-id SPACE_ID \
  --task-id TASK_ID \
  --region us-east-1
```

Poll every **30 seconds** until the status transitions to `IN_PROGRESS` or a terminal state (`COMPLETED`, `FAILED`, `CANCELED`, `TIMED_OUT`).

### 4. Monitor Until Completion

Once `IN_PROGRESS`, poll for progress in a loop:

```
aws devops-agent list-journal-records \
  --agent-space-id SPACE_ID \
  --execution-id EXEC_ID \
  --order ASC \
  --region us-east-1
```

1. Present each record to the user with a friendly progress update.
2. Use `next_token` from the response to fetch only new records on subsequent polls.
3. **Wait 20 seconds** between each poll iteration.
4. Check `get-backlog-task` periodically — stop when terminal status (`COMPLETED`, `FAILED`, `CANCELED`, `TIMED_OUT`).

### 5. Present Results

Once the job reaches a terminal status:

- If `COMPLETED`:
  1. Retrieve the report using the appropriate record type:
     - **UI testing**: `--record-type qa_ui_testing_report`
     - **API testing**: `--record-type qa_api_testing_report`

     ```
     aws devops-agent list-journal-records \
       --agent-space-id SPACE_ID \
       --execution-id EXEC_ID \
       --record-type qa_ui_testing_report \
       --order ASC \
       --region us-east-1
     ```

  2. Write the report contents to a markdown file:

     ```
     release-testing-report-<YYYY-MM-DD-HHmmss>.md
     ```

  3. Inform the user that the report was saved, including the file path.
- If `FAILED` or `TIMED_OUT`: Present the error information and suggest next steps.
- If `CANCELED`: Inform the user the job was canceled and no report is available.

#### Cancelling (fallback)

```
aws devops-agent update-backlog-task \
  --agent-space-id SPACE_ID \
  --task-id TASK_ID \
  --task-status CANCELED \
  --region us-east-1
```
