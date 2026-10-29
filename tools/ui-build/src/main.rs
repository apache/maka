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

use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Compile a Maka plugin's NSH UI module and assets")]
struct Args {
    #[arg(long, value_name = "FILE")]
    entry: PathBuf,
    #[arg(long, value_name = "DIRECTORY")]
    output: PathBuf,
}

fn main() -> std::process::ExitCode {
    let args = Args::parse();
    match maka_ui_build::compiler_identity()
        .and_then(|identity| maka_ui_build::compile_cached(&args.entry, &args.output, &identity))
    {
        Ok(manifest) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&manifest).expect("compiled UI manifest")
            );
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("maka-ui-build: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
