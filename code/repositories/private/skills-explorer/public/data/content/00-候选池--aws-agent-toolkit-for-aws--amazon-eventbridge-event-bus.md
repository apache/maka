---
name: amazon-eventbridge-event-bus
description: Builds, runs, debugs, and operates event-driven applications using EventBridge Event Bus - a managed, centrally governed publish/subscribe event bus that an organization can share across many teams and accounts. Applicable when workloads need event-driven architectures, decoupling, choreography, asynchronous integration, pub/sub, fan-out, event ordering, delivered in sequence, event router, event broker, event bus, event store, event retention, event replay, deduplication, avro, protobuf, cloudevents, uses events or messages. Designed as a centrally managed event bus platform allowing governance and control - such as subscriber control, revocation, per-account throttling - while giving application owners flexibility across an organization spanning multiple accounts, with end-to-end open-standards observability and cost allocation. Also helps reduce costs in high fan-out scenarios where multi-account forwarding adds cost. A serverless, managed alternative to self-managed event streaming platforms.
version: 2
---

# Building with the new EventBridge custom event buses

## Overview

The new EventBridge custom event bus routes events and retains them. You publish with
one of two APIs, and subscribers filter, optionally transform, and deliver each matching event to one target.

**Read chapters 5 and 6 before writing any filter, transformer, or target parameter.** The two publish APIs
deliver different payload shapes, and an expression written for one silently matches nothing against the
other.

Publish metrics are on by default, so you can always tell whether events reached a bus. Subscriber logs
are **off** by default, so turn them on before you debug a delivery rather than after (chapter 18).

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/), which is recommended for
running the CLI calls in this skill: it executes them in a sandboxed environment with audit logging. All
guidance also works with standard AWS CLI access.

## Conventions

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** in this skill are to be interpreted as
described in RFC 2119. They appear only in decision procedures, where following the wrong course either
breaks the configuration or loses events silently. **MUST** marks an absolute requirement, **SHOULD** a
strong recommendation you may have a specific reason to set aside, and **MAY** a genuine option.

Everything else is ordinary description. A sentence stating how the service behaves carries no keyword,
because it is a fact rather than an instruction to you.

## When not to use this skill

This skill is only about the new custom event buses, the service you reach with the `eventsv2` CLI
and the `eventbridgev2` SDK clients. It does not cover:

- **Classic EventBridge**, meaning the `events` API with rules, targets, archives, and event patterns on
  `AWS::Events::Rule`. The two services share the `events:` IAM namespace and some vocabulary, which is
  exactly why they are easy to confuse. If you are writing a rule, you are not on a new bus. Chapter 3
  maps the concepts across if you are migrating.
- **EventBridge Pipes, Scheduler, and Schemas** (the classic schema registry and its discovery feature).
  Different APIs.
- **Configuring the Firehose service itself**, such as buffering hints or record transformation. A
  Firehose delivery stream is a valid subscriber target; chapter 9 covers that side of it.

## Trigger examples

1. "Write a filter so this subscriber only gets orders over $500."
2. "My producer says PUBLISHED but nothing shows up in the queue. What do I check?"
3. "Should I use PutEvents or PutRawEvents for Protobuf payloads?"
4. "Set up a subscriber that reprocesses everything from the last two days."
5. "Write a JSONata expression that pulls the customer id out of the event into a DynamoDB putItem."

## Guardrail — where this skill's own files live (MCP vs local install)

This skill can be loaded two ways, and they resolve the skill's own bundled
files from different places. Determine how the skill was loaded before reading
a reference:

- **Loaded through the AWS MCP `retrieve_skill` tool:** The skill is not
  installed on the local filesystem. You MUST fetch each reference via
  `retrieve_skill` with the `file` parameter (e.g.
  `file="references/setup-walkthroughs.md"`). Do NOT `file_read` these paths
  locally — they do not exist on disk.
