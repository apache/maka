---
name: aws-messaging-and-streaming
description: >-
  Guides general use of AWS messaging and streaming services. Covers Amazon SQS,
  Amazon SNS, Amazon EventBridge, Amazon MQ, Amazon Kinesis Data Streams,
  Amazon Data Firehose, Amazon Managed Service for Apache Flink, and Amazon Managed Streaming for Apache Kafka (MSK).
  Use when reasoning about messaging and streaming patterns.
  Also identifies which AWS service owns each customer communication channel:
  email (Amazon SES), and WhatsApp, SMS, MMS, RCS, voice and mobile push
  (the AWS End User Messaging family of services).
  Routes the request to the specialized skill for that channel.
  Defers to the channel's specialized skill when the user already named a specific channel.
  In general, use specific skills or documentation searches for detailed service-specific questions.
  Do NOT use for MSK or Managed Service for Apache Flink questions, prefer specific skills.
  Does not configure customer communication channels; defers to specific skills.
metadata:
  version: "4"
---

# AWS Messaging & Streaming Services

When answering AWS messaging and streaming questions, verify specific numbers, versions, limits, and behavioral details from service-specific skills or official AWS documentation. When uncertain, search skills or docs rather than guessing. Fabricated configuration options or incorrect version numbers are worse than admitting uncertainty.

When a question asks about recommended configurations (CloudWatch alarm settings, thresholds, missing data treatment), search for the service-specific skills or documentation rather than relying on general best practices.

## Overview

Domain expertise for choosing and using AWS services that move data between producers and consumers.
This skill covers two fundamental patterns — **messaging** and **streaming** — and the AWS services that implement each.
It also marks the boundary with **customer communication** — messages delivered to people rather than to application components — and routes those questions to the skill or AWS documentation that owns each channel (see Customer Communications (Application-to-Person)).
Use this skill to decide which pattern fits a workload, select the right service, and understand how services integrate with each other.

For specific guidance on individual AWS services, see reference files or service-specific Skills.

## Streaming and Messaging

### What Is Messaging?

Messaging enables **decoupled, asynchronous communication** between components. A producer sends a message; one or more consumers receive and process it. Once processed, the message is typically deleted. Messaging services handle delivery guarantees, retries, and dead-letter routing.

**Key characteristics:**

- Messages are consumed once (point-to-point) or fanned out (pub/sub), then removed
- No replay — once acknowledged, a message is gone
- Designed for command/request workloads, task distribution, and event notification

### What Is Streaming?

Streaming enables **ordered, durable, high-throughput continuous data flow**. Producers append records to a log; consumers read from positions in that log. Records persist for a configurable retention period regardless of consumption.

**Key characteristics:**

- Records are retained and replayable within the retention window
- Strict ordering within a partition/shard
- Multiple independent consumers can read the same data at different positions
- Designed for event sourcing, real-time analytics, change data capture, and continuous processing

### Key Differences

| Dimension              | Messaging                                  | Streaming                                   |
| ---------------------- | ------------------------------------------ | ------------------------------------------- |
| **Data lifecycle**     | Deleted after consumption                  | Retained for replay (hours to indefinitely) |
| **Ordering**           | Best-effort (Standard) or per-group (FIFO) | Strict per-partition/shard                  |
| **Consumer model**     | Competing consumers (work distribution)    | Independent readers (fan-out by position)   |
| **Throughput pattern** | Bursty, variable                           | Sustained, high-volume                      |
| **Replay**             | Not supported (except DLQ redrive)         | Native — seek to any position in retention  |
| **Typical latency**    | Milliseconds (push or short-poll)          | Milliseconds to low seconds                 |
| **Scaling unit**       | Concurrency (consumers/pollers)            | Partitions or shards                        |

### Messaging Use Cases

- Decoupling microservices with request/response or command patterns
- Distributing work across a pool of competing consumers (task queues)
- Fan-out notifications where each subscriber acts independently
- Workloads that are bursty and benefit from queue buffering
- Migrating existing JMS/AMQP applications (Amazon MQ)

