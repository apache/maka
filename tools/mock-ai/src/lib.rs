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

//! High-concurrency, multi-protocol simulated AI server for Maka tests, evals, and load testing.
//!
//! Speaks OpenAI Chat Completions (HTTP SSE/JSON), OpenAI Responses (HTTP SSE/JSON + WebSocket
//! with connection-local `store:false` state), Anthropic Messages (HTTP SSE/JSON), plus
//! discovery/usage/storage control-plane endpoints, physics-based TTFT/TPS pacing, stateful
//! RPM/TPM rate limiting, JSON Schema tool argument synthesis, inline invariant watchdog,
//! Prometheus metrics, and optional TLS / YAML rules / transparent proxy record & replay.

pub mod codec;
pub mod control;
pub mod handler;
pub mod metrics;
pub mod pacing;
pub mod plan;
pub mod protocol;
#[cfg(feature = "proxy")]
pub mod proxy;
pub mod ratelimit;
pub mod routing;
#[cfg(feature = "rules")]
pub mod rules;
pub mod scenario;
pub mod schema_synth;
pub mod server;
#[cfg(feature = "tls")]
pub mod tls;
pub mod watchdog;
pub mod workload;

pub use control::{ControlPlaneConfig, CustomResponse, CustomRouteFn, ModelEntry, StoredResponses};
pub use handler::{
    ChainHandler, FnHandler, InteractiveHandler, ScriptedHandler, SessionTracker, TurnContext,
    TurnDecision, TurnHandle, TurnHandler,
};
pub use metrics::{
    AtomicHistogram, AttemptOutcome, AttemptSpan, DimensionCounter, HistogramSummary,
    MetricsSnapshot, RecordedControlRequest, RecordedRequest, RecorderMode, RequestPurpose,
    RequestRecorder, ServerMetrics, SessionTelemetryStore,
};
pub use pacing::{
    DynamicProfileManager, LatencyProfile, ProfileSnapshot, RuntimeProfile, ScenarioPhase,
    ScenarioSchedule, TurnPacer,
};
pub use plan::{
    Citation, CloseSignal, CompactionOutput, FinishReason, FrameKind, HttpErrorSpec,
    MidStreamErrorSpec, NativeToolEvent, ProviderDialectProfile, ToolCallPayload, ToolCallSpec,
    TurnEvent, TurnPlan, TurnUsage, Usage, WebSearchResult,
};
pub use protocol::{
    AuthPolicy, NormalizedMessage, NormalizedRequest, NormalizedRole, NormalizedTool, Protocol,
    RequestOptions, RequestSizeBreakdown, ToolDeclKind, Transport,
};
#[cfg(feature = "proxy")]
pub use proxy::{
    CassetteReplayer, CassetteWriter, ExchangeKind, ExchangeOutcome, ProxyRecordConfig,
    ProxyRecorder, RecordedExchange, ReplayConfig, ReplayMatchMode, TimedChunk,
};
pub use ratelimit::{
    RateLimitConfig, RateLimitDecision, RateLimitHeaders, RateLimitLease, RateLimitScope,
    RateLimiter,
};
pub use routing::{RequestClassifier, RequestUse, SessionRegistration};
#[cfg(feature = "rules")]
pub use rules::{ConfigError, MockServerConfig, RuleEngine, RuleMatcher, RuleSpec};
pub use scenario::{ScenarioEngine, ScenarioSpec};
pub use schema_synth::{
    SynthMode, WirePoisonConfig, context_overflow_error, poison_sse_frame,
    synthesize_tool_arguments, try_synthesize_tool_arguments,
};
pub use server::{MockAiBuilder, MockAiServer, ServerTuning};
#[cfg(feature = "tls")]
pub use tls::{TlsServerConfig, UpstreamWsStream, build_tls_connector, connect_ws_upstream};
pub use watchdog::{
    ProtocolWatchdog, StreamCloseReason, ViolationKind, ViolationRecord, WatchdogConfig,
    WatchdogSnapshot,
};
pub use workload::{ChaosConfig, SyntheticToolTemplate, WorkloadConfig, WorkloadGenerator};

/// Build a `MockAiBuilder` directly from a declarative `MockServerConfig` (JSON/YAML).
#[cfg(feature = "rules")]
pub fn builder_from_config(config: MockServerConfig) -> Result<MockAiBuilder, ConfigError> {
    use std::sync::Arc;

    config.validate()?;

    let has_workload = config.workload.is_some();
    let mut handlers: Vec<Arc<dyn TurnHandler>> = Vec::new();
    let mut rule_engine_ref = None;

    if !config.rules.is_empty() || config.workload.is_none() {
        let engine = Arc::new(RuleEngine::new(
            config.rules,
            if config.workload.is_some() {
                None
            } else {
                config.default_reply.clone()
            },
        )?);
        rule_engine_ref = Some(engine.clone());
        handlers.push(engine);
    }

    if let Some(workload) = config.workload {
        handlers.push(Arc::new(WorkloadGenerator::new(workload)));
    }

    let handler: Arc<dyn TurnHandler> = if handlers.len() == 1 {
        handlers.pop().unwrap()
    } else {
        Arc::new(ChainHandler::new(handlers))
    };

    let mut builder = MockAiBuilder::new()
        .auth(config.auth)
        .control(config.control)
        .recorder(config.recorder)
        .latency_profile(config.latency)
        .schedule(config.schedule)
        .rate_limit(config.rate_limit)
        .watchdog(config.watchdog)
        .strict_benchmark(config.strict_benchmark)
        .request_classifier(config.request_classifier)
        .handler(handler)
        .with_workload_flag(has_workload);
    if let Some(spec) = config.scenario {
        builder = builder.scenario(spec);
    }
    if let Some(dialect) = config.provider_dialect {
        builder = builder.provider_dialect(dialect);
    }
    if let Some(engine) = rule_engine_ref {
        builder = builder.with_rule_engine(engine);
    }
    Ok(builder)
}
