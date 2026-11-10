/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Original cleanup observations, without execution, publication or control ports.
use super::{
    Accepted, Identity, NativeServices, RecoveryDescriptor, RequestOwner, ServiceTask, operation,
};
use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_engine::{RunError, ports::ExternalCleanupSource};
use maka_agent_facts::{
    durable::{ExecutionIdentity, RunOwner},
    executor::{ExecutorId, NATIVE_TASK_PROTOCOL, TaskDescriptor},
};
use maka_agent_state::CleanupFrontier;
use maka_host_runtime::application::Subscription;
use maka_plugin_core::operation::{NotExecutedProof, OperationCleanup, OperationOutcome};
use maka_process::isolated::{
    self, CleanupEvidence, Descriptor, EvidenceInterest, EvidenceWatch, SnapshotProof,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn unavailable(message: impl Into<String>) -> RunError {
    RunError::IsolationUnavailable(message.into())
}

// A read projection of the original prepare record; publication is not rehydrated.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedInput {
    accepted: Accepted,
    request: maka_agent_ports::executor::Request,
    private_resource: Descriptor,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn open(
    services: &NativeServices,
    root: &RunOwner,
    state_domain: &str,
    native_package: &str,
    frontier: &CleanupFrontier,
    backend: &[u8],
    prepared: &[u8],
    bound: Option<&[u8]>,
    retirement: CancellationToken,
) -> Result<Box<dyn ExternalCleanupSource>, RunError> {
    let accepted: Accepted = serde_json::from_slice(backend).map_err(RunError::Json)?;
    let prepared: TaskDescriptor<Value> =
        serde_json::from_slice(prepared).map_err(RunError::Json)?;
    if prepared.protocol != NATIVE_TASK_PROTOCOL
        || prepared.payload.get("recovery") != Some(&Value::Null)
    {
        return Err(unavailable(
            "Original cleanup prepare record is not an unbound native task",
        ));
    }
    let recovery = match bound {
        None => None,
        Some(bytes) => {
            let mut binding: TaskDescriptor<Value> =
                serde_json::from_slice(bytes).map_err(RunError::Json)?;
            let recovery = binding
                .payload
                .as_object_mut()
                .and_then(|payload| payload.get_mut("recovery"))
                .ok_or_else(|| unavailable("Original cleanup binding has no recovery association"))?
                .take();
            if recovery.is_null() || binding != prepared {
                return Err(unavailable(
                    "Original cleanup binding differs from its prepare record",
                ));
            }
            Some(serde_json::from_value::<RecoveryDescriptor>(recovery).map_err(RunError::Json)?)
        }
    };
    let input: PreparedInput = serde_json::from_value(prepared.payload).map_err(RunError::Json)?;
    let execution = ExecutionIdentity {
        session_id: frontier.session_id.clone(),
        turn_id: frontier.turn_id.clone(),
        run_id: frontier.run,
    };
    if input.accepted != accepted
        || input.request.execution != execution
        || input.request.task_id != frontier.task
        || prepared.source.executor_id
            != ExecutorId::try_from(accepted.selection.executor.clone())
                .map_err(|_| unavailable("Original cleanup executor identity is invalid"))?
    {
        return Err(unavailable(
            "Original cleanup input differs from its admitted task",
        ));
    }
    if retirement.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let native = accepted.selection.executor == "external"
        && accepted.import == "external"
        && accepted.member == 0
        && prepared.source.package_id == native_package
        && prepared.source.entry_id == "external";
    if native {
        let expected = match recovery {
            None => None,
            Some(RecoveryDescriptor::Native { binding }) => {
                if binding.adapter_version != 2
                    || binding.resource.resource_ref != input.private_resource.resource_ref
                {
                    return Err(unavailable(
                        "Original native cleanup binding has a different resource or adapter",
                    ));
                }
                let pipe = !matches!(binding.task, super::external::NativeTask::Claude { .. });
                Some((binding.snapshot, pipe))
            }
            Some(RecoveryDescriptor::Service { .. }) => {
                return Err(unavailable("Native cleanup has a service binding"));
            }
        };
        let watch = EvidenceWatch::open(&input.private_resource, EvidenceInterest::Cleanup)
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        return Ok(Box::new(NativeSource {
            resource: input.private_resource,
            expected,
            watch: Some(watch),
            reading: None,
            retirement,
        }));
    }
    let binding = services
        .imports()
        .find(|(name, _)| *name == accepted.import)
        .and_then(|(_, bindings)| bindings.get(accepted.member))
        .cloned()
        .ok_or_else(|| unavailable("Original service cleanup import slot is unavailable"))?;
    if binding.consumer().instance() != &root.namespace
        || binding.execution_basis() != accepted.basis
        || binding.contract() != &super::contract()
        || binding.package().id != prepared.source.package_id
        || binding.export() != prepared.source.entry_id
    {
        return Err(unavailable(
            "Current captured service slot differs from the original cleanup source",
        ));
    }
    let original = match recovery {
        Some(RecoveryDescriptor::Service { original }) => {
            if original.task != frontier.task
                || original.execution != execution
                || original.deployment != root.deployment
                || original.provider != *binding.provider().instance()
                || original.package != *binding.package()
                || original.export != binding.export()
            {
                return Err(unavailable("Original service cleanup binding changed"));
            }
            Some(original)
        }
        None => None,
        Some(RecoveryDescriptor::Native { .. }) => {
            return Err(unavailable("Service cleanup has a native binding"));
        }
    };
    let receipt = services
        .select_import_method(&accepted.import, accepted.member, "execute")
        .and_then(|selected| {
            selected.request(
                Identity::Agent {
                    execution: execution.clone(),
                    operation_id: None,
                },
                retirement.clone(),
            )
        })
        .map_err(unavailable)?;
    // After the first scope exists, every failure is returned with that scope's owner.
    let mut source = ServiceSource {
        requests: RequestOwner::one(receipt),
        subscription: None,
        admission: None,
        task: frontier.task,
        prevented_before_start: false,
        failure: None,
    };
    let result = async {
        let key = operation(&execution, frontier.task);
        let intent = source
            .requests
            .execution
            .lookup_intent(key)
            .map_err(unavailable)?
            .await
            .map_err(unavailable)?
            .ok_or_else(|| unavailable("Original service cleanup intent is not recorded"))?;
        let reference = &intent.reference;
        if intent.consumer != root.namespace
            || intent.caller.deployment != root.deployment
            || intent.caller.state_domain != state_domain
            || reference.source.deployment != root.deployment
            || reference.source.state_domain != state_domain
            || reference.operation != key
            || reference.namespace != *binding.provider().instance()
            || reference.export != binding.export()
            || reference.method != "execute"
            || !reference
                .contract
                .matches(binding.contract(), "execute")
                .map_err(|error| unavailable(error.to_string()))?
            || intent.recovery
                != serde_json::json!({"protocol":2,"taskId":frontier.task,"execution":execution})
            || original
                .as_ref()
                .is_some_and(|original: &ServiceTask| original.reference != *reference)
        {
            return Err(unavailable(
                "Original service cleanup intent does not match the exact source",
            ));
        }
        let observation = source
            .requests
            .execution
            .recover(reference.clone())
            .map_err(unavailable)?
            .await
            .map_err(unavailable)?
            .ok_or_else(|| unavailable("Original service cleanup receipt is unavailable"))?;
        if observation.reference != *reference {
            return Err(unavailable(
                "Original service cleanup receipt reference changed",
            ));
        }
        if matches!(
            &observation.outcome,
            OperationOutcome::NotExecuted {
                proof: NotExecutedProof::ProviderPreventedBeforeStart,
            }
        ) && observation.cleanup == OperationCleanup::Confirmed
        {
            if frontier.has_creation_evidence {
                return Err(unavailable(
                    "Original task creation evidence contradicts provider prevention",
                ));
            }
            // The exact execute is the sole creator; its provider fenced entry and settled.
            source.prevented_before_start = true;
            return Ok(());
        }
        // Ordinary receipt cleanup belongs to the SDK call, not to the original Task.
        source.requests.observation = Some(
            services
                .select_import_method(&accepted.import, accepted.member, "observe")
                .and_then(|selected| {
                    selected.request(
                        Identity::Agent {
                            execution,
                            operation_id: None,
                        },
                        retirement,
                    )
                })
                .map_err(unavailable)?,
        );
        let request = source
            .requests
            .observation
            .as_ref()
            .expect("original observer request");
        source.admission = Some(
            request
                .subscribe(
                    &accepted.import,
                    accepted.member,
                    "observe".into(),
                    serde_json::to_value(maka_agent_api::executor::Observe {
                        task_id: frontier.task,
                        after_index: None,
                    })
                    .map_err(RunError::Json)?,
                    maka_capabilities::call::Attachments::default(),
                )
                .map_err(unavailable)?,
        );
        Ok::<_, RunError>(())
    }
    .await;
    source.failure = result.err();
    Ok(Box::new(source))
}

type Reading = BoxFuture<'static, Result<Option<CleanupEvidence>, isolated::Error>>;
struct NativeSource {
    resource: Descriptor,
    expected: Option<(SnapshotProof, bool)>,
    watch: Option<EvidenceWatch>,
    reading: Option<Reading>,
    retirement: CancellationToken,
}
impl ExternalCleanupSource for NativeSource {
    fn next(&mut self) -> BoxFuture<'_, Result<OperationCleanup, RunError>> {
        Box::pin(async move {
            loop {
                if self.retirement.is_cancelled() {
                    return Err(RunError::Cancelled);
                }
                if self.reading.is_none() {
                    let resource = self.resource.clone();
                    self.reading =
                        Some(async move { isolated::cleanup_evidence(&resource).await }.boxed());
                }
                let evidence = self.reading.as_mut().expect("original evidence read").await;
                self.reading = None;
                match evidence.map_err(|error| unavailable(error.to_string()))? {
                    Some(evidence) => {
                        if let Some((snapshot, pipe)) = &self.expected {
                            if evidence.snapshot() != snapshot {
                                return Err(unavailable(
                                    "Original native cleanup snapshot changed",
                                ));
                            }
                            match &evidence {
                                CleanupEvidence::NeverLaunched { .. } => {
                                    return Err(unavailable(
                                        "A bound native task contradicts never-launched evidence",
                                    ));
                                }
                                CleanupEvidence::GroupClosed { receipt, .. } => {
                                    if matches!(
                                        receipt,
                                        isolated::TaskReceipt::Task {
                                            terminal_size: None,
                                            ..
                                        }
                                    ) != *pipe
                                    {
                                        return Err(unavailable(
                                            "Original native cleanup transport changed",
                                        ));
                                    }
                                }
                            }
                        }
                        return Ok(OperationCleanup::Confirmed);
                    }
                    None => self
                        .watch
                        .as_mut()
                        .expect("original evidence watch")
                        .changed()
                        .await
                        .map_err(|error| unavailable(error.to_string()))?,
                }
            }
        })
    }
    fn close(mut self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            if let Some(reading) = self.reading.take() {
                let _completed_read = reading.await;
            }
            if let Some(watch) = self.watch.take() {
                if let Err(error) = watch.close().await {
                    tracing::error!(
                        cause = "native_watch_close",
                        "Original cleanup observer fence remains unconfirmed"
                    );
                    let _failure = error;
                    std::future::pending::<()>().await;
                }
            }
        })
    }
}

