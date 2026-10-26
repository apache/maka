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

// Controlled fixture driver. Production callers stay asynchronous; legacy
// transaction tests explicitly drain worker completion before inspecting facts.
use maka_plugin_core::{
    composition::{Input, PresentationTarget},
    runtime::Mount,
};
use maka_ui_runtime::{
    ExecutionOptions, NativeRegistry, Result,
    actions::{RemoteService, RemoteServices},
};
use serde_json::Value;
use std::{
    ops::{Deref, DerefMut},
    sync::Arc,
    task::Poll,
};

pub struct Application<V: ?Sized = ()>(maka_ui_runtime::Application<V>);
impl<V: ?Sized> Deref for Application<V> {
    type Target = maka_ui_runtime::Application<V>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl<V: ?Sized> DerefMut for Application<V> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl<V: ?Sized + 'static> Application<V> {
    pub fn new(
        input: &Input,
        packages: Vec<maka_packages::Package>,
        scheduler: tokio::runtime::Handle,
        execution: ExecutionOptions,
        native: NativeRegistry<V>,
        remotes: RemoteServices,
    ) -> Result<Self> {
        let mut inner = maka_ui_runtime::Application::new(
            input,
            packages,
            scheduler.clone(),
            execution,
            native,
            remotes,
        )?;
        scheduler.block_on(inner.wait_ready())?;
        Ok(Self(inner))
    }
    pub async fn start_from_store(
        store: Arc<maka_event_log::RootStore>,
        source: maka_plugin_core::deployment::DeploymentRef,
        target: PresentationTarget,
        scheduler: tokio::runtime::Handle,
        execution: ExecutionOptions,
        native: NativeRegistry<V>,
        registrations: Vec<RemoteService>,
    ) -> Result<Self> {
        Ok(Self(
            maka_ui_runtime::Application::start_from_store(
                store,
                source,
                target,
                scheduler,
                execution,
                native,
                registrations,
            )
            .await?,
        ))
    }
    pub fn mount_launch(&mut self, props: Value) -> Result<Mount> {
        let mount = self.0.mount_launch(props)?;
        self.0.scheduler().clone().block_on(self.0.wait_idle())?;
        Ok(mount)
    }
    pub fn mount_bootstrap(&mut self, props: Value) -> Result<Mount> {
        self.0
            .scheduler()
            .clone()
            .block_on(self.0.mount_bootstrap_ready(props))
    }
    pub fn dispatch(
        &mut self,
        mount: &Mount,
        revision: u64,
        key: &str,
        event: Value,
    ) -> Result<()> {
        self.0.dispatch(mount, revision, key, event)?;
        self.0.scheduler().clone().block_on(self.0.wait_idle())
    }
    pub fn advance_deployment(&mut self) -> Result<()> {
        let scheduler = self.0.scheduler().clone();
        scheduler.block_on(std::future::poll_fn(|cx| {
            self.0.set_waker(cx.waker().clone());
            if let Err(error) = self.0.advance_deployment() {
                return Poll::Ready(Err(error));
            }
            let status = self.0.deployment_status();
            // Physical acknowledgements and accepted service work are supplied
            // explicitly by each fixture, rather than fabricated by this driver.
            if !status.converging
                || status.error.is_some()
                || !self.0.retiring_mounts().is_empty()
                || self.0.accepted_action_count() != 0
            {
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            }
        }))
    }
    pub fn deliver_action_results(
        &mut self,
        root: &Mount,
        mut valid: impl FnMut(
            &maka_ui_runtime::actions::CaptureTarget,
            &V,
            &maka_ui_runtime::actions::ContinuationWitness,
        ) -> Result<bool>,
    ) -> Result<usize> {
        let mut count = 0;
        loop {
            self.0.scheduler().clone().block_on(self.0.wait_idle())?;
            let delivered = self.0.deliver_action_results(root, &mut valid)?;
            count += delivered;
            if delivered == 0 {
                return Ok(count);
            }
        }
    }
    pub fn shutdown(&mut self) -> Result<()> {
        if !self.0.can_shutdown() {
            return self.0.shutdown();
        }
        let scheduler = self.0.scheduler().clone();
        scheduler.block_on(std::future::poll_fn(|cx| {
            self.0.set_waker(cx.waker().clone());
            match self.0.shutdown() {
                Err(maka_ui_runtime::Error::Core(maka_plugin_core::Error::CleanupPending)) => {
                    Poll::Pending
                }
                result => Poll::Ready(result),
            }
        }))
    }
}
