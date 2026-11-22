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
use super::{Command, Module, Result, failed, json};
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::oneshot;

pub(super) enum Target {
    Path(Vec<String>),
    Captured { callback: u64, method: String },
}

/// Exact functions and receiver retained in their original worker module.
/// Handles are not serializable and cannot address another module or VM.
#[derive(Clone)]
pub struct Captured(Arc<Owner>);
struct Owner {
    module: Module,
    id: u64,
    methods: BTreeSet<String>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.module.0.vm.0.commands.send(Command::ReleaseCaptured {
            module: self.module.0.id,
            callback: self.id,
        });
    }
}
impl Captured {
    pub(super) fn new(module: Module, id: u64, methods: Vec<String>) -> Self {
        Self(Arc::new(Owner {
            module,
            id,
            methods: methods.into_iter().collect(),
        }))
    }
    /// Calls may return a Promise. Dropping the waiting future does not cancel
    /// admitted work; the worker retains capacity until the actual call finishes.
    pub async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value> {
        self.invoke(method, args, None).await
    }

    /// Appends an unforgeable request context as the final argument. Its native
    /// bridge expires when the actual callback finishes, even if JS saves it.
    pub async fn call_with_context(
        &self,
        method: &str,
        args: Vec<Value>,
        bridge: Arc<dyn super::RequestBridge>,
    ) -> Result<Value> {
        if self.0.module.0.vm.0.realm != super::Realm::Scoped {
            return Err(failed("request contexts require a scoped VM"));
        }
        self.invoke(
            method,
            args,
            Some(Arc::new(super::request::Owner::new(bridge))),
        )
        .await
    }

    async fn invoke(
        &self,
        method: &str,
        args: Vec<Value>,
        context: Option<Arc<super::request::Owner>>,
    ) -> Result<Value> {
        if !self.0.methods.contains(method) {
            return Err(failed("method was not captured"));
        }
        let module = &self.0.module;
        module.ready().await?;
        let size = json::encoded_size(&(method, &args), usize::MAX).map_err(failed)?;
        let bytes = module
            .0
            .vm
            .0
            .bytes
            .clone()
            .try_acquire_many_owned(super::input_charge(size)?)
            .map_err(|_| failed("VM input budget exhausted"))?;
        let (reply, result) = oneshot::channel();
        module
            .0
            .vm
            .0
            .commands
            .send(Command::Call {
                module: module.clone(),
                target: Target::Captured {
                    callback: self.0.id,
                    method: method.into(),
                },
                args,
                context,
                reply,
                bytes,
            })
            .map_err(|_| module.0.vm.0.health.error())?;
        result.await.map_err(|_| module.0.vm.0.health.error())?
    }
}
impl Module {
    /// Capture actual receiver/functions before capability publication. Lookup
    /// executes under the worker's poll watchdog; namespace mutation afterwards
    /// never redirects this registration. Last handle drop releases its globals.
    pub async fn capture(&self, namespace: Vec<String>, methods: Vec<String>) -> Result<Captured> {
        self.ready().await?;
        if namespace.iter().any(|s| s.is_empty())
            || methods.is_empty()
            || methods.iter().any(|s| s.is_empty())
            || methods.iter().collect::<BTreeSet<_>>().len() != methods.len()
        {
            return Err(failed("invalid worker callback registration"));
        }
        let size = json::encoded_size(&(&namespace, &methods), usize::MAX).map_err(failed)?;
        let bytes = self
            .0
            .vm
            .0
            .bytes
            .clone()
            .try_acquire_many_owned(super::input_charge(size)?)
            .map_err(|_| failed("VM input budget exhausted"))?;
        let (reply, result) = oneshot::channel();
        self.0
            .vm
            .0
            .commands
            .send(Command::Capture {
                module: self.clone(),
                namespace,
                methods,
                reply,
                bytes,
            })
            .map_err(|_| self.0.vm.0.health.error())?;
        result.await.map_err(|_| self.0.vm.0.health.error())?
    }
}
