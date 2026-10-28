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
use maka_plugin_core::deployment::management::{UiCatalog, UiInstance, UiRead, UiWatch};

impl Manager {
    pub(super) async fn read_ui(&self, input: Value) -> Result<Value> {
        let request: UiRead = serde_json::from_value(input).map_err(|error| error.to_string())?;
        let loaded = self.source_at(request.source).await?;
        let plan = loaded.plan();
        let instances = plan
            .instances()
            .values()
            .filter(|instance| !instance.disabled)
            .filter_map(|instance| instance.ui_entry().map(|entry| (instance, entry)))
            .map(|(instance, entry)| {
                Ok(UiInstance {
                    instance: instance.identity.clone(),
                    binding_basis: plan
                        .binding_basis(&instance.identity)
                        .map_err(|error| error.to_string())?,
                    path: instance.path.clone(),
                    package: instance.package.clone(),
                    configuration: instance.configuration.clone(),
                    module: entry.module.clone(),
                    contributions: entry.contributions.clone(),
                    imports: instance
                        .bindings
                        .iter()
                        .map(|(name, bindings)| (name.clone(), bindings.len()))
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        serde_json::to_value(UiCatalog {
            source: loaded.source().reference.clone(),
            ui: plan.ui().cloned(),
            instances,
        })
        .map_err(|error| error.to_string())
    }

    pub(super) async fn watch(&self, input: Value, context: Context) -> Result<Value> {
        let request: UiWatch = serde_json::from_value(input).map_err(|error| error.to_string())?;
        if request.source.state_domain != self.source.state_domain
            || request.source.deployment != self.source.deployment
        {
            return Err("foreign managed deployment source".into());
        }
        let mut changes = self
            .store
            .subscribe_application(request.source)
            .map_err(|error| error.to_string())?;
        loop {
            let source = tokio::select! {
                biased;
                () = context.scope().cancellation.cancelled() => return Ok(Value::Null),
                source = changes.next() => source.map_err(|error| error.to_string())?,
            };
            context
                .emit(serde_json::to_value(source).map_err(|error| error.to_string())?)
                .await?;
        }
    }
}
