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

use crate::call::Scope;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifetime {
    #[default]
    Invocation,
    Instance,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub lifetime: Lifetime,
}
impl Command {
    pub fn validate(&self) -> Result<(), Error> {
        if self.executable.is_empty()
            || self.executable.contains('\0')
            || self.args.iter().any(|arg| arg.contains('\0'))
            || self.env.iter().any(|(key, value)| {
                key.is_empty() || key.contains(['=', '\0']) || value.contains('\0')
            })
        {
            return Err(Error::Invalid(
                "invalid process command or launch limit exceeded".into(),
            ));
        }
        Ok(())
    }
}

/// A lookup key in this activation, never an execution permission or durable PID.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Id(pub String);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exit {
    pub code: Option<i32>,
    pub success: bool,
    pub stopped: bool,
    pub error: Option<String>,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    Stdout,
    Stderr,
}
#[derive(Serialize)]
pub struct Chunk {
    pub stream: Stream,
    pub bytes: Vec<u8>,
}

pub struct Handle {
    pub id: Id,
    pub io: Arc<dyn Process>,
}
pub trait Processes: Send + Sync {
    fn spawn(&self, call: Scope, command: Command) -> BoxFuture<'_, Result<Handle, Error>>;
    /// Bind an instance-owned process to a new authorized call. Old bindings
    /// remain expired; the ID alone cannot keep their permissions alive.
    fn open(&self, call: Scope, id: Id) -> Result<Handle, Error>;
    /// Cleanup by owner remains allowed after the call binding expires.
    fn close(&self, id: Id) -> BoxFuture<'_, Result<(), Error>>;
}
/// The native owner retains the process through physical settlement. Dropping
/// this view does not terminate it; close explicitly or retire its owner.
pub trait Process: Send + Sync {
    fn write(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<(), Error>>;
    fn end_input(&self) -> BoxFuture<'_, Result<(), Error>>;
    fn next(&self) -> BoxFuture<'_, Result<Option<Chunk>, Error>>;
    fn wait(&self) -> BoxFuture<'_, Result<Exit, Error>>;
    fn close(&self) -> BoxFuture<'_, Result<(), Error>>;
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("process authority is retired or denied")]
    Denied,
    #[error("invalid process operation: {0}")]
    Invalid(String),
    #[error("process operation failed: {0}")]
    Failed(String),
    #[error("process cleanup is unconfirmed: {0}")]
    CleanupUnconfirmed(String),
}

impl From<crate::authorization::CommandError> for Error {
    fn from(error: crate::authorization::CommandError) -> Self {
        use crate::authorization::CommandError;
        match error {
            CommandError::Denied | CommandError::Revoked => Self::Denied,
            CommandError::Invalid(reason) => Self::Invalid(reason),
            CommandError::OutcomeUnknown(reason) => Self::CleanupUnconfirmed(reason),
            error => Self::Failed(error.to_string()),
        }
    }
}
