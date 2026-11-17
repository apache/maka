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

mod guest;
mod harbor;

use crate::harbor::{HarborRunOptions, run_trial};

#[derive(Parser)]
#[command(name = "maka-eval", about = "Minimal Maka Host evaluation runner")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run a Harbor task with native Maka Host inside Docker.
    Run(Box<HarborRunOptions>),
    /// Container-side entry executed inside Harbor Docker environments.
    #[command(hide = true)]
    GuestRun {
        #[arg(long)]
        request_file: PathBuf,
        #[arg(long)]
        result_file: PathBuf,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Run(opts) => run_command(*opts).await,
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
    let (summary, validation) = outcome.settle();
    let summary_path = opts.out_dir.join("run-summary.json");
    let encoded = serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?;
    std::fs::write(&summary_path, format!("{encoded}\n"))
        .map_err(|e| format!("failed to write {}: {e}", summary_path.display()))?;
    println!("{encoded}");

    validation
}
