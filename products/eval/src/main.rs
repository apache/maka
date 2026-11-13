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

use clap::{Parser, Subcommand};
use maka_eval::contract::{expand_experiment, parse_experiment_spec};
use maka_eval::environment::{HarborExecutorConfig, HarborTrialEnvironment};
use maka_eval::parity::{ParityVerificationReport, verify_experiment_parity};
use maka_eval::report::{
    MilestoneGate, build_cohort_summary, evaluate_milestone_gate, export_v1_canonical,
    export_v2_canonical,
};
use maka_eval::runner::{RunExperimentInput, run_experiment};
use maka_eval::store::{ExperimentDirectory, write_atomic_bytes};
use maka_eval::subject::{ExternalCliSubject, RustHostSubject, SubjectAdapter};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use tokio_util::sync::CancellationToken;

pub const USAGE: &str = "usage: maka eval <run|parity|report> <spec.json> ...";

#[derive(Debug, Parser)]
#[command(
    name = "maka-eval",
    about = "Maka evaluation measurement and control plane"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    #[command(hide = true)]
    HostSubject { payload: String },
    /// Execute an evaluation experiment specification.
    Run {
        /// Path to the experiment specification JSON file.
        spec: PathBuf,
        /// Experiment output directory.
        #[arg(long = "out")]
        out_dir: PathBuf,
        /// Optional repeatable cell ID filter.
        #[arg(long = "cell")]
        cell_ids: Vec<String>,
    },
    /// Verify Product Parity between normal Maka client execution and maka-eval.
    Parity {
        /// Path to the experiment specification JSON file.
        spec: PathBuf,
        /// Optional Maka subject ID filter.
        #[arg(long = "subject")]
        subject_id: Option<String>,
        /// Optional path to write the parity verification report JSON.
        #[arg(long = "out")]
        out_file: Option<PathBuf>,
    },
    /// Validate or inspect an experiment directory, export canonical projections, and enforce M3/M5 gates.
    Report {
        /// Path to the experiment specification JSON file.
        spec: PathBuf,
        /// Experiment output directory.
        #[arg(long = "out")]
        out_dir: PathBuf,
        /// Output format (`summary`, `v1`, or `v2`).
        #[arg(long, default_value = "summary")]
        format: String,
        /// Optional milestone acceptance gate (`m3` or `m5`), requiring verified Product Parity.
        #[arg(long = "milestone")]
        milestone: Option<String>,
        /// Repeatable path(s) to `ParityVerificationReport` JSON file(s).
        #[arg(long = "parity-report")]
        parity_reports: Vec<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("{err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    match cli.command {
        Command::HostSubject { payload } => {
            let stop = CancellationToken::new();
            let signal_stop = stop.clone();
            tokio::spawn(async move {
                #[cfg(unix)]
                {
                    use tokio::signal::unix::{SignalKind, signal};
                    let mut term = signal(SignalKind::terminate()).expect("SIGTERM registration");
                    tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
                }
                #[cfg(not(unix))]
                let _ = tokio::signal::ctrl_c().await;
                signal_stop.cancel();
            });
            match maka_eval::subject::maka::native::run(&payload, stop).await {
                Ok(result) => {
                    let value = serde_json::to_value(&result).unwrap();
                    match std::env::var("MAKA_EVAL_RESULT_TOKEN") {
                        Ok(token) => {
                            match maka_eval::subject::external_cli::encode_relay_result_frame(
                                &token, &value,
                            ) {
                                Ok(frame) => print!("{frame}"),
                                Err(error) => {
                                    eprintln!("native Eval Host result frame failed: {error}");
                                    return ExitCode::FAILURE;
                                }
                            }
                        }
                        Err(std::env::VarError::NotPresent) => println!("{value}"),
                        Err(error) => {
                            eprintln!("native Eval Host result token failed: {error}");
                            return ExitCode::FAILURE;
                        }
                    }
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("native Eval Host failed: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        Command::Run {
            spec,
            out_dir,
            cell_ids,
        } => run_cli_command(&spec, &out_dir, cell_ids).await,
        Command::Parity {
            spec,
            subject_id,
            out_file,
        } => run_parity_command(&spec, subject_id.as_deref(), out_file.as_deref()).await,
        Command::Report {
            spec,
            out_dir,
            format,
            milestone,
            parity_reports,
        } => {
            let raw = match fs::read_to_string(&spec) {
                Ok(s) => s,
                Err(err) => {
                    eprintln!("maka eval: {err}\n{USAGE}");
                    return ExitCode::from(2);
                }
            };
            let parsed: Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(err) => {
                    eprintln!("maka eval: {err}\n{USAGE}");
                    return ExitCode::from(2);
                }
            };
            let experiment_spec = match parse_experiment_spec(&parsed) {
                Ok(s) => s,
                Err(err) => {
                    eprintln!("maka eval: {err}\n{USAGE}");
                    return ExitCode::from(2);
                }
            };
            let milestone_gate = match milestone.as_deref() {
                None => None,
                Some(raw_ms) => match MilestoneGate::parse(raw_ms) {
                    Some(ms) => Some(ms),
                    None => {
                        eprintln!(
                            "maka eval: unsupported milestone '{raw_ms}' (expected m3 or m5)"
                        );
                        return ExitCode::from(2);
                    }
                },
            };
            let loaded_parity_reports = match load_parity_reports(&parity_reports) {
                Ok(r) => r,
                Err(err) => {
                    eprintln!("maka eval: {err}");
                    return ExitCode::from(2);
                }
            };
            let directory = match ExperimentDirectory::open(&out_dir, &experiment_spec) {
                Ok(d) => d,
                Err(err) => {
                    eprintln!("maka eval: {err}\n{USAGE}");
                    return ExitCode::from(2);
                }
            };

            let v1 = match export_v1_canonical(&experiment_spec, &directory.attempts) {
                Ok(v1) => v1,
                Err(err) => {
                    eprintln!("maka eval: {err}");
                    return ExitCode::from(1);
                }
            };
            let gate_report = milestone_gate.map(|ms| {
                evaluate_milestone_gate(ms, &experiment_spec, &v1, &loaded_parity_reports)
            });
            if let Some(gate) = &gate_report
                && !gate.passed
            {
                for violation in &gate.violations {
                    eprintln!("maka eval milestone gate violation: {violation}");
                }
            }

            match format.as_str() {
                "v1" => {
                    println!("{}", serde_json::to_string_pretty(&v1).unwrap());
                    if gate_report.as_ref().is_some_and(|g| !g.passed) {
                        ExitCode::from(1)
                    } else {
                        ExitCode::SUCCESS
                    }
                }
                "v2" => match export_v2_canonical(&experiment_spec, &directory.attempts) {
                    Ok(v2) => {
                        println!("{}", serde_json::to_string_pretty(&v2).unwrap());
                        if gate_report.as_ref().is_some_and(|g| !g.passed) {
                            ExitCode::from(1)
                        } else {
                            ExitCode::SUCCESS
                        }
                    }
                    Err(err) => {
                        eprintln!("maka eval: {err}");
                        ExitCode::from(1)
                    }
                },
                _ => {
                    let summary = build_cohort_summary(&experiment_spec, &v1);
                    if let Some(gate) = &gate_report {
                        println!(
                            "{}",
                            serde_json::to_string(&json!({
                                "summary": summary,
                                "milestoneGate": gate,
                            }))
                            .unwrap()
                        );
                        if summary.incomplete_cells == 0 && gate.passed {
                            ExitCode::SUCCESS
                        } else {
                            ExitCode::from(1)
                        }
                    } else {
                        println!("{}", serde_json::to_string(&summary).unwrap());
                        if summary.incomplete_cells == 0 {
                            ExitCode::SUCCESS
                        } else {
                            ExitCode::from(1)
                        }
                    }
                }
            }
        }
    }
}

async fn run_parity_command(
    spec: &std::path::Path,
    subject_id: Option<&str>,
    out_file: Option<&std::path::Path>,
) -> ExitCode {
    let raw = match fs::read_to_string(spec) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let experiment_spec = match parse_experiment_spec(&parsed) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let reports = match verify_experiment_parity(&experiment_spec, subject_id).await {
        Ok(r) => r,
        Err(err) => {
            eprintln!("maka eval parity failed: {err}");
            return ExitCode::from(1);
        }
    };
    let encoded = serde_json::to_string_pretty(&reports).unwrap();
    if let Some(target) = out_file {
        let mut bytes = encoded.as_bytes().to_vec();
        bytes.push(b'\n');
        if let Err(err) = write_atomic_bytes(target, &bytes) {
            eprintln!("maka eval parity write failed: {err}");
            return ExitCode::from(1);
        }
    }
    println!("{encoded}");
    if reports.iter().all(|r| r.passed) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn load_parity_reports(paths: &[PathBuf]) -> Result<Vec<ParityVerificationReport>, String> {
    let mut out = Vec::new();
    for path in paths {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("failed reading parity report {}: {e}", path.display()))?;
        let val: Value = serde_json::from_str(&raw)
            .map_err(|e| format!("invalid parity report JSON {}: {e}", path.display()))?;
        if val.is_array() {
            let batch: Vec<ParityVerificationReport> = serde_json::from_value(val)
                .map_err(|e| format!("invalid parity report array {}: {e}", path.display()))?;
            out.extend(batch);
        } else {
            let single: ParityVerificationReport = serde_json::from_value(val)
                .map_err(|e| format!("invalid parity report {}: {e}", path.display()))?;
            out.push(single);
        }
    }
    Ok(out)
}

async fn run_cli_command(spec: &PathBuf, out_dir: &PathBuf, cell_ids: Vec<String>) -> ExitCode {
    let raw = match fs::read_to_string(spec) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let experiment_spec = match parse_experiment_spec(&parsed) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let directory = match ExperimentDirectory::open(out_dir, &experiment_spec) {
        Ok(d) => d,
        Err(err) => {
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    let executor_cfg = match HarborExecutorConfig::decode(
        &experiment_spec.executor.kind,
        &experiment_spec.executor.config,
    ) {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let spec_dir = spec
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let environment = Arc::new(HarborTrialEnvironment::new(executor_cfg, spec_dir));

    let subjects: Vec<Arc<dyn SubjectAdapter>> = vec![
        Arc::new(RustHostSubject::new()),
        Arc::new(ExternalCliSubject::new()),
    ];

    let cancel = CancellationToken::new();
    let signal_exit_code = Arc::new(AtomicU8::new(0));
    {
        let cancel_clone = cancel.clone();
        let code_clone = signal_exit_code.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            {
                use tokio::signal::unix::{SignalKind, signal};
                let mut sigint = signal(SignalKind::interrupt()).ok();
                let mut sigterm = signal(SignalKind::terminate()).ok();
                tokio::select! {
                    _ = async {
                        if let Some(ref mut s) = sigint {
                            let _ = s.recv().await;
                        } else {
                            std::future::pending::<()>().await;
                        }
                    } => {
                        code_clone.store(130, Ordering::SeqCst);
                        cancel_clone.cancel();
                    }
                    _ = async {
                        if let Some(ref mut s) = sigterm {
                            let _ = s.recv().await;
                        } else {
                            std::future::pending::<()>().await;
                        }
                    } => {
                        code_clone.store(143, Ordering::SeqCst);
                        cancel_clone.cancel();
                    }
                }
            }
            #[cfg(not(unix))]
            {
                if tokio::signal::ctrl_c().await.is_ok() {
                    code_clone.store(130, Ordering::SeqCst);
                    cancel_clone.cancel();
                }
            }
        });
    }

    let mut input =
        RunExperimentInput::new(&experiment_spec, &directory.attempts, environment, subjects);
    if !cell_ids.is_empty() {
        input.cell_ids = Some(cell_ids.clone());
    }
    input.cancel = cancel;

    let results = match run_experiment(input).await {
        Ok(r) => r,
        Err(err) => {
            let sig = signal_exit_code.load(Ordering::SeqCst);
            if sig != 0 {
                return ExitCode::from(sig);
            }
            eprintln!("maka eval: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    let sig = signal_exit_code.load(Ordering::SeqCst);
    if sig != 0 {
        return ExitCode::from(sig);
    }

    let summary = build_cohort_summary(&experiment_spec, &results);
    println!("{}", serde_json::to_string(&summary).unwrap());

    let expected_cells = if cell_ids.is_empty() {
        expand_experiment(&experiment_spec).len()
    } else {
        cell_ids.len()
    };

    if results.len() == expected_cells {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
