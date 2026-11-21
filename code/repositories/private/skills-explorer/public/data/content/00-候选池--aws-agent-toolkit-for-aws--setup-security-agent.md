---
name: setup-security-agent
description: Configure AWS Security Agent for the current workspace — provision or reuse an agent space, IAM service role, and S3 bucket. Use when the user asks to "set up security agent", "configure security scanner", "is security agent configured", or on first-time use before any scan or pentest.
---

# AWS Security Agent — Setup

This skill handles ONE thing: making sure the workspace has a working agent space, IAM service role, and S3 bucket linked together. Scans and pentests live in separate skills and assume this is done.

---

## Local state convention

All Security Agent skills share workspace-local state at `.security-agent/`:

- `config.json` — `{ "agent_space_id": "as-...", "region": "us-east-1", "code_reviews": { "<abs_path>": "cr-..." } }`. Account ID, role ARN, and bucket name are derived by convention. The `code_reviews` map lets scans reuse the same CodeReview for a workspace.
- `scans.json` — array of `{ scan_id, code_review_id, job_id, agent_space_id, scan_type, title, started_at, status, path }` (keep last 50)
- `pentests.json` — same shape, for pentest jobs
- `.gitignore` — contents `*` so this directory stays untracked
- `findings-{scan_id}.md` — written by the scan skill after each scan completes

This skill's job is to populate `config.json` and create `.gitignore`.

### Derived values (convention over config)

Other skills compute these on each invocation rather than reading them from `config.json`:

| Value              | Convention                                                  |
| ------------------ | ----------------------------------------------------------- |
| `ACCOUNT`          | `aws sts get-caller-identity --query Account --output text` |
| `REGION`           | `config.region` (default `us-east-1`)                       |
| `service_role_arn` | `arn:aws:iam::${ACCOUNT}:role/SecurityAgentScanRole`        |
| `s3_bucket`        | `security-agent-scans-${ACCOUNT}-${REGION}`                 |

Why minimal config: the role name and bucket name are deterministic, so storing them adds drift risk (a user re-creating a role manually would silently use a stale path). Only `agent_space_id` is stored because users may have multiple agent spaces and we don't want to ask which one every session.

---

## Workflow

1. **Check existing state:** read `.security-agent/config.json` if it exists.
2. **Caller identity + region:**

   ```bash
   export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   export REGION="${AWS_REGION:-us-east-1}"
   ```

3. **Agent space:**
   - If `config.agent_space_id` is set, verify with:

     ```bash
     aws securityagent batch-get-agent-spaces --agent-space-ids <id>
     ```

     If the response shows it doesn't exist, treat as missing.

   - If missing, list existing:

     ```bash
     aws securityagent list-agent-spaces
     ```

     - If any exist → **show them to the user** with name + id and ask: "Would you like to reuse one of these, or should I create a new one?" Wait for the answer. **Do not auto-select.**
     - If user picks one, use that `agentSpaceId`.
     - If user wants new, or none exist:

       ```bash
       aws securityagent create-agent-space --name security-scans
       ```

       Capture returned `agentSpaceId`.
4. **Service role** (`SecurityAgentScanRole`, ARN `arn:aws:iam::$ACCOUNT:role/SecurityAgentScanRole`):
   - Probe:

     ```bash
     aws iam get-role --role-name SecurityAgentScanRole
     ```

   - If `NoSuchEntity` is returned, create the role. **Idempotency note:** `create-role` will fail with `EntityAlreadyExists` if the role already exists. If that happens, fall through to `update-assume-role-policy` to ensure the trust policy is correct.

     ```bash
     # Trust policy — includes aws:SourceAccount confused-deputy guard
     cat > /tmp/sa-trust.json <<EOF
     {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"securityagent.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"${ACCOUNT}"}}}]}
     EOF
     # Permissions policy (S3 + CloudWatch Logs)
     cat > /tmp/sa-perms.json <<EOF
     {"Version":"2012-10-17","Statement":[
       {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion","s3:ListBucket"],"Resource":["arn:aws:s3:::security-agent-scans-${ACCOUNT}-${REGION}","arn:aws:s3:::security-agent-scans-${ACCOUNT}-${REGION}/*"]},
       {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:*:${ACCOUNT}:log-group:/aws/securityagent/*"}
     ]}
     EOF

     aws iam create-role --role-name SecurityAgentScanRole --assume-role-policy-document file:///tmp/sa-trust.json
     # if EntityAlreadyExists:
     aws iam update-assume-role-policy --role-name SecurityAgentScanRole --policy-document file:///tmp/sa-trust.json
     # always (re)apply permissions:
     aws iam put-role-policy --role-name SecurityAgentScanRole --policy-name SecurityAgentCodeReviewAccess --policy-document file:///tmp/sa-perms.json
     ```

