/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

pub mod options;
pub mod profile;
mod reasoning;
use super::{
    CacheBudget, FunctionTool, HostedTool, PreparedTools, Tool, ToolChoice, ToolPolicy, Warning,
    citations::Document,
    constrained_schema,
    prompt::{PreparedPrompt, PromptOptions},
    response,
};
use crate::{
    Error, Result,
    input::{Message, UserPart},
};
use options::*;
use profile::Profile;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default)]
pub enum Reasoning {
    #[default]
    ProviderDefault,
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}
impl Reasoning {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProviderDefault => "provider-default",
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}
#[derive(Debug, Default)]
pub struct Sampling {
    pub max_output_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub top_k: Option<f64>,
    pub top_p: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub seed: Option<u64>,
}
#[derive(Debug, Default)]
pub enum Format {
    #[default]
    Text,
    Json {
        schema: Option<Value>,
    },
}
#[derive(Debug)]
pub struct ToolBinding {
    pub name: String,
    pub definition: Tool,
}
#[derive(Debug)]
pub struct Config {
    pub provider_namespace: String,
    pub cache_namespace: String,
    pub structured_output: bool,
    pub strict_tools: bool,
    pub max_temperature: Option<f64>,
    pub sampling_with_thinking: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            provider_namespace: "anthropic".into(),
            cache_namespace: "anthropic".into(),
            structured_output: true,
            strict_tools: true,
            max_temperature: None,
            sampling_with_thinking: false,
        }
    }
}
pub struct Request<'a> {
    pub model: String,
    pub messages: &'a [Message],
    pub tools: Vec<ToolBinding>,
    pub choice: Option<ToolChoice>,
    pub sampling: Sampling,
    pub reasoning: Reasoning,
    pub format: Format,
    pub options: ProviderOptions,
    pub custom_namespace_used: bool,
    pub streaming: bool,
    pub header_betas: Vec<String>,
}
#[derive(Debug, Clone, Copy)]
pub enum DiagnosticKind {
    Unsupported,
    Compatibility,
}
#[derive(Debug)]
pub enum Diagnostic {
    Setting {
        kind: DiagnosticKind,
        feature: String,
        details: Option<String>,
    },
    Message(String),
    Tool(Warning),
}
impl Diagnostic {
    fn unsupported(feature: impl Into<String>, details: impl Into<String>) -> Self {
        Self::Setting {
            kind: DiagnosticKind::Unsupported,
            feature: feature.into(),
            details: Some(details.into()),
        }
    }
    fn compatibility(feature: impl Into<String>, details: impl Into<String>) -> Self {
        Self::Setting {
            kind: DiagnosticKind::Compatibility,
            feature: feature.into(),
            details: Some(details.into()),
        }
    }
}
#[derive(Debug)]
pub struct Prepared {
    pub body: Body,
    pub diagnostics: Vec<Diagnostic>,
    pub betas: Vec<String>,
    pub response: response::Options,
}
#[derive(Debug, Serialize)]
pub struct Body {
    pub model: String,
    pub max_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Thinking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_config: Option<OutputConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<Speed>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<ServiceTier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inference_geo: Option<InferenceGeo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallbacks: Option<Fallbacks>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<super::CacheDirective>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<McpServer>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<WireContainer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safeguards: Option<Vec<Safeguard>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction: Option<Compaction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_management: Option<ContextManagement>,
    #[serde(flatten)]
    pub prompt: PreparedPrompt,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<super::tools::WireChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}
#[derive(Debug, Serialize)]
pub struct OutputConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_budget: Option<TaskBudget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<SchemaFormat>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename = "json_schema")]
pub struct SchemaFormat {
    pub schema: Value,
}
#[derive(Debug, Serialize)]
pub struct Metadata {
    pub user_id: String,
}
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum WireContainer {
    Id(String),
    Skills {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        skills: Vec<WireSkill>,
    },
}
#[derive(Debug, Serialize)]
pub struct WireSkill {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub skill_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}
fn beta(betas: &mut Vec<String>, name: impl Into<String>) {
    let name = name.into();
    if !betas.contains(&name) {
        betas.push(name);
    }
}
fn nonempty<T>(value: Option<Vec<T>>) -> Option<Vec<T>> {
    value.filter(|v| !v.is_empty())
}

