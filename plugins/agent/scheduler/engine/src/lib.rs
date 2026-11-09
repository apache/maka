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

//! Scheduled-task business policy, separate from plugin lifecycle and Host admission.
pub mod authorization;
pub mod command;
pub mod controller;
mod cron;
pub mod delivery;
pub mod owner;
pub mod plan;
pub mod repository;
pub mod schedule;
pub mod task;
pub mod view;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Authority(#[from] maka_capabilities::authorization::CommandError),
    #[error(transparent)]
    Resource(#[from] maka_agent_facts::tools::ToolError),
    #[error("scheduled task does not exist")]
    NotFound,
    #[error("scheduled task changed since it was read")]
    RevisionConflict,
    #[error("scheduled-task creation identity was used for different input")]
    CreationConflict,
    #[error("Approve background access in the Scheduler UI before creating this task")]
    AuthorizationRequired,
    #[error("scheduler is closed")]
    Closed,
    #[error("scheduler command queue is full")]
    Busy,
    #[error("scheduler unavailable: {0}")]
    Unavailable(String),
    #[error("scheduled-task mutation outcome is unknown")]
    OutcomeUnknown,
    #[error("invalid scheduled task: {0}")]
    Invalid(String),
    #[error(transparent)]
    Time(#[from] jiff::Error),
    #[error(transparent)]
    Storage(#[from] maka_plugin_core::storage::StoreError),
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
