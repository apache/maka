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
use maka_host_runtime::application::{Context, HandlerError, HandlerResult};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use std::sync::atomic::AtomicUsize;

pub(super) fn contract() -> Contract {
    Contract{name:"maka.test.Dispatch".into(),version:1,transport:Transport::Local,
        interface:Interface::Service{methods:[("send".into(),Method{mode:MethodMode::Mutation,
        input:json!({"type":"object","properties":{"to":{"type":"string"}},"required":["to"],"additionalProperties":false}).into(),
        output:json!({}).into(),resources:BTreeMap::new(),progress:None})].into()}}
}
pub(super) fn definition() -> NativeDefinition {
    NativeDefinition::new(
        "maka.test.connector",
        json!({"type":"object","additionalProperties":false}),
        [("connector", contract())],
    )
}
pub(super) fn provide(
    registry: &mut NativeRegistry,
    count: Arc<AtomicUsize>,
) -> Result<(), String> {
    registry.insert(
        "maka.test.connector".into(),
        Arc::new(move |_, _| {
            let handler = Arc::new(Connector(count.clone()));
            Box::pin(async move {
                NativeActivation {
                    exports: Ok(BTreeMap::from([(
                        "connector".into(),
                        Published {
                            contract: contract(),
                            value: handler.clone() as Arc<dyn Handler>,
                        },
                    )])),
                    owner: handler,
                }
            })
        }),
    )
}
struct Connector(Arc<AtomicUsize>);
impl Handler for Connector {
    fn call(
        &self,
        _: String,
        input: Value,
        context: Context,
    ) -> futures_util::future::BoxFuture<'static, HandlerResult> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let receipt = context.operation().expect("confirmed native mutation");
            if input["to"] == "disconnect" {
                return Err(HandlerError::Unknown {
                    diagnostic: "delivery connection lost".into(),
                });
            }
            Ok(maka_host_runtime::application::HandlerValue::Json(
                json!({"to":input["to"],"operation":receipt.operation}),
            ))
        })
    }
}

impl maka_host_runtime::application::NativeOwner for Connector {
    fn execution_basis(&self) -> Option<Value> {
        Some(json!({"destination":"fixture outbox"}))
    }
    fn close(&self) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
