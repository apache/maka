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

use super::{OriginalMutation, Owner, ScopedSubscription, SubscriptionKind, execute};
use maka_app_client::Client;
use maka_plugin_core::{composition::InstanceId, deployment::DeploymentRef};
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
    services: Arc<Services>,
}
struct Services {
    owner: Arc<Owner>,
    instance: InstanceId,
    binding_basis: String,
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
}

impl UiScope {
    pub(super) fn new(
        owner: Arc<Owner>,
        source: DeploymentRef,
        instance: InstanceId,
        binding_basis: String,
    ) -> Result<Self, String> {
        instance.validate().map_err(|error| error.to_string())?;
        let (current, metadata) = owner
            .plugins
            .current_ui(&instance)
            .ok_or("UI instance is no longer active")?;
        if source.state_domain != current.state_domain || source.deployment != current.deployment {
            return Err("UI bindings belong to another deployment".into());
        }
        if metadata.binding_basis != binding_basis {
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
            services: Arc::new(Services {
                owner,
                instance,
                binding_basis,
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
    fn ensure_open(&self) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("UI service scope is closed".into());
        }
        Ok(())
    }

    fn current_source(&self) -> Result<DeploymentRef, String> {
        self.ensure_open()?;
        let (source, metadata) = self
            .owner
            .plugins
            .current_ui(&self.instance)
            .ok_or("UI service scope is no longer active")?;
        if metadata.binding_basis != self.binding_basis {
            return Err("UI service scope belongs to a retired binding generation".into());
        }
        Ok(source)
    }

    async fn resolve(&self, locator: &str) -> Result<(Client, String), String> {
        let selection = self
            .routes
            .get(locator)
            .ok_or("Unknown UI service locator")?;
        let mut binding = self.binding.lock().await;
        loop {
            let source = self.current_source()?;
            if binding
                .as_ref()
                .is_some_and(|bound| bound.client.binding_retired())
            {
                let old = binding.take().expect("retired binding checked above");
                let _ = self.owner.spawn(async move { old.client.retire().await });
            }
            if binding.is_none() {
                let captured = self
                    .owner
                    .client
                    .bind_ui(source.clone(), self.instance.clone())
                    .await;
                match (captured, self.current_source()) {
                    (Ok((client, imports)), Ok(_)) => {
                        *binding = Some(Binding { client, imports });
                    }
                    (Ok((client, _)), Err(error)) => {
                        let _ = self.owner.spawn(async move { client.retire().await });
                        return Err(error);
                    }
                    (Err(_), Ok(latest)) if latest != source => continue,
                    (Err(error), Ok(_)) | (_, Err(error)) => return Err(error),
                }
            }
            let bound = binding.as_ref().expect("UI session captured above");
            let endpoint = bound
                .imports
                .get(&selection.import)
                .and_then(|endpoints| endpoints.get(selection.index))
                .ok_or("Host omitted a declared UI service binding")?;
            return Ok((bound.client.clone(), endpoint.clone()));
        }
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

    async fn close(&self) -> Result<(), String> {
        self.closed.store(true, Ordering::Release);
        self.cleanup
            .get_or_init(|| async {
                if let Some(binding) = self.binding.lock().await.take() {
                    binding.client.retire().await?;
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
