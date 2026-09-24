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

use crate::{
    decision::{Jev, SERVICE},
    settings::Repository,
};
use futures_util::future::BoxFuture;
use maka_plugins::{
    client::{Bundle, Client},
    composition::Scope,
    contributions::Staged,
    kernel::{Plugin, PluginContext},
};
use serde_json::Value;
use std::sync::Arc;
mod remote;
mod terminal;
pub const ID: &str = "maka.jev";
pub struct Builtin {
    pub client: Option<Arc<Bundle>>,
}
struct ClientSupport(Arc<Bundle>);
pub fn client_service(package: &str) -> String {
    format!("{package}.client")
}
impl Plugin for Builtin {
    fn supports_scope(&self, scope: &Scope) -> bool {
        *scope == Scope::Profile || (*scope == Scope::DesktopUi && self.client.is_some())
    }
    fn validate(&self, _: &Scope, value: &Value) -> Result<(), maka_plugins::Error> {
        if value.is_null() || value.as_object().is_some_and(|v| v.is_empty()) {
            Ok(())
        } else {
            Err(maka_plugins::Error::Invalid(
                "Jev settings are managed through its Remote interface".into(),
            ))
        }
    }
    fn activate(
        &self,
        context: PluginContext,
        config: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        let client = self.client.clone();
        Box::pin(async move {
            let identity = context.lifecycle.identity().map_err(message)?;
            let mut staged = Staged::default();
            if identity.scope == Scope::DesktopUi {
                let service = context
                    .services
                    .get::<ClientSupport>(&client_service(&identity.package_id))
                    .map_err(message)?
                    .ok_or("Jev backend is not active")?;
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
                let host = context.host.ok_or("Jev requires Host capabilities")?;
                let backend = Arc::new(Jev {
                    settings: Repository {
                        store: host.storage,
                        credentials: host.credentials,
                    },
                    http: host.http,
                    preferences: host.preferences,
                });
                context
                    .services
                    .provide_method(SERVICE, backend.clone())
                    .map_err(message)?;
                terminal::publish(backend.clone(), &mut staged)?;
                remote::publish(backend, client.as_deref(), &mut staged)?;
                if let Some(client) = client {
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
fn message(e: impl std::fmt::Display) -> String {
    e.to_string()
}