- **Installed locally** (e.g. `.kiro/skills/amazon-eventbridge-event-bus/` or
  `~/.claude/skills/amazon-eventbridge-event-bus/`): Read files from the local
  skill directory using relative paths.

This distinction applies only to the skill's own packaged files. User data and
session artifacts are always read from and written to the user's working
directory. Never fetch or write customer data through `retrieve_skill`.

## Reference files

The chapters below carry the decisions and the failure modes; the detail lives in these files. Load a
file when the task matches its row, and do not load them all by default.

| File                                                                  | When to load                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [setup-walkthroughs.md](references/setup-walkthroughs.md)             | standing up a working bus end to end, in one account or shared across accounts with AWS RAM, including prerequisites and teardown                                                                                     |
| [code-samples.md](references/code-samples.md)                         | writing an individual CLI or SDK call (Python, Java, TypeScript): create a bus and subscriber, publish with either API, binary payloads, replay, cross-account grants, waiters, per-entry results, throttling backoff |
| [filters-and-expressions.md](references/filters-and-expressions.md)   | writing any filter pattern, JSONata expression, or target parameter that reads the event; both delivered envelopes in full                                                                                            |
| [target-configuration.md](references/target-configuration.md)         | configuring any subscriber target, especially a universal target                                                                                                                                                      |
| [target-contract.md](references/target-contract.md)                   | writing an actual `CreateSubscriber` call: required fields, a working example per target type, literal versus JSONata, the delivery error taxonomy                                                                    |
| [migrating-from-classic.md](references/migrating-from-classic.md)     | migrating from classic EventBridge, planning the migration sequence, or classic habits producing wrong new-bus config                                                                                                 |
| [event-sources.md](references/event-sources.md)                       | putting AWS service events or partner events on a bus with an event source, or forwarded events not arriving or not matching a filter                                                                                 |
| [provisioning-and-state.md](references/provisioning-and-state.md)     | creating or updating a bus, or a resource stuck in an unexpected state                                                                                                                                                |
| [delivery-troubleshooting.md](references/delivery-troubleshooting.md) | an event published but never arrived, or building a test rig that counts deliveries correctly                                                                                                                         |
| [authorization.md](references/authorization.md)                       | writing an IAM policy or bus resource policy, cross-account access checks, or anything that forwards events into a bus                                                                                                |
| [replay-and-recovery.md](references/replay-and-recovery.md)           | reading history rather than new events, pausing or resuming, or a replay that looks broken                                                                                                                            |
| [observability.md](references/observability.md)                       | setting up metrics, alarms, or the vended-log delivery; reading delivery logs; observing across accounts                                                                                                              |
| [schema-registries.md](references/schema-registries.md)               | publishing Avro, Protobuf, or anything that is not JSON; the accepted content types; running alongside Kafka                                                                                                          |
| [cloudevents.md](references/cloudevents.md)                           | publishing or consuming CloudEvents, or filtering on CloudEvents attributes                                                                                                                                           |
| [security-and-sharing.md](references/security-and-sharing.md)         | encrypting a bus, sharing it cross-account, or tagging                                                                                                                                                                |
| [cost-and-quotas.md](references/cost-and-quotas.md)                   | billing mechanics, who pays what across accounts, shaping events for cost, or handling throttling                                                                                                                     |
| [infrastructure-as-code.md](references/infrastructure-as-code.md)     | writing a CloudFormation template, splitting stacks across accounts, or private connectivity                                                                                                                          |

---

## 1. The three resources

**Event bus.** The thing you publish to. It routes events and retains them.

**Subscriber.** A statement of which events you want and where to send them, in one resource. It watches its
bus, keeps the events matching its filter, optionally transforms each one, and delivers it to exactly one
target. To send one event to several targets, create several subscribers on the same bus.

**Event source.** A managed feed into a bus, either AWS service events or a partner/SaaS source.

Names and identifiers:

