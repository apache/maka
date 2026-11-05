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

//! Request-scoped Host authority and journaled MCP results.
use super::*;
use maka_agent_facts::{
    archive::ArchivedPlaceholder,
    event::{CommitFuture, EventSink, EventWrite, Fact, PrefixCommitFuture, ToolOutcome},
    read::{ReadInput, ResourceAddress},
    tool_call::{ToolCallIdentity, ToolOrigin, ToolRejection},
    tool_output::ToolOutput,
    tools::{ExecutionCustody, ToolError, ToolJournal},
};
use maka_event_log::SessionStore;
use maka_tools::ToolCatalog;
use std::sync::Mutex;

#[derive(Clone, Default)]
pub(crate) struct HostTools {
    pub catalog: ToolCatalog,
    pub resource_reads: Vec<String>,
}

pub(super) struct Tools {
    tools: HostTools,
    store: Arc<SessionStore>,
    invocation: maka_agent_facts::event::Invocation,
    origin: ToolOrigin,
}

impl Tools {
    #[cfg(test)]
    pub(super) fn for_test(store: Arc<SessionStore>) -> Self {
        Self {
            tools: HostTools::default(),
            store,
            invocation: maka_agent_facts::event::Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            origin: ToolOrigin::HostSdk {
                package_id: "test".into(),
                entry_id: "external".into(),
                activation: "test".into(),
                parent: None,
            },
        }
    }
    pub async fn bind(
        mut tools: HostTools,
        store: Arc<SessionStore>,
        request: &Request,
        execution: Arc<dyn ExecutionCustody>,
        owner: &External,
        cancellation: CancellationToken,
    ) -> Result<Self, Error> {
        tools
            .catalog
            .bind_request(maka_tools::request::BindingRequest {
                behavior: None,
                model: None,
                invocation: request.invocation.clone(),
                execution: Some(execution),
                cwd: request.cwd.clone(),
                tools: tools.catalog.names().into_iter().collect(),
                available_tools: tools.catalog.names().into(),
                cancellation,
            })
            .await
            .map_err(|error| Error::Provider(error.to_string()))?;
        Ok(Self {
            tools,
            store,
            invocation: request.invocation.clone(),
            origin: ToolOrigin::HostSdk {
                package_id: owner.package.clone(),
                entry_id: "external".into(),
                activation: owner.activation.clone(),
                parent: None,
            },
        })
    }

    pub fn definitions(&self) -> Vec<Value> {
        self.tools.catalog.definitions().map(|tool| serde_json::json!({
            "name":tool.name, "description":tool.description, "inputSchema":tool.input_schema,
        })).collect()
    }

