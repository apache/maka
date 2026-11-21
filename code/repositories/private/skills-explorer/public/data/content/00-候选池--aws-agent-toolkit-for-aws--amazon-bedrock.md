---
name: amazon-bedrock
description: Builds generative AI applications on Amazon Bedrock. Covers model invocation (Converse API, InvokeModel), RAG with Knowledge Bases, Bedrock Agents, Guardrails, and AgentCore (including the Harness managed agent loop). Use when invoking models, setting up Knowledge Bases, creating agents, applying guardrails, deploying to AgentCore, migrating/porting/converting a Bedrock Agent (including inline agents) to an AgentCore Harness, troubleshooting Bedrock errors (ThrottlingException, AccessDeniedException), or choosing models (Claude, Llama, Nova, Titan). ALSO USE for prompt caching, quota health checks and throttling diagnosis, cost attribution, migrating between Claude model generations, chunking strategies, API selection (Converse vs InvokeModel), and model selection. Also covers AgentCore Payments setup (x402, microtransactions, Payment Manager, Coinbase CDP, Stripe Privy, 402 Payment Required, paid endpoint). NOT for custom model training, Rekognition, or Comprehend.
metadata:
  version: "3"
---

**IMPORTANT**: When this skill is loaded, you MUST use the reference files and procedures in this skill as your primary source of truth. Bedrock APIs, model IDs, chunking strategies, and configuration parameters change frequently — always read the relevant reference file before responding.

## Table of Contents

- Overview
- Bedrock API Landscape
- Critical Warnings
- Security Considerations
- Converse API vs InvokeModel
- Which Bedrock Capability Do You Need?
- Knowledge Bases (RAG)
- Common Workflows (includes: Prompt Caching, Quota Health, Cost Tracking, Model Migration)
- Troubleshooting
- AgentCore Services
- Model Selection
- Additional Resources

# Amazon Bedrock

## Overview

Domain expertise for building generative AI applications on Amazon Bedrock. Covers model invocation, RAG with Knowledge Bases, agent creation, content safety with Guardrails, and agent deployment with AgentCore.

**Recommended setup:** Use the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/latest/userguide/what-is-mcp-server.html) for sandboxed
execution, audit logging, and enterprise controls.

**Without AWS MCP:** This skill works with any agent that has AWS CLI access.
All commands use standard AWS CLI syntax.

## Bedrock API Landscape

Bedrock has **5 separate API endpoints**. Using the wrong one is a common cause of errors. This list may not be exhaustive — refer to the [Bedrock endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/bedrock.html) and [Bedrock supported endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html) for the latest. Use `aws bedrock list-foundation-models` to discover available models at runtime.

