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

//! A provider's explicit return is distinct from losing its execution worker.
use crate::storage::StateChange;
use serde_json::Value;

pub type HandlerResult = std::result::Result<HandlerValue, HandlerError>;

#[derive(Debug)]
pub enum HandlerValue {
    Json(Value),
    Commit { value: Value, state: StateChange },
    Computed { state: StateChange },
}
impl From<Value> for HandlerValue {
    fn from(value: Value) -> Self {
        Self::Json(value)
    }
}
impl HandlerValue {
    pub fn value(&self) -> Option<&Value> {
        match self {
            Self::Json(value) | Self::Commit { value, .. } => Some(value),
            Self::Computed { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandlerError {
    Returned { diagnostic: String },
    Unknown { diagnostic: String },
}
impl From<String> for HandlerError {
    fn from(diagnostic: String) -> Self {
        Self::Returned { diagnostic }
    }
}
impl From<&str> for HandlerError {
    fn from(diagnostic: &str) -> Self {
        Self::from(diagnostic.to_owned())
    }
}
impl std::fmt::Display for HandlerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Returned { diagnostic } | Self::Unknown { diagnostic } => {
                formatter.write_str(diagnostic)
            }
        }
    }
}
impl std::error::Error for HandlerError {}

pub(crate) fn state_rejected(error: &maka_event_log::StoreError) -> bool {
    match error {
        maka_event_log::StoreError::Shared(error) => state_rejected(error),
        maka_event_log::StoreError::StatementRejected { .. }
        | maka_event_log::StoreError::SessionRevisionConflict { .. }
        | maka_event_log::StoreError::RevisionConflict { .. }
        | maka_event_log::StoreError::SessionNotFound
        | maka_event_log::StoreError::InvalidTransition(_) => true,
        _ => false,
    }
}

pub(crate) fn state_conflict(error: &maka_event_log::StoreError) -> bool {
    match error {
        maka_event_log::StoreError::Shared(error) => state_conflict(error),
        maka_event_log::StoreError::EventConflict => true,
        _ => false,
    }
}
