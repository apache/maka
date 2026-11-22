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

//! Explicit user-input service. The Host labels this Agent input service; model input cannot impersonate a requester.
use futures_util::future::BoxFuture;
use maka_agent_authority::computer::NativeCallContext;
use maka_agent_authority::executor::ExecutorCallContext;
use maka_agent_facts::capability::FormRequester;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_event_log::RootStore;
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation, NativeOwner,
    NativeRegistry,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};

use maka_interactions_api::forms::*;
pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        maka_interactions_api::forms::IMPLEMENTATION.into(),
        Arc::new(|context, _| {
            Box::pin(async move {
                let Some(persistence) = context.persistence() else {
                    return NativeActivation {
                        exports: Err("forms_require_persistence".into()),
                        owner: Arc::new(()),
                    };
                };
                let owner = Arc::new(Forms(persistence.store().clone()));
                NativeActivation {
                    exports: Ok(BTreeMap::from([(
                        EXPORT.into(),
                        maka_plugin_core::runtime::Published {
                            contract: contract(),
                            value: owner.clone() as Arc<dyn Handler>,
                        },
                    )])),
                    owner,
                }
            })
        }),
    )
}
struct Forms(Arc<RootStore>);
enum Caller {
    Native(Arc<NativeCallContext>),
    Executor(Arc<ExecutorCallContext>),
}
impl Handler for Forms {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let result = async move {
            if method != "ask" {
                return Err("form_method_unavailable".into());
            }
            let execution = context
                .scope()
                .identity
                .agent()
                .ok_or("form_requires_agent")?;
            let operation_id = context
                .scope()
                .identity
                .operation_id()
                .ok_or("form_requires_tool")?;
            let operation = context.operation().ok_or("form_requires_mutation")?;
            let caller = if let Some(native) = context.native_context::<NativeCallContext>() {
                Caller::Native(native)
            } else if let Some(executor) = context.native_context::<ExecutorCallContext>() {
                Caller::Executor(executor)
            } else {
                return Err("agent_native_call_context_missing".into());
            };
            let tool_use_id = match &caller {
                Caller::Native(native) => {
                    let tool = native.access().call();
                    if &tool.execution != execution || tool.operation_id != operation_id {
                        return Err("interaction_native_call_mismatch".into());
                    }
                    tool.tool_use_id()
                }
                Caller::Executor(_) => {
                    maka_agent_facts::tool_call::tool_use_id(execution.run_id, operation_id)
                }
            };
            let input: Ask = serde_json::from_value(input).map_err(|_| "form_input_invalid")?;
            let request = InteractionRequest::Form {
                tool_use_id,
                message: input.message,
                requester: FormRequester {
                    name: "Agent".into(),
                    source: None,
                },
                fields: input.fields,
            };
            if request.validate().is_err() {
                return encode(Answer::Rejected {
                    reason: maka_interactions_api::questions::Rejection::InvalidInput,
                });
            }
            if context.scope().cancellation.is_cancelled() {
                return encode(Answer::Rejected {
                    reason: maka_interactions_api::questions::Rejection::Unavailable,
                });
            }
            if let Caller::Native(native) = &caller {
                native
                    .access()
                    .bind_original(&context)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            let record = InteractionRecord {
                execution: execution.clone(),
                request_id: format!(
                    "form_{}",
                    hex::encode(Sha256::digest(
                        serde_json::to_vec(operation).expect("operation identity")
                    ))
                ),
                created_at: maka_agent_authority::now(),
                request,
                outcome: None,
            };
            let Some(result) = (match &caller {
                Caller::Native(native) => {
                    maka_agent_authority::interaction_wait::publish(
                        native.access(),
                        &context,
                        &record,
                    )
                    .await?
                }
                Caller::Executor(executor) => executor.0.publish_form(&context, &record).await?,
            }) else {
                return encode(Answer::Rejected {
                    reason: maka_interactions_api::questions::Rejection::Unavailable,
                });
            };
            encode(match result {
                InteractionOutcome::FormAnswer { result, .. } => Answer::Answered { result },
                InteractionOutcome::Closure { reason, .. } => Answer::Closed { reason },
                _ => return Err("form_outcome_invalid".into()),
            })
        };
        Box::pin(async move {
            let result: std::result::Result<Value, String> = result.await;
            result.map(HandlerValue::Json).map_err(HandlerError::from)
        })
    }
}
fn encode(answer: Answer) -> Result<Value, String> {
    serde_json::to_value(answer).map_err(|_| "form_output_unavailable".into())
}
impl NativeOwner for Forms {
    fn execution_basis(&self) -> Option<Value> {
        Some(serde_json::json!({"root": self.0.owned_root().ok()?.root_id()}))
    }
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
