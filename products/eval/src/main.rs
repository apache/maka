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

mod batch;
mod guest;
mod harbor;

use crate::batch::{BatchOptions, run_batch};
use crate::harbor::{HarborRunOptions, run_single};

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
    /// Run a repeatable multi-task/multi-subject batch experiment with resume support.
    Batch(BatchOptions),
    /// Container-side entry executed inside Harbor Docker environments.
    #[command(hide = true)]
    GuestRun {
        #[arg(long)]
        request_file: PathBuf,
        #[arg(long)]
        result_file: PathBuf,
    },
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Run(opts) => run_single(*opts),
        Command::Batch(opts) => run_batch(&opts),
        Command::GuestRun {
            request_file,
            result_file,
        } => tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("failed to build tokio runtime: {e}"))
            .and_then(|rt| rt.block_on(guest::run_from_files(&request_file, &result_file))),
    };

    if let Err(err) = result {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}
