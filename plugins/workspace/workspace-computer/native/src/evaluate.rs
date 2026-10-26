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

use super::*;
use maka_agent_facts::language::Language;
use maka_agent_facts::workspace::PermissionBasis;
use maka_agent_facts::{
    artifact::{Artifact, ArtifactKind, ArtifactSource},
    capability::{CallResult, ContentBlock},
    event::Invocation,
    tool_call::ToolCallIdentity,
    tool_output::ToolOutput,
    tools::{PreparedEffect, ToolExecutor, ToolFuture, ToolJournal},
};
use maka_capabilities::call::Scope;
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult};
use maka_js_runtime::repl::Repl;
use std::time::Duration;
use uuid::Uuid;

impl Computer {
    pub(super) async fn evaluate(
        self: &Arc<Self>,
        name: &str,
        input: Value,
        call: Scope,
        basis: PermissionBasis,
        interaction: Arc<sessions::Interaction>,
        cancellation: CancellationToken,
    ) -> Result<ResultValue, ToolError> {
        let invocation = call.identity.agent().expect("checked invocation").clone();
        let mut repl = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(failed("Computer Use cancelled while queued")),
            repl = interaction.repl.lock() => repl,
        };
        if interaction.retiring.is_cancelled() {
            return Err(failed("Computer Session is retiring"));
        }
        let (current, language) = access::current(
            self,
            &call,
            if name == "reset" {
                "cua_reset"
            } else {
                "cua_repl"
            },
        )
        .await?;
        if current.permission_basis() != basis {
            return Err(failed("Computer Use permissions changed while queued"));
        }
        if name == "reset" {
            if let Some(runtime) = repl.take() {
                runtime
                    .close()
                    .await
                    .map_err(|e| ToolError::CleanupUnconfirmed(message(e)))?;
            }
            let mut native = interaction.native.lock().await;
            native.close().await?;
            *native = maka_computer_use::Session::new(self.sessions.driver.clone());
            return self
                .output(
                    &invocation,
                    &call,
                    vec![CellOutput::Text {
                        text: maka_computer_use::language::reset(language).into(),
                    }],
                    ReplState::Fresh,
                )
                .await;
        }
        access::granted(self, &call, basis).await?;
        let platform = {
            let mut native = interaction.native.lock().await;
            native.configure(
                self.configuration.desktop,
                self.configuration.browsers.clone(),
                language,
            )?;
            native.prepare(&cancellation, language).await?;
            native.platform()
        };
        let input: api::Evaluate = serde_json::from_value(input).map_err(failed)?;
        let limits = CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        };
        let context = tokio::task::spawn_blocking(|| {
            let store = maka_code_runtime::CellStore::temporary()?;
            CellContext::new(store, vec![])
        })
        .await
        .map_err(failed)?
        .map_err(|error| failed(error.message))?
        .with_image_deduplication();
        let runtime =
            repl.get_or_insert_with(|| Repl::new(maka_computer_use::facade_for(platform), limits));
        let bridge = Arc::new(Bridge {
            owner: self.clone(),
            call: call.clone(),
            native: interaction.native.clone(),
            basis,
            language,
        });
        let store = maka_agent_authority::permissions::execution(
            &self.store,
            &invocation,
            call.execution().map(|token| token.as_ref()),
        )?;
        let mut changes = store.subscribe_commits().map_err(failed)?;
        let monitor = async {
            loop {
                changes.borrow_and_update();
                access::granted(self, &call, basis).await?;
                changes.changed().await.map_err(failed)?;
            }
            #[allow(unreachable_code)]
            Ok::<(), ToolError>(())
        };
        let result = runtime.evaluate(
            input.code,
            bridge,
            cancellation.clone(),
            context.clone(),
            Duration::from_millis(input.timeout_ms),
        );
        tokio::pin!(result);
        let result = tokio::select! {
            result = &mut result => result,
            stopped = monitor => {
                cancellation.cancel();
                let settled = result.await;
                match settled {
                    Err(maka_code_runtime::CellAbort::Tool(error)) if !matches!(error, ToolError::Failed(_)) => return Err(partial(error, &context, runtime.is_closed(), language)),
                    _ => return Err(partial(stopped.err().unwrap_or_else(|| failed("Computer permission monitor closed")), &context, runtime.is_closed(), language)),
                }
            },
        };
        match result {
            Ok(CellResult::Failure { error, .. }) => {
                return Err(partial(
                    failed(match language {
                        Language::En => format!("Cua JavaScript error: {}", error.message),
                        Language::ZhCn => format!("Cua JavaScript 错误：{}", error.message),
                        Language::ZhTw => format!("Cua JavaScript 錯誤：{}", error.message),
                    }),
                    &context,
                    runtime.is_closed(),
                    language,
                ));
            }
            Err(maka_code_runtime::CellAbort::Tool(error)) => {
                return Err(partial(error, &context, runtime.is_closed(), language));
            }
            Err(error) => {
                return Err(partial(
                    failed(error),
                    &context,
                    runtime.is_closed(),
                    language,
                ));
            }
            Ok(_) => {}
        }
        self.output(
            &invocation,
            &call,
            context.take_output(),
            if runtime.is_closed() {
                ReplState::ResetRequired
            } else {
                ReplState::Ready
            },
        )
        .await
    }
    async fn output(
        &self,
        invocation: &Invocation,
        call: &Scope,
        output: Vec<CellOutput>,
        state: ReplState,
    ) -> Result<ResultValue, ToolError> {
        let bytes = serde_json::to_vec(&output).map_err(failed)?;
        let id = format!("computer-{}", Uuid::new_v4());
        let artifact = Artifact {
            id: id.clone(),
            session_id: invocation.session_id.clone(),
            turn_id: invocation.turn_id.clone(),
            created_at: maka_agent_authority::now(),
            name: "Computer Use output.json".into(),
            kind: ArtifactKind::File,
            size_bytes: bytes.len() as u64,
            mime_type: Some("application/json".into()),
            source: ArtifactSource::SessionEffect,
            summary: None,
        };
        maka_agent_authority::permissions::execution(
            &self.store,
            invocation,
            call.execution().map(|token| token.as_ref()),
        )?
        .commit_artifact(artifact, bytes)
        .await
        .map_err(|e| ToolError::Persistence(message(e)))?;
        Ok(ResultValue::Completed {
            artifact: id,
            state,
        })
    }
    async fn operation(
        self: &Arc<Self>,
        call: Scope,
        input: Value,
        native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
        basis: PermissionBasis,
        language: Language,
        cancellation: CancellationToken,
    ) -> Result<Value, ToolError> {
        let command: maka_computer_use::protocol::Command =
            serde_json::from_value(input.clone()).map_err(failed)?;
        let invocation = call.identity.agent().expect("checked invocation").clone();
        let device = tokio::select! { biased;
            () = cancellation.cancelled() => return Err(failed("Computer Use cancelled while queued")),
            device = self.sessions.input.clone().lock_owned() => device,
        };
        let mut native = tokio::select! { biased;
            () = cancellation.cancelled() => return Err(failed("Computer Use cancelled while queued")),
            native = native.lock_owned() => native,
        };
        access::granted(self, &call, basis).await?;
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before admission"));
        }
        let title = native.activity(&command);
        let session = invocation.session_id.clone();
        let effect = PreparedEffect::new(move |cancellation| {
            Box::pin(async move {
                let _device = device;
                let mut output = native
                    .invoke(command, &session, &cancellation, language)
                    .await?;
                let content = output
                    .as_object_mut()
                    .and_then(|object| object.remove("image"))
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(failed)?
                    .into_iter()
                    .collect();
                Ok(ToolOutput::Mcp(CallResult {
                    content,
                    structured_content: Some(output),
                })
                .into())
            })
        })
        .titled(title);
        let mut origin = self.origin.clone();
        if let ToolOrigin::HostSdk {
            parent_operation_id,
            ..
        } = &mut origin
        {
            *parent_operation_id = call.identity.operation_id().map(str::to_owned);
        }
        let result = ToolJournal::new(
            Arc::new(access::Journal {
                store: maka_agent_authority::permissions::execution(
                    &self.store,
                    &invocation,
                    call.execution().map(|token| token.as_ref()),
                )?,
                basis,
            }),
            invocation,
        )
        .invoke_prepared_output(
            Uuid::new_v4().to_string(),
            ToolCallIdentity {
                tool_call_id: Uuid::new_v4().to_string(),
                origin,
            },
            "cua_operation".into(),
            input,
            cancellation,
            effect,
        )
        .await;
        if matches!(
            result,
            Err(ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))
        ) {
            self.stopping.cancel();
        }
        match result? {
            ToolOutput::Mcp(result) => {
                let mut value = result.structured_content.unwrap_or(Value::Null);
                if let Some(image) = result
                    .content
                    .into_iter()
                    .find(|block| matches!(block, ContentBlock::Image { .. }))
                {
                    value["image"] = serde_json::to_value(image).map_err(failed)?;
                }
                Ok(value)
            }
            _ => Err(ToolError::CleanupUnconfirmed(
                "Computer output format changed".into(),
            )),
        }
    }
}
struct Bridge {
    owner: Arc<Computer>,
    call: Scope,
    native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    basis: PermissionBasis,
    language: Language,
}
impl ToolExecutor for Bridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let owner = self.owner.clone();
        let call = self.call.clone();
        let native = self.native.clone();
        let basis = self.basis;
        let language = self.language;
        Box::pin(async move {
            if name != "cua" {
                return Err(failed("Computer operation unavailable"));
            }
            owner
                .operation(call, input, native, basis, language, cancellation)
                .await
        })
    }
}
fn partial(error: ToolError, context: &CellContext, reset: bool, language: Language) -> ToolError {
    let mut observations = String::new();
    for output in context.take_output() {
        if let CellOutput::Text { text } = output {
            for c in text.chars().chain(std::iter::once('\n')) {
                if observations.len() + c.len_utf8() > 16 * 1024 {
                    break;
                }
                observations.push(c);
            }
        }
    }
    let mut suffix = String::new();
    if !observations.is_empty() {
        suffix += maka_computer_use::language::partial_observations(language);
        suffix += &observations;
    }
    if reset {
        suffix += maka_computer_use::language::closed(language);
    }
    match error {
        ToolError::Failed(value) => ToolError::Failed(value + &suffix),
        ToolError::Persistence(value) => ToolError::Persistence(value + &suffix),
        ToolError::CleanupUnconfirmed(value) => ToolError::CleanupUnconfirmed(value + &suffix),
        ToolError::OutcomeUnknown(value) => ToolError::OutcomeUnknown(value + &suffix),
        ToolError::Io { kind, message } => ToolError::Io {
            kind,
            message: message + &suffix,
        },
        error => error,
    }
}
