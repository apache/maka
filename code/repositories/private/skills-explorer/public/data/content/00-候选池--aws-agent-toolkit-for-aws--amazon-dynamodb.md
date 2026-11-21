---
name: amazon-dynamodb
description: Designs, reviews, and debugs DynamoDB data layers from design axioms — enumerates access patterns, chooses partition/sort keys and GSIs, decides single-table vs. multi-table, configures Streams, Global Tables, TTL, vector indexes for similarity search, and zero-ETL integrations to OpenSearch/Redshift/SageMaker Lakehouse, and produces a defensible data-layer design with a monthly cost estimate and optional live validation. Applies whenever a user is designing, reviewing, or refactoring anything backed by DynamoDB — schemas, access patterns, GSIs, single- vs. multi-table choices, Streams consumers, transactional outboxes, Global Tables, zero-ETL pipelines, or storing embeddings and running semantic/vector similarity search with SearchVectors on items already in DynamoDB — even when they don't say "axioms" or "design review." Also applies when debugging hot partitions, throttling, unbounded Scans, LWW conflicts, or surprise bills on DynamoDB workloads.
version: 2
---

# DynamoDB Axioms

This document is a set of design axioms for DynamoDB applications. It is intended to be read by an agent with no other context about the application and used to produce a defensible data-layer design.

## Guardrail — where this skill's own files live (MCP vs local install)

This skill can be loaded two ways, and they resolve the skill's own bundled
files from different places. Determine how the skill was loaded before reading
a reference or running a script:

- **Loaded through the AWS MCP `retrieve_skill` tool:** The skill is not
  installed on the local filesystem. You MUST fetch each reference or script
  via `retrieve_skill` with the `file` parameter (e.g.
  `file="references/vector-search.md"` or `file="scripts/calculate_costs.py"`), and
  run the script from the returned content. Do NOT `file_read` these paths
  locally — they do not exist on disk.
- **Installed locally** (e.g. `.kiro/skills/amazon-dynamodb/` or
  `~/.claude/skills/amazon-dynamodb/`): Read and run files from the local skill
  directory using relative paths.

This distinction applies only to the skill's own packaged files. User data and
session artifacts are always read from and written to the user's working
directory. Never fetch or write customer data through `retrieve_skill`.

Separately from where these files live: this skill calls real AWS APIs when it
validates a design, deploys a scratch table or benchmarks one. **The AWS MCP
server is recommended for those AWS interactions where it is available** — it
gives consistent credential handling and region resolution across hosts. It is
**not required**: every script here uses boto3 and the AWS CLI against the
ambient credential chain, so the skill works unchanged when no MCP server is
present.

The `${SKILL_DIR}` resolution below applies to the **locally installed** case: over
MCP there is no directory to resolve, and the scripts this skill ships cannot be
executed from a returned string — so a cost estimate or live validation requires
the locally installed form.

## Resolving the skill's own paths

This skill is host-agnostic — it runs under Claude Code, Kiro, Codex, Cursor, a plain terminal, or CI. Where it lives on disk depends on the host (`~/.claude/skills/…`, `~/.kiro/…`, `~/.codex/…`, `~/.cursor/…`, a repo checkout, anywhere). The agent's working directory is the **user's project**, not the skill bundle, so relative paths like `scripts/calculate_costs.py` will not resolve. Throughout this document, `${SKILL_DIR}` means **the absolute path of the directory that contains this SKILL.md file** (the skill root, which holds `scripts/` and `references/`).

**Resolve `${SKILL_DIR}` once per session, then reuse it.** Pick the first method that works in your host:

1. **You already know it.** You loaded SKILL.md from a path — `${SKILL_DIR}` is the directory that file is in. This is the most reliable source; prefer it.
2. **An environment variable.** If `$DDB_SKILL_DIR` is set, trust it.
3. **The bundled resolver** (host-neutral, no host assumptions). It searches the common install roots _and_ verifies the hit against sentinel files, so it never returns the wrong directory silently:

   ```bash
   # If you already know the path to the script, just run it directly:
   #   SKILL_DIR="$(sh /path/to/amazon-dynamodb/scripts/find_skill_dir.sh)"
   # If you don't, this host-neutral one-liner searches the common roots
   # (~/.claude, ~/.kiro, ~/.codex, ~/.cursor, ~/.config, ~/.local/share, $PWD):
   SKILL_DIR="$(find "$HOME" "$PWD" -maxdepth 7 -type f -name SKILL.md -path '*amazon-dynamodb*' 2>/dev/null \
                | head -1 | xargs -I{} dirname {})"
   # Verify it before trusting it (sentinel check), then hand off to the resolver
   # for its loud-on-failure diagnostics:
   SKILL_DIR="$(sh "$SKILL_DIR/scripts/find_skill_dir.sh" 2>/dev/null || echo "$SKILL_DIR")"
   ```

   The resolver prints the verified skill root and exits 0, or prints nothing and exits non-zero with a fix-it message — so `SKILL_DIR="$(sh …/find_skill_dir.sh)"` is safe to trust when it succeeds. It is plain POSIX `sh`, so it behaves identically across hosts.

Once resolved, **export it so every later command is a clean substitution** and the scripts can also pick it up:

```bash
export DDB_SKILL_DIR="$SKILL_DIR"
python3 "$DDB_SKILL_DIR/scripts/calculate_costs.py" --model dynamodb_data_model.json --output cost_report.md
```

Internally the scripts locate their own siblings (other scripts, `scripts/benchmark_lambda.py`) relative to themselves, so you only ever need the **root** path — never each individual script path.

**Rules:**

- Always invoke scripts with an absolute path (the `$DDB_SKILL_DIR/…` form). Do **not** `cd` into the skill directory — the user's working directory must stay put so their artifacts (`dynamodb_data_model.json`, `cost_report.md`, …) land where they expect.
- If none of the three methods resolves the directory, **stop and ask the user where the skill is installed** rather than guessing. A wrong `${SKILL_DIR}` produces confusing "file not found" failures downstream; one clarifying question is cheaper.

## The pipeline at a glance

The skill is one tool per stage. **The default path touches no AWS: most work is stage 1 (a design you can discuss and refine conversationally).** Stage 2 (cost) runs on request or when the design is being finalized — not reflexively every turn. Stages 3–6 are a distinctly opt-in, heavyweight fork that creates real AWS resources and incurs a real bill; enter it only on explicit user agreement. Each stage's detailed contract is in the section named in the last column.

| #   | Stage     | Command (after `export DDB_SKILL_DIR=…`)                                                                                                                                                                         | Reads                                  | Writes                                          | AWS?                     | Section                  |
| --- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- | ------------------------ | ------------------------ |
| 1   | Design    | _(no script — you produce the access-pattern list + schema)_                                                                                                                                                     | —                                      | _(in-reply artifacts)_                          | no                       | _Artifacts to produce_   |
| 2   | Cost      | `python3 "$DDB_SKILL_DIR/scripts/calculate_costs.py" --model dynamodb_data_model.json --output cost_report.md`                                                                                                   | `dynamodb_data_model.json`             | `cost_report.md`                                | no                       | _Cost estimation_        |
| 3   | Deploy    | `python3 "$DDB_SKILL_DIR/scripts/deploy_model.py" --model dynamodb_data_model.json --config benchmark_config.json --manifest-out created_resources.json --yes-deploy`                                            | model + config                         | `created_resources.json`                        | **yes**                  | _Live validation_        |
| 4   | Benchmark | `python3 "$DDB_SKILL_DIR/scripts/benchmark_model.py" --model dynamodb_data_model.json --config benchmark_config.json --manifest created_resources.json --raw-out perf_raw.jsonl --summary-out perf_summary.json` | model + config + manifest              | `perf_raw.jsonl`, `perf_summary.json`           | **yes**                  | _Live validation_        |
| 5   | Report    | `python3 "$DDB_SKILL_DIR/scripts/generate_perf_report.py" --model dynamodb_data_model.json --summary perf_summary.json --output performance_report.md`                                                           | model + summary                        | `performance_report.md`, `design_findings.json` | no                       | _Live validation_        |
| 6   | Teardown  | `python3 "$DDB_SKILL_DIR/scripts/generate_teardown.py" --manifest created_resources.json --out teardown.sh` → review → `bash teardown.sh --confirm`                                                              | manifest                               | `teardown.sh`                                   | **yes** (on `--confirm`) | _Live validation_ step 6 |
| —   | Iterate   | `python3 "$DDB_SKILL_DIR/scripts/iterate_design.py" …` (wraps 3→4→5→cost as one human-driven round)                                                                                                              | model + config + loop-state + manifest | `loop_state.json` + the above                   | **yes** (gated)          | _Iterative design loop_  |

**Who reads what.** _You (the agent)_ read the compact artifacts: `cost_report.md`, `design_findings.json`, `loop_state.json`. _The user_ reads `performance_report.md`. Never read `perf_raw.jsonl` (large) — it only feeds stage 5.

**Consent gates.** Stage 3+ needs `--yes-deploy`; the benchmark refuses to spend over `cost_guardrail_usd` without `--allow-spend`; teardown needs the user's attested review **and** intent before you run `bash teardown.sh --confirm`. Details in _Live validation_.

**AWS access (MCP recommended, not required).** Stages 3–6 talk to AWS (create tables, a Lambda, an IAM role, then benchmark and tear down). For the best experience with AWS API calls the **AWS MCP server is recommended but not required** — every script here uses `boto3` directly and runs from a plain shell with standard AWS credentials (a profile, SSO, or environment credentials), so the skill works identically with or without the MCP server. Nothing in this skill assumes MCP-specific tools.

## How to use these axioms

1. **Read the reference architecture first** when the task is to design, review, or critique a full-app data layer (multi-entity schemas, multi-table layouts, end-to-end composition with streams/search/notifications). `${SKILL_DIR}/references/reference-architecture.md` is a complete multi-tenant kanban task-board ("TaskBoard") SaaS on AWS backed by DynamoDB, with all of the surrounding pieces (Cognito, CloudFront, HTTP API, Lambdas, Streams, OpenSearch, AppSync Events, SQS/EventBridge, cascades, idempotency middleware) worked out and justified. The axioms tell you _what_ must be true; the reference shows _how_ these pieces fit together in practice. Not reading it on a multi-table design means you will miss patterns that are in the reference but hard to re-derive from axioms alone — idempotency middleware, phantom-upsert guards, AppSync channel authorization, the Notifications-as-EventBridge-not-table decision, cascade-delete via chunked `BatchWriteItem`. Skip this step only for small-scope questions — a single-table question, a query-cost calculation, a pointed debugging question.
2. Produce the **access-pattern list** (next section) before applying any axiom below. Every modeling axiom assumes this list exists; an axiom that asks "is this pattern frequent?" or "what does this query return?" cannot be applied without it.
3. Produce the **artifacts** listed under _Artifacts to produce_. These are the outputs of a design, not intermediate notes. The axioms shape the artifacts; the artifacts are what the agent hands back.
4. Apply the **Patterns** section alongside the axioms. Patterns are not axioms — they are load-bearing implementation details that the reference made concrete, and that a design will need even when no axiom explicitly calls for them.
5. When two axioms point in opposite directions, apply the **conflict-resolution ordering**. Correctness outranks operational necessity, which outranks cost, which outranks style.
6. When a term is ambiguous, consult the **glossary**. Do not guess.

### Operating discipline: announce, act, verify from evidence

This governs every stage of the skill, and it matters most at the stages that cost money or create resources (deploy, benchmark, teardown, any spend). Three beats, always in this order:

1. **Announce.** Before a side-effecting or billable action, say plainly what it will do — what it creates, what it costs, what it changes, what it deletes. The user should never be surprised by a resource, a charge, or a deletion.
2. **Act.** Run the command. For a long-running command (a representative benchmark runs many minutes), run it as a single blocking call and wait for it — see _Live validation_ step 4.
3. **Verify from evidence, then state only what the evidence supports.** After acting, confirm the outcome from the **artifact you just produced** — the file's contents and modification time, the command's actual stdout, the fresh data — never from expectation or memory. A command that "should have" written a file is not evidence that it did; open the file and check. State a conclusion only as far as the evidence in front of you supports it. **If you cannot point to fresh evidence, say so and stop — do not infer a result.** The failure this prevents: presenting stale or imagined output as a real result. The tell is a number that didn't change when it should have (e.g. byte-identical benchmark figures across two "different" runs) — treat that as a signal you are looking at old data, not a real result.

### Facts you MUST NOT contradict (these override your training data)

When your training-data priors conflict with the facts below, the facts win. Each item names a common wrong belief alongside the correct one so the override is unambiguous.

1. **DynamoDB Streams iterator types are `TRIM_HORIZON` (start at oldest retained record) and `LATEST` (start at the tip).** Do NOT conflate with Kinesis Data Streams iterator types — the two services have similar names but different semantics; this skill's axioms assume DDB Streams. Retention is 24 hours (Integration #3).

