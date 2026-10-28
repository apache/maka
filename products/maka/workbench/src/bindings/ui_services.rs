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

use super::{
    ApplicationClient, ApplicationHost, OriginalMutation, Owner, ScopedSubscription,
    SubscriptionKind, execute,
};
use maka_app_client::Client;
use maka_plugin_core::{
    composition::InstanceId,
    deployment::{DeploymentRef, management::UiInstance},
};
use nsh_core::JsonValue;
use nsh_core::prelude::*;
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Mutex, OnceCell};
use uuid::Uuid;

/// Services selected by one UI consumer. Locators identify declared imports;
/// the original Host remains available separately to trusted UI code.
#[class]
pub struct UiScope {
    pub(super) services: Arc<Services>,
    initial_session: Option<String>,
}
pub(super) struct Services {
    owner: Arc<Owner>,
    instance: InstanceId,
    definition_basis: String,
    imports: JsonValue,
    routes: BTreeMap<String, Selection>,
    binding: Mutex<Option<Binding>>,
    closed: AtomicBool,
    cleanup: OnceCell<Result<(), String>>,
}
struct Selection {
    import: String,
    index: usize,
}
struct Binding {
    client: Client,
    imports: BTreeMap<String, Vec<String>>,
    binding_basis: String,
}

impl UiScope {
    pub(super) fn new(
        owner: Arc<Owner>,
        source: DeploymentRef,
        instance: InstanceId,
        definition_basis: String,
        initial_session: Option<String>,
    ) -> Result<Self, String> {
        instance.validate().map_err(|error| error.to_string())?;
        let (current, metadata) = owner
            .plugins
            .current_ui(&instance)
            .ok_or("UI instance is no longer active")?;
        if source.state_domain != current.state_domain || source.deployment != current.deployment {
            return Err("UI bindings belong to another deployment".into());
        }
        if metadata.definition_basis != definition_basis {
            return Err("UI service scope belongs to a retired binding generation".into());
        }
        let mut routes = BTreeMap::new();
        let mut imports = BTreeMap::new();
        for (name, count) in &metadata.imports {
            let mut locators = Vec::with_capacity(*count);
            for index in 0..*count {
                let locator = routes.len().to_string();
                routes.insert(
                    locator.clone(),
                    Selection {
                        import: name.clone(),
                        index,
                    },
                );
                locators.push(locator);
            }
            imports.insert(name.clone(), locators);
        }
        Ok(Self {
            initial_session,
            services: Arc::new(Services {
                owner,
                instance,
                definition_basis,
                imports: serde_json::to_value(imports).map_err(|error| error.to_string())?,
                routes,
                binding: Mutex::new(None),
                closed: AtomicBool::new(false),
                cleanup: OnceCell::new(),
            }),
        })
    }
}

impl Services {
    pub(super) fn asset_uri(&self, uri: &str) -> Result<String, String> {
        super::assets::scoped_uri(&self.instance, &self.definition_basis, uri)
    }

