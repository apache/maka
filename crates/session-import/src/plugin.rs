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

use futures_util::future::BoxFuture;
use maka_plugins::{
    client::{Bundle, Client},
    composition::Scope,
    contributions::Staged,
    kernel::{Plugin, PluginContext},
    remote::{Endpoint, Handler, key},
};
use serde_json::Value;
use std::sync::Arc;

pub const ID: &str = "maka.session-import";
pub struct Builtin {
    pub client: Arc<Bundle>,
}
struct ClientSupport(Arc<Bundle>);
pub fn client_service(package: &str) -> String {
    format!("{package}.client")
}

impl Plugin for Builtin {
    fn supports_scope(&self, scope: &Scope) -> bool {
        matches!(scope, Scope::Profile | Scope::DesktopUi)
    }
    fn validate(&self, _: &Scope, config: &Value) -> Result<(), maka_plugins::Error> {
        if config.is_null() || config.as_object().is_some_and(|object| object.is_empty()) {
            Ok(())
        } else {
            Err(maka_plugins::Error::Invalid(
                "Session import takes no instance configuration".into(),
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
                    .ok_or("Session import backend is not active")?;
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
                    .ok_or("Session import requires Host capabilities")?;
                let backend = Arc::new(crate::remote::Import::new(
                    host.storage,
                    host.executions,
                    host.models,
                ));
                staged
                    .insert(
                        key(&identity.package_id, "request").map_err(message)?,
                        Endpoint::new(
                            client.content_digest.clone(),
                            Handler::Method(backend.clone()),
                        )
                        .requiring_host_paths(),
                    )
                    .map_err(message)?;
                crate::terminal::publish(backend.clone(), &identity.package_id, &mut staged)?;
                // CLI and other clients consume the identical public handler.
                staged
                    .insert(
                        key(&identity.package_id, "manage").map_err(message)?,
                        Endpoint::standalone(Handler::Method(backend)).requiring_host_paths(),
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
            Ok(staged)
        })
    }
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
