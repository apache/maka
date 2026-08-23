<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Provider-hosted web search capability

Status: implemented for OpenAI Responses and Anthropic Messages
`web_search_20250305`; other provider-native wires remain explicit follow-ups.
Verified against public provider documentation and shipped client/SDK behavior
on 2026-08-04.

## Problem

Maka originally exposed only a Tavily-backed `WebSearch` tool. That made live
search require a second credential even when the selected model provider already
offered a server-side search tool.

The missing abstraction was not another search-provider enum entry. Hosted
search depends on all three of:

1. the configured provider access path;
2. the exact selected model;
3. a provider-specific protocol and tool shape.

`functionCalling: true` does not imply hosted search. OpenAI-compatible chat
does not imply Responses `web_search`, and Anthropic-compatible messages do not
imply support for `web_search_20250305`.

## Current routing

The user chooses one explicit search source:

- `model`: reuse the current session model connection and credential;
- `tavily`: use the separately configured Tavily credential.

There is no silent fallback. If `model` is selected and the exact provider/model
pair is unsupported, Maka omits the native tool from that turn. Tavily remains
an explicit alternative rather than taking over after a failed native call.

The capability decision lives in
`packages/core/src/model-web-search.ts`. Stored model metadata can explicitly
set `capabilities.webSearch`; otherwise narrow provider/model rules apply.

The implemented native adapters are:

- `openai-responses` for Codex-style `web_search`;
- `anthropic-messages` for Claude Code-compatible `web_search_20250305`.

## Execution surfaces

All production `AiSdkBackend` composition roots use the same
`routeWebSearchTools` decision:

| Surface | Configuration authority | Root behavior |
| --- | --- | --- |
| Desktop | persisted `webSearch.enabled/defaultProvider` settings | May add provider-native `WebSearch` |
| CLI / TUI / `maka run` | the same persisted settings | May add provider-native `WebSearch` |
| Runtime Host | runtime-policy web-search settings | May add provider-native `WebSearch` |
| Headless Harbor | explicit `MAKA_WEB_SEARCH_ENABLED=true` | May add provider-native `WebSearch` |

Headless remains opt-in because silently enabling network search would change
benchmark semantics and historical baselines. Merely speaking Anthropic
Messages is not enough to infer hosted-search support; Maka uses explicit model
metadata or narrow model-id rules, including DeepSeek V4 Flash on an
`anthropic-compatible` connection.

An explicit `BackendFactoryContext.tools` list is a hard ceiling. Root surfaces
may add native search, but scoped child agents do not gain it unless their
supplied tool list already contains `WebSearch`. Dedicated model experiments
and auxiliary calls such as title generation, history compaction, goal judging,
connection tests, and daily review do not receive search implicitly.

Privacy mode removes both provider-native and client-executed `WebSearch`
before the model request is built.

The built-in `web_research` child profile is derived from that same routed
per-session child tool surface. It is not advertised when search is disabled,
privacy mode is active, or the selected provider/model wire is unsupported.

```text
turn-start tool surface
  -> provider/model capability resolution
  -> replace client WebSearch with provider-native WebSearch
  -> primary model POST /responses
       tools: [{ type: "web_search" }]
  -> provider-executed search call/result
  -> same model stream continues to final text
```

The search request uses the existing model credential. It does not duplicate the
secret into web-search settings, start a nested model request, or expose the
secret to the renderer. Provider search call/results are marked
`providerExecuted`, preserved separately from local ToolRuntime execution, and
replayed through the native provider-tool shape.

The durable event keeps normalized `result` data for the canonical read model,
UI, and exports, plus opaque `providerOutput` data for provider-protocol replay.
Anthropic replay places `server_tool_use` and `web_search_tool_result` in the
same assistant message. Responses replay uses a provider item reference and
never emits an orphan `function_call_output`.

Context budgeting measures the opaque replay payload rather than the smaller
display projection. Provider-native results are not partially archived: history
compaction removes the complete old turn instead of archiving only `result`
while accidentally retaining an unbounded `providerOutput`.

DeepSeek live verification on 2026-08-04 completed one real Maka `AiSdkBackend`
turn with two provider-executed WebSearch calls and a final answer in the same
stream. DeepSeek returned search actions but no structured source rows or URL
annotations in that response, so Maka preserves citations when supplied but
does not synthesize or invent them.

The same key was also verified through DeepSeek's Anthropic-compatible endpoint:
one real Maka turn sent `web_search_20250305`, received one provider-executed
WebSearch result containing ten source rows, and completed the final answer
without a second model call. This pins both the Codex/Responses and Claude
Code/Messages wire formats against live provider behavior.

Full production-surface smoke verification on 2026-08-04 then ran:

- `maka run` through a persisted DeepSeek Responses connection;
- `maka run` through a persisted DeepSeek Anthropic-compatible connection;
- the former Headless Harbor path with Responses and explicit WebSearch opt-in;
- the former Headless Harbor path with Anthropic Messages and the same opt-in.

All four runs completed with provider-executed WebSearch call/result pairs,
final model text, no local ToolRuntime execution of `WebSearch`, and durable
runtime events. Both historical Headless runs also persisted token summaries;
that deleted path is evidence for the provider capability, not evidence for the
new Runtime Host Eval subject. The
Responses CLI turn emitted search plus page-open actions; the Anthropic CLI
turn returned ten structured source rows.

