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

//! Revocation custody for an already admitted fixed Mac monitor resource.

use super::{Computer, admission::Gate, api, app_access, sessions::Epoch};
use futures_util::FutureExt;
use maka_agent_facts::{event::Invocation, tools::ToolError, workspace::PermissionBasis};
use maka_computer_use::{
    ComputerAppTarget, NativeMonitorAuthority, NativeMonitorFuture, NativeMonitorPermit,
    NativeMonitorResource,
};
use std::sync::{Arc, Mutex};

type Retirement = super::sessions::Retirement;

pub(super) struct Receipt {
    root: Arc<maka_event_log::RootStore>,
    invocation: Invocation,
    operation: String,
    basis: PermissionBasis,
    subject: ComputerAppTarget,
    cleanup: Arc<super::sessions::TurnCleanup>,
    vm: Arc<Gate>,
    admission: Arc<Gate>,
    resource: Mutex<Option<Arc<dyn NativeMonitorResource>>>,
    attaching: tokio::sync::Mutex<()>,
    retirement: Mutex<Option<Retirement>>,
    tasks: tokio_util::task::TaskTracker,
    stopping: tokio_util::sync::CancellationToken,
    changed: Arc<tokio::sync::Notify>,
}

impl Receipt {
    async fn current(&self) -> Result<(), ToolError> {
        self.vm.check_open()?;
        self.cleanup.check_native_monitor_admission()?;
        self.admission.check_open()?;
        if self.stopping.is_cancelled() {
            return Err(super::failed("Computer owner is closing"));
        }
        let store = self
            .root
            .session(&self.invocation.session_id)
            .await
            .map_err(|error| ToolError::Persistence(super::message(error)))?;
        let projection = store
            .session_projection::<maka_agent_api::session::StoredSessionConfiguration>(
                &self.invocation.session_id,
            )
            .await
            .map_err(|error| ToolError::Persistence(super::message(error)))?
            .filter(|projection| !projection.session.archived)
            .ok_or_else(|| super::failed("Native monitor Session retired"))?;
        if !projection.root_turn.as_ref().is_some_and(|turn| {
            turn.invocation.turn_id == self.invocation.turn_id
                && turn.state.terminal_outcome().is_none()
        }) {
            return Err(super::failed("Native monitor turn retired"));
        }
        let configuration = maka_agent_authority::permissions::resolve_session(projection.session)
            .map_err(|error| ToolError::Persistence(super::message(error)))?
            .configuration;
        if configuration.permission_basis() != self.basis
            || configuration.permissions.access
                == maka_agent_api::contract::WorkspaceAccess::ReadOnly
            || configuration
                .tools
                .as_ref()
                .is_some_and(|tools| !tools.iter().any(|tool| tool == "cua_repl"))
        {
            return Err(super::failed("Native monitor permission boundary changed"));
        }
        if configuration.permissions.access
            != maka_agent_api::contract::WorkspaceAccess::DangerFullAccess
        {
            let global = store
                .client_capability_grant(&self.invocation.session_id, &api::target())
                .await
                .map_err(|error| ToolError::Persistence(super::message(error)))?;
            if global.is_none_or(|grant| grant.basis != Some(self.basis)) {
                return Err(super::failed("Computer Use grant was revoked"));
            }
        }
        let target = app_access::target(&self.subject);
        if !store
            .computer_app_granted(&self.invocation, &self.operation, &target, &self.basis)
            .await
            .map_err(|error| ToolError::Persistence(super::message(error)))?
            || store
                .computer_app_stopped(&self.invocation, &target, &self.subject.display)
                .await
                .map_err(|error| ToolError::Persistence(super::message(error)))?
        {
            return Err(super::failed("Native monitor app authority retired"));
        }
        Ok(())
    }

    fn seal(&self) {
        self.admission.close_admission();
        let resource = self
            .resource
            .lock()
            .expect("Native monitor resource lock poisoned")
            .clone();
        if let Some(resource) = resource {
            resource.seal_admission();
        }
    }

    pub(super) fn retire(self: &Arc<Self>) -> Retirement {
        self.seal();
        let mut retirement = self
            .retirement
            .lock()
            .expect("Native monitor retirement lock poisoned");
        if let Some(original) = retirement.as_ref() {
            return original.clone();
        }
        let receipt = self.clone();
        let future = async move {
            let resource = receipt
                .resource
                .lock()
                .expect("Native monitor resource lock poisoned")
                .clone();
            let close = async move {
                match resource {
                    Some(resource) => resource.close().await,
                    None => Ok(()), // No resource was attached, so callbacks could never be admitted.
                }
            };
            let (native, admitted) = tokio::join!(close, receipt.admission.seal());
            match (native, admitted) {
                (Ok(()), result) | (result, Ok(())) => result,
                (Err(native), Err(admitted)) => Err(ToolError::CleanupUnconfirmed(format!(
                    "{native}; {admitted}"
                ))),
            }
        }
        .boxed()
        .shared();
        let drive = future.clone();
        self.tasks.spawn(async move {
            let _ = drive.await;
        });
        *retirement = Some(future.clone());
        future
    }
}