### Streaming Use Cases

- Continuous, high-throughput data ingestion (logs, metrics, clickstreams, IoT telemetry)
- Event sourcing where consumers need to replay from any point in time
- Multiple independent consumers processing the same data differently
- Real-time analytics, windowed aggregations, or complex event processing
- Change data capture (CDC) pipelines

### Messaging Services

These services are generally used for messaging workloads.
Sometimes streaming services (Kinesis Data Streams, Managed Streaming for Apache Kafka) are also used for messaging workloads, depending on exact use case and requirements.

| Service                | Best For                                      | Key Differentiator                                                                                                                                                            |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Amazon SQS**         | Task queues, decoupling, buffering            | Fully managed, unlimited throughput (Standard), exactly-once (FIFO), fair queues for multi-tenant workloads                                                                   |
| **Amazon SNS**         | Fan-out, pub/sub notifications                | Push to multiple subscribers (SQS, Lambda, HTTP; email/SMS endpoints suit operational alerts — for customer email or SMS see Customer Communications (Application-to-Person)) |
| **Amazon EventBridge** | Event routing, cross-account/SaaS integration | Content-based filtering, schema registry, 200+ AWS source integrations                                                                                                        |
| **Amazon MQ**          | Lift-and-shift of existing JMS/AMQP/MQTT apps | Protocol compatibility (ActiveMQ, RabbitMQ) for legacy migration                                                                                                              |

### Streaming Services

These services are generally used for streaming workloads.

| Service                                     | Best For                                          | Key Differentiator                                                                                                            |
| ------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Amazon Kinesis Data Streams**             | Real-time ingestion with AWS-native consumers     | On-demand Advantage mode (instant scaling, no shard management), 1–365 day retention                                          |
| **Amazon Data Firehose**                    | Zero-admin delivery to storage/analytics          | Auto-scales, buffers, batches, and delivers to destinations                                                                   |
| **Amazon Managed Service for Apache Flink** | Complex stream processing (joins, windows, state) | Full Apache Flink runtime — SQL, Java, Python APIs for stateful computation                                                   |
| **Amazon MSK**                              | Kafka-native workloads, ecosystem compatibility   | Apache Kafka API, Express brokers (3x throughput, 20x faster scaling compared to Standard brokers), broad connector ecosystem |

## Customer Communications (Application-to-Person)

The services above move data application-to-application, between components of the same application.
A separate group of AWS services is application-to-person (A2P): it delivers messages to — or receives them from — recipients outside the application, such as customers and subscribers.
The two groups are not interchangeable.

| Channel              | Service                           | Skill                  |
| -------------------- | --------------------------------- | ---------------------- |
| Email                | **Amazon SES**                    | `amazon-ses`           |
| WhatsApp             | **AWS End User Messaging Social** | `aws-social-messaging` |
| SMS, MMS, RCS, voice | **AWS End User Messaging SMS**    | `aws-sms-voice`        |
| Mobile push          | **AWS End User Messaging Push**   | None                   |

Answer two kinds of question directly from this section: which group a workload belongs to, and which service owns a channel.
For every other customer communication question — setting up a channel, sending through it, or troubleshooting delivery — do not answer from this skill: load the skill named in the table and answer from that.
To load it, use `aws___retrieve_skill(skill_name="<skill>")` with the exact name from the table when the AWS MCP server is available, or read the skill document from the Agent Toolkit at `skills/<skill>/SKILL.md`.
Where the table says None, or the named skill cannot be loaded, say so, then answer using the documentation tools (`aws___search_documentation`, `aws___read_documentation`) if available, or the AWS documentation for the named service otherwise.

## Common Integration Gotchas