- A bus ARN and a subscriber ARN both end in a service-generated id after the name:
  `arn:aws:events:us-east-1:111122223333:event-busv2/my-bus/exampleid0123456789abcdef`.
  **Store the full ARN, not the name**, because the name alone does not identify the resource and
  re-creating a deleted bus with the same name yields a different id.
- Event source names are unique per account, not per bus.
- **Three names identify this service and they do not match.** The CLI command and the endpoint host
  are `eventsv2`, as in `aws eventsv2 create-event-bus` and `eventsv2.{region}.amazonaws.com`. The SDK
  clients are `eventbridgev2`. IAM actions and ARNs are `events`, shared with classic EventBridge, as
  in `events:PutEvents` and `arn:aws:events:...:event-busv2/...`. See chapter 14.

## 2. A router with a durable log behind it

The bus routes each event to matching subscribers, and it also retains events for a configured period,
set per bus with `StorageConfiguration.RetentionPeriodInDays` (1 to 365 days). Retention is what makes
four other features possible: starting positions, pausing and resuming, replay, and a subscriber created
today reading events published yesterday. The retention window is clamped at the bus's creation time, so
on a young bus even a recent past timestamp can fall outside it.

## 3. Coming from classic EventBridge

A classic rule plus its target becomes one subscriber on the new bus. Four new-bus concepts have no
classic analogue: retention on the bus itself, a subscriber starting position, pause and resume with a
backlog, and two publish APIs with different payload models. That last changes how you write filters, so
a classic event pattern ported unchanged works only for `PutEvents`. The concept mapping, the habits that
carry over incorrectly, and a step-by-step migration sequence are in
[migrating-from-classic.md](references/migrating-from-classic.md).

## 4. AWS service and partner event sources

An **event source** is a managed feed onto your bus. You create one naming a destination bus and one
origin, and the service stands up the forwarding on the classic EventBridge side for you. **There is no
role and no delivery code**: the managed path uses the service's own identity.

`Configuration` is discriminated and exactly one variant MUST be set:

| Variant                         | Origin                         | Required member         |
| ------------------------------- | ------------------------------ | ----------------------- |
| `AwsServiceEventsConfiguration` | one AWS service, as `aws.s3`   | `AwsService`            |
| `PartnerEventsConfiguration`    | a classic partner event source | `PartnerEventSourceArn` |

Both take an optional `Pattern`, which narrows what forwards and is evaluated on the classic side against
the classic envelope. **Your pattern MUST NOT carry a `source` key or a top-level `account` or `region`**,
because the service sets those itself to pin the forward to your account and origin.

**A forwarded event arrives as the whole classic envelope.** `Data` holds it, `ContentType` is
`application/eventbridge+json`, your content is at `$events.Data.detail`, and the source and detail-type
are in `SystemMetadata` as **`aws:Source` and `aws:DetailType`**. So a classic rule's `source` filter does
not transfer: the equivalent is a `SYSTEM_METADATA` filter, `{"aws:Source":["aws.s3"]}`.

**Only that `SystemMetadata` pair proves an AWS service or partner produced the event.** No publish call
can write either key. A raw payload can imitate the envelope exactly, so a `DATA` filter on the payload's
`source` matches a forgery as readily as the real thing. **You SHOULD filter on `aws:Source` whenever
provenance matters**, and MUST match its value rather than its presence, because a direct `PutEvents` sets
the key too, from its own never-`aws.`-prefixed `Source`.

`EventBusArn` is immutable. Recovery splits by failure: from `CREATE_FAILED` or `UPDATE_FAILED`,
`UpdateEventSource` converges the classic side back to your record, while from `DELETE_FAILED` the only
recovery is another delete.

**A bus owner's control is at create time.** `CreateEventSource` is authorized against the destination bus
with an `events:source` condition key, and `RevokeResource` is how an owner stops a feed that already
exists (chapter 22). Prerequisites, encryption, dead-lettering, and what appears in your classic account
are in [event-sources.md](references/event-sources.md).

## 5. Choosing a publish API

The choice fixes the payload shape, and the payload shape determines every filter, transformer, and
target parameter you go on to write.