    fn ensure_open(&self) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("UI service scope is closed".into());
        }
        Ok(())
    }

    fn current_source(&self) -> Result<(DeploymentRef, Arc<UiInstance>), String> {
        self.ensure_open()?;
        let (source, metadata) = self
            .owner
            .plugins
            .current_ui(&self.instance)
            .ok_or("UI service scope is no longer active")?;
        if metadata.definition_basis != self.definition_basis {
            return Err("UI service scope belongs to a retired binding generation".into());
        }
        Ok((source, metadata))
    }

    async fn capture(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Binding>>, String> {
        let mut binding = self.binding.lock().await;
        loop {
            let (source, metadata) = self.current_source()?;
            if binding.as_ref().is_some_and(|bound| {
                bound.binding_basis == metadata.binding_basis && !bound.client.binding_retired()
            }) {
                return Ok(binding);
            }
            let captured = self
                .owner
                .client
                .bind_ui(source.clone(), self.instance.clone())
                .await;
            match (captured, self.current_source()) {
                (Ok((client, imports)), Ok((_, latest))) => {
                    if latest.binding_basis != metadata.binding_basis || client.binding_retired() {
                        let _ = self.owner.spawn(async move { client.retire().await });
                        continue;
                    }
                    let old = binding.replace(Binding {
                        client,
                        imports,
                        binding_basis: metadata.binding_basis.clone(),
                    });
                    if let Some(old) = old {
                        let _ = self.owner.spawn(async move { old.client.retire().await });
                    }
                    return Ok(binding);
                }
                (Ok((client, _)), Err(error)) => {
                    let _ = self.owner.spawn(async move { client.retire().await });
                    return Err(error);
                }
                (Err(_), Ok((latest, _))) if latest != source => continue,
                (Err(error), Ok(_)) | (_, Err(error)) => return Err(error),
            }
        }
    }

    pub(super) async fn client(&self) -> Result<Client, String> {
        let binding = self.capture().await?;
        Ok(binding
            .as_ref()
            .expect("UI session captured above")
            .client
            .clone())
    }

    pub(super) async fn local_client(&self) -> Result<Client, String> {
        let binding = self.binding.lock().await;
        if let Some(bound) = binding.as_ref() {
            return Ok(bound.client.clone());
        }
        drop(binding);
        self.client().await
    }

    pub(super) async fn mutation_context(
        &self,
        endpoint: &str,
    ) -> Result<(Client, String, JsonValue), String> {
        let binding = self.capture().await?;
        let bound = binding.as_ref().expect("UI session captured above");
        for (import, endpoints) in &bound.imports {
            if let Some((index, target)) = endpoints.iter().enumerate().find(|(_, target)| {
                target.as_str() == endpoint || (import.as_str() == endpoint && endpoints.len() == 1)
            }) {
                return Ok((
                    bound.client.clone(),
                    target.clone(),
                    json!({"kind":"ui", "instance":self.instance, "import":import, "index":index}),
                ));
            }
        }
        Err("UI application has no such service endpoint".into())
    }

    async fn resolve(&self, locator: &str) -> Result<(Client, String), String> {
        let selection = self
            .routes
            .get(locator)
            .ok_or("Unknown UI service locator")?;
        let binding = self.capture().await?;
        let bound = binding.as_ref().expect("UI session captured above");
        let endpoint = bound
            .imports
            .get(&selection.import)
            .and_then(|endpoints| endpoints.get(selection.index))
            .ok_or("Host omitted a declared UI service binding")?;
        Ok((bound.client.clone(), endpoint.clone()))
    }

    fn correlation(&self, locator: &str) -> Result<JsonValue, String> {
        let selection = self
            .routes
            .get(locator)
            .ok_or("Unknown UI service locator")?;
        Ok(
            json!({"kind":"ui", "instance":self.instance, "import":selection.import, "index":selection.index}),
        )
    }

    pub(super) async fn close(&self) -> Result<(), String> {
        self.closed.store(true, Ordering::Release);
        self.cleanup
            .get_or_init(|| async {
                let client = self
                    .binding
                    .lock()
                    .await
                    .as_ref()
                    .map(|bound| bound.client.clone());
                if let Some(client) = client {
                    // Keep the captured journal owner for already admitted local IO.
                    client.retire().await?;
                }
                Ok(())
            })
            .await
            .clone()
    }
}

impl Drop for UiScope {
    fn drop(&mut self) {
        self.services.closed.store(true, Ordering::Release);
        let services = self.services.clone();
        let _ = self
            .services
            .owner
            .spawn(async move { services.close().await });
    }
}

#[class]
impl UiScope {
    pub fn application(&self) -> Instance<ApplicationHost> {
        Instance::new(ApplicationHost {
            owner: self.services.owner.clone(),
            client: ApplicationClient::Ui(self.services.clone()),
            initial_session: self.initial_session.clone(),
        })
    }

    #[getter]
    pub fn imports(&self) -> JsonValue {
        self.services.imports.clone()
    }

    pub async fn query(
        this: Instance<Self>,
        locator: String,
        method: String,
        input: JsonValue,
    ) -> Result<JsonValue, String> {
        let services = this.with(|scope| scope.services.clone());
        drop(this);
        execute(services.owner.clone(), async move {
            let (client, endpoint) = services.resolve(&locator).await?;
            client.query(&endpoint, &method, input).await
        })
        .await
    }

