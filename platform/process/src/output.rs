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

use crate::tail::Tail;
use serde_json::{Value, json};
use std::{path::PathBuf, process::ExitStatus};

#[derive(Debug)]
pub enum Termination {
    Timeout,
    Cancelled,
}
#[derive(Debug)]
pub enum Outcome {
    Exited(ExitStatus),
    Interrupted {
        reason: Termination,
        /// Whether the first native termination signal was accepted.
        signal_applied: bool,
    },
}

/// Final native exit evidence and bounded output, after process and pipe cleanup.
#[derive(Debug)]
pub struct Captured {
    pub outcome: Outcome,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl Captured {
    /// Present the final native evidence using the shell tool's common format.
    pub fn into_output(self, cwd: PathBuf, command: String) -> Value {
        #[cfg(windows)]
        let cwd = dunce::simplified(&cwd);
        let (status, code, failure) = match self.outcome {
            Outcome::Exited(exit) if exit.success() => ("completed", Some(0), None),
            Outcome::Exited(exit) => ("failed", exit.code(), Some(failure(exit))),
            Outcome::Interrupted {
                reason: Termination::Timeout,
                ..
            } => ("timed_out", Some(124), None),
            Outcome::Interrupted {
                reason: Termination::Cancelled,
                ..
            } => ("cancelled", Some(130), None),
        };
        let mut result = json!({"kind":"terminal","cwd":cwd,"cmd":command,"status":status,
        "output":{"mode":"pipes","stdout":self.stdout,"stderr":self.stderr,
        "stdoutTruncated":self.stdout_truncated,"stderrTruncated":self.stderr_truncated,"redacted":false}});
        if let Some(code) = code {
            result["exitCode"] = json!(code);
        }
        if let Some(failure) = failure {
            result["failureMessage"] = json!(failure);
        }
        result
    }

    pub(crate) fn new(outcome: Outcome, mut stdout: Tail, mut stderr: Tail) -> Self {
        Self {
            outcome,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
        }
    }
}

fn failure(exit: ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = exit.signal() {
            return format!("Command terminated by signal {signal}");
        }
    }
    format!("Command exited with code {}", exit.code().unwrap_or(-1))
}
