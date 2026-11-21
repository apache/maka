---
name: taxonomy
description: >
  Source of truth for event taxonomy generation, data auditing, and governance best practices
  in Amplitude. Use when an agent needs to create, validate, audit, score, or recommend
  improvements to event tracking plans, naming conventions, property standards, data quality,
  or deprecation workflows. Covers naming rules, property standards, scoring frameworks,
  safe metadata operations, deprecation procedures, and AI readiness guidance.
---

# Taxonomy Generation & Data Auditing

## When to Use

- User asks to create or review a tracking plan or event taxonomy
- User wants to validate event/property naming conventions
- User needs to audit data quality (duplicates, stale events, missing metadata)
- User asks about funnel design or event relationships
- Agent is generating event names or property names and needs to follow standards
- User wants to understand or improve their taxonomy governance
- User asks about reducing event volume or type counts
- User asks about deprecation, blocking, deleting, or hiding events
- Any agent needs a "source of truth" for taxonomy best practices before recommending events
- User asks about AI readiness, AI Controls, or improving AI feature accuracy

---

# Layer 1: Foundational Concepts

## Core Philosophy

Six principles govern all taxonomy work:

1. **Evidence-first. Never fabricate.** Every finding must be grounded in tool-retrieved data. If something cannot be verified, say so explicitly.
2. **Scan aggressively. Propose confidently. Confirm before writing.** Paginate autonomously through the full taxonomy. Form a prioritized, opinionated view of what needs fixing — then present it. Never call a write tool without explicit user confirmation.
3. **Be opinionated, not neutral.** Generic requests ("audit my taxonomy") are an invitation to lead. Use the scoring framework, recommend the highest-impact action first, and explain why. Don't present a menu of equal options.
4. **Surface critical issues proactively.** If you find something important while working on an adjacent task, raise it. Don't silently ignore a PII violation because the user only asked about naming conventions.
5. **Questions extract institutional knowledge.** Ask about business intent and real-world meaning, not Amplitude mechanics. One focused question at a time. The goal is to surface knowledge that lives in people's heads.
6. **Explain before acting.** Before calling any write tool, present exact proposed changes — including before/after state — and wait for explicit confirmation.

## Data Quality Lifecycle

All taxonomy governance follows a four-stage loop:

1. **Detect** — Scan systematically. Paginate through the full taxonomy. Score every finding. Surface issues with evidence before conclusions.
2. **Clarify** — Ask one focused question to capture semantic truth. Do not suggest actions yet. Seek understanding first.
3. **Resolve** — Apply metadata-only improvements. Guide humans through phased deprecation for structural changes. Never execute destructive actions unilaterally.
4. **Prevent** — Recommend conventions and governance habits that stop drift from recurring.

## Event Volume vs. Taxonomy Type Counts

These are **different problems** requiring **different solutions**:

- **Event volume** = total event instances ingested per billing period (how many times events fire). Properties do not count toward volume.
- **Taxonomy type counts** = number of distinct names across all schema dimensions (event types, event property types, user property types, group types, group property types). Each has its own limit.

**Billing models — know which applies before advising:**

- **Event volume billing**: customer has a contracted allocation of events per period. Exceeding it triggers overage costs. Flag significant event volume changes to these customers.
- **MTU billing**: customer is billed based on distinct users who trigger any event in a month. Per-user event counts matter less; total unique user count matters more.

**What customers usually mean:**

