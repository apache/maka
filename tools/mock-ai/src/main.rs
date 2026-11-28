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

use clap::{Parser, ValueEnum};
use maka_mock_ai::{
    ControlPlaneConfig, LatencyProfile, MockAiBuilder, MockServerConfig, ProviderDialectProfile,
    ProxyRecordConfig, RateLimitConfig, RateLimitScope, RecorderMode, ReplayConfig,
    ReplayMatchMode, ScenarioSchedule, ScenarioSpec, ServerTuning, TlsServerConfig, WatchdogConfig,
    WorkloadConfig, builder_from_config,
};
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum Preset {
    Echo,
    Stress,
    LongSession,
    ChaosFuzz,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum LatencyPreset {
    Instant,
    Frontier,
    Degraded,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliDialect {
    #[value(name = "standard-openai", alias = "standard-open-ai")]
    StandardOpenAi,
    #[value(name = "deepseek-chat", alias = "deep-seek-chat")]
    DeepSeekChat,
    KimiChat,
    AnthropicMessages,
    #[value(name = "openai-responses", alias = "open-ai-responses")]
    OpenAiResponses,
}

impl From<CliDialect> for ProviderDialectProfile {
    fn from(dialect: CliDialect) -> Self {
        match dialect {
            CliDialect::StandardOpenAi => Self::StandardOpenAi,
            CliDialect::DeepSeekChat => Self::DeepSeekChat,
            CliDialect::KimiChat => Self::KimiChat,
            CliDialect::AnthropicMessages => Self::AnthropicMessages,
            CliDialect::OpenAiResponses => Self::OpenAiResponses,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliReplayMatch {
    Sequential,
    Fingerprint,
}

#[derive(Debug, Parser)]
#[command(
    name = "maka-mock-ai",
    about = "Local multi-protocol simulated AI server for Maka tests, evals, and load testing"
)]
struct Cli {
    /// Socket address to bind (use port 0 for ephemeral port).
    #[arg(long, default_value = "127.0.0.1:4014")]
    listen: SocketAddr,

    /// Path to a JSON or YAML MockServerConfig file.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Benchmark scenario file (JSON or YAML).
    #[arg(long, conflicts_with_all = ["preset", "proxy_record", "replay"])]
    scenario: Option<PathBuf>,

    /// Require requests to resolve to a registered benchmark session.
    #[arg(long)]
    strict_benchmark: bool,

    /// Select the provider response dialect.
    #[arg(long, value_enum)]
    provider_dialect: Option<CliDialect>,

    /// Reject missing, exhausted or truncated recordings instead of simulating them.
    #[arg(long, requires = "replay")]
    strict_replay: bool,

    /// Built-in workload preset when --config is omitted.
    #[arg(long, value_enum, default_value_t = Preset::Echo)]
    preset: Preset,

    /// Deterministic PRNG seed for workload presets.
    #[arg(long, default_value_t = 42)]
    seed: u64,

    /// Built-in latency physics preset (overrides base latency when not instant).
    #[arg(long, value_enum, default_value_t = LatencyPreset::Instant)]
    latency_profile: LatencyPreset,

    /// Activate built-in 3-phase repeating incident wave schedule (60s baseline -> 60s incident -> 60s recovery).
    #[arg(long)]
    incident_wave: bool,

    /// Optional stateful RPM limit.
    #[arg(long)]
    rpm: Option<u64>,

    /// Optional stateful ITPM limit.
    #[arg(long)]
    itpm: Option<u64>,

    /// Optional stateful OTPM limit.
    #[arg(long)]
    otpm: Option<u64>,

    /// Optional maximum concurrent in-flight turns.
    #[arg(long)]
    max_concurrent: Option<usize>,

    /// Transparently proxy all requests to an upstream provider URL and record to --cassette.
    #[arg(long)]
    proxy_record: Option<String>,

    /// Output NDJSON cassette file path used with --proxy-record.
    #[arg(long)]
    cassette: Option<PathBuf>,

    /// Replay a recorded NDJSON cassette file.
    #[arg(long)]
    replay: Option<PathBuf>,

    /// Playback speed multiplier for --replay (1.0 = recorded speed, 10.0 = 10x faster, 0.0 = instant).
    #[arg(long, default_value_t = 1.0)]
    replay_speed: f64,

    /// Cassette matching mode for --replay.
    #[arg(long, value_enum, default_value_t = CliReplayMatch::Sequential)]
    replay_match: CliReplayMatch,

    /// Enable /admin/* control endpoints (Prometheus /metrics is always enabled).
    #[arg(long)]
    admin: bool,

    /// Disable request body retention (atomic metrics only, recommended for high-concurrency load tests).
    #[arg(long)]
    metrics_only: bool,

    /// Disable the inline protocol invariant watchdog.
    #[arg(long)]
    no_watchdog: bool,

    /// Optional PEM certificate path to serve HTTPS/WSS on the mock listener.
    #[arg(long)]
    tls_cert: Option<PathBuf>,

    /// Optional PEM private key path paired with --tls-cert.
    #[arg(long)]
    tls_key: Option<PathBuf>,

    /// Optional custom CA PEM path for verifying self-signed/private TLS upstreams in --proxy-record.
    #[arg(long)]
    upstream_ca: Option<PathBuf>,

    /// Per-connection WebSocket read buffer size in bytes.
    #[arg(long, default_value_t = 16 * 1024)]
    ws_read_buffer_bytes: usize,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let cli = Cli::parse();
    let tuning = ServerTuning {
        ws_read_buffer_size: cli.ws_read_buffer_bytes,
        http_keep_alive: true,
        ..Default::default()
    };

    let scenario = if let Some(path) = &cli.scenario {
        let source = tokio::fs::read_to_string(path).await?;
        Some(
            if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
            {
                ScenarioSpec::from_json_str(&source)?
            } else {
                ScenarioSpec::from_yaml_str(&source)?
            },
        )
    } else {
        None
    };
    let mut strict_benchmark = cli.strict_benchmark;
    let mut builder = if let Some(path) = &cli.config {
        let mut cfg = MockServerConfig::from_file(path)?;
        if cli.admin {
            cfg.control.enable_admin_api = true;
        }
        if cli.metrics_only {
            cfg.recorder = RecorderMode::MetricsOnly;
        }
        if cli.no_watchdog {
            cfg.watchdog.enabled = false;
        }
        if scenario.is_some() {
            cfg.scenario = scenario;
        }
        strict_benchmark |= cfg.strict_benchmark;
        cfg.strict_benchmark = strict_benchmark;
        if let Some(dialect) = cli.provider_dialect {
            cfg.provider_dialect = Some(dialect.into());
        }
        builder_from_config(cfg)?
    } else {
        let control = ControlPlaneConfig {
            enable_admin_api: cli.admin,
            ..Default::default()
        };
        let recorder = if cli.metrics_only {
            RecorderMode::MetricsOnly
        } else {
            RecorderMode::Ring {
                capacity: 2_000,
                max_bytes: 64 * 1024 * 1024,
            }
        };
        let watchdog = WatchdogConfig {
            enabled: !cli.no_watchdog,
            ..Default::default()
        };
        let mut b = MockAiBuilder::new()
            .control(control)
            .recorder(recorder)
            .watchdog(watchdog)
            .strict_benchmark(strict_benchmark);
        if let Some(dialect) = cli.provider_dialect {
            b = b.provider_dialect(dialect.into());
        }
        if let Some(scenario) = scenario {
            b = b.scenario(scenario);
        }
        match cli.preset {
            Preset::Echo => b,
            Preset::Stress => b.workload(WorkloadConfig::stress_preset(cli.seed)),
            Preset::LongSession => {
                b.workload(WorkloadConfig::long_session_compaction_preset(cli.seed))
            }
            Preset::ChaosFuzz => b.workload(WorkloadConfig::chaos_fuzz_preset(cli.seed)),
        }
    };

    match cli.latency_profile {
        LatencyPreset::Instant => {}
        LatencyPreset::Frontier => {
            builder = builder.latency_profile(LatencyProfile::realistic_frontier())
        }
        LatencyPreset::Degraded => {
            builder = builder.latency_profile(LatencyProfile::degraded_incident())
        }
    }
    if cli.incident_wave {
        builder = builder.schedule(ScenarioSchedule::incident_wave());
    }
    if cli.rpm.is_some() || cli.itpm.is_some() || cli.otpm.is_some() || cli.max_concurrent.is_some()
    {
        builder = builder.rate_limit(RateLimitConfig {
            enabled: true,
            scope: RateLimitScope::Global,
            rpm: cli.rpm,
            itpm: cli.itpm,
            otpm: cli.otpm,
            max_concurrent: cli.max_concurrent,
            ..Default::default()
        });
    }
    if let (Some(cert), Some(key)) = (&cli.tls_cert, &cli.tls_key) {
        let tls = TlsServerConfig::from_pem_files(cert, key)
            .map_err(|e| format!("TLS server setup failed: {e}"))?;
        builder = builder.tls(tls);
    } else if cli.tls_cert.is_some() || cli.tls_key.is_some() {
        return Err("both --tls-cert and --tls-key must be provided together".into());
    }
    if let Some(upstream) = cli.proxy_record {
        let cassette_path = cli
            .cassette
            .unwrap_or_else(|| PathBuf::from("mock-ai-trace.ndjson"));
        let mut pcfg = ProxyRecordConfig::new(upstream, cassette_path);
        if let Some(ca_path) = &cli.upstream_ca {
            pcfg = pcfg
                .with_upstream_ca_file(ca_path)
                .map_err(|e| format!("upstream CA setup failed: {e}"))?;
        }
        builder = builder
            .proxy_record(pcfg)
            .map_err(|e| format!("proxy_record setup failed: {e}"))?;
    }
    if let Some(replay_path) = cli.replay {
        let mode = match cli.replay_match {
            CliReplayMatch::Sequential => ReplayMatchMode::Sequential,
            CliReplayMatch::Fingerprint => ReplayMatchMode::Fingerprint,
        };
        let mut replay = ReplayConfig::new(replay_path)
            .with_speed(cli.replay_speed)
            .with_match_mode(mode);
        replay.strict_replay = cli.strict_replay || strict_benchmark;
        builder = builder
            .replay(replay)
            .map_err(|e| format!("replay setup failed: {e}"))?;
    }

    let server = builder.bind(cli.listen).tuning(tuning).start().await?;
    tracing::info!(
        origin = %server.origin_url(),
        base_url = %server.base_url(),
        ws_url = %server.responses_ws_url(),
        metrics = %format!("{}/metrics", server.origin_url()),
        admin = cli.admin,
        "maka-mock-ai listening"
    );

    tokio::signal::ctrl_c().await?;
    tracing::info!("shutting down maka-mock-ai");
    server.shutdown().await;
    Ok(())
}