|                           | `PutEvents`                                                     | `PutRawEvents`                                     |
| ------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| Payload field             | `Detail`, a JSON string                                         | `Data`, a base64 blob                              |
| Payload must be JSON      | Yes                                                             | No, any format                                     |
| Required per entry        | `Source`, `DetailType`                                          | `Data`, `SystemMetadata`                           |
| `ContentType`             | Not accepted; the service stamps `application/eventbridge+json` | **Required**, inside each entry's `SystemMetadata` |
| Classic-style fields      | `Resources`, `Time` available                                   | Not present                                        |
| Your own metadata         | No                                                              | `Metadata`, up to 100 keys                         |
| Ordering and dedup inputs | `SystemMetadata.EventGroupId`, `SystemMetadata.DeduplicationId` | Same two fields                                    |

Use `PutEvents` for JSON events where you want the classic-shaped envelope. Use `PutRawEvents` for binary
or non-JSON payloads, your own metadata keys, or a payload delivered exactly as sent.

Both return one result entry per request entry in the same order, so you correlate by index. Each carries
either a `SuccessCode` or an `ErrorCode` and `ErrorMessage`. `SuccessCode` is `PUBLISHED` or `DEDUPLICATED`,
and **`DEDUPLICATED` is a success, not an error.** Code that treats every success as a new event makes
deduplication look like delivery.

Publishing Avro or Protobuf requires a schema registry named on each publish request, not on the bus; a
registry configured in the wrong place leaves your events undecoded. `application/octet-stream` needs no
registry, because the service does not decode those bytes at all
([schema-registries.md](references/schema-registries.md)).

## 6. Addressing: where every field lives

Filters, transformers, and target parameters share one addressing model, and **it is not the same for
the two publish APIs.** Every event is delivered under three top-level names: `Data` (the
payload), `Metadata` (your own keys, `PutRawEvents` only), and `SystemMetadata` (service-assigned and
ordering fields). A raw-published payload sits directly in `Data`; a `PutEvents` payload sits inside the
classic envelope, one level down under `detail`. So the same field is `$events.Data.m` for one API and
`$events.Data.detail.m` for the other, and the wrong form does not error: it resolves to nothing, the
filter matches nothing, and the transformer emits nothing. If you publish through both APIs onto one bus,
write expressions that work for both, or give each traffic type its own subscribers; no addressing form
spans both. Both envelopes in full, with every `SystemMetadata` field, are in
[filters-and-expressions.md](references/filters-and-expressions.md).

## 7. Filtering

A subscriber's `FilterConfiguration` holds a list of `Filters`, and **an event must match every filter in
the list to be delivered**: the filters are ANDed, not ORed. Each filter has a `Pattern` and a `Scope`
(`DATA`, `METADATA`, or `SYSTEM_METADATA`), one filter per scope. A `DATA` pattern is written against the
chapter 6 shape, so one pattern cannot serve both publish APIs; each is correct for exactly one API and
silently matches nothing for the other. `FilterConfiguration` is optional on create, and a subscriber
without one receives every event on the bus. A filter that matches nothing is indistinguishable from a
broken subscriber, so confirm a should-match and a should-not-match case by observing the target.

## 8. Transformation

A subscriber's `Transformer` has three types: **`RAW`** (the default) delivers the payload alone,
**`WITH_METADATA`** delivers the three-part envelope, and **`JSONATA`** delivers the result of an
expression. A JSONata expression is wrapped in `{% %}` delimiters and sees the event as `$events`,
addressed exactly as in chapter 6. Most scalar target parameters also accept an expression in the same
form. Some members refuse one and **MUST** be literals: an API Gateway header name, a message
attribute's `BinaryValue`, and `InvocationType`. An expression is only syntax-checked at create, so its
result is a delivery-time fact. A `JSONATA` transformer whose expression throws, or evaluates to nothing,
is a customer-fault delivery failure, so you **SHOULD** test it.

## 9. Targets and their parameter blocks

