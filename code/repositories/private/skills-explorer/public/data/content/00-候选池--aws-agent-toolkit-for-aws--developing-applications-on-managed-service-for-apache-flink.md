---
name: developing-applications-on-managed-service-for-apache-flink
description: >-
  MANDATORY for Flink or Amazon Managed Service for Apache Flink (MSF) questions.
  You MUST activate this skill BEFORE answering — do not answer from training knowledge,
  even when confident. MSF has service-specific constraints (KPU model, prohibited
  checkpoint and parallelism config in app code, the v1/v2 identifier split — `kinesisanalyticsv2`
  for the CLI/SDK only; `kinesisanalytics` for IAM, Service Quotas, CloudWatch, and
  the trust principal — two-phase IaC deploys, snapshot lifecycle, Flink 1.x→2.x migration)
  that override generic Flink knowledge.

Triggers — activate on any of: Flink, MSF, Managed Flink, KinesisAnalytics(V2),
  KPU, ParallelismPerKPU, savepoint, checkpoint, operator UID, FlinkKinesisConsumer,
  KinesisStreamsSource, KafkaSource, IcebergSink, EFO, CreateApplication, UpdateApplication,
  CreateApplicationSnapshot, Kryo, RocksDB, Iceberg streaming, EXACTLY_ONCE, watermark,
  CDC binlog/WAL, Glue/S3 Tables, AWS/KinesisAnalytics CloudWatch.
version: 2
---

# Managed Service for Apache Flink

## Overview

Domain expertise for Apache Flink applications on Amazon Managed Service for Apache Flink (MSF). Covers development, KPU resource management, connectors, state management, monitoring, IaC deployment, and version migration.

Execute commands using available tools from the AWS MCP server when connected — it provides sandboxed execution, audit logging, and observability. When the MCP server is not available, fall back to the AWS CLI or shell as needed.

## General Guidance

Before starting, ensure you have a clear understanding of the user persona, use case, and requirements:

STOP: Determine the users background and use case before proceeding:

- Are they new to Flink? New to Managed Service for Apache Flink?
- Are they familiar with Java development?
- Is the use case complex with lots of business logic? Or simple and declarative?

These will inform how to organize the project, and whether to use Flink Table API or DataStream API. In general, assume the DataStream API.

### Example Workflow for New Applications

```
1. User asks to build a Flink application
2. Confirm user's goals and use case
3. READ [best-practices.md](references/best-practices.md)
4. READ [dependency-management.md](references/dependency-management.md)
5. READ relevant connector guides (e.g. [kinesis-connector-guide.md](references/kinesis-connector-guide.md))
6. Generate code following the loaded guidance
7. Validate against best practices
8. READ environment-setup.md via [environment-setup.md](references/environment-setup.md)
9. Compile and test locally
```

### Example Workflow for General Questions

```
1. User asks about real time delivery of data to Iceberg
2. Confirm user's goals and use case
3. READ [best-practices.md](references/best-practices.md)
4. READ [iceberg-connector-guide.md](references/iceberg-connector-guide.md)
5. READ other reference files as needed
6. Answer question with loaded guidance
```

## Reference Files

- You MUST use this skill and its reference files to answer any question on these topics.
- Do NOT answer from training knowledge or by searching general AWS documentation when the question concerns Apache Flink, Managed Service for Apache Flink, KPU sizing, Flink monitoring, deployment, migration, real-time analytics, or Iceberg/LakeHouse streaming with Flink
  - You MUST load the relevant reference files below before taking other steps.
  - The reference files contain MSF-specific details (thresholds, statistics, namespaces, constraints) that differ from generic Flink guidance and are required for correct responses.

