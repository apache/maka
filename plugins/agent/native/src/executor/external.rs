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
use futures_util::future::Shared;
use maka_agent_api::executor::{ExternalConfiguration, NativeCommand, NativeRuntime};
use maka_agent_ports::executor::{Outcome, Request};
use maka_capabilities::storage::Store;
use maka_host_runtime::storage::Storage;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

mod agy;
mod attachments;
mod claude;
mod codex;
mod discovery;
mod history;
mod journal;
mod mcp;
mod runtime;
mod steering;
mod tools;
pub(crate) use tools::HostTools;

struct CatalogSnapshot {
    cwd: String,
    selected: Option<NativeRuntime>,
    started: Instant,
    result: Shared<BoxFuture<'static, Result<Value, Error>>>,
}

impl CatalogSnapshot {
    fn reusable(&self) -> bool {
        let Some(result) = self.result.peek() else {
            return true;
        };
        let Ok(catalog) = result else {
            return false;
        };
        let rows = match self.selected {
            Some(_) => std::slice::from_ref(catalog),
            None => catalog
                .as_array()
                .expect("unscoped native catalog is an array"),
        };
        self.started.elapsed() < Duration::from_secs(30)
            && !rows.iter().any(|row| {
                ["installation", "models"].iter().any(|field| {
                    row.get(field)
                        .and_then(|value| value.get("kind"))
                        .and_then(Value::as_str)
                        == Some("error")
                })
            })
    }
}
enum Catalog {
    Empty,
    Cached(CatalogSnapshot),
    Failed(Error),
}
impl Catalog {
    fn failure(&self) -> Result<(), Error> {
        match self {
            Self::Failed(error) => Err(error.clone()),
            _ => Ok(()),
        }
    }
    fn invalidate(&mut self) {
        if !matches!(self, Self::Failed(_)) {
            *self = Self::Empty;
        }
    }
    fn admit(
        &self,
        resources: &Arc<maka_capabilities::call::Resources>,
    ) -> Result<maka_capabilities::call::Ticket, Error> {
        self.failure()?;
        resources.reserve().map_err(|_| Error::Retired)
    }
    fn observe(&mut self, result: &Result<Value, Error>) {
        if let Err(error @ (Error::Unknown | Error::CleanupUnconfirmed)) = result
            && !matches!(self, Self::Failed(Error::CleanupUnconfirmed))
        {
            *self = Self::Failed(error.clone());
        }
    }
}

