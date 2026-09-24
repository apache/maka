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

mod terminal;
use crate::{Agent, settings::Manager};
use maka_plugins::{
    client::{Bundle, Client},
    composition::Scope,
    contributions::Staged,
    kernel::{Plugin, PluginContext},
    remote::{self, Caller, Endpoint, Handler, Method},
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

pub const ID: &str = "maka.external-agent";
pub struct Builtin {
    pub client: Option<Arc<Bundle>>,
}
struct ClientSupport(Arc<Bundle>);
pub fn client_service(package: &str) -> String {
    format!("{package}.client")
}

impl Plugin for Builtin {
    fn supports_scope(&self, scope: &Scope) -> bool {
        matches!(scope, Scope::Profile | Scope::Session(_))
            || (*scope == Scope::DesktopUi && self.client.is_some())
    }
    fn validate(&self, _: &Scope, config: &Value) -> Result<(), maka_plugins::Error> {
        if config.is_null() || config.as_object().is_some_and(|value| value.is_empty()) {
            Ok(())
        } else {
            Err(maka_plugins::Error::Invalid(
                "external agents are configured through Remote".into(),
            ))
        }
    }
    fn activate(
        &self,
        context: PluginContext,
        config: Value,
    ) -> futures_util::future::BoxFuture<'static, Result<Staged, String>> {
        let client = self.client.clone();
        Box::pin(async move {
            let identity = context.lifecycle.identity().map_err(message)?;
            let mut staged = Staged::default();
            if identity.scope == Scope::DesktopUi {
                let service = context
                    .services
                    .get::<ClientSupport>(&client_service(&identity.package_id))
                    .map_err(message)?
                    .ok_or("external agent backend is inactive")?;
                let bundle = service.acquire().map_err(message)?;
                staged
                    .insert(
                        identity.entry_id,
                        Client {
                            bundle: bundle.0.clone(),
                            config,
                        },
                    )
                    .map_err(message)?;
            } else {
                let host = context
                    .host
                    .ok_or("external agents require Host capabilities")?;
                let manager =
                    Manager::load(host, context.data, context.contributions, &mut staged).await?;
                let setup = Arc::new(crate::setup::Provider {
                    manager: manager.clone(),
                    context: context.lifecycle.clone(),
                });
                let handler = Arc::new(Management(manager));
                terminal::publish(
                    handler.clone(),
                    setup.clone(),
                    &identity.package_id,
                    &mut staged,
                )?;
                staged
                    .insert(
                        remote::key(&identity.package_id, "manage").map_err(message)?,
                        Endpoint::standalone(Handler::Method(handler.clone()))
                            .requiring_host_paths(),
                    )
                    .map_err(message)?;
                staged
                    .insert(
                        remote::key(&identity.package_id, "setup").map_err(message)?,
                        Endpoint::standalone(Handler::Stream(setup.clone())),
                    )
                    .map_err(message)?;
                if let Some(client) = client {
                    staged
                        .insert(
                            remote::key(&identity.package_id, "request").map_err(message)?,
                            Endpoint::new(client.content_digest.clone(), Handler::Method(handler))
                                .requiring_host_paths(),
                        )
                        .map_err(message)?;
                    staged
                        .insert(
                            remote::key(&identity.package_id, "setup-request").map_err(message)?,
                            Endpoint::new(client.content_digest.clone(), Handler::Stream(setup)),
                        )
                        .map_err(message)?;
                    context
                        .services
                        .provide(
                            &client_service(&identity.package_id),
                            Arc::new(ClientSupport(client)),
                        )
                        .map_err(message)?;
                }
            }
            Ok(staged)
        })
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Read,
    Configure {
        expected_revision: Option<u64>,
        agents: Vec<Agent>,
    },
    Schema,
    Reconcile,
}
pub(crate) struct Management(Arc<Manager>);
impl Method for Management {
    fn call(
        &self,
        input: Value,
        _: Caller,
    ) -> futures_util::future::BoxFuture<'static, Result<Value, remote::Error>> {
        let manager = self.0.clone();
        Box::pin(async move {
            let request: Request = serde_json::from_value(input)
                .map_err(|error| remote::Error::Invalid(error.to_string()))?;
            match request {
                Request::Read => manager.read().await.map_err(remote::Error::Provider),
                Request::Configure {
                    expected_revision,
                    agents,
                } => manager.configure(expected_revision, agents).await,
                Request::Reconcile => manager.reconcile().await,
                Request::Schema => serde_json::to_value(schemars::schema_for!(Request))
                    .map_err(|error| remote::Error::Provider(error.to_string())),
            }
        })
    }
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
