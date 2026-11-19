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

//! Scoped JavaScript execution for the Host runtime. Original Host contexts
//! retain all authorization and custody; the adapter exposes only their ABI.
use futures_util::future::BoxFuture;
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, Result,
    abi::{HostActivation, HostObservation, HostRequest},
    backend,
};
use maka_host_runtime::storage::StateChange;
use maka_js_runtime::plugin::{Captured, Limits, Vm};
use maka_plugin_core::{contract::Interface, package::EntryDeclaration, runtime::Published};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub fn factory(limits: Limits) -> Arc<dyn backend::Factory> {
    Arc::new(Factory(limits))
}
struct Factory(Limits);
impl backend::Factory for Factory {
    fn create(&self) -> Result<Arc<dyn backend::Realm>> {
        Vm::scoped(self.0.clone())
            .map(|vm| Arc::new(Realm(vm)) as Arc<dyn backend::Realm>)
            .map_err(message)
    }
}
struct Realm(Vm);
impl backend::Realm for Realm {
    fn load(&self, name: String, source: String) -> Result<Arc<dyn backend::Module>> {
        self.0
            .load(name, source)
            .map(|module| Arc::new(Module(module)) as Arc<dyn backend::Module>)
            .map_err(message)
    }
    fn is_terminated(&self) -> bool {
        self.0.is_terminated()
    }
    fn failed(&self) -> BoxFuture<'static, String> {
        let vm = self.0.clone();
        Box::pin(async move { vm.failed().await.to_string() })
    }
    fn shutdown(&self) -> BoxFuture<'static, ()> {
        let vm = self.0.clone();
        Box::pin(async move { vm.shutdown().await })
    }
}
struct Module(maka_js_runtime::plugin::Module);
impl backend::Module for Module {
    fn activate(
        &self,
        entry: Arc<EntryDeclaration>,
        configuration: Value,
    ) -> BoxFuture<'static, Result<backend::Exports>> {
        let module = self.0.clone();
        Box::pin(async move {
            let actual: BTreeMap<String, HostActivation> = serde_json::from_value(
                module
                    .call(vec!["activate".into()], vec![configuration])
                    .await
                    .map_err(message)?,
            )
            .map_err(message)?;
            entry
                .check_exports(&actual, |actual| &actual.contract)
                .map_err(message)?;
            let mut exports = BTreeMap::new();
            for (name, actual) in actual {
                let Interface::Service { methods } = &actual.contract.interface else {
                    return Err("Host export must declare a service".into());
                };
                if actual.service.is_empty() {
                    return Err("service namespace is missing".into());
                }
                let callbacks = module
                    .capture(actual.service, methods.keys().cloned().collect())
                    .await
                    .map_err(message)?;
                exports.insert(
                    name,
                    Published {
                        contract: actual.contract,
                        value: Arc::new(Service(callbacks)) as Arc<dyn Handler>,
                    },
                );
            }
            Ok(exports)
        })
    }
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        let module = self.0.clone();
        Box::pin(async move { module.close().await.map_err(message) })
    }
}
struct Service(Captured);
impl Handler for Service {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let callbacks = self.0.clone();
        Box::pin(async move {
            let observation = serde_json::to_value(HostObservation {
                source: context.scope().identity.clone(),
                operation: context.operation().cloned(),
            })
            .map_err(|error| HandlerError::Unknown {
                diagnostic: error.to_string(),
            })?;
            let request = Arc::new(Request {
                context,
                completion: Mutex::new(None),
            });
            let value = callbacks
                .call_with_context(&method, vec![input, observation], request.clone())
                .await
                .map_err(|error| match error {
                    maka_js_runtime::plugin::Error::Rejected { diagnostic } => {
                        HandlerError::Returned { diagnostic }
                    }
                    maka_js_runtime::plugin::Error::Unavailable { diagnostic } => {
                        HandlerError::Unknown { diagnostic }
                    }
                })?;
            let completion = request
                .completion
                .lock()
                .expect("state completion lock poisoned")
                .take();
            match completion {
                Some((declared, state)) if declared == value => {
                    Ok(HandlerValue::Commit { value, state })
                }
                Some(_) => Err(HandlerError::Returned {
                    diagnostic: "callback output does not match its sealed state completion".into(),
                }),
                None => Ok(HandlerValue::Json(value)),
            }
        })
    }
}
struct Request {
    context: Context,
    completion: Mutex<Option<(Value, StateChange)>>,
}
impl maka_js_runtime::plugin::RequestBridge for Request {
    fn invoke(
        &self,
        input: Value,
    ) -> BoxFuture<'static, std::result::Result<Value, maka_js_runtime::plugin::Error>> {
        let request = (|| {
            let operation: HostRequest = serde_json::from_value(input).map_err(message)?;
            // Serialize the last descriptor with admission, not asynchronous work.
            // Previously accepted requests retain their own original Scope tickets.
            let mut completion = self
                .completion
                .lock()
                .expect("state completion lock poisoned");
            if completion.is_some() {
                return Err("callback state completion is already sealed".to_string());
            }
            match operation {
                HostRequest::CompleteState { mutations, value } => {
                    let state = self.context.prepare_state(mutations)?;
                    *completion = Some((value.clone(), state));
                    Ok(Box::pin(async move { Ok(value) }) as BoxFuture<'static, Result<Value>>)
                }
                operation => Ok(self.context.request(operation)),
            }
        })();
        Box::pin(async move {
            request
                .map_err(|error| maka_js_runtime::plugin::Error::Rejected {
                    diagnostic: error.to_string(),
                })?
                .await
                .map_err(|diagnostic| maka_js_runtime::plugin::Error::Rejected { diagnostic })
        })
    }
}
fn message(error: impl ToString) -> String {
    error.to_string()
}
