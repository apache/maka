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

//! Native UI cases run on the process main thread, including under nextest.

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[path = "../src/terminal/pixels/tests.rs"]
mod cases;
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[path = "../src/terminal/pixels/geometry.rs"]
mod geometry;
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[path = "../src/terminal/pixels/mapping.rs"]
mod mapping;
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[path = "../src/terminal/pixels/probe.rs"]
mod probe;

fn main() -> std::process::ExitCode {
    let mut list = false;
    let mut exact = false;
    let mut ignored_only = false;
    let mut filter = None;
    let mut skips = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--list" => list = true,
            "--exact" => exact = true,
            "--ignored" => ignored_only = true,
            "--include-ignored" | "--nocapture" | "--show-output" | "--quiet" | "-q" => {}
            "--format" | "--color" | "--test-threads" => {
                let _ = args.next();
            }
            "--skip" => {
                if let Some(skip) = args.next() {
                    skips.push(skip);
                }
            }
            arg if arg.starts_with("--format=")
                || arg.starts_with("--color=")
                || arg.starts_with("--test-threads=") => {}
            arg if !arg.starts_with('-') => filter = Some(arg.to_owned()),
            arg => {
                eprintln!("unsupported native test argument: {arg}");
                return std::process::ExitCode::FAILURE;
            }
        }
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let cases = cases::cases().to_vec();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let cases: Vec<(&str, fn())> = Vec::new();
    let matches = |name: &str, filter: &str| {
        if exact {
            name == filter
        } else {
            name.contains(filter)
        }
    };
    let selected: Vec<_> = cases
        .into_iter()
        .filter(|(name, _)| {
            !ignored_only
                && filter.as_deref().is_none_or(|filter| matches(name, filter))
                && !skips.iter().any(|skip| matches(name, skip))
        })
        .collect();
    if list {
        for (name, _) in selected {
            println!("{name}: test");
        }
        return std::process::ExitCode::SUCCESS;
    }
    let mut failed = 0;
    let count = selected.len();
    for (name, run) in selected {
        print!("test {name} ... ");
        if std::panic::catch_unwind(run).is_ok() {
            println!("ok");
        } else {
            failed += 1;
            println!("FAILED");
        }
    }
    println!(
        "test result: {}. {} passed; {} failed",
        if failed == 0 { "ok" } else { "FAILED" },
        count - failed,
        failed
    );
    if failed == 0 {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}
