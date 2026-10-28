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

use super::error;
use maka_agent_facts::model::error::ModelError;
use maka_agent_facts::model::error::ProviderFailureReason;
use maka_agent_ports::model::Frame;
use maka_agent_ports::model::Socket;
use serde_json::Value;

pub(super) enum ReadError {
    CleanupUnconfirmed,
    Cancelled,
    Interrupted(String),
    Invalid(String),
}

impl ReadError {
    pub fn into_error(self) -> super::super::Error {
        match self {
            Self::CleanupUnconfirmed => super::super::Error::CleanupUnconfirmed,
            Self::Cancelled => error("Responses WebSocket cancelled"),
            Self::Interrupted(message) => super::super::Error::Interrupted(message),
            Self::Invalid(message) => super::super::Error::Invalid(message),
        }
    }
}

pub(super) async fn receive(
    socket: &dyn Socket,
) -> std::result::Result<(String, bool, bool, Value), ReadError> {
    use ReadError::{Interrupted, Invalid};
    let frame = socket
        .receive()
        .await
        .map_err(|cause| match cause {
            ModelError::CleanupUnconfirmed => ReadError::CleanupUnconfirmed,
            ModelError::Cancelled => ReadError::Cancelled,
            ModelError::Provider(ref failure)
                if matches!(
                    failure.reason(),
                    ProviderFailureReason::Network | ProviderFailureReason::StreamTruncated
                ) =>
            {
                Interrupted(failure.message().to_owned())
            }
            ModelError::Adapter(message) => Invalid(message),
            cause => Invalid(cause.to_string()),
        })?
        .ok_or_else(|| Interrupted("Responses WebSocket ended before completion".into()))?;
    let Frame::Text(text) = frame else {
        return Err(Invalid(
            "Responses WebSocket expected a JSON text frame".into(),
        ));
    };
    let event: Value = serde_json::from_str(&text)
        .map_err(|_| Invalid("Responses WebSocket returned invalid JSON".into()))?;
    let kind = event["type"]
        .as_str()
        .ok_or(Invalid("Responses WebSocket event has no type".into()))?;
    let reusable = matches!(kind, "response.completed" | "response.done")
        || (kind == "response.incomplete"
            && event["response"]["incomplete_details"]["reason"] == "max_output_tokens");
    let terminal = reusable || matches!(kind, "response.incomplete" | "response.failed" | "error");
    // Deliver terminal semantics to the shared decoder, including Incomplete
    // without details. A non-reusable terminal simply discards the WS cache.
    // JSON whitespace may contain newlines, which must not become SSE
    // record boundaries when the frame crosses the SDK fetch bridge.
    let text = event.to_string();
    Ok((text, terminal, reusable, event))
}
