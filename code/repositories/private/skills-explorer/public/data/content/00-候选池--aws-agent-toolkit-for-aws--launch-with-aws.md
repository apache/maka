---
name: launch-with-aws
description: "Migrates vibe-coded web applications to AWS. Handles the full workflow from analysis through migration to deployment, producing deployable AWS Blocks infrastructure code. Supports full-stack apps built with vibe-coding platforms (Lovable, Bolt.new, Replit) and frontend web applications and websites: React, Vue, Angular, Next.js, Nuxt, Astro, SvelteKit, Gatsby, Vite, Svelte, Solid, Docusaurus, and others (static sites, SPAs, and SSR frameworks with static export). Triggers on: launch with AWS, launch on AWS, deploy to AWS, migrate to AWS, host my app on AWS, move my app to AWS, transfer my app to AWS. Activates when the user wants to migrate a vibe-coded app or frontend web app to AWS, even if they don't say 'migrate' explicitly."
metadata:
  version: "3"
---

# Launch with AWS

Drives an AWS migration end-to-end using CLI scripts. Takes a user's web application, analyzes it, generates a migration plan with cost estimate, and delivers deployable [AWS Blocks](https://docs.aws.amazon.com/blocks/latest/devguide/what-is-blocks.html) infrastructure code.

The AWS MCP server is recommended but is not required. This skill works standalone via its CLI scripts in any agent environment.

## Script Invocation

All commands are run via:

```bash
python3 scripts/launch_with_aws.py <command> [args...]
```

where `scripts/` is relative to this skill directory. The agent MUST set the working directory to the skill root before invoking commands.

Required files: [launch_with_aws.py](scripts/launch_with_aws.py), [launch_config.py](scripts/launch_config.py), [auth.py](scripts/auth.py), [auth_callback_server.py](scripts/auth_callback_server.py), [launch_api_client.py](scripts/launch_api_client.py), [archive.py](scripts/archive.py), [service model](references/launchwithaws-2026-06-15.json). When loaded via MCP, fetch all and write to a temp directory preserving structure before invoking.

Each command outputs JSON to stdout on success, or exits non-zero with a JSON error on stderr.

Dependencies: Python 3.10+ and `boto3`. The script checks both on startup and exits with a clear error if either is missing.

## Supported Application Types

Full-stack apps built with vibe-coding platforms, and frontend web applications and websites (static sites, SPAs, and SSR frameworks with static export).

| Origin Platform | What it covers                                                  |
| --------------- | --------------------------------------------------------------- |
| Lovable         | Lovable-generated full-stack apps (React + Supabase)            |
| Bolt.new        | Bolt.new-generated full-stack apps (React + Supabase)           |
| Replit          | Replit-hosted full-stack apps (React + Express.js + PostgreSQL) |

| Framework               | Examples                                     |
| ----------------------- | -------------------------------------------- |
| React ecosystem         | React, CRA, Vite + React, Gatsby, Docusaurus |
| Vue ecosystem           | Vue, Nuxt (static export), VitePress         |
| Angular                 | Angular                                      |
| Svelte ecosystem        | Svelte, SvelteKit (static export)            |
| SSR with static export  | Next.js, Nuxt, Astro, SvelteKit              |
| Other modern frameworks | Astro, Solid, Preact, Lit, Eleventy          |
| Vite (generic)          | Any Vite-based app                           |

Other frameworks may also work. If the user's app doesn't match these, see **Unsupported Application Handling** below.

### What Gets Migrated vs. What Stays

**Lovable / Bolt.new apps (Supabase-backed):**

| Component                          | What happens                               |
| ---------------------------------- | ------------------------------------------ |
| Frontend & hosting                 | Migrated to AWS (S3 + CloudFront + Lambda) |
| Edge functions / server functions  | Migrated to AWS Lambda                     |
| AI calls (e.g. Lovable AI Gateway) | Migrated to Amazon Bedrock                 |
| Database (Supabase DB)             | Stays on Supabase — not migrated           |
| Auth (Supabase Auth)               | Stays on Supabase — not migrated           |
| Storage & Realtime                 | Stays on Supabase — not migrated           |

The app continues to call Supabase for database, auth, storage, and realtime from the AWS-hosted application.