5. **S3 bucket** (`security-agent-scans-$ACCOUNT-$REGION`):

   > **Bucket-ownership enforcement (required).** The bucket name is derived from
   > the caller's AWS account ID and region — both non-secret and publicly
   > derivable from ARNs / ECR URIs — so any third party can pre-register
   > ("squat") the predictable name in their own account. Every S3 call MUST
   > pass `--expected-bucket-owner "$ACCOUNT"` so the operation fails closed if
   > the bucket is owned by someone else. A `403 Forbidden` on a bucket that
   > exists but is foreign-owned is **fatal** — abort setup and never upload.
   - Probe (asserts ownership):

     ```bash
     BUCKET="security-agent-scans-${ACCOUNT}-${REGION}"
     NEED_CREATE=0
     if aws s3api head-bucket --bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT" 2>/tmp/sa-head.err; then
       : # bucket exists and is owned by this account — safe to reuse
     elif grep -q '404' /tmp/sa-head.err; then
       NEED_CREATE=1
     elif grep -Eq '403|Forbidden' /tmp/sa-head.err; then
       echo "FATAL: bucket $BUCKET exists but is owned by another account (403). Possible bucket-squatting — aborting. Nothing was uploaded." >&2
       exit 1
     else
       cat /tmp/sa-head.err >&2; exit 1
     fi
     ```

   - If not found, create it. A `BucketAlreadyExists` error means another account
     already holds the global name — treat it as **fatal** and distinct from
     `BucketAlreadyOwnedByYou` (which is a safe no-op). Re-assert ownership after
     creation before any further use:

     ```bash
     if [ "$NEED_CREATE" = "1" ]; then
       if [ "$REGION" = "us-east-1" ]; then
         # us-east-1: no LocationConstraint
         aws s3api create-bucket --bucket "$BUCKET" 2>/tmp/sa-create.err || true
       else
         # other regions:
         aws s3api create-bucket --bucket "$BUCKET" \
           --create-bucket-configuration LocationConstraint="$REGION" 2>/tmp/sa-create.err || true
       fi
       if grep -q 'BucketAlreadyExists' /tmp/sa-create.err; then
         echo "FATAL: bucket name $BUCKET is already owned by another account (BucketAlreadyExists). Possible bucket-squatting — aborting." >&2
         exit 1
       elif [ -s /tmp/sa-create.err ] && ! grep -q 'BucketAlreadyOwnedByYou' /tmp/sa-create.err; then
         cat /tmp/sa-create.err >&2; exit 1
       fi
       # Confirm ownership of the freshly created bucket before using it.
       aws s3api head-bucket --bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT"
     fi
     ```

   - Always (re)apply public access block + 30-day lifecycle:

     ```bash
     aws s3api put-public-access-block --bucket "$BUCKET" \
       --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

     cat > /tmp/sa-lifecycle.json <<'EOF'
     {"Rules":[{"ID":"AutoDeleteUploads","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30}}]}
     EOF
     aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration file:///tmp/sa-lifecycle.json
     ```

6. **Register role + bucket on the agent space (idempotent):**
   - Read existing resources:

     ```bash
     aws securityagent batch-get-agent-spaces --agent-space-ids <id>
     ```

     Look at `agentSpaces[0].awsResources.iamRoles` and `awsResources.s3Buckets`.

   - If the role ARN or the bucket name is missing from those lists, merge and update:

     ```bash
     aws securityagent update-agent-space --agent-space-id <id> --name <existing-name> \
       --aws-resources iamRoles=[<arn1>,<arn2>...],s3Buckets=[<bucket1>,<bucket2>...]
     ```

7. **Persist** to `.security-agent/config.json` (minimal — account/role/bucket are derived):

   ```json
   {
     "agent_space_id": "as-xxxxx",
     "region": "us-east-1"
   }
   ```

8. **Create gitignore** if missing:

   ```bash
   mkdir -p .security-agent
   echo '*' > .security-agent/.gitignore
   ```

9. Confirm to user: "Setup complete. You can run security scans or pentests now."

---

## Rules

- Never auto-select an agent space when multiple exist — always ask the user
- Never disable safety protections (the public-access-block stays on)
- Every S3 call against the derived bucket MUST pass `--expected-bucket-owner "$ACCOUNT"`. The bucket name is derived from a non-secret account ID, so a third party can pre-register it; a `403`/`BucketAlreadyExists` on a foreign-owned bucket is fatal — abort and never upload.
- Trust policy must allow `securityagent.amazonaws.com` (production service principal) and include the `aws:SourceAccount` confused-deputy guard
- If the user provides their own role name or bucket name (different from the conventional defaults), tell them: this plugin uses convention-based defaults (`SecurityAgentScanRole` / `security-agent-scans-${ACCOUNT}-${REGION}`). Either accept those defaults or extend the skill — the other skills derive these names rather than reading them from config.
- The scan and pentest skills can call this skill inline if `config.json` is missing — first-time users don't need to run setup separately.

---

## Troubleshooting

- **`AccessDenied` calling `iam:CreateRole`** → user lacks IAM permissions. Ask them to run setup with their own role ARN, or to grant `iam:CreateRole` + `iam:PutRolePolicy`.
- **`AccessDenied` on `s3api create-bucket`** → either the bucket name is taken globally, or the user lacks `s3:CreateBucket`. Suggest using an existing bucket they own and pass it explicitly.
- **`403 Forbidden` / `BucketAlreadyExists` on the derived bucket** → the predictable name is owned by a _different_ account (bucket-squatting). This is fatal by design — do not upload. Have the user pick a bucket name they own (or run from the expected account/region) and re-run setup.
- **Role exists but trust policy is wrong** → `update-assume-role-policy` (step 4 fallback). If they don't want that role updated, ask them for a different role ARN.
- **Agent space exists but in a different region** → tell the user; suggest using the right region or creating a new space in the current region.