// No output cursor: this subscription carries only the original Task's cleanup level.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum CleanupPage {
    Missing,
    Found {
        task_id: maka_agent_facts::durable::ExternalTaskId,
        observed: u64,
        has_more: bool,
        outputs: Vec<serde::de::IgnoredAny>,
        cleanup: OperationCleanup,
    },
}
struct ServiceSource {
    requests: RequestOwner,
    subscription: Option<Subscription>,
    admission: Option<BoxFuture<'static, Result<Subscription, String>>>,
    task: maka_agent_facts::durable::ExternalTaskId,
    prevented_before_start: bool,
    failure: Option<RunError>,
}
impl ExternalCleanupSource for ServiceSource {
    fn next(&mut self) -> BoxFuture<'_, Result<OperationCleanup, RunError>> {
        Box::pin(async move {
            if let Some(error) = self.failure.take() {
                return Err(error);
            }
            if self.prevented_before_start {
                return Ok(OperationCleanup::Confirmed);
            }
            if self.subscription.is_none() {
                let admission = self
                    .admission
                    .as_mut()
                    .ok_or_else(|| unavailable("Original cleanup observer was not admitted"))?;
                let subscription = admission.await.map_err(unavailable)?;
                self.admission = None;
                self.subscription = Some(subscription);
            }
            let subscription = self
                .subscription
                .as_mut()
                .expect("original cleanup subscription");
            let value = subscription.recv().await.ok_or_else(|| {
                unavailable("Original cleanup observer drained without a new proof")
            })?;
            let page: CleanupPage = serde_json::from_value(value).map_err(|error| {
                unavailable(format!("Invalid cleanup-only observation header: {error}"))
            })?;
            match page {
                CleanupPage::Missing => Err(unavailable("Original cleanup task is missing")),
                CleanupPage::Found {
                    task_id,
                    observed,
                    has_more,
                    outputs,
                    cleanup,
                    ..
                } => {
                    if task_id != self.task || !outputs.is_empty() || has_more || observed != 0 {
                        return Err(unavailable(
                            "Original cleanup-only observation violates its task or header projection",
                        ));
                    }
                    Ok(cleanup)
                }
            }
        })
    }
    fn close(mut self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            self.admission.take();
            if let Some(subscription) = self.subscription.as_mut() {
                subscription.cancel();
            }
            let owner = Arc::new(self.requests);
            let _initial = owner.finish().await;
            use maka_agent_ports::executor::RootSettlementOwner;
            owner.clone().original_root_cleanup_signal().await;
            if owner.original_root_cleanup() != OperationCleanup::Confirmed {
                tracing::error!(
                    cause = "service_request_close",
                    "Original cleanup observer Root resources remain unconfirmed"
                );
                std::future::pending::<()>().await;
            }
        })
    }
}
