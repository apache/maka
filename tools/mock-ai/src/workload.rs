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

use crate::handler::{HandlerFuture, TurnContext, TurnDecision, TurnHandler};
use crate::plan::{
    Citation, CompactionOutput, FinishReason, HttpErrorSpec, MidStreamErrorSpec, NativeToolEvent,
    ToolCallSpec, TurnEvent, TurnPlan, Usage, WebSearchResult,
};
use crate::protocol::{NormalizedRequest, NormalizedTool};
use crate::schema_synth::{
    SynthMode, WirePoisonConfig, context_overflow_error, synthesize_tool_arguments,
    try_synthesize_tool_arguments,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::hash::{Hash, Hasher};

/// Deterministic high-concurrency & long-session workload generator configuration.
///
/// PRNG state is derived purely from `hash(seed, session_key, session_turn)`, so concurrent
/// out-of-order HTTP/WS requests stay 100% reproducible with zero lock contention.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadConfig {
    #[serde(default = "default_seed")]
    pub seed: u64,
    /// Number of consecutive tool-calling turns per session before emitting a final answer.
    #[serde(default = "default_tool_turns")]
    pub tool_turns_per_session: u64,
    /// Min/max parallel tool calls emitted during a tool-calling turn.
    #[serde(default = "default_one")]
    pub min_parallel_tools: usize,
    #[serde(default = "default_one")]
    pub max_parallel_tools: usize,
    /// Preferred tool templates (used when matching tools are advertised, or verbatim if `strict_advertised_tools == false`).
    #[serde(default)]
    pub tool_templates: Vec<SyntheticToolTemplate>,
    /// If true, only invoke tools present in `req.tools` (prevents bogus unknown-tool loops).
    #[serde(default = "default_true")]
    pub strict_advertised_tools: bool,
    /// Synthesize arguments directly from each advertised tool's JSON Schema (`parameters` / `input_schema`).
    #[serde(default = "default_true")]
    pub use_json_schema_synthesis: bool,
    /// Target byte size when injecting `huge_tool_payload_rate` large tool arguments (default 64 KiB).
    #[serde(default = "default_huge_tool_bytes")]
    pub huge_tool_payload_bytes: usize,
    /// Probability [0.0, 1.0] of emitting a thinking/reasoning block before text/tools.
    #[serde(default)]
    pub reasoning_probability: f64,
    #[serde(default = "default_reasoning_chars")]
    pub reasoning_chars: usize,
    /// Probability [0.0, 1.0] of emitting a provider-native web_search event (when supported).
    #[serde(default)]
    pub web_search_probability: f64,
    /// Visible assistant response size bounds in characters for final answer turns.
    #[serde(default = "default_min_response_chars")]
    pub min_response_chars: usize,
    #[serde(default = "default_max_response_chars")]
    pub max_response_chars: usize,
    /// Split text/reasoning/tool args into streaming deltas of this many chars (0 = single chunk).
    #[serde(default = "default_chunk_chars")]
    pub chunk_chars: usize,
    /// Simulated time-to-first-token latency range in ms.
    #[serde(default)]
    pub ttft_min_ms: u64,
    #[serde(default)]
    pub ttft_max_ms: u64,
    /// Per-chunk streaming delay in ms.
    #[serde(default)]
    pub chunk_delay_ms: u64,
    /// Prompt byte threshold for Anthropic server-side native compaction (only when request enables Anthropic compaction).
    #[serde(default = "default_compaction_threshold")]
    pub anthropic_compaction_threshold_bytes: usize,
    /// Optional prompt byte ceiling above which the server returns HTTP 400 `context_length_exceeded`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_overflow_bytes: Option<usize>,
    /// Multiplier applied to estimated input tokens to accelerate triggering real client-side compaction during stress tests.
    #[serde(default = "default_one_f64")]
    pub usage_input_multiplier: f64,
    /// Fraction [0.0, 1.0] of input tokens reported as prompt-cache hits on turns > 1.
    #[serde(default = "default_cache_ratio")]
    pub cache_hit_ratio: f64,
    /// Optional wire-level SSE framing poison applied to generated turns.
    #[serde(default)]
    pub wire_poison: WirePoisonConfig,
    /// Chaos / fault injection probabilities [0.0, 1.0].
    #[serde(default)]
    pub chaos: ChaosConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosConfig {
    /// Probability of HTTP 429 rate-limit before streaming.
    #[serde(default)]
    pub rate_limit_rate: f64,
    #[serde(default = "default_retry_ms")]
    pub rate_limit_retry_after_ms: u64,
    /// Probability of HTTP 503 overloaded before streaming.
    #[serde(default)]
    pub server_error_rate: f64,
    /// Probability of in-band mid-stream error after partial text.
    #[serde(default)]
    pub mid_stream_error_rate: f64,
    /// Probability of abrupt connection reset mid-stream.
    #[serde(default)]
    pub drop_connection_rate: f64,
    /// Probability of premature clean EOF mid-stream.
    #[serde(default)]
    pub truncate_eof_rate: f64,
    /// Probability of generating bad tool arguments (missing required / wrong type / malformed JSON).
    #[serde(default)]
    pub bad_tool_rate: f64,
    /// Probability of hallucinating a non-existent tool name.
    #[serde(default)]
    pub unknown_tool_rate: f64,
    /// Probability of injecting a large tool payload (`huge_tool_payload_bytes`).
    #[serde(default)]
    pub huge_tool_payload_rate: f64,
    /// Probability of ending a final answer turn with `FinishReason::Length` (max_output_tokens truncation).
    #[serde(default)]
    pub max_output_truncation_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticToolTemplate {
    pub name: String,
    pub arguments: Value,
}

fn default_seed() -> u64 {
    42
}
fn default_tool_turns() -> u64 {
    0
}
fn default_one() -> usize {
    1
}
fn default_one_f64() -> f64 {
    1.0
}
fn default_true() -> bool {
    true
}
fn default_huge_tool_bytes() -> usize {
    64 * 1024
}
fn default_reasoning_chars() -> usize {
    120
}
fn default_min_response_chars() -> usize {
    64
}
fn default_max_response_chars() -> usize {
    256
}
fn default_chunk_chars() -> usize {
    32
}
fn default_compaction_threshold() -> usize {
    64 * 1024
}
fn default_cache_ratio() -> f64 {
    0.5
}
fn default_retry_ms() -> u64 {
    50
}

impl Default for WorkloadConfig {
    fn default() -> Self {
        Self {
            seed: default_seed(),
            tool_turns_per_session: default_tool_turns(),
            min_parallel_tools: 1,
            max_parallel_tools: 1,
            tool_templates: Vec::new(),
            strict_advertised_tools: true,
            use_json_schema_synthesis: true,
            huge_tool_payload_bytes: default_huge_tool_bytes(),
            reasoning_probability: 0.0,
            reasoning_chars: default_reasoning_chars(),
            web_search_probability: 0.0,
            min_response_chars: default_min_response_chars(),
            max_response_chars: default_max_response_chars(),
            chunk_chars: default_chunk_chars(),
            ttft_min_ms: 0,
            ttft_max_ms: 0,
            chunk_delay_ms: 0,
            anthropic_compaction_threshold_bytes: default_compaction_threshold(),
            context_overflow_bytes: None,
            usage_input_multiplier: 1.0,
            cache_hit_ratio: default_cache_ratio(),
            wire_poison: WirePoisonConfig::default(),
            chaos: ChaosConfig::default(),
        }
    }
}

impl WorkloadConfig {
    /// Preset for high-concurrency stress testing (fast, realistic multi-turn tool chains + cache usage).
    pub fn stress_preset(seed: u64) -> Self {
        Self {
            seed,
            tool_turns_per_session: 4,
            min_parallel_tools: 1,
            max_parallel_tools: 3,
            reasoning_probability: 0.35,
            reasoning_chars: 180,
            min_response_chars: 128,
            max_response_chars: 1024,
            chunk_chars: 64,
            usage_input_multiplier: 1.0,
            cache_hit_ratio: 0.75,
            ..Default::default()
        }
    }

    /// Preset for ultra-long session + compaction stress (amplified usage + deep tool chains).
    pub fn long_session_compaction_preset(seed: u64) -> Self {
        Self {
            seed,
            tool_turns_per_session: 20,
            min_parallel_tools: 1,
            max_parallel_tools: 4,
            reasoning_probability: 0.5,
            reasoning_chars: 240,
            min_response_chars: 256,
            max_response_chars: 2048,
            chunk_chars: 64,
            anthropic_compaction_threshold_bytes: 16 * 1024,
            usage_input_multiplier: 4.0,
            cache_hit_ratio: 0.8,
            ..Default::default()
        }
    }

    /// Chaos & wire-fuzzing preset (bad tools, truncation, UTF-8 boundary splitting, CRLF, comments).
    pub fn chaos_fuzz_preset(seed: u64) -> Self {
        Self {
            seed,
            tool_turns_per_session: 6,
            min_parallel_tools: 1,
            max_parallel_tools: 3,
            reasoning_probability: 0.4,
            chunk_chars: 19,
            wire_poison: WirePoisonConfig {
                split_utf8_boundaries: true,
                crlf_line_endings: true,
                inject_sse_comments: true,
            },
            chaos: ChaosConfig {
                rate_limit_rate: 0.05,
                rate_limit_retry_after_ms: 80,
                server_error_rate: 0.02,
                mid_stream_error_rate: 0.03,
                drop_connection_rate: 0.02,
                truncate_eof_rate: 0.02,
                bad_tool_rate: 0.15,
                unknown_tool_rate: 0.05,
                huge_tool_payload_rate: 0.05,
                max_output_truncation_rate: 0.10,
            },
            ..Default::default()
        }
    }
}

/// Stateless, lock-free deterministic workload generator implementing `TurnHandler`.
pub struct WorkloadGenerator {
    config: WorkloadConfig,
}

impl WorkloadGenerator {
    pub fn new(config: WorkloadConfig) -> Self {
        Self { config }
    }

    fn turn_rng(&self, req: &NormalizedRequest, ctx: &TurnContext) -> fastrand::Rng {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.config.seed.hash(&mut hasher);
        req.session_key.hash(&mut hasher);
        ctx.session_turn.hash(&mut hasher);
        fastrand::Rng::with_seed(hasher.finish())
    }

    fn compute_usage(
        &self,
        req: &NormalizedRequest,
        ctx: &TurnContext,
        output_chars: usize,
        reasoning_chars: usize,
    ) -> Usage {
        let scaled_in = ((req.estimated_input_tokens as f64) * self.config.usage_input_multiplier)
            .round()
            .max(16.0) as u64;
        let reasoning_tokens = (reasoning_chars as u64) / 4;
        let text_tokens = ((output_chars as u64).max(16)) / 4;
        let output_tokens = text_tokens + reasoning_tokens;
        let cache_read = if ctx.session_turn > 1 && self.config.cache_hit_ratio > 0.0 {
            Some(((scaled_in as f64) * self.config.cache_hit_ratio.clamp(0.0, 0.95)) as u64)
        } else {
            None
        };
        let cache_creation = if ctx.session_turn == 1 && self.config.cache_hit_ratio > 0.0 {
            Some(scaled_in / 2)
        } else {
            None
        };
        Usage {
            input_tokens: scaled_in,
            output_tokens,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_creation,
            reasoning_tokens: (reasoning_tokens > 0).then_some(reasoning_tokens),
        }
    }

    fn build_plan(&self, req: &NormalizedRequest, ctx: &TurnContext) -> TurnPlan {
        let mut rng = self.turn_rng(req, ctx);
        let chaos = ctx.chaos_override.as_ref().unwrap_or(&self.config.chaos);

        // 0) Context overflow ceiling (exercises Maka's emergency compaction & retry path)
        if let Some(limit_bytes) = self.config.context_overflow_bytes
            && !req.has_compaction_trigger
            && req.prompt_bytes > limit_bytes
        {
            return TurnPlan::http_error(context_overflow_error(
                req.protocol,
                req.prompt_bytes,
                limit_bytes,
            ));
        }

        // 1) Pre-stream chaos faults
        let roll = rng.f64();
        if roll < chaos.rate_limit_rate {
            return TurnPlan::http_error(
                HttpErrorSpec::rate_limit(None, "synthetic rate limit")
                    .with_retry_after_ms(chaos.rate_limit_retry_after_ms),
            );
        }
        if roll < chaos.rate_limit_rate + chaos.server_error_rate {
            return TurnPlan::http_error(HttpErrorSpec::new(
                503,
                "overloaded_error",
                "synthetic upstream overload",
            ));
        }

        let mut plan = TurnPlan::new()
            .with_chunk_delay_ms(self.config.chunk_delay_ms)
            .with_wire_poison(self.config.wire_poison.clone());

        // Optional static TTFT delay (if dynamic LatencyProfile isn't driving TTFT)
        if self.config.ttft_max_ms > 0 {
            let lo = self.config.ttft_min_ms.min(self.config.ttft_max_ms);
            let hi = self.config.ttft_max_ms;
            let delay = if hi > lo { rng.u64(lo..=hi) } else { lo };
            if delay > 0 {
                plan = plan.with_ttft_ms(delay);
            }
        }

        // 2) Authentic Codex/Responses native compaction ONLY when requested via compaction_trigger
        if req.has_compaction_trigger {
            let encrypted = format!(
                "mock_native_checkpoint:{}:turn_{}:bytes_{}",
                req.session_key, ctx.session_turn, req.prompt_bytes
            );
            let usage = self.compute_usage(req, ctx, encrypted.len(), 0);
            return plan
                .push_compaction(CompactionOutput::new(encrypted))
                .with_usage(usage)
                .finish(FinishReason::Compaction);
        }

        // 3) Authentic Anthropic native compaction when enabled on request AND context crosses threshold
        if req.anthropic_compaction_enabled
            && self.config.anthropic_compaction_threshold_bytes > 0
            && req.prompt_bytes >= self.config.anthropic_compaction_threshold_bytes
        {
            let summary = format!(
                "[Compacted state for {} at turn {} ({} prompt bytes)]",
                req.session_key, ctx.session_turn, req.prompt_bytes
            );
            let usage = self.compute_usage(req, ctx, summary.len(), 0);
            return plan
                .push_compaction(CompactionOutput::new(summary).with_pause(true))
                .with_usage(usage)
                .finish(FinishReason::Compaction);
        }

        // 4) Optional reasoning/thinking prefix
        let mut reasoning_len = 0;
        if self.config.reasoning_probability > 0.0 && rng.f64() < self.config.reasoning_probability
        {
            let thought = synth_text(
                &mut rng,
                self.config.reasoning_chars.max(16),
                "analyzing context and planning step",
            );
            reasoning_len = thought.len();
            plan = plan.push(TurnEvent::Reasoning {
                text: thought,
                chunk_chars: self.config.chunk_chars,
                signature: Some(format!("sig_{}_{}", req.session_key, ctx.session_turn)),
                encrypted_content: Some(format!("enc_rs_{}_{}", req.session_key, ctx.session_turn)),
            });
        }

        // 5) Mid-stream chaos faults (after partial visible text)
        let mid_roll = rng.f64();
        let mid_err_end = chaos.mid_stream_error_rate;
        let drop_end = mid_err_end + chaos.drop_connection_rate;
        let eof_end = drop_end + chaos.truncate_eof_rate;
        if mid_roll < eof_end {
            plan = plan.push_text("Partial synthetic output before fault... ");
            if mid_roll < mid_err_end {
                return plan.push(TurnEvent::MidStreamError(MidStreamErrorSpec {
                    error_type: "server_error".into(),
                    code: Some("stream_interrupted".into()),
                    message: "synthetic mid-stream failure".into(),
                    retryable: Some(true),
                }));
            } else if mid_roll < drop_end {
                return plan.push(TurnEvent::DropConnection);
            } else {
                return plan.push(TurnEvent::TruncateEof);
            }
        }

        // 6) Optional native web_search
        if self.config.web_search_probability > 0.0
            && rng.f64() < self.config.web_search_probability
        {
            let query = format!("maka load query turn {}", ctx.session_turn);
            plan = plan.push(TurnEvent::NativeTool(NativeToolEvent::WebSearch {
                id: format!("ws_{}_{}", ctx.global_turn, ctx.session_turn),
                query,
                results: vec![WebSearchResult {
                    url: "https://example.org/maka-workload".into(),
                    title: "Synthetic Reference".into(),
                    encrypted_content: Some("opaque_enc".into()),
                }],
            }));
        }

        // 7) Multi-step tool chain (with JSON Schema synthesis & bad-tool chaos)
        let want_tools = ctx.session_turn <= self.config.tool_turns_per_session;
        let candidates = self.select_tool_candidates(req, chaos, &mut rng);
        if want_tools && !candidates.is_empty() {
            let lo = self.config.min_parallel_tools.max(1);
            let hi = self.config.max_parallel_tools.max(lo);
            let count = if hi > lo { rng.usize(lo..=hi) } else { lo };
            let mut total_arg_chars = 0;
            for idx in 0..count {
                let tpl = &candidates[rng.usize(0..candidates.len())];
                let call_id = format!("call_t{}_{idx}", ctx.session_turn);
                let item_id = format!("fc_t{}_{idx}", ctx.session_turn);
                let tool_name =
                    if chaos.unknown_tool_rate > 0.0 && rng.f64() < chaos.unknown_tool_rate {
                        format!("hallucinated_tool_{}", rng.u16(1..999))
                    } else {
                        tpl.name.clone()
                    };
                let mut spec = ToolCallSpec::new(call_id, tool_name, tpl.arguments.clone())
                    .with_chunk_chars(self.config.chunk_chars);
                spec.item_id = Some(item_id);
                total_arg_chars += spec.arguments_string().len();
                plan = plan.push(TurnEvent::ToolCall(spec));
            }
            let usage = self.compute_usage(req, ctx, total_arg_chars, reasoning_len);
            return plan.with_usage(usage).finish(FinishReason::ToolCalls);
        }

        // Final answer turn (with optional max_output_tokens truncation fault)
        let lo = self
            .config
            .min_response_chars
            .min(self.config.max_response_chars);
        let hi = self.config.max_response_chars.max(lo).max(16);
        let target_chars = if hi > lo {
            rng.usize(lo..=hi)
        } else {
            lo.max(16)
        };
        let body = synth_text(
            &mut rng,
            target_chars,
            &format!(
                "Completed session={} turn={} model={}",
                req.session_key, ctx.session_turn, req.model
            ),
        );
        let citations = if self.config.web_search_probability > 0.0 {
            vec![Citation {
                url: "https://example.org/maka-workload".into(),
                title: Some("Synthetic Reference".into()),
                cited_text: Some("verified result".into()),
            }]
        } else {
            Vec::new()
        };
        let finish_reason = if chaos.max_output_truncation_rate > 0.0
            && rng.f64() < chaos.max_output_truncation_rate
        {
            FinishReason::Length
        } else {
            FinishReason::Stop
        };
        let usage = self.compute_usage(req, ctx, body.len(), reasoning_len);
        plan.push(TurnEvent::Text {
            text: body,
            chunk_chars: self.config.chunk_chars,
            citations,
        })
        .with_usage(usage)
        .finish(finish_reason)
    }

    fn select_tool_candidates(
        &self,
        req: &NormalizedRequest,
        chaos: &ChaosConfig,
        rng: &mut fastrand::Rng,
    ) -> Vec<SyntheticToolTemplate> {
        if !self.config.tool_templates.is_empty() {
            if self.config.strict_advertised_tools {
                return self
                    .config
                    .tool_templates
                    .iter()
                    .filter(|t| req.has_tool(&t.name))
                    .cloned()
                    .collect();
            }
            return self.config.tool_templates.clone();
        }
        req.tools
            .iter()
            .filter(|t| t.kind.as_deref() != Some("web_search"))
            .filter_map(|t| self.synthesize_for_tool(t, chaos, rng))
            .collect()
    }

    fn synthesize_for_tool(
        &self,
        tool: &NormalizedTool,
        chaos: &ChaosConfig,
        rng: &mut fastrand::Rng,
    ) -> Option<SyntheticToolTemplate> {
        let mode = if chaos.huge_tool_payload_rate > 0.0 && rng.f64() < chaos.huge_tool_payload_rate
        {
            SynthMode::HugePayload(self.config.huge_tool_payload_bytes)
        } else if chaos.bad_tool_rate > 0.0 && rng.f64() < chaos.bad_tool_rate {
            match rng.u8(0..3) {
                0 => SynthMode::MissingRequired,
                1 => SynthMode::WrongType,
                _ => SynthMode::MalformedJson,
            }
        } else {
            SynthMode::Valid
        };

        let args = if self.config.use_json_schema_synthesis {
            if let Some(ref schema) = tool.parameters {
                match try_synthesize_tool_arguments(schema, rng, mode) {
                    Ok(v) => v,
                    Err(err) => {
                        tracing::debug!(tool = %tool.name, %err, "skipping tool whose schema exceeded synthesis budget");
                        return None;
                    }
                }
            } else {
                fallback_tool_args(tool, rng, mode)
            }
        } else {
            fallback_tool_args(tool, rng, mode)
        };

        Some(SyntheticToolTemplate {
            name: tool.name.clone(),
            arguments: args,
        })
    }
}

fn fallback_tool_args(tool: &NormalizedTool, rng: &mut fastrand::Rng, mode: SynthMode) -> Value {
    if matches!(mode, SynthMode::MalformedJson) {
        return Value::String("{\"input\": \"broken".into());
    }
    if let SynthMode::HugePayload(sz) = mode {
        return synthesize_tool_arguments(
            &json!({"type": "object", "properties": {"input": {"type": "string"}}}),
            rng,
            SynthMode::HugePayload(sz),
        );
    }
    match tool.name.as_str() {
        "exec" => json!({ "code": "text('synthetic-exec-ok');" }),
        "Read" => json!({ "path": "README.md", "offset": 0, "limit": 20 }),
        "Shell" => json!({ "command": "echo synthetic-ok" }),
        _ => json!({ "input": "synthetic" }),
    }
}

impl TurnHandler for WorkloadGenerator {
    fn handle<'a>(&'a self, req: &'a NormalizedRequest, ctx: &'a TurnContext) -> HandlerFuture<'a> {
        let plan = self.build_plan(req, ctx);
        Box::pin(async move { Some(TurnDecision::Plan(plan)) })
    }
}

const VOCAB: &[&str] = &[
    "alpha", "beta", "context", "delta", "engine", "frame", "graph", "handler", "index", "kernel",
    "latency", "memory", "pipeline", "query", "runtime", "session", "stream", "token", "vector",
    "worker",
];

fn synth_text(rng: &mut fastrand::Rng, target_chars: usize, prefix: &str) -> String {
    let mut out = String::with_capacity(target_chars + 32);
    out.push_str(prefix);
    while out.len() < target_chars {
        out.push(' ');
        out.push_str(VOCAB[rng.usize(0..VOCAB.len())]);
    }
    if out.len() > target_chars && target_chars >= prefix.len() {
        out.truncate(target_chars);
    }
    out
}
