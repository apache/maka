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

use maka_plugin_core::shell_run::ShellObservation;
use maka_plugin_core::terminal::TerminalSize;
use maka_plugin_core::terminal::input::InputAction;
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Bytes accepted by the input transport, not a claim of application consumption.
/// Windows accepts into its owned overlapped pipe queue; this is not an I/O
/// completion fence. A later process exit can discard accepted but unread input.
#[derive(Clone, Debug)]
pub struct WriteReceipt {
    pub accepted_bytes: usize,
    pub resized: bool,
    pub resize_changed: bool,
    /// The worker's committed parser cut when transport acceptance settles.
    pub record: Arc<ShellObservation>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message} (accepted input prefix: {accepted_bytes:?}, resized: {resized:?})")]
pub struct ControlError {
    pub kind: ControlErrorKind,
    pub message: String,
    /// None means the worker disappeared before it could report an exact prefix.
    pub accepted_bytes: Option<usize>,
    /// None means native resize may have happened before the worker disappeared.
    pub resized: Option<bool>,
    pub resize_changed: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlErrorKind {
    Rejected,
    Closed,
    Unknown,
}

impl ControlError {
    pub(super) fn new(message: impl ToString, accepted_bytes: usize) -> Self {
        Self {
            kind: ControlErrorKind::Closed,
            message: message.to_string(),
            accepted_bytes: Some(accepted_bytes),
            resized: Some(false),
            resize_changed: Some(false),
        }
    }

    pub(super) fn unknown(message: &str) -> Self {
        Self {
            kind: ControlErrorKind::Unknown,
            message: message.into(),
            accepted_bytes: None,
            resized: None,
            resize_changed: None,
        }
    }

    pub(super) fn rejected(message: impl ToString) -> Self {
        Self {
            kind: ControlErrorKind::Rejected,
            ..Self::new(message, 0)
        }
    }

    pub(super) fn after_resize(mut self, resized: bool, changed: bool) -> Self {
        self.resized = Some(resized);
        self.resize_changed = Some(changed);
        self
    }
}

/// Owned complete native terminal payload; the caller supplies authorization before enqueue.
pub enum Input {
    Actions(Vec<InputAction>),
    Interactive(Vec<InputAction>),
    Raw(String),
}

pub(super) struct Control {
    pub input: Input,
    pub size: Option<TerminalSize>,
    pub cancellation: CancellationToken,
    pub reply: oneshot::Sender<Result<WriteReceipt, ControlError>>,
}