pub fn prepare(request: Request<'_>, config: &Config) -> Result<Prepared> {
    prepare_inner(request, config, None)
}

/// Native streaming path: the prepass contains metadata/cache decisions only.
/// `body.prompt` is an empty framing placeholder; the caller streams its system
/// and message arrays with `prompt::streaming::Encoder` and the captured context.
pub fn prepare_streaming(
    request: Request<'_>,
    config: &Config,
    metadata: super::prompt::streaming::Metadata,
) -> Result<Prepared> {
    prepare_inner(request, config, Some(metadata))
}

fn prepare_inner(
    mut request: Request<'_>,
    config: &Config,
    metadata: Option<super::prompt::streaming::Metadata>,
) -> Result<Prepared> {
    let mut diagnostics = Vec::new();
    let model = &request.model;
    let profile = Profile::for_model(model);
    let sampling = &mut request.sampling;
    for (present, name) in [
        (sampling.frequency_penalty.is_some(), "frequencyPenalty"),
        (sampling.presence_penalty.is_some(), "presencePenalty"),
        (sampling.seed.is_some(), "seed"),
    ] {
        if present {
            diagnostics.push(Diagnostic::Setting {
                kind: DiagnosticKind::Unsupported,
                feature: name.into(),
                details: None,
            });
        }
    }
    let max_temperature = config.max_temperature.unwrap_or(1.0);
    let temperature_provider = if config.max_temperature.is_some() {
        config.provider_namespace.as_str()
    } else {
        "anthropic"
    };
    if let Some(temperature) = sampling.temperature {
        if temperature > max_temperature {
            diagnostics.push(Diagnostic::unsupported("temperature",format!("{temperature} exceeds {temperature_provider} maximum of {max_temperature:.1}. clamped to {max_temperature:.1}")));
            sampling.temperature = Some(max_temperature);
        } else if temperature < 0.0 {
            diagnostics.push(Diagnostic::unsupported(
                "temperature",
                format!("{temperature} is below {temperature_provider} minimum of 0. clamped to 0"),
            ));
            sampling.temperature = Some(0.0);
        }
    }
    if matches!(request.format, Format::Json { schema: None }) {
        diagnostics.push(Diagnostic::unsupported(
            "responseFormat",
            "JSON response format requires a schema. The response format is ignored.",
        ));
    }
    if !profile.known && sampling.max_output_tokens.is_none() {
        diagnostics.push(Diagnostic::compatibility("maxOutputTokens",format!("The model \"{model}\" is unknown. The max output tokens have been limited to {}. Set maxOutputTokens explicitly to override this limit.",profile.max_output_tokens)));
    }
    if profile.reject_sampling {
        for (value, name) in [
            (&mut sampling.temperature, "temperature"),
            (&mut sampling.top_k, "topK"),
            (&mut sampling.top_p, "topP"),
        ] {
            if value.take().is_some() {
                diagnostics.push(Diagnostic::unsupported(
                    name,
                    format!("{name} is not supported by {model} and will be ignored"),
                ));
            }
        }
    }
    let options = &mut request.options;
    let native_supported = config.structured_output && profile.structured;
    let has_schema = matches!(request.format, Format::Json { schema: Some(_) });
    let mut mode = options
        .structured_output_mode
        .unwrap_or(StructuredOutputMode::Auto);
    if mode == StructuredOutputMode::JsonTool
        && profile.reject_forced
        && native_supported
        && has_schema
    {
        diagnostics.push(Diagnostic::unsupported("providerOptions.anthropic.structuredOutputMode",format!("structuredOutputMode 'jsonTool' is not supported by {model} because it rejects forced tool use. Using 'outputFormat' instead.")));
        mode = StructuredOutputMode::OutputFormat;
    }
    let native_output = mode == StructuredOutputMode::OutputFormat
        || (mode == StructuredOutputMode::Auto && native_supported);
    let json_tool = has_schema && !native_output;
    if json_tool && options.disable_parallel_tool_use == Some(false) {
        diagnostics.push(Diagnostic::unsupported("providerOptions.anthropic.disableParallelToolUse","`disableParallelToolUse: false` is ignored when using the JSON response tool. Parallel tool use is disabled to ensure a single coherent JSON tool call."));
    }
    if options.compaction.is_some() && options.context_management.is_some() {
        return Err(Error::InvalidConfiguration {argument:"providerOptions".into(),message:"Anthropic provider options `compaction` and `contextManagement` cannot be used together.".into()});
    }
    let mut names = BTreeMap::new();
    let mut toolsets = BTreeMap::new();
    let mut response_names = BTreeMap::new();
    let mut explicit_code = false;
    let mut dynamic_web = false;
    let mut skills_code = false;
    for binding in &request.tools {
        if let Tool::Hosted(tool) = &binding.definition {
            let provider = tool.name().unwrap_or("computer");
            names.insert(binding.name.clone(), provider.into());
            response_names.insert(provider.into(), binding.name.clone());
            if matches!(tool, HostedTool::ComputerToolset(_)) {
                toolsets.insert(binding.name.clone(), "computer".into());
            }
            explicit_code |= matches!(tool, HostedTool::CodeExecution(_));
            skills_code |= matches!(
                tool,
                HostedTool::CodeExecution(
                    super::CodeVersion::V20250825 | super::CodeVersion::V20260120
                )
            );
            dynamic_web |= matches!(
                tool,
                HostedTool::WebFetch(
                    super::FetchVersion::V20260209 | super::FetchVersion::V20260318,
                    _
                ) | HostedTool::WebSearch(
                    super::SearchVersion::V20260209 | super::SearchVersion::V20260318,
                    _
                )
            );
        }
    }
    let (mut cache, mut prompt, documents) = if let Some(metadata) = metadata {
        (
            metadata.cache,
            PreparedPrompt {
                system: None,
                messages: Vec::new(),
                features: metadata.features,
                warnings: metadata.warnings,
            },
            metadata.documents,
        )
    } else {
        let mut cache = CacheBudget::default();
        let prompt = PreparedPrompt::encode(
            request.messages,
            PromptOptions {
                send_reasoning: options.send_reasoning.unwrap_or(true),
                cache_namespace: &config.cache_namespace,
                tool_names: &names,
                toolsets: &toolsets,
            },
            &mut cache,
        )?;
        (cache, prompt, documents(request.messages))
    };
    diagnostics.extend(prompt.warnings.drain(..).map(Diagnostic::Message));
    let mut betas = prompt
        .features
        .iter()
        .map(|s| (*s).into())
        .collect::<Vec<String>>();
    reasoning::resolve(model, profile, request.reasoning, options, &mut diagnostics);
    let active_thinking = options.thinking.as_ref().is_some_and(Thinking::active);
    let budgeted = options.thinking.as_ref().is_some_and(Thinking::budgeted);
    let mut thinking_budget = match options.thinking.as_ref() {
        Some(Thinking::Mode(ThinkingMode::Enabled { budget_tokens })) => *budget_tokens,
        _ => None,
    };
    if budgeted && thinking_budget.is_none() {
        diagnostics.push(Diagnostic::compatibility("extended thinking","thinking budget is required when thinking is enabled. using default budget of 1024 tokens."));
        thinking_budget = Some(1024);
        options.thinking = Some(Thinking::Mode(ThinkingMode::Enabled {
            budget_tokens: thinking_budget,
        }));
    }
    if active_thinking {
        for (value, name) in [
            (&mut sampling.temperature, "temperature"),
            (&mut sampling.top_k, "topK"),
            (&mut sampling.top_p, "topP"),
        ] {
            if !(config.sampling_with_thinking && matches!(name, "temperature" | "topP"))
                && value.take().is_some()
            {
                diagnostics.push(Diagnostic::unsupported(
                    name,
                    format!("{name} is not supported when thinking is enabled"),
                ));
            }
        }
    } else if (profile.known || model.contains("claude-"))
        && sampling.temperature.is_some()
        && sampling.top_p.take().is_some()
    {
        diagnostics.push(Diagnostic::unsupported(
            "topP",
            "topP is not supported when temperature is set. topP is ignored.",
        ));
    }
    let mut max_tokens = sampling
        .max_output_tokens
        .unwrap_or(profile.max_output_tokens)
        .checked_add(thinking_budget.unwrap_or(0))
        .ok_or_else(|| Error::InvalidArgument {
            field: "max output token overflow".into(),
            value: Value::Null,
        })?;
    if profile.known && max_tokens > profile.max_output_tokens {
        if sampling.max_output_tokens.is_some() {
            diagnostics.push(Diagnostic::unsupported("maxOutputTokens",format!("{max_tokens} (maxOutputTokens + thinkingBudget) is greater than {model} {} max output tokens. The max output tokens have been limited to {}.",profile.max_output_tokens,profile.max_output_tokens)));
        }
        max_tokens = profile.max_output_tokens;
    }
    let mcp_servers = nonempty(options.mcp_servers.take());
    let safeguards = nonempty(options.safeguards.take());
    if mcp_servers.is_some() {
        beta(&mut betas, "mcp-client-2025-04-04");
    }
    if safeguards.is_some() {
        beta(&mut betas, "dangerous-tool-use-2026-09-03");
    }
    if options.compaction.is_some() {
        beta(&mut betas, "compact-2026-09-04");
    }
    if let Some(context) = &options.context_management {
        beta(&mut betas, "context-management-2025-06-27");
        if context
            .edits
            .iter()
            .any(|edit| matches!(edit, ContextEdit::Compact { .. }))
        {
            beta(&mut betas, "compact-2026-01-12");
        }
    }
    let container = container(options.container.take())?;
    if matches!(&container,Some(WireContainer::Skills {skills,..}) if !skills.is_empty()) {
        for name in [
            "code-execution-2025-08-25",
            "skills-2025-10-02",
            "files-api-2025-04-14",
        ] {
            beta(&mut betas, name);
        }
        if !skills_code {
            diagnostics.push(Diagnostic::Message(
                "code execution tool is required when using skills".into(),
            ));
        }
    }
    if options.task_budget.is_some() {
        beta(&mut betas, "task-budgets-2026-03-13");
    }
    if options.speed == Some(Speed::Fast) {
        beta(&mut betas, "fast-mode-2026-02-01");
    }
    if matches!(
        options.thinking,
        Some(Thinking::Mode(ThinkingMode::Adaptive {
            display: Some(ThinkingDisplay::Updates),
            ..
        }))
    ) {
        beta(&mut betas, "thinking-display-updates-2026-08-18");
    }
    if options.thinking.as_ref().is_some_and(Thinking::bound) {
        beta(&mut betas, "thinking-binding-controls-2026-08-01");
    }
    let fallbacks = options
        .fallbacks
        .take()
        .filter(|f| !matches!(f,Fallbacks::Chain(chain) if chain.is_empty()));
    if let Some(fallbacks) = &fallbacks {
        beta(
            &mut betas,
            match fallbacks {
                Fallbacks::Default(_) => "server-side-fallback-2026-07-01",
                Fallbacks::Chain(_) => "server-side-fallback-2026-06-01",
            },
        );
    }
    let mut tools = request
        .tools
        .into_iter()
        .map(|b| b.definition)
        .collect::<Vec<_>>();
    let schema = match request.format {
        Format::Json { schema } => schema,
        Format::Text => None,
    };
    if json_tool {
        tools.push(Tool::Function(FunctionTool {
            name: "json".into(),
            description: Some("Respond with a JSON object.".into()),
            input_schema: schema.clone().unwrap(),
            cache_control: None,
            strict: None,
            defer_loading: None,
            eager_input_streaming: None,
            allowed_callers: None,
            input_examples: None,
        }));
    }
    let has_tools = !tools.is_empty();
    let prepared = PreparedTools::build(
        tools,
        if json_tool {
            Some(ToolChoice::Required)
        } else {
            request.choice
        },
        if json_tool {
            Some(true)
        } else {
            options.disable_parallel_tool_use
        },
        ToolPolicy {
            structured_output: !json_tool && native_supported,
            strict: config.strict_tools && profile.structured,
            eager_streaming: request.streaming && options.tool_streaming.unwrap_or(true),
            forced_choice: !profile.reject_forced && !budgeted,
        },
        &mut cache,
    );
    for feature in &prepared.features {
        beta(&mut betas, feature.header());
    }
    for header in request.header_betas {
        for name in header.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            beta(&mut betas, name.to_lowercase());
        }
    }
    for name in options.anthropic_beta.take().unwrap_or_default() {
        beta(&mut betas, name);
    }
    let wire_tools = has_tools.then(|| prepared.wire_tools());
    diagnostics.extend(prepared.warnings.into_iter().map(Diagnostic::Tool));
    diagnostics.extend(cache.into_warnings().into_iter().map(Diagnostic::Tool));
    let format = if native_output {
        schema.map(|schema| SchemaFormat {
            schema: constrained_schema(schema),
        })
    } else {
        None
    };
    let output_config =
        if options.effort.is_some() || options.task_budget.is_some() || format.is_some() {
            Some(OutputConfig {
                effort: options.effort,
                task_budget: options.task_budget.take(),
                format,
            })
        } else {
            None
        };
    let response = response::Options {
        tool_names: response_names,
        documents,
        json_tool,
        implicit_code_execution: dynamic_web && !explicit_code,
        metadata_namespace: request
            .custom_namespace_used
            .then(|| config.provider_namespace.clone()),
    };
    Ok(Prepared {
        body: Body {
            model: request.model,
            max_tokens,
            temperature: sampling.temperature,
            top_k: sampling.top_k,
            top_p: sampling.top_p,
            stop_sequences: sampling.stop_sequences.take(),
            thinking: options.thinking.take(),
            output_config,
            speed: options.speed,
            service_tier: options.service_tier.take(),
            inference_geo: options.inference_geo.take(),
            fallbacks,
            cache_control: options.cache_control,
            metadata: options
                .metadata
                .take()
                .and_then(|m| m.user_id)
                .map(|user_id| Metadata { user_id }),
            mcp_servers,
            container,
            safeguards,
            compaction: options.compaction.take(),
            context_management: options.context_management.take(),
            prompt,
            tools: wire_tools,
            tool_choice: prepared.choice,
            stream: request.streaming.then_some(true),
        },
        diagnostics,
        betas,
        response,
    })
}
fn container(value: Option<Container>) -> Result<Option<WireContainer>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(skills) = value.skills.filter(|s| !s.is_empty()) else {
        return Ok(value.id.map(WireContainer::Id));
    };
    let skills = skills
        .into_iter()
        .map(|skill| match skill {
            Skill::Anthropic { skill_id, version } => Ok(WireSkill {
                kind: "anthropic",
                skill_id,
                version,
            }),
            Skill::Custom {
                provider_reference,
                version,
            } => {
                let skill_id = provider_reference
                    .get("anthropic")
                    .cloned()
                    .ok_or_else(|| Error::MissingReference {
                        provider: "anthropic".into(),
                        reference: json!(provider_reference),
                    })?;
                Ok(WireSkill {
                    kind: "custom",
                    skill_id,
                    version,
                })
            }
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(WireContainer::Skills {
        id: value.id,
        skills,
    }))
}
fn documents(messages: &[Message]) -> Vec<Document> {
    messages
        .iter()
        .filter_map(|m| match m {
            Message::User { parts, .. } => Some(parts),
            _ => None,
        })
        .flatten()
        .filter_map(|part| {
            let UserPart::File(file) = part else {
                return None;
            };
            if !matches!(file.media_type.as_str(), "application/pdf" | "text/plain") {
                return None;
            }
            if file.extensions.as_ref()?.get("anthropic")?["citations"]["enabled"] != true {
                return None;
            }
            Some(Document {
                title: file
                    .filename
                    .clone()
                    .unwrap_or_else(|| "Untitled Document".into()),
                filename: file.filename.clone(),
                media_type: file.media_type.clone(),
            })
        })
        .collect()
}
