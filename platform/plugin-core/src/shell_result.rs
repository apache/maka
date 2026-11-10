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

//! Bounded shell result contracts shared by model and client projections.
use crate::{shell_run::PipeStream, terminal::TerminalCursor};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

pub const RESOURCE_REF_PREFIX: &str = "maka://runtime/background-tasks/";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShellMode {
    Pipes,
    Pty,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShellStatus {
    Starting,
    Running,
    Completed,
    Failed,
    TimedOut,
    Cancelled,
    Orphaned,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellSnapshot {
    pub kind: SnapshotKind,
    #[serde(rename = "ref")]
    pub resource_ref: String,
    pub mode: ShellMode,
    pub status: ShellStatus,
    pub cwd: String,
    pub cmd: String,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "u64")]
    pub completed_at: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "u64")]
    pub timeout_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "i64")]
    pub exit_code: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "String")]
    pub failure_message: Option<String>,
    pub revision: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(with = "ShellOutput")]
    pub output: Option<ShellOutput>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum SnapshotKind {
    #[serde(rename = "shell_run")]
    ShellRun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ShellOutput {
    Pipes {
        stdout: String,
        stderr: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "present"
        )]
        #[schemars(with = "PipeStream")]
        latest_stream: Option<PipeStream>,
        stdout_truncated: bool,
        stderr_truncated: bool,
        redacted: bool,
    },
    Pty {
        screen: String,
        scrollback: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "present"
        )]
        #[schemars(with = "String")]
        last_alternate_screen: Option<String>,
        cols: u16,
        rows: u16,
        cursor: TerminalCursor,
        alternate_screen: bool,
        truncated: bool,
        redacted: bool,
    },
}

impl ShellSnapshot {
    pub fn validate(&self) -> Result<(), &'static str> {
        use ShellStatus::*;
        let failure = self.failure_message.as_deref();
        let completed = self.completed_at.is_some();
        let valid = match self.status {
            Starting | Running => !completed && self.exit_code.is_none() && failure.is_none(),
            Completed => completed && self.exit_code == Some(0) && failure.is_none(),
            Failed => {
                completed
                    && (self.exit_code.is_some_and(|n| n != 0)
                        || self.exit_code.is_none() && failure.is_some_and(|s| !s.is_empty()))
            }
            TimedOut => completed && self.exit_code == Some(124),
            Cancelled => completed && self.exit_code == Some(130),
            Orphaned => {
                completed && self.exit_code.is_none() && failure.is_some_and(|s| !s.is_empty())
            }
        };
        if !valid || self.revision == 0 {
            return Err("invalid projected shell lifecycle");
        }
        if let Some(output) = &self.output {
            match output {
                ShellOutput::Pipes { .. } if self.mode == ShellMode::Pipes => {}
                ShellOutput::Pty {
                    cols, rows, cursor, ..
                } if self.mode == ShellMode::Pty
                    && *cols > 0
                    && *rows > 0
                    && cursor.x <= *cols
                    && cursor.y < *rows => {}
                _ => return Err("invalid projected shell output"),
            }
        }
        Ok(())
    }
}

fn present<'de, D, T>(de: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(de).map(Some)
}
