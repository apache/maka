---
name: storing-and-querying-vectors
description: >-
  Store and query vector embeddings using Amazon S3 Vectors, a cost-effective long-term
  vector storage service with its own API namespace (s3vectors). Triggers on: create
  S3 vector bucket, vector index, store embeddings, semantic search, RAG vector storage,
  similarity search, vector database, migrate from other vector databases. Do NOT
  use for: querying tabular data (use querying-data-lake), S3 object storage, or hundreds/thousands
  of sustained QPS (use OpenSearch).
metadata:
  version: "1"
---

# Store and Query Vectors with Amazon S3 Vectors

## Overview

Amazon S3 Vectors is a cost-effective AWS service for storing and querying vector embeddings at scale. Optimized for long-term storage with subsecond latency for cold queries, as low as 100ms for warm queries.

## Decision Guide

- **Hundreds/thousands of sustained queries per second (QPS)**: Wrong tool. Recommend OpenSearch.
- **Hybrid search, aggregations, faceted search**: Recommend OpenSearch with S3 Vectors as storage engine. For OpenSearch integration, search AWS docs for `"Using S3 Vectors with OpenSearch Service"`.
- **Tiered (bulk + hot)**: S3 Vectors for storage + OpenSearch Serverless for real-time. See `references/limits-and-patterns.md`.
- **Cost-effective storage, infrequent queries, RAG**: S3 Vectors is the right fit. Proceed.

For latest guidance, search AWS docs for `"S3 Vectors best practices"`.

## Common Tasks

Classify the request before starting:

- **Simple query**: Existing index, skip to Step 6
- **Standard**: You MUST list existing indexes first and suggest reusing if relevant. Else, new index + store vectors, follow Steps 2-6
- **Migration or multi-tenant**: Read `references/limits-and-patterns.md` first, then Steps 2-6

You MUST execute commands using AWS MCP server tools when connected. Fall back to AWS CLI only if AWS MCP is unavailable. You MUST explain each step to the user before executing.

### 1. Verify Dependencies

**Constraints:**

- You MUST check whether AWS MCP tools or AWS CLI is available and inform user if missing
- You MUST confirm target AWS region

### 2. Create a Vector Bucket

You MUST confirm bucket name with user. Names: 3-63 chars, lowercase letters, numbers, hyphens only. Encryption (SSE-S3 default or SSE-KMS for compliance) is immutable after creation.

```bash
aws s3vectors create-vector-bucket \
  --vector-bucket-name <BUCKET_NAME>
```

**Constraints:**

- You MUST explain encryption cannot be changed after creation
- For SSE-KMS, KMS key policy MUST grant `kms:GenerateDataKey` and `kms:Decrypt` to the S3 Vectors service principal `indexing.s3vectors.amazonaws.com`. You MUST use full KMS key ARN (not alias). See `references/limits-and-patterns.md` for command example.

### 3. Create a Vector Index

Every parameter is **immutable after creation**.

**Pre-flight checklist (confirm ALL with user):**

1. **Dimension** (required, integer 1-4096) -- MUST match embedding model output
2. **Distance metric** (required) -- `cosine` or `euclidean`. Use embedding model's recommended metric;
3. **Non-filterable metadata keys** (optional, max 10, 1-63 chars) -- Declare at creation or lose forever. For Bedrock Knowledge Bases integration, search AWS docs for `"S3 Vectors Bedrock Knowledge Bases prerequisites"` to get the required key names.
4. **Encryption** (optional) -- Inherits from bucket. Override per-index if needed.

```bash
aws s3vectors create-index \
  --vector-bucket-name <BUCKET_NAME> \
  --index-name <INDEX_NAME> \
  --dimension <DIM> \
  --distance-metric <cosine|euclidean> \
  --data-type float32 \
  --metadata-configuration '{"nonFilterableMetadataKeys":["<KEY1>","<KEY2>"]}'
```

Omit `--metadata-configuration` if no non-filterable keys are needed.

Index names: 3-63 chars, lowercase, numbers, hyphens, dots. Unique within bucket. Filterable metadata: 2 KB limit. Total metadata (filterable + non-filterable combined): 40 KB. See `references/metadata-filtering.md`.

