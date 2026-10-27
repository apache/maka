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

//! Minimal embedding executable for the private desktop and cursor helpers.
fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_max_level(tracing_subscriber::filter::LevelFilter::DEBUG)
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .try_init()
        .expect("initialize desktop host diagnostics");
    if let Some(exit) = maka_computer_use::cursor::bootstrap() {
        return exit;
    }
    if let Some(exit) = maka_computer_use::desktop::bootstrap() {
        return exit;
    }
    eprintln!("This executable supplies Maka's private desktop helper entry points.");
    std::process::ExitCode::SUCCESS
}