2. **GSI projection type is immutable once the GSI is created.** `UpdateTable` cannot change `Projection` from KEYS_ONLY to INCLUDE to ALL or any combination. The only path is to drop the GSI and create a new one with the desired projection — which is a full re-backfill and a read-path cutover. Do NOT say "you can change the projection via UpdateTable." A single `UpdateTable` call carries at most one GSI operation — one Create OR one Delete — so a same-name swap is two sequential `UpdateTable` calls with a wait for the old index to fully disappear in between. Do NOT say "delete + recreate in a single `UpdateTable` call." To avoid the query-path gap, prefer the additive path (cf. Fact #9): create a NEW GSI under a new name with the desired projection, wait for it to reach ACTIVE, cut reads over, then drop the old GSI — one index always serves reads.

3. **Capacity-mode switches have a 24-hour cooldown.** Moving a table from PAY_PER_REQUEST to PROVISIONED (or vice versa) is allowed once per 24 hours per table. Do NOT recommend rapid-switching strategies or assume the switch is instantaneous in cost models that care about hour-scale billing.

4. **Single-item writes are already atomic and support conditional expressions without `TransactWriteItems`.** `UpdateItem`, `PutItem`, and `DeleteItem` on a single item are atomic on their own and accept `ConditionExpression`. Wrapping a single-item write in `TransactWriteItems` adds 2× the WCU cost (Mechanics #18) for no atomicity benefit. Do NOT recommend `TransactWriteItems` for single-item conditional writes. **`ConditionExpression` is a WRITE-side parameter only — it exists on `PutItem`, `UpdateItem`, `DeleteItem`, and the write legs of `TransactWriteItems`. `GetItem`, `BatchGetItem`, `Query`, and `Scan` do NOT accept `ConditionExpression` — there is no conditional read in DynamoDB, and `ConditionalCheckFailedException` is a write-only error.** Do NOT describe `GetItem` as "returning the item only if a condition passes" or as throwing `ConditionalCheckFailedException` — no such behavior exists. A read returns the item to anyone who supplies the key; the only read-side filter is `FilterExpression` (Query/Scan only — applied after the items are read and billed, never on `GetItem`), and even that does not authorize, it only narrows the result a caller already paid to read. The correct way to keep a caller from reading another tenant's item is to make the data unaddressable to them — partition-key the table on the authorization identifier (Data modeling #14) so a foreign key simply isn't in a partition the caller can reach — NOT to bolt a "conditional GetItem" on top.

5. **Maximum item size is 400 KB, hard cap.** The 1 MB limit is the `Query`/`Scan` response-page cap, not an item cap. Do NOT quote 1 MB as the item limit. Items near 400 KB also cost more per write (WRU = 1 per 1 KB rounded up, Mechanics #18), so large items are expensive even before the cap bites.

6. **`BatchGetItem` and `BatchWriteItem` are NOT atomic.** Partial failures are normal and returned via `UnprocessedKeys` (BatchGetItem) or `UnprocessedItems` (BatchWriteItem). The client must retry the unprocessed portion with exponential backoff. Do NOT describe batch operations as atomic or all-or-nothing — use `TransactWriteItems` when atomicity across multiple items is required (subject to Mechanics #14 bounds).

7. **Reserved Capacity applies to PROVISIONED capacity only, not to on-demand (PAY_PER_REQUEST).** Do NOT recommend Reserved Capacity for on-demand tables — there is no such product. On-demand savings come from usage-based discounts or table-class selection (Standard vs Standard-IA), not reservations.

8. **A failed `ConditionExpression` still consumes write capacity.** `ConditionalCheckFailedException` charges the same WCU as a successful write of the same shape. Do NOT claim that failed conditional writes are free or that the condition check happens "before" the write-cost is assessed. Plan cost models around expected failure rates (Mechanics #18 uses `conditional_fail_rate` for this reason).

9. **A GSI's key schema (partition key / sort key) is immutable once the GSI is created.** `UpdateTable` can add a new GSI or drop an existing one, but it cannot alter the KeySchema of an existing GSI. Re-keying an index — including write-sharding a hot GSI partition key by adding a hash suffix — is therefore an **additive migration**, not a code-only change: create a new GSI with the new key → let it populate → cut reads over → drop the old GSI. A _historical_ backfill is needed only when the new index must cover items that were already written and won't be touched again; a sparse or small in-flight index (e.g. one holding only active orders) populates from ongoing writes alone and needs no backfill. Do NOT describe a GSI key change as "just a code change" or "no schema migration."

10. **DynamoDB has native vector search. Semantic similarity does NOT require a second datastore.** A **vector index** is a third index type alongside GSIs and LSIs: declare it with the `VectorIndexes` parameter on `CreateTable` or the `VectorIndexUpdates` parameter on `UpdateTable`, store embeddings as a list of numbers on your items, and query it with the **`SearchVectors`** API (approximate nearest neighbour). Do NOT say DynamoDB cannot do vector or similarity search, and do NOT route a semantic-search requirement to OpenSearch, pgvector, or S3 Vectors by default — the vectors live on the same items as the operational data, with no replication pipeline (Integration #8 routes the workload types). `Query`, `Scan`, PartiQL and DAX do **not** work against a vector index; `Query` is rejected with `ValidationException: Query operation not supported on this index type.` A vector index is NOT a GSI and is NOT configured through one — there is no `VectorIndexConfig` and no vector block on a secondary index. Vector indexes require **on-demand capacity** (Mechanics #19).

    **DynamoDB does NOT recompute embeddings, and the index cannot fix a stale one.** The vector is ordinary item data: DynamoDB indexes the numbers you wrote and nothing more. Edit the source text and the stored embedding still describes the _old_ text, so it keeps matching the old meaning — indefinitely, with no error and no staleness signal anywhere. This is **not** index-propagation lag, and vector-index write propagation does not "close the window": no amount of waiting regenerates a vector. Whenever content behind an embedding is mutable, say so explicitly and give the fix — detect the content change and re-embed with the _same_ model, then write the new vector back (DynamoDB Streams into a re-embedding consumer is the usual shape; synchronous regeneration in the write path is also fine). Never imply the index refreshes vectors on its own.

    **`Dimensions`, `DistanceFunction`, `Projection` and `SearchSchema` are ALL immutable** — every one of them is fixed at `CreateTable`, not just the projection. Changing any single one means creating a replacement index and migrating; there is no in-place `UpdateTable` for them (Mechanics #7).

    **A stale SDK is not evidence the feature is missing.** The operations ship in **botocore/boto3 ≥ 1.43.64** and **AWS CLI v2 ≥ 2.36.16**. Below those versions they are absent from the client entirely — `aws dynamodb search-vectors` fails with `Found invalid choice` and `hasattr(client, "search_vectors")` is `False`. Testing for that `hasattr` is better than comparing version strings: it checks the capability directly and cannot go stale. If it is absent, tell the user to upgrade; do NOT conclude the feature does not exist. Full API surface, sharp edges and troubleshooting: `${SKILL_DIR}/references/vector-search.md`.

    **Quoted service limits are a design envelope, not a fact to argue with.** The per-table index count, maximum dimensions, `TopK` range and inline-filter count quoted in this skill are subject to change, and quotas of this kind generally rise. Design inside them, but before telling a user their design exceeds a limit, confirm the current value in AWS Service Quotas or the DynamoDB developer guide — a raised quota that this skill has not caught up with should not become a wrongly rejected design.

These ten facts are not the full axiom set — they are the subset where LLM prior is most likely to be wrong. When a user's question intersects one of them, state the correct fact plainly and move on; do not hedge with "I think" or "typically."

## The access-pattern list

Before touching a schema, enumerate every pattern the application must serve. For each pattern record:

- A one-line description of what the caller is asking for.
- Expected RPS (treat "unknown" as a design gap to close, per Mechanics #2).
- Items returned per call and approximate item size in KB.
- Consistency requirement (strong, eventual, or transactional).
- Authorization scope — the identifier that must be verified before the call is permitted (per Data modeling #14).

The list is a numbered, ranked table. The rest of this document assumes it exists. Any modeling decision that cannot be traced back to an entry on this list is unjustified.

## Per-entity operational-config inputs

> **This interview is required before proposing any table boundary.** Producing a full multi-table design first and then backfilling "here are the assumptions I made" is a workflow violation, not a shortcut. The per-entity questions below drive the table-splitting decision via Data modeling #3; when the answers are agent-assumed rather than user-stated, the signal fires spuriously and the design ends up over-fragmented (or under-fragmented if the agent guessed "no divergence" to keep things simple). Ask first, then design.

Before grouping entities into tables, gather operational-config requirements from the user per entity (or per logical aggregate — a parent and its tightly-bound children can share one answer set). Do not assume these defaults silently, because Data modeling #3 uses operational-config divergence as a signal to split tables — if the divergence is _agent-assumed_ rather than _user-stated_, the signal fires spuriously and the design ends up over-fragmented.

For each entity, ask:

- **Backup and recovery granularity.** Does this entity need PITR? If so, what retention (default 35 days, can be shorter)? Would this entity ever be restored independently of other entities, or always together with them? (Independent-restore requirements force table separation per Data modeling #5.)
- **Streams consumers.** Does any downstream system need change events for this entity — search indexing, analytics export, notifications, audit, CDC? Which stream view type (`NEW_AND_OLD_IMAGES` is the default per Integration #3)? A "no" here is a positive answer: no Streams consumer means Streams can stay disabled, which is cheaper and simpler.
- **Capacity mode.** Does this workload's shape justify provisioned (sustained, predictable traffic over months, per Mechanics #19), or does on-demand remain the default? "Unknown" means on-demand.
- **TTL.** Is there a per-item expiration attribute the application will set? If yes, the attribute is a Unix epoch second (per Patterns #3). If no, TTL stays off and items persist until deleted.
- **Encryption and IAM scope.** Any non-default requirement — customer-managed KMS key, specific IAM boundary, cross-account resource policy? Default is AWS-owned KMS and standard IAM; divergence is an explicit answer.

Treat these as design inputs on par with RPS. A missing answer is a gap to close, not a value to guess. If the user says "same across all entities," record that and **do not** treat the entities as operationally divergent — co-location by Data modeling #1 is then unobstructed. If the user states real divergence, Data modeling #3 fires on real divergence and the tables split.

## Per-entity attribute walkthrough (drives item size)

Item size is the second-largest driver of the cost estimate after RPS, and it's the place the estimate silently drifts worst. A Query declared as `20 items × 1,536 B` but really returning `20 × 512 B` triples the modeled cost against reality. Mechanics #2 says unknown RPS is a design gap; the same discipline applies to item size — an ungrounded guess for `estimated_item_size_bytes` is a design gap, not a safe default.

For each entity, before settling on a number, **walk the attribute list with the user**. Asking first is the preferred path; proceeding from inferred attributes is the fallback. Either way, the user has to see and sign off on the per-attribute breakdown before it becomes an input to the cost estimate — a silent fill-in is what makes item sizes drift 2–10×.

1. Propose an attribute list grounded in the domain. For a Waypoint, that's `waypoint_id`, `courier_id`, `lat`, `lng`, `recorded_at`. For a Contract, it's `firm_id`, `contract_id`, `title`, `status`, `body`, `created_by`, `created_at`, `updated_at`.
2. Per attribute, estimate bytes using these starting points:
   - IDs and short strings (ULIDs, UUIDs, slugs, enum values): **~40 B** each. The generic `S=100` heuristic in `cost-model-schema.md` is conservative for the free-tier storage path; for per-item size estimation, use realistic values.
   - Titles, display names, short descriptions: **100–300 B**.
   - Long-form content (contract body, message body, serialized JSON aggregates): ask the user explicitly. Do not guess 4 KB or 50 KB without confirmation.
   - Numeric attributes: **~8 B**.
   - Timestamps as ISO strings: **~25 B**. As epoch numbers: **~8 B**. (Mechanics #11.)
   - Boolean: **~1 B**. Map/List: **~200 B** per instance as a rough default, but ask if the user is storing a big blob inside a Map.
3. Ask the corrections the user will know and you won't: "Does this item carry any denormalized parent data per Mechanics #10?" "Is there a free-text field whose length varies widely?" "Are you storing the full document or a summary?" Update the estimates from the answers.
4. Sum the per-attribute estimates to derive the entity's `estimated_item_size_bytes`. For a Query that projects a subset (INCLUDE / KEYS_ONLY, or application-side projection), use a smaller number for the access-pattern's `estimated_item_size_bytes` — the bytes billed by DynamoDB are bytes actually read from the projected view, not the full item.
5. If the user is uncertain on a specific attribute, label that attribute as an assumption in the artifact (same discipline as unknown RPS). Do not silently pick a number.
6. **Surface the full list in your response — always, regardless of whether this is an interactive conversation or a one-shot prompt.** Emit a compact markdown table per entity with columns `attribute | type | bytes | source (user or guess)`. This is a reply-shape requirement, not a dialog gate. In one-shot settings where there will be no follow-up turn, the table still goes in the response so the user sees exactly what you assumed — the call-out is how they catch a 3× overshoot on a body field before it contaminates every cost number downstream. Label every uncertain estimate "guess" explicitly; do not smuggle a guess in as a user-supplied number. Explicitly invite correction: "These are my guesses where noted — please correct any that are wrong." Even when the user said "just pick reasonable values and go," emit the table.

Calibration: for the reference Contracts-app example in `cost-model-schema.md`, `Contract` is ~2 KB (not 50 KB — the 50 KB value is the worst-case body size, not the typical), and `Clause` is ~512 B. If a declared `estimated_item_size_bytes` is more than 2× the sum of the named attributes and the user hasn't explained the gap, you're guessing — revisit.

A run that skips this walkthrough can drift by 2–10× on individual patterns. The live-validation step (below) will surface that drift, but you shouldn't need live validation to get the cost estimate in the right order of magnitude.

## Artifacts to produce

> **Produce artifacts in the order listed below.** Schema + per-pattern plan are the primary outputs; cost estimate (item 7) and live validation (item 8) come **after** the design exists, not instead of it. A response that leads with a cost analysis and buries the schema in an appendix has the dependency backwards — the user asked for a design, and the cost is a property _of_ the design. The access-pattern list (item 1), schema (item 2), and per-pattern plan (item 3) must be visible and discussable in the reply **before** any cost numbers appear. Items 1–6 are the no-AWS design itself and are the default deliverable; item 7 (cost) is produced on request or at finalization (see _Cost estimation_); item 8 (live validation) is the opt-in AWS fork. Putting these artifacts only in `dynamodb_data_model.json` does not satisfy this — the user reads your prose, not the JSON. ❌ BAD reply shape (a real failure mode): a reply that opens "## Summary for the CFO — $1,019/month" with the schema living only in `dynamodb_data_model.json` on disk and the reply's only design content a trailing "artifacts produced" file list. ✅ GOOD: access-pattern list + per-table schema + per-pattern plan + per-entity byte table (per _Per-entity attribute walkthrough_ step 6) rendered in the reply, **then** the cost summary, **then** "`cost_report.md` written."

A complete design hands back:

1. **The access-pattern list** as above.
2. **A schema per table**: primary key (named per Data modeling #7), GSIs with their key attributes and projection type, and the operational configuration (Streams, PITR, TTL, capacity mode, Global Tables replication, encryption, IAM scope — all per Data modeling #3).
3. **A per-pattern plan**: for each access pattern in the list, the exact API call (`GetItem`, `Query`, or `BatchGetItem`, per Mechanics #16), the table or GSI it targets, the key conditions, the filter expressions if any, and the projected cost using the formulas in Mechanics #18.
4. **A fan-out topology**: for each table with Streams enabled, the consumers (Lambda, EventBridge Pipe, Kinesis shim), the filters at the source (Integration #4), and the on-failure destinations and retry bounds (Integration #5).
5. **A list of deviations and their justification**: any axiom or pattern not applied, with a stated reason.
6. **Idempotency and conditional-write guards**: which routes use idempotency-key middleware (Patterns #1), which `UpdateItem`s carry `attribute_exists` guards against phantom upserts (Patterns #2), and which `PutItem`s carry `attribute_not_exists` guards against double-creation.
7. **A monthly cost estimate** — produced **on request or at finalization**, not reflexively on every design turn. While the user is still exploring or refining the model, stay in design discussion and don't run the calculator each turn. Produce the estimate (via `${SKILL_DIR}/scripts/calculate_costs.py` — see _Cost estimation_ below) when the user asks what it costs, or when the design is being settled (they signal they're committing to it / taking it to review / want the numbers). When you do produce it, use the calculator — never inline arithmetic. Skip entirely for questions too narrow to have produced a full design (a single-query sizing, a debugging thread, a pointed mechanics question).

8. **A live validation** (optional, on offer, last step): after the cost estimate, ask the user whether they want to deploy this schema to an AWS account they nominate and measure real per-operation capacity, latency, and GSI amplification against live DynamoDB. If yes, follow _Live validation_ below. Skip for narrow questions, when the cost estimate was skipped, or when the user has no sandbox account. Unlike the cost estimate, this step creates real resources and incurs real charges, so both the offer and the consent must be explicit.

## Conflict-resolution ordering

When axioms point in opposite directions, apply in this priority order:

1. **Correctness** — authorization boundary alignment (Data modeling #14), consistency requirements, transactional atomicity, idempotency. A design that leaks data across tenants or serves stale data where strong consistency is required is wrong regardless of its other merits.
2. **Operational necessity** — divergent PITR, Streams, capacity, or replication configuration (Data modeling #3), recovery granularity (Data modeling #5), per-partition throughput ceilings (Mechanics #3), transaction bounds (Mechanics #14). These are physical or service constraints; preference does not override them.
3. **Cost and performance** — access-pattern co-location (Data modeling #1), dedicated GSIs (Data modeling #6), projection choice (Mechanics #7), cost formulas (Mechanics #18), capacity mode (Mechanics #19).
4. **Style and convention** — naming (Data modeling #7), single-table vs. multi-table framing (Data modeling #11) absent other signal. The cheapest to override when a higher-tier axiom disagrees.

Two concrete examples:

- Data modeling #1 (co-locate by shared access) vs. Data modeling #14 (partition by authorization boundary): #14 wins. If the natural access key and the authorization key differ, key on the authorization identifier and expose the alternate access via a GSI.
- Data modeling #1 (co-locate) vs. Data modeling #3 (split on divergent operational config): #3 wins. Two entities sharing a read pattern but requiring different PITR retention or Streams consumers belong in separate tables.

## Glossary

- **Access pattern** — a request the application makes against the data layer, described by its key conditions, items returned, frequency, and consistency requirement. The atomic unit of DynamoDB design.
- **Aggregate** — a cluster of entities that are read or written together. A single item, an item collection, or a set of items under different keys can each be an aggregate; the choice is the subject of Mechanics #1.
- **Item collection** — the set of items sharing a single partition-key value. Queries against an item collection are constant-partition and cheap; cross-partition reads are not.
- **Identifying relationship** — a data model in which a child entity is keyed by its parent's identifier plus its own. The child has no independent existence outside the parent.
- **Overloaded key** — a partition or sort key whose value encodes a type prefix (e.g. `USER#42`, `ORDER#42`) so that one physical key holds multiple logical entity types.
- **Sparse GSI** — a GSI whose indexed attribute is present on only a subset of base-table items, so the index projects only those items. Useful when an access pattern would otherwise filter out most items at read time. The same semantics apply to a vector index and are the mechanism behind **silent de-indexing**.
- **Vector index** — a third index type alongside GSIs and LSIs, holding vector embeddings from a named item attribute and read with `SearchVectors` rather than `Query`/`Scan`. Declared via `VectorIndexes` on `CreateTable` or `VectorIndexUpdates` on `UpdateTable`. On-demand capacity only; up to 5 per table.
- **ANN** (approximate nearest neighbour) — the search strategy a vector index uses. It trades exactness for speed, so results and their ordering can vary slightly between runs or Regions over identical data.
- **SearchSchema** — a vector index's optional schema, listing at most one `HASH` element (the vector index partition key, which scopes and scales each search and MUST be supplied on every call) and up to 18 `INLINE_FILTER` elements (optional equality filters applied at the storage layer). Fixed at creation. Every SearchSchema attribute must also appear in the table's `AttributeDefinitions`.
- **Distance function** — `COSINE`, `EUCLIDEAN` or `DOT_PRODUCT`, chosen at index creation and immutable. It determines both the `Score` and the sort order: lower is more similar for `COSINE`/`EUCLIDEAN`, higher for `DOT_PRODUCT`, whose scores can be negative.
- **Silent de-indexing** — an item written without the vector index's SearchSchema `HASH` attribute is accepted on the base table with no error but never replicated into the index, so it vanishes from `SearchVectors` results while `GetItem` still returns it intact. Expected behaviour, not a defect; see `${SKILL_DIR}/references/vector-search.md`.
- **VS / VWR** — Vector Search and Vector Write request units. Vector index capacity is metered in **bytes**, reported as `VectorSearchRequestBytes` and `VectorWriteRequestBytes`, separately from base-table RCU/WCU, with a 1 KB per-request minimum.
- **GSI write amplification** — the property that every write to a base-table item with projected GSI attributes produces one write per matching GSI, each billed in WCU.
- **LWW** (last-writer-wins) — the conflict resolution strategy used by standard Global Tables: the write with the newest timestamp wins; earlier writes are silently discarded.
- **MRSC** (Multi-Region Strong Consistency) — an opt-in Global Tables mode that provides strong consistency across replicas via consensus, at higher write latency and cost.
- **Hot partition** — a partition receiving traffic beyond the per-partition throughput ceiling (Mechanics #3), causing throttling even when table-level capacity is available.
- **Poison pill** — a record that a stream consumer cannot process successfully, which blocks forward progress on its shard until it is discarded, retried to exhaustion, or routed to an on-failure destination.
- **RCU / WCU** — read and write capacity units; the provisioned-mode spelling of the per-operation throughput unit. The formulas in Mechanics #18 are written in RCU/WCU and apply identically to on-demand.
- **RRU / WRU** — read and write _request_ units: the on-demand (PAY_PER_REQUEST) spelling of the same per-operation unit, billed per request rather than per provisioned capacity-second. One RRU = one RCU of work and one WRU = one WCU of work — the consumption math in Mechanics #18 is identical; only the billing dimension differs. The cost references (`cost-model-schema.md`) use RRU/WRU because the calculator prices on-demand; the axioms and the performance report use RCU/WCU. They are the same quantity — do not treat a model's RRU/WRU figure and the report's RCU/WCU figure as different things.

## Data modeling

1. Co-locate data by shared access pattern, not by domain. Two entities belong in the same table only when an application request fetches or writes them together. A shared business domain — "user data," "billing data" — is not sufficient justification. Co-location without a shared query introduces coupling and yields no performance benefit.

2. Treat table count as an output of the design, not a target. Do not optimize for one table, nor for one table per entity. The correct number of tables is whatever the access patterns produce. If the analysis surfaces three tables, ship three tables.

3. Treat table-level configuration as both a modeling input and an interface declaration. Streams, point-in-time recovery, TTL, capacity mode, attached Kinesis streams, Global Tables replicas, encryption, and IAM scope all apply at the table level — they declare how the table participates in the broader system. When two entities require different operational settings — different PITR retention, different stream consumers, different replication regions, different capacity modes — that divergence is a primary signal that they belong in separate tables, not a secondary concern to be reconciled later.

4. DynamoDB Streams provide two concurrent consumers, no native per-entity filtering, and a 24-hour retention window. These properties constrain downstream architecture as firmly as the key schema does. Decide the fan-out topology before finalizing table layout.

5. Design for recovery granularity. Point-in-time recovery operates at the table level; partial restores are not supported. If two entities would never be recovered together, they should not share a table. The cost of an incident scales with the volume of unrelated data the restore has to carry.

6. Prefer additional GSIs to overloaded keys. The constraints that historically motivated index overloading — a low per-table GSI ceiling, per-index provisioned capacity, and no on-demand mode — generally do not apply to modern DynamoDB, which supports many GSIs per table with shared capacity and on-demand billing (consult the current AWS service-quota docs for the exact per-table GSI limit). Choose a dedicated GSI per access pattern unless a specific, measured reason argues otherwise.

   **Vector indexes are scarcer and serialize with GSIs.** A table supports at most **5** vector indexes, against a far higher GSI allowance, so budget them deliberately rather than adding one per query shape. More importantly, only **one** online index operation — create or delete — runs at a time per table, and that limit is **shared between GSIs and vector indexes**. Two `Create` actions in a single `UpdateTable` fail with `LimitExceededException: Subscriber limit exceeded: Only 1 online index can be created or deleted simultaneously per table`. Sequence index work one at a time, and note this makes any vector index migration (Mechanics #7) slow, because each new index must finish backfilling before the next can start.

7. Name keys for what they represent. Use `customer_id`, `order_created_at`, and `OrdersByCustomer` rather than `PK`, `SK`, and `GSI1`. Self-describing keys reduce onboarding time, make code reviewable without a schema reference, and let tooling introspect the model. Reserve generic overloaded keys for genuinely polymorphic hierarchies.

8. Pre-join only entities that are read together in a single request. Item collections exist to satisfy one-shot queries such as "fetch parent with all children." If no access pattern reads two entities together, do not store them together. A pre-join without a corresponding read is coupling without benefit.

9. Default to not sharing tables across service boundaries. A table shared between services forces teams to coordinate GSI allocation, key conventions, and schema changes. That coordination cost compounds as the table grows. Service ownership should imply table ownership.

10. Plan for the model to change. Access patterns evolve. A table layout that requires a multi-table refactor to accommodate a new pattern is a liability. Prefer designs in which adding or modifying an access pattern is a localized change to a single table instead of changing the full data access layer.

11. Apply single-table design as a tactic, not a default. Single-table design is appropriate for tightly bound parent-child hierarchies with predictable joint access — orders and line items, tenants and sub-resources. It is not appropriate as a global rule. The pattern's value is local; applying it globally produces the operational problems documented in production post-mortems.

12. Move analytical workloads off the operational table. DynamoDB is an OLTP store. SQL-shaped queries, full-table aggregations, and ad-hoc BI belong in a downstream system populated by export or zero-ETL integrations. Do not reshape the operational table to serve analytics.

13. Design around last-writer-wins in standard Global Tables, or opt into Multi-Region Strong Consistency (MRSC) when the domain cannot tolerate it. Standard Global Tables provide multi-region active-active replication with eventual consistency and last-writer-wins conflict resolution — they are not CRDTs. Domains that cannot tolerate LWW — inventory, balances, counters — have two options: application-level conflict avoidance (region-pinned writes, shard partitioning, conditional updates), or MRSC, an opt-in mode that provides strongly consistent reads and writes across a designated replica set via a consensus protocol. MRSC requires a three-region topology (two active replicas plus a witness), carries higher write latency and cost, and is configured per table. Cross-account replicas are supported in both modes and inherit the same consistency semantics — account boundaries are an IAM and ownership surface, not a consistency one. The choice between standard Global Tables and MRSC is a modeling decision: it determines what domains the table can host.

    A special case: a single hot item under contention — a flash-sale stock decrement where thousands of buyers converge on one SKU. Here the problem is throughput, not just consistency: writes to one item serialize internally, so you hit elevated latency and the per-partition WCU ceiling (Mechanics #3) before the partition's raw budget, and every failed conditional decrement still burns WCU (Fact #8). Region-pinning a single item does NOT help — it pins the contention to one region without removing it. The fix is a sharded counter: split the quantity across N sibling items (`sku#shard0`..`sku#shardN` as the partition key so they spread across partitions), decrement a random shard under a `> 0` condition, retry another shard on failure, and scatter-read all shards to sum — sized to undersell rather than oversell (each shard enforces its own floor). Note this IS write-sharding the partition key (Mechanics #3), applied to sibling counter items; it is the contention fix, not a contradiction of it. Region-pinning and per-item conflict avoidance remain right for high-cardinality, low-per-item-contention data (per-account balances, where each user is their own partition key and contention is ~1), not for one contended row.

14. Align the partition key with the authorization or tenancy boundary. The identifier you verify before permitting a read or write — `tenant_id`, `account_id`, `board_id`, whatever scopes the caller's access — should be the partition key of every table holding data under that scope. When authorization and lookup share a partition, a query against a partition the caller cannot prove access to simply returns nothing; when they diverge, a caller can pass a foreign child identifier and reach data across the authorization boundary (IDOR). Data that legitimately crosses tenants belongs in a separate table with its own access rules, not as a compromise on the main one.

    On any design review — and first of all when the user asks what the _security_ problem is — evaluating whether the partition key aligns with the authorization/tenancy boundary is the FIRST check to make and to state, ahead of hot-partition, projection, or cost findings (per _Conflict-resolution ordering_, correctness outranks cost). The canonical hole: a partition key set to a client-supplied identifier (a `review_id`/`order_id` from the URL) instead of the server-derived authorization identifier (`user_id`, `tenant_id`, `account_id`) — that is IDOR. If the design is already aligned, say so and move on; if it diverges, lead with it and do NOT downgrade it to "add a `ConditionExpression`" — a per-call check is discipline, not a structural fix. When you explain _why_ a `ConditionExpression` is not the fix, get the mechanism right: a write-side condition is opt-in (one forgotten call path = IDOR) and it does **not** cover reads at all — but the reason it does not cover reads is that **`GetItem`/`Query` take no `ConditionExpression` in the first place** (Fact #4), NOT that a "conditional GetItem returns the item / throws `ConditionalCheckFailedException` anyway." Do not invent a read-side condition mechanism to argue against it. The structural fix is the key schema (the foreign key is unaddressable), and reads stay safe because the caller cannot name a partition they don't own — state it that way.

## Integration

1. Ensure Streams consumers are idempotent or deduplicated by event identifier. DynamoDB Streams deliver at-least-once — handlers will see the same record twice after a Lambda timeout, a batch retry, or replay during an incident, and must produce the same outcome whether invoked once or many times.

   Two strategies are viable:
   - **Idempotent handler**: structure the operation so repeating it is a no-op. Conditional writes, set-based mutations (`ADD` to a set), and idempotency tokens on downstream APIs all qualify.
   - **Explicit dedupe**: record the `eventID` from the stream record in a dedupe store (a DynamoDB table with TTL is the usual choice) and skip records already present.

   Example (dedupe by `eventID`, TTL bounded to the redelivery window):

   ```python
   def handler(event, context):
       for record in event["Records"]:
           try:
               dedupe_table.put_item(
                   Item={"event_id": record["eventID"], "ttl": int(time.time()) + 86400},
                   ConditionExpression="attribute_not_exists(event_id)",
               )
           except ClientError as e:
               if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                   continue  # already processed
               raise
           process(record)
   ```

   Dedupe on `eventID`, not on application identifiers like `order_id` — the same aggregate legitimately produces many events, and keying on the business identifier will drop valid change records.

2. Use the transactional outbox pattern for reliable event publication. Write the state change and an outbox record in a single `TransactWriteItems` call; have a downstream consumer read the outbox via Streams and publish the event. This eliminates the "updated but did not emit" failure mode without resorting to two-phase commit.

3. Default the stream view to `NEW_AND_OLD_IMAGES`. Zero-ETL integrations with OpenSearch, most change-data-capture consumers, and any logic that depends on diffs all require both images.

4. Filter events at the source, not in the handler. Source-side filtering has **two mechanisms — mention both when diagnosing or proposing a fix**:

   - **Lambda Event Source Mapping `FilterCriteria`** — filters stream records _before_ Lambda invocation. A handler that previously ran on 10M events/day but cares about 500k of them becomes a handler that runs 500k times, billed for 500k invocations instead of 10M. Filter shape (JSON pattern matching against the DynamoDB stream record): `{"dynamodb": {"NewImage": {"status": {"S": ["shipped", "delivered"]}}}}`.
   - **EventBridge Pipes filters** — the same source-side discarding, applied when the Pipe is the consumer. Use Pipes when the fan-out crosses multiple downstream targets (an event → Lambda + SQS + EventBridge bus), since the 2-concurrent-consumer limit on Streams (Data modeling #4) makes Pipes the common path for >2-consumer topologies.

   Both mechanisms eliminate invocation cost AND the work the handler would have done filtering. Inline filter logic inside the handler pays full invocation cost for every discarded event — a filter that drops 95% of traffic means 95% of invocations are pure waste. If the question is about source-side filtering, the answer names both mechanisms and routes the recommendation to the one that fits the consumer topology.

5. Treat Event Source Mapping configuration as a reliability surface. `BatchSize`, `MaximumBatchingWindowInSeconds`, `ParallelizationFactor`, `MaximumRetryAttempts`, `MaximumRecordAgeInSeconds`, `BisectBatchOnFunctionError`, and on-failure destinations together define delivery semantics. Several defaults are actively dangerous: `MaximumRetryAttempts` and `MaximumRecordAgeInSeconds` both default to `-1`, meaning a single unprocessable record will block its shard for the full 24-hour stream retention and then disappear silently. Bound retries, bound record age, and configure an on-failure destination so poison records are quarantined rather than stalling the shard or vanishing. Leaving any of these at defaults is a deliberate choice, not a neutral one.

6. Treat stream enablement as a durable interface commitment. Disabling a stream and re-enabling it produces a new stream ARN. Any Lambda Event Source Mapping or EventBridge Pipe bound to the old ARN becomes orphaned. Stream lifecycle is part of the table's public contract and should be managed accordingly.

7. Distinguish TTL-driven deletes from user-driven deletes. DynamoDB delivers TTL deletions through Streams with `userIdentity.principalId` set to `dynamodb.amazonaws.com`. Consumers should branch on this attribute to route TTL events separately — typically to archival or audit pipelines — rather than treating them as ordinary user deletes.

8. Match the analytical or search workload to the right target; do not reshape the operational table to serve either. DynamoDB is an OLTP store for _analytical_ workloads, and the supported path to a read-optimized system is a managed integration, not a `Scan` and not a bespoke GSI. **Semantic similarity is the exception and stays in DynamoDB** (Fact #10). Route by workload type:

   - **Semantic similarity — "find similar", "more like this", RAG retrieval, recommendations, AI-agent memory, embedding-based anomaly detection** → a **vector index on the DynamoDB table itself**, queried with `SearchVectors`. No second datastore, no replication pipeline, no PITR prerequisite. This is the default for anything expressed as similarity over embeddings. See `${SKILL_DIR}/references/vector-search.md`.
   - **Full-text, keyword, typo-tolerant or fuzzy matching, faceting, aggregations, geospatial/radius search** → zero-ETL to Amazon OpenSearch Service. Initial load from a PITR snapshot, ongoing change capture via DynamoDB Streams, near real-time freshness (seconds). Requires PITR enabled on the source and Streams enabled with `NEW_AND_OLD_IMAGES`.
   - **SQL analytics, BI, materialized views, data sharing** → zero-ETL to Amazon Redshift. Initial load from a PITR export, ongoing change capture via incremental exports every 15–30 minutes. Requires PITR enabled on the source and KMS configured with an AWS-owned or customer-managed key (AWS-managed KMS is not supported).
   - **Open-format data lake, Apache Iceberg, multi-engine analytics (Athena, EMR, Spark, Redshift), or ML feature stores** → zero-ETL to Amazon SageMaker Lakehouse. Glue-orchestrated initial export plus incremental exports that write Iceberg tables to S3 or S3 Tables, typically 15–30 minutes fresh. Requires PITR enabled and a resource-based policy granting Glue the export actions.
   - **Point-in-time batch dump with custom downstream processing and no freshness requirement** → DynamoDB export to S3 (not branded zero-ETL, but the correct fallback when no zero-ETL target fits). Consumes no RCU.

   In every zero-ETL path above, PITR on the source table is a hard prerequisite — this does NOT apply to the vector-index path, which is not an integration. Do not approximate search with `begins_with` queries and bespoke GSIs. Do not scan the operational table for analytics. The integrations exist because these workloads compose with a column store, a search engine, or an Iceberg table and do not compose with a NoSQL key-value store.

   **Split a bundled ask; do not send it all to one place.** A request for "search" often bundles several kinds. Semantic similarity goes to a vector index; lexical, fuzzy and geo go to OpenSearch; SQL goes to Redshift. A workload legitimately needing both semantic and full-text search uses both a vector index and OpenSearch. Two directions are both wrong: routing semantic similarity out to OpenSearch by reflex, and routing typo-tolerant keyword or geo-radius search _into_ a vector index. ANN over embeddings does no substring, prefix or edit-distance matching.

   When one operational table feeds BOTH the Redshift (SQL/BI) and SageMaker Lakehouse (Iceberg) paths, prefer a single DynamoDB→Lakehouse Iceberg export and have Redshift read the same Iceberg tables (Redshift Spectrum / native Iceberg support) rather than running two parallel zero-ETL integrations — this avoids a second incremental export and the duplicate per-GB charge with no loss of SQL/join capability. Use two separate integrations only when the consumers genuinely need divergent freshness or isolation.

## Mechanics

1. Select aggregate tightness by weighing how often entities are read together against how often they are written independently. Three options — embed children in a single item, group them as an item collection under a shared partition key, or store them as separate aggregates — sit on a spectrum of how tightly parent and children are bound. No single threshold governs the choice. A high read correlation argues for co-location, but a write-heavy workload with large items pushes the opposite direction, since every update rewrites the full item. Item size and whether the child count is bounded matter as much as access frequency. Rule of thumb: if order line items are fetched with orders most of the time and the line count is bounded, consider embedding or an item collection with the order as the parent; if individual line items receive frequent updates in isolation, keep them separate so each write does not rewrite the whole parent. Selecting the wrong tier is the underlying mistake behind most "single-table design gone wrong" stories.

2. Document RPS for every access pattern. Without a request rate, you cannot size partitions, choose between on-demand and provisioned capacity, or justify a GSI. An estimate grounded in business context is sufficient; an absent rate is not. Treat "unknown" as a design gap to be closed.

3. Respect the per-partition throughput ceilings. A single partition supports up to 1,000 write capacity units and 3,000 read capacity units per second. Workloads that exceed these limits must shard the partition key — typically with a hash suffix for write-heavy traffic or a time bucket for sequential keys.

4. Base-table key schemas allow exactly one `HASH` and at most one `RANGE`. When a base table requires a composite key, encode it as a concatenated string with a stable delimiter, such as `tenant_id#user_id`. GSIs support **native multi-attribute keys** — up to four attributes for the partition key and up to four for the sort key — with DynamoDB hashing the PK attributes together for distribution. Prefer native multi-attribute GSI keys over synthetic concatenated keys: items are written with natural attributes from the domain model, client code does not concatenate or parse, and adding a new multi-attribute GSI to an existing table requires no backfill of synthetic attributes. Use synthetic concatenated keys only when the number of components exceeds four or when an older table is already committed to the pattern.

5. Multi-attribute GSI keys have strict query rules. On the partition-key side, every PK attribute must be constrained with equality — a GSI with PK (`tenant_id`, `region`) cannot be queried by `tenant_id` alone, and inequality operators are not allowed on any PK attribute. On the sort-key side, attributes must be constrained left-to-right in the order they are defined; a middle attribute cannot be skipped. Equality conditions must precede any inequality, and only one inequality is allowed — it must be the final condition in the key condition expression. `BETWEEN`, `>`, `<`, `>=`, `<=`, and `begins_with` all count as inequality. Violating these rules is the most common reason a GSI fails to satisfy its intended access pattern.

6. Consider a sparse GSI when 50% or more of items would be filtered out. Indexing the presence of an attribute is materially cheaper than indexing all items and filtering at read time. Sparse indexes also reduce write amplification, since only items carrying the indexed attribute are projected.

7. Project only the attributes the access pattern reads. An `ALL` projection roughly doubles storage cost and write amplification for every base-table update. Use `ALL` if read latency is important, or if your application is read heavy in comparison to writes. If item sizes are large or the table is write heavy, use `INCLUDE`, and if latency warrants it, use `KEYS_ONLY` with a reverse table lookup.

   **On a vector index, projection is a hard read boundary and it is immutable.** `SearchVectors` cannot return an attribute that is not projected into the index, and asking for one is **silently ignored** — no error, the attribute is simply absent from the result. The projection cannot be changed after creation, so under-projecting means either creating a replacement index and migrating (an additive migration, cf. Fact #9) or hydrating the missing attributes from the base table with `GetItem`/`BatchGetItem` after the search. **And it is not only the projection: `Dimensions`, `DistanceFunction` and `SearchSchema` are equally immutable.** So "switch this index to COSINE" or "add a partition key to the search schema" is a new-index migration too, never an `UpdateTable` — when a debugging thread lands on the wrong distance function, say that explicitly rather than describing only the projection case. Note also that the vector attribute itself is excluded from results by default even under `ALL`, since vector data is large — request it explicitly with `ProjectionExpression` only if you actually need it back.

8. Avoid using mutable attributes as GSI keys. DynamoDB implements a key-attribute change as a delete followed by an insert in the index, doubling the write cost for that update. Fields that change frequently should not appear as GSI partition or sort keys.

9. Use identifying relationships when child access is dominantly in the context of the parent. When a child entity cannot exist independently of its parent, and fetches or updates of children typically carry the parent identifier, model the relationship on the base table with the parent identifier as the partition key and the child identifier as the sort key. This removes a GSI for the "list children by parent" pattern and typically halves write cost by eliminating the associated index amplification. The exception is a hot path that updates a single child by its own id without the parent — a webhook scoped to a line item, for example. `UpdateItem` requires the full primary key, so if callers routinely arrive with only `order_item_id`, the identifying-relationship schema forces a GSI lookup to resolve `order_id` on every write, negating the savings. In that case, invert: key the child by its own id and carry the parent on a GSI. The right shape follows the hot access pattern, not a style preference.

10. Restrict denormalization to attributes that rarely change. Short-circuit copies — a user's display name on an order, a product SKU on a line item — are safe and eliminate additional reads. Copying mutable attributes turns every update into a multi-item fan-out and quickly outweighs the read benefit.

11. Choose temporal encoding based on required sort behavior. Strings sort lexicographically; `"10"` precedes `"2"`. Use ISO 8601 timestamps when natural string sort is desirable and human readability matters. Use Unix epoch numbers when compactness, arithmetic, or precision matters. Do not mix encodings within a table. **When a key attribute (a table or GSI partition/sort key) is a number — an epoch timestamp, a numeric id — or binary, you MUST declare its type in the data model so the live deploy creates it correctly.** DynamoDB types only key attributes, and it enforces that type at write time: a key left undeclared deploys as string (`S`), and the first real integer/binary write then fails with `ValidationException` — in production, not in the benchmark (the seed may pass while live writes fail). Declare the type in `entities[].attributes[]` as `{"name": "order_date", "type": "N"}`, or table-level in `attribute_definitions` as `{"attribute_name": "order_date", "attribute_type": "N"}` (both spellings are read by the deploy and the benchmark; an `attribute_definitions` entry wins on conflict). See `${SKILL_DIR}/references/cost-model-schema.md`.

12. Do not rely on TTL for time-sensitive expiration. TTL deletions are eventual — the background sweeper runs on a best-effort schedule and expired items can remain visible for hours, in practice up to ~48 hours past the TTL timestamp, until the sweeper removes them. TTL is appropriate for storage reclamation and cleanup; it is not appropriate for security-sensitive expirations such as sessions, tokens, entitlements, or real-time event triggers.

    Two consequences follow:

    - **Filter on reads.** Because an item can outlive its TTL until the sweeper runs, every read path that cares about expiration must check the TTL attribute itself — `FilterExpression` of `#ttl > :now`, or an application-side check. Do not assume an item returned by DynamoDB is logically current.
    - **Pair with EventBridge Scheduler when timing matters.** If a workload needs a precise action at expiration — revoke a session, fire a reminder, release a lock — create a one-time EventBridge Scheduler invocation at write time for the exact timestamp, and let that invocation do the work. TTL handles eventual cleanup; the scheduler handles the time-sensitive trigger. Streams can then propagate the actual TTL deletion to archival or audit (see Integration #7), but Streams is not the timing mechanism.

    The TTL attribute must be a Unix epoch value in seconds, not milliseconds.

13. Enforce uniqueness with transactions, not application logic. Create a sibling lookup item — for example, `UNIQUE#email#user@example.com` — and write it together with the entity in a single `TransactWriteItems` call. A check-then-write sequence in application code has a race window; the transaction does not.

14. Work within transaction bounds. `TransactWriteItems` is bounded by **three hard limits — always state all three when the question is about transaction bounds, never just one or two.** The bounds are independent; exceeding any single one rejects the transaction:

    - **100 items** per transaction — total item count across the array.
    - **4 MB** total payload — combined size of all items in the transaction. Do NOT omit this bound or fold it into the 100-item bullet; a transaction with 10 items at 500 KB each passes the 100-item bound but fails the 4 MB bound. The payload cap is 4 MB exactly — not 16 MB (that's `BatchGetItem`), not 1 MB (that's `Query`/`Scan` page cap), not 400 KB (that's max item size).
    - **Single region** — a transaction executes in one region only; it does NOT span Global Tables replicas. If callers in different regions need to participate in the same transaction, standard Global Tables is the wrong consistency model for the workload (use MRSC or restructure so each transaction is region-local).

    Operations that routinely exceed these limits indicate an aggregate boundary that is too coarse, not a database limitation to be worked around. When an import or bulk operation crosses the 100-item boundary, batch it into multiple transactions and handle partial-failure recovery explicitly (a job id, checkpointed progress, idempotent retry of each chunk).

    **Count items, not records, against the 100-item bound.** When one logical record requires multiple DynamoDB items — a contact plus a uniqueness sentinel per Mechanics #13 plus a counter increment — every item in the `TransactWriteItems` array counts. 3 items per contact means ~30–33 contacts fit per transaction, not 100. The 4 MB payload bound imposes a second ceiling independently; for records near 30 KB each, the 4 MB cap bites before the 100-item cap. Plan the chunk size against both bounds and pick the smaller.

    **Bulk imports over the 100-item boundary are background jobs, not synchronous API calls.** A loop of `TransactWriteItems` that pages through tens of thousands of records will exceed any reasonable request timeout (API Gateway 30s, Lambda 15min ceiling, browser request timeouts). Model the operation as a durable job: accept the request, enqueue a job record, drive the chunked execution from a worker (Step Functions, SQS + Lambda, batch job) with checkpointed progress so restart resumes mid-run, and report completion asynchronously. Do not treat "chunked transactions" as if they compose into a single synchronous operation.

15. Default to eventually consistent reads. Strongly consistent reads cost twice as many RCU. Use them only at boundaries that require read-your-writes semantics; do not adopt them as a global default.

    When a caller updates an item and immediately needs the fresh value, prefer `ReturnValues=ALL_NEW` on the `UpdateItem` (or `ALL_OLD` / `UPDATED_NEW` / `UPDATED_OLD` variants as fit) over a follow-up read. The write returns the post-update item as part of its response at **no extra RCU cost** and with no consistency concerns — the write's return payload is authoritative by construction. A strongly-consistent `GetItem` after an `UpdateItem` pays 1 RCU and a second round-trip for information that was already available for free. This is the cheapest read-your-writes shape on DynamoDB.

16. Resolve every access pattern to `GetItem`, `Query`, or `BatchGetItem`. `Scan` is appropriate for administrative operations, not for application read paths. A production access pattern that requires a scan reflects a modeling gap, not an acceptable query choice.

17. Constrain every query. Specify sort-key ranges or filter conditions, compute expected page sizes, and paginate with `LastEvaluatedKey`. The constraint can come from the key structure itself — a parent partition that holds a bounded number of children (line items under one order, members of one team) is already constrained, and "return all under this parent" is a valid access pattern against it. What is not an access pattern is a query whose result size grows without bound as the dataset grows — "all orders for a customer" over years, "all events in a log" — with no range, no page target, and no termination condition. An unbounded result set over a growing collection is a design gap, not a query choice.

18. Compute the cost of each access pattern. Read pricing depends on the API:

    - **GetItem / BatchGetItem**: bills per item returned, rounded up to 4 KB. Eventually consistent (default) = 0.5 RCU per 4 KB per item; strongly consistent = 1 RCU per 4 KB; transactional = 2 RCU per 4 KB. `BatchGetItem` offers no per-request discount — each item is billed independently.
    - **Query**: bills on the total size of items matching the key condition, rounded up to 4 KB, at the same per-4 KB rate as `GetItem`. `FilterExpression` applies _after_ billing — a filter that discards 90% of matches does not reduce cost by 90%.
    - **Scan**: bills on the total size of items examined — the portion of the table or GSI actually read — again before any filter is applied. This is the underlying reason `Scan` is the wrong choice on a hot path.

    Write pricing: `WCU = frequency × ⌈item_size / 1 KB⌉ × copies_updated`. `UpdateItem` is billed on **`max(before, after)` item size**, not the delta and not just the post-update size — a shrinking update still pays for the larger pre-update size rounded up. Transactional writes cost 2×. `ConditionalCheckFailedException` still consumes the same WCU as a successful write of that shape; plan `conditional_fail_rate` into the estimate.

    If these formulas cannot be written down for a given pattern, the pattern is not specified precisely enough to be modeled.

19. Use on-demand capacity by default; switch to provisioned on evidence. On-demand removes a class of capacity-related incidents and is the correct default for new or variable workloads. At sustained high throughput with predictable patterns, provisioned capacity with autoscaling delivers a lower unit cost. The switch should be triggered by measured traffic, not anticipation.

    **For a table carrying a vector index, on-demand is not a default — it is mandatory.** Vector indexes are not supported on provisioned tables at all. A provisioned table must be switched to `PAY_PER_REQUEST` before the index can be created, and that switch is subject to the 24-hour capacity-mode cooldown (Fact #3), so it is a scheduling constraint rather than an instant step. This also removes the provisioned-capacity option from any design that includes semantic search, so do not later propose moving such a table to provisioned for unit-cost reasons.

## Patterns

These are concrete implementation patterns that sit alongside the axioms. They are not axioms in the "correctness/operational/cost/style" sense — they are load-bearing details that a complete design needs even when no axiom explicitly requires them. Each one is worked out in full in the reference architecture; this section is the short form so the agent recognizes when it applies.

1. **Protect mutating API routes with an `IdempotencyKeys` table.** Every `POST`, `PUT`, `PATCH`, or `DELETE` that can be retried by a client (mobile network hiccup, load-balancer retry, user double-tap) must be wrapped by idempotency middleware. Shape: a dedicated table, `PK = <user_id>:<METHOD>:<path>:<client-supplied-uuid>`, attributes `status`, `response_status`, `response_body`, `expiration` (epoch seconds). The middleware does a conditional `PutItem` with `attribute_not_exists(id)` before the handler runs; on a conflict, it reads the cached response back and returns it. TTL is 24 hours; PITR off (the table is a cache). This is the mechanism that keeps a retried "create order" from double-charging a customer or double-decrementing inventory — the guarantee `TransactWriteItems` gives _within_ a single call but not _across_ retries.

2. **Guard mutating writes with conditional expressions. Two halves — both are mandatory guidance whenever this pattern comes up.**

   **Half A — `attribute_exists(<pk>)` on `UpdateItem` unless you explicitly want upsert.** `UpdateItem` defaults to _create if missing_. A `PATCH /orders/:id` with a guessed or stale `order_id` silently materializes a phantom order row — no error, no log, no recovery. Add `ConditionExpression: attribute_exists(<partition_key>)` to every `UpdateItem` that operates on a row the caller is asserting exists; catch `ConditionalCheckFailedException` and translate to 404.

   **Half B — `attribute_not_exists(<pk>)` on `PutItem` when you mean "fail on overwrite."** `PutItem` defaults to _overwrite if present_. A `POST /orders` that should create a new order (or a new review, a new courier-assignment, a new uniqueness sentinel) will silently clobber an existing row keyed the same way without a guard. Add `ConditionExpression: attribute_not_exists(<partition_key>)` to every `PutItem` that should fail if the key already exists; catch `ConditionalCheckFailedException` and translate to 409 Conflict.

   Conditional writes are where invariants live in the data layer. When you recommend one half, surface the other — design reviews routinely catch the missing `PutItem` guard in apps that added the `UpdateItem` guard years earlier.

3. **TTL attributes are Unix epoch seconds. Three common format mistakes silently break expiration — enumerate all three whenever diagnosing a "TTL isn't deleting anything" report.** DynamoDB TTL reads the attribute as a number and interprets it as seconds since epoch. Any of the following causes TTL to silently never fire (no error, no log — the sweeper just skips the row):

   1. **Milliseconds instead of seconds.** `Date.now()` in JavaScript returns milliseconds; written unchanged, the stamp is ~1000× too large and resolves to a year-50,000 timestamp that will never be in the past. Fix: `Math.floor(Date.now() / 1000)` in JS, `int(time.time())` in Python.
   2. **ISO 8601 strings instead of numbers.** `datetime.datetime.now().isoformat()` in Python or `new Date().toISOString()` in JS produces a string like `"2026-05-13T09:45:00Z"`. DynamoDB TTL reads strings as non-numeric and skips the row entirely.
   3. **Wrong attribute name.** TTL is configured per-table with a specific attribute name (`ttl`, `expiration`, `expires_at`, etc.). If the app writes `expires_at` but TTL is configured on `ttl`, or if a typo splits the attribute, TTL scans an attribute that doesn't exist and skips the row. Verify the configured attribute name in the table's TTL specification matches what the application writes, exactly.

   Validate at write time: flag any TTL value greater than `current_time + 50 years` as a likely milliseconds-vs-seconds bug before it reaches the table. Standardize on the attribute name across the codebase. This pairs with Mechanics #12: the "filter on read" discipline still applies because even when TTL is configured correctly, deletion is eventual.

4. **Do not persist a `Notifications` table for transient push/email/SMS.** The reflex to create a table for every domain noun is a trap here. If notifications are dispatched-and-forgotten — push to APNS/FCM, transactional email via SES — the correct shape is **EventBridge → SQS → NotificationLambda → delivery service**. DynamoDB is reserved for state that needs to be _queried later_. Only create a `Notifications` table if you have a genuine read access pattern against it — a per-user in-app inbox, a delivery-status dashboard, a compliance audit. Otherwise you are paying DynamoDB write cost to never read the result. Per-user inbox, if needed: `PK = user_id`, `SK = <createdAt>#<notificationId>`, TTL on older entries.

5. **Plan cascade deletes as chunked `BatchWriteItem`, not a sync API call.** Deleting a parent entity in a hierarchical schema (a board, an order, a tenant, a user under GDPR) requires deleting everything keyed under it. Do it with `BatchWriteItem` (25 items per batch) paginated with `Query(..., Limit=25, LastEvaluatedKey=...)`. This is a background job, not a synchronous API response — at scale the walk is long enough to exceed a typical Lambda timeout, and partial failures must be retryable. If GDPR or regulatory deletion is a requirement of the domain, model this job explicitly as part of the design; do not assume it will fall out of the schema for free.

## Cost estimation

Designing and discussing the data model is the default, no-AWS path, and a user is often there to explore options — keys, GSIs, single- vs multi-table, projection tradeoffs — without yet wanting a dollar figure. **Do not run the calculator reflexively on every design turn.** Produce the monthly cost estimate when either is true: **(a)** the user asks what it costs (or for the cost report), or **(b)** the design is being finalized — they signal they're settling on it, taking it to a review, or otherwise want the numbers committed. Until then, stay in design discussion.

Skip the estimate entirely when no full design was produced — a single-query sizing, a hot-partition debugging thread, a pointed mechanics question. In those cases there is nothing to estimate.

When you _do_ produce the estimate, three steps are not optional: (a) write `dynamodb_data_model.json`, (b) invoke `${SKILL_DIR}/scripts/calculate_costs.py`, (c) reference the generated `cost_report.md` in your summary. **Computing numbers inline without running the calculator is never a substitute** — not even for a "rough" or "realistic" figure, and not even to reconcile a headline number against a stated daily volume (for that, set `avg_rps` and let the calculator produce the expected-volume scenario — see below). The calculator enforces the pricing module that stays calibrated against live billing; doing the arithmetic by hand means the numbers drift silently and the user ships a quote they cannot defend.

The calculator is at `${SKILL_DIR}/scripts/calculate_costs.py`. The JSON schema it consumes is documented at `${SKILL_DIR}/references/cost-model-schema.md` — read that file the first time you produce a cost estimate.

The workflow:

1. **Serialize the design to `dynamodb_data_model.json`.** The calculator does not reinvent the design — it reads what you already produced. The access-pattern list you built (per Mechanics #2, #18) is a near-literal translation into the JSON's `access_patterns` array; the schema you built (per Data modeling #3, #7, Mechanics #4, #7) translates into `tables`, `gsis`, and — when the design has one — `vector_indexes`. If a field the calculator wants is missing (most commonly `peak_rps` on a pattern), that is a gap in the design itself — close it by asking the user or by making a defensible assumption and labeling it as one, not by writing `0`.

   **A vector index goes into the model as a `vector_indexes` entry, and its search goes in as a `SearchVectors` access pattern carrying `top_k`.** The calculator supports both (full shape in `${SKILL_DIR}/references/cost-model-schema.md`). Mind the asymmetry with the service API: you _create_ an index with the `VectorIndexes` **CreateTable parameter** (Fact #10), but you _cost_ it with the `vector_indexes` **model field**. Knowing the API shape is not the same as knowing the model shape, and conflating the two is how a vector index ends up costed at zero.

   **If you catch yourself concluding "the calculator doesn't support vector search," the vector index is missing from your model — fix the model, do not fall back to arithmetic.** The calculator prices vector index storage and vector **write** capacity and includes both in the headline; it deliberately declines to price vector **search**, printing `not priced` with a footnote and the measured drivers instead. Both halves are already handled, so hand-computing either is exactly the inline arithmetic the rule above forbids. This is not a small slip: on a 1024-dimension `ALL`-projected index over ~3 KB items, vector writes are typically the **largest single line in the estimate** — measured at **$1,942/month** at 200 rps against **$972/month** for the base-table writes themselves — because `ALL` copies the entire item into the index on every write. Eyeballing that figure can understate the true top cost driver by more than an order of magnitude.

   **When the user states an average or daily volume, set `avg_rps` on the pattern — do not hand-compute a "realistic" figure.** The headline is peak-sustained (every pattern at `peak_rps`, 24/7); a user who hears a large peak-sustained monthly figure for a 15K-orders/day workload needs the expected number too. Setting `avg_rps` (e.g. 15,000 orders/day ÷ 86,400 s ≈ 0.17 rps average, vs a 600 rps Black-Friday peak) makes the calculator emit a second **Expected Monthly Cost** headline at that average rate. This is the _only_ sanctioned way to produce a realistic-volume number — reconciling the peak headline against a daily volume with mental arithmetic is exactly the inline-arithmetic the rule above forbids.

2. **Run the calculator.** Write the JSON to a workspace path of your choosing and invoke:

   ```bash
   python3 ${SKILL_DIR}/scripts/calculate_costs.py --model /path/to/dynamodb_data_model.json --output /path/to/cost_report.md
   ```

   The JSON is an intermediate artifact. You do not need to present it to the user unless they ask.

3. **Surface the cost report.** Hand back `cost_report.md` — either inline (if short) or as a file pointer. Highlight the top drivers the report surfaces (the "cost patterns sorted descending" table), and call out the assumptions you baked in (RPS numbers you estimated, retention you assumed, consistency choices). The disclaimer at the top of the report is part of the artifact — do not strip it.

4. **Use the cost report to challenge the design, not just to report the number.** A cost estimate is diagnostic. If one pattern dominates the bill — the classic case is a high-frequency write like a GPS ping — that is a modeling signal, not just a line item: revisit the aggregate choice (Mechanics #1), the projection shape (Mechanics #7), whether a sparse-GSI-on-transition would cut amplification (Mechanics #6), or whether the pattern belongs outside DynamoDB entirely (Integration #8). Propose the alternative and re-run the calculator on the revised model. This is the main value of having the calculator bundled: the feedback loop from "here's the design" → "here's the bill" → "here's the cheaper design" becomes a turn or two, not a separate exercise.

The calculator models request and storage cost only. It does not model Streams read/write costs, PITR, backup, DAX, or data transfer. If those line items are likely material for the workload, call that out alongside the estimate so the user knows what the number excludes. **Storage is priced at the full public rate — the 25 GB free tier is not assumed** (it is account-wide and often already used), so never tell the user "storage is free." Set a write pattern's `retention_days` to size its stored data; the calculator honors it. The storage figure is a **bounded-retention snapshot** at that `retention_days` — for a table with **no TTL / "kept forever" data**, real storage keeps growing past the snapshot, so do **not** reframe a steady-state storage number as "after N years": either state the retention window the number assumes, or note that a no-TTL table accumulates without bound.

**Name the artifacts in your final response. Do not let the tool calls disappear into prose.** The user reads your natural-language output, not your shell history. After you run `calculate_costs.py`, your response must name (a) the JSON file you wrote (`dynamodb_data_model.json`), (b) the script you invoked (`${SKILL_DIR}/scripts/calculate_costs.py`), and (c) the report file it produced (`cost_report.md`). A response that shows cost numbers but does not name the artifact files reads as if you computed them by hand — the workflow evidence has to be in the prose, not just the tool trace.

## Live validation

After the cost estimate, **offer to run a live validation** — deploy the tables and GSIs to an AWS account the user nominates and drive scaled-down traffic against them to measure real per-operation capacity and round-trip latency. Ask in one line, and run only on explicit agreement. Even in that one-line offer, name the two constraints the user needs in order to opt in responsibly: it runs only against a **sandbox/testing account** (never production or real user data), and **cleanup is their responsibility** (the skill hands back a `teardown.sh` and never auto-deletes). The full four-fact disclosure still comes before any deploy (below) — this is just so the one-line offer isn't misleadingly light. Skip for narrow questions — single-query sizing, pointed debugging, pointed mechanics — where no full design was produced and there is nothing to benchmark.

**Before running, make the safety expectation explicit in your own wording** (the `deploy_model.py` script also prints a warning banner, but that's a belt-and-braces backstop — the agent is responsible for setting the expectation). **State the following four facts verbatim in your response; do not paraphrase them into a shorter summary**:

1. Live validation **creates real DynamoDB tables, a Lambda function, and an IAM role** in the AWS account the user nominates.
2. It **incurs real (small) AWS charges** — single-digit cents in practice, but a real bill.
3. The account **must be a testing or sandbox account** — never a production account, never an account holding real user data.
4. The skill **does not auto-teardown** — at the end, the user is handed a `teardown.sh` script to review, and the skill will execute it on their behalf only after explicit review + intent (see step 6 below).

After stating those four facts, ask the user to explicitly name the profile, the region, and confirm the account's purpose. Only then produce the `benchmark_config.json` and invoke `deploy_model.py`. If the user hasn't named a testing account, stop and ask. Shortening this to "this creates real resources, confirm your profile" is **not** sufficient — enumerate the four facts because the user often doesn't know which specific resources get created or that teardown is their responsibility.

The step differs from the cost estimate in two respects that change how it must be run:

1. **Real resources, real bill.** A scaled-down run costs single-digit cents in practice, but against a real account. Never run silently. Always require an explicit AWS profile, region, and caller-identity confirmation.
2. **Teardown is two-phase.** Phase 1: the skill generates `teardown.sh` and hands it to the user. Phase 2: the skill may execute it — but only after the user has explicitly stated they reviewed the script AND explicitly directed the skill to run it. The skill never calls `DeleteTable` on its own initiative, and never runs `teardown.sh` on the basis of a bare "go" or "proceed."

**Refuse to start by enumerating the four preconditions explicitly.** Emit them as numbered items in your response; do not fold them into a generic "I need more information" paragraph. Surface the **specific** precondition that failed so the user knows what blocked the run:

1. `access_patterns` is empty, or any pattern has `peak_rps` missing or `0` → refuse with Mechanics #2 framing: "Unknown RPS is a design gap, not a benchmark input. Pattern `<id>` has no declared RPS — please supply an estimate before benchmarking."
2. `boto3` is not installed → print exactly: `pip install boto3>=1.34`.
3. AWS credentials are missing or expired → print the exact remediation, e.g. `aws sso login --profile <profile>` for SSO, or the specific boto3 exception's suggested fix.
4. Caller identity's account alias or ARN contains `prod`, `production`, `prd`, or `live` → refuse and tell the user to supply a sandbox/testing profile.

Check all four before writing `benchmark_config.json` or invoking `deploy_model.py`. A generic "I need more info" paraphrase does not satisfy the contract — enumerate the specific precondition that failed.

**Workflow**, once the user agrees:

1. Reuse `dynamodb_data_model.json` from the cost estimate. Do not re-serialize.

   **Before deploying, confirm every numeric/binary key declares its type.** The deploy builds each table's `AttributeDefinitions` by looking up every key attribute (table + GSI partition/sort keys) in `entities[].attributes[]` and `attribute_definitions`, defaulting any it can't find to `S`. A numeric epoch sort key or numeric id left undeclared deploys as a string and then rejects real writes with `ValidationException`. Per Data modeling #11, ensure each such key carries `"type": "N"` (or `"B"`) in the model before this step — and don't trust a clean seed as proof, since the failure can surface only on live writes. If you want belt-and-suspenders, `DescribeTable` after deploy and confirm the key's `AttributeType`.

   **Scope the run when the design has many patterns — warn, estimate, and get confirmation.** The benchmark drives patterns **serially** (each pattern runs its own warmup + measurement window one at a time), so wall-clock grows with pattern count: roughly `table_settle + Σ_patterns (warmup + duration)`. At standard windows (~10s warmup + ~60–90s duration) a 6-pattern design is a few minutes, but a **20+ pattern design is 25–45+ minutes** and gets split across several sequential Lambda invocations. Before launching a run on a design with more than ~8 patterns: state a rough wall-clock estimate and **get explicit confirmation** ("This will benchmark all 24 patterns and take ~35–45 minutes — proceed, or would you rather test a focused subset?"). Don't silently kick off a 40-minute run.

   **Offer to load-test only the critical patterns, and choose them with the user.** A full live run rarely needs every pattern — most are cheap structured lookups whose per-op cost the calculator already nails. Offer to benchmark a focused subset and collaborate on which ones, steering toward the patterns where a live measurement actually buys something:
   - **Highest-throughput / firehose writes** — the ones whose RPS dominates the bill or stresses capacity (e.g. a location-ping write).
   - **The transactional / multi-item core** — `TransactWriteItems`, multi-table writes, the checkout path (transaction 2× cost, Mechanics #18, is worth seeing live).
   - **Novel or risky key shapes** — anything with a fan-out read (N parallel Queries), a hot-key risk, or a GSI you're unsure about; skip the boring `GetItem`-by-id patterns.
   - **Cost-dominant patterns** — whatever the cost report flagged as the top drivers.

   To run a subset, benchmark a **trimmed copy of the model**: keep **all `tables`** (so the schema deploys and seeds correctly) but prune `access_patterns` to the chosen few. The **cost estimate is unaffected** — it always runs on the full model against declared peak; subsetting only narrows the _live driven traffic_, not the design or its costing. Name which patterns you're testing and which you're skipping (and why) so the user sees the coverage tradeoff.

2. Write `benchmark_config.json` — profile and region are the only fields you must set (`resource_prefix` is auto-generated by the deploy when omitted; everything else has a mode-driven default). Read `${SKILL_DIR}/references/performance-model-schema.md` the first time. **Ask the user which mode to run BEFORE writing the file — do not pick a default silently.** For a one-shot live validation, the choice is between the two unit-cost modes below; the third mode, **`"representative"`**, is the iterative design loop's mode (hot-key skew at bounded scale) and is described under _Iterative design loop_ — offer it only when the user wants to probe hot-partition/throttle risk, not for a plain cost-validation run.

   **State the driven throughput honestly, and offer to drive harder.** This is the most important thing to get right about live validation. By **default** `quick`/`standard` drive only a small fraction of declared peak (`scale_factor` ~0.01, floored at `min_rps_per_pattern`) — for a design whose peaks are modest this floors to **~1 request/second per pattern**. That is a **unit-cost sample**: it validates per-operation capacity (cost) and _unloaded_ latency, and it is cheap (pennies, ~1–2 min/pattern). It does **NOT** exercise load — at ~1 rps, zero throttles is mathematically guaranteed (on-demand baseline is ~2,000 WCU / ~4,000 RCU) and the latencies are best-case. So when you offer the run, say which it is, and offer the alternative:
   - **Unit-cost sample (default)** — validates cost + unloaded latency. Cheap. Does not test load/throttling.
   - **Drive at/near declared peak** — a real load test. Set `scale_factor` (fraction of declared peak, e.g. `1.0` for full peak) or `max_rps_per_pattern` in `benchmark_config.json`; both are honored. Bounded by one in-region Lambda's ceiling (~1,500–2,000 rps/pattern) and gated by `cost_guardrail_usd` + `--allow-spend` (so an expensive run can't fire silently). **Caveat:** a freshly-created on-demand table starts at ~2,000 WCU / ~4,000 RCU baseline and adapts upward with a lag, so a high rate immediately after deploy measures cold-start adaptive-capacity warm-up, not steady state — the run already has `ramp_seconds` + `table_settle_seconds` to absorb some of this; for a clean high-rps read use a longer `duration_seconds`.
   - **`representative` mode** — the loop's hot-key/throttle-risk mode (zipf skew at bounded scale); use it when hot-partition behaviour is the question (see _Iterative design loop_).

   The extrapolated monthly **cost is identical** across `quick`/`standard` and at any throughput — per-op CU is deterministic and the cost extrapolation always uses declared peak, so a higher-throughput run buys you latency-under-load and throttle signals, **not** a different cost number. **Always tell the user the per-pattern rate you will drive before you run.** Emit the mode options as a literal question and wait for the user to pick:

   > Which mode should I run? Pick one:
   >
   > - **`"quick"`** — ≈1 minute per pattern window, a smoke test that confirms the design deploys and runs. Percentiles are less stable. A unit-cost sample (drives ~1 rps/pattern for a modest-peak design): validates cost + unloaded latency, not load.
   > - **`"standard"`** (default) — full-length windows, stable p50/p95/p99, trustworthy extrapolated monthly cost. Still a unit-cost sample by default (same ~1 rps/pattern) — the cost number is identical to `quick`; you get tighter latency percentiles, not a load test. To make it a load test, tell me to drive at/near your declared peak.
   >   _(There is also `"representative"` — hot-key/throttle-risk mode for the iterative design loop. Mention it only if hot-partition behavior is the question; see Iterative design loop.)_

   Write the user's chosen value into `benchmark_config.json`'s `mode` field. If the user skips the question and just says "go," default to `"standard"` and name that default in your reply ("I'll run `standard` mode since you didn't specify — interrupt if you meant `quick`").

3. Deploy: `python3 "$DDB_SKILL_DIR/scripts/deploy_model.py" --model … --config … --manifest-out created_resources.json --yes-deploy`. Prints caller identity for confirmation, aborts on prod markers, prefixes every resource with `ddb-skill-bench-<date>-<uuid8>-` (generated for you if you didn't set `resource_prefix`), tags it with the run id. On an interactive terminal it waits a few seconds for a Ctrl-C abort after printing the account; in an agent/CI run it proceeds immediately on the `--yes-deploy` consent.
4. Benchmark: `python3 "$DDB_SKILL_DIR/scripts/benchmark_model.py" --model … --config … --manifest created_resources.json --raw-out perf_raw.jsonl --summary-out perf_summary.json`. Handles cold-start discipline automatically (see below).

   **Execution discipline — run it in the foreground and wait.** A `representative` run drives many minutes of traffic (≈ settle + per-pattern warmup + per-pattern duration across every pattern — often 15+ minutes for a multi-pattern design). Run the benchmark as a **single blocking call and wait for it to finish — do NOT background it and hand control back to the user.** A backgrounded run can be killed when the surrounding turn/session ends, leaving the _previous_ run's `perf_summary.json` in place — which is exactly how a stale summary gets read as if it were fresh. If the run risks exceeding your tool's wall-clock limit, **raise the tool timeout — do not shrink the windows or background the job.** You do not need to hand-size `duration_seconds` to fit a budget: the heavy work runs inside the Lambda (≤900 s server-side) and `benchmark_model.py` already splits the load across sequential invocations (`_compute_split`). When it finishes, note the UTC time you launched it; you'll check the summary's `benchmark_completed_at` against it in step 5.

5. Report: `python3 "$DDB_SKILL_DIR/scripts/generate_perf_report.py" --model … --summary perf_summary.json --output performance_report.md`.

   **Verify the summary is fresh AND matches the experiment you described before you interpret it (Operating discipline, applied).** `perf_summary.json` records `benchmark_completed_at` (UTC) and the `config` the run actually used. Before generating or trusting the report, confirm **(a)** `benchmark_completed_at` is newer than the launch time you noted in step 4, and **(b)** the summary's `config` (`mode`, `provisioned_capacity`, `duration_seconds`) matches what you set for _this_ run. If either fails — or the field is absent — the benchmark did not complete and you are looking at a stale file: **do not interpret it, re-run.** The report's Deployment block surfaces `benchmark_completed_at` and the run window so the user can see the same thing. The tell that you're reading stale data: benchmark numbers that are byte-identical to a prior run you expected to differ.

   **Run what you said you'd run — verify config-match, not just freshness.** If you told the user this run would change something (raise the provisioned ceiling to isolate skew, pin a subset of patterns, drive a higher rps, switch modes), then read the actual `config` block in the fresh `perf_summary.json` and confirm it reflects that change **before** you report. A run that is fresh but used the _old_ config is not the experiment you promised — interpreting it answers a different question than the one you set up. If you find you described an experiment you did not actually configure, say so plainly and either re-run with the correct config or, if the run is physically incapable of producing the signal regardless (e.g. a unit-cost/floor run at ~1 rps cannot drive _any_ partition key hot no matter how you set capacity, so it can never isolate skew — only representative mode or driving at/near declared peak can; raising a provisioned ceiling on a floor run changes nothing — Mechanics #3, and _Unit-cost / floor runs_ below), state _that_ instead of quietly substituting a same-config re-run. Never present a re-run as testing a variable you did not change. The catch in practice: the user notices two "different" runs producing near-identical numbers — get ahead of it by checking the config yourself.

   > ⚠ **DO NOT run `rm`, `rm -f`, `ls`, `find`, `aws dynamodb delete-table`, or any other ad-hoc delete command when the user asks to "clean up," "tear down," "remove," or "get rid of" the benchmark resources.** "Teardown" in this skill means **invoking `generate_teardown.py` to produce `teardown.sh`**, never running a shell command yourself to delete local files or AWS resources. The teardown protocol is step 6, below. Local artifact files (`performance_report.md`, `cost_report.md`, `dynamodb_data_model.json`, etc.) are the user's to keep or delete — the skill never cleans them up.

6. **Teardown — generate first, execute only after explicit review + intent.** When the user asks to tear down, clean up, or remove benchmark resources:

   a. **Generate the script** with `python3 ${SKILL_DIR}/scripts/generate_teardown.py --manifest created_resources.json --out teardown.sh`. This writes `teardown.sh`. It does not delete anything.

   b. **Surface the script path, the review command, and the execute command** in your reply. Verbatim form:
   - Review: `cat teardown.sh` (or open in an editor) — the script deletes DynamoDB tables, a Lambda function, and an IAM role under the `ddb-skill-bench-` prefix.
   - Execute: `bash teardown.sh --confirm` — the manifest's account, region, and prefix are baked into the script at generation time, and it re-checks caller identity + prefix before deleting anything. (Pass `--dry-run` instead of `--confirm` to preview deletions; add `--delete-logs` to also remove the Lambda's CloudWatch log group — that log deletion is irreversible.)

   c. **Do not conflate "teardown" with "local cleanup."** Never run `rm`, `rm -f performance_report.md`, `ls`, or `find` thinking the task is removing local files. Only `teardown.sh` deletes AWS resources; local files are not the skill's concern.

   d. **The skill may execute `teardown.sh` on the user's behalf, but only under this exact two-part condition:**
   - The user's message must state they **reviewed the script** (examples: "I read it," "I reviewed teardown.sh," "I checked the contents," "looked it over"). Inferring review from context does not count; it must be stated.
   - The user's message must state the **intent to run it** (examples: "run it," "execute it," "go ahead and tear down," "proceed with the teardown").

   e. **When the user asks the skill to run teardown without stating review**, the skill must not execute. Instead, surface the exact review command (`cat teardown.sh`) and ask the user to confirm they reviewed it. One required response shape:

   > Before I run `teardown.sh`, please confirm you've reviewed the script. Run `cat <PATH>/teardown.sh` — it deletes the DynamoDB tables, Lambda function, and IAM role created under the `ddb-skill-bench-` prefix. Once you've read it and want me to execute, reply with something like "I reviewed it, go ahead" and I'll run `bash teardown.sh --confirm`.

   f. **When the user asks the skill to skip the review** ("don't worry about it," "just run it without showing me," "trust it"), refuse. Destructive actions require the user's attested review. Surface the refusal and re-offer the review command.

   g. **When the conditions in (d) are met**, the skill may run `bash teardown.sh --confirm`, surface the full stdout/stderr, and report which resources were deleted.

**Operations execute as declared, never substituted.** When the design says `BatchWriteItem`, the benchmark issues `BatchWriteItem` in 25-item batches. When it says `TransactWriteItems`, the benchmark issues `TransactWriteItems` with the declared item set. Single-item substitutes (a loop of `PutItem` for `BatchWriteItem`, or individual `PutItem` calls for `TransactWriteItems`) are not used — they measure a different design. Transaction 2× write cost (Mechanics #18), batch partial-failure semantics, and transaction bounds (Mechanics #14) are exactly what live validation observes; substituting them defeats the purpose. If a user asks how the benchmark exercises batch or transactional patterns, state plainly that the declared operation runs as-declared and name the specific bounds the benchmark will observe.

**Cold-start discipline.** DynamoDB latency and throughput are not stable at t=0 on a new table; numbers collected without discipline here will misleadingly look worse than steady state. Three classes of bias must be removed before measurements are trustworthy:

- **Fresh-table capacity.** On-demand tables start at baseline capacity (~2,000 WCU, ~4,000 RCU); traffic above baseline in the first minutes can throttle until adaptive capacity scales. After `table_exists` returns, wait at least `table_settle_seconds` (default 30) before any measurement call.
- **Partition priming and client warmup.** Seed writes warm the partitions the benchmark will later hit, and a fresh boto3 client carries a TLS handshake + credential refresh on its first call (tens to hundreds of ms). The benchmark pauses briefly between seed and measurement, and issues one `DescribeTable` per worker thread, so those one-time costs don't show up in the percentiles.
- **Per-pattern warmup window.** Every pattern runs a `warmup_seconds` window (default 10) ahead of its measurement window. Warmup calls are recorded with `phase: "warmup"` and excluded from latency percentiles and the cost extrapolation. The perf report surfaces warmup p99 separately — if it's materially higher than steady-state p99, that itself characterizes cold-deploy behavior and is worth calling out.

**What is and is not measured:**

- Measured: per-op consumed RCU/WCU from `ReturnConsumedCapacity`; round-trip latency p50/p95/p99 (warmup and steady-state reported separately); throttle counts; GSI write amplification; even-distribution signal per pattern; observation-based extrapolated monthly cost.
- Not measured: TTL sweep cadence, stream consumer latency and cost, autoscaling under sustained burst, cross-region replication lag, long-tail traffic shapes beyond the measurement window, and any non-DDB service in the design (Lambda, API Gateway, SQS, EventBridge Pipes, OpenSearch, etc.). The perf report lists these under "Designed, not benchmarked" so the user sees plainly which parts of their architecture the numbers cover.

The report format is documented in `${SKILL_DIR}/references/performance-report-format.md`. It mirrors `cost_report.md`'s disclaimer-first, table-driven style and prints both observed and calculator-expected numbers per pattern so the user sees where their inputs (RPS, item size, consistency) diverged from reality.

**Reflect on the findings and offer an iteration loop.** After the report is written, read it as a diagnostic — not a final score — and ask: is there an alternative design that the measurements argue for? For each finding, classify it:

- **Input-accuracy finding** — the observation diverged from the calculator because a declared input (RPS, item size, consistency, `conditional_fail_rate`) was off. The design itself is fine; the estimate needs updated inputs. Propose updating the JSON and re-running the calculator only (cheap, no redeploy).
- **Design finding** — the observation reveals a structural issue that persists regardless of input accuracy. Examples and the axioms that govern them:
  - Persistent throttles that scale with partition-key skew → Mechanics #3 (per-partition ceilings, write-shard the hot key). **Before attributing throttles to a hot partition, run the skew-vs-starvation gate — both parts must pass:** (1) **Differential test** — the hot partition's p99 must be materially above the cold partitions' p99 (the report's ~1.8× rule). If hot p99 ≈ cold p99, every partition throttled _uniformly_: that is **capacity starvation, not key skew** — say so, and do **not** attribute it to the partition key. (2) **Uniform-baseline test** — using the per-op observed CU the report already prints (not hand-derived item counts), check whether _uniform_ keys at the driven RPS would already exceed the provisioned ceiling; if they would, the run cannot isolate skew — recommend re-running with capacity set _above_ uniform demand so only a genuinely hot partition throttles. Only once both pass is "hot partition at its ceiling" a supported verdict. Note also: write-sharding a _mutable_ partition key (e.g. a status that changes each transition) spreads the Mechanics #3 load but the key still mutates on every write, so the Mechanics #8 (mutable GSI key) deviation **persists** and must stay recorded per Artifact #5 — eliminating the write amplification needs a separate single-purpose table, not a sharded suffix.
  - One pattern dominating the bill → Mechanics #1 (aggregate tightness), Mechanics #7 (projection), Integration #8 (move off DDB to Timestream/S3/OpenSearch/Redshift/SageMaker Lakehouse when the workload is analytical, high-frequency telemetry, or full-text).
  - GSI write amplification higher than the projection implies → Mechanics #6 (sparse GSI when a mutable key isn't always present), Mechanics #7 (downgrade ALL → INCLUDE/KEYS_ONLY), Mechanics #8 (mutable attribute as GSI key doubles the write).
  - Strong read cost observed where RYW semantics weren't actually required → Mechanics #15 (default to eventual), Patterns around `ReturnValues=ALL_NEW` to avoid the post-write re-read.
  - Unbounded query hitting the 900 KB page cap repeatedly → Mechanics #17 (constrain every query; require a time window or max page).
  - Cold-start p99 materially elevated at on-demand baseline → a capacity-mode or pre-warming decision (Mechanics #19), not usually a schema change.

When at least one design finding is meaningful — meaning the proposed change would plausibly reduce cost by >10%, remove a throttle source, or close an axiom deviation — tell the user:

1. Which findings point to design changes vs. which point to input accuracy.
2. For each design finding, the axiom it traces to AND **a literal JSON diff on `dynamodb_data_model.json`** — not a verbal description. Emit the diff as a fenced code block showing the specific fields that change (new GSI object, dropped GSI, changed `projection.type`, sharded PK with hash suffix, pattern moved out of the `access_patterns` array entirely). A verbal suggestion like "consider downgrading the projection" does not satisfy this — the user has to see the exact change so they can accept or reject it. When the diff changes a **GSI's key** (a sharded partition key is the common case), label it as an **additive-GSI migration**, not a code-only change, per Fact #9 — the new index is created alongside, populated, cut over, then the old one dropped. Example shape:

   ```diff
   - { "name": "OrdersByCustomer", "projection": { "type": "ALL" } }
   + { "name": "OrdersByCustomer", "projection": { "type": "INCLUDE", "non_key_attributes": ["status", "total"] } }
   ```

3. The expected effect on the top cost drivers and throttle sources.

**Your spoken verdict inherits the report — never exceed it.** The chat summary you give the user must not claim an outcome the report did not classify. Concretely:

- If the report emitted **no `key_skew_patterns` finding**, do **not** say the design "throttles" or "hot-partitions" — the supported statement is the report's own ("no hot-partition distress observed under skew" / "not validated by this run").
- Restate the report's hedge; do not upgrade it. "Throttles appeared under a deliberately low ceiling" is **not** "the GSI partition is hot" (see the skew-vs-starvation gate above).
- Attribute every number to exactly the claim it supports. A low provisioned ceiling that throttles proves the **table was under-provisioned for the driven load**, not that any single partition key is hot.
- Worked contrast — same data, two verdicts: ❌ "Confirmed: the OrdersByStatus GSI throttles hard under load." ✅ "Under a 50-WCU ceiling, writes to the Orders table throttled — but hot-partition p99 ≈ cold-partition p99, so this is uniform capacity starvation, not key skew. The run did not isolate a hot-partition effect; to test that, re-run with capacity above uniform demand."
- **Unit-cost / floor runs — do not narrate them as load tests.** When the run was a unit-cost sample — `quick`/`standard` mode, or any run where every pattern's driven `bench_rps` equals the `min_rps_per_pattern` floor (it shows as a uniform `bench_rps`, typically ~1, in `perf_summary.json`, and the report's disclaimer says "UNIT-COST sample, not a load test") — you **MUST NOT** present "0 throttles" or the latency percentiles as evidence the design withstands load. At ≤ a few rps, zero throttles is mathematically guaranteed (on-demand baseline ~2,000 WCU / ~4,000 RCU) and the latencies are unloaded best-case. State what the run actually validated — **per-op capacity (cost) and unloaded latency** — and that throttling/ceilings were "not exercised — see the report's Not-validated list." If you reassure the user that throttling isn't a risk, give the **structural reason, not the zero count**: e.g. a high-cardinality partition key (`user_id` across many users) spreads load so no single partition gets hot (Mechanics #3). To actually exercise throttling, drive at/near declared peak or use representative mode.
  - Worked contrast — a ~1 rps habit-tracker run: ❌ "Validated against live DynamoDB — 0 throttles, reads <8 ms, writes <50 ms. Ready for review." ✅ "This validated per-op cost (within 2% of the model) and unloaded latency (reads <8 ms). It ran at ~1 rps, so it did **not** test throttling — but throttling isn't a concern for this design anyway: the partition key is `user_id`, so load spreads across users and no single partition gets hot. To _prove_ peak behaviour, we'd re-run driving your declared peak rps."
- **Reconcile any number the user quotes back against your own latest artifact — do not just agree.** When the user restates a figure ("$189/mo is fine," "so it's ~600 WCU on that partition," "the 1,884 throttles") before you respond, check it against the number actually in your current `cost_report.md` / `perf_summary.json` / `performance_report.md` — after confirming that artifact is itself fresh per step 5, since a number matching a *stale* summary is not a real reconciliation. If it doesn't match — even when the user sounds confident, and *especially* when accepting it would be the agreeable move — correct it explicitly and cite the artifact: "Quick correction: the report says **$835/mo** expected, not $189 — the $189 was an earlier figure. Still want to proceed?" Silently accepting a wrong number the user will then carry into a budget deck or a design review is a worse failure than a moment of friction. This applies to costs, capacity math, throttle/latency counts, and item-size assumptions alike. A user-supplied number is an input to verify, not a verdict to ratify.
- **Do not vouch for a claim the run did not establish.** Your spoken verdict may assert only what the artifact in front of you actually shows. If a number you're about to state came from your own head rather than the report (a hand-extrapolated provisioned/reserved cost, a "scales linearly so 25k rps is fine" leap from a 2k-rps run, a per-partition figure the benchmark never isolated), label it as reasoning, not measurement, and give the user the structural argument behind it — never dress an estimate as a validated result. "The calculator only models on-demand; the reserved figure is my hand-calc for a _provisioned_ alternative (reserved capacity applies to provisioned only — Fact #7) from published rates — confirm it against the AWS calculator before the deck" is honest. Presenting that hand-calc as "validated" is not.

Then **ask the user whether they want to iterate**: apply one or more changes and re-evaluate. Offer three levels of re-evaluation and let the user pick. **Emit the three options as three literal bulleted items — do not collapse them into prose, do not drop any of the three, and do not re-order them. The user picks one by name.**

- **Calculator only** — update the JSON, re-run `calculate_costs.py`, show the new `cost_report.md` and a side-by-side delta. Cheap, no AWS calls, no teardown. This is the default and should be the first offer.
- **Calculator + live validation** — do the above, then offer a second live run against the revised design. Requires the user to re-consent to AWS deployment and accept a second teardown script; the prior teardown should be run first unless the change is additive-only.
- **No changes** — the user may reasonably decide the findings are acceptable, the cost of change outweighs the savings, or the proposed alternatives don't fit a constraint the skill doesn't know about. Record the decision as a "deviation" per Artifact #5 with the user's stated reason.

Do not iterate silently, do not iterate unboundedly. Each iteration is explicit and opt-in; if the user declines or the report surfaces no meaningful findings, stop and hand back the final artifacts.

## Iterative design loop

The three re-eval levels above are run as **rounds** of a human-driven loop, orchestrated by `${SKILL_DIR}/scripts/iterate_design.py`. This is the seamless path for "deploy → test at representative scale → get feedback → change the design → test again."

**What it is — and is NOT.** One invocation = **one round**: optionally apply a user-agreed change → decide reuse-vs-redeploy → (gated) deploy or reuse → benchmark at representative scale → report → **surface findings + suggestions** → STOP. The loop is **human-driven**: you run one round, present the findings and concrete suggestions, and hand back. **The user** decides what to change and prompts the next round. Never self-iterate to convergence; never start a second round in one invocation; the script enforces this (it has no logic to propose or select a change — it only applies the change it is handed).

**Representative mode (honest scope).** The loop runs `mode: "representative"` (see `${SKILL_DIR}/references/performance-model-schema.md`): ~0.10–0.25× declared peak with **zipf hot-key sampling** and **realistic item-collection cardinality**. This surfaces what the 1%-scale unit-cost run cannot — **hot-partition throttling (Mechanics #3), throttle-under-load, GSI amplification at volume, and Query-at-realistic-cardinality**. State the scope plainly to the user: one in-region Lambda drives ~1,500–2,000 RPS/pattern max (32 driver threads), so representative scale is **bounded** — it surfaces hot-partition/throttle risk at bounded cost; it does **not** prove the design sustains declared peak. Per-op cost extrapolation stays linear and valid (per-op CU is scale-invariant, extrapolated against _declared_ peak); the throttle/latency numbers are load-risk signals in the report's "Load-risk signals" section and must never be extrapolated linearly.

**Exceeding one Lambda's ceiling (not yet built).** If a design needs more than one Lambda's ~1,500–2,000 rps/pattern, the path is to invoke the _same deployed benchmark function concurrently_ (Lambda scales horizontally for free — no need to deploy multiple functions), each invocation driving `target_rps / N` of the load, with seeding done once and the results merged (calls/throttles/errors add; per-op CU is a call-weighted average; latency percentiles are recomputed from the pooled per-call latencies the raw rows already carry). This load-sharding is **not implemented yet** — today a single Lambda is the ceiling. Don't promise rates above it; offer representative mode or note the ceiling instead.

**Gated consent every round.** A real deploy and a real teardown each require explicit user consent, every round. The four live-validation facts above (real resources, real charge, sandbox-only, no auto-teardown) apply per round. `iterate_design.py` refuses to deploy without `--yes-deploy`; the benchmark refuses to spend above `cost_guardrail_usd` without `--allow-spend`. The two-phase attested teardown (Live validation step 6) is unchanged and remains the only teardown path — a schema-changing round tells the user to run the prior `teardown.sh` first so no resources are orphaned.

**On-demand vs. provisioned, and why throttles may not appear.** Representative runs deploy on-demand (PAY_PER_REQUEST) by default, matching the skill's Mechanics #19 default. On on-demand, **adaptive capacity isolates and absorbs a single hot key** — a hot partition usually shows up as _elevated tail latency on that partition_, not throttles, because the table auto-scales to serve it. The `key_skew_patterns` signal therefore fires on **either** throttles **or** a hot-partition p99 materially above the cold-partition p99 (a baseline-free, within-pattern comparison), so on-demand designs still get the warning. To observe hard **throttling**, set `provisioned_capacity: {"read": N, "write": M}` in `benchmark_config.json` (or per-table) — a low provisioned ceiling has no adaptive absorption, so a hot partition throttles deterministically; this is also how you validate a _planned_ provisioned capacity. The benchmark Lambda runs with **client-side retries disabled** so throttles are observed and counted, not silently retried away. Be aware a freshly-created provisioned table carries ~5 min of burst capacity that masks throttling at the very start of a short window — use a longer `duration_seconds` or a lower capacity to drain it.

**The round protocol you follow:**

1. Invoke `python3 "$DDB_SKILL_DIR/scripts/iterate_design.py" --model dynamodb_data_model.json --config benchmark_config.json --loop-state loop_state.json --manifest created_resources.json [--apply-change change.json] --mode representative [--timestamp <iso>] [--yes-deploy] [--allow-spend]`. `--timestamp` is **optional** — omit it and the round stamps itself with the current UTC time; pass an ISO string only if you need the loop-state entries to carry a specific clock (e.g. reproducible tests). A round runs a representative benchmark, so the same **execution discipline** as _Live validation_ step 4 applies: invoke it as a **single blocking foreground call and wait** — never background it (a killed round leaves stale artifacts) — and **raise the tool timeout** rather than shrinking windows if needed. Before relaying any result, verify freshness as in step 5 (the round's `loop_state.json` headline and `design_findings.json` derive from the same `perf_summary.json`; if it didn't refresh, the round didn't complete).
2. Read **only** the compact artifacts: `design_findings.json`, `cost_report.md`, and `loop_state.json`. Never read `perf_raw.jsonl` (large) or `performance_report.md` (human-facing).
3. Relay the round's compact summary and the delta-vs-prior-round from `loop_state.json` (e.g. "sharding the PK cut W1 throttles 1450 → 0, p99 −70 ms"). Present each suggested change as a **literal JSON diff on `dynamodb_data_model.json`** (the same diff requirement as the iteration offer above). Then STOP and ask the user what to change, or whether to accept.
4. When the user picks a change, pass it as `--apply-change` next round (a `merge` object or an `ops` list); record their decision for the prior round in `loop_state.json`'s `user_decision`.

**How the three re-eval tiers map onto the loop:** "Calculator only" → `iterate_design.py --calculator-only` (applies the change, re-costs, no AWS); "Calculator + live validation" → a full representative round (gated deploy or reuse); "No changes" → record `user_decision` as a deviation per Artifact #5 and stop. The loop **extends** the offer, it does not replace it. `quick`/`standard` modes remain for one-shot unit-cost validation; `representative` is the loop's mode. Loop state is documented in `${SKILL_DIR}/references/loop-state-schema.md`.

## Security considerations

Security is woven through the axioms above (authorization-aligned keys in Data modeling #14, conditional-write guards in Patterns #2, transactional uniqueness in Mechanics #13). This section consolidates the risks an agent following this skill MUST surface to the user regardless of which axiom is in play, plus the controls specific to the skill's executable scripts. State the relevant ones in any design review; do not assume the user already knows them.

1. **Authorization-boundary alignment (IDOR) is the first security check.** The most common DynamoDB data-exposure bug is a partition key set to a client-supplied identifier (a `review_id`/`order_id` from a URL) instead of the server-derived authorization identifier (`user_id`, `tenant_id`, `account_id`). When they diverge, a caller can pass a foreign key and reach data across the tenancy boundary. Align the partition key with the authorization/tenancy boundary (Data modeling #14) so a foreign key is simply unaddressable; a per-call `ConditionExpression` is discipline, not a structural fix, and does not cover reads (Fact #4). On any design review, evaluate and state this **before** hot-partition, projection, or cost findings.

2. **Encryption at rest — always on; choose the key tier deliberately.** DynamoDB encrypts every table at rest with no way to turn it off. The default is an **AWS-owned key** — no cost, no key management, and the implicit state when no `SSESpecification` is set (which is what the live-validation deploy does; the bench manifest records the at-rest state read back from `DescribeTable`). It is right for ephemeral/bench tables and most workloads. For data under a compliance regime (audit of key usage, independent key rotation/revocation, cross-account key policy, or a regulatory requirement to hold the key), recommend a **customer-managed KMS key (CMK)** — set `SSESpecification` with `SSEType: KMS` and a `KMSMasterKeyId` (note: DynamoDB's only non-default `SSEType` is `KMS`; there is no `AES256` type on DynamoDB), and note the per-request KMS cost and the need for a key policy. Surface the encryption choice in the design (it is one of the per-entity operational-config inputs) rather than leaving it implicit. **Encryption in transit** is always on for every AWS API call these scripts make: boto3 talks to DynamoDB/Lambda/IAM over TLS (HTTPS) by default and there is no plaintext path — agents replicating this pattern should treat all data-in-transit as protected and never disable TLS verification.

3. **Generated artifacts are sensitive — treat them accordingly.** The deploy writes `created_resources.json`, a manifest that contains the AWS **account ID, resource ARNs, and the profile name** used. It is not a secret store (it holds no credentials), but it identifies the account and resources, so do not paste it into a shared channel, commit it to a public repo, or include it verbatim in a report. The skill's scripts never write AWS credentials, tokens, or connection strings to any artifact — keep it that way; if you extend them, do not log credential material.

4. **Benchmark resources go only in a sandbox/test account.** The live-validation deploy creates real, billable resources. It must run only against a sandbox/testing account the user names — never production, never an account holding real user data. The deploy refuses on prod-marker account aliases/ARNs (`prod`/`production`/`prd`/`live`), but the agent is responsible for stating the four live-validation facts and confirming the account's purpose first (see _Live validation_).

5. **Credential hygiene.** Never persist AWS profiles, access keys, session tokens, or `credential_process` blobs into any file the skill generates, and never echo them to output. The scripts authenticate from the ambient AWS credential chain (a named profile, SSO, or environment credentials); they neither read arbitrary environment variables wholesale nor record what they resolved. When you write `benchmark_config.json`, store only the profile _name_ and region — not the resolved credentials behind them.

6. **Vector search does not honour fine-grained access control, and a vector index partition key is not a tenant boundary.** Two distinct hazards, both of which MUST be surfaced on any multi-tenant design that includes semantic search — followed by the compensating detective control they require.

   First, the `dynamodb:` FGAC condition keys — `dynamodb:LeadingKeys`, `dynamodb:Attributes`, `dynamodb:Select` — are absent from the `SearchVectors` request context. A statement whose `Condition` references one therefore does not match, and the outcome is denial rather than a grant. Adding `dynamodb:SearchVectors` to an existing FGAC-conditioned statement silently breaks vector search while that statement's other actions keep working normally, which presents as a broken index rather than a policy fault. Grant `dynamodb:SearchVectors` in its **own** statement, scoped to the index resource ARN (`arn:aws:dynamodb:<region>:<account-id>:table/<table>/index/<index>`), with no `dynamodb:` FGAC conditions attached.

   Second, scoping searches to one tenant's partition-key value is a data-locality and performance optimization, **not** an access-control mechanism. Any principal holding `dynamodb:SearchVectors` on the index can search any partition-key value, and because the FGAC condition keys do not apply you cannot constrain which values they reach at the IAM layer. Where strict tenant isolation at the data layer is required, use separate tables or separate indexes with distinct per-tenant IAM grants; an application layer that injects the caller's tenant identifier and never accepts it from the client is a complement, not a substitute. This is the vector-search form of the authorization-boundary check in item 1 — and unlike the base table, the key schema does **not** make foreign data unaddressable here, so the structural fix is grant separation rather than partitioning. Encryption at rest is inherited from the base table; there is no separate setting for a vector index.

   Third, because grant separation constrains which _index_ a principal may search but never which partition-key values, recommend **CloudTrail data-event logging** on any multi-tenant vector-indexed table as the compensating detective control. It is the only record of which value each principal searched — the precise dimension IAM cannot gate — so a cross-tenant search from a compromised principal or a failed application-layer injection is otherwise unobservable. A CloudWatch alarm on per-principal `VectorSearchRequestBytes` catches partition enumeration as a volume anomaly. Note also that the embeddings are themselves sensitive: similarity results disclose that two records are semantically close even when no raw text is returned, so the vector attribute's exclusion from results by default is a security default worth keeping, and anything logging whole items needs the same care as the table. Full treatment: `${SKILL_DIR}/references/vector-search.md § Security`.

## Best practices

These are recommended defaults, not axioms. They do not shape the design; they are operational safeguards that should be enabled unless a specific reason argues against them. An agent producing a design should turn each of these on unless the justification for disabling is explicit in the artifacts.

1. **Enable deletion protection on every table.** DynamoDB's deletion-protection flag blocks `DeleteTable` at the service boundary until it is explicitly disabled. It costs nothing, has no performance impact, and prevents an entire class of incidents — an IaC misconfiguration, a copy-paste command, a stack tear-down that should have been scoped — from destroying a production table. The one-step disable is cheap when deliberate deletion is genuinely intended; the protection should be on everywhere else.

   Two important details people miss:

   - **Deletion protection defaults to FALSE.** New tables are created without it unless you set `--deletion-protection-enabled` on `create-table` (or the equivalent property in CloudFormation/CDK or any third-party IaC tool). This is why it is so commonly absent on tables that predate the feature or were created without deliberate thought — you have to explicitly turn it on.
   - **Service-boundary protection is not redundant with IaC guards.** CDK `RemovalPolicy.RETAIN`, a third-party IaC tool's prevent-destroy / retain-on-delete guard, and similar mechanisms only protect the IaC path — a direct `aws dynamodb delete-table` CLI call, a different IaC state file targeting the same resource, or a rogue script all bypass them. Deletion protection lives on the table itself at the service boundary and catches every destruction path. Use both together; do not treat IaC guards as sufficient on their own.

2. **Enable point-in-time recovery (PITR) on every table.** PITR provides continuous backup with 35-day retention and per-second restore granularity. Cost is a fraction of storage cost, and the day it is needed — accidental deletion, a bad migration, a logic bug that wrote corrupted values — it is the only thing that recovers the data. Disable PITR only on ephemeral tables whose contents can be rebuilt from another source (idempotency caches, dedupe stores with TTL). PITR divergence across tables is also a modeling signal per Data modeling #3.

3. **Make the table observable — alarms and an audit trail for production tables.** A table with no monitoring fails silently; the first sign of throttling or a runaway cost is often a customer complaint or the monthly bill. For every production table, recommend:

   - **CloudWatch alarms** on `ThrottledRequests`, `SystemErrors`, and `UserErrors` (and, on provisioned tables, on consumed-vs-provisioned capacity). At minimum a starter alarm on `ThrottledRequests > 0` sustained — that is the earliest signal of a hot partition or under-provisioning, and it ties directly to the Mechanics #3 ceilings.
   - **CloudTrail data-event logging** for tables holding sensitive or regulated data, so item-level reads and writes are auditable. CloudTrail captures DynamoDB _management_ events by default; item-level (data) events are opt-in per table and are what an audit or incident investigation actually needs. When the audit/operational logs themselves hold sensitive data, **encrypt the CloudWatch Logs log group (and the CloudTrail trail's S3 bucket) with an AWS KMS customer-managed key** so the logged data is protected at rest, not just the source table.

   These are operational safeguards, not design inputs — but because this skill's guidance is replicated across many customer environments, surfacing them is part of a defensible design rather than an afterthought.

## Reference architectures

Worked examples that apply these axioms end-to-end to a concrete application. Consult when a design question is easier to answer against a running model than against the axioms alone.

- `${SKILL_DIR}/references/reference-architecture.md` — a multi-tenant kanban task-board ("TaskBoard") SaaS on AWS backed by DynamoDB. Covers the access-pattern list, table and GSI layout, Streams fan-out to OpenSearch and EventBridge, authorization-aligned partitioning, real-time delivery, and the trade-offs made at each step. Start here when a user asks about a full-stack DynamoDB design, multi-tenancy, or end-to-end composition of the services around the database.
- `${SKILL_DIR}/references/vector-search.md` — the vector index API surface (`VectorIndexes`, `VectorIndexUpdates`, `SearchVectors`), SearchSchema design, distance functions and score direction, the readiness predicate, projection and immutability rules, silent de-indexing, IAM including the fine-grained-access-control gap, the byte-based cost dimensions, and a troubleshooting table keyed on the service's verbatim error strings. Read this whenever a design or debugging thread involves semantic similarity, RAG retrieval, recommendations, or AI-agent memory (Fact #10, Integration #8). Skip it otherwise.
- `${SKILL_DIR}/references/cost-model-schema.md` — the JSON shape consumed by `${SKILL_DIR}/scripts/calculate_costs.py`. Read this the first time you produce a monthly cost estimate (see _Cost estimation_ above). Skip it for non-cost questions.
- `${SKILL_DIR}/references/performance-model-schema.md` — the JSON shape of `benchmark_config.json` consumed by the live-validation scripts. Read this the first time you run a live validation (see _Live validation_ above). Skip it when live validation is not on the table.
- `${SKILL_DIR}/references/performance-report-format.md` — the structure of `performance_report.md` generated by `${SKILL_DIR}/scripts/generate_perf_report.py`. Read this before interpreting the report or drafting the design-reflection section.
- `${SKILL_DIR}/references/loop-state-schema.md` — the shape of `loop_state.json`, the compact per-round genealogy file written by `${SKILL_DIR}/scripts/iterate_design.py`. Read this when running the iterative design loop (see _Iterative design loop_ above).
