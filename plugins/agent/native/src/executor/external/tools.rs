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
    read::{ReadInput, ResourceAddress},
    tool_call::{ToolCallIdentity, ToolOrigin, ToolRejection},
    tool_output::{DurableToolProjection, ReturnedToolResult, ToolOutput},
    tools::{ToolCallContext, ToolError},
};
use maka_plugin_core::{operation::OperationResult, work::WorkCustody};
use maka_tools::ToolCatalog;

/// The native owner owns canonical preparation, current access, one original T1,
/// execution custody and the full immutable return/receipt/cleanup observations.
pub(crate) trait HostEffects: Send + Sync {
    fn invoke(
        &self,
        catalog: ToolCatalog,
        context: ToolCallContext,
        name: String,
        input: Value,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<ReturnedToolResult, ToolError>>;
}

#[derive(Clone)]
pub(crate) struct HostTools {
    pub catalog: ToolCatalog,
    pub resource_reads: Vec<String>,
    pub effects: Arc<dyn HostEffects>,
}

pub(super) struct Tools {
    tools: Option<HostTools>,
    execution: ExecutionIdentity,
    custody: Arc<dyn WorkCustody>,
    task: ExternalTaskId,
    source: maka_agent_facts::executor::Binding,
}

impl Tools {
    #[cfg(test)]
    pub(super) fn for_test(
        catalog: ToolCatalog,
        execution: ExecutionIdentity,
        custody: Arc<dyn WorkCustody>,
        task: ExternalTaskId,
        source: maka_agent_facts::executor::Binding,
        effects: Arc<dyn HostEffects>,
    ) -> Self {
        Self {
            tools: Some(HostTools {
                catalog,
                resource_reads: Vec::new(),
                effects,
            }),
            execution,
            custody,
            task,
            source,
        }
    }
    pub async fn bind(
        mut tools: Option<HostTools>,
        request: &Request,
        custody: Arc<dyn WorkCustody>,
        owner: &External,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        if let Some(tools) = &mut tools {
            tools
                .catalog
                .bind_request(maka_tools::request::BindingRequest {
                    behavior: None,
                    model: None,
                    execution: request.execution.clone(),
                    custody: Some(custody.clone()),
                    cwd: request.cwd.clone(),
                    tools: tools.catalog.names().into_iter().collect(),
                    available_tools: tools.catalog.names().into(),
                    cancellation,
                })
                .await
                .map_err(|error| Error::Provider(error.to_string()))?;
        }
        Ok(Self {
            tools,
            execution: request.execution.clone(),
            custody,
            task: request.task_id,
            source: owner.source_identity(),
        })
    }

    pub fn definitions(&self) -> Vec<Value> {
        self.tools.iter().flat_map(|tools| tools.catalog.definitions()).map(|tool| serde_json::json!({
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
        let resource_read = tools.resource_reads.contains(&name);
        Box::pin(async move {
            if resource_read && let Err(reason) = authorize_resource(&input) {
                return (
                    mcp_error(
                        serde_json::json!({"message":reason.to_string(),"operationId":operation_id}),
                    ),
                    None,
                );
            }
            let result = effects
                .invoke(catalog, context, name, input, cancellation)
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
                    if matches!(&returned.output, ToolOutput::Image(_))
                        || matches!(&returned.output,ToolOutput::Mcp(result) if result.content.iter().any(|part|matches!(part,maka_agent_facts::capability::ContentBlock::Image {..}|maka_agent_facts::capability::ContentBlock::Audio {..})))
                        || matches!(&returned.projection,DurableToolProjection::Content {parts} if parts.iter().any(|part|part.media().is_some()))
                    {
                        return (
                            mcp_error(
                                serde_json::json!({"message":"Image resources are unsupported by the External agent Host bridge","operationId":operation_id}),
                            ),
                            None,
                        );
                    }
                    let is_error = returned.is_error
                        || matches!(&returned.projection, DurableToolProjection::Failure);
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

fn authorize_resource(input: &Value) -> Result<(), ToolRejection> {
    let request = serde_json::from_value::<ReadInput>(input.clone())
        .map_err(|error| ToolRejection::InvalidInput {
            message: error.to_string(),
        })?
        .resolve()
        .map_err(|error| ToolRejection::InvalidInput {
            message: error.to_string(),
        })?;
    if maka_agent_facts::read::parse_imported_tool_result_path(request.path())
        .map_err(|error| ToolRejection::InvalidInput {
            message: error.to_string(),
        })?
        .is_some()
    {
        return Ok(());
    }
    match ResourceAddress::parse(request.path()) {
        Ok(Some(ResourceAddress::Attachment(_) | ResourceAddress::ToolResult(_))) => Ok(()),
        _ => Err(ToolRejection::InvalidInput {
            message: "Read only accepts Maka attachment and archived tool-result resources".into(),
        }),
    }
}
fn mcp(value: Value, error: bool) -> Value {
    let mut result = serde_json::json!({"content":[{"type":"text","text":serde_json::to_string(&value).expect("tool result is JSON")}]});
    if error {
        result["isError"] = true.into();
    }
    result
}
fn mcp_error(value: Value) -> Value {
    mcp(value, true)
}