`InvokeConfiguration` carries the `TargetArn`, the `RoleArn`, and **at most one parameter block, matching
the target**. A universal target **MUST** carry its block; every typed block may be omitted. A classic bus
and a Firehose delivery stream are both valid targets that take no block at all.

**The service resolves the target type from the ARN and checks the invariants it owns before storing
anything**: that the block matches the target, that the ARN's region, partition and account are its own,
and that every expression parses. **It does not mirror the target API's own parameter grammars, value
ranges, identifier limits, or which members that API requires** — those stay with the target, so a request
the target will reject is accepted at create and fails at delivery.

1. **You MUST supply the parameter block a universal target requires.** A typed block may be omitted:
   `KinesisParameters: {}` is stored, and Kinesis reports the missing `PartitionKey` when it is called.
2. **You MUST NOT put a constant in a per-message field**, because a constant deduplication id makes the
   target discard everything after the first message. Neither form is checked against the target's range,
   requiredness or FIFO applicability, so a bad or missing value is a delivery failure.
3. **You SHOULD check the target service's own rules.** Existence, reachability, authorization, size
   after enveloping, and its API's required fields are enforced by the target, at delivery.
4. **You SHOULD confirm at the target**, because a `PUBLISHED` response is not delivery, and neither is
   an HTTP 200 from a batch API, which can carry individually failed entries.
5. **You MUST attach a dead-letter queue and turn on logs before you test, and MUST grant the delivery
   role `sqs:SendMessage` on that queue**, because a failure otherwise leaves no signal anywhere.

Each rule's failure mode, the exact rejection messages, and the per-target blocks are in
[target-configuration.md](references/target-configuration.md). Before writing the call itself, load
[target-contract.md](references/target-contract.md) for the required-field lists, one working example per
target type, and the delivery error taxonomy.

## 10. Universal targets

A universal target invokes any supported AWS API directly, with no intermediate function. The target ARN
has a fixed shape:

```
arn:{partition}:events:::aws-sdk:{service}:{apiAction}
```

Four things to get right, each of which fails at create time with a message that names the problem:
`apiAction` is camelCase with a lowercase first letter (`putItem`); `service` is the SDK service id,
which is not always the obvious word (Step Functions is `sfn`); `UniversalTargetParameters.Input` is
required and holds the API request as JSON or a JSONata expression producing it; and
`BatchConfiguration` is required. The service's validation text abbreviates universal target as "USI
target"; the two mean the same thing.

## 11. Ordering and deduplication

**Ordering** is a subscriber property. `Type` is `UNORDERED` (no guarantee) or `FIFO` (ordered within an
event group), and events are grouped by `SystemMetadata.EventGroupId` at publish time. A FIFO target
enforces its own length and character limits on the group id, and an undeliverable event holds up the
later events in **its own group** while other groups on the same subscriber keep flowing, so keep group
ids bounded and do not derive them from unbounded input.

**Deduplication** happens at publish time, two ways. `DeduplicationConfiguration.DeduplicationType:
CONTENT_BASED` on the request hashes the event content, and `CONTENT_BASED` is the only
`DeduplicationType` value. To deduplicate on your own key instead, omit `DeduplicationConfiguration`
and set `SystemMetadata.DeduplicationId` on each entry. A suppressed duplicate returns
`SuccessCode: DEDUPLICATED` either way.

Keep the two ideas separate. Bus-level deduplication decides whether an event is accepted. A FIFO
target's own deduplication id, set in the target parameter block, decides whether that target accepts the
delivery. Different fields at different layers, and the second is a per-message value (chapter 9, rule 2).

## 12. Retries and dead-lettering

`RetryPolicy` has three members:

| Member                 | Range    | Default |
| ---------------------- | -------- | ------- |
| `MaxRetryAttempts`     | 0-185    | 5       |
| `MaxEventAgeInSeconds` | 60-86400 | 300     |
| `RetryStrategy`        | `ALL`    | `ALL`   |

