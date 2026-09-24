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

use agent_client_protocol_schema::v1 as acp;
use maka_plugins::{
    execution::{OfferInteraction, Prompt},
    executor::{Context, Request},
    filesystem::{Operation, Write},
    host::Services,
};
use maka_runtime::{
    capability::{FormField, FormFieldSpec, FormOption, FormResult, FormValue},
    interaction::InteractionOutcome,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

mod read;

#[derive(Debug)]
pub struct CallbackError {
    pub code: i32,
    pub message: String,
}
impl CallbackError {
    fn invalid(message: impl ToString) -> Self {
        Self {
            code: -32602,
            message: message.to_string(),
        }
    }
    fn host(message: impl ToString) -> Self {
        Self {
            code: -32000,
            message: message.to_string(),
        }
    }
}

/// Agent callbacks borrow the admitted call; external consent creates no Host grant.
pub async fn handle(
    method: &str,
    params: Value,
    session: &str,
    request: &Request,
    context: &Context,
    host: &Services,
    rpc_id: &Value,
) -> Result<Value, CallbackError> {
    match method {
        "fs/read_text_file" => {
            let input: acp::ReadTextFileRequest = decode(params)?;
            check_session(&input.session_id, session)?;
            check_path(&input.path)?;
            let content = read::text(input, context, host).await?;
            encode(acp::ReadTextFileResponse::new(content))
        }
        "fs/write_text_file" => {
            let input: acp::WriteTextFileRequest = decode(params)?;
            check_session(&input.session_id, session)?;
            let path = check_path(&input.path)?.to_owned();
            host.files
                .invoke(
                    call(context)?,
                    Operation::Write(Write {
                        path,
                        content: input.content,
                    }),
                )
                .await
                .map_err(CallbackError::host)?;
            encode(acp::WriteTextFileResponse::default())
        }
        "session/request_permission" => {
            let input: acp::RequestPermissionRequest = decode(params)?;
            check_session(&input.session_id, session)?;
            permission(input, request, context, host, rpc_id).await
        }
        _ => Err(CallbackError {
            code: -32601,
            message: format!("Unsupported ACP client method: {method}"),
        }),
    }
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, CallbackError> {
    serde_json::from_value(value).map_err(CallbackError::invalid)
}
fn encode(value: impl Serialize) -> Result<Value, CallbackError> {
    serde_json::to_value(value).map_err(CallbackError::host)
}
fn check_session(actual: &acp::SessionId, expected: &str) -> Result<(), CallbackError> {
    if actual.0.as_ref() != expected {
        return Err(CallbackError::invalid(
            "Callback belongs to another ACP session",
        ));
    }
    Ok(())
}
fn check_path(path: &Path) -> Result<&str, CallbackError> {
    let text = path
        .to_str()
        .ok_or_else(|| CallbackError::invalid("Path is not UTF-8"))?;
    if !path.is_absolute() || text.contains('\0') {
        return Err(CallbackError::invalid(
            "ACP filesystem callbacks require an absolute path",
        ));
    }
    Ok(text)
}
fn call(context: &Context) -> Result<maka_plugins::call::Scope, CallbackError> {
    context
        .call
        .clone()
        .ok_or_else(|| CallbackError::host("No admitted Host call"))
}

async fn permission(
    input: acp::RequestPermissionRequest,
    request: &Request,
    context: &Context,
    host: &Services,
    rpc_id: &Value,
) -> Result<Value, CallbackError> {
    if input.options.is_empty() || input.options.len() > 32 {
        return Err(CallbackError::invalid(
            "Permission request needs 1 to 32 options",
        ));
    }
    let fields = vec![FormField {
        name: "permission".into(),
        label: "External agent permission".into(),
        required: true,
        description: None,
        spec: FormFieldSpec::SingleSelect {
            options: input
                .options
                .iter()
                .map(|option| FormOption {
                    value: option.option_id.0.to_string(),
                    label: option.name.clone(),
                })
                .collect(),
            default: None,
        },
    }];
    let title = input
        .tool_call
        .fields
        .title
        .as_deref()
        .unwrap_or("External agent tool");
    let details = serde_json::to_string(&input.tool_call).map_err(CallbackError::invalid)?;
    let message = format!(
        "{}\nConsent for the external agent's sandboxed process.\n{}",
        excerpt(title, 256),
        excerpt(&details, 1600)
    );
    let digest = serde_json::to_vec(&(&request.invocation.invocation_id, rpc_id, &input))
        .map_err(CallbackError::invalid)?;
    let operation_id = format!("acp-{:x}", Sha256::digest(digest));
    let offer = OfferInteraction {
        operation_id: operation_id.clone(),
        invocation: request.invocation.clone(),
        prompt: Prompt::Form {
            message,
            fields: fields.clone(),
        },
    };
    // Reuse the public form contract for option IDs, uniqueness, labels and budgets.
    offer
        .request("external-agent")
        .map_err(CallbackError::invalid)?;
    if context.cancellation.is_cancelled() {
        return cancelled();
    }
    let commands = host
        .executions
        .acquire(call(context)?)
        .await
        .map_err(CallbackError::host)?;
    // Do not drop the offer future on cancellation: it may already have committed.
    commands
        .offer_interaction(offer)
        .await
        .map_err(CallbackError::host)?;
    let result = tokio::select! {
        biased;
        _ = context.cancellation.cancelled() => None,
        result = commands.wait_interaction(operation_id.clone()) => Some(result),
    };
    // Close the exact offer on cancellation/errors; answers are never replaced.
    if result.as_ref().is_none_or(|value| value.is_err()) {
        commands
            .close_interaction(operation_id)
            .await
            .map_err(CallbackError::host)?;
    }
    let Some(result) = result else {
        return cancelled();
    };
    match result.map_err(CallbackError::host)? {
        InteractionOutcome::FormAnswer { result, .. } => {
            result
                .validate_for_fields(&fields)
                .map_err(CallbackError::host)?;
            if let FormResult::Accept { values } = result {
                let Some(FormValue::String(selected)) = values.get("permission") else {
                    return Err(CallbackError::host("Permission selection is missing"));
                };
                let option = input
                    .options
                    .iter()
                    .find(|option| option.option_id.0.as_ref() == selected)
                    .ok_or_else(|| CallbackError::host("Unknown permission selection"))?;
                encode(acp::RequestPermissionResponse::new(
                    acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                        option.option_id.clone(),
                    )),
                ))
            } else {
                cancelled()
            }
        }
        InteractionOutcome::Closure { .. } => cancelled(),
        _ => Err(CallbackError::host(
            "Unexpected permission interaction outcome",
        )),
    }
}

fn cancelled() -> Result<Value, CallbackError> {
    encode(acp::RequestPermissionResponse::new(
        acp::RequestPermissionOutcome::Cancelled,
    ))
}

fn excerpt(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} [excerpt]", &text[..end])
}
