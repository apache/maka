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

//! Transport-independent protocol envelope. Domain validation is explicitly
//! delegated to an operation registry; subscription/capability frames are separate.
pub mod access;
pub mod artifact;
mod authority;
pub mod capability;
pub mod codec;
pub mod configuration;
pub mod configuration_pages;
pub mod connection_effects;
pub mod context;
mod display;
pub mod execution_boundary;
pub mod handshake;
pub mod host;
pub mod interaction;
pub mod message;
pub mod model_provider;
pub mod navigation;
pub mod oauth;
pub mod onboarding;
pub mod operation;
pub mod operation_error;
pub mod plugin;
pub mod pricing;
pub mod project;
pub mod request_headers;
pub mod resource;
pub use operation::{Availability, Operation, OperationMode};
pub use operation_error::OperationErrorCode;
pub mod network_proxy;
pub mod runtime_policy;
pub mod sandbox_setup;
pub mod session;
pub mod subscription;
pub mod transcript;
pub mod turn;

use codec::{exact, record, string};
use serde::Serialize;
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 0;
pub const COMPATIBILITY_EPOCH: u64 = 190;
pub const COMPOSITION_ID: &str = "maka.interactive";
pub const MAX_MESSAGE_BYTES: usize = 768 * 1024;
pub const MAX_IN_FLIGHT_DOMAIN_REQUESTS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidFrame,
    FrameTooLarge,
    InvalidUtf8,
    InvalidJson,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, ProtocolError>;

impl ProtocolError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::InvalidFrame,
            message: message.into(),
        }
    }
}

/// Decode one complete message. Framing and connection admission are caller-owned.
/// This JSON boundary is not fully equivalent to JavaScript JSON.parse:
/// serde_json rejects unpaired UTF-16 surrogate escapes, out-of-range floating
/// numbers and nesting beyond its default recursion limit.
pub fn decode_message(bytes: &[u8]) -> Result<Value> {
    check_size(bytes.len())?;
    let text = std::str::from_utf8(bytes).map_err(|e| ProtocolError {
        code: ErrorCode::InvalidUtf8,
        message: e.to_string(),
    })?;
    serde_json::from_str(text).map_err(|e| ProtocolError {
        code: ErrorCode::InvalidJson,
        message: e.to_string(),
    })
}

pub fn encode_message(value: &impl Serialize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|e| ProtocolError {
        code: ErrorCode::InvalidJson,
        message: e.to_string(),
    })?;
    check_size(bytes.len())?;
    Ok(bytes)
}

fn check_size(size: usize) -> Result<()> {
    if size > MAX_MESSAGE_BYTES {
        return Err(ProtocolError {
            code: ErrorCode::FrameTooLarge,
            message: "Runtime Host message exceeds the byte limit".into(),
        });
    }
    Ok(())
}

/// Implementations must reject unknown operation keys and validate their payloads.
/// Returning a normalized value permits source decoders that discard optional keys.
pub trait OperationRegistry {
    fn decode_input(&self, operation: Operation, value: &Value) -> Result<Value>;
    fn decode_output(&self, operation: Operation, value: &Value) -> Result<Value>;
    /// None means an unknown operation; unauthorized is allowed for every known key.
    fn error_codes(&self, operation: Operation) -> Option<&[OperationErrorCode]>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub request_id: String,
    pub operation: Operation,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct OperationError {
    pub code: OperationErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Success { result: Value },
    Failure { error: OperationError },
}

impl Serialize for Outcome {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut frame = serializer.serialize_struct("Outcome", 2)?;
        match self {
            Self::Success { result } => {
                frame.serialize_field("ok", &true)?;
                frame.serialize_field("result", result)?;
            }
            Self::Failure { error } => {
                frame.serialize_field("ok", &false)?;
                frame.serialize_field("error", error)?;
            }
        }
        frame.end()
    }
}

impl Outcome {
    pub fn success(result: Value) -> Self {
        Self::Success { result }
    }
    pub fn failure(error: OperationError) -> Self {
        Self::Failure { error }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub request_id: String,
    pub operation: Operation,
    #[serde(flatten)]
    pub outcome: Outcome,
}

pub fn decode_request(value: &Value, registry: &impl OperationRegistry) -> Result<Request> {
    let mut request = decode_request_envelope(value)?;
    if registry.error_codes(request.operation).is_none() {
        return Err(ProtocolError::invalid("Operation is not registered"));
    }
    request.input = registry.decode_input(request.operation, &request.input)?;
    Ok(request)
}

/// Validate the wire envelope without claiming an unimplemented operation's input is supported.
/// Hosts can reject that operation while preserving the shared connection.
pub fn decode_request_envelope(value: &Value) -> Result<Request> {
    let frame = record(value, "operation request")?;
    exact(frame, &["requestId", "operation", "input"])?;
    let request_id = string(&frame["requestId"], "requestId", 128)?;
    let operation = frame["operation"]
        .as_str()
        .ok_or_else(|| ProtocolError::invalid("Invalid operation key"))?
        .parse()?;
    let input = frame["input"].clone();
    Ok(Request {
        request_id,
        operation,
        input,
    })
}

pub fn decode_response(value: &Value, registry: &impl OperationRegistry) -> Result<Response> {
    let frame = record(value, "operation response")?;
    let request_id = string(&value["requestId"], "requestId", 128)?;
    let operation = known_operation(&value["operation"], registry)?;
    let outcome = match value["ok"].as_bool() {
        Some(true) => {
            exact(frame, &["requestId", "operation", "ok", "result"])?;
            Outcome::success(registry.decode_output(operation, &frame["result"])?)
        }
        Some(false) => {
            exact(frame, &["requestId", "operation", "ok", "error"])?;
            let error = record(&frame["error"], "operation error")?;
            exact(error, &["code", "message"])?;
            let code: OperationErrorCode = serde_json::from_value(error["code"].clone())
                .map_err(|_| ProtocolError::invalid("Invalid error code"))?;
            if code != OperationErrorCode::Unauthorized
                && !registry
                    .error_codes(operation)
                    .unwrap_or_default()
                    .contains(&code)
            {
                return Err(ProtocolError::invalid(
                    "Operation returned an undeclared error code",
                ));
            }
            Outcome::failure(OperationError {
                code,
                message: string(&error["message"], "operation error message", 1024)?,
            })
        }
        None => return Err(ProtocolError::invalid("Invalid operation response outcome")),
    };
    Ok(Response {
        request_id,
        operation,
        outcome,
    })
}

fn known_operation(value: &Value, registry: &impl OperationRegistry) -> Result<Operation> {
    let operation: Operation = value
        .as_str()
        .ok_or_else(|| ProtocolError::invalid("Invalid operation key"))?
        .parse()?;
    if registry.error_codes(operation).is_none() {
        return Err(ProtocolError::invalid("Operation is not registered"));
    }
    Ok(operation)
}