Delivery stops at whichever limit is reached first, and a failing delivery is retried until then. So **a
conclusion that "nothing arrived" is only safe after the `MaxEventAgeInSeconds` window has elapsed.**

`OnFailureConfiguration.Arn` names an SQS queue for dead-lettering, and SQS is the only supported
destination. **An event source refuses a FIFO queue there**, with the single message
`OnFailureConfiguration.Arn must name a standard SQS queue: FIFO queues are not supported as EventSource dead-letter queues`;
a subscriber accepts one, so the two
resources differ on this point. Two further limits to plan around: a dead-letter record identifies failed
events by id and timestamp and **does not carry the payload**, so replaying it needs the event still
inside retention; and **the dead-letter queue must be writable by the delivery role**, or the failure has
nowhere to go and the events disappear with no signal.

## 13. Delivery permissions

`InvokeConfiguration.RoleArn` is the role the service assumes to invoke your target. It **MUST** belong to
the calling account, its trust policy **MUST** allow the `events.amazonaws.com` service principal, and that
policy **SHOULD** condition on `aws:SourceAccount` and `aws:SourceArn`. It **MUST** carry the action the
target requires (`sqs:SendMessage`, `sns:Publish`, `lambda:InvokeFunction`, `kinesis:PutRecords`,
`states:StartExecution`, or whatever your universal target calls), and **`sqs:SendMessage` on your
dead-letter queue**, or deliveries fail, no failure record is written, and nothing is observable.

`CreateSubscriber` also enforces `iam:PassRole` on that role, so a role you cannot pass fails with
`AccessDeniedException` before target validation runs. The list understates four: Kinesis delivery calls
`PutRecords`, Firehose `PutRecordBatch`, API Gateway needs `execute-api:Invoke`, an API destination
`events:InvokeApiDestination`.

The target ARN is checked at create for shape, type, region, partition and **account**, but **not for
existence or reachability**: a well-formed ARN naming nothing is stored and fails at delivery.

## 14. Authorization: what your caller needs

Chapter 13 covers the role EventBridge assumes to invoke your target. This chapter covers what your
caller needs to reach the API.

**Every action name is `events:`.** The CLI command and the endpoint host are `eventsv2`, and the SDK
clients are named `eventbridgev2`, but the IAM namespace is `events`, shared with classic EventBridge. **You
MUST NOT write `eventbridgev2:` or `eventsv2:` in an IAM policy**, because neither names an action that
exists, and both fail closed: the policy is accepted and grants nothing. A policy written from the command
you just ran, granting `eventsv2:PutEvents`, is the usual way this happens. The name-by-name map is
in [authorization.md](references/authorization.md).

**Publishing** is authorized against the bus ARN, per entry, with no partial authorization: if one entry
fails a condition check the whole request is denied, so a batch is only as authorized as its least
authorized entry.

**Creating a subscriber or an event source is authorized against the bus**, which makes the bus the
cross-account grant point: a bus owner decides there whether another account may attach anything.

**Forwarding into a bus** under a role you supply is authorized at ingestion, per event: a genuine AWS or
partner event needs `events:PutEvents`, and anything you originated needs `events:PutRawEvents`. **So a
forwarder carrying both kinds MUST be granted both actions**, because granting one silently denies half
the stream. The condition keys, the per-create checks, and revocation semantics are in
[authorization.md](references/authorization.md).

## 15. Provisioning and resource state

Creating a bus is asynchronous: `CreateEventBus` returns with `State: CREATING`, and the bus becomes
usable later. **Use the waiter rather than a hand-rolled poll**, because it fails fast on the failure
states and surfaces `StateReason` instead of spinning to a timeout:

```
aws eventsv2 wait event-bus-active  --event-bus-arn "$BUS_ARN"
```

