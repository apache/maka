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

mod attachments;

use super::*;
use maka_agent_ports::execution::OfferInteraction;
use maka_agent_ports::execution::Prompt;
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Scope;
use maka_capabilities::filesystem::Operation;
use maka_capabilities::filesystem::Output as FileOutput;
use maka_host_runtime::application::{NativeRequest, NativeServices};
use maka_plugin_core::operation::OperationResult;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use sha2::{Digest, Sha256};

pub(super) enum Role {
    Runtime {
        authority: Arc<maka_agent_authority::executor::ExecutorCallContext>,
        journal: Arc<journal::Journal>,
        key: String,
    },
    Setup(Arc<maka_agent_authority::setup::ActualSetupContext>),
}
pub(super) struct Issued {
    pub origin: Arc<Context>,
    pub role: Role,
    pub process: std::sync::Mutex<ProcessSlot>,
}
pub(super) enum ProcessSlot {
    Available,
    Claimed(Arc<processes::Running>),
    SealedUnused,
}
impl ProcessSlot {
    pub fn running(&self) -> Option<Arc<processes::Running>> {
        match self {
            Self::Claimed(running) => Some(running.clone()),
            _ => None,
        }
    }
    pub fn seal(&mut self) -> Option<Arc<processes::Running>> {
        if matches!(self, Self::Available) {
            *self = Self::SealedUnused;
        }
        self.running()
    }
}
impl Issued {
    pub fn is_setup(&self) -> bool {
        matches!(&self.role, Role::Setup(_))
    }
    pub fn process_operation(&self) -> Result<Uuid, String> {
        Ok(match &self.role {
            Role::Runtime { authority, .. } => operation(&(
                "acp_process_start",
                self.origin.requester().instance(),
                authority.0.execution(),
                authority.0.task_id(),
            )),
            Role::Setup(_) => operation(&(
                "acp_process_start",
                self.origin.requester().instance(),
                self.origin
                    .operation()
                    .ok_or("ACP setup has no original operation")?,
            )),
        })
    }
    pub async fn process_reference(
        &self,
        original: maka_plugin_core::operation::RecoveryRef,
        started: bool,
    ) -> Result<(), String> {
        match &self.role {
            Role::Runtime { journal, key, .. } => journal.process(key, original, started).await,
            Role::Setup(_) => Ok(()),
        }
    }
}
pub(super) struct Calls {
    pub services: NativeServices,
    pub issuer: Issuer,
    pub source: maka_plugin_core::deployment::DeploymentRef,
}
enum ReplyPolicy {
    Settled,
    Outcome,
}
pub(super) struct ProcessWatch {
    stop: CancellationToken,
    pub finished: Option<tokio::sync::oneshot::Receiver<Result<(), String>>>,
}
impl ProcessWatch {
    pub async fn close(&mut self) {
        self.stop.cancel();
        if let Some(finished) = self.finished.take() {
            let _ = finished.await;
        }
    }
}
impl Drop for ProcessWatch {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
pub(super) fn digest(value: &impl Serialize) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).expect("ACP identity"),
    ))
}
pub(super) fn operation(value: &impl Serialize) -> Uuid {
    Uuid::from_bytes(
        Sha256::digest(serde_json::to_vec(value).expect("ACP identity"))[..16]
            .try_into()
            .expect("UUID digest"),
    )
}
impl Calls {
    pub fn watch_process(
        self: &Arc<Self>,
        journal: Arc<journal::Journal>,
        key: String,
        context: Arc<Context>,
        original: journal::Original,
    ) -> Result<ProcessWatch, String> {
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|error| error.to_string())?;
        let stop = context.scope().cancellation.child_token();
        let cancellation = stop.clone();
        let (finished, completion) = tokio::sync::oneshot::channel();
        let calls = self.clone();
        tokio::spawn(async move {
            ticket.start();
            let mut requests: Vec<Arc<NativeRequest>> = Vec::new();
            let mut source_root = Ok(());
            let result = async {
                let input = &original.input;
                if context.scope().identity.agent() != Some(&input.execution) {
                    return Err("ACP cleanup source differs from its original execution".into());
                }
                let operation = operation(&(
                    "acp_process_start", context.requester().instance(), &input.execution, input.task_id,
                ));
                let lookup = Arc::new(calls.services.select_import_method("processes", 0, "run")?
                    .request(context.scope().identity.clone(), cancellation.child_token())?
                    .with_sandbox_floor(context.scope().sandbox_floor())?);
                requests.push(lookup.clone());
                let intent = lookup.lookup_intent(operation)?.await?
                    .ok_or("ACP original process intent is not yet available")?;
                let source: Identity = serde_json::from_value(intent.recovery["correlation"]["source"].clone())
                    .map_err(|_| "ACP original process source is invalid")?;
                if source.agent() != Some(&input.execution) {
                    return Err("ACP original process source execution changed".into());
                }
                let caller = Identity::Agent {
                    execution: input.execution.clone(),
                    operation_id: Some(format!("acp-process-{}", digest(&source))),
                };
                let process_input: maka_workspace_api::protocol::Run = serde_json::from_value(intent.recovery["input"].clone())
                    .map_err(|_| "ACP original process input is invalid")?;
                let resources = maka_host_runtime::application::CallResources::default();
                let recovery = serde_json::json!({
                    "kind":"acp_process_start", "version":2,
                    "correlation":{"source":source,"caller":caller,"taskId":input.task_id,
                        "requester":context.requester().instance()},
                    "target":{"kind":"import","name":"processes","member":0}, "method":"run", "input":process_input,
                    "resources":{"descriptors":resources.descriptors()?,"reacquisition":{"kind":"none"}},
                });
                calls.check_process_intent(&intent, operation, &recovery)?;
                if original.process.as_ref().is_some_and(|reference| reference != &intent.reference) {
                    return Err("ACP persisted original process reference changed".into());
                }
                let observed = lookup.recover(intent.reference.clone())?.await?
                    .ok_or("ACP original process receipt is unavailable")?;
                if observed.reference != intent.reference { return Err("ACP original process receipt reference changed".into()); }
                journal.process(&key, intent.reference.clone(), false).await?;
                if matches!(observed.outcome, OperationOutcome::NotExecuted {
                    proof: maka_plugin_core::operation::NotExecutedProof::ProviderPreventedBeforeStart
                }) && observed.cleanup == OperationCleanup::Confirmed {
                    return journal.prevented(&key).await;
                }
                let request = Arc::new(calls.services.select_import_method("processes", 0, "observe")?
                    .request(context.scope().identity.clone(), cancellation.child_token())?
                    .with_sandbox_floor(context.scope().sandbox_floor())?);
                requests.push(request.clone());
                let mut subscription = request.subscribe("processes", 0, "observe".into(),
                    serde_json::to_value(maka_workspace_api::protocol::Observe { original: intent.reference.clone() })
                        .map_err(|error| error.to_string())?, Attachments::default())?.await?;
                let reading = async {
                    loop {
                        let value = tokio::select! {
                            biased;
                            () = cancellation.cancelled() => return Ok(()),
                            value = subscription.recv() => value.ok_or("ACP original process source ended without closure")?,
                        };
                        let observation: maka_workspace_api::protocol::Observation = serde_json::from_value(value)
                            .map_err(|error| error.to_string())?;
                        if observation.original != intent.reference || observation.id != intent.reference.operation {
                            return Err("ACP original process cleanup source changed".into());
                        }
                        let confirmed = observation.cleanup == OperationCleanup::Confirmed;
                        journal.cleanup(&key, observation.cleanup).await?;
                        if confirmed { return Ok(()); }
                    }
                }.await;
                subscription.cancel();
                let completion = subscription.completion().await;
                source_root = completion.cleanup;
                reading.map_err(|error| completion.result.err().unwrap_or(error))
            }.await;
            for request in &requests {
                request.scope().cancellation.cancel();
            }
            let mut errors = source_root.err().into_iter().collect::<Vec<_>>();
            for request in &requests {
                if let Err(error) = request.finish().await {
                    errors.push(error);
                }
            }
            let root = if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            };
            match &root {
                Ok(()) => ticket.complete(Ok(())),
                Err(error) => ticket.unconfirmed(error.clone(), requests),
            }
            let _ = finished.send(result.and(root));
        });
        Ok(ProcessWatch {
            stop,
            finished: Some(completion),
        })
    }
    pub fn check_process_intent(
        &self,
        intent: &maka_event_log::applications::intents::CallerIntent,
        key: Uuid,
        recovery: &Value,
    ) -> Result<(), String> {
        let binding = self
            .services
            .imports()
            .find(|(name, _)| *name == "processes")
            .and_then(|(_, bindings)| bindings.first())
            .ok_or("ACP process import is unavailable")?;
        if intent.consumer != *binding.consumer().instance()
            || intent.caller.deployment != self.source.deployment
            || intent.caller.state_domain != self.source.state_domain
            || intent.reference.source.deployment != self.source.deployment
            || intent.reference.source.state_domain != self.source.state_domain
            || intent.reference.operation != key
            || intent.reference.namespace != *binding.provider().instance()
            || intent.reference.export != binding.export()
            || intent.reference.method != "run"
            || !intent
                .reference
                .contract
                .matches(binding.contract(), "run")
                .map_err(|error| error.to_string())?
            || &intent.recovery != recovery
        {
            return Err("ACP original process intent changed".into());
        }
        Ok(())
    }
    pub fn original_issued<'a>(&self, scope: &'a Scope) -> Result<&'a Arc<Issued>, String> {
        let issued = self
            .issuer
            .evidence::<Arc<Issued>>(scope)
            .ok_or("ACP cleanup has no original issuer")?;
        if scope.identity != issued.origin.scope().identity {
            return Err("ACP cleanup differs from its original call".into());
        }
        if let Role::Runtime { authority, key, .. } = &issued.role
            && (scope.identity.agent() != Some(authority.0.execution())
                || journal::Journal::key(&issued.origin, authority.0.task_id())? != *key)
        {
            return Err("ACP cleanup differs from its original task".into());
        }
        Ok(issued)
    }
    pub fn issued<'a>(&self, scope: &'a Scope) -> Result<&'a Arc<Issued>, String> {
        let issued = self
            .issuer
            .evidence::<Arc<Issued>>(scope)
            .ok_or("IsolationUnavailable: ACP requires an original native executor call")?;
        if scope.cancellation.is_cancelled()
            || issued.origin.scope().cancellation.is_cancelled()
            || scope.identity != issued.origin.scope().identity
        {
            return Err("ACP call is closed or changed".into());
        }
        Ok(issued)
    }
    pub fn origin<'a>(&self, scope: &'a Scope) -> Result<&'a Context, String> {
        Ok(self.issued(scope)?.origin.as_ref())
    }
    pub fn request(
        &self,
        scope: &Scope,
        identity: String,
        cancellation: CancellationToken,
        process_method: Option<&str>,
    ) -> Result<NativeRequest, String> {
        let issued = self.issued(scope)?;
        match &issued.role {
            Role::Runtime { authority, .. } => {
                let actual = issued
                    .origin
                    .native_context::<maka_agent_authority::executor::ExecutorCallContext>()
                    .ok_or("Original runtime context is closed")?;
                if !Arc::ptr_eq(authority, &actual) {
                    return Err("Runtime role changed".into());
                }
            }
            Role::Setup(authority) => {
                let actual = issued
                    .origin
                    .native_context::<maka_agent_authority::setup::ActualSetupContext>()
                    .ok_or("Original setup context is closed")?;
                if !Arc::ptr_eq(authority, &actual) {
                    return Err("Setup role changed".into());
                }
            }
        }
        self.request_from(issued, identity, cancellation, process_method)
    }
    fn request_from(
        &self,
        issued: &Issued,
        operation: String,
        cancellation: CancellationToken,
        process_method: Option<&str>,
    ) -> Result<NativeRequest, String> {
        let origin = &issued.origin;
        let services = match process_method {
            Some(method) => self.services.select_import_method("processes", 0, method)?,
            None => self.services.clone(),
        };
        let request = match &issued.role {
            Role::Runtime { authority, .. } => {
                let execution = origin
                    .scope()
                    .identity
                    .agent()
                    .ok_or("ACP requires its original admitted execution")?;
                let identity = Identity::Agent {
                    execution: execution.clone(),
                    operation_id: Some(operation),
                };
                let custody = origin
                    .work_custody()
                    .ok_or("ACP requires original work custody")?;
                services.request_with_work_and_context(
                    identity,
                    cancellation,
                    custody.clone(),
                    authority.clone(),
                )?
            }
            Role::Setup(authority) => {
                if origin.work_custody().is_some() {
                    return Err("Setup cannot borrow Agent work".into());
                }
                services.request_with_context(
                    origin.scope().identity.clone(),
                    cancellation,
                    authority.clone(),
                )?
            }
        };
        request.with_sandbox_floor(origin.scope().sandbox_floor())
    }
    pub async fn close_original(
        &self,
        scope: &Scope,
        running: &Arc<processes::Running>,
    ) -> Result<maka_workspace_api::protocol::Written, String> {
        let issued = self.original_issued(scope)?;
        let original = issued
            .process
            .lock()
            .unwrap()
            .running()
            .ok_or("ACP cleanup has no original private process")?;
        if !Arc::ptr_eq(&original, running) {
            return Err("ACP cleanup differs from the original process capability".into());
        }
        let (id, _) = running.original()?;
        let identity = format!("acp-close-{id}");
        // The only post-cancellation request is this original process's close.
        // Its provider still validates the same live native role and custody.
        let request = self.request_from(
            issued,
            identity.clone(),
            CancellationToken::new(),
            Some("close"),
        )?;
        let (outcome, _root_cleanup) = self
            .invoke_request(
                scope.clone(),
                request,
                identity,
                ("processes", "close"),
                serde_json::to_value(maka_workspace_api::protocol::Close { id: *id })
                    .map_err(|e| e.to_string())?,
                true,
                ReplyPolicy::Outcome,
            )
            .await?;
        serde_json::from_value(outcome?).map_err(|error| error.to_string())
    }
    pub async fn cleanup_original(
        &self,
        scope: &Scope,
        running: &Arc<processes::Running>,
        wait: bool,
    ) -> Result<OperationCleanup, String> {
        let issued = self.original_issued(scope)?;
        if !issued
            .process
            .lock()
            .unwrap()
            .running()
            .as_ref()
            .is_some_and(|original| Arc::ptr_eq(original, running))
        {
            return Err("ACP cleanup source has no original process custody".into());
        }
        let original = running.reference()?.clone();
        let mut ticket = scope
            .resources
            .reserve()
            .map_err(|error| error.to_string())?;
        let request = Arc::new(
            self.services
                .select_import_method("processes", 0, "observe")?
                .request(
                    issued.origin.scope().identity.clone(),
                    CancellationToken::new(),
                )?
                .with_sandbox_floor(issued.origin.scope().sandbox_floor())?,
        );
        let journal = match &issued.role {
            Role::Runtime { journal, key, .. } => Some((journal.clone(), key.clone())),
            Role::Setup(_) => None,
        };
        tokio::spawn(async move {
            ticket.start();
            let mut source_root = Ok(());
            let result = async {
                let mut subscription = request
                    .subscribe(
                        "processes",
                        0,
                        "observe".into(),
                        serde_json::to_value(maka_workspace_api::protocol::Observe {
                            original: original.clone(),
                        })
                        .map_err(|error| error.to_string())?,
                        Attachments::default(),
                    )?
                    .await?;
                let reading = async {
                    loop {
                        let value = subscription
                            .recv()
                            .await
                            .ok_or("ACP original process cleanup source ended")?;
                        let observation: maka_workspace_api::protocol::Observation =
                            serde_json::from_value(value).map_err(|error| error.to_string())?;
                        if observation.original != original || observation.id != original.operation
                        {
                            return Err("ACP original process cleanup source changed".into());
                        }
                        if let Some((journal, key)) = &journal {
                            journal.cleanup(key, observation.cleanup.clone()).await?;
                        }
                        if !wait || observation.cleanup != OperationCleanup::Unconfirmed {
                            return Ok(observation.cleanup);
                        }
                    }
                }
                .await;
                subscription.cancel();
                let completion = subscription.completion().await;
                source_root = completion.cleanup;
                reading.map_err(|error| completion.result.err().unwrap_or(error))
            }
            .await;
            let root = match (source_root, request.finish().await) {
                (Err(source), Err(request)) => Err(format!(
                    "ACP source Root: {source}; request Root: {request}"
                )),
                (Err(error), _) | (_, Err(error)) => Err(error),
                (Ok(()), Ok(())) => Ok(()),
            };
            match root {
                Ok(()) => ticket.complete(Ok(())),
                Err(error) => ticket.unconfirmed(error, request),
            }
            result
        })
        .await
        .map_err(|_| "ACP original cleanup source owner disappeared".to_owned())?
    }

    pub async fn invoke(
        &self,
        scope: Scope,
        identity: String,
        cancellation: CancellationToken,
        target: (&str, &str),
        input: Value,
        mutation: bool,
    ) -> Result<Value, String> {
        let request = self.request(&scope, identity.clone(), cancellation, None)?;
        let (outcome, cleanup) = self
            .invoke_request(
                scope,
                request,
                identity,
                target,
                input,
                mutation,
                ReplyPolicy::Settled,
            )
            .await?;
        cleanup?;
        outcome
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "The callback retains the original call scope, request, target, input and settlement policy explicitly"
    )]
    async fn invoke_request(
        &self,
        scope: Scope,
        request: NativeRequest,
        identity: String,
        target: (&str, &str),
        input: Value,
        mutation: bool,
        policy: ReplyPolicy,
    ) -> Result<(Result<Value, String>, Result<(), String>), String> {
        let (import, method) = (target.0.to_owned(), target.1.to_owned());
        let mut ticket = scope.resources.reserve().map_err(|e| e.to_string())?;
        // Accepted callback I/O retains its real owner even if the SDK drops
        // the observer while the Root drains that operation.
        tokio::spawn(async move {
            ticket.start();
            let request = Arc::new(request);
            let mut sdk_cleanup = Ok(());
            let result = async {
                if mutation {
                    let resources = maka_host_runtime::application::CallResources::default();
                    let recovery = serde_json::json!({
                        "kind": "acp_callback",
                        "version": 1,
                        "correlation": {
                            "source": scope.identity,
                            "caller": request.scope().identity,
                            "callbackId": identity,
                        },
                        "target": {"kind": "import", "name": import, "member": 0},
                        "method": method,
                        "input": input,
                        "resources": {
                            "descriptors": resources.descriptors()?,
                            "reacquisition": {"kind": "none"},
                        },
                    });
                    let id = operation(&(scope.identity.agent(), &identity, &import, &method));
                    let mutation = request
                        .begin_mutation(&import, 0, method.clone(), input, id, recovery, resources)?
                        .await?;
                    let original = mutation.reference.clone();
                    match policy {
                        ReplyPolicy::Settled => {
                            let completion = mutation.completion().await;
                            sdk_cleanup = completion.cleanup;
                            if completion.reply.reference != original {
                                let error = "ACP callback completion reference changed".to_owned();
                                sdk_cleanup =
                                    Err(match std::mem::replace(&mut sdk_cleanup, Ok(())) {
                                        Ok(()) => error.clone(),
                                        Err(cleanup) => format!("{error}; SDK cleanup: {cleanup}"),
                                    });
                                return Err(error);
                            }
                            let receipt_cleanup = match &completion.reply.receipt {
                                Receipt::Recorded {
                                    cleanup: OperationCleanup::Confirmed,
                                    ..
                                } => Ok(()),
                                Receipt::Recorded {
                                    cleanup: OperationCleanup::Failed { diagnostic },
                                    ..
                                }
                                | Receipt::Unavailable { diagnostic } => Err(diagnostic.clone()),
                                _ => {
                                    Err("ACP callback final receipt cleanup is unconfirmed"
                                        .to_owned())
                                }
                            };
                            sdk_cleanup = match (
                                std::mem::replace(&mut sdk_cleanup, Ok(())),
                                receipt_cleanup,
                            ) {
                                (Err(scope), Err(receipt)) => {
                                    Err(format!("SDK scope: {scope}; receipt cleanup: {receipt}"))
                                }
                                (Err(error), _) | (_, Err(error)) => Err(error),
                                (Ok(()), Ok(())) => Ok(()),
                            };
                            returned(completion.reply.receipt)
                        }
                        ReplyPolicy::Outcome => {
                            let reply = mutation.result().await;
                            if reply.reference != original {
                                sdk_cleanup = Err("ACP callback outcome reference changed".into());
                                return Err("ACP callback outcome reference changed".into());
                            }
                            returned_outcome(reply.receipt)
                        }
                    }
                } else {
                    request
                        .call(&import, 0, method.clone(), input, Attachments::default())?
                        .await
                }
            }
            .await;
            let cleanup = match (sdk_cleanup, request.finish().await) {
                (Err(sdk), Err(request)) => {
                    Err(format!("SDK cleanup: {sdk}; request Root: {request}"))
                }
                (Err(error), _) | (_, Err(error)) => Err(error),
                (Ok(()), Ok(())) => Ok(()),
            };
            match &cleanup {
                Ok(()) => ticket.complete(Ok(())),
                Err(error) => ticket.unconfirmed(error.clone(), request),
            }
            (result, cleanup)
        })
        .await
        .map_err(|error| format!("ACP accepted callback owner disappeared: {error}"))
    }
}
pub(super) fn returned(receipt: Receipt) -> Result<Value, String> {
    if !matches!(
        &receipt,
        Receipt::Recorded {
            cleanup: OperationCleanup::Confirmed,
            ..
        }
    ) {
        return Err("ACP service operation outcome or cleanup is unconfirmed".into());
    }
    returned_outcome(receipt)
}
pub(super) fn returned_outcome(receipt: Receipt) -> Result<Value, String> {
    match receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } => Ok(value),
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Failure { diagnostic },
                },
            ..
        } => Err(diagnostic),
        Receipt::Recorded {
            outcome: OperationOutcome::NotExecuted { .. },
            ..
        } => Err("ACP service operation was prevented before execution".into()),
        _ => Err("ACP service operation outcome or cleanup is unconfirmed".into()),
    }
}
impl maka_external_agent::ports::Callbacks for Calls {
    fn private_paths(
        &self,
        scope: &Scope,
    ) -> Result<maka_external_agent::ports::PrivatePaths, String> {
        let issued = self.issued(scope)?;
        let process = issued
            .process
            .lock()
            .unwrap()
            .running()
            .ok_or("IsolationUnavailable: ACP has no original private process")?;
        process.private_paths()
    }

