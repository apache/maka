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

//! WorkHub business state and decisions. Host owns execution and authorization.
mod access;
mod assignment;
mod candidates;
mod control;
mod coordinator;
mod decision;
mod feedback;
mod model_repair;
mod observation;
mod plugin;
mod queue;
mod recovery;
mod repository;
mod results;
mod selection;

use access::Access;
use coordinator::Coordinator;
use repository::Repository;

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    Execution(#[from] maka_plugins::execution::CommandError),
    #[error(transparent)]
    Storage(#[from] maka_plugins::storage::StoreError),
    #[error("WorkHub decision changed")]
    Conflict,
    #[error("WorkHub state changed concurrently; retry the frozen decision")]
    Contended,
    #[error("invalid WorkHub data: {0}")]
    Invalid(String),
}
fn invalid(error: impl ToString) -> Error {
    Error::Invalid(error.to_string())
}

pub use plugin::{Builtin, ID};