After review fixes, local HTTP wire conformance also verified second-turn
replay through the real AI SDK provider converters for both protocols. A later
live-provider rerun on 2026-08-04 timed out before either provider returned its
first model event, so it did not replace the earlier successful live smoke or
the deterministic second-turn wire tests.

## Dual-wire selection

Native search never switches protocol independently from the primary model
request. The selected connection wire is authoritative:

- an OpenAI Responses session receives `openai.web_search`;
- an Anthropic Messages session receives `anthropic.web_search_20250305`.

For a provider that supports both, an explicit connection/model `apiProtocol`
wins. An ambiguous standard DeepSeek V4 connection defaults to Responses;
using the CC wire requires an explicit Anthropic-compatible connection. Maka
does not retry a failed native search over the other protocol.

A single same-prompt DeepSeek V4 Flash comparison on 2026-08-04 observed:

| Wire | Latency | Search calls | Visible source rows | Tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Responses | 9.46 s | 2 | 0 | 5,943 | $0.00046 |
| Anthropic Messages | 3.13 s | 1 | 10 | 9,638 | $0.00134 |

This is a smoke comparison, not a latency benchmark. It shows the trade-off:
the CC wire provided stricter `maxUses`, lower observed latency, and structured
source rows; Responses used much more cache, cost about one third as much, and
matched the general Codex/coding-agent wire. The default therefore remains
Responses, while the Anthropic-compatible route stays an explicit choice for
search-heavy workflows that value source visibility over cache economics.

## Provider matrix

| Provider or access path | Official hosted search surface | Model boundary | Maka state |
| --- | --- | --- | --- |
| DeepSeek | Responses `web_search`, server-executed | `deepseek-v4-flash` and `deepseek-v4-pro` | Integrated through `openai-responses` |
| OpenAI API | Responses `web_search` tool | Maka currently enables the native path for GPT-5 families, whose runtime wire is already Responses | Integrated through `openai-responses` |
| Custom Responses relay | Responses `web_search` tool when explicitly declared by model metadata | `openai-responses-compatible` connections with `apiProtocol=openai-responses` and `capabilities.webSearch=true` | Integrated through `openai-responses` |
| xAI API / OAuth | Responses Agent Tools `web_search` | Maka currently enables the verified Grok 4.5 Responses route | Integrated through `openai-responses` |
| Alibaba Model Studio | Responses `web_search` | Qwen 3.5 Plus/Flash provider support is recorded | Provider supports it; Maka Responses adapter pending |
| Anthropic / Claude subscription | Messages `web_search_20250305` | Current Claude Opus/Sonnet/Haiku/Fable families | Integrated through `anthropic-messages` |
| MiniMax API / Coding Plan | Anthropic-compatible `web_search_20250305` | MiniMax M2.7/M3 families | Integrated through `anthropic-messages`; live provider verification pending |
| Google Gemini | Gemini API grounding with Google Search | Supported Gemini 2.0+ model families vary by release | Provider supports it; Maka adapter pending |
| Z.AI / GLM Coding Plan | Chat tool and standalone Web Search API | GLM model/tool availability varies by endpoint | Provider supports it; Maka adapter pending |
| Mistral | Agents/Conversations `websearch` connector | Agent-capable models | Provider supports it; Maka adapter pending |
| Groq | Compound systems with built-in web search | `groq/compound` and `groq/compound-mini` | Provider supports it; Maka adapter pending |
| OpenRouter | Web plugin and `:online` variants | Depends on routed model/plugin support | Provider supports it; Maka adapter pending |
| Moonshot API | No general model-API hosted search contract found | Kimi Code exposes `SearchWeb`, but that is a managed coding-platform tool | Not treated as Moonshot model capability |
| Cohere, Together, Fireworks, SiliconFlow | No general hosted-search contract found in the reviewed API docs | Client tools or external search remain required | Use Tavily or another future external provider |

## Official references

- DeepSeek Responses compatibility:
  https://api-docs.deepseek.com/guides/responses_api
- DeepSeek Anthropic compatibility:
  https://api-docs.deepseek.com/guides/anthropic_api/
- OpenAI web search:
  https://developers.openai.com/api/docs/guides/tools-web-search
- Anthropic web search:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Gemini grounding with Google Search:
  https://ai.google.dev/gemini-api/docs/google-search
- xAI search tools:
  https://docs.x.ai/developers/tools/search-tools
- Alibaba Qwen web search:
  https://www.alibabacloud.com/help/en/model-studio/web-search
- Z.AI web search:
  https://docs.bigmodel.cn/cn/guide/tools/web-search
- Mistral websearch connector:
  https://docs.mistral.ai/agents/tools/built-in/websearch
- Groq web search:
  https://console.groq.com/docs/web-search
- OpenRouter web search:
  https://openrouter.ai/docs/guides/features/plugins/web-search

## Follow-up adapters

Add adapters in this order:

1. Add an opt-in `web_search_20260209` capability for Anthropic deployments
   that support dynamic filtering; retain `20250305` as the compatibility
   baseline used by Claude Code and third-party Anthropic-compatible services.
2. Gemini grounding with Google Search.
3. Z.AI native model tool. Keep its standalone Search API outside the
   provider-native path.
4. OpenRouter web plugin.
5. Mistral Agents and Groq Compound, after defining their cost and result-row
   projection contracts.

Every adapter must execute in the primary model request, preserve provider tool
events and citation metadata, keep credential isolation, and retain explicit
no-fallback behavior.