A bus has seven states, and the asymmetry that matters is between the two failure states: **`UPDATE_FAILED`
is recoverable in place, and `CREATE_FAILED` is not.** A failed create permits only delete, so that bus
must be deleted and recreated. Delete subscribers and event sources before the bus; a bus that still has
either rejects `DeleteEventBus` with `ResourceInUseException`, and the message names which kind is
blocking. Revoked subscribers and event sources do not block the delete.

**Creates are idempotent through `ClientToken`.** `CreateEventBus`, `CreateSubscriber`, and
`CreateEventSource` each accept one, and a retry carrying the same token returns the original result
rather than creating a second resource. An SDK generates a fresh token per call when you omit the field,
so a retry your own code issues builds a new request, gets a new token, and creates a second resource.
**So you MUST supply your own `ClientToken` whenever a retry can cross a process, a queue, or a workflow
step.** The mismatch error and the naming collision are in
[provisioning-and-state.md](references/provisioning-and-state.md).

## 16. Updating safely

One rule governs every update API, and getting it wrong silently discards configuration you did not
intend to change:

**An omitted top-level member means unchanged. A supplied configuration block replaces that whole block.**

So an update that supplies `Configuration` or `FilterConfiguration` or `LogConfiguration` in order to
change one field inside it **clears every other field in that block.** An event source updated with its
`Pattern` omitted comes back with no pattern at all, widening its filter to everything, with no warning.
**So you MUST read the resource, modify the whole block, write the whole block back, and then read it
back again**, because reading it back is the only way to confirm what was stored.

## 17. Pausing, resuming, and replay

There is no separate replay API. Replay is a subscriber's starting position, evaluated against the bus's
retained events, so anything still inside retention can be reread.

- **`StartingPosition`** at create time is `LATEST` (only events published after the subscriber exists) or
  `POINT_IN_TIME` (from a point in retained history).
- **Pausing** is `State: STOPPED` on `UpdateSubscriber`. The backlog accrues, bounded by retention, and
  `ResumePosition` decides whether the backlog is delivered or skipped on resume.
- **Replayed events are marked.** `SystemMetadata."aws:DeliveryType"` reads `REPLAY` instead of `LIVE`, so
  a consumer can make replay idempotent.
- **A replay has a startup delay, then runs at live speed**, so allow for the delay before concluding a
  replay is broken.

## 18. Observability: metrics and logs

Two surfaces tell you what the service is doing, and their defaults are opposite.

**Publish metrics are on by default**, in the `AWS/EventsV2` namespace, on the tuple `{EventBus}` plus
`{EventBus, EventSource}` for traffic attributed to an event source and `{EventBus, PublisherAccount}` for
ingress bytes. `PublishEventsApproximateCallCount` against `PublishEventsApproximateSuccessCallCount` is
the cheapest check that your producer is reaching the bus at all. **The outcome metrics count calls, not
events**, so a call that returned a response counts as a success even when every entry in it was rejected;
`PublishEventsEntryCount` against `PublishEventsFailedEntriesCount` is what says whether events landed.
**The `EventBus` dimension value is not the bus ARN**; querying with the ARN returns no data and looks
identical to no traffic.

**Subscriber logs are off by default**, and they need two things before they exist: `LogConfiguration.Level`
raised above `OFF`, and a CloudWatch Logs vended-log delivery wiring the subscriber to a log group. Set
both up _before_ debugging a delivery, not after. The delivery setup, the metric list, and the
`EVENT_DELIVERY_ATTEMPT` record fields are in [observability.md](references/observability.md).

## 19. Verifying delivery

A publish response tells you the service accepted the event. It says nothing about delivery. To know an
event arrived, look at the target.

**A healthy delivery reaches the target quickly, so an event that has not arrived promptly is probably
failing rather than in flight.** But "nothing arrived" is only sound after the retry window elapses,
because until then a failing delivery is still being retried.

Two counting mistakes make a working setup look broken. Reading an SQS queue without deleting the messages
re-reads them, so raw counts overstate deliveries. And a shared target accumulates messages from earlier
runs, so use a fresh target per experiment or a marker unique to the run.

## 20. When it published but never arrived