| Goal                                                               | Reference                                                                       | When to Load                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Best practices                                                     | [best-practices.md](references/best-practices.md)                               | **Always** before writing code                                                                                                                                                                                                                                                                                  |
| Maven dependencies                                                 | [dependency-management.md](references/dependency-management.md)                 | New project or adding connectors                                                                                                                                                                                                                                                                                |
| Local dev environment                                              | [environment-setup.md](references/environment-setup.md)                         | Docker-based local development                                                                                                                                                                                                                                                                                  |
| MSF architecture                                                   | [msf-overview.md](references/msf-overview.md)                                   | KPU model and service constraints                                                                                                                                                                                                                                                                               |
| MSF constraints and patterns                                       | [msf-constraints-and-patterns.md](references/msf-constraints-and-patterns.md)   | MSF vs self-managed Flink, service-level vs application-level configuration separation, MSF-specific resource/network/storage limits, common MSF patterns                                                                                                                                                       |
| Quotas, ENI planning, MSF vs EMR, source/sink choice               | [foundation-operations.md](references/foundation-operations.md)                 | Capacity planning, service selection, architecture design, CLI/IAM/CloudWatch identifier disambiguation                                                                                                                                                                                                         |
| IAM execution role, trust policy, action prefix, service principal | [foundation-operations.md](references/foundation-operations.md)                 | Writing IAM policies for MSF — covers the `kinesisanalytics:` (no v2) action prefix, `kinesisanalytics.amazonaws.com` (no v2) trust principal, and the v2/non-v2 disconnect that is the most common source of permission and AssumeRole failures                                                                |
| Flink 2.x migration                                                | [flink-2x-migration.md](references/flink-2x-migration.md)                       | Version upgrades, state compatibility                                                                                                                                                                                                                                                                           |
| KPU sizing                                                         | [resource-optimization.md](references/resource-optimization.md)                 | Right-sizing, performance diagnosis, scaling                                                                                                                                                                                                                                                                    |
| Scaling decisions on running apps                                  | [scaling-decisions.md](references/scaling-decisions.md)                         | In-flight scaling matrix, cost/memory impact of scale changes, autoscaling behavior, anti-patterns                                                                                                                                                                                                              |
| Cost estimation                                                    | [pricing-calculator.md](references/pricing-calculator.md)                       | Budget planning, sizing-to-cost mapping, optimization levers                                                                                                                                                                                                                                                    |
| Application lifecycle ops                                          | [application-lifecycle.md](references/application-lifecycle.md)                 | Start/stop, deploy code, rollback, snapshot lifecycle, runtime properties, delete                                                                                                                                                                                                                               |
| Restart loop diagnosis                                             | [first-fault-isolation.md](references/first-fault-isolation.md)                 | Crashing/restarting apps, finding original failure vs loop sustainers, Flink Dashboard live diagnosis                                                                                                                                                                                                           |
| Checkpoint tuning                                                  | [checkpoint-tuning.md](references/checkpoint-tuning.md)                         | Checkpoint impact on KPU memory and CPU, frequency vs network bandwidth trade-offs, checkpoint duration exceeding interval, OOM/GC during checkpoints                                                                                                                                                           |
| Job graph design                                                   | [job-graph-architecture.md](references/job-graph-architecture.md)               | Performance issues, splitting jobs                                                                                                                                                                                                                                                                              |
| Job graph anti-patterns                                            | [job-graph-anti-patterns.md](references/job-graph-anti-patterns.md)             | Data skew detection and mitigation, monolith job anti-pattern, high fan-out anti-pattern, removing multiple shuffles, when to split a large application                                                                                                                                                         |
| Monitoring and alarms                                              | [monitoring-and-metrics.md](references/monitoring-and-metrics.md)               | CloudWatch dashboards, alarms, metrics                                                                                                                                                                                                                                                                          |
| Logging                                                            | [logging-configuration.md](references/logging-configuration.md)                 | Log4j2, CloudWatch Logs setup                                                                                                                                                                                                                                                                                   |
| Kinesis connectors                                                 | [kinesis-connector-guide.md](references/kinesis-connector-guide.md)             | Kinesis source and sink builders, polling configuration and throttling (`READER_EMPTY_RECORDS_FETCH_INTERVAL`, `SHARD_GET_RECORDS_MAX`, `ReadProvisionedThroughputExceeded`, `LimitExceededException`), legacy connector migration                                                                              |
| Kinesis Enhanced Fan-Out (EFO)                                     | [kinesis-efo-guide.md](references/kinesis-efo-guide.md)                         | When to use EFO vs polling, EFO source configuration, consumer lifecycle (`JOB_MANAGED` vs `SELF_MANAGED`), parallelism vs shard count, IAM permissions, troubleshooting                                                                                                                                        |
| Iceberg integration (write APIs, distribution modes, partitioning) | [iceberg-connector-guide.md](references/iceberg-connector-guide.md)             | Iceberg write APIs (append, upsert, dynamic), distribution modes (NONE/HASH/RANGE), CoW vs MoR, read patterns, partitioning, DDL. **Does NOT contain catalog choice or maintenance approaches** — for those, load `iceberg-tuning-and-operations.md`.                                                           |
| Iceberg tuning, operations, catalog choice, maintenance            | [iceberg-tuning-and-operations.md](references/iceberg-tuning-and-operations.md) | Provides maintenance approaches for S3 Tables, Glue + Glue auto-compaction, and Glue + Flink embedded maintenance with JDBC lock for catalog-choice questions; small files problem and mitigations; Flink TableMaintenance API, post-commit maintenance, lock factories; IcebergSink monitoring, anti-patterns. |
| CDC connectors                                                     | [cdc-connector-guide.md](references/cdc-connector-guide.md)                     | MySQL, PostgreSQL, Oracle, SQL Server, MongoDB CDC                                                                                                                                                                                                                                                              |
| IaC and deployment                                                 | [iac-and-deployment.md](references/iac-and-deployment.md)                       | CloudFormation, CDK, Terraform, two-phase deployment                                                                                                                                                                                                                                                            |
| Serialization                                                      | [serialization-guide.md](references/serialization-guide.md)                     | POJO, Avro, Kryo guidance                                                                                                                                                                                                                                                                                       |
| State management                                                   | [state-management.md](references/state-management.md)                           | TTL, state types, migration safety                                                                                                                                                                                                                                                                              |

## Additional Resources

- [GitHub Issues](https://github.com/awslabs/managed-service-for-apache-flink-agent-steering-files/issues)
