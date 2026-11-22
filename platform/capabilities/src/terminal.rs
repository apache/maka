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

//! Activation-owned PTYs with call-bound control and replayable output.

use crate::call::Scope;
use crate::process::Command;
pub use crate::process::Error;
use futures_util::future::BoxFuture;
pub use maka_plugin_core::shell_run::ShellOutcome as Outcome;
pub use maka_plugin_core::terminal::TerminalSize as Size;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spawn {
    pub command: Command,
    pub size: Size,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    #[serde(default)]
    pub text: String,
    pub size: Option<Size>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Id(pub String);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub accepted_bytes: usize,
    pub resized: bool,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Output {
    Data {
        sequence: u64,
        text: String,
    },
    Reset {
        sequence: u64,
        text: String,
        size: Size,
    },
    Closed,
}
pub struct Handle {
    pub id: Id,
    pub io: Arc<dyn Terminal>,
}
pub trait Terminals: Send + Sync {
    fn spawn(&self, call: Scope, input: Spawn) -> BoxFuture<'_, Result<Handle, Error>>;
    /// Rebind an activation-local lookup key; each operation rechecks permission.
    fn open(&self, call: Scope, id: Id) -> Result<Handle, Error>;
    /// Owner cleanup does not require a still-live calling scope.
    fn close(&self, id: Id) -> BoxFuture<'_, Result<(), Error>>;
}
/// Dropping this view does not end an instance-owned terminal. The activation
/// owns the process; this view only fixes the authority used to interact with it.
pub trait Terminal: Send + Sync {
    fn control(&self, input: Control) -> BoxFuture<'_, Result<Written, Error>>;
    fn next(&self) -> BoxFuture<'_, Result<Output, Error>>;
    fn wait(&self) -> BoxFuture<'_, Result<Outcome, Error>>;
    fn close(&self) -> BoxFuture<'_, Result<(), Error>>;
}