**Replit apps (Express.js + PostgreSQL):**

| Component                 | What happens                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend & hosting        | Migrated to AWS (S3 + CloudFront + Lambda)                                                                                                              |
| Server logic (Express.js) | Migrated to AWS Lambda (API Gateway)                                                                                                                    |
| Database (PostgreSQL)     | Schema and code migrated to AWS (Aurora Serverless / DynamoDB). Existing data is NOT migrated — customers must export and import their data separately. |
| Auth (Replit Auth)        | Code migrated to AWS (Cognito). Existing user accounts are NOT migrated — customers must re-create or invite users in Cognito.                          |
| Realtime (WebSockets)     | Migrated to AWS (API Gateway WebSocket)                                                                                                                 |
| File storage              | Migrated to AWS (S3). Existing files are NOT migrated.                                                                                                  |

Replit app infrastructure and code are migrated to AWS-native services, but existing data, user accounts, and files must be migrated separately by the customer.

## Input Resolution

Resolve the user's input to a local directory path or GitHub URL:

- If the user provides a **local path**: pass that path directly.
- If the user provides a **GitHub URL**: pass it directly (the service clones it server-side).
- If neither is provided: use the current working directory. If it doesn't look like an app directory, ask the user for the path.

## Flow

Run the script commands in order, surfacing results to the user at each step:

### 1. Authentication

```bash
python3 scripts/launch_with_aws.py auth-start
```

Always run first. Returns immediately with JSON:

- If already authenticated: `{"authenticated": true, "reusedCachedSession": true, "baseUrl": "..."}`
- If silent refresh succeeded: `{"authenticated": true, "reusedCachedSession": false, "baseUrl": "..."}`
- If interactive sign-in is needed: `{"authenticated": false, "signInUrl": "https://...", "pid": 12345, "port": 54321, "baseUrl": "..."}`

When `authenticated` is `false`, **immediately display the `signInUrl` to the user** (so they can open it in their browser) and call `auth-wait` in the same response:

```bash
python3 scripts/launch_with_aws.py auth-wait <pid>
```

where `<pid>` is the `pid` value from the `auth-start` response. This blocks until the user completes browser sign-in (or times out after 600s). Returns `{"authenticated": true, "baseUrl": "..."}` on success.

Sessions are capped at 90 days even if the identity provider does not set an expiration; after that the interactive flow is required again.

To check the current session without authenticating, or to sign out:

```bash
python3 scripts/launch_with_aws.py session-status
python3 scripts/launch_with_aws.py sign-out
```

`session-status` reports whether a session exists and how long until the token and overall session expire. `sign-out` best-effort revokes the refresh token and deletes the local `~/.launch-with-aws/session.json`. On shared or untrusted workstations, run `sign-out` when finished.

### 2. Create Launch

For a local directory, present this confirmation and wait for explicit approval:

> Your source code will be uploaded to the Launch with AWS service to analyze your application and generate a migration plan. If you later approve execution, an AWS-hosted agent will modify a copy of your source code according to the plan and produce a migrated snapshot for you to download. Your uploaded source code and associated launch data are encrypted in transit and at rest and retained for up to 48 hours for recovery. Your data is never used to train AI models. We exclude Git history, Git-ignored files, and files matching common sensitive-file patterns. Sensitive-file filtering is best effort; review your project for secrets. Continue?

Do NOT call `create-launch` for a local directory until the user explicitly confirms. A missing or ambiguous response means no.

```bash
python3 scripts/launch_with_aws.py create-launch <source-path-or-github-url> [name]
```

Creates a launch from a local directory (zips, uploads, then creates) or a GitHub URL (passes directly). Returns JSON with the full `launch` object including `launch.launchId`.

The launch starts in `analyzing` status and automatically progresses through analysis and planning.

### 3. Poll Launch Status

```bash
python3 scripts/launch_with_aws.py get-launch-status <launch-id>
```

Poll until `status` is `planned` (ready for execution), `awaiting_input` (needs context answers — see step 4), or `failed`. Key status progression:

- `analyzing` → detecting app type and dependencies
- `awaiting_input` → needs context answers (see `refine-plan`)
- `planning` → generating migration plan
- `planned` → ready for execution
- `executing` → deployment in progress
- `completed` → done
- `failed` → check `failureReason`

