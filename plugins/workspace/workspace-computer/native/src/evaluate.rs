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

#[derive(Debug)]
enum OperationFailure {
    Ordinary(ToolError),
    // Constructed by operation only after its exact sealed physical drain proof.
    // The original action's journal remains Unknown.
    DrainedNativeUnknown(ToolError),
}
impl From<ToolError> for OperationFailure {
    fn from(error: ToolError) -> Self {
        Self::Ordinary(error)
    }
}

#[cfg(test)]
type OperationFixture = Arc<
    dyn Fn(
            Value,
            CancellationToken,
            admission::Receipt,
        ) -> BoxFuture<'static, Result<Value, OperationFailure>>
        + Send
        + Sync,
>;

/// The production caller carries the original Host budget capability. Direct
/// product fixtures retain their old Scope, and cannot claim upload support.
pub(super) struct EvaluationScope {
    call: Scope,
    input_resources: Option<maka_host_runtime::application::ResourceCapturer>,
}
impl From<maka_host_runtime::application::ResourceCapturer> for EvaluationScope {
    fn from(resources: maka_host_runtime::application::ResourceCapturer) -> Self {
        Self {
            call: resources.scope().clone(),
            input_resources: Some(resources),
        }
    }
}
#[cfg(test)]
impl From<Scope> for EvaluationScope {
    fn from(call: Scope) -> Self {
        Self {
            call,
            input_resources: None,
        }
    }
}

