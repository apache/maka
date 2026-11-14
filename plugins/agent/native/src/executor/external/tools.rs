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

//! Request-scoped MCP authority delegates actual effects to the Agent owner.
use super::*;
use maka_agent_facts::{
    durable::{ExecutionIdentity, ExternalTaskId},
    execution::CodeLanguage,
    tool_call::{ToolCallIdentity, ToolOrigin},
    tool_output::{DurableToolProjection, ReturnedToolResult, ToolOutput},
    tools::{ToolCallContext, ToolDefinition, ToolError},
};
use maka_model::prompt::{ContentPart, FileData};
use maka_plugin_core::{operation::OperationResult, work::WorkCustody};
use maka_tools::ToolCatalog;

/// The native owner owns canonical preparation, current access, one original T1,
/// execution custody and the full immutable return/receipt/cleanup observations.
pub(crate) trait HostEffects: Send + Sync {
    fn invoke(
        &self,
        catalog: ToolCatalog,
        context: ToolCallContext,
        definition: ToolDefinition,
        input: Value,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<ReturnedToolResult, ToolError>>;

    fn finish_signal(&self) -> CancellationToken;

    fn content<'a>(
        &'a self,
        returned: &'a ReturnedToolResult,
        cancellation: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Vec<ContentPart>, String>>;
}

#[derive(Clone)]
pub(crate) struct HostTools {
    pub availability: maka_tools::availability::Availability,
    pub code_language: CodeLanguage,
    pub effects: Arc<dyn HostEffects>,
}

pub(super) struct Tools {
    tools: Option<BoundTools>,
    execution: ExecutionIdentity,
    custody: Arc<dyn WorkCustody>,
    task: ExternalTaskId,
    source: maka_agent_facts::executor::Binding,
}

struct BoundTools {
    catalog: ToolCatalog,
    definitions: Vec<ToolDefinition>,
    effects: Arc<dyn HostEffects>,
}

impl Tools {
    pub async fn bind(
        tools: Option<HostTools>,
        request: &Request,
        custody: Arc<dyn WorkCustody>,
        owner: &External,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        let tools = if let Some(tools) = tools {
            let bound = tools
                .availability
                .capture(
                    None,
                    request.execution.clone(),
                    Some(custody.clone()),
                    request.cwd.clone(),
                    cancellation,
                )
                .await
                .map_err(|error| Error::Provider(error.to_string()))?;
            Some(BoundTools {
                catalog: bound.all(),
                definitions: maka_tools::CodeCells::definitions_for(&bound, tools.code_language),
                effects: tools.effects,
            })
        } else {
            None
        };
        Ok(Self {
            tools,
            execution: request.execution.clone(),
            custody,
            task: request.task_id,
            source: owner.source_identity(),
        })
    }

    pub fn finish_signal(&self) -> CancellationToken {
        self.tools
            .as_ref()
            .map_or_else(CancellationToken::new, |tools| {
                tools.effects.finish_signal()
            })
    }

    pub fn definitions(&self) -> Vec<Value> {
        self.tools.iter().flat_map(|tools| &tools.definitions).map(|tool| serde_json::json!({
            "name":tool.name, "description":tool.description, "inputSchema":tool.input_schema,
        })).collect()
    }