If `status` is `awaiting_input`, check `contextInputs` for the questions that need answering. Inputs with `required: true` must be answered before the launch can proceed; others are optional enrichment.

### 4. Refine Plan (if awaiting_input)

```bash
python3 scripts/launch_with_aws.py refine-plan <launch-id> key1=value1 key2=value2
```

Provide context answers to refine the plan. Triggers re-planning.

### 5. Get Full Launch Details & Confirm

```bash
python3 scripts/launch_with_aws.py get-launch <launch-id> plan,cost_estimate
```

Get full launch details. Optional second argument is a comma-separated include list: `analysis`, `plan`, `execution`, `cost_estimate`, `download_url`.

Present the cost estimate and plan to the user. The `costEstimate` field in the response contains `estimatedMonthlyCost`, `region`, and a `services` breakdown with per-service costs.

**Confirmation Gate — present and wait for explicit approval:**

> **Migration Summary**
>
> - App type: [detected type from analysis]
> - Architecture: [target architecture from plan]
> - Estimated monthly cost: $X.XX/month
> - Region: us-east-1
>
> Ready to proceed? This will execute the migration in an AWS-managed environment (no cost to you) and produce the migrated snapshot for you to download.

Do NOT call `start-launch-execution` until the user explicitly confirms.

### 6. Start Execution

```bash
python3 scripts/launch_with_aws.py start-launch-execution <launch-id>
```

Starts deployment. Then poll with `get-launch-status` until `status` is `completed` or `failed`. Sleep at least 30 seconds between polls.

### 7. Download

```bash
python3 scripts/launch_with_aws.py get-launch-download-url <launch-id>
```

**Always present the full download URL to the user** — they may need it to download the migrated snapshot directly or for reference.

### 8. List or Delete Launches

```bash
python3 scripts/launch_with_aws.py list-launches
python3 scripts/launch_with_aws.py delete-launch <launch-id>
```

### 9. Post-Migration: Apply Migrated Code Locally

After obtaining the download URL (adapt commands for the user's platform if not POSIX):

#### Step A: Download and unpack

```bash
curl -L -o /tmp/migration-snapshot.zip "<download_url>"
mkdir -p /tmp/migration-output
unzip -o /tmp/migration-snapshot.zip -d /tmp/migration-output
```

#### Step B: Prepare the local workspace

Ensure the user's working directory is clean:

```bash
cd <user-app-directory>
git status
```

If there are uncommitted changes, ask the user to commit or stash first. Do NOT proceed with a dirty working tree.

#### Step C: Apply migration (3-way merge)

Create a migration branch and overlay the migrated files:

```bash
cd <user-app-directory>
git checkout -b aws-migration
rsync -a /tmp/migration-output/ .
git status
git diff --stat
```

Review the changes with the user. Key additions to highlight:

- `aws-blocks/` — AWS Blocks infrastructure definition
- `DEPLOY.md` — deployment instructions
- Any modified config files

If there are conflicts with the user's existing files, present them and ask how to resolve.

#### Step D: Follow DEPLOY.md

Read the `DEPLOY.md` file in the project root and follow its instructions to deploy the app to the user's AWS account. Typical steps:

1. AWS authentication (`aws login --profile aws-migrate --region us-east-1`)
2. CDK bootstrap (first-time only): `npm install && npx cdk bootstrap`
3. Deploy: `npx cdk deploy --all --progress events`
4. Verify the CloudFront URL that CDK prints on completion.

**Important:** Always read `DEPLOY.md` from the migrated output — it is generated specifically for this app and architecture. Do not assume deployment steps from memory.

## Unsupported Application Handling

If a launch fails during analysis with a `failureReason` indicating an unsupported app type (or the user's stack doesn't match the supported list):

1. Tell the user: "This app type isn't directly supported by Launch with AWS yet. Let me search for other skills that can help deploy this kind of application."

2. Search for relevant skills based on the app type (e.g. `aws-serverless`, `aws-containers`, `databases-on-aws`, `deploy-on-aws`, `aws-cdk`, `sagemaker-ai`).