- "I need to reduce my event volume" → worried about billing (volume-billed customers)
- "I need to reduce my event types / schema count" → worried about hitting type limits (new types won't be queryable)

**What actually reduces each:**

| Goal              | Action                           | Reduces Volume? | Reduces Type Count? |
| ----------------- | -------------------------------- | :-------------: | :-----------------: |
| Reduce volume     | Block event                      |       Yes       |         No          |
| Reduce volume     | Delete event                     |       Yes       |         Yes         |
| Reduce type count | Delete event/property/group type |        —        |         Yes         |
| Reduce type count | Block event                      |       No        |       **No**        |
| Reduce type count | Hide event                       |       No        |       **No**        |

**Key rules:**

- Blocking and hiding do NOT reduce type count. A quota-constrained customer must delete, not block.
- **Never recommend sampling.** Sampling breaks funnel charts, journey paths, cohorts, downstream destinations, and Guides.
- Custom events and merged events simplify analysis but do NOT reduce raw event volume.
- When ambiguous, ask: "Are you trying to reduce how many events are being sent, or the number of different event and property types in your taxonomy?"

## Event States and Metadata Permissions

| Status     | Meaning                                           |            Can Edit Metadata?            |
| ---------- | ------------------------------------------------- | :--------------------------------------: |
| Planned    | In tracking plan; not yet instrumented            |                   Yes                    |
| Live       | Actively receiving data                           |                   Yes                    |
| Blocked    | Stops new ingestion; historical data accessible   |                   Yes                    |
| Unexpected | Receiving data but NOT in tracking plan           | **No** — must add to tracking plan first |
| Deleted    | Stops ingestion; removed from new-chart dropdowns |       **No** — must restore first        |

**Unexpected events have special restrictions.** No metadata can be updated until the event is added to the tracking plan. When you encounter Unexpected events:

- If they appear legitimate (real product actions, consistent volume): recommend adding to the tracking plan first, then apply metadata.
- If they appear invalid (single-day spikes, test strings, security scan artifacts): treat as a deprecation candidate through the standard safe deprecation process. Always distinguish "legitimate but undocumented" from "truly invalid" before recommending any action.

**Activity state is NOT a deprecation signal.** An event marked Inactive is behaving as intended.

**Actual deprecation signals:**

| Signal            | Interpretation                   |
| ----------------- | -------------------------------- |
| No recent volume  | Event has gone stale             |
| No recent queries | Event is unused                  |
| **Both together** | **Strong deprecation candidate** |

**Planned events:** Zero volume and queries are expected — evaluate by age, name collisions with Live events, and test-like names instead.

## Custom Events, Labeled Events, and Merged Events

None reduce event volume. Each has distinct behavior:

- **Custom events** (`ce:` prefix, type = custom): Logical combinations of underlying events for analysis convenience. The underlying events still exist and fire independently. Always check whether an event is used as the basis for a custom event before recommending its deletion — deleting the underlying event may break the custom event silently. Allowed: consolidate duplicate custom events with the same definition; improve naming, descriptions, categories, tags. Never claim that removing a custom event reduces event volume.
- **Labeled events** (`ce:` prefix, type = labeled): Designed for use with Autocapture, distinguished from custom events by a separate metadata flag. Adding/deleting does not impact volume.
- **Merged events** (Transform/Merge): Source events are no longer individually available for analysis after a merge. If the user needs to analyze combined events AND retain independent analysis of source events, recommend a **custom event** instead of a merge. Allowed: merge truly duplicated events that share the same semantics and where independent analysis is not needed. Never claim that merging reduces event volume.

## Protected Data Categories

**How to identify category from naming convention:** Events with bracket prefixes (`[...]`) follow a consistent pattern: if the text inside the brackets is a recognizable third-party product brand, it is an integration. If not, it is an Amplitude system event.

**Amplitude system events** (`[Amplitude]`, `[Guides-Surveys]`, `[Experiment]`, etc.): Critical to platform functionality. Do not recommend blocking, deleting, hiding, or modifying in response to generic cleanup.

**Integration-prefixed data** (`[Appboy]`, `[Adjust]`, `[Intercom]`, etc.): Can be cleaned up, but recommend turning off at the integration source first. Lower priority than native events.

**Experiment data:** Do not recommend TTLs or automatic deletion. Deleting breaks historical experiment interpretation.

## Interpreting Usage Signals

**Query count** reflects usage across user-created objects (charts, dashboards, notebooks, cohorts, metrics) but does NOT include AI tools, Chat, Global Agent, MCP, or Alerts. Zero-query is a strong signal to review, not a definitive signal to act.

**Three key patterns:**

| Pattern              | Definition                              | Action                                      |
| -------------------- | --------------------------------------- | ------------------------------------------- |
| Stale event          | Has ingested before, but volume stopped | Confirm with customer before deprecating    |
| Test event           | first seen = last seen, single day      | Strong deprecation candidate; confirm first |
| Firing but unqueried | Has volume, zero queries                | Flag for review, not immediate removal      |

**Safe to act on:** No volume for 6-12 months. Even if query activity exists, those queries return zero results.

## AI Readiness

Frame metadata and cleanup work as AI readiness improvements. Every AI feature selects events by evaluating the visible taxonomy — taxonomy quality directly determines AI output quality.

**Flag these as AI quality issues:**

- Cryptic event names with no description — AI cannot interpret them
- Clusters of duplicate/near-duplicate names — AI will guess incorrectly between them
- Implementation-focused descriptions (e.g., "fires when POST /purchase returns 200") — users ask behavioral questions, not backend questions
- Large numbers of deprecated events still visible — noise that increases wrong AI selection

**Event description structure (in order):**

1. Non-technical behavior definition — what the user did, in plain language
2. Trigger conditions — exact conditions, UI vs API, success-only or also failure, page/URL pattern
3. Disambiguation — how this differs from similarly-named events
4. Key use cases — if it's a funnel step, success metric, or key analysis input
5. Frequently used properties — 2-3 most commonly queried properties with brief context
6. Technical details (optional) — implementation notes, source system, endpoint

**Property descriptions:** Start with a clear definition, then include example values. Example: _"The category of the product the user viewed. Examples: 'electronics', 'apparel', 'home & garden'."_

**AI readiness at instrumentation time:**

- Choose clear, descriptive event and property names that don't require a display name to be interpretable. Do not recommend adding display names during instrumentation — they are only needed later when the raw name is already established and ambiguous.
- Write descriptions following the structure above: non-technical behavior definition → trigger conditions → disambiguation → key use cases → frequently used properties → optional technical details.
- For properties with coded values (SKUs, IDs, status codes): recommend creating lookup tables mapping codes to human-readable labels (available to Growth and Enterprise customers).

**AI Controls recommendations:**

- **Organization context** (10,000 char): company-wide standards, KPI definitions, standard terminology, global filters, fiscal calendar
- **Project context** (10,000 char): product-specific events/funnels, project-specific metrics, segment definitions
- Use audit findings to populate these recommendations. Recurring jargon or acronyms across multiple events belong in org/project context, not just individual descriptions. Consistent structural patterns (naming conventions, event groupings) are useful project context that helps AI interpret the taxonomy as a whole.

---

# Layer 2: Rules by Action Type

## When Reading and Analyzing (Always Safe)

Reading and analysis operations carry no risk — be autonomous and decisive. For tool usage
strategy and step-by-step procedures, see the Data Quality Audit procedure in the governance skill.

## When Writing or Updating Metadata

**Before/after confirmation required for all writes.** Never auto-apply. Only update confirmed items — do not extend to similar items based on pattern inference.

**Per-field defaults:**

- **Descriptions:** Do not remove existing content unless clearly erroneous. Append to or incorporate existing detail.
- **Categories:** Only set when empty. Suggest changing only if clearly incorrect or user requests it.
- **Tags:** Add only; never remove without explicit request.
- **Display names:** Follow the project's existing naming conventions.

**Restrictions:**

- Do not write to bracket-prefixed or vendor-prefixed events unless explicitly requested.
- Never write to Unexpected or Deleted events (must be added to plan / restored first).

**When writes fail due to permissions:**

- Explain that the user lacks write access.
- Provide read-only guidance on what could be done and why.
- Offer an "Ask an Admin to apply this" summary the user can share.

## When Recommending Cleanup or Deprecation

Deprecation must always follow a phased process. For the step-by-step procedure, see the governance skill's Deprecation Workflow.

**Never:**

- Present delete/hide/block as immediate one-step solutions
- Recommend sampling, TTLs, automatic deletion rules, or moving events between projects
- Recommend reconfiguring upstream integrations for volume control
- Skip dependency checks before recommending deprecation

## When Recommending New Instrumentation

### Event Naming Standards

**Format: `[Object] [Past-Tense Verb]` in Title Case**

| Good             | Bad                                              | Why                                                                                                        |
| ---------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `Song Played`    | `Play Song`                                      | Past tense = completed action                                                                              |
| `Form Submitted` | `Submit Form`                                    | Noun-first = scannable, sortable                                                                           |
| `Product Added`  | `product added`, `product_added`, `productAdded` | Amplitude treats different casings as separate events — always use Title Case, not snake_case or camelCase |

**Consistency is the top priority.** If an existing taxonomy uses a consistent convention that differs from the ideal, match the existing convention rather than introducing a new pattern.

**User perspective, not system perspective:**

- `Message Sent` (user sent) not `Message Delivered` (system delivered)
- `Purchase Completed` (user completed) not `Payment Processed` (system processed)

**Specificity balance — one event + properties, not many events:**

- **Good**: `Order Completed` with property `payment_method`
- **Bad**: `Credit Card Order Completed`, `Apple Pay Order Completed`

**Cross-platform consistency:** Same user action = same event name across Web, iOS, Android. Platform differences go in a `platform` property.

**One action = one event name.** No duplicates across the codebase.

**Autocapture-first:** Do not recommend custom events for anything already captured by Autocapture: `Page Viewed`, `Element Clicked`, `Element Changed`, `Form Started`, etc.

### Property Naming Standards

- **`snake_case`** for all property names
- **Descriptive and specific:** `payment_type` not `type`, `error_message` not `message`
- **Include units when ambiguous:** `video_duration_seconds`, `file_size_mb`, `price_usd`
- **Timestamp convention:** `[event_name]_at` (e.g., `product_added_at`)
- **Consistent across events:** Same property name for the same concept everywhere. `product_name` must be `product_name` on every event — not `name`, `prod_name`, etc.
- **Distinct names for distinct concepts:** `login_method` and `payment_method`, not generic `method` for both
- **Dot notation:** Means a nested object was passed (Amplitude creates it automatically). Don't use dot notation in property names directly unless intending nested objects. During audits, a cluster of dot notation properties is a cleanup signal — check which are actually being queried. If a significant portion are unused, recommend trimming the object at the source to reduce taxonomy noise.

### Property Type Standards

| Type           | Format                         | Example                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDs            | Always string                  | `"user_id": "12345"` not `12345`                                                                                                                                                                                                                                                                |
| Counts/amounts | Number                         | `"order_total": 59.99`                                                                                                                                                                                                                                                                          |
| Flags          | Boolean                        | `"is_premium": true`                                                                                                                                                                                                                                                                            |
| Timestamps     | ISO 8601 string                | `"2024-03-10T14:30:00Z"`                                                                                                                                                                                                                                                                        |
| Enums/status   | String                         | `"status": "In Progress"`                                                                                                                                                                                                                                                                       |
| Null handling  | Pick one approach per property | Omit, `null`, or sentinel string like `"Unknown"` — never mix. Using an explicit sentinel string lets you distinguish intentionally unavailable values from instrumentation bugs. Inconsistent null handling is one of the most common causes of incorrect property filters and broken funnels. |

### User Identification Standards

- **Anonymous users:** Set `device_id` only. Do NOT set `user_id`.
- **Authenticated users:** Set a unique, stable `user_id` per verified user. Never set before login/verification.
- **Server-side events:** Include a unique `insert_id` per event for deduplication (7-day window).
- **Sessions:** Use a consistent `session_id` within a session; for server-side, use the UNIX timestamp of the first session event.

### Structural Patterns

- **A/B experiments:** Track as list user properties, not events
- **Errors:** One `Error Encountered` event with `error_type`/`error_category` property
- **E-commerce:** Use `product_engagement` (items in this action) + `cart_contents` (full cart snapshot) arrays
- **B2B:** Instrument at least one group type (`org_id`, `account_id`)
- **Property consistency for funnels:** Capture the same property (e.g., `product_id`) across all events in a funnel

### Category Assignment

Use the Amplitude category metadata field — don't embed prefixes in event names. Common categories:

| Category    | Purpose                       | Examples                                                |
| ----------- | ----------------------------- | ------------------------------------------------------- |
| Lifecycle   | User journey milestones       | Signup Completed, Trial Started, Subscription Cancelled |
| Feature     | Core product functionality    | Task Created, Document Edited, Report Generated         |
| Engagement  | Navigation and UI interaction | Page Viewed, Button Clicked, Search Performed           |
| Transaction | Revenue events                | Purchase Completed, Checkout Started, Refund Requested  |
| System      | Technical health              | Error Occurred, API Request Completed, Timeout Occurred |
| Growth      | Acquisition and referral      | Invite Sent, Share Completed, Referral Reward Earned    |

**Assignment heuristics:**

- If an event represents a first-time or milestone user action (signup, first purchase, first invite), prefer **Lifecycle** over Feature or Transaction.
- If an event records a click or view that is not a core product action, prefer **Engagement** over Feature.
- Integration-sourced events (`[Appboy]`, `[Adjust]`, etc.) may not fit neatly — assign System or Growth based on the integration's purpose, or leave unassigned.
- When the correct category is ambiguous, ask the customer rather than guessing.

## Scoring and Prioritizing Issues

Three dimensions:

### 1. Issue Impact

| Level  | Points | Definition                                               | Examples                                           |
| ------ | ------ | -------------------------------------------------------- | -------------------------------------------------- |
| HIGH   | 3      | Name is ambiguous — analyst cannot reliably interpret it | Jargon, acronyms, blob words, confusable names     |
| MEDIUM | 2      | Name is interpretable but taxonomy is messier for it     | Convention outliers, unexpected events not on plan |
| LOW    | 1      | Name is clear; issue is missing polish                   | Missing description when name is self-explanatory  |

### 2. Event Importance

- **Query frequency:** 30/60/90/180-day counts — high-query events affect more analyses
- **Volume:** High-volume = more cost and risk
- **First seen:** Very recent = validate early before issues compound
- **Last seen:** Distant = staleness signal

### 3. Effort

- **Low:** Metadata-only changes (descriptions, display names, categories, tags, hiding)
- **Medium:** Requires stakeholder validation or dependency checks
- **High:** Requires codebase changes or integration reconfiguration

**Prioritization:** Lead with high-impact issues on high-importance events. Stale/test events are quick wins — surface them below real data quality problems.

**Health grade:** (Total Points Earned / Total Points Possible) x 100%

- 0-49%: Needs Improvement
- 50-79%: Meets Expectations
- 80-100%: Exceeds Expectations

## Authority Boundaries (Metadata-Only)

**Allowed (non-destructive, metadata-only, with user approval):**

- Update display names, descriptions, categories, tags
- Set official status
- Hide events (NOT block or delete)
- Set up Automated Tasks
- Add AI Context to project settings

**Not allowed:**

- Blocking, deleting, merging, or transforming events
- Block/Drop filters
- Modifying ingestion pipelines or upstream integrations
- Sampling strategies of any kind

---

# Layer 3: Detection Reference

## Detection Signals and Thresholds

Default lookback: **180 days**.

| Signal                                                      | Priority | Action                                         |
| ----------------------------------------------------------- | -------- | ---------------------------------------------- |
| Semantically unclear name                                   | HIGH     | Add display name + description                 |
| Missing description (unclear name)                          | HIGH     | Add description following AI readiness formula |
| Semantic duplicate (true — same meaning, different casing)  | HIGH     | Merge or disambiguate                          |
| Semantic duplicate (similar — different names, same action) | HIGH     | Investigate; merge or disambiguate             |
| Zero volume (180 days)                                      | MEDIUM   | Investigate before acting                      |
| Zero queries (180 days)                                     | MEDIUM   | Check asset dependencies first                 |
| Duplicate property across event + user scope                | MEDIUM   | Clarify correct source of truth                |
| Missing description (clear name)                            | LOW      | Add description; deprioritize                  |
| Missing category                                            | LOW      | Add category                                   |
| Naming convention outlier                                   | LOW      | Flag for future realignment                    |
| Unexpected event/property                                   | LOW      | Add to plan or block after review              |
| Stale (last seen beyond lookback)                           | LOW      | Quick win — schedule for deprecation           |
| Single-day (first seen = last seen)                         | LOW      | Quick win — likely test; verify first          |
| Test/QA artifact (`test_`, `debug_`, `tmp_`, `_qa`)         | LOW      | Quick win — standard deprecation process       |

**Exception:** When customer is near quota, Stale/Single-day/Test signals become elevated priority.

## Key Audit Metrics

| Metric                                                               | Impact             |
| -------------------------------------------------------------------- | ------------------ |
| % of types at quota limit                                            | HIGH when >90%     |
| New types added in last 7 days (spike = possible dynamic value leak) | HIGH if spike      |
| Total event volume change in last 7 days                             | HIGH if unexpected |
| Number of duplicate types by name                                    | HIGH               |
| Group types not instrumented (B2B products)                          | HIGH               |
| A/B experiments tracked as events instead of user properties         | MEDIUM             |
| Events with zero queries in 180 days                                 | MEDIUM             |
| Events with zero volume in 180 days                                  | MEDIUM             |
| Single-day events                                                    | MEDIUM             |
| % of live events with descriptions                                   | LOW                |
| % of live events with categories                                     | LOW                |
| Number of Unexpected events/properties                               | LOW                |
| Naming convention inconsistencies                                    | LOW                |

## Good vs. Bad Metadata Examples

**Display names:**

| Before               | After               |
| -------------------- | ------------------- |
| `catSelectClick`     | `Category Selected` |
| `pgVw`               | `Page Viewed`       |
| `ord_compl_v2`       | `Order Completed`   |
| `usr_prop_acct_tier` | `Account Tier`      |

**Descriptions:**

| Bad (implementation-focused)               | Good (intent + context)                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| "Fired on click handler for nav component" | "Triggered when a customer selects a product category from the navigation menu. Example categories: Electronics, Apparel, Home."        |
| "Event fired on submit"                    | "Triggered when a user completes checkout and confirms their order. Includes all line items, discounts applied, and final order total." |
| "See tracking plan"                        | "Fired the first time a new user completes onboarding by verifying their email. Fires once per user lifetime only."                     |

---

# Amplitude MCP capability selection

Inspect the connected public Amplitude MCP catalog at runtime. Tool names and
wrappers can change or be exposed differently during a rollout, so select
capabilities from their advertised descriptions and schemas instead of relying
on names recorded in this skill.

## Context and discovery

- Use the project-context capability to discover accessible project IDs and
  read the selected project's settings. Ask the user to choose when more than
  one project is available; never infer an ID from a project name.
- Use taxonomy search for event and property discovery when exposed; otherwise
  filter and paginate the active taxonomy reader. Use entity search for charts,
  dashboards, notebooks, experiments, cohorts, and saved content.
- Before any write, use the workspace or branch capability to inspect approval
  requirements, branch protection, permissions, and current branches.

## Taxonomy reads

- Prefer the consolidated taxonomy reader when the catalog exposes one. Use
  its advertised discriminator to select raw events, custom/labeled events,
  event properties, user properties, group properties, derived properties,
  lookups, channels, or persisted properties.
- If the catalog exposes separate event or property readers, use only their
  documented filters and pagination fields. Do not invent an alias or copy
  parameters from another reader.
- Resolve event and property names from returned taxonomy rows. Names are
  case-sensitive; do not substitute display names.
- Paginate exhaustive reads through every cursor. When the response reports a
  total, reconcile it with the accumulated rows; otherwise require the reader's
  documented terminal-cursor condition. A failed or partial page is not
  completion.
- Use the available transformation reader when auditing event/property merges,
  value mappings, or other cleaning rules.

## Metadata updates

- Select the event or property mutation capability only after verifying that
  its current schema supports the requested object type, metadata fields,
  branch selector, and scope.
- Read the exact current object first. Update only explicitly confirmed fields,
  preserve existing descriptions unless the user asks to replace them, and do
  not infer unsupported parameters from an older tool version.
- Event-property metadata can be global or scoped to one event. Use the
  schema's explicit scope control; never assume omission means global unless
  the current schema documents it.
- Custom/labeled event definitions are full replacements, not merges. Pass the
  complete verified definition and warn that renames can break references.
- Never update bracket-prefixed or vendor-prefixed system events unless the
  user explicitly requests it.
- Require explicit confirmation before any write and honor tracking-plan write
  permissions and branch protection.

---

# Workflows

For step-by-step execution procedures (data quality audits, governance analyses, event verification,
deprecation workflows, tracking plan generation, tool usage strategy), see the **governance** skill.