impl Computer {
    pub(super) async fn evaluate(
        self: &Arc<Self>,
        name: &str,
        input: Value,
        evaluation: EvaluationScope,
        basis: PermissionBasis,
        interaction: Arc<sessions::Interaction>,
        cancellation: CancellationToken,
    ) -> Result<ResultValue, ToolError> {
        let EvaluationScope {
            call,
            input_resources,
        } = evaluation;
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
            interaction: interaction.clone(),
            epoch,
            admission,
            basis,
            language,
            cell: context.clone(),
            #[cfg(test)]
            operation_fixture: None,
            input_resources,
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
    ) -> Result<Value, OperationFailure> {
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
            return Err(
                failed("Computer audio recording is disabled in Host configuration").into(),
            );
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
                    return Err(failed("Computer Use permission boundary changed").into());
                }
                access::approve_audio(self, &call, &configuration, &cancellation, &cell).await?;
            } else {
                access::audio_granted(self, &call, basis).await?;
            }
            targets.push(api::audio_target());
        }
        let subject = {
            let mut desktop = tokio::select! { biased;
                () = cancellation.cancelled() => return Err(failed("Computer Use cancelled before app resolution").into()),
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
                () = cancellation.cancelled() => return Err(failed("Computer Use cancelled while queued").into()),
                device = self.sessions.input.clone().lock_owned() => device,
            })
        };
        let mut native = tokio::select! { biased;
            () = cancellation.cancelled() => return Err(failed("Computer Use cancelled while queued").into()),
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
            return Err(failed("Computer Use app changed while access was being approved").into());
        }
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before admission").into());
        }
        // Keep mutation ordering through the canonical outcome. On a journal
        // failure, close Host admission before another input waiter proceeds.
        let _device = device;
        let lane = if native.platform() == "windows" && native_helper_command(&command) {
            access::ComputerLane::Native
        } else {
            access::ComputerLane::Other
        };
        let title = native.activity(&command);
        let pause_native =
            matches!(native.platform(), "mac" | "windows") && !browser_command(&command);
        let session = invocation.session_id.clone();
        let turn = invocation.turn_id.clone();
        let monitor_enabled = native.platform() == "mac";
        let monitor_owner = self.clone();
        let monitor_gate = bridge.admission.clone();
        let monitor_operation = operation_id.clone();
        let preparation_active = CancellationToken::new();
        let browser_access = browser_access::Access::new(
            self.clone(),
            call.clone(),
            basis,
            cell.clone(),
            cancellation.clone(),
            bridge.admission.clone(),
            browser_access::PreparationScope {
                epoch: bridge.epoch.clone(),
                operation: operation_id.clone(),
                active: preparation_active.clone(),
                input_resources: bridge.input_resources.clone(),
            },
        );
        let native_interruption = sessions::native_interruption_observer(
            self,
            &bridge.interaction,
            &invocation,
            &bridge.epoch,
            &operation_id,
        )?;
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
        let settlement = admission::Operation::new(self, lease, &bridge.epoch.native)?;
        let operation_settlement = settlement.handoff();
        let host_effects = admission::host_effects_with_lease_children(
            self,
            bridge.admission.clone(),
            &bridge.epoch.native,
            browser_access.popup_attachment(),
        );
        let effect_targets = targets.clone();
        let effect_invocation = invocation.clone();
        let browser_operation_id = operation_id.clone();
        let preparation_policy = maka_computer_use::BrowserPreparationPolicy {
            popup_enabled: self.configuration.browser_preparation.popup,
            headers: self
                .configuration
                .browser_preparation
                .request_headers
                .iter()
                .map(|header| maka_computer_use::BrowserPreparationHeader {
                    name: header.name.clone(),
                    value: header.value.clone(),
                })
                .collect(),
        };
        let browser_files = epoch.files.clone();
        let effect_app = app.clone();
        let native_receipt = native_interruption.clone();
        let admitted = receipt.clone();
        let effect = PreparedEffect::new(move |_producer_cancellation| {
            Box::pin(async move {
                // This owner is inside the actual admitted future. Keeping an
                // authorization Arc after Ready/drop does not keep it active.
                let _preparation_lifetime = preparation_active.drop_guard();
                let mut output = access::settle(
                    &effect_owner,
                    &effect_call,
                    basis,
                    &effect_targets,
                    move |operation_cancel| async move {
                        let monitor_invocation = effect_invocation.clone();
                        app_access::settle(
                            &effect_store,
                            &effect_invocation,
                            effect_app.as_ref(),
                            operation_cancel,
                            move |operation_cancel| async move {
                                let mut context =
                                    maka_computer_use::InvocationContext::new(&session, &turn)
                                        .with_operation_id(browser_operation_id)
                                        .with_browser_authorization(browser_access)
                                        .with_native_interruption_observer(native_interruption)
                                        .with_browser_asset_files(browser_files)
                                        .with_browser_preparation_policy(preparation_policy)
                                        .with_operation_settlement(operation_settlement)
                                        .with_browser_host_effects(host_effects);
                                if let Some(subject) = subject {
                                    if monitor_enabled {
                                        context = context.with_native_monitor_authority(
                                            epoch.native_monitor_authority(
                                                &monitor_owner,
                                                monitor_gate,
                                                monitor_invocation,
                                                monitor_operation,
                                                basis,
                                                subject.clone(),
                                            )?,
                                        );
                                    }
                                    context = context.with_app_target(subject);
                                }
                                let _timeout = pause_native.then(|| cell.suspend_timeout());
                                let completion = native
                                    .prepare_invoke(command, &context, &operation_cancel, language)
                                    .await?;
                                if completion.is_pending() {
                                    drop(native);
                                    return completion.wait().await;
                                }
                                // Immediate operations, including audio receipt
                                // publication, keep the original Session lock.
                                let result = completion.wait().await?;
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
                lane,
                store: journal_store,
                basis,
                targets,
                app,
            }),
            invocation.clone(),
        )
        .invoke_prepared_output(
            operation_id.clone(),
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
        let native_drain = if matches!(lane, access::ComputerLane::Native)
            && matches!(
                &result,
                Err(ToolError::OutcomeUnknown(_) | ToolError::OperationUnknown { .. })
            ) {
            match native_receipt.native_drain().await {
                Ok(proof) => proof,
                Err(error) => {
                    // The original action T2 is already Unknown. Failure of
                    // its canonical fence remains a Host persistence/cleanup
                    // failure; a physical drain must not wash that failure.
                    receipt.fail(error.clone());
                    self.stopping.cancel();
                    settlement.complete(Some(error.clone()));
                    return Err(error.into());
                }
            }
        } else {
            None
        };
        let drained_native_unknown = native_drain.is_some();
        let journal_failure = if !drained_native_unknown
            && let Err(
                error @ (ToolError::Persistence(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::OutcomeUnknown(_)
                | ToolError::OperationUnknown { .. }
                | ToolError::OperationCleanupUnconfirmed { .. }),
            ) = &result
        {
            receipt.fail(error.clone());
            self.stopping.cancel();
            Some(error.clone())
        } else {
            None
        };
        settlement.complete(journal_failure);
        let result = match result {
            Err(error) if drained_native_unknown => {
                return Err(OperationFailure::DrainedNativeUnknown(error));
            }
            other => other,
        };
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
            _ => Err(ToolError::CleanupUnconfirmed("Computer output format changed".into()).into()),
        }
    }
}
#[derive(Clone)]
struct Bridge {
    #[cfg(test)]
    operation_fixture: Option<OperationFixture>,
    owner: Arc<Computer>,
    call: Scope,
    interaction: Arc<sessions::Interaction>,
    epoch: Arc<sessions::Epoch>,
    admission: Arc<admission::Gate>,
    basis: PermissionBasis,
    language: Language,
    cell: CellContext,
    input_resources: Option<maka_host_runtime::application::ResourceCapturer>,
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

// Actual helper callers, rather than every desktop-looking command. Cursor
// presentation/documentation do not call the Windows native SDK child.
fn native_helper_command(command: &maka_computer_use::protocol::Command) -> bool {
    use maka_computer_use::protocol::{Command, Handle};
    matches!(
        command,
        Command::NativeComputer { .. }
            | Command::StartAudioRecording { .. }
            | Command::StopAudioRecording
            | Command::GetState { .. }
            | Command::ListApps { .. }
            | Command::ListWindows { .. }
            | Command::GetApp { .. }
            | Command::LaunchApp { .. }
            | Command::Observe {
                handle: Handle::App(_),
                ..
            }
            | Command::Action {
                handle: Handle::App(_),
                ..
            }
    )
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
            | Command::BrowserManagedTabs { .. }
            | Command::BrowserSelect { .. }
            | Command::BrowserSelectedTab { .. }
            | Command::BrowserNameSession { .. }
            | Command::BrowserHistory { .. }
            | Command::BrowserViewportSet { .. }
            | Command::BrowserViewportReset { .. }
            | Command::TabPageAssetsList { .. }
            | Command::TabPageAssetsBundle { .. }
            | Command::BrowserUserOpenTabs { .. }
            | Command::BrowserUserGetTabContext { .. }
            | Command::BrowserUserClaimTab { .. }
            | Command::BrowserMarkTab { .. }
            | Command::BrowserScreenshot { .. }
            | Command::BrowserEvaluate { .. }
            | Command::BrowserRead { .. }
            | Command::BrowserCua {
                handle: Handle::Tab(_),
                ..
            }
            | Command::BrowserWait { .. }
            | Command::BrowserFileChooserWait { .. }
            | Command::BrowserFileChooserSetFiles { .. }
            | Command::BrowserDownloadWait { .. }
            | Command::BrowserDownloadPath { .. }
            | Command::BrowserDownloadMedia { .. }
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
            #[cfg(test)]
            let result = match &bridge.operation_fixture {
                Some(operation) => operation(input, cancellation, receipt.clone()).await,
                None => {
                    bridge
                        .owner
                        .operation(&bridge, input, cancellation, receipt.clone())
                        .await
                }
            };
            #[cfg(not(test))]
            let result = bridge
                .owner
                .operation(&bridge, input, cancellation, receipt.clone())
                .await;
            match result {
                Err(OperationFailure::DrainedNativeUnknown(error)) => {
                    receipt.complete_call();
                    Err(error)
                }
                Err(OperationFailure::Ordinary(error)) => {
                    if matches!(
                        &error,
                        ToolError::Persistence(_)
                            | ToolError::CleanupUnconfirmed(_)
                            | ToolError::OutcomeUnknown(_)
                            | ToolError::OperationUnknown { .. }
                            | ToolError::OperationCleanupUnconfirmed { .. }
                    ) {
                        receipt.fail(error.clone());
                        bridge.owner.stopping.cancel();
                    } else {
                        receipt.complete_call();
                    }
                    Err(error)
                }
                Ok(value) => {
                    receipt.complete_call();
                    Ok(value)
                }
            }
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_bridge_keeps_browser_live_only_for_the_typed_post_drain_native_unknown() {
        use futures_util::FutureExt;
        use maka_agent_facts::{
            event::{EventWrite, Fact, InvocationInput, RuntimeEvent, ToolOutcome},
            interaction::{Decision, InteractionOutcome, InteractionRecord, InteractionRequest},
            tool_call::{HostSdkParent, ToolCallIdentity, ToolOrigin},
            workspace::BindingStamp,
        };
        use maka_capabilities::call::{Identity, Issuer};
        use maka_code_runtime::CellAbort;
        use maka_event_log::root::{RootNamespaces, RootOwner};
        // This cfg(test)-only operation fixture represents the Host boundary
        // AFTER the sealed native drain check. It never constructs a public
        // native proof or claims a physical Escape/Windows/Chrome execution.
        // Journal, SQL, real Bridge::invoke, Gate and V8 are the product paths.
        #[derive(Clone, Copy, Debug)]
        enum Writer {
            Confirmed,
            Failed,
            Missing,
        }
        for (post_drain, writer) in [
            (true, Writer::Confirmed),
            (false, Writer::Confirmed),
            (true, Writer::Failed),
            (true, Writer::Missing),
        ] {
            let eligible = post_drain && matches!(writer, Writer::Confirmed);
            let directory = tempfile::tempdir().unwrap();
            let root = Arc::new(
                maka_event_log::RootStore::open(Arc::new(
                    RootOwner::create(
                        &directory.path().join("root"),
                        &RootNamespaces {
                            ownership: directory.path().join("ownership"),
                            control: directory.path().join("control"),
                        },
                    )
                    .unwrap(),
                ))
                .await
                .unwrap(),
            );
            let binding = root
                .attach_workspace("fixture", &json!({"path":"/workspace"}))
                .await
                .unwrap();
            let store = root
                .create_session(
                    "session",
                    "create",
                    &json!({"workspace":binding,"boundary_revision":0}),
                    1,
                )
                .await
                .unwrap();
            let invocation = Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            };
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::InvocationOpened {
                            configuration: None,
                            input: InvocationInput::Message {
                                content: "fixture".into(),
                                source_messages: vec![],
                                request_fingerprint: None,
                            },
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
            let basis = PermissionBasis {
                boundary_revision: 0,
                binding: BindingStamp {
                    id: binding.id,
                    permission_epoch: binding.permission_epoch_at_attach,
                },
            };
            store
                .establish_run_interaction(
                    &invocation,
                    &InteractionRecord {
                        session_id: "session".into(),
                        turn_id: "turn".into(),
                        run_id: "run".into(),
                        request_id: "grant".into(),
                        created_at: 2,
                        outcome: None,
                        request: InteractionRequest::ClientCapability {
                            tool_use_id: "outer".into(),
                            target: api::target(),
                            basis: Some(basis),
                        },
                    },
                )
                .await
                .unwrap();
            store
                .commit_interaction_outcome(
                    "grant",
                    InteractionOutcome::ClientCapabilityDecision {
                        decision: Decision::Allow,
                        committed_at: 3,
                    },
                )
                .await
                .unwrap();
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::ToolDispatched {
                            presentation: None,
                            title: None,
                            operation_id: "outer".into(),
                            call: ToolCallIdentity::standalone("outer-call".into()),
                            name: "cua_repl".into(),
                            input: json!({}),
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
            let tasks = tokio_util::task::TaskTracker::new();
            let owner = Arc::new(Computer {
                store: root.clone(),
                configuration: Default::default(),
                sessions: sessions::Sessions::with_audio(false, tasks.clone()),
                resources: Arc::default(),
                stopping: CancellationToken::new(),
                tasks,
                origin: ToolOrigin::HostSdk {
                    package_id: "fixture".into(),
                    entry_id: "computer".into(),
                    activation: "host".into(),
                    parent: None,
                },
                popup_provenance: None,
            });
            let interaction = owner.sessions.get("session").unwrap();
            let kernel = interaction.fresh_kernel().unwrap();
            let epoch = kernel.epoch.clone();
            let admission = kernel.admission.clone();
            let scope = Issuer::default()
                .issue(
                    Identity::Agent {
                        invocation: invocation.clone(),
                        operation_id: Some("outer".into()),
                    },
                    CancellationToken::new(),
                )
                .unwrap();
            let weak = Arc::downgrade(&owner);
            let operation_store = store.clone();
            let operation_invocation = invocation.clone();
            let operation_epoch = epoch.id.clone();
            let fixture: OperationFixture = Arc::new(move |input, cancellation, receipt| {
                let weak = weak.clone();
                let store = operation_store.clone();
                let invocation = operation_invocation.clone();
                let epoch = operation_epoch.clone();
                Box::pin(async move {
                    let computer = weak
                        .upgrade()
                        .ok_or_else(|| failed("fixture Host closed"))?;
                    if computer.stopping.is_cancelled() {
                        return Err(failed("fixture observes product Computer Host stop").into());
                    }
                    let command: maka_computer_use::protocol::Command =
                        serde_json::from_value(input.clone()).map_err(failed)?;
                    let native = matches!(
                        command,
                        maka_computer_use::protocol::Command::ListWindows { .. }
                    );
                    let operation = if native { "native" } else { "browser" };
                    let sink = Arc::new(access::Journal {
                        lane: if native {
                            access::ComputerLane::Native
                        } else {
                            access::ComputerLane::Other
                        },
                        store: store.clone(),
                        basis,
                        targets: vec![api::target()],
                        app: None,
                    });
                    let admitted = receipt.clone();
                    let result = ToolJournal::new(sink, invocation.clone())
                        .invoke_prepared_output(
                            operation.into(),
                            ToolCallIdentity {
                                tool_call_id: format!("call-{operation}"),
                                origin: ToolOrigin::HostSdk {
                                    package_id: "fixture".into(),
                                    entry_id: "computer".into(),
                                    activation: "host".into(),
                                    parent: Some(HostSdkParent::EvaluationObserver {
                                        operation_id: "outer".into(),
                                        epoch: epoch.clone(),
                                    }),
                                },
                            },
                            "cua_operation".into(),
                            input,
                            None,
                            cancellation,
                            PreparedEffect::new(move |_| {
                                Box::pin(async move {
                                    if native {
                                        Err(ToolError::OutcomeUnknown(
                                            "accepted native action remains unknown".into(),
                                        ))
                                    } else {
                                        Ok(ToolOutput::Json(json!("browser-still-live")).into())
                                    }
                                })
                            })
                            .on_admission(move |boundary| {
                                if matches!(
                                    boundary,
                                    maka_agent_facts::tools::EffectAdmission::Durable { .. }
                                ) {
                                    admitted.agent_dispatched();
                                }
                            }),
                        )
                        .await;
                    match result {
                        Err(error @ ToolError::OutcomeUnknown(_)) if post_drain => {
                            let write = if matches!(writer, Writer::Missing) {
                                None
                            } else {
                                Some(async move {
                                    store.record_native_turn_interruption(
                                        maka_event_log::native_computer::NativeInterruption {
                                            opening: invocation,
                                            operation_id: "native".into(),
                                            // The negative case reaches the real SQL
                                            // source/T1 identity check, which refuses
                                            // to record an unbound native epoch.
                                            native_epoch: if matches!(writer, Writer::Failed) {
                                                "not-the-actual-T1-epoch".into()
                                            } else {
                                                epoch
                                            },
                                            native_generation: "synthetic-host-boundary-only".into(),
                                        },
                                    ).await.map(|_| ()).map_err(|error| ToolError::Persistence(message(error)))
                                }.boxed().shared())
                            };
                            // The production post-proof eligibility helper must
                            // observe this same original SQL future, including
                            // failures. No new native proof is minted here.
                            let confirmed = sessions::confirm_native_interruption(write).await;
                            match writer {
                                Writer::Confirmed => assert!(confirmed.is_ok()),
                                Writer::Failed => {
                                    assert!(matches!(&confirmed, Err(ToolError::Persistence(_))))
                                }
                                Writer::Missing => assert!(matches!(
                                    &confirmed,
                                    Err(ToolError::CleanupUnconfirmed(_))
                                )),
                            }
                            confirmed?;
                            Err(OperationFailure::DrainedNativeUnknown(error))
                        }
                        Err(error) => Err(error.into()),
                        Ok(output) => Ok(output.into_json()),
                    }
                })
            });
            let context =
                CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![])
                    .unwrap();
            let bridge = Arc::new(Bridge {
                owner: owner.clone(),
                call: scope,
                interaction: interaction.clone(),
                epoch: epoch.clone(),
                admission: admission.clone(),
                basis,
                language: Language::En,
                cell: context.clone(),
                operation_fixture: Some(fixture),
                input_resources: None,
            });
            let bootstrap = format!(
                "{}\nglobalThis.native=()=>invoke('listWindows',{{options:{{}}}});globalThis.browser=()=>invoke('listBrowsers',{{options:{{}}}});",
                maka_computer_use::facade()
            );
            let runtime = Repl::new(bootstrap, CellLimits::default()).unwrap();
            let result=runtime.evaluate("let caught=false;try{await native()}catch(e){caught=true}nodeRepl.write({caught,browser:await browser()});".into(),
                bridge.clone(),CancellationToken::new(),context.clone(),Duration::from_secs(3)).await;
            if eligible {
                assert!(
                    matches!(&result, Ok(CellResult::Success { .. })),
                    "{result:?}"
                );
                assert!(
                    !owner.stopping.is_cancelled(),
                    "actual Bridge must not cancel the Computer after exact drained native Unknown"
                );
                assert!(admission.check_open().is_ok());
                assert!(!runtime.is_closed(), "same JS kernel remains available");
                let output = context.take_output();
                let [CellOutput::Text { text }] = output.as_slice() else {
                    panic!(
                        "the recovered native call and live browser must emit one JSON result: {output:?}"
                    );
                };
                let value: Value = serde_json::from_str(text).unwrap_or_else(|error| {
                    panic!("invalid emitted bridge result: {error}; output={output:?}")
                });
                assert_eq!(
                    value,
                    json!({"caught":true,"browser":"browser-still-live"}),
                    "the facade must throw the native failure and unwrap the live browser result: {output:?}"
                );
                let tip = store
                    .run_source("session", "run", None)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    matches!(tip.last.event.fact,Fact::ToolSettled{ref operation_id,..} if operation_id=="browser"),
                    "following browser has its real canonical T2"
                );
            } else {
                match (post_drain, writer, &result) {
                    (false, Writer::Confirmed, Ok(CellResult::Failure { .. })) => {}
                    (
                        true,
                        Writer::Failed,
                        Err(CellAbort::Tool(ToolError::Persistence(message))),
                    ) => {
                        assert!(
                            message.contains(
                                "native interruption differs from its original dispatch binding"
                            ),
                            "the rejected fence must preserve its original binding error: {message}"
                        );
                    }
                    (
                        true,
                        Writer::Missing,
                        Err(CellAbort::Tool(ToolError::CleanupUnconfirmed(message))),
                    ) => {
                        assert_eq!(
                            message,
                            "Native input drained without its canonical interruption writer"
                        );
                    }
                    _ => {
                        panic!("unexpected post_drain={post_drain}, writer={writer:?}: {result:?}")
                    }
                }
                assert!(
                    owner.stopping.is_cancelled(),
                    "ordinary Unknown or an unconfirmed canonical fence retains the existing failure boundary"
                );
            }
            let native_tip = store
                .run_source("session", "run", Some(4))
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(native_tip.last.event.fact,Fact::ToolSettled{ref operation_id,outcome:ToolOutcome::Unknown{ref message,..}}
                if operation_id=="native" && message=="accepted native action remains unknown"),
                "the original admitted native T2 remains Unknown"
            );
            runtime.close().await.unwrap();
            drop(bridge);
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::ToolSettled {
                            operation_id: "outer".into(),
                            outcome: ToolOutcome::Failed {
                                message: "fixture complete".into(),
                            },
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
            owner.sessions.close().await.unwrap();
            owner.resources.settle().await.unwrap();
            owner.tasks.close();
            owner.tasks.wait().await;
            drop((kernel, epoch, interaction, owner, store));
            Arc::try_unwrap(root).ok().unwrap().close().await.unwrap();
        }
    }
}