struct Permit {
    receipt: Option<super::admission::Receipt>,
    changed: Arc<tokio::sync::Notify>,
}
impl NativeMonitorPermit for Permit {
    fn complete(mut self: Box<Self>, result: Result<(), ToolError>) {
        if let Some(receipt) = self.receipt.take() {
            match result {
                Ok(()) => receipt.complete_call(),
                Err(error) => {
                    receipt.fail(error);
                    self.changed.notify_one();
                }
            }
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        if let Some(receipt) = self.receipt.take() {
            receipt.fail(ToolError::CleanupUnconfirmed(
                "Native monitor callback lost its actual terminal result".into(),
            ));
            self.changed.notify_one();
        }
    }
}

impl NativeMonitorAuthority for Receipt {
    fn subject(&self) -> &ComputerAppTarget {
        &self.subject
    }

    fn attach(self: Arc<Self>, resource: Arc<dyn NativeMonitorResource>) -> NativeMonitorFuture {
        Box::pin(async move {
            let _attaching = self.attaching.lock().await;
            let mut current = self.current().await;
            let original = self
                .resource
                .lock()
                .expect("Native monitor resource lock poisoned")
                .clone();
            if current.is_ok()
                && let Some(original) =
                    original.filter(|original| !Arc::ptr_eq(original, &resource))
            {
                original.seal_admission();
                current = original.close().await;
                if current.is_ok() {
                    current = self.current().await;
                }
            }
            if current.is_err() {
                self.admission.close_admission();
            }
            let installed = {
                let mut slot = self
                    .resource
                    .lock()
                    .expect("Native monitor resource lock poisoned");
                current
                    .and_then(|()| self.vm.check_open())
                    .and_then(|()| self.cleanup.check_native_monitor_admission())
                    .and_then(|()| self.admission.check_open())
                    .inspect(|_| {
                        *slot = Some(resource.clone());
                    })
            };
            if let Err(error) = installed {
                resource.seal_admission();
                let close = resource.close().await;
                let original = self.retire().await;
                let cleanup = match (close, original) {
                    (Ok(()), result) | (result, Ok(())) => result,
                    (Err(close), Err(original)) => Err(ToolError::CleanupUnconfirmed(format!(
                        "{close}; {original}"
                    ))),
                };
                if let Err(cleanup) = cleanup {
                    return Err(ToolError::CleanupUnconfirmed(format!("{error}; {cleanup}")));
                }
                return Err(error);
            }
            Ok(())
        })
    }

    fn try_admit(&self) -> Result<Box<dyn NativeMonitorPermit>, ToolError> {
        self.vm.check_open()?;
        self.cleanup.check_native_monitor_admission()?;
        if self.stopping.is_cancelled() {
            return Err(super::failed("Computer owner is closing"));
        }
        if self
            .resource
            .lock()
            .expect("Native monitor resource lock poisoned")
            .is_none()
        {
            return Err(super::failed(
                "Native monitor has no Host-attached resource",
            ));
        }
        let receipt = self.admission.register()?;
        if let Err(error) = self
            .vm
            .check_open()
            .and_then(|()| self.cleanup.check_native_monitor_admission())
        {
            receipt.complete_call();
            return Err(error);
        }
        if self.stopping.is_cancelled() {
            receipt.complete_call();
            return Err(super::failed("Computer owner is closing"));
        }
        Ok(Box::new(Permit {
            receipt: Some(receipt),
            changed: self.changed.clone(),
        }))
    }
}

impl Epoch {
    /// Called only inside the original T1-admitted fixed native effect.
    pub(super) fn native_monitor_authority(
        &self,
        owner: &Arc<Computer>,
        vm: Arc<Gate>,
        invocation: Invocation,
        operation: String,
        basis: PermissionBasis,
        subject: ComputerAppTarget,
    ) -> Result<Arc<dyn NativeMonitorAuthority>, ToolError> {
        vm.check_open()?;
        let cleanup = self.native_monitor_turn(&invocation.turn_id)?;
        let mut receipts = self
            .native_monitors
            .lock()
            .expect("Native monitor receipt lock poisoned");
        if let Some(receipt) = receipts.iter().find(|receipt| {
            Arc::ptr_eq(&receipt.vm, &vm)
                && Arc::ptr_eq(&receipt.cleanup, &cleanup)
                && receipt.basis == basis
                && receipt.invocation == invocation
                && receipt.subject.matches_resolved(&subject)
        }) {
            if receipt.admission.check_open().is_ok() {
                return Ok(receipt.clone());
            }
            let retired = receipt
                .retirement
                .lock()
                .expect("Native monitor retirement lock poisoned")
                .as_ref()
                .and_then(|future| future.peek().cloned());
            match retired {
                Some(Ok(())) => {}
                Some(Err(error)) => return Err(error),
                None => {
                    return Err(ToolError::CleanupUnconfirmed(
                        "Previous native monitor use has not retired".into(),
                    ));
                }
            }
        }
        receipts.retain(|receipt| {
            !matches!(
                receipt
                    .retirement
                    .lock()
                    .expect("Native monitor retirement lock poisoned")
                    .as_ref()
                    .and_then(|future| future.peek()),
                Some(Ok(()))
            )
        });
        let receipt = Arc::new(Receipt {
            root: owner.store.clone(),
            invocation,
            operation,
            basis,
            subject,
            cleanup,
            vm,
            admission: Arc::default(),
            resource: Mutex::new(None),
            attaching: tokio::sync::Mutex::new(()),
            retirement: Mutex::new(None),
            tasks: owner.tasks.clone(),
            stopping: owner.stopping.clone(),
            changed: self.effects_changed.clone(),
        });
        receipts.push(receipt.clone());
        self.effects_changed.notify_one();
        Ok(receipt)
    }

