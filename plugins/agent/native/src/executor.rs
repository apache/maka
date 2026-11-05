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

//! Explicit Executor services, driven by the original Agent engine.
use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_ports::executor;
use maka_agent_ports::executor::Admitted;
use maka_agent_ports::executor::Error;
use maka_agent_ports::executor::OutputSink;
use maka_agent_ports::executor::Request;
use maka_agent_ports::executor::Settlement;
use maka_capabilities::call::Identity;
use maka_event_log::RootStore;
use maka_host_runtime::application::{Binding, NativeContext, NativeServices};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, panic::AssertUnwindSafe, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(crate) mod attachments;
pub(crate) mod external;
pub mod setup;

use maka_agent_api::executor::{Execute, Selection, ServiceExecutor, contract};
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Accepted {
    pub selection: Selection,
    import: String,
    #[serde(default)]
    member: usize,
    basis: String,
}
#[derive(Clone)]
pub(crate) struct Backend {
    pub accepted: Accepted,
    implementation: Implementation,
    host_tools: Option<external::HostTools>,
}
#[derive(Clone)]
enum Implementation {
    Service(Box<ServiceBackend>),
    External(Arc<external::External>),
}
#[derive(Clone)]
struct ServiceBackend {
    services: NativeServices,
    store: Arc<RootStore>,
    deployment: Uuid,
    consumer: maka_plugin_core::composition::InstanceId,
    binding: Binding,
    setup: Option<maka_agent_api::executor::setup::Binding>,
}
#[derive(Default)]
pub(crate) struct Executors(BTreeMap<String, Backend>);
impl Executors {
    pub fn capture(
        context: &NativeContext,
        selected: &[ServiceExecutor],
        external: Option<&maka_agent_api::executor::ExternalConfiguration>,
    ) -> Result<Self, String> {
        let mut result = BTreeMap::new();
        for selection in selected {
            maka_agent_facts::executor::ExecutorId::try_from(selection.name.clone())
                .map_err(|_| "agent_executor_name_invalid")?;
            let services = context.services();
            let bindings = services
                .imports()
                .find(|(name, _)| *name == selection.import)
                .map(|(_, bindings)| bindings)
                .ok_or("agent_executor_import_missing")?;
            let binding = bindings
                .get(selection.member)
                .ok_or("agent_executor_member_unavailable")?;
            if binding.contract() != &contract() {
                return Err("agent_executor_contract_invalid".into());
            }
            if let Some(setup) = &selection.setup {
                let target = services
                    .imports()
                    .find(|(name, _)| *name == setup.import)
                    .and_then(|(_, bindings)| bindings.get(setup.member))
                    .ok_or("agent_executor_setup_unavailable")?;
                if target.contract() != &maka_agent_api::executor::setup::contract() {
                    return Err("agent_executor_setup_contract_invalid".into());
                }
            }
            let persistence = context.persistence().ok_or("agent_requires_persistence")?;
            let backend = Backend {
                accepted: Accepted {
                    selection: Selection {
                        executor: selection.name.clone(),
                        settings: Default::default(),
                    },
                    import: selection.import.clone(),
                    member: selection.member,
                    basis: binding.execution_basis().into(),
                },
                host_tools: None,
                implementation: Implementation::Service(Box::new(ServiceBackend {
                    binding: binding.clone(),
                    setup: selection.setup.clone(),
                    services: services.clone(),
                    store: persistence.store().clone(),
                    deployment: persistence.source().deployment,
                    consumer: context.activation().instance().clone(),
                })),
            };
            if result.insert(selection.name.clone(), backend).is_some() {
                return Err("agent_executor_name_ambiguous".into());
            }
        }
        if let Some(configuration) =
            external.filter(|configuration| configuration.enabled_runtimes().next().is_some())
        {
            let owner = external::External::capture(context, configuration)?;
            let backend = Backend {
                accepted: Accepted {
                    selection: Selection {
                        executor: "external".into(),
                        settings: Default::default(),
                    },
                    import: "external".into(),
                    member: 0,
                    basis: owner.basis.clone(),
                },
                host_tools: None,
                implementation: Implementation::External(owner),
            };
            if result.insert("external".into(), backend).is_some() {
                return Err("agent_executor_name_ambiguous".into());
            }
        }
        Ok(Self(result))
    }
    pub fn supports_steering(&self, accepted: &Accepted) -> bool {
        self.restore(accepted).is_ok_and(|backend| {
            matches!(backend.implementation, Implementation::External(_))
                && matches!(
                    accepted.selection.settings.runtime.as_deref(),
                    Some("codex" | "claude")
                )
        })
    }
    pub fn contains(&self, executor: &str) -> bool {
        self.0.contains_key(executor)
    }
    pub fn names(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }
    pub async fn finish(&self) -> Result<(), String> {
        for backend in self.0.values() {
            if let Implementation::External(owner) = &backend.implementation {
                owner.finish().await?;
            }
        }
        Ok(())
    }
    pub async fn external_query(
        &self,
        cwd: String,
        request: Value,
        cancellation: CancellationToken,
    ) -> Result<Option<Value>, Error> {
        let Some(Backend {
            implementation: Implementation::External(owner),
            ..
        }) = self.0.get("external")
        else {
            return Ok(None);
        };
        owner.query(cwd, request, cancellation).await.map(Some)
    }
    pub fn select(&self, selection: Selection) -> Result<Backend, String> {
        selection
            .settings
            .validate()
            .map_err(|_| "agent_executor_settings_invalid")?;
        let mut backend = self
            .0
            .get(&selection.executor)
            .cloned()
            .ok_or("agent_executor_unavailable")?;
        match &backend.implementation {
            Implementation::Service(_) if selection.settings.runtime.is_some() => {
                return Err("agent_executor_runtime_unsupported".into());
            }
            Implementation::External(owner) => {
                if selection.settings.runtime.is_none() {
                    return Err("agent_executor_runtime_required".into());
                }
                owner
                    .require_runtime(selection.settings.runtime.as_deref())
                    .map_err(|error| error.to_string())?;
            }
            _ => {}
        }
        backend.accepted.selection = selection;
        Ok(backend)
    }
    pub fn restore(&self, accepted: &Accepted) -> Result<Backend, String> {
        let backend = self.select(accepted.selection.clone())?;
        if &backend.accepted != accepted {
            return Err("agent_executor_changed".into());
        }
        Ok(backend)
    }
}
impl Backend {
    pub fn bind_host_tools(&mut self, tools: external::HostTools) {
        if matches!(self.implementation, Implementation::External(_)) {
            self.host_tools = Some(tools);
        }
    }
}
impl executor::Backend for Backend {
    fn admit_execution(&self, input: Request) -> Result<Admitted, Error> {
        input
            .settings
            .validate()
            .map_err(|error| Error::Invalid(error.into()))?;
        if input.settings != self.accepted.selection.settings
            || input
                .content
                .quotes
                .as_ref()
                .is_some_and(|items| !items.is_empty())
            || input
                .content
                .directory_references
                .as_ref()
                .is_some_and(|items| !items.is_empty())
        {
            return Err(Error::Invalid(
                "executor service requires owned message input".into(),
            ));
        }
        let service = match &self.implementation {
            Implementation::External(owner) => return owner.admit(input, self.host_tools.clone()),
            Implementation::Service(service) => service,
        };
        let identity = maka_agent_facts::executor::Binding {
            executor_id: self
                .accepted
                .selection
                .executor
                .clone()
                .try_into()
                .map_err(|error: &str| Error::Invalid(error.into()))?,
            package_id: service.binding.package().id.clone(),
            entry_id: "host".into(),
            activation: service.binding.provider().epoch().to_string(),
        };
        let operation = Uuid::from_bytes(
            Sha256::digest(
                serde_json::to_vec(&("maka.agent.executor", &input.invocation))
                    .expect("executor identity"),
            )[..16]
                .try_into()
                .expect("UUID digest"),
        );
        let body = Execute {
            language: input.language,
            invocation: input.invocation.clone(),
            conversation_key: input.conversation_key,
            message: input.content.text,
            cwd: input.cwd,
            instructions: input.instructions,
            settings: input.settings,
        };
        let value =
            serde_json::to_value(body).map_err(|error| Error::Invalid(error.to_string()))?;
        if !jsonschema::validator_for(
            &serde_json::to_value(schemars::schema_for!(Execute)).expect("executor input"),
        )
        .expect("executor schema")
        .is_valid(&value)
        {
            return Err(Error::Invalid("executor input is invalid".into()));
        }
        Ok(Admitted {
            identity,
            execution: Box::new(Call {
                backend: service.as_ref().clone(),
                accepted: self.accepted.clone(),
                input: value,
                invocation: input.invocation,
                operation,
                attachments: input.content.attachments.unwrap_or_default(),
            }),
        })
    }
}
struct Call {
    backend: ServiceBackend,
    accepted: Accepted,
    input: Value,
    invocation: maka_agent_facts::event::Invocation,
    operation: Uuid,
    attachments: Vec<maka_agent_facts::attachment::AttachmentRef>,
}
impl executor::Execution for Call {
    fn execute(
        self: Box<Self>,
        execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Settlement> {
        Box::pin(async move {
            let store = match self
                .backend
                .store
                .session_for_execution(execution.as_ref(), &self.invocation)
            {
                Ok(store) => Arc::new(store),
                Err(error) => {
                    return Settlement::new(Err(Error::Persistence(error.to_string())), ());
                }
            };
            let request = match self.backend.services.request_with_execution(
                Identity::Agent {
                    invocation: self.invocation.clone(),
                    operation_id: None,
                },
                cancellation,
                execution,
            ) {
                Ok(request) => request,
                Err(error) => return Settlement::new(Err(Error::Provider(error)), ()),
            };
            let mut result = {
                let business = async {
                    let original = self
                        .backend
                        .store
                        .application_intent(
                            self.backend.deployment,
                            self.backend.consumer.clone(),
                            self.operation,
                        )
                        .await
                        .map_err(|error| Error::Persistence(error.to_string()))?;
                    let receipt = if let Some(original) = original {
                        // An earlier uncertain call is observed at its actual source; never resubmit it.
                        request
                            .recover(original.reference)
                            .map_err(Error::Provider)?
                            .await
                            .map_err(Error::Provider)?
                            .map(|observation| Receipt::Recorded {
                                outcome: observation.outcome,
                                cleanup: observation.cleanup,
                            })
                            .ok_or(Error::Unknown)?
                    } else {
                        let resources = attachments::capture(
                            store.clone(),
                            &request,
                            &self.invocation.session_id,
                            self.attachments,
                        )
                        .await
                        .map_err(Error::Provider)?;
                        let mut mutation = request
                            .begin_mutation(
                                &self.accepted.import,
                                self.accepted.member,
                                "execute".into(),
                                self.input,
                                self.operation,
                                resources,
                            )
                            .map_err(Error::Provider)?
                            .await
                            .map_err(Error::Provider)?;
                        while let Some(value) = mutation.recv().await {
                            let observed = serde_json::from_value(value)
                                .map_err(|error| Error::Invalid(error.to_string()))?;
                            output.emit(observed).await?;
                        }
                        let completed = mutation.completion().await;
                        if completed.cleanup.is_err() {
                            return Err(Error::CleanupUnconfirmed);
                        }
                        completed.reply.receipt
                    };
                    match receipt {
                        Receipt::Recorded {
                            outcome: OperationOutcome::Returned { value },
                            cleanup: OperationCleanup::Confirmed,
                        } => serde_json::from_value(value)
                            .map_err(|error| Error::Invalid(error.to_string())),
                        Receipt::Recorded {
                            cleanup: OperationCleanup::Unconfirmed | OperationCleanup::Failed { .. },
                            ..
                        } => Err(Error::CleanupUnconfirmed),
                        _ => Err(Error::Unknown),
                    }
                };
                let mut business = Box::pin(AssertUnwindSafe(business).catch_unwind());
                tokio::select! {
                    biased;
                    result = &mut business => result.unwrap_or(Err(Error::Unknown)),
                    () = request.scope().cancellation.cancelled() => {
                        if request.finish().await.is_err() { Err(Error::CleanupUnconfirmed) }
                        else { let _ = business.await; Err(Error::Cancelled) }
                    }
                }
            };
            if request.finish().await.is_err() {
                result = Err(Error::CleanupUnconfirmed);
            }
            Settlement::new(result, request)
        })
    }
}
