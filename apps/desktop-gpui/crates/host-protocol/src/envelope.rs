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

//! Operation request and response envelopes.
//!
//! Source: `RequestFrame`, `ResponseFrame`, `decodeRequestFrame`,
//! `decodeResponseFrame`, `decodeOperationOutcome` and `decodeOperationError`
//! in `packages/runtime-host/src/protocol/operations.ts`; the error shape is
//! `HostOperationError` in `protocol/operation-spec.ts`.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

/// A client request: `{ requestId, operation, input }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RequestFrame {
    /// Unique among this connection's in-flight requests; the Host fails the
    /// connection on reuse. The TS client uses a random UUID.
    pub request_id: String,
    pub operation: String,
    pub input: Value,
}

impl RequestFrame {
    /// A request for `operation` with an already encoded `input`.
    pub fn new(request_id: impl Into<String>, operation: impl Into<String>, input: Value) -> Self {
        Self { request_id: request_id.into(), operation: operation.into(), input }
    }
}

/// A Host response:
/// `{ requestId, operation, ok: true, result }` or
/// `{ requestId, operation, ok: false, error }`.
///
/// The result stays untyped here; the caller that issued the request knows
/// its operation and decodes it (see [`crate::Operation`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "WireResponse", into = "WireResponse")]
#[non_exhaustive]
pub struct ResponseFrame {
    pub request_id: String,
    pub operation: String,
    pub outcome: Outcome,
}

impl ResponseFrame {
    /// A successful response.
    pub fn ok(request_id: impl Into<String>, operation: impl Into<String>, result: Value) -> Self {
        Self {
            request_id: request_id.into(),
            operation: operation.into(),
            outcome: Outcome::Ok(result),
        }
    }

    /// A failed response.
    pub fn err(
        request_id: impl Into<String>,
        operation: impl Into<String>,
        error: HostOperationError,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            operation: operation.into(),
            outcome: Outcome::Err(error),
        }
    }
}

/// The body of a [`ResponseFrame`].
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// `ok: true`; the operation's result, not yet decoded.
    Ok(Value),
    /// `ok: false`.
    Err(HostOperationError),
}

/// `HostOperationError`: a declared operation failure.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[error("{code}: {message}")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostOperationError {
    pub code: HostOperationErrorCode,
    pub message: String,
}