    pub fn invoke(
        &self,
        name: String,
        input: Value,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, (Value, Option<Error>)> {
        let operation_id = Uuid::new_v4().to_string();
        let call = ToolCallIdentity {
            tool_call_id: Uuid::new_v4().to_string(),
            origin: self.origin.clone(),
        };
        let sink = Arc::new(Sink {
            store: self.store.clone(),
            name: name.clone(),
            call_id: call.tool_call_id.clone(),
            evidence: Mutex::new(Evidence::default()),
        });
        let journal = ToolJournal::new(sink.clone(), self.invocation.clone());
        let catalog = self.tools.catalog.clone();
        let resource_read = self.tools.resource_reads.contains(&name);
        Box::pin(async move {
            let prepared = async {
                if resource_read {
                    authorize_resource(&input)?;
                }
                catalog
                    .prepare(
                        name.clone(),
                        input.clone(),
                        journal.context(operation_id.clone()),
                        cancellation.clone(),
                    )
                    .await
            }
            .await;
            let rejected = prepared.as_ref().err().map(|reason| format!("{reason:?}"));
            let result = match prepared {
                Ok(effect) => {
                    journal
                        .invoke_prepared_output(
                            operation_id.clone(),
                            call,
                            name,
                            input,
                            None,
                            cancellation,
                            effect,
                        )
                        .await
                }
                Err(reason) => journal
                    .reject(operation_id.clone(), call, name, input.into(), None, reason)
                    .await
                    .map(ToolOutput::Json),
            };
            let evidence = std::mem::take(
                &mut *sink
                    .evidence
                    .lock()
                    .expect("Host tool evidence lock poisoned"),
            );
            match result {
                Ok(output) => {
                    if let Some(reason) = rejected {
                        return (
                            mcp_error(
                                serde_json::json!({"message":reason,"operationId":operation_id}),
                            ),
                            None,
                        );
                    }
                    if let ToolOutput::Operation(reply) = &output
                        && matches!(
                            &reply.receipt,
                            Receipt::Recorded {
                                cleanup: OperationCleanup::Unconfirmed
                                    | OperationCleanup::Failed { .. },
                                ..
                            }
                        )
                    {
                        return (
                            mcp_error(
                                serde_json::json!({"message":"Original Host operation cleanup is unconfirmed","operationId":operation_id,"observation":reply}),
                            ),
                            Some(Error::CleanupUnconfirmed),
                        );
                    }
                    let image = matches!(&output, ToolOutput::Image(_));
                    if image {
                        return (
                            mcp_error(
                                serde_json::json!({"message":"Image resources are unsupported by the External agent Host bridge", "operationId":operation_id}),
                            ),
                            None,
                        );
                    }
                    let value = match evidence.archived {
                        Some(value) => value,
                        None => match output.into_code_value() {
                            Ok(value) => value,
                            Err(message) => {
                                return (
                                    mcp_error(
                                        serde_json::json!({"message":message,"operationId":operation_id}),
                                    ),
                                    Some(Error::Unknown),
                                );
                            }
                        },
                    };
                    (mcp(value, false), None)
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
                        _ => evidence.observation,
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

#[derive(Default)]
struct Evidence {
    archived: Option<Value>,
    observation: Option<Value>,
}
struct Sink {
    store: Arc<SessionStore>,
    name: String,
    call_id: String,
    evidence: Mutex<Evidence>,
}
impl EventSink for Sink {
    fn execution_custody(self: Arc<Self>) -> Option<Arc<dyn ExecutionCustody>> {
        self.store.clone().execution_custody()
    }
    fn commit(self: Arc<Self>, event: EventWrite) -> CommitFuture {
        Box::pin(async move {
            // This is the original T2 event, including its real ID and frozen projection.
            let placeholder = match &event.event().fact {
                Fact::ToolSettled {
                    outcome:
                        ToolOutcome::Succeeded {
                            model_projection, ..
                        },
                    ..
                } => ArchivedPlaceholder::prepare(
                    event.event().id.clone(),
                    self.call_id.clone(),
                    self.name.clone(),
                    model_projection,
                )
                .map_err(|message| {
                    maka_agent_facts::event::CommitError::Rejected(message.into())
                })?,
                _ => None,
            };
            let observation = match &event.event().fact {
                Fact::ToolOperationObserved { observation, .. } => {
                    Some(serde_json::to_value(observation).expect("operation receipt is JSON"))
                }
                _ => None,
            };
            let sequence = self.store.clone().commit(event).await?;
            if let Some(placeholder) = placeholder {
                let value = match placeholder.to_canonical_projection().map_err(|message| {
                    maka_agent_facts::event::CommitError::Rejected(message.into())
                })? {
                    maka_agent_facts::tool_output::DurableToolProjection::Json { value } => value,
                    _ => unreachable!("archive placeholder is JSON"),
                };
                self.evidence
                    .lock()
                    .expect("Host tool evidence lock poisoned")
                    .archived = Some(value);
            }
            if let Some(observation) = observation {
                self.evidence
                    .lock()
                    .expect("Host tool evidence lock poisoned")
                    .observation = Some(observation);
            }
            Ok(sequence)
        })
    }
    fn commit_with_prefix(
        self: Arc<Self>,
        prefix: &[EventWrite],
        last: EventWrite,
    ) -> PrefixCommitFuture {
        self.store.clone().commit_with_prefix(prefix, last)
    }
}
