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

//! A minimal stderr logger for the `log` facade.
//!
//! `MAKA_LOG` sets the level (`error`, `warn`, `info`, `debug`, `trace`;
//! default `info`). Only this workspace's crates log at the chosen level;
//! dependencies log warnings and errors, which keeps GPUI's own chatter out.

use std::io::Write as _;

use log::{LevelFilter, Log, Metadata, Record};

const OWN_CRATES: [&str; 9] = [
    "app",
    "maka_gpui",
    "host_client",
    "workspace",
    "session",
    "settings",
    "shared",
    "conversation",
    "transcript_model",
];

struct StderrLogger {
    level: LevelFilter,
}

impl Log for StderrLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let crate_name = metadata.target().split("::").next().unwrap_or_default();
        let limit = if OWN_CRATES.contains(&crate_name) { self.level } else { LevelFilter::Warn };
        metadata.level() <= limit
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            let _ = writeln!(
                std::io::stderr().lock(),
                "[{} {}] {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

pub(crate) fn init() {
    let level = std::env::var("MAKA_LOG")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(LevelFilter::Info);
    // Leaked once: the logger lives for the whole process.
    let logger: &'static StderrLogger = Box::leak(Box::new(StderrLogger { level }));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(level.max(LevelFilter::Warn));
    }
}