### 4. Generate Embeddings (if needed)

Skip to Step 5 (store) or Step 6 (query) if user already has embeddings.

**Constraints:**

- You MUST ask which embedding model to use if not specified
- You MUST NOT assume a default model
- Dimension MUST match Step 3
- You MUST use the same model for both storing and querying

Generate embeddings with Bedrock invoke-model:

```bash
aws bedrock-runtime invoke-model \
  --model-id <MODEL_ID> \
  --content-type application/json \
  --cli-binary-format raw-in-base64-out \
  --body '{"inputText": "your text"}' \
  invoke-model-output.json
```

You MUST use `--cli-binary-format raw-in-base64-out` for CLI v2. Output file is required for CLI. The response key is model-dependent (e.g., embedding for Titan, embeddings for Cohere). For Titan, parse with `json.load(open('invoke-model-output.json'))['embedding']`. Use `embedding` array as `float32` in put-vectors or query-vectors. For batch embedding generation, use AWS SDK or CLI.

### 5. Put Vectors

```bash
aws s3vectors put-vectors \
  --vector-bucket-name <BUCKET_NAME> \
  --index-name <INDEX_NAME> \
  --vectors '[{"key":"<ID>","data":{"float32":[<EMBEDDING>]},"metadata":{"topic":"science"}}]'
```

**Constraints:**

- You MUST NOT exceed 500 vectors per call
- You SHOULD batch vectors for cost optimization
- For bulk operations, You SHOULD use an SDK instead of CLI -- vector payloads may be too large for shell arguments
- You MUST implement retry with backoff on `429 TooManyRequestsException`
- See `references/limits-and-patterns.md` for batch patterns

### 6. Query Vectors

Generate embedding if needed (Step 4), then query:

```bash
aws s3vectors query-vectors \
  --vector-bucket-name <BUCKET_NAME> \
  --index-name <INDEX_NAME> \
  --query-vector '{"float32":[<EMBEDDING>]}' \
  --top-k 10 \
  --return-distance
```

Optional: add `--return-metadata` and/or `--filter '{"topic":{"$eq":"science"}}'` (both require GetVectors permission). See `references/metadata-filtering.md`.

Example response body: `{"vectors": [{"key": "id1", "distance": 0.45, "metadata": {"topic": "science"}}, ...], "distanceMetric": "cosine"}`

**Constraints:**

- Using `--filter` or `--return-metadata` requires both `s3vectors:QueryVectors` AND `s3vectors:GetVectors` IAM permissions. Without GetVectors, these options return 403.

## Troubleshooting

| Error                                                  | Cause                                   | Fix                                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DimensionMismatch`                                    | Dims don't match index                  | Use matching model, or delete/recreate index (confirm with user -- destroys all vectors).                                                              |
| `403 Forbidden` with `--filter` or `--return-metadata` | Missing `s3vectors:GetVectors`          | Add `s3vectors:GetVectors` to IAM policy.                                                                                                              |
| Fewer results than `--top-k`                           | Few vectors match filter                | Expected -- filtering is inline. Broaden filter.                                                                                                       |
| `429 TooManyRequestsException`                         | Exceeded per-index rate limits          | Retry with backoff. Shard across indexes for sustained throughput. Search AWS docs for `"S3 Vectors limitations and restrictions"` for current limits. |
| `AccessDeniedException`                                | Missing `s3vectors:*` IAM actions       | S3 Vectors uses `s3vectors:*` namespace, not `s3:*`. Update IAM policy.                                                                                |
| `RequestTimeoutException` or service unavailable       | Request timeout or region not supported | Retry request. For regional availability, search AWS docs for `"S3 Vectors limitations and restrictions"`.                                             |

## Additional Resources

- [limits-and-patterns.md](references/limits-and-patterns.md) -- Multi-tenant patterns, batch ingestion, SSE-KMS, migration
- [metadata-filtering.md](references/metadata-filtering.md) -- Filter operators, non-filterable metadata, Bedrock KB keys