    pub fn invoke(
        &self,
        name: String,
        input: Value,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, (Value, Option<Error>)> {
        let Some(tools) = &self.tools else {
            return Box::pin(async {
                (
                    mcp_error(
                        serde_json::json!({"message":"Host tools are unavailable for this execution"}),
                    ),
                    None,
                )
            });
        };
        let Some(definition) = tools.definitions.iter().find(|tool| tool.name == name) else {
            return Box::pin(async {
                (
                    mcp_error(serde_json::json!({"message":"Unknown Maka tool"})),
                    None,
                )
            });
        };
        let definition = definition.clone();
        let operation = Uuid::new_v4();
        let operation_id = format!("external:{}:{operation}", self.task);
        let context = ToolCallContext {
            execution: self.execution.clone(),
            operation_id: operation_id.clone(),
            call: ToolCallIdentity {
                tool_call_id: operation_id.clone(),
                origin: ToolOrigin::External {
                    task: self.task,
                    operation,
                    package_id: self.source.package_id.clone(),
                    entry_id: self.source.entry_id.clone(),
                    activation: self.source.activation.clone(),
                },
            },
            custody: Some(self.custody.clone()),
        };
        let effects = tools.effects.clone();
        let catalog = tools.catalog.clone();
        Box::pin(async move {
            let result = effects
                .invoke(catalog, context, definition, input, cancellation.clone())
                .await;
            match result {
                Ok(returned) => {
                    if let ToolOutput::Operation(reply) = &returned.output {
                        let failure = match &reply.receipt {
                            Receipt::Recorded {
                                cleanup:
                                    OperationCleanup::Unconfirmed | OperationCleanup::Failed { .. },
                                ..
                            } => Some((
                                "Original Host operation cleanup is unconfirmed".to_owned(),
                                Some(Error::CleanupUnconfirmed),
                            )),
                            Receipt::Recorded {
                                outcome:
                                    OperationOutcome::Returned {
                                        result: OperationResult::Failure { diagnostic },
                                    },
                                ..
                            } => Some((diagnostic.clone(), None)),
                            Receipt::Recorded {
                                outcome: OperationOutcome::NotExecuted { .. },
                                ..
                            } => Some((
                                "Operation was prevented before handler execution".into(),
                                None,
                            )),
                            Receipt::Recorded {
                                outcome:
                                    OperationOutcome::Returned {
                                        result: OperationResult::Success { .. },
                                    },
                                cleanup: OperationCleanup::Confirmed,
                            } => None,
                            Receipt::Recorded {
                                outcome:
                                    OperationOutcome::Unresolved | OperationOutcome::Unknown { .. },
                                ..
                            }
                            | Receipt::NotRecorded
                            | Receipt::Unavailable { .. } => Some((
                                "Original Host operation outcome is unknown".into(),
                                Some(Error::Unknown),
                            )),
                        };
                        if let Some((message, fatal)) = failure {
                            return (
                                mcp_error(
                                    serde_json::json!({"message":message,"operationId":operation_id,"observation":reply}),
                                ),
                                fatal,
                            );
                        }
                    }
                    let is_error = returned.is_error
                        || matches!(&returned.projection, DurableToolProjection::Failure);
                    if let DurableToolProjection::Text { text } = &returned.projection {
                        return (mcp_content(vec![ContentPart::text(text)], is_error), None);
                    }
                    if matches!(&returned.projection, DurableToolProjection::Content { .. }) {
                        return match effects.content(&returned, &cancellation).await {
                            Ok(parts) => (mcp_content(parts, is_error), None),
                            Err(message) => (
                                mcp_error(serde_json::json!({
                                    "message": message,
                                    "operationId": operation_id,
                                })),
                                None,
                            ),
                        };
                    }
                    match maka_agent_facts::archive::encode_projection(&returned.projection)
                        .map_err(str::to_owned)
                        .and_then(|bytes| {
                            serde_json::from_slice::<Value>(&bytes)
                                .map_err(|error| error.to_string())
                        }) {
                        Ok(value) => (mcp(value, is_error), None),
                        Err(message) => (
                            mcp_error(
                                serde_json::json!({"message":message,"operationId":operation_id}),
                            ),
                            Some(Error::Unknown),
                        ),
                    }
                }
                Err(error) => {
                    let fatal = match &error {
                        ToolError::OperationUnknown { .. } | ToolError::OutcomeUnknown(_) => {
                            Some(Error::Unknown)
                        }
                        ToolError::CleanupUnconfirmed(_)
                        | ToolError::OperationCleanupUnconfirmed { .. } => {
                            Some(Error::CleanupUnconfirmed)
                        }
                        ToolError::Persistence(message) => {
                            Some(Error::Persistence(message.clone()))
                        }
                        _ => None,
                    };
                    let observation = match &error {
                        ToolError::OperationUnknown { observation, .. }
                        | ToolError::OperationCleanupUnconfirmed { observation, .. } => Some(
                            serde_json::to_value(observation).expect("operation receipt is JSON"),
                        ),
                        _ => None,
                    };
                    (
                        mcp_error(
                            serde_json::json!({"message":error.to_string(),"operationId":operation_id,"observation":observation}),
                        ),
                        fatal,
                    )
                }
            }
        })
    }
}

fn mcp(value: Value, error: bool) -> Value {
    tool_result(
        vec![serde_json::json!({"type":"text","text":value.to_string()})],
        error,
    )
}

fn mcp_content(parts: Vec<ContentPart>, error: bool) -> Value {
    let content = parts
        .into_iter()
        .map(|part| match part {
            ContentPart::Text { text, .. } => serde_json::json!({"type": "text", "text": text}),
            ContentPart::File {
                data: FileData::Data(data),
                media_type,
                ..
            } => {
                let kind = if media_type.starts_with("audio/") {
                    "audio"
                } else {
                    "image"
                };
                serde_json::json!({"type": kind, "data": data, "mimeType": media_type})
            }
        })
        .collect();
    tool_result(content, error)
}

fn tool_result(content: Vec<Value>, error: bool) -> Value {
    let mut result = serde_json::json!({"content": content});
    if error {
        result["isError"] = true.into();
    }
    result
}
fn mcp_error(value: Value) -> Value {
    mcp(value, true)
}