- **SQS system vs. user message attributes:** Attributes like `AWSTraceHeader` (set by X-Ray / EventBridge / Pipes when sending to an SQS DLQ) and `SenderId`, `SentTimestamp` are SQS _system_ attributes, NOT user message attributes. They are never returned by default from `ReceiveMessage` — request them explicitly via `AttributeNames=[...]` (or `MessageSystemAttributeNames`), separate from `MessageAttributeNames` which fetches user attributes. This matters for DLQs, where the trace header rides on the system attribute and the user-attributes slot carries the service's failure metadata (e.g. EventBridge's `RULE_ARN`, `ERROR_CODE`).

- **SNS → Firehose → S3 record separator:** For SNS subscriptions using the `firehose` protocol that land in S3, records are already newline-delimited by default (NDJSON). Do NOT turn on Firehose's `AppendDelimiterToRecord` — SNS emits the newline itself, and enabling the processor produces double newlines.

- **EventBridge rule target DLQ + SNS subscription DLQ both need a DLQ queue policy.** Attaching the DLQ alone is not enough — the DLQ silently drops messages until its queue policy allows the service principal. EventBridge: `PutTargets` with `DeadLetterConfig.Arn=<DLQ>`, plus SQS policy `Allow sqs:SendMessage` for `Service: events.amazonaws.com` with `aws:SourceArn` = the rule ARN. SNS: `SetSubscriptionAttributes` `RedrivePolicy={"deadLetterTargetArn":"<DLQ>"}`, plus SQS policy allowing `Service: sns.amazonaws.com` scoped by the topic ARN.

- **SQS production defaults: long polling + customer-managed encryption.** New queues default to short-poll (`ReceiveMessageWaitTimeSeconds=0`) and SSE-SQS (AWS-owned key). For production, `SetQueueAttributes` with `ReceiveMessageWaitTimeSeconds=20` (long polling) and `KmsMasterKeyId=<customer-managed key id/ARN>` rather than leaving `alias/aws/sqs`.

- **Broker and Kafka credentials belong in Secrets Manager, not connection strings.** Do not hardcode usernames, passwords, or SASL/SCRAM credentials in application config, env vars, JAAS files, or IaC. For Amazon MQ (ActiveMQ/RabbitMQ) store broker users as secrets and fetch at startup; Lambda event source mappings for Amazon MQ require the broker credentials to be supplied as a Secrets Manager secret ARN (`BASIC_AUTH`), not inline. For MSK SASL/SCRAM the secret is not optional: it must be named with the `AmazonMSK_` prefix and encrypted with a **customer-managed** KMS key (secrets created with the default `aws/secretsmanager` key cannot be associated with a cluster), then attached via `BatchAssociateScramSecret`. Lambda event source mappings for MSK (SASL/SCRAM or mTLS) and self-managed Kafka also reference a Secrets Manager secret ARN rather than inline credentials. Enable rotation and scope IAM read access (`secretsmanager:GetSecretValue`) to the consuming role only. See AWS Well-Architected [SEC02-BP03 Store and use secrets securely](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_identities_secrets.html).

- **Service-principal resource policies need `aws:SourceArn` / `aws:SourceAccount` conditions.** When a queue or topic policy grants a service principal like `events.amazonaws.com`, `sns.amazonaws.com`, or `s3.amazonaws.com` permission to `sqs:SendMessage` or `sns:Publish`, omitting source conditions opens a confused-deputy hole — any rule, topic, or bucket in any AWS account can drive writes. Scope every such statement with `aws:SourceArn` (the specific rule/topic/bucket/pipe ARN; use `ArnLike` with `*` when the ARN isn't fully known yet) and `aws:SourceAccount` (your account ID). For S3 event notifications both keys are required because S3 bucket ARNs don't carry the account ID, so `aws:SourceArn` alone doesn't constrain the account. The same pattern applies to role trust policies for IAM roles used by EventBridge rules and EventBridge Pipes (principal `events.amazonaws.com` / `pipes.amazonaws.com`, `aws:SourceArn` = the rule or pipe ARN) — not just the DLQ case called out above. See the IAM User Guide on [The confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html).