impl HostOperationError {
    /// An error with `code` and a human-readable `message`.
    pub fn new(code: HostOperationErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

wire_enum! {
    /// `HostOperationErrorCode` (`protocol/operation-spec.ts`). Each
    /// operation declares a subset; `unauthorized` is allowed for every one.
    pub enum HostOperationErrorCode {
        HostNotReady = "host_not_ready",
        HostDraining = "host_draining",
        Unauthorized = "unauthorized",
        OperationUnavailable = "operation_unavailable",
        NotFound = "not_found",
        SessionArchived = "session_archived",
        SessionBusy = "session_busy",
        /// `client.capability.replace` for one Session: another client's
        /// provider holds a conflicting Session configuration.
        SessionBindingConflict = "session_binding_conflict",
        TranscriptPreparing = "transcript_preparing",
        CandidateSetStale = "candidate_set_stale",
        OperationConflict = "operation_conflict",
        CapabilityUnavailable = "capability_unavailable",
        SlugTaken = "slug_taken",
        InvalidRequest = "invalid_request",
        ModelRequired = "model_required",
        ModelUnavailable = "model_unavailable",
        SourceUnreadable = "source_unreadable",
        SourceLimitExceeded = "source_limit_exceeded",
        ProjectionIncomplete = "projection_incomplete",
        StaleCursor = "stale_cursor",
        PersistenceFailed = "persistence_failed",
        CommitOutcomeUnknown = "commit_outcome_unknown",
        AlreadyResolved = "already_resolved",
        OutcomeUnknown = "outcome_unknown",
        InternalFailure = "internal_failure",
    }
}

/// The literal wire layout of a response, used only for (de)serialization.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
struct WireResponse {
    request_id: String,
    operation: String,
    ok: bool,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<HostOperationError>,
}

/// Distinguishes a present `null` result from an absent one.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// A response whose `ok` flag disagrees with its body.
#[derive(Debug, Error)]
#[error("{0}")]
struct InvalidResponse(&'static str);

impl TryFrom<WireResponse> for ResponseFrame {
    type Error = InvalidResponse;

    fn try_from(wire: WireResponse) -> Result<Self, Self::Error> {
        let outcome = match (wire.ok, wire.result, wire.error) {
            (true, Some(result), None) => Outcome::Ok(result),
            (false, None, Some(error)) => Outcome::Err(error),
            (true, _, _) => {
                return Err(InvalidResponse("a successful response needs a result and no error"));
            }
            (false, _, _) => {
                return Err(InvalidResponse("a failed response needs an error and no result"));
            }
        };
        Ok(Self { request_id: wire.request_id, operation: wire.operation, outcome })
    }
}

impl From<ResponseFrame> for WireResponse {
    fn from(frame: ResponseFrame) -> Self {
        let (ok, result, error) = match frame.outcome {
            Outcome::Ok(result) => (true, Some(result), None),
            Outcome::Err(error) => (false, None, Some(error)),
        };
        Self { request_id: frame.request_id, operation: frame.operation, ok, result, error }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_encodes_in_wire_order() {
        let frame = RequestFrame::new("r1", "session.catalog.query", json!({"kind": "list_start"}));
        assert_eq!(
            serde_json::to_string(&frame).expect("encode"),
            r#"{"requestId":"r1","operation":"session.catalog.query","input":{"kind":"list_start"}}"#
        );
    }

    #[test]
    fn ok_response_decodes() {
        let frame: ResponseFrame = serde_json::from_value(json!({
            "requestId": "r1", "operation": "host.status", "ok": true, "result": {"a": 1}
        }))
        .expect("decode");
        assert_eq!(frame.outcome, Outcome::Ok(json!({"a": 1})));
    }

    #[test]
    fn null_result_is_a_valid_success() {
        let frame: ResponseFrame = serde_json::from_value(json!({
            "requestId": "r1", "operation": "x", "ok": true, "result": null
        }))
        .expect("decode");
        assert_eq!(frame.outcome, Outcome::Ok(Value::Null));
    }

    #[test]
    fn error_response_decodes_known_and_unknown_codes() {
        let frame: ResponseFrame = serde_json::from_value(json!({
            "requestId": "r1", "operation": "x", "ok": false,
            "error": {"code": "host_not_ready", "message": "starting"}
        }))
        .expect("decode");
        assert_eq!(
            frame.outcome,
            Outcome::Err(HostOperationError::new(HostOperationErrorCode::HostNotReady, "starting"))
        );
        let frame: ResponseFrame = serde_json::from_value(json!({
            "requestId": "r1", "operation": "x", "ok": false,
            "error": {"code": "brand_new_code", "message": "m"}
        }))
        .expect("decode");
        let Outcome::Err(error) = frame.outcome else {
            panic!("expected error");
        };
        assert_eq!(error.code, HostOperationErrorCode::Other("brand_new_code".into()));
    }

    #[test]
    fn inconsistent_outcomes_are_rejected() {
        for value in [
            json!({"requestId": "r", "operation": "x", "ok": true}),
            json!({"requestId": "r", "operation": "x", "ok": false, "result": 1}),
            json!({"requestId": "r", "operation": "x", "ok": true, "result": 1,
                   "error": {"code": "internal_failure", "message": "m"}}),
            json!({"requestId": "r", "operation": "x", "ok": "yes", "result": 1}),
        ] {
            assert!(serde_json::from_value::<ResponseFrame>(value).is_err());
        }
    }

    #[test]
    fn response_round_trips() {
        let frame = ResponseFrame::err(
            "r1",
            "x",
            HostOperationError::new(HostOperationErrorCode::InternalFailure, "boom"),
        );
        let value = serde_json::to_value(&frame).expect("encode");
        assert_eq!(value["ok"], json!(false));
        assert!(value.get("result").is_none());
        assert_eq!(serde_json::from_value::<ResponseFrame>(value).expect("decode"), frame);
    }
}
