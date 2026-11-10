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

//! Agent receipt metadata retains the original Root result by content address.
use crate::{artifact::content_digest, durable::ContentRef};
use maka_plugin_core::operation::{OperationOutcome, OperationReply, OperationResult, Receipt};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type RecordedOperationReply = OperationReply<RecordedOperationResult>;
pub type RecordedReceipt = Receipt<RecordedOperationResult>;
pub type RecordedOutcome = OperationOutcome<RecordedOperationResult>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecordedOperationResult {
    Success { value: Value },
    Failure { diagnostic: String },
    Referenced { content: ContentRef, is_error: bool },
}

impl RecordedOperationResult {
    pub fn is_error(&self) -> bool {
        match self {
            Self::Success { .. } => false,
            Self::Failure { .. } => true,
            Self::Referenced { is_error, .. } => *is_error,
        }
    }

    pub fn same_result(&self, other: &Self) -> Result<bool, serde_json::Error> {
        fn matches_content(
            result: &RecordedOperationResult,
            content: &ContentRef,
        ) -> Result<bool, serde_json::Error> {
            let bytes = serde_json::to_vec(result)?;
            Ok(bytes.len() as u64 == content.bytes && content_digest(&bytes) == content.digest)
        }
        if self.is_error() != other.is_error() {
            return Ok(false);
        }
        match (self, other) {
            (Self::Referenced { content: a, .. }, Self::Referenced { content: b, .. }) => {
                Ok(a == b)
            }
            (Self::Referenced { content, .. }, other)
            | (other, Self::Referenced { content, .. }) => matches_content(other, content),
            (a, b) => Ok(a == b),
        }
    }
}

pub fn same_outcome(
    left: &RecordedOutcome,
    right: &RecordedOutcome,
) -> Result<bool, serde_json::Error> {
    match (left, right) {
        (
            OperationOutcome::Returned { result: left },
            OperationOutcome::Returned { result: right },
        ) => left.same_result(right),
        _ => Ok(left == right),
    }
}

impl From<OperationResult> for RecordedOperationResult {
    fn from(value: OperationResult) -> Self {
        match value {
            OperationResult::Success { value } => Self::Success { value },
            OperationResult::Failure { diagnostic } => Self::Failure { diagnostic },
        }
    }
}

pub fn inline_reply(reply: OperationReply) -> RecordedOperationReply {
    reply
        .try_map_result(|value| Ok::<_, std::convert::Infallible>(value.into()))
        .unwrap_or_else(|never| match never {})
}

pub fn restore_result(
    reply: &mut RecordedOperationReply,
    stored: OperationResult,
) -> Result<(), &'static str> {
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { result },
        ..
    } = &mut reply.receipt
    else {
        return Err("operation receipt has no returned value");
    };
    let RecordedOperationResult::Referenced { is_error, .. } = result else {
        return Err("operation receipt does not reference a stored value");
    };
    let stored = RecordedOperationResult::from(stored);
    if stored.is_error() != *is_error {
        return Err("original operation result differs from its receipt");
    }
    *result = stored;
    Ok(())
}

pub fn result_reference(reply: &RecordedOperationReply) -> Option<&ContentRef> {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: RecordedOperationResult::Referenced { content, .. },
                },
            ..
        } => Some(content),
        _ => None,
    }
}

pub fn resolve_reply(
    reply: RecordedOperationReply,
    stored: Option<OperationResult>,
) -> Result<OperationReply, &'static str> {
    reply.try_map_result(|result| match result {
        RecordedOperationResult::Success { value } => Ok(OperationResult::Success { value }),
        RecordedOperationResult::Failure { diagnostic } => {
            Ok(OperationResult::Failure { diagnostic })
        }
        RecordedOperationResult::Referenced { is_error, .. } => {
            let stored = stored.ok_or("original operation result is absent")?;
            if matches!(stored, OperationResult::Failure { .. }) != is_error {
                return Err("original operation result differs from its receipt");
            }
            Ok(stored)
        }
    })
}