    pub async fn subscribe(
        this: Instance<Self>,
        locator: String,
        method: String,
        input: JsonValue,
    ) -> Result<Instance<ScopedSubscription>, String> {
        let services = this.with(|scope| scope.services.clone());
        drop(this);
        let subscription = execute(services.owner.clone(), async move {
            let (client, endpoint) = services.resolve(&locator).await?;
            let subscription = client.subscribe(&endpoint, &method, input).await?;
            Ok(ScopedSubscription {
                owner: services.owner.clone(),
                subscription: Arc::new(subscription),
                kind: SubscriptionKind::Events,
            })
        })
        .await?;
        Ok(Instance::new(subscription))
    }

    pub async fn mutation(
        this: Instance<Self>,
        locator: String,
        method: String,
        input: JsonValue,
    ) -> Result<JsonValue, String> {
        let services = this.with(|scope| scope.services.clone());
        drop(this);
        execute(services.owner.clone(), async move {
            let correlation = services.correlation(&locator)?;
            let (client, endpoint) = services.resolve(&locator).await?;
            let id = Uuid::new_v4();
            let mutation = client
                .mutation(
                    id,
                    &endpoint,
                    &method,
                    input,
                    Default::default(),
                    None,
                    correlation,
                )
                .await?;
            mutation.prepare().await?;
            let reply = mutation.confirm().await?;
            Ok(json!({"operationId":id, "reply":reply}))
        })
        .await
    }

    pub async fn begin_mutation(
        this: Instance<Self>,
        locator: String,
        method: String,
        input: JsonValue,
    ) -> Result<Instance<OriginalMutation>, String> {
        let services = this.with(|scope| scope.services.clone());
        drop(this);
        let original = execute(services.owner.clone(), async move {
            let correlation = services.correlation(&locator)?;
            let (client, endpoint) = services.resolve(&locator).await?;
            let mutation = client
                .mutation(
                    Uuid::new_v4(),
                    &endpoint,
                    &method,
                    input,
                    Default::default(),
                    None,
                    correlation,
                )
                .await?;
            mutation.prepare().await?;
            Ok(OriginalMutation::new(services.owner.clone(), mutation))
        })
        .await?;
        Ok(Instance::new(original))
    }

    pub async fn pending(this: Instance<Self>) -> Result<JsonValue, String> {
        let services = this.with(|scope| scope.services.clone());
        drop(this);
        execute(services.owner.clone(), async move {
            services.ensure_open()?;
            let operations = services.owner.client.pending_ui(&services.instance).await?;
            serde_json::to_value(operations).map_err(|error| error.to_string())
        })
        .await
    }

    pub async fn recover(this: Instance<Self>, operation_id: String) -> Result<JsonValue, String> {
        let services = this.with(|scope| scope.services.clone());
        drop(this);
        let id = Uuid::parse_str(&operation_id).map_err(|error| error.to_string())?;
        execute(services.owner.clone(), async move {
            services.ensure_open()?;
            services
                .owner
                .client
                .operation_for_ui(&services.instance, id)
                .await?;
            let reply = services.owner.client.recover(id).await?;
            serde_json::to_value(reply).map_err(|error| error.to_string())
        })
        .await
    }

    pub async fn abandon(this: Instance<Self>, operation_id: String) -> Result<JsonValue, String> {
        let services = this.with(|scope| scope.services.clone());
        drop(this);
        let id = Uuid::parse_str(&operation_id).map_err(|error| error.to_string())?;
        execute(services.owner.clone(), async move {
            services.ensure_open()?;
            services
                .owner
                .client
                .operation_for_ui(&services.instance, id)
                .await?;
            let operation = services.owner.client.abandon_unprepared(id).await?;
            serde_json::to_value(operation).map_err(|error| error.to_string())
        })
        .await
    }

    pub async fn close(this: Instance<Self>) -> Result<(), String> {
        let services = this.with(|scope| scope.services.clone());
        drop(this);
        execute(
            services.owner.clone(),
            async move { services.close().await },
        )
        .await
    }
}
