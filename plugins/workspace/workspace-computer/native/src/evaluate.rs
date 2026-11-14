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
use maka_agent_facts::{
    artifact::{Artifact, ArtifactKind, ArtifactSource},
    durable::ExecutionIdentity,
    tools::{ToolExecutor, ToolFuture},
};
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult};
use maka_js_runtime::repl::Repl;
use maka_sandbox::workspace::PermissionBasis;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug)]
enum OperationFailure {
    Ordinary(ToolError),
    // A browser result has a durable Unknown receipt. Native input additionally
    // requires its exact physical drain proof before this observer may continue.
    ReportedUnknown(ToolError),
}
impl OperationFailure {
    fn reported(error: ToolError, browser: bool, native_drained: bool) -> Self {
        if (browser || native_drained)
            && matches!(
                error,
                ToolError::OutcomeUnknown(_) | ToolError::OperationUnknown { .. }
            )
        {
            Self::ReportedUnknown(error)
        } else {
            Self::Ordinary(error)
        }
    }
}
impl From<ToolError> for OperationFailure {
    fn from(error: ToolError) -> Self {
        Self::Ordinary(error)
    }
}

/// Carries the original Host call and resource budget.
pub(super) struct EvaluationScope {
    call: Call,
    input_resources: Option<maka_host_runtime::application::ResourceCapturer>,
}
impl EvaluationScope {
    pub(super) fn new(
        call: Call,
        resources: maka_host_runtime::application::ResourceCapturer,
    ) -> Self {
        Self {
            call,
            input_resources: Some(resources),
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
    ) -> Result<(ResultValue, maka_event_log::root_store::DataChange), ToolError> {
        let EvaluationScope {
            call,
            input_resources,
        } = evaluation;
        let invocation = call.authority.call().execution.clone();
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
        access::resource_boundary(call.scope.sandbox_floor())?;
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
        sessions::drain_ended_turns(self, &interaction, language).await?;
        sessions::watch_turn(self, &interaction, &call, language).await?;
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

            input_resources,
        });
        let mut changes = call.authority.changes().map_err(failed)?;
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
        invocation: &ExecutionIdentity,
        call: &Call,
        output: Vec<CellOutput>,
        state: ReplState,
    ) -> Result<(ResultValue, maka_event_log::root_store::DataChange), ToolError> {
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
        let original = call
            .operation
            .as_ref()
            .ok_or_else(|| failed("Computer original operation is missing"))?;
        let change = call
            .authority
            .prepare_artifact(original, artifact, bytes)
            .await?;
        Ok((
            ResultValue::Completed {
                artifact: id,
                state,
            },
            change,
        ))
    }
    async fn operation(
        self: &Arc<Self>,
        bridge: &Bridge,
        input: Value,
        cancellation: CancellationToken,
        receipt: admission::Receipt,
    ) -> Result<Value, OperationFailure> {
        let call = bridge.call.clone();
        access::resource_boundary(call.scope.sandbox_floor())?;
        let basis = bridge.basis;
        let language = bridge.language;
        let cell = bridge.cell.clone();
        let epoch = bridge.epoch.clone();
        let mut command: maka_computer_use::protocol::Command =
            serde_json::from_value(input.clone()).map_err(failed)?;
        let native = epoch.native.clone();
        let invocation = call.authority.call().execution.clone();
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
        let required = maka_computer_use::system_permission::required(&command);
        if !required.is_empty() {
            system_permission::ensure(
                self,
                &call,
                basis,
                required,
                &operation_id,
                &cancellation,
                &cell,
            )
            .await?;
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
                serde_json::json!({"command": command, "subject": subject}),
                &cancellation,
                &cell,
            )
            .await?;
            Some((target, subject.display.clone()))
        } else {
            None
        };
        let browser_operation = browser_command(&command);
        let device = if browser_operation
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
        // Keep mutation ordering until the actual action result. A custody
        // failure closes Host admission before another input waiter proceeds.
        let _device = device;
        let lane = if native.platform() == "windows" && native_helper_command(&command) {
            access::ComputerLane::Native
        } else {
            access::ComputerLane::Other
        };
        let pause_native =
            matches!(native.platform(), "mac" | "windows") && !browser_command(&command);
        let session = invocation.session_id.clone();
        let turn = invocation.turn_id.clone();
        let execution = maka_computer_use::ExecutionCorrelation::new(invocation.run_id.to_string())
            .map_err(failed)?;
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
            &call,
            &bridge.epoch,
            &operation_id,
        )?;
        if pause_native {
            native_interruption.check_native_admission().await?;
        }
        let lease = self
            .store
            .fork_effect(
                call.scope
                    .work_custody()
                    .ok_or_else(|| failed("Computer work custody is missing"))?
                    .as_ref(),
                &invocation.session_id,
            )
            .map_err(|error| ToolError::Persistence(message(error)))?;
        let lease = lease
            .for_parent(call.scope.work_custody().map(|token| token.as_ref()))
            .map_err(|error| ToolError::Persistence(message(error)))?;
        let effect_call = Call {
            scope: call.scope.for_work(
                lease
                    .store()
                    .work_custody()
                    .map_err(|error| ToolError::Persistence(message(error)))?,
                lease.cancellation(),
            )?,
            authority: call.authority.clone(),
            operation: call.operation.clone(),
        };
        let effect_owner = self.clone();
        let settlement =
            admission::Operation::new(self, lease, &bridge.epoch.native, &bridge.admission)?;
        let operation_settlement = settlement.handoff();
        let host_effects = admission::host_effects_with_lease_children(
            self,
            bridge.admission.clone(),
            &bridge.epoch.native,
            browser_access.popup_attachment(),
        );
        let effect_targets = targets.clone();
        let monitor_call = effect_call.clone();
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
        if app.is_some() && !call.authority.authorize_app(&operation_id).await? {
            settlement.complete(None);
            return Err(failed("Computer action already admitted; inspect its original operation instead of redispatching").into());
        }
        access::granted(self, &effect_call, basis).await?;
        receipt.action_admitted();
        let result = async move {
            // This owner is inside the actual admitted future. Keeping an
            // authorization Arc after Ready/drop does not keep it active.
            let _preparation_lifetime = preparation_active.drop_guard();
            access::settle(
                &effect_owner,
                &effect_call,
                basis,
                &effect_targets,
                move |operation_cancel| async move {
                    let monitor_action_call = monitor_call.clone();
                    let monitor_action_operation = monitor_operation.clone();
                    app_access::settle(
                        &monitor_call,
                        &monitor_operation,
                        effect_app.is_some(),
                        operation_cancel,
                        move |operation_cancel| async move {
                            let mut context = maka_computer_use::InvocationContext::new(
                                &session, &turn, execution,
                            )
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
                                            monitor_action_call.clone(),
                                            monitor_action_operation,
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
                                let finished = native.wait_audio_finished();
                                let policy = match monitor_action_call
                                    .authority
                                    .session_audio_retention(&basis)
                                    .await
                                {
                                    Ok(policy) => policy,
                                    Err(error) => {
                                        if let Err(cleanup) = native.discard_audio().await {
                                            return Err(ToolError::CleanupUnconfirmed(format!(
                                                "{error}; {cleanup}"
                                            )));
                                        }
                                        return Err(error);
                                    }
                                };
                                epoch.record_audio(
                                    policy,
                                    monitor_action_call.scope.sandbox_floor().clone(),
                                    monitor_owner.stopping.clone(),
                                    finished,
                                );
                            } else if stops_audio {
                                epoch.clear_audio();
                            }
                            Ok(result)
                        },
                    )
                    .await
                },
            )
            .await
        }
        .await;
        let native_drain = if matches!(lane, access::ComputerLane::Native)
            && matches!(
                &result,
                Err(ToolError::OutcomeUnknown(_) | ToolError::OperationUnknown { .. })
            ) {
            match native_receipt.native_drain().await {
                Ok(proof) => proof,
                Err(error) => {
                    // The action remains Unknown. A missing original physical
                    // receipt must remain a cleanup failure.
                    receipt.fail(error.clone());
                    bridge.admission.close_admission();
                    settlement.complete(Some(error.clone()));
                    return Err(error.into());
                }
            }
        } else {
            None
        };
        let result = result.map_err(|error| {
            OperationFailure::reported(error, browser_operation, native_drain.is_some())
        });
        let failure = if let Err(OperationFailure::Ordinary(
            error @ (ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::OperationCleanupUnconfirmed { .. }),
        )) = &result
        {
            receipt.fail(error.clone());
            bridge.admission.close_admission();
            Some(error.clone())
        } else {
            None
        };
        settlement.complete(failure);
        result
    }
}
#[derive(Clone)]
struct Bridge {
    owner: Arc<Computer>,
    call: Call,
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
            | Command::BrowserRelease { .. }
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

            let result = bridge
                .owner
                .operation(&bridge, input, cancellation, receipt.clone())
                .await;
            match result {
                Err(OperationFailure::ReportedUnknown(error)) => {
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
                        bridge.admission.close_admission();
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
        ToolError::Failed(value) => ToolError::Failed(value + suffix.as_str()),
        ToolError::Persistence(value) => ToolError::Persistence(value + suffix.as_str()),
        ToolError::CleanupUnconfirmed(value) => {
            ToolError::CleanupUnconfirmed(value + suffix.as_str())
        }
        ToolError::OutcomeUnknown(value) => ToolError::OutcomeUnknown(value + suffix.as_str()),
        ToolError::Io { kind, message } => ToolError::Io {
            kind,
            message: message + suffix.as_str(),
        },
        error => error,
    }
}
