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
        let mut kernels = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(failed("Computer Use cancelled while queued")),
            kernels = interaction.kernel.lock() => kernels,
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
            self.retire_kernel(&interaction, &mut kernels).await?;
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
        if kernels
            .as_ref()
            .is_some_and(|kernel| kernel.repl.as_ref().is_some_and(Repl::is_closed))
        {
            self.retire_kernel(&interaction, &mut kernels).await?;
        }
        if kernels.is_none() {
            *kernels = Some(interaction.fresh_kernel()?);
        }
        let kernel = kernels.as_mut().expect("current Computer kernel");
        let epoch = kernel.epoch.clone();
        access::granted(self, &call, basis).await?;
        sessions::drain_ended_turns(self, &interaction, &invocation.session_id, language).await?;
        sessions::watch_turn(self, &interaction, &invocation, language).await?;
        let platform = {
            let mut native = epoch.native.lock().await;
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
        let admission = kernel.admission.clone();
        if kernel.repl.is_none() {
            let bootstrap = maka_computer_use::facade_for(platform, self.configuration.audio);
            let runtime =
                Repl::new_observed(bootstrap, limits, admission.clone()).map_err(failed)?;
            kernel.repl = Some(runtime);
        }
        let runtime = kernel.repl.as_ref().expect("REPL initialized");
        let bridge = Arc::new(Bridge {
            owner: self.clone(),
            call: call.clone(),
            epoch,
            admission,
            basis,
            language,
            cell: context.clone(),
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
        let (result, denied) = {
            let evaluation = runtime.evaluate(
                input.code,
                bridge,
                cancellation.clone(),
                context.clone(),
                Duration::from_millis(input.timeout_ms),
            );
            tokio::pin!(evaluation);
            tokio::select! {
                result = &mut evaluation => (result, None),
                stopped = monitor => {
                    cancellation.cancel();
                    (evaluation.await, Some(stopped.err().unwrap_or_else(|| failed("Computer permission monitor closed"))))
                },
            }
        };
        let closed = runtime.is_closed();
        if closed {
            // The old worker already confirmed durable admission before its
            // observer returned. Retain that exact worker in the task owner.
            self.retire_kernel(&interaction, &mut kernels).await?;
        }
        if let Some(reason) = denied {
            let error = match result {
                Err(maka_code_runtime::CellAbort::Tool(error))
                    if !matches!(error, ToolError::Failed(_)) =>
                {
                    error
                }
                _ => reason,
            };
            return Err(partial(error, &context, language));
        }
        match result {
            Ok(CellResult::Failure { error, .. }) => {
                return Err(partial(
                    failed(match language {
                        Language::En => format!("Cua JavaScript error: {}", error.message),
                        Language::ZhCn => format!("Cua JavaScript 错误：{}", error.message),
                        Language::ZhTw => format!("Cua JavaScript 錯誤：{}", error.message),
                    }),
                    &context,
                    language,
                ));
            }
            Err(maka_code_runtime::CellAbort::Tool(error)) => {
                return Err(partial(error, &context, language));
            }
            Err(error) => {
                return Err(partial(failed(error), &context, language));
            }
            Ok(_) => {}
        }
        self.output(
            &invocation,
            &call,
            context.take_output(),
            if closed {
                ReplState::Fresh
            } else {
                ReplState::Ready
            },
        )
        .await
    }
    async fn retire_kernel(
        self: &Arc<Self>,
        interaction: &Arc<sessions::Interaction>,
        current: &mut Option<sessions::Kernel>,
    ) -> Result<(), ToolError> {
        let Some(kernel) = current.take() else {
            return Ok(());
        };
        let admission = kernel.admission.clone();
        if let Err((error, kernel)) = interaction.retire_kernel(self, kernel) {
            *current = Some(kernel);
            return Err(error);
        }
        admission.seal().await
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
        bridge: &Bridge,
        input: Value,
        cancellation: CancellationToken,
        receipt: admission::Receipt,
    ) -> Result<Value, ToolError> {
        let call = bridge.call.clone();
        let basis = bridge.basis;
        let language = bridge.language;
        let cell = bridge.cell.clone();
        let epoch = bridge.epoch.clone();
        let mut command: maka_computer_use::protocol::Command =
            serde_json::from_value(input.clone()).map_err(failed)?;
        let native = epoch.native.clone();
        let invocation = call.identity.agent().expect("checked invocation").clone();
        let operation_id = Uuid::new_v4().to_string();
        access::granted(self, &call, basis).await?;
        let audio_operation = matches!(
            command,
            maka_computer_use::protocol::Command::StartAudioRecording { .. }
                | maka_computer_use::protocol::Command::StopAudioRecording
        );
        let starts_audio = matches!(
            command,
            maka_computer_use::protocol::Command::StartAudioRecording { .. }
        );
        let stops_audio = matches!(
            command,
            maka_computer_use::protocol::Command::StopAudioRecording
        );
        if audio_operation && !self.configuration.audio {
            return Err(failed(
                "Computer audio recording is disabled in Host configuration",
            ));
        }
        let audio_consent = if audio_operation {
            audio_consent(&native, &cancellation).await?
        } else {
            false
        };
        let mut targets = vec![api::target()];
        if audio_consent {
            if matches!(
                command,
                maka_computer_use::protocol::Command::StartAudioRecording { .. }
            ) {
                let (configuration, _) = access::current(self, &call, "cua_repl").await?;
                if configuration.permission_basis() != basis {
                    return Err(failed("Computer Use permission boundary changed"));
                }
                access::approve_audio(self, &call, &configuration, &cancellation, &cell).await?;
            } else {
                access::audio_granted(self, &call, basis).await?;
            }
            targets.push(api::audio_target());
        }
        let subject = {
            let mut desktop = tokio::select! { biased;
                () = cancellation.cancelled() => return Err(failed("Computer Use cancelled before app resolution")),
                desktop = native.lock() => desktop,
            };
            desktop
                .permission_subject(&command, &invocation.session_id, &cancellation, language)
                .await?
        };
        if let Some(subject) = &subject
            && let maka_computer_use::protocol::Command::GetApp {
                target: maka_computer_use::protocol::AppReference::Name(name),
            } = &mut command
        {
            // Freeze the OS-resolved bundle path across consent. The original
            // name cannot be resolved to a different app after approval.
            *name = subject.display.app_path.clone();
        }
        let app = if let Some(subject) = &subject {
            let target = app_access::approve(
                self,
                &call,
                basis,
                subject,
                &operation_id,
                &cancellation,
                &cell,
            )
            .await?;
            Some((target, subject.display.clone()))
        } else {
            None
        };
        let device = if browser_command(&command)
            || matches!(
                command,
                maka_computer_use::protocol::Command::ListWindows { .. }
                    | maka_computer_use::protocol::Command::Documentation
            ) {
            None
        } else {
            Some(tokio::select! { biased;
                () = cancellation.cancelled() => return Err(failed("Computer Use cancelled while queued")),
                device = self.sessions.input.clone().lock_owned() => device,
            })
        };
        let mut native = tokio::select! { biased;
            () = cancellation.cancelled() => return Err(failed("Computer Use cancelled while queued")),
            native = native.lock_owned() => native,
        };
        access::granted(self, &call, basis).await?;
        let current_subject = native
            .permission_subject(&command, &invocation.session_id, &cancellation, language)
            .await?;
        let same_subject = match (&subject, &current_subject) {
            (None, None) => true,
            (Some(expected), Some(current)) => expected.matches_resolved(current),
            _ => false,
        };
        if !same_subject {
            return Err(failed(
                "Computer Use app changed while access was being approved",
            ));
        }
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before admission"));
        }
        // Keep mutation ordering through the canonical outcome. On a journal
        // failure, close Host admission before another input waiter proceeds.
        let _device = device;
        let title = native.activity(&command);
        let pause_native =
            matches!(native.platform(), "mac" | "windows") && !browser_command(&command);
        let session = invocation.session_id.clone();
        let turn = invocation.turn_id.clone();
        let browser_access = browser_access::Access::new(
            self.clone(),
            call.clone(),
            basis,
            cell.clone(),
            cancellation.clone(),
            bridge.admission.clone(),
        );
        let lease = self
            .store
            .fork_invocation_effect(
                call.execution()
                    .ok_or_else(|| failed("Computer execution custody is missing"))?
                    .as_ref(),
                &invocation,
            )
            .map_err(|error| ToolError::Persistence(message(error)))?;
        let (lease, effect_call) = lease.into_scope(&call)?;
        let effect_owner = self.clone();
        let effect_store = lease.store();
        let journal_store = effect_store.clone();
        let settlement = admission::Operation::new(self, lease)?;
        let operation_settlement = settlement.handoff();
        let host_effects = admission::host_effects(self, bridge.admission.clone());
        let effect_targets = targets.clone();
        let effect_invocation = invocation.clone();
        let effect_app = app.clone();
        let admitted = receipt.clone();
        let effect = PreparedEffect::new(move |_producer_cancellation| {
            Box::pin(async move {
                let mut output = access::settle(
                    &effect_owner,
                    &effect_call,
                    basis,
                    &effect_targets,
                    move |operation_cancel| async move {
                        app_access::settle(
                            &effect_store,
                            &effect_invocation,
                            effect_app.as_ref(),
                            operation_cancel,
                            move |operation_cancel| async move {
                                let mut context =
                                    maka_computer_use::InvocationContext::new(&session, &turn)
                                        .with_browser_authorization(browser_access)
                                        .with_operation_settlement(operation_settlement)
                                        .with_browser_host_effects(host_effects);
                                if let Some(subject) = subject {
                                    context = context.with_app_target(subject);
                                }
                                let _timeout = pause_native.then(|| cell.suspend_timeout());
                                let result = native
                                    .invoke(command, &context, &operation_cancel, language)
                                    .await?;
                                if starts_audio {
                                    epoch.record_audio(basis, audio_consent);
                                } else if stops_audio {
                                    epoch.clear_audio();
                                }
                                Ok(result)
                            },
                        )
                        .await
                    },
                )
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
        .titled(title)
        .on_admission(move |boundary| {
            if matches!(
                boundary,
                maka_agent_facts::tools::EffectAdmission::Durable { .. }
            ) {
                admitted.agent_dispatched();
            }
        });
        let mut origin = self.origin.clone();
        if let ToolOrigin::HostSdk { parent, .. } = &mut origin {
            *parent = call.identity.operation_id().map(|operation_id| {
                maka_agent_facts::tool_call::HostSdkParent::EvaluationObserver {
                    operation_id: operation_id.into(),
                    epoch: bridge.epoch.id.clone(),
                }
            });
        }
        let result = ToolJournal::new(
            Arc::new(access::Journal {
                store: journal_store,
                basis,
                targets,
                app,
            }),
            invocation,
        )
        .invoke_prepared_output(
            operation_id,
            ToolCallIdentity {
                tool_call_id: Uuid::new_v4().to_string(),
                origin,
            },
            "cua_operation".into(),
            input,
            None,
            cancellation,
            effect,
        )
        .await;
        let journal_failure = if let Err(
            error @ (ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OperationCleanupUnconfirmed { .. }),
        ) = &result
        {
            receipt.fail(error.clone());
            self.stopping.cancel();
            Some(message(error))
        } else {
            None
        };
        settlement.complete(journal_failure);
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
#[derive(Clone)]
struct Bridge {
    owner: Arc<Computer>,
    call: Scope,
    epoch: Arc<sessions::Epoch>,
    admission: Arc<admission::Gate>,
    basis: PermissionBasis,
    language: Language,
    cell: CellContext,
}

async fn audio_consent(
    native: &Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    cancellation: &CancellationToken,
) -> Result<bool, ToolError> {
    let native = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(failed("Computer audio cancelled before admission")),
        native = native.lock() => native,
    };
    Ok(native.platform() == "mac")
}

fn browser_command(command: &maka_computer_use::protocol::Command) -> bool {
    use maka_computer_use::protocol::{Command, Handle};
    matches!(
        command,
        Command::ListBrowsers { .. }
            | Command::GetJsDialog { .. }
            | Command::HandleJsDialog { .. }
            | Command::ListTabs { .. }
            | Command::GetBrowser { .. }
            | Command::BrowserTab { .. }
            | Command::BrowserRead { .. }
            | Command::BrowserMutation {
                handle: Handle::Tab(_),
                ..
            }
            | Command::ClipboardRead {
                handle: Handle::Tab(_)
            }
            | Command::ClipboardReadText {
                handle: Handle::Tab(_)
            }
            | Command::ClipboardWrite {
                handle: Handle::Tab(_),
                ..
            }
            | Command::ClipboardWriteText {
                handle: Handle::Tab(_),
                ..
            }
            | Command::TabMetadata { .. }
            | Command::GetTab { .. }
            | Command::CreateBrowserTab { .. }
            | Command::Observe {
                handle: Handle::Tab(_),
                ..
            }
            | Command::Action {
                handle: Handle::Tab(_),
                ..
            }
    )
}
impl ToolExecutor for Bridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        // Register before returning the future: an unscheduled old VM task can
        // never acquire admission after reset has sealed its producer.
        let receipt = self.admission.register();
        let bridge = self.clone();
        Box::pin(async move {
            let receipt = receipt?;
            if name != "cua" {
                receipt.complete_call();
                return Err(failed("Computer operation unavailable"));
            }
            let result = bridge
                .owner
                .operation(&bridge, input, cancellation, receipt.clone())
                .await;
            match &result {
                Err(
                    error @ (ToolError::Persistence(_)
                    | ToolError::CleanupUnconfirmed(_)
                    | ToolError::OperationCleanupUnconfirmed { .. }),
                ) => {
                    receipt.fail(error.clone());
                    bridge.owner.stopping.cancel();
                }
                _ => receipt.complete_call(),
            }
            result
        })
    }
}
fn partial(error: ToolError, context: &CellContext, language: Language) -> ToolError {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clipboard_and_locator_commands_retain_the_exact_browser_owner() {
        for handle in [
            json!({"kind":"tab","id":"owned"}),
            json!({"kind":"app","id":"owned"}),
        ] {
            for payload in [
                json!({"method":"clipboardRead","handle":handle}),
                json!({"method":"clipboardReadText","handle":handle}),
                json!({"method":"clipboardWriteText","handle":handle,"text":"fixture"}),
                json!({"method":"clipboardWrite","handle":handle,"items":[{"entries":[{"mimeType":"text/plain","text":"fixture"}]}]}),
                json!({"method":"browserMutation","handle":handle,"locator":{"selector":"button"},"operation":{"kind":"click"}}),
            ] {
                let command =
                    serde_json::from_value(payload.clone()).expect("public Computer Use command");
                assert_eq!(
                    browser_command(&command),
                    handle["kind"] == "tab",
                    "{payload}"
                );
            }
        }
    }

    struct QueuedAudio {
        native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
        admission: Arc<admission::Gate>,
        started: CancellationToken,
    }
    impl ToolExecutor for QueuedAudio {
        fn names(&self) -> Vec<String> {
            vec!["queued_audio".into()]
        }
        fn invoke(&self, _: String, _: Value, cancellation: CancellationToken) -> ToolFuture {
            let receipt = self.admission.register();
            let native = self.native.clone();
            self.started.cancel();
            Box::pin(async move {
                let receipt = receipt?;
                let result = audio_consent(&native, &cancellation).await;
                receipt.complete_call();
                result.map(Value::Bool)
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn vm_timeout_rejects_audio_queued_behind_an_accepted_native_operation() {
        let native = Arc::new(tokio::sync::Mutex::new(maka_computer_use::Session::new(
            Arc::new(tokio::sync::Mutex::new(maka_computer_use::Driver::default())),
        )));
        let accepted_native = native.clone().lock_owned().await;
        let admission = Arc::new(admission::Gate::default());
        let started = CancellationToken::new();
        let runtime = Repl::new_observed(
            "Object.defineProperty(globalThis,'audio',{value:()=>call('queued_audio',{})});",
            CellLimits::default(),
            admission.clone(),
        )
        .unwrap();
        let context =
            CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            runtime.evaluate(
                "await audio()".into(),
                Arc::new(QueuedAudio {
                    native,
                    admission,
                    started: started.clone(),
                }),
                CancellationToken::new(),
                context,
                Duration::from_millis(100),
            ),
        )
        .await
        .expect("VM admission must not wait for the old native operation")
        .unwrap();
        assert!(started.is_cancelled());
        assert!(matches!(result, CellResult::Failure { .. }));
        runtime.close().await.unwrap();
        // The accepted native operation has deliberately not released its lock.
        drop(accepted_native);
    }
}