    fn prompt_attachments(
        &self,
        scope: &Scope,
    ) -> Result<Vec<maka_external_agent::ports::PromptAttachment>, String> {
        let origin = self.origin(scope)?;
        attachments::read(origin.attachments().get("attachments").cloned())
    }

    fn file(
        &self,
        _scope: Scope,
        _identity: String,
        _operation: Operation,
        _cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<FileOutput, String>> {
        Box::pin(async {
            Err("IsolationUnavailable: ACP filesystem callbacks cannot write or read the Root; candidate publication requires known completion and a current Root FS effect".into())
        })
    }
    fn form(
        &self,
        scope: Scope,
        offer: OfferInteraction,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Option<maka_agent_facts::capability::FormResult>, String>> {
        Box::pin(async move {
            let origin = self.origin(&scope)?;
            if origin.scope().identity.agent() != Some(&offer.execution) {
                return Err("ACP form execution changed".into());
            }
            let Prompt::Form { message, fields } = offer.prompt else {
                return Err("ACP expected a form".into());
            };
            let value = self
                .invoke(
                    scope,
                    offer.operation_id,
                    cancellation,
                    ("forms", "ask"),
                    serde_json::json!({"message":message,"fields":fields}),
                    true,
                )
                .await?;
            match value.get("kind").and_then(Value::as_str) {
                Some("answered") => serde_json::from_value(
                    value
                        .get("result")
                        .cloned()
                        .ok_or("ACP form answer missing")?,
                )
                .map(Some)
                .map_err(|e| e.to_string()),
                Some("closed") => Ok(None),
                _ => Err("ACP form request rejected".into()),
            }
        })
    }
}
