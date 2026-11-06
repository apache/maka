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

use agent_client_protocol::{Dispatch, Error, Handled, Protocol, UntypedMessage};
use serde_json::Value;

/// Optional SDK fields use permissive decoding. Reject unsupported requests
/// before that decoding can erase malformed or nonempty capability inputs.
pub(super) fn validate<P: Protocol>(
    message: Dispatch<UntypedMessage, UntypedMessage, P>,
    valid_content: impl Fn(&Value) -> bool,
) -> Result<Handled<Dispatch<UntypedMessage, UntypedMessage, P>>, Error> {
    if let Dispatch::Request(request, responder) = message {
        if let Err(reason) = parameters(&request.method, &request.params, valid_content) {
            responder.respond_with_error(Error::invalid_params().data(reason.to_string()))?;
            return Ok(Handled::Yes);
        }
        return Ok(Handled::No {
            message: Dispatch::Request(request, responder),
            retry: false,
        });
    }
    Ok(Handled::No {
        message,
        retry: false,
    })
}
fn parameters(
    method: &str,
    params: &Value,
    valid_content: impl Fn(&Value) -> bool,
) -> Result<(), &'static str> {
    match method {
        "session/new" | "session/resume" | "session/load" => {
            for field in ["mcpServers", "additionalDirectories"] {
                if params.get(field).is_some_and(|value| {
                    !value.is_null() && !value.as_array().is_some_and(Vec::is_empty)
                }) {
                    return Err(
                        "MCP servers and additional directories are not supported by this connection",
                    );
                }
            }
            if method == "session/resume"
                && params.get("replayFrom").is_some_and(|value| {
                    !value.is_null()
                        && !matches!(
                            serde_json::from_value::<agent_client_protocol::v2::schema::ReplayFrom>(
                                value.clone()
                            ),
                            Ok(agent_client_protocol::v2::schema::ReplayFrom::Start(_))
                        )
                })
            {
                return Err("Unsupported replay cursor");
            }
        }
        "session/prompt" => {
            let blocks = params
                .get("prompt")
                .and_then(Value::as_array)
                .ok_or("Prompt must be an array of content blocks")?;
            if blocks.iter().any(|block| !valid_content(block)) {
                return Err("Invalid prompt content");
            }
        }
        _ => {}
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn parameters(method: &str, params: &Value) -> Result<(), &'static str> {
        super::parameters(method, params, |v| {
            serde_json::from_value::<agent_client_protocol::v2::schema::ContentBlock>(v.clone())
                .is_ok()
        })
    }
    use serde_json::json;
    #[test]
    fn optional_decoding_cannot_silently_drop_requested_capabilities() {
        assert!(parameters("session/new", &json!({"mcpServers":[{"broken":true}]})).is_err());
        assert!(parameters("session/new", &json!({"additionalDirectories":"broken"})).is_err());
        assert!(parameters("session/resume", &json!({"replayFrom":{"type":"missing"}})).is_err());
        assert!(parameters("session/new", &json!({"mcpServers":null})).is_ok());
        assert!(parameters("session/prompt", &json!({"prompt":[{"type":"text"}]})).is_err());
    }
}