Nearly every delivery problem presents identically: the publish succeeded and the target is empty. **You
SHOULD work the ordered procedure** in [delivery-troubleshooting.md](references/delivery-troubleshooting.md);
it covers eleven causes ordered by how often each is the answer.

Three shortcuts that do not require opening the file:

- **You SHOULD check `PublishEventsEntryCount` first** (chapter 18). Zero means the problem is upstream of
  the bus and nothing downstream matters yet.
- **You SHOULD turn on subscriber logs.** `INFO` with `IncludePayload: FULL` shows the per-attempt error
  and the exact `target_input` sent, without waiting for retries to exhaust.
- **To see the event as the service sees it**, you MAY add a second subscriber with
  `Transformer: { Type: WITH_METADATA }` and no filter, pointed at a queue you own.

## 21. Errors and client retries

**Batch responses are per entry.** A publish can return success at the request level with individual entries
failed, so check `FailedEntryCount` and every entry, not just the HTTP status.

**Some malformed input fails the whole request instead of one entry.** Anything caught while deserializing
the request rejects the entire batch and takes the valid entries with it. Validate per entry client-side,
and keep batches small enough that losing one is cheap.

**Retryable errors.** `ConcurrentModificationException` and `ThrottlingException` are retryable with
backoff. `InvalidInputException`, `AccessDeniedException`, `ResourceNotFoundException`, and
`IdempotentParameterMismatchException` are not; fix the request.

**Treat a persistent 500 as a client-side wire-type problem first.** The usual cause is a value sent as the
wrong JSON type, such as a number where a string is expected or an ISO-8601 string where epoch seconds are.
An SDK retries a 500 by contract, and retrying cannot fix a malformed request, so check your types before
escalating.

## 22. Security, encryption, sharing, tagging

- **Encryption** is `EncryptionConfiguration.KmsKeyIdentifier` on the bus. Your caller needs
  `kms:DescribeKey` on the key at create time, and on a CMK bus **every publisher needs `kms:Decrypt` on
  that key too**, because a caller who cannot read the bus's events back is not allowed to write them. An
  unusable key policy on the service's side settles the bus at `CREATE_FAILED` with
  `StateReason: KMS_ACCESS_DENIED` instead ([security-and-sharing.md](references/security-and-sharing.md)).
- **To share a bus with another account, use AWS RAM.** Resource policies are the fallback for what RAM
  cannot express, and a hand-written policy is invisible to RAM, so you then own tracking it.
- **Some operations are restricted to the bus owner**, including revoking a shared resource, so a permission
  grant alone is not always sufficient. **Revocation is terminal and scoped to the one resource you
  name**, so stopping an account rather than a resource means also denying it `events:CreateSubscriber`
  and `events:CreateEventSource` in the bus resource policy
  ([authorization.md](references/authorization.md)).

## 23. Cost, quotas, and platform integration

Four things that change design decisions. Current prices and quota values are on the
[EventBridge pricing page](https://aws.amazon.com/eventbridge/pricing/) and in Service Quotas, not here.

- **Billing rounds up per KB** on both ingestion and delivery, so many tiny events cost more than the byte
  total suggests; batching related facts into one event is cheaper.
- **"Enriched operations" are billed separately**: JSONata evaluation, schema deserialization, and
  `CONTENT_BASED` deduplication. So prefer a per-entry `DeduplicationId`, with no
  `DeduplicationConfiguration`, when you already have an idempotency key.
- **Publishing is throttled per account across both publish APIs**, so a service splitting traffic between
  them draws from one budget. Subscriber management has its own per-account limit, so `CreateSubscriber`
  and `DeleteSubscriber` can be throttled while publishing has headroom. Handle `ThrottlingException` with
  backoff (chapter 21).
- **CloudFormation covers the new buses under `AWS::EventsV2::`**, with three types. Six subscriber
  properties are create-only and replacement is delete-then-create, so changing a target ARN in a template
  can silently drop events published during the gap.