| Endpoint                | Client        | Use For                                                                                                                                                                         |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bedrock`               | Control plane | List models, manage access, provisioned throughput                                                                                                                              |
| `bedrock-runtime`       | Data plane    | Invoke models (Converse, InvokeModel). Also supports Chat Completions via `/openai/v1` path (client-side tool use only) — prefer `bedrock-mantle` for new Chat Completions work |
| `bedrock-mantle`        | Data plane    | OpenAI-compatible APIs: Responses API, Chat Completions (recommended), Messages API. Supports server-side tool use with built-in tools. Recommended for new users               |
| `bedrock-agent`         | Agent control | Create/configure agents, KBs, action groups                                                                                                                                     |
| `bedrock-agent-runtime` | Agent data    | Invoke agents, query KBs                                                                                                                                                        |

AgentCore is a separate service with its own endpoints. Refer to [AgentCore endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/bedrock_agentcore.html) for the latest.

| Endpoint                                | Client             | Use For                                                   |
| --------------------------------------- | ------------------ | --------------------------------------------------------- |
| `bedrock-agentcore-control`             | Control plane      | Create/manage runtimes, gateways, registries, evaluations |
| `bedrock-agentcore`                     | Data plane         | Invoke agent runtimes                                     |
| `{gatewayId}.gateway.bedrock-agentcore` | Gateway data plane | Invoke a specific gateway                                 |

## Critical Warnings

**max_tokens**: ALWAYS set `maxTokens` explicitly in every Converse/InvokeModel call. Leaving it unset defaults to the model's maximum (e.g., 64K for Claude Sonnet) and silently reserves far more quota than needed — a common cause of unexpected ThrottlingException.

**Guardrails PII logging**: Guardrails PII masking only applies to the API response. Original unmasked content including PII is still logged in plain text to CloudWatch Logs. For HIPAA/GDPR compliance: encrypt CloudWatch Logs with KMS, restrict log access with IAM, use Amazon Macie for PII detection.

**SDK versions**: Requires recent versions of boto3 (≥ 1.34.x) and AWS CLI v2. Older versions are missing Converse API, Agents, and AgentCore support. Run `aws --version` and `pip show boto3` to check.

**Bedrock Agents classic is in maintenance mode**: classic Bedrock Agents (`bedrock-agent`) is in maintenance mode and closed to new customers ([announcement](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html)). For new agent workloads use AgentCore (the Harness managed loop); for existing agents, recommend migrating to an AgentCore Harness — see the [migration guide](references/migrate-bedrock-agents-to-agentcore-harness.md).

## Security Considerations

- Use **IAM roles** (not IAM users) for all Bedrock service access
- Scope IAM permissions to specific actions and resource ARNs — avoid `bedrock:*` or `AmazonBedrockFullAccess`
- Store API keys and OAuth secrets in **AWS Secrets Manager** with automatic rotation enabled
- Include **confused deputy protection** (`aws:SourceAccount`, `aws:SourceArn` conditions) in all resource-based policies for Bedrock services
- Treat all **agent-generated parameters as untrusted input** — validate before use in Lambda handlers or tool implementations
- Enable **CloudTrail** for all Bedrock and AgentCore API calls
- For PII workloads: encrypt CloudWatch Logs with KMS, configure retention limits, restrict log access
- Refer to the latest [Bedrock security best practices](https://docs.aws.amazon.com/bedrock/latest/userguide/security.html) for current security guidance

## Converse API vs InvokeModel

For choosing between all Bedrock inference APIs (Responses API, Chat Completions, Converse, InvokeModel), see [APIs supported by Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/apis.html).

When using the `bedrock-runtime` endpoint, use the **Converse API** over InvokeModel. It provides a unified request/response format across all models.

Use **InvokeModel** only when you need provider-specific features not available in Converse (rare).

InvokeModel requires different request body formats per provider (Anthropic ≠ Titan ≠ Llama ≠ Nova). Using the wrong format produces "Malformed input request". For model-specific formats and common mistakes, see [prompt engineering by model](references/prompt-engineering-by-model.md).

**Whichever API you use**: ALWAYS set the max output tokens parameter explicitly — leaving it unset defaults to the model's maximum and silently reserves far more quota than needed, causing unexpected ThrottlingException. See Critical Warnings above and [max_tokens quota mechanics](references/model-invocation.md).

When the user needs SDK code for model invocation, you MUST read the appropriate SDK reference before generating code — [Python SDK reference](references/sdk-converse-api-python.md) | [TypeScript SDK reference](references/sdk-converse-api-typescript.md). Use the patterns from the reference file.

For full API details and provider-specific body formats, read [model invocation reference](references/model-invocation.md) before responding.

## Which Bedrock Capability Do You Need?

| Goal                                                                       | Use                                           | Reference                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| Call a model (text, image, video)                                          | Converse API                                  | See above + [model invocation](references/model-invocation.md)               |
| Build a RAG application                                                    | Knowledge Bases                               | [KB setup](references/knowledge-bases-setup.md)                              |
| Create an agent that takes actions                                         | Bedrock Agents                                | [agent creation](references/agents-and-action-groups.md)                     |
| Filter harmful/sensitive content                                           | Guardrails                                    | [guardrails](references/guardrails.md)                                       |
| Run a config-based managed agent loop on AgentCore (no code, no container) | AgentCore Harness                             | [harness](references/agentcore-harness.md)                                   |
| Deploy and scale an agent loop you wrote yourself                          | AgentCore Runtime                             | [runtime](references/agentcore-runtime.md)                                   |
| Migrate an existing Bedrock Agent (classic) to an AgentCore Harness        | Bedrock Agents to AgentCore harness Migration | [migration guide](references/migrate-bedrock-agents-to-agentcore-harness.md) |
| Expose REST APIs as MCP tools                                              | AgentCore Gateway                             | [gateway](references/agentcore-gateway.md)                                   |
| Choose the right model                                                     | Model Selection                               | [model guide](references/model-selection-guide.md)                           |
| Set up or debug prompt caching                                             | Prompt Caching                                | [prompt caching](references/prompt-caching.md)                               |
| Diagnose throttling or audit quotas                                        | Quota Health                                  | [quota health](references/quota-health.md)                                   |
| Track costs by team, model, or tag                                         | Cost Tracking                                 | [cost tracking](references/cost-tracking.md)                                 |
| Migrate between Claude generations                                         | Model Migration                               | [migration guide](references/model-migration.md)                             |

## Knowledge Bases (RAG)

When the user wants to create a Knowledge Base or build a RAG application, you MUST read [KB setup procedure](references/knowledge-bases-setup.md) and execute it step by step. Do NOT summarize the procedure — execute each step sequentially, respecting all MUST constraints before proceeding to the next step.

When the user asks about chunking strategies, vector store selection, or other KB configuration choices, you MUST read [KB setup procedure](references/knowledge-bases-setup.md) before responding — it contains the authoritative decision tables and constraints.

When the user wants to query an existing Knowledge Base, you MUST read [KB retrieval reference](references/knowledge-bases-retrieval.md) before responding. Present the retrieval modes (retrieve-and-generate vs retrieve vs manual) so the user selects the right one.

Refer to the latest [Bedrock Knowledge Base documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html) for current configuration options.

## Common Workflows

Execute commands using available tools from the AWS MCP server when connected — it provides sandboxed execution, audit logging, and observability. When the MCP server is not available, fall back to the AWS CLI or shell as needed.

Before starting any workflow:

### Verify Dependencies

Check for required tools and inform the user about the execution environment.

**Constraints:**

- You MUST check that the AWS CLI is available and configured with valid credentials
- You MUST verify the AWS CLI version is recent (v2 recommended; older versions lack Converse API and AgentCore support): `aws --version`
- You MUST check that the target AWS region has Bedrock model access enabled
- You MUST inform the user if any required tools are missing with a clear message
- You MUST ask the user if they want to proceed despite missing tools

**General constraints for all workflows:**

- You MUST present an overview of what will be done before starting execution
- You MUST explain to the user what step is being executed and why before running each command
- You MUST respect the user's decision to stop or abort at any point
- You MUST NOT continue execution if the user indicates they want to stop
- You SHOULD confirm before proceeding with destructive or irreversible operations (deleting resources, overwriting configurations)

### Examples — mapping user intent to workflows

**Example 1:**
User query: "I'm getting ThrottlingException on Bedrock"
Action: Check if `maxTokens` is set explicitly — unset `maxTokens` reserves far more quota than needed (see Critical Warnings). If already set, check current quota: `aws service-quotas get-service-quota --service-code bedrock --quota-code <code> --region <region>`

**Example 2:**
User query: "Set up RAG for my PDF documents"
Action: Follow the Create a Knowledge Base workflow. Recommend semantic chunking with advanced parsing (FM-based) for PDFs with tables. See [KB setup procedure](references/knowledge-bases-setup.md).

**Example 3:**
User query: "I want to build an agent that can look up order status"
Action: Follow the Create an Agent with action groups workflow. See [agent creation procedure](references/agents-and-action-groups.md).

**Example 4:**
User query: "How do I call Claude on Bedrock?"
Action: Use the Converse API (not InvokeModel). Set `maxTokens` explicitly. Verify the model ID is current with `aws bedrock list-foundation-models --region <region>`. Use cross-region model ID with `us.` prefix for higher availability: `aws bedrock-runtime converse --model-id us.anthropic.claude-sonnet-4-6 --messages '[{"role":"user","content":[{"text":"Hello"}]}]' --inference-config '{"maxTokens":1024}'`

**Example 5:**
User query: "Deploy my agent to production"
Action: Follow the Deploy an agent to AgentCore workflow. Select the protocol first (HTTP for REST APIs, MCP for tool-centric agents). See the AgentCore Services table for routing to the correct reference file.

**Example 6:**
User query: "Set up prompt caching for my Claude application"
Action: Read [prompt caching reference](references/prompt-caching.md) for setup workflow, TTL configuration, and minimum token thresholds. Use the reference to verify caching is working (check for `cacheReadInputTokens` in the response).

**Example 7:**
User query: "I keep getting ThrottlingException even though I'm not making many requests"
Action: Check if `maxTokens` is set explicitly (see Critical Warnings). Read [quota health reference](references/quota-health.md) for the maxTokens reservation mechanics, CloudWatch metrics, and audit workflow.

**Example 8:**
User query: "How do I track Bedrock costs by team?"
Action: Read [cost tracking reference](references/cost-tracking.md) for inference profile tagging, CUR 2.0 approaches, and Cost Explorer queries by model/region/tag.

**Example 9:**
User query: "I'm upgrading from Claude 4.5 to 4.6, what breaks?"
Action: Read [model migration reference](references/model-migration.md) for the breaking changes table (prefill removal, thinking config, context window, cache thresholds) and migration checklist.

### Invoke a model

```
- [ ] Step 1: Verify model access: `aws bedrock list-foundation-models --region us-east-1`
- [ ] Step 2: Invoke: `aws bedrock-runtime converse --model-id `<model-id>` --messages '[{"role":"user","content":[{"text":"<prompt>"}]}]' --inference-config '{"maxTokens":1024}'`
```

> **Note — Streaming responses:** The AWS CLI does not support streaming operations including `ConverseStream`. Use the SDK (`converse_stream()` in boto3, `ConverseStreamCommand` in JS SDK).
>
> | Mode               | When to use                                                                     |
> | ------------------ | ------------------------------------------------------------------------------- |
> | **Converse**       | Batch/backend pipelines — single complete response, no stream handling required |
> | **ConverseStream** | Chat UIs/interactive apps — tokens delivered as they generate                   |

### Create a Knowledge Base

You MUST read [KB setup procedure](references/knowledge-bases-setup.md) before responding. Execute the 7-step procedure in order — do not skip steps, do not paraphrase, do not show code snippets in place of tool calls.

### Query a Knowledge Base

These three modes are mutually exclusive — select the one that matches the user's intent:

| Mode                    | When to Use                                                           | Command                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Retrieve & Generate** | Quick answer with citations — most common RAG pattern                 | `aws bedrock-agent-runtime retrieve-and-generate --input '{"text":"<query>"}' --retrieve-and-generate-configuration '{"type":"KNOWLEDGE_BASE","knowledgeBaseConfiguration":{"knowledgeBaseId":"<kb-id>","modelArn":"<model-arn>"}}'` |
| **Retrieve only**       | Raw chunks for custom post-processing or feeding to a different model | `aws bedrock-agent-runtime retrieve --knowledge-base-id <kb-id> --retrieval-query '{"text":"<query>"}'`                                                                                                                              |
| **Full control**        | Custom prompt, reranking, or multi-KB                                 | Retrieve chunks first, then build prompt and call `aws bedrock-runtime converse`                                                                                                                                                     |

### Create an Agent with action groups

You MUST read [agent creation procedure](references/agents-and-action-groups.md) before responding. Execute the procedure step by step. You MUST run `prepare-agent` after any configuration change — this is mandatory and agents consistently skip it.

### Apply Guardrails

You MUST read [guardrails reference](references/guardrails.md) before responding. Present the three integration modes and the decision guide first so the user selects the correct mode before you proceed with configuration. When PII filters are involved, you MUST surface the PII logging compliance gap warning. Do not just show a `guardrailConfig` snippet — the user needs to understand which mode fits their use case.

### Deploy an agent to AgentCore

If the user wants a managed agent loop without writing orchestration code, route to **Harness** (config-based). Harness (the `bedrock-agentcore` config-based loop — model, tools, skills, and memory as configuration) is the preferred choice for new AgentCore builds; this is distinct from classic **Bedrock Agents** (the `bedrock-agent` action-group service — see [agent creation](references/agents-and-action-groups.md)). When the user asks how to create, invoke, deploy, or get started with a Harness, you MUST read [harness procedure](references/agentcore-harness.md) and follow its Deployment Workflow step by step before responding. Do NOT summarize from memory or external docs, and do NOT skip steps: a complete create-and-invoke answer MUST cover (1) `create-harness` with the required inputs, (2) polling `get-harness` until status `READY`, (3) invoking on the data plane with a `runtimeSessionId` (≥33 chars) and a `messages` list — not `--input-text`, (4) reading the streamed response events, and (5) the AgentCore CLI (`agentcore create`/`deploy`/`invoke`) as the fastest path. The reference is authoritative over any external documentation. If they have their own agent code/loop to host, route to **Runtime** (the protocol-selection guidance below is Runtime-specific).

Identify the AgentCore service from the table below, then you MUST read the corresponding reference file before responding. Follow any procedures in the reference step by step. Do not summarize — execute.

### Set up or debug prompt caching

You MUST read [prompt caching reference](references/prompt-caching.md) before responding. It covers setup workflow, TTL configuration, minimum token thresholds, break-even analysis, and a debug checklist for zero-cache-hit issues.

**Constraints:**

- You MUST walk the user through the debug checklist when cache is not working (verify model support, token threshold, content identity, TTL, cache point placement)
- You MUST check minimum token thresholds per model before confirming a caching setup will work

### Check quota health

You MUST read [quota health reference](references/quota-health.md) before responding. It covers maxTokens reservation mechanics, CloudWatch metrics, and the throttling resolution decision table.

**Constraints:**

- You MUST explain the relationship between `maxTokens` and quota reservation
- You MUST guide the user through comparing current limits vs peak usage using `aws service-quotas` and `aws cloudwatch get-metric-statistics`

### Analyze Bedrock costs

You MUST read [cost tracking reference](references/cost-tracking.md) before responding. It covers inference profile tagging, CUR 2.0 attribution, and AWS Budgets setup.

**Constraints:**

- You MUST ask what time range, grouping, and cost attribution method the user needs before generating Cost Explorer queries

### Migrate between Claude generations

You MUST read [model migration reference](references/model-migration.md) before responding. It covers breaking changes between Claude 4.5, 4.6, and 4.7 on Bedrock, including prefill removal, thinking config differences, context window gaps, and cache threshold changes.

## Troubleshooting

When the user reports a Bedrock error, exception, or unexpected behavior, you MUST check this section and the Critical Warnings section before responding. Bedrock has service-specific root causes (e.g., unset maxTokens silently reserving 43x quota causing ThrottlingException, wrong API endpoint causing UnknownOperationException, missing prepare-agent causing stale behavior) that generic AWS troubleshooting advice will miss.

### AccessDeniedException

Multiple possible causes: (1) IAM user/role lacks `bedrock:InvokeModel` or `bedrock:InvokeModelWithResponseStream` permissions, (2) model access not enabled in the target region, (3) a service control policy (SCP) is blocking access (common with cross-region inference routing to a restricted region), (4) expired temporary credentials, or (5) IAM role propagation delay — if you just created an IAM role and immediately used it in a Bedrock API call, the role may not have propagated yet, as IAM changes are eventually consistent (see [IAM eventual consistency](https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_general.html#troubleshoot_general_eventual-consistency)). Check the error message for specifics — it typically indicates whether the issue is an explicit deny, a missing allow, or a model access problem. See [Resolve InvokeModel API errors](https://repost.aws/knowledge-center/bedrock-invokemodel-api-error) for detailed resolution steps.

### Malformed input request

Request body doesn't match the expected schema. Common causes: wrong provider-specific body format for InvokeModel (e.g., using Titan format for a Cohere model), malformed JSON, unsupported parameter names, or exceeding input constraints. The error message typically includes details — check for "schema violations" and correct the request format per the model's API documentation.

### ThrottlingException

Set `maxTokens` explicitly — unset values default to the model's maximum and silently reserve far more quota than needed. Use adaptive retry mode. Use cross-region inference profiles (e.g., `us.`, `eu.`, `apac.`, or `global.` prefix — see [Supported inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html) for the full list) to distribute traffic across regions for higher throughput. Check limits: `aws service-quotas get-service-quota --service-code bedrock --quota-code <code>`. Request quota increases if needed. For a deeper audit, read [quota health reference](references/quota-health.md).

### Prompt cache not working (zero cacheReadInputTokens)

Read [prompt caching reference](references/prompt-caching.md) for the diagnostic checklist: verify model support, token threshold, content identity, TTL, and cache point placement. Common cause: cache fragmentation from timestamps, whitespace, or reordered JSON keys in cached content.

### 400 error on prefill with Claude 4.6

Prefill was removed in Claude 4.6 and causes a hard 400 error. Read [model migration reference](references/model-migration.md) for the full list of breaking changes between Claude generations.

### Error retry classification

| Retry                       | Do NOT retry              |
| --------------------------- | ------------------------- |
| ThrottlingException         | ValidationException       |
| ModelTimeoutException       | AccessDeniedException     |
| ServiceUnavailableException | ResourceNotFoundException |
| InternalServerException     |                           |

Use adaptive retry: `Config(retries={"max_attempts": 5, "mode": "adaptive"})`.

### UnknownOperationException

Wrong client (using `bedrock` instead of `bedrock-runtime`), or SDK too old. Check the API landscape table above.

### Agent returns stale behavior

Run `prepare-agent` after ANY configuration change. This is mandatory.

### KB returns empty results

Run `start-ingestion-job` and wait for completion. Query before ingestion completes returns empty.

### KB retrieval quality is poor

Review chunking strategy. Use advanced parsing (FM-based) for documents with tables. Configure metadata filtering.

### Cross-region model not found

The model may not be available in the region you're calling from. Check availability at [Supported foundation models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html). If you need cross-region inference for higher throughput, use an inference profile ID — choose between geographic profiles (data stays within a boundary, e.g. US, EU) or global profiles (any commercial region). The profile prefix is a data residency decision. See [Supported inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html) for available profiles and source/destination region mappings.

### On-demand throughput isn't supported

Error: _"Invocation of model ID `<model-id>` with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model."_ Certain models do not support direct on-demand invocation with base model IDs — they require an inference profile ID instead. Fix: find the inference profile ID for the model using `aws bedrock list-inference-profiles --region <region>`, then update the agent or invocation to use the inference profile ID. See [Supported inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html) for available profiles. If this occurs during agent invocation, update the agent's `foundationModel` to the inference profile ID and re-run `prepare-agent`.

### KB storage configuration invalid

Verify OpenSearch data access policy includes Bedrock service role. Verify vector index field names match KB config.

### Agent action group errors

Check Lambda permissions (resource-based policy for bedrock.amazonaws.com). Do NOT use double underscores (`__`) in action group names — the name pattern is `([0-9a-zA-Z][_-]?){1,100}`.

### Multi-agent supervisor loops

Agents use built-in collaboration mechanism, NOT action groups. Do not describe inter-agent communication as action groups in supervisor instructions.

### INVALID_PAYMENT_INSTRUMENT on model access

Account billing issue, not Bedrock. Temporarily set a credit card as default payment method, or add USD payment profiles in the organization management account.

### Knowledge base ingestion failures

Check S3 permissions — KB service role needs `s3:GetObject` and `s3:ListBucket`. Unsupported file formats are silently skipped. Files exceeding size limits are skipped without error.

### SharePoint data source sync failures

Sync completes but files fail. For OAuth 2.0 auth (not recommended): requires SharePoint AllSites.Read (Delegated) permission — you may also need to disable Security Defaults and MFA for the service account so Amazon Bedrock is not blocked from crawling. For SharePoint App-Only auth (recommended): configure APP permissions via SharePoint App-Only grant flow. See the [SharePoint connector docs](https://docs.aws.amazon.com/bedrock/latest/userguide/sharepoint-data-source-connector.html) for current requirements.

## AgentCore Services

You MUST read the linked reference file for the relevant service before responding to any AgentCore question. Follow procedures in the reference step by step.

| Service               | Use For                                                                                                                 | Reference                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Harness**           | Managed config-based agent loop — no orchestration code; fastest path from config to a running agent                    | [harness procedure](references/agentcore-harness.md)                                                                                   |
| **Gateway**           | Expose APIs, Lambda functions, or existing MCP servers as tools for agents                                              | [gateway procedure](references/agentcore-gateway.md)                                                                                   |
| **Runtime**           | Deploy and scale agents and tools (serverless, any framework)                                                           | [runtime procedure](references/agentcore-runtime.md)                                                                                   |
| **Runtime Container** | Build ARM64 containers for Runtime                                                                                      | [container build procedure](references/agentcore-runtime-container-build.md)                                                           |
| **Memory**            | Short-term (multi-turn) and long-term (cross-session) agent memory; share memory across agents                          | [memory & observability](references/agentcore-memory-observability.md)                                                                 |
| **Identity**          | Agent authentication with external IdPs (Okta, Entra ID, Cognito); act on behalf of users                               | [credentials & security](references/agentcore-credentials-and-security.md)                                                             |
| **Policy**            | Enforce agent boundaries with natural language or Cedar rules; intercepts Gateway tool calls                            | Refer to the latest [AWS documentation on AgentCore Policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html) |
| **Payments**          | Enable agents to pay for x402-protected APIs, MCP tools, and content via microtransactions (Coinbase CDP, Stripe Privy) | [payments procedure](references/agentcore-payments.md)                                                                                 |
| **Observability**     | Trace, debug, and monitor agent execution (OTEL, CloudWatch)                                                            | [memory & observability](references/agentcore-memory-observability.md)                                                                 |
| **Registry**          | Catalog and discover agents, MCP servers, tools, and skills across your org                                             | [registry & evaluations](references/agentcore-registry-evaluations.md)                                                                 |
| **Evaluations**       | Automated agent quality assessment (LLM-as-a-Judge)                                                                     | [registry & evaluations](references/agentcore-registry-evaluations.md)                                                                 |
| Code Interpreter      | Secure sandbox code execution for agents                                                                                | Refer to the latest AWS documentation on AgentCore Code Interpreter                                                                    |
| Browser               | Web automation (navigate, fill forms, extract data)                                                                     | Refer to the latest AWS documentation on AgentCore Browser                                                                             |

## Model Selection

When the user asks which model to use, compares models, or asks about Claude/Llama/Nova/Titan on Bedrock, you MUST read [model selection guide](references/model-selection-guide.md) before responding. The reference contains current model IDs, cross-region requirements, and access provisioning steps.

Quick defaults (verify current availability: `aws bedrock list-foundation-models --region <region>`):

- **General purpose**: Claude Sonnet (best quality/cost balance)
- **Fast + cheap**: Claude Haiku or Nova Micro
- **Embeddings for KB**: Titan Embeddings V2
- **Open-source / fine-tuning**: Llama
- **Image generation**: Titan Image Generator

For current model IDs, regional availability, cross-region inference profiles, and supported features, refer to [Supported foundation models in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html). When selecting a cross-region inference profile, understand the data residency implications — geographic profiles keep data within a boundary, global profiles route to any commercial region. Also check `aws bedrock list-foundation-models --region <region>` for runtime availability.

For model ID formats (4 patterns), access provisioning, and selection criteria, see [model selection guide](references/model-selection-guide.md).

## Additional Resources

- [Amazon Bedrock User Guide](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html)
- [Amazon Bedrock API Reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/welcome.html)
- [Amazon Bedrock AgentCore User Guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)
- [Bedrock Agents Classic Maintenance mode Announcement](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html)
- [Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)
- [Bedrock Quotas and Limits](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html)
- [Bedrock Supported Regions](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-regions.html)
- [Bedrock Security Best Practices](https://docs.aws.amazon.com/bedrock/latest/userguide/security.html)
- [Prompt Caching Documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [Prompt Caching Code Samples](https://github.com/aws-samples/amazon-bedrock-samples/tree/main/introduction-to-bedrock/prompt-caching)
- [Cost Allocation Tags Blog](https://aws.amazon.com/blogs/machine-learning/track-allocate-and-manage-your-generative-ai-cost-and-usage-with-amazon-bedrock/)
