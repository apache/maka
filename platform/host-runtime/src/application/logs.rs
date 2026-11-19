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

//! Explicitly granted reads of the original Root's fixed raw stderr capture.

use super::*;
use crate::logs::{HostLogPage, HostLogRequest, Source};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use serde::Deserialize;

pub const HOST_LOGS: &str = "maka.host.logs";

struct Logs(Source);
impl Handler for Logs {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let source = self.0.clone();
        let result = async move {
            let request: HostLogRequest =
                serde_json::from_value(input).map_err(|error| error.to_string())?;
            match method.as_str() {
                "read" => page(
                    source
                        .read(request)
                        .await
                        .map_err(|error| error.to_string())?,
                ),
                "watch" => {
                    source
                        .watch(request, context.scope().cancellation.clone(), |value| {
                            let emitted = page(value).map(|value| context.emit(value));
                            async move {
                                emitted
                                    .map_err(std::io::Error::other)?
                                    .await
                                    .map_err(std::io::Error::other)
                            }
                        })
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(Value::Null)
                }
                _ => Err("unknown Host logs method".into()),
            }
        };
        Box::pin(async move {
            let result: std::result::Result<Value, String> = result.await;
            result.map(HandlerValue::Json).map_err(HandlerError::from)
        })
    }
}
fn page(page: HostLogPage) -> Result<Value> {
    let value = serde_json::to_value(page).map_err(|error| error.to_string())?;
    maka_plugin_core::json::check_delivery(&value, 48 * 1024)?;
    Ok(value)
}

pub(super) fn provide(native: &mut NativeRegistry) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Configuration {}
    native.insert(
        HOST_LOGS.into(),
        Arc::new(|context, configuration| {
            Box::pin(async move {
                let exports = (|| {
                    serde_json::from_value::<Configuration>(configuration)
                        .map_err(|error| error.to_string())?;
                    let persistence = context
                        .persistence()
                        .ok_or("Host logs require the original persisted Root")?;
                    let root = persistence
                        .store()
                        .owned_root()
                        .map_err(|error| error.to_string())?;
                    let source = Source::from_owner(&root).map_err(|error| error.to_string())?;
                    Ok(BTreeMap::from([(
                        "HostLogs".into(),
                        Published {
                            contract: contract(),
                            value: Arc::new(Logs(source)) as Arc<dyn Handler>,
                        },
                    )]))
                })();
                // Every read/follow belongs to its original Application invocation.
                NativeActivation {
                    exports,
                    owner: Arc::new(()),
                }
            })
        }),
    )
}

pub fn contract() -> Contract {
    let input = serde_json::to_value(schemars::schema_for!(HostLogRequest))
        .expect("Host log request schema");
    let output =
        serde_json::to_value(schemars::schema_for!(HostLogPage)).expect("Host log page schema");
    Contract {
        name: "maka.host.Logs".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: [
                ("read", MethodMode::Query),
                ("watch", MethodMode::Subscription),
            ]
            .into_iter()
            .map(|(name, mode)| {
                (
                    name.into(),
                    Method {
                        mode,
                        input: input.clone().into(),
                        output: output.clone().into(),
                        progress: None,
                        resources: BTreeMap::new(),
                    },
                )
            })
            .collect(),
        },
    }
}
pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        HOST_LOGS,
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [("HostLogs", contract())],
    )
}
