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
use maka_eval::report::{build_cohort_summary, export_v1_canonical, export_v2_canonical};
use maka_eval::runner::{RunExperimentInput, run_experiment};
use maka_eval::store::ExperimentDirectory;
use maka_eval::subject::{ExternalCliSubject, RustHostSubject, SubjectAdapter};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use tokio_util::sync::CancellationToken;

pub const USAGE: &str = "usage: maka eval run <spec.json> --out <directory> [--cell <cell-id>]";

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
    /// Validate or inspect an experiment directory and export canonical projections.
    Report {
        /// Path to the experiment specification JSON file.
        spec: PathBuf,
        /// Experiment output directory.
        #[arg(long = "out")]
        out_dir: PathBuf,
        /// Output format (`summary`, `v1`, or `v2`).
        #[arg(long, default_value = "summary")]
        format: String,
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
        Command::Run {
            spec,
            out_dir,
            cell_ids,
        } => run_cli_command(&spec, &out_dir, cell_ids).await,
        Command::Report {
            spec,
            out_dir,
            format,
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
            let directory = match ExperimentDirectory::open(&out_dir, &experiment_spec) {
                Ok(d) => d,
                Err(err) => {
                    eprintln!("maka eval: {err}\n{USAGE}");
                    return ExitCode::from(2);
                }
            };

            match format.as_str() {
                "v1" => match export_v1_canonical(&experiment_spec, &directory.attempts) {
                    Ok(v1) => {
                        println!("{}", serde_json::to_string_pretty(&v1).unwrap());
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("maka eval: {err}");
                        ExitCode::from(1)
                    }
                },
                "v2" => match export_v2_canonical(&experiment_spec, &directory.attempts) {
                    Ok(v2) => {
                        println!("{}", serde_json::to_string_pretty(&v2).unwrap());
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("maka eval: {err}");
                        ExitCode::from(1)
                    }
                },
                _ => match export_v1_canonical(&experiment_spec, &directory.attempts) {
                    Ok(v1) => {
                        let summary = build_cohort_summary(&experiment_spec, &v1);
                        println!("{}", serde_json::to_string(&summary).unwrap());
                        if summary.incomplete_cells == 0 {
                            ExitCode::SUCCESS
                        } else {
                            ExitCode::from(1)
                        }
                    }
                    Err(err) => {
                        eprintln!("maka eval: {err}");
                        ExitCode::from(1)
                    }
                },
            }
        }
    }
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
