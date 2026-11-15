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

use std::path::PathBuf;

use clap::{Parser, Subcommand};

use maka_eval::guest::{self, SandboxMode};
use maka_eval::harbor::{HarborRunOptions, run_trial, validate_trial_evidence};

#[derive(Parser)]
#[command(name = "maka-eval", about = "Minimal Maka Host evaluation runner")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run a Harbor task with native Maka Host inside Docker.
    Run(Box<RunArgs>),
    /// Container-side entry executed inside Harbor Docker environments.
    #[command(hide = true)]
    GuestRun {
        #[arg(long)]
        request_file: PathBuf,
        #[arg(long)]
        result_file: PathBuf,
    },
}

#[derive(clap::Args)]
struct RunArgs {
    #[arg(long)]
    task: PathBuf,
    #[arg(long)]
    bundle_dir: PathBuf,
    #[arg(long)]
    out: PathBuf,
    #[arg(long)]
    base_url: Option<String>,
    #[arg(long)]
    model: String,
    #[arg(long, default_value = "openai-compatible")]
    provider: String,
    #[arg(long, default_value = "eval-target")]
    connection_slug: String,
    #[arg(long, default_value = "OLLAMA_API_KEY")]
    api_key_env: String,
    #[arg(long, value_enum, default_value_t = SandboxMode::DangerFullAccess)]
    sandbox_mode: SandboxMode,
    #[arg(long, default_value_t = 64)]
    max_steps: u32,
    #[arg(long, default_value_t = 600_000)]
    timeout_ms: u64,
    #[arg(long)]
    force_build: bool,
    #[arg(long, default_value = "harbor")]
    harbor_bin: String,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Run(args) => {
            run_command(HarborRunOptions {
                task_path: args.task,
                bundle_dir: args.bundle_dir,
                out_dir: args.out,
                harbor_bin: args.harbor_bin,
                force_build: args.force_build,
                base_url: args.base_url,
                api_key_env: args.api_key_env,
                provider: args.provider,
                connection_slug: args.connection_slug,
                model_id: args.model,
                sandbox_mode: args.sandbox_mode,
                max_steps: args.max_steps,
                timeout_ms: args.timeout_ms,
            })
            .await
        }
        Command::GuestRun {
            request_file,
            result_file,
        } => guest::run_from_files(&request_file, &result_file).await,
    };

    if let Err(err) = result {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

async fn run_command(opts: HarborRunOptions) -> Result<(), String> {
    let outcome = run_trial(&opts).await?;
    let summary_path = opts.out_dir.join("run-summary.json");
    let encoded = serde_json::to_string_pretty(&outcome).map_err(|e| e.to_string())?;
    std::fs::write(&summary_path, format!("{encoded}\n"))
        .map_err(|e| format!("failed to write {}: {e}", summary_path.display()))?;
    println!("{encoded}");

    validate_trial_evidence(&outcome)
}