pub(super) struct External {
    commands: BTreeMap<NativeRuntime, NativeCommand>,
    storage: Storage,
    queries: Arc<maka_capabilities::call::Resources>,
    catalog: tokio::sync::Mutex<Catalog>,
    stop: CancellationToken,
    endpoints: tokio::sync::Mutex<BTreeMap<(String, NativeRuntime), Arc<mcp::Endpoint>>>,
    root: Arc<RootStore>,
    package: String,
    activation: String,
    pub basis: String,
}
impl External {
    pub fn capture(
        context: &NativeContext,
        configuration: &ExternalConfiguration,
    ) -> Result<Arc<Self>, String> {
        let persistence = context
            .persistence()
            .ok_or("External agents require persistence")?;
        let mut commands = BTreeMap::new();
        for runtime in configuration.enabled_runtimes() {
            let command =
                configuration
                    .command(runtime)
                    .cloned()
                    .unwrap_or_else(|| NativeCommand {
                        executable: runtime.executable().into(),
                        args: Vec::new(),
                        env: BTreeMap::new(),
                    });
            runtime::validate_command(runtime, &command)?;
            commands.insert(runtime, command);
        }
        let prefix = hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                persistence.source().deployment,
                context.activation().instance(),
            ))
            .map_err(|e| e.to_string())?,
        ));
        // Historical physical namespace: retain the deployed CAS records and native IDs.
        let storage = Storage::new(
            persistence.store().clone(),
            format!("{prefix}/"),
            maka_capabilities::storage::Namespace::new(
                "maka.agent.oar",
                maka_plugin_core::scope::Scope::Profile,
            )
            .map_err(|e| e.to_string())?,
        );
        let basis = hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                context.activation().epoch(),
                &commands,
                storage.execution_basis(),
            ))
            .map_err(|e| e.to_string())?,
        ));
        Ok(Arc::new(Self {
            commands,
            storage,
            queries: Arc::default(),
            catalog: tokio::sync::Mutex::new(Catalog::Empty),
            stop: CancellationToken::new(),
            endpoints: tokio::sync::Mutex::new(BTreeMap::new()),
            root: persistence.store().clone(),
            package: context.package().id.clone(),
            activation: context.activation().epoch().to_string(),
            basis,
        }))
    }
    pub fn admit(
        self: &Arc<Self>,
        request: Request,
        host_tools: Option<HostTools>,
    ) -> Result<Admitted, Error> {
        self.require_runtime(request.settings.runtime.as_deref())?;
        Ok(Admitted {
            identity: maka_agent_facts::executor::Binding {
                executor_id: "external"
                    .to_owned()
                    .try_into()
                    .expect("external executor identity"),
                package_id: self.package.clone(),
                entry_id: "external".into(),
                activation: self.activation.clone(),
            },
            execution: Box::new(Call {
                owner: self.clone(),
                request,
                host_tools,
            }),
        })
    }
    pub(super) fn require_runtime(&self, runtime: Option<&str>) -> Result<NativeRuntime, Error> {
        let runtime = runtime
            .ok_or_else(|| Error::Invalid("External agent requires a runtime selection".into()))?
            .parse::<NativeRuntime>()
            .map_err(Error::Invalid)?;
        if !self.commands.contains_key(&runtime) {
            return Err(Error::Invalid(format!(
                "External agent runtime is not enabled: {}",
                runtime.as_str()
            )));
        }
        Ok(runtime)
    }
    pub async fn query(
        self: &Arc<Self>,
        cwd: String,
        request: Value,
        cancellation: CancellationToken,
    ) -> Result<Value, Error> {
        if cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let kind = request
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid("Missing external query kind".into()))?;
        if !matches!(kind, "status" | "catalog" | "models") {
            return Err(Error::Invalid("Unsupported external query kind".into()));
        }
        let selected = request
            .get("runtime")
            .map(|id| self.require_runtime(id.as_str()))
            .transpose()?;
        if selected.is_none() && kind == "models" {
            return Err(Error::Invalid("Models require a runtime selection".into()));
        }
        if kind == "catalog" {
            let (discovery, catalog_runtime) = {
                let mut cached = self.catalog.lock().await;
                cached.failure()?;
                if let Catalog::Cached(entry) = &*cached
                    && entry.cwd == cwd
                    && (entry.selected == selected
                        || (entry.selected.is_none() && entry.result.peek().is_some()))
                    && entry.reusable()
                {
                    (entry.result.clone(), entry.selected)
                } else {
                    let owner = self.clone();
                    let work_cwd = cwd.clone();
                    let discovery = async move {
                        owner
                            .discover(
                                work_cwd,
                                "catalog".into(),
                                selected,
                                owner.stop.child_token(),
                            )
                            .await
                    }
                    .boxed()
                    .shared();
                    let retained = discovery.clone();
                    tokio::spawn(async move {
                        let _ = retained.await;
                    });
                    *cached = Catalog::Cached(CatalogSnapshot {
                        cwd,
                        selected,
                        started: Instant::now(),
                        result: discovery.clone(),
                    });
                    (discovery, selected)
                }
            };
            return tokio::select! { biased;
                () = cancellation.cancelled() => Err(Error::Cancelled),
                () = self.stop.cancelled() => Err(Error::Retired),
                result = discovery => {
                    let value = result?;
                    if catalog_runtime.is_none() && let Some(runtime) = selected {
                        value.as_array().expect("unscoped native catalog is an array")
                            .iter().find(|row| row["runtime"].as_str() == Some(runtime.as_str()))
                            .cloned().ok_or_else(|| Error::Invalid("Native runtime missing from catalog".into()))
                    } else {
                        Ok(value)
                    }
                },
            };
        }
        if kind == "status" {
            self.catalog.lock().await.invalidate();
        }
        self.discover(cwd, kind.to_owned(), selected, cancellation)
            .await
    }
    async fn discover(
        self: &Arc<Self>,
        cwd: String,
        kind: String,
        selected: Option<NativeRuntime>,
        cancellation: CancellationToken,
    ) -> Result<Value, Error> {
        let mut ticket = self.catalog.lock().await.admit(&self.queries)?;
        let owner = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            ticket.start();
            let cancel = cancellation.child_token();
            let work = discovery::query(&owner.commands, &cwd, &kind, selected, cancel.clone());
            tokio::pin!(work);
            let result = tokio::select! {
                result = &mut work => result,
                () = owner.stop.cancelled() => { cancel.cancel(); work.await },
            };
            owner.catalog.lock().await.observe(&result);
            ticket.complete(if matches!(result, Err(Error::CleanupUnconfirmed)) {
                Err("Native discovery cleanup is unconfirmed".into())
            } else {
                Ok(())
            });
            let _ = send.send(result);
        });
        match receive.await {
            Ok(result) => result,
            Err(_) => {
                let result = Err(Error::CleanupUnconfirmed);
                self.catalog.lock().await.observe(&result);
                result
            }
        }
    }
    async fn bridge(
        &self,
        request: &Request,
        tools: tools::Tools,
    ) -> Result<Arc<mcp::Bridge>, Error> {
        let runtime = self.require_runtime(request.settings.runtime.as_deref())?;
        let mut endpoints = self.endpoints.lock().await;
        if self.stop.is_cancelled() {
            return Err(Error::Retired);
        }
        let key = (request.conversation_key.clone(), runtime);
        if !endpoints.contains_key(&key) {
            let endpoint =
                mcp::Endpoint::open(request.invocation.session_id.clone(), tools.definitions())
                    .await?;
            endpoints.insert(key.clone(), endpoint);
        }
        endpoints[&key].bind(tools)
    }
    pub async fn remove_sessions(&self, sessions: &[String]) -> Result<(), String> {
        let selected = self
            .endpoints
            .lock()
            .await
            .iter()
            .filter(|(_, endpoint)| sessions.contains(&endpoint.session_id))
            .map(|(key, endpoint)| (key.clone(), endpoint.clone()))
            .collect::<Vec<_>>();
        self.finish_endpoints(selected).await
    }
    async fn finish_endpoints(
        &self,
        selected: Vec<((String, NativeRuntime), Arc<mcp::Endpoint>)>,
    ) -> Result<(), String> {
        let mut failure = None;
        for (key, endpoint) in selected {
            match endpoint.finish().await {
                Ok(()) => {
                    let mut endpoints = self.endpoints.lock().await;
                    if endpoints
                        .get(&key)
                        .is_some_and(|current| Arc::ptr_eq(current, &endpoint))
                    {
                        endpoints.remove(&key);
                    }
                }
                Err(error) => failure = Some(error.to_string()),
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.stop.cancel();
        self.catalog.lock().await.invalidate();
        let selected = self
            .endpoints
            .lock()
            .await
            .iter()
            .map(|(key, endpoint)| (key.clone(), endpoint.clone()))
            .collect();
        let endpoints = self.finish_endpoints(selected).await;
        let queries = self.queries.finish().await.map_err(|e| e.to_string());
        let storage = self.storage.finish().await;
        queries?;
        storage?;
        endpoints
    }
}
struct Call {
    owner: Arc<External>,
    request: Request,
    host_tools: Option<HostTools>,
}
impl executor::Execution for Call {
    fn execute(
        self: Box<Self>,
        execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Settlement> {
        Box::pin(async move {
            let result = self.run(execution, output, cancellation).await;
            Settlement::new(result, self.owner)
        })
    }
}
impl Call {
    async fn run(
        &self,
        execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> Result<Outcome, Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let store = self
            .owner
            .root
            .session_for_execution(execution.as_ref(), &self.request.invocation)
            .map_err(|e| Error::Persistence(e.to_string()))?;
        let host_tools = tools::Tools::bind(
            self.host_tools.clone().unwrap_or_default(),
            Arc::new(store.clone()),
            &self.request,
            execution.clone(),
            &self.owner,
            cancellation.clone(),
        )
        .await?;
        let mut materials = attachments::prepare(
            &store,
            &self.request.invocation.session_id,
            &self.request.content,
            &cancellation,
        )
        .await?;
        let mut journal = journal::Journal::load(&self.owner.storage, &self.request).await?;
        if let Some(mut context) =
            history::context(&store, &self.request, journal.last_delivered_run()).await?
        {
            context.push_str("\n\n--- Current user message ---\n");
            context.push_str(&materials.message);
            materials.message = context;
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut steering =
            steering::Steering::new(store.clone(), &self.request, cancellation.clone())?;
        let lease = self
            .owner
            .root
            .fork_execution(execution.as_ref(), &self.request.invocation)
            .map_err(|e| Error::Persistence(e.to_string()))?;
        let bridge = match self.owner.bridge(&self.request, host_tools).await {
            Ok(bridge) => bridge,
            Err(error) => {
                lease.finish();
                return Err(error);
            }
        };
        if let Err(error) = journal
            .start(&self.owner.storage, &self.request.invocation.invocation_id)
            .await
        {
            lease.finish();
            let result = bridge.close().await.and(Err(error));
            bridge.settled(&result);
            return result;
        }
        let runtime = self
            .owner
            .require_runtime(self.request.settings.runtime.as_deref())?;
        let request = serde_json::json!({
            "kind":"execute", "runtime":self.request.settings.runtime, "cwd":self.request.cwd,
            "message":materials.message,
            "images":materials.images,
            "tools":bridge.definitions(),
        });
        let mut request = request.as_object().expect("worker request").clone();
        for (key, value) in [
            ("model", self.request.settings.model.as_deref()),
            (
                "effort",
                self.request
                    .settings
                    .thinking_level
                    .as_ref()
                    .map(|e| e.as_str()),
            ),
            ("instructions", self.request.instructions.as_deref()),
            ("resume", journal.native_session()),
        ] {
            if let Some(value) = value {
                request.insert(key.into(), value.into());
            }
        }
        // From this point cancellation/drop must not remove paths that the native
        // agent may still be reading. Only confirmed worker settlement releases them.
        let directory = materials.handoff();
        let result = runtime::execute(
            runtime,
            &self.owner.commands[&runtime],
            &self.request.cwd,
            request.into(),
            &self.owner.storage,
            &mut journal,
            output,
            bridge,
            cancellation,
            &mut steering,
        )
        .await;
        if !matches!(result, Err(Error::CleanupUnconfirmed)) {
            lease.finish();
            steering.cleanup().await?;
            if let Some(directory) = directory {
                tokio::fs::remove_dir_all(directory).await.map_err(|e| {
                    Error::Provider(format!("External agent attachment cleanup failed: {e}"))
                })?;
            }
        }
        if matches!(&result, Ok(Outcome::Completed { .. })) {
            journal
                .delivered(&self.owner.storage, &self.request.invocation.run_id)
                .await?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{Mutex, oneshot};

    #[tokio::test]
    async fn evicted_catalog_probe_still_quarantines_metadata_and_drains_overlapping_status() {
        let cached = CatalogSnapshot {
            cwd: "workspace".into(),
            selected: None,
            started: Instant::now(),
            result: futures_util::future::pending::<Result<Value, Error>>()
                .boxed()
                .shared(),
        };
        let catalog = Arc::new(Mutex::new(Catalog::Cached(cached)));
        let resources = Arc::new(maka_capabilities::call::Resources::default());
        async fn probe(
            catalog: Arc<Mutex<Catalog>>,
            resources: Arc<maka_capabilities::call::Resources>,
            entered: oneshot::Sender<()>,
            release: oneshot::Receiver<Result<Value, Error>>,
        ) -> Result<Value, Error> {
            let mut ticket = catalog.lock().await.admit(&resources)?;
            ticket.start();
            entered.send(()).unwrap();
            let result = release.await.unwrap();
            catalog.lock().await.observe(&result);
            ticket.complete(if matches!(result, Err(Error::CleanupUnconfirmed)) {
                Err("probe cleanup unconfirmed".into())
            } else {
                Ok(())
            });
            result
        }
        let (catalog_entered, entered) = oneshot::channel();
        let (release_catalog, result) = oneshot::channel();
        let original = tokio::spawn(probe(
            catalog.clone(),
            resources.clone(),
            catalog_entered,
            result,
        ));
        entered.await.unwrap();
        catalog.lock().await.invalidate();
        assert!(matches!(*catalog.lock().await, Catalog::Empty));
        let (status_entered, entered) = oneshot::channel();
        let (release_status, result) = oneshot::channel();
        let status = tokio::spawn(probe(
            catalog.clone(),
            resources.clone(),
            status_entered,
            result,
        ));
        entered.await.unwrap();
        release_catalog
            .send(Err(Error::CleanupUnconfirmed))
            .unwrap();
        assert!(matches!(
            original.await.unwrap(),
            Err(Error::CleanupUnconfirmed)
        ));
        catalog.lock().await.invalidate();
        assert!(matches!(
            catalog.lock().await.admit(&resources),
            Err(Error::CleanupUnconfirmed)
        ));
        assert!(
            resources.has_pending(),
            "the admitted status probe must remain owned after its sibling fails"
        );
        release_status.send(Ok(serde_json::json!([]))).unwrap();
        status.await.unwrap().unwrap();
        assert!(!resources.has_pending());
        assert!(
            resources.reserve().is_ok(),
            "Resources alone do not quarantine discovery"
        );
        catalog.lock().await.invalidate();
        assert!(
            matches!(
                catalog.lock().await.admit(&resources),
                Err(Error::CleanupUnconfirmed)
            ),
            "clean status completion/refresh cannot erase the original fatal result"
        );
        assert!(resources.finish().await.is_err());
    }
}