    pub(super) fn seal_native_monitors(&self, turn: Option<&str>) {
        let receipts = self
            .native_monitors
            .lock()
            .expect("Native monitor receipt lock poisoned")
            .iter()
            .filter(|receipt| turn.is_none_or(|turn| receipt.invocation.turn_id == turn))
            .cloned()
            .collect::<Vec<_>>();
        for receipt in receipts {
            receipt.seal();
        }
    }

    pub(super) async fn retire_native_monitors(&self, turn: Option<&str>) -> Result<(), ToolError> {
        let receipts = self
            .native_monitors
            .lock()
            .expect("Native monitor receipt lock poisoned")
            .iter()
            .filter(|receipt| turn.is_none_or(|turn| receipt.invocation.turn_id == turn))
            .cloned()
            .collect::<Vec<_>>();
        // Seal every producer before awaiting any sibling's original cleanup.
        for receipt in &receipts {
            receipt.seal();
        }
        let mut failure = None;
        for receipt in receipts {
            if let Err(error) = receipt.retire().await {
                failure = Some(match failure {
                    None => error,
                    Some(previous) => ToolError::CleanupUnconfirmed(format!("{previous}; {error}")),
                });
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub(super) async fn observe_native_monitor_authority(&self) {
        let receipts = self
            .native_monitors
            .lock()
            .expect("Native monitor receipt lock poisoned")
            .clone();
        for receipt in receipts {
            if receipt.current().await.is_err() {
                drop(receipt.retire());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_api::contract::{WorkspaceAccess, WorkspacePermissions};
    use maka_agent_facts::interaction::{
        ComputerAppDisplay, ComputerAppIdentity, ComputerAppPlatform,
    };

    #[tokio::test]
    async fn full_access_monitor_needs_no_consent_but_retires_with_its_turn() {
        let fixture = super::super::browser_access::tests::Fixture::with_permissions(
            false,
            true,
            WorkspacePermissions {
                access: WorkspaceAccess::DangerFullAccess,
                request_permissions: false,
            },
        )
        .await;
        let receipt = Receipt {
            root: fixture.owner.store.clone(),
            invocation: fixture.invocation.clone(),
            operation: "native-monitor".into(),
            basis: fixture.basis(),
            subject: ComputerAppTarget {
                identity: ComputerAppIdentity {
                    platform: ComputerAppPlatform::Macos,
                    application_id: "fixture.application".into(),
                },
                display: ComputerAppDisplay {
                    name: "Fixture application".into(),
                    app_path: "/Applications/Fixture.app".into(),
                    risk: None,
                    warning: None,
                },
                allow_always: false,
                binding: None,
            },
            cleanup: Arc::default(),
            vm: Arc::default(),
            admission: Arc::default(),
            resource: Mutex::new(None),
            attaching: tokio::sync::Mutex::new(()),
            retirement: Mutex::new(None),
            tasks: fixture.owner.tasks.clone(),
            stopping: fixture.owner.stopping.clone(),
            changed: Arc::default(),
        };
        receipt.current().await.unwrap();
        fixture.end().await;
        assert!(receipt.current().await.is_err());
        fixture.close().await;
    }
}
