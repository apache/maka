---
name: dms-schema-conversion
description: "Handles the full DMS Schema Conversion lifecycle including creating migration projects, converting database schemas to a target engine, running compatibility assessments, navigating metadata trees, exporting converted DDL to S3, applying schema changes to a target database, and converting SQL statements between database engines. Applies when migrating database schemas between heterogeneous engines using AWS DMS Schema Conversion."
version: 3
---

# DMS Schema Conversion

## Overview

This skill handles the full DMS Schema Conversion lifecycle — from first-time setup to running conversions on an existing project.

> The AWS MCP server is recommended for streamlined execution, audit logging, and observability. When the MCP server is not available, all operations can be performed via AWS CLI directly.

**Key documentation:**

- [Selection rules in DMS Schema Conversion](https://docs.aws.amazon.com/dms/latest/userguide/sc-selection-rules.html) — scoping operations to specific objects
- [Transformation rules in DMS Schema Conversion](https://docs.aws.amazon.com/dms/latest/userguide/sc-transformation-rules.html) — renaming schemas, tables, columns during conversion

**Global constraint:** You MUST fetch and read any linked documentation before acting on it — do NOT rely on memory for any referenced material (selection rules, transformation rules, troubleshooting guides, network configuration, etc.). Documentation contains vendor-specific details that change between engines and API versions.

---

## Guardrail — where this skill's own files live (MCP vs local install)

This skill can be loaded two ways, and they resolve the skill's own bundled files from different places. Determine how the skill was loaded before reading a reference:

- **Loaded through the AWS MCP `retrieve_skill` tool:** The skill is not installed on the local filesystem. You MUST fetch each reference via `retrieve_skill` with the `file` parameter (e.g. `file="references/setup-wizard.md"`). Do NOT `file_read` these paths locally — they do not exist on disk.
- **Installed locally** (e.g. `.kiro/skills/dms-schema-conversion/` or `~/.claude/skills/dms-schema-conversion/`): Read files from the local skill directory using relative paths.

This distinction applies only to the skill's own packaged files. User data and session artifacts are always read from and written to the user's working directory. Never fetch or write customer data through `retrieve_skill`.

---

## Verify Dependencies

Before starting, check that AWS CLI commands can be executed.

**Constraints:**

- You MUST verify that AWS CLI commands can be run (via MCP server tools or directly via shell)
- You MUST inform the customer if no execution method is available and ask whether to proceed
- You MUST ask the customer which AWS region to use — do NOT attempt to infer it from the STS response (it does not contain a region field). If the customer is unsure, suggest checking the `AWS_DEFAULT_REGION` environment variable or the `--region` flag they are using.

---

## Project Selection

Check for existing migration projects:

```
aws dms describe-migration-projects
```

- **If exactly one project exists** → ask the customer: "Found migration project `<name>`. Would you like to use it, or create a new one?" If they confirm, store `migration_project_identifier` and proceed to [Actions Menu](#actions-menu). If they want a new one, run the setup wizard.
- **If multiple projects exist** → list them and ask the customer to pick one, or offer to create a new project. Store `migration_project_identifier`, proceed to [Actions Menu](#actions-menu).
- **If no projects exist** → ask: "No migration projects found. Would you like to create one?" If yes, load [setup-wizard.md](references/setup-wizard.md) and run the full setup wizard from Phase 1. After wizard completes, run [Auto Import](#auto-import), then proceed to [Actions Menu](#actions-menu).

---

## Auto Import

> This section runs only after the setup wizard creates a new project. Do NOT run for existing projects.

1. Build selection rules to import **all schemas** from the source server. For `server-name`, use the data provider identifier (the short ID from the ARN, e.g., `JIFET2LUZJEJZPDYSOSGANOA2M`) or the literal `ServerName` value from the data provider settings (e.g., `"offline"` for offline sources). For SQL Server, you MUST include `database-name` in the object locator. See [Selection rules in DMS Schema Conversion](https://docs.aws.amazon.com/dms/latest/userguide/sc-selection-rules.html) for JSON format.

2. Run `start-metadata-model-import` with `--origin SOURCE --refresh` and the selection rules from step 1. Extract `RequestIdentifier` from the response.

3. Wait for import completion using the DMS waiter:

   ```
   aws dms wait metadata-model-imported \
     --migration-project-identifier <migration_project_identifier> \
     --filter 'Name=schema-conversion-operation-id,Values=<RequestIdentifier>'
   ```

   If the waiter fails or is unavailable, fall back to polling `describe-metadata-model-imports` every 30 seconds with `--filter Name=request-id,Values=<RequestIdentifier>`. Terminal statuses: **SUCCESS** (proceed) or **FAILED** (check error via the `Error` field in the response).

4. **Show discovered schemas:** On success, call `describe-metadata-model-children` with `--origin SOURCE` at the root level to list the imported schemas/databases. Present the discovered names to the customer so they can confirm the correct database connection was established:

   > "Import complete. I found the following schemas/databases: `<list>`. Does this look correct?"

5. Proceed to [Actions Menu](#actions-menu).

---

## Actions Menu

Present the actions menu using a structured selection tool (e.g., `AskUserQuestion`) if available — this gives the customer a clickable/selectable list.

**For SQL Server → PostgreSQL/Aurora PostgreSQL projects** (present as a single-select question "What would you like to do?"):

1. **Convert database** — convert schema objects to the target engine (also produces an conversion assessment report)
2. **Assess database** — run a compatibility assessment (also produces an conversion assessment report)
3. **Convert statement** — convert a single SQL statement
4. **Clean up** — delete migration project and related DMS resources

**For all other engine combinations** (present as a single-select question "What would you like to do?"):

1. **Convert database** — convert schema objects to the target engine (also produces an conversion assessment report)
2. **Assess database** — run a compatibility assessment (also produces an conversion assessment report)
3. **Work with tree** — browse the metadata model tree
4. **Clean up** — delete migration project and related DMS resources

The customer can always type a custom request via "Other" (e.g., "work with tree", "show database statistics", or "exit"). If the customer selects "Other" and describes an action covered by this skill, handle it accordingly.

After each action completes, return to this menu by presenting the same selection again.

> **Note on metadata loading:** `start-metadata-model-import` (with `Refresh=false`), `start-metadata-model-assessment`, and `start-metadata-model-conversion` all load the source tree for the scoped objects. If metadata was already imported in the current session for a given subtree, it does not need to be re-imported — these operations will work with what is already loaded.

---

### Convert Database

1. **Ask what to convert:** Ask the customer what they want to convert (e.g., "all schemas", "schema public", "tables starting with PROD_").

2. **Build selection rules:** Translate the customer's natural language to selection rules JSON. Refer to [Selection rules in DMS Schema Conversion](https://docs.aws.amazon.com/dms/latest/userguide/sc-selection-rules.html) for format, wildcards, and vendor-specific locators.

3. **Run conversion:** Call `start-metadata-model-conversion` with the migration project and selection rules. Extract `RequestIdentifier` from the response.

4. **Wait for completion:** Wait using the DMS waiter:

   ```
   aws dms wait metadata-model-converted \
     --migration-project-identifier <migration_project_identifier> \
     --filter 'Name=schema-conversion-operation-id,Values=<RequestIdentifier>'
   ```

   If the waiter fails or is unavailable, fall back to polling `describe-metadata-model-conversions` every 30 seconds with `--filter Name=request-id,Values=<RequestIdentifier>`. Terminal statuses: **SUCCESS** (proceed) or **FAILED** (check error).

5. **Export conversion assessment report:** On conversion success, call `export-metadata-model-assessment` with selection rules using `rule-action: "explicit"` (this API requires explicit rules, not `include`). Provide the customer with S3 links for both PDF and CSV reports (`PdfReport.S3ObjectKey` and `CsvReport.S3ObjectKey`).

6. **Show summary:** Download the Summary CSV from S3 using `aws s3 cp s3://<bucket>/<CsvReport.S3ObjectKey> ./Summary.csv`. Present its contents to the customer — show the number of objects per category, how many converted automatically, and how many have Action Items at each complexity level.

7. **Post-convert sub-menu:** After showing the summary, present options. Only show "Apply to target" if the target is a live target (not virtual):

   > "What would you like to do next?
   >
   > 1. **Fix Action Items** — review and fix Action Items from the conversion assessment report
   > 2. **Export as script** — export converted DDL as SQL script to S3
   > 3. **Apply to target** — apply converted objects to the target database _(live targets only)_
   > 4. **Back** — return to actions menu"
   - **Fix Action Items:** Load [action-items.md](references/action-items.md) and follow the fixing workflow there.
   - **Export as script:** Run `aws dms start-metadata-model-export-as-script --migration-project-identifier <migration_project_identifier> --origin TARGET --selection-rules '<json>'`. Extract `RequestIdentifier`. Wait via `aws dms wait metadata-model-exported-as-script --migration-project-identifier <id> --filter 'Name=schema-conversion-operation-id,Values=<RequestIdentifier>'`. Provide the S3 link on completion.
   - **Apply to target:** Run `aws dms start-metadata-model-export-to-target --migration-project-identifier <migration_project_identifier> --selection-rules '<json>'`. Optionally pass `--overwrite-extension-pack` if the customer confirms. Extract `RequestIdentifier`. Wait via `aws dms wait metadata-model-exported-to-target --migration-project-identifier <id> --filter 'Name=schema-conversion-operation-id,Values=<RequestIdentifier>'`. Inform the customer on completion.
   - **Back:** Return to [Actions Menu](#actions-menu).

After completing, ask the customer what they'd like to do next.

---

### Assess Database

Assessment analyzes conversion complexity and generates an conversion assessment report **without** actually converting any objects. Use this when the customer wants to understand the migration effort before committing to conversion.

> **Important:** If the customer already ran a conversion on the same scope, a separate assessment is not necessary — conversion already produces an conversion assessment report. Inform the customer: "You already have an conversion assessment report from the conversion you ran. Would you like me to show that report instead, or do you want to re-run assessment on a different scope?"

1. **Ask what to assess:** Ask the customer what they want to assess (e.g., "all schemas", "schema pg_catalog", "tables starting with PROD_").

2. **Build selection rules:** Translate the customer's natural language to selection rules JSON. Refer to [Selection rules in DMS Schema Conversion](https://docs.aws.amazon.com/dms/latest/userguide/sc-selection-rules.html) for format, wildcards, and vendor-specific locators.

3. **Run assessment:** Call `start-metadata-model-assessment` with the migration project and selection rules. Extract `RequestIdentifier` from the response.

4. **Wait for completion:** Wait using the DMS waiter:

   ```
   aws dms wait metadata-model-assessed \
     --migration-project-identifier <migration_project_identifier> \
     --filter 'Name=schema-conversion-operation-id,Values=<RequestIdentifier>'
   ```

   If the waiter fails or is unavailable, fall back to polling `describe-metadata-model-assessments` every 30 seconds with `--filter Name=request-id,Values=<RequestIdentifier>`. Terminal statuses: **SUCCESS** (proceed) or **FAILED** (check error).

5. **Export conversion assessment report:** On success, call `export-metadata-model-assessment` with the same selection rules. Provide the customer with S3 links for both PDF and CSV reports (`PdfReport.S3ObjectKey` and `CsvReport.S3ObjectKey`). The report contains conversion complexity statistics, Action Items, and estimated effort.

6. **Show summary:** Download the Summary CSV from S3 using `aws s3 cp s3://<bucket>/<CsvReport.S3ObjectKey> ./Summary.csv`. Present its contents to the customer — show the number of objects per category, how many converted automatically, and how many have Action Items at each complexity level.

7. **Offer to fix Action Items:** Ask the customer:

   > "Would you like me to help fix the Action Items?"

   If yes, load [action-items.md](references/action-items.md) and follow the fixing workflow there.

After completing, ask the customer what they'd like to do next.

---

### Review Action Items

Load [action-items.md](references/action-items.md) and follow the workflow there.

After completing, ask the customer what they'd like to do next.

---

### Work with Tree

The metadata tree represents database schemas hierarchically. It contains two kinds of elements:

- **Objects** — actual database objects (tables, functions, views, sequences, indexes) that have SQL definitions
- **Categories** — virtual grouping containers ("Schemas", "Tables", "Functions") that organize objects for navigation but have no SQL definitions

The tree uses on-demand loading — metadata is retrieved from the database only when imported. See [Navigating the metadata model](https://docs.aws.amazon.com/dms/latest/userguide/sc-metadata-model.html#sc-metadata-model-navigating) for full details.

**Navigation uses two APIs:**

- `describe-metadata-model-children` — returns the children of a given node, each with its own `SelectionRules` for drilling deeper
- `describe-metadata-model` — returns the name, type, and SQL definition of a specific object

Both require `--origin SOURCE` or `--origin TARGET` and accept only `explicit` selection rules.

1. **Show tree root:** Call `describe-metadata-model-children` with selection rules targeting the root level and `--origin SOURCE`. If the tree is empty, automatically run a metadata import (same as [Auto Import](#auto-import)) and then re-display the tree root.

2. **Navigate:** Each child in the response has `MetadataModelName` and `SelectionRules`. Present the children and ask the customer what to do:
   - **Show children** — drill into a child by calling `describe-metadata-model-children` with the child's `SelectionRules` as the `--selection-rules` parameter
   - **Show definition** — display the DDL for the selected object (see step 3). Only available for objects, not categories.
   - **Go up** — return to the parent node
   - **Exit tree** — return to actions menu

3. **Show definition:** Call `describe-metadata-model` with the child's `SelectionRules` and `--origin SOURCE`. The response includes `Definition` (SOURCE DDL) and `TargetMetadataModels` (list of converted counterparts with their own `SelectionRules`). To get the TARGET DDL, call `describe-metadata-model` again with `SelectionRules` from `TargetMetadataModels[0]` and `--origin TARGET`. Present both clearly labeled as **SOURCE** and **TARGET**.

4. **Refresh from database:** If the customer asks to refresh, run `start-metadata-model-import` with selection rules scoped to the current tree position, `--origin SOURCE --refresh`. Extract `RequestIdentifier`. Wait via `aws dms wait metadata-model-imported --migration-project-identifier <id> --filter 'Name=schema-conversion-operation-id,Values=<RequestIdentifier>'`. After refresh completes, re-display the current node's children.

After completing, ask the customer what they'd like to do next.

---

### Convert Statement

> **Restriction:** This feature is only available for **SQL Server → PostgreSQL/Aurora PostgreSQL** migration projects. Do NOT offer or show this option for any other source/target engine combination.

1. **Determine context:** Navigate the metadata tree to find the target location. For SQL Server this is server → database → schema; for other engines it's server → schema. Use `describe-metadata-model-children` to drill into nodes until you reach the schema level. Let the customer pick the schema (or database + schema for SQL Server). If the tree is empty, ask the customer to provide the location manually.

2. **Get the SQL statement:** Ask the customer for the SQL statement they want to convert.

3. **Build selection rules for the schema:** Build selection rules targeting the schema location. See [Selection rules in DMS Schema Conversion](https://docs.aws.amazon.com/dms/latest/userguide/sc-selection-rules.html) for format and vendor-specific locators.

4. **Create metadata model:** Generate a unique model name (e.g., `statement-<timestamp>`). Call `start-metadata-model-creation` with:
   - `--selection-rules` — the schema selection rules from step 3
   - `--metadata-model-name` — the generated model name
   - `--properties '{"StatementProperties": {"Definition": "<sql_statement>"}}'`

   Extract `RequestIdentifier` from the response. Wait via `aws dms wait metadata-model-created --migration-project-identifier <id> --filter 'Name=schema-conversion-operation-id,Values=<RequestIdentifier>'`.

5. **Build selection rules for the statement:** Build selection rules targeting the specific statement. See [Selection rules in DMS Schema Conversion](https://docs.aws.amazon.com/dms/latest/userguide/sc-selection-rules.html) — use `statement-name` set to the model name.

6. **Convert the created model:** Call `start-metadata-model-conversion` with the statement selection rules from step 5. Extract `RequestIdentifier`. Wait via `aws dms wait metadata-model-converted --migration-project-identifier <id> --filter 'Name=schema-conversion-operation-id,Values=<RequestIdentifier>'`.

7. **Show converted result:** Call `describe-metadata-model` with the statement selection rules from step 5 and `--origin SOURCE`. From the response, extract `TargetMetadataModels[0].SelectionRules`. Then call `describe-metadata-model` with those target selection rules and `--origin TARGET`. Present the converted SQL from the `Definition` field clearly to the customer.

8. **Export conversion assessment report:** Call `export-metadata-model-assessment` with the **source** selection rules from step 5. Provide the customer with S3 links for PDF and CSV reports.

After completing, ask the customer what they'd like to do next.

---

### Database Statistics

When a customer asks about their source database statistics — such as the number of objects, object types, schema sizes, or a general overview — run an assessment and present the results as a concise summary.

1. **Build selection rules** based on the customer's scope. If they specify particular schemas or objects, scope accordingly. If no scope is specified, default to all schemas on the source server (wildcard `%`). See [Selection rules in DMS Schema Conversion](https://docs.aws.amazon.com/dms/latest/userguide/sc-selection-rules.html) for JSON format.

2. **Run assessment:** Call `start-metadata-model-assessment` with the migration project and selection rules. See [schema-conversion-operations.md](references/schema-conversion-operations.md) for execution details.

3. **Wait for completion** using the DMS waiter or fallback polling as described in [schema-conversion-operations.md](references/schema-conversion-operations.md).

4. **Export conversion assessment report:** Call `export-metadata-model-assessment` with the same selection rules.

5. **Download and present only what the customer asked for:** Download the Summary CSV from S3:

   ```
   aws s3 cp s3://<bucket>/<CsvReport.S3ObjectKey> ./Summary.csv
   ```

   The report contains many data points. Present **only** the information the customer requested — do not dump the entire report. For example:
   - If they asked "how many tables?" → show only the table count
   - If they asked about a specific schema → show only that schema's stats

6. **Offer next steps:** Ask if they'd like to see conversion complexity or proceed with conversion.

**Constraints:**

- If the customer specifies a scope, use it. If not, default to all schemas.
- Present only what the customer asked for — do not overwhelm with unrequested data.
- Present statistics in a clear, tabular format.

After completing, ask the customer what they'd like to do next.

---

### Clean Up

Delete the migration project and its associated DMS resources. Resources MUST be deleted in dependency order.

1. **Confirm with customer:** List the resources that will be deleted and ask for confirmation:

   ```
   aws dms describe-migration-projects --filter Name=migration-project-identifier,Values=<migration_project_identifier>
   ```

   Show the project name, source/target data providers, and instance profile.

2. **Delete migration project:**

   ```
   aws dms delete-migration-project \
     --migration-project-identifier <migration_project_identifier>
   ```

3. **Delete data providers:** Delete both source and target data providers:

   ```
   aws dms delete-data-provider \
     --data-provider-identifier <source_data_provider_identifier>
   aws dms delete-data-provider \
     --data-provider-identifier <target_data_provider_identifier>
   ```

4. **Delete instance profile:**

   ```
   aws dms delete-instance-profile \
     --instance-profile-identifier <instance_profile_identifier>
   ```

5. **Delete subnet group:**

   ```
   aws dms delete-replication-subnet-group \
     --replication-subnet-group-identifier <subnet_group_identifier>
   ```

6. **Confirm completion:** Inform the customer that all DMS Schema Conversion resources have been removed.

**Constraints:**

- You MUST get explicit customer confirmation before deleting any resources.
- You MUST delete in order: migration project first, then data providers, then instance profile, then subnet group — deleting in the wrong order will fail due to dependencies.
- You MUST NOT delete the underlying infrastructure (VPC, subnets, security groups, RDS instances, Secrets Manager secrets) — those are outside the scope of DMS Schema Conversion cleanup.

After completing, ask the customer what they'd like to do next.

---

## Cancel Awareness

During any running async operation, if the customer requests cancellation, refer to [cancel-operations.md](references/cancel-operations.md) for the correct cancel command mapping.

---

## Security Considerations

- **Credentials:** All database credentials are stored in AWS Secrets Manager. Never embed credentials in data provider settings or log them to output.
- **Encryption at rest:** S3 buckets use SSE-S3 encryption (default). SSE-KMS is not supported by DMS Schema Conversion.
- **Encryption in transit:** Online connections should use `require` or stronger SSL mode. `none` should only be used in isolated test environments.
- **IAM least-privilege:** All IAM roles use confused-deputy condition keys (`aws:SourceAccount`, `aws:SourceArn`) and scoped resource ARNs.
- **Network access:** DMS instance profiles operate within VPC subnets with security group restrictions.
- See [DMS security best practices](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Security.html) for additional guidance.

---

## Error Handling

When any operation fails or returns an error, load [troubleshooting.md](references/troubleshooting.md) and follow its guidance to diagnose and resolve the issue. Explain the error to the customer in plain language and offer options: retry, try a different action, or exit.
