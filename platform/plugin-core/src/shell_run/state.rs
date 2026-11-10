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

use serde::{Deserialize, Serialize};
use std::num::NonZeroI64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ShellState {
    Starting,
    Running,
    Terminal {
        completed_at: u64,
        outcome: ShellOutcome,
        observed_at: Option<u64>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ShellOutcome {
    Completed,
    Exited {
        code: NonZeroI64,
        message: Option<String>,
    },
    Failed {
        message: String,
    },
    TimedOut {
        message: Option<String>,
    },
    Cancelled {
        message: Option<String>,
    },
    Orphaned {
        message: String,
    },
}

impl ShellState {
    pub fn active(&self) -> bool {
        !matches!(self, Self::Terminal { .. })
    }

    pub fn status(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Terminal { outcome, .. } => outcome.status(),
        }
    }

    pub(super) fn accepts(&self, next: &Self) -> bool {
        if self == next {
            return true;
        }
        match (self, next) {
            (Self::Starting, Self::Running) => true,
            (Self::Starting, Self::Terminal { outcome, .. }) => matches!(
                outcome,
                ShellOutcome::Exited { .. }
                    | ShellOutcome::Failed { .. }
                    | ShellOutcome::Orphaned { .. }
            ),
            (Self::Running, Self::Terminal { .. }) => true,
            _ => false,
        }
    }

    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if let Self::Terminal {
            completed_at,
            outcome,
            observed_at,
        } = self
        {
            super::time(*completed_at)?;
            if let Some(at) = observed_at {
                super::time(*at)?;
            }
            match outcome {
                ShellOutcome::Failed { message } | ShellOutcome::Orphaned { message }
                    if message.is_empty() =>
                {
                    return Err("shell failure requires a message");
                }
                ShellOutcome::Exited { code, .. }
                    if code.get().unsigned_abs() > super::MAX_SAFE =>
                {
                    return Err("invalid shell exit code");
                }
                _ => {}
            }
        }
        Ok(())
    }
}

impl ShellOutcome {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Exited { .. } | Self::Failed { .. } => "failed",
            Self::TimedOut { .. } => "timed_out",
            Self::Cancelled { .. } => "cancelled",
            Self::Orphaned { .. } => "orphaned",
        }
    }

    pub fn exit_code(&self) -> Option<i64> {
        match self {
            Self::Completed => Some(0),
            Self::Exited { code, .. } => Some(code.get()),
            Self::TimedOut { .. } => Some(124),
            Self::Cancelled { .. } => Some(130),
            Self::Failed { .. } | Self::Orphaned { .. } => None,
        }
    }
}
