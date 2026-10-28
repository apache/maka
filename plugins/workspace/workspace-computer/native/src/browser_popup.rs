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

//! Fresh Host work from an existing browser lease, outside an Agent Run.

use super::{Computer, admission, browser_access, failed, message};
use maka_agent_facts::tools::ToolError;
use maka_capabilities::authorization::{Boundary, SessionBoundary};
use maka_computer_use::{
    AuthorizationFuture, BrowserAccess, BrowserAttachmentAuthorization, BrowserAttachmentOrigin,
    BrowserAuthorization, BrowserHostEffects, BrowserLeaseChildRequest, BrowserSessionPreparation,
    InvocationContext,
};
use maka_event_log::effects::{NativeOwner, Operation, Outcome, Owner, Request};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Actual immutable native activation provenance, captured by its factory.
/// There is no synthetic resource generation or inherited Agent operation.
pub(super) struct Provenance {
    package_id: String,
    entry_id: String,
    source: maka_plugin_core::deployment::DeploymentRef,
    epoch: uuid::Uuid,
}
impl Provenance {
    pub(super) fn capture(
        context: &maka_host_runtime::application::NativeContext,
    ) -> Result<Self, String> {
        let persistence = context
            .persistence()
            .ok_or("browser popup service requires native persistence")?;
        Ok(Self {
            package_id: context.package().id.clone(),
            entry_id: serde_json::to_string(context.activation().instance()).map_err(message)?,
            source: persistence.source().clone(),
            epoch: context.activation().epoch(),
        })
    }
    fn owner(&self, session: &str) -> Owner {
        Owner::Native(NativeOwner {
            package_id: self.package_id.clone(),
            entry_id: self.entry_id.clone(),
            scope: maka_plugin_core::scope::Scope::Session(session.to_owned()),
            source: self.source.clone(),
            epoch: self.epoch,
        })
    }
}

/// This scope permits only the retained page request's physical navigation.
/// It neither prompts for nor records a destination content-read grant.
#[derive(Clone)]
pub(super) struct Authorization {
    attachment: Arc<browser_access::Attachment>,
    browser: String,
    requested_url: String,
    preparation: Option<PreparationIdentity>,
}

#[derive(Clone)]
struct PreparationIdentity {
    operation: String,
    native_owner: uuid::Uuid,
    native_epoch: String,
    generation: String,
    active: CancellationToken,
}

impl Authorization {
    pub(super) fn new(
        attachment: Arc<browser_access::Attachment>,
        browser: String,
        requested_url: String,
    ) -> Self {
        Self {
            attachment,
            browser,
            requested_url,
            preparation: None,
        }
    }

    fn with_session_preparation(
        mut self,
        request: &BrowserLeaseChildRequest,
        operation: String,
        active: CancellationToken,
    ) -> Self {
        self.preparation = Some(PreparationIdentity {
            operation,
            native_owner: request.native_owner,
            native_epoch: request.native_epoch.clone(),
            generation: request.generation.clone(),
            active,
        });
        self
    }

    async fn session_preparation_current(
        &self,
        preparation: BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> Result<(), ToolError> {
        let expected = self
            .preparation
            .as_ref()
            .ok_or_else(|| failed("Browser lease-child preparation has no actual Host receipt"))?;
        if expected.active.is_cancelled() {
            return Err(failed(
                "Browser lease-child preparation operation has finished",
            ));
        }
        if preparation.browser_id != self.browser
            || preparation.generation != expected.generation
            || preparation.native_owner != expected.native_owner
            || preparation.native_epoch != expected.native_epoch
        {
            return Err(failed(
                "Browser lease-child preparation changed its captured native binding",
            ));
        }
        // These are the service's captured routing fields, not proof of a
        // source/child lease. Main independently validates actual retained
        // source intent, creation receipt and the issued native call ledger.
        self.attachment
            .session_preparation_current(&preparation, &expected.operation, &cancellation)
            .await?;
        if expected.active.is_cancelled() {
            return Err(failed(
                "Browser lease-child preparation operation has finished",
            ));
        }
        Ok(())
    }

    async fn current(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> Result<(), ToolError> {
        if access.document().browser_id != self.browser {
            return Err(failed("Browser lease-child scope changed its provider"));
        }
        let owner = self.attachment.alive(&cancellation)?;
        match &access {
            BrowserAccess::Metadata { .. } => {
                self.attachment.current_global(&owner).await?;
            }
            BrowserAccess::ReadDocument {
                origin: BrowserAttachmentOrigin::Opaque,
                ..
            } => {
                // Only Main's fixed origin getter can produce this admitted
                // proof in the child path. Its URL is not an origin authority.
                self.attachment.current_global(&owner).await?;
            }
            BrowserAccess::Navigate { url, .. } if url == &self.requested_url => {
                let configuration = self.attachment.current_global(&owner).await?;
                if let Some(origin) = access.origin()? {
                    browser_access::network_allowed(&configuration, &origin).await?;
                }
                self.attachment.current_global(&owner).await?;
            }
            BrowserAccess::Download { .. } => {
                return Err(failed("A popup lease does not authorize file transfer"));
            }
            BrowserAccess::Navigate { .. } => {
                return Err(failed(
                    "Browser lease-child navigation differs from its retained page request",
                ));
            }
            _ => {
                let origin = access
                    .origin()?
                    .ok_or_else(|| failed("Browser content lacks a verified site origin"))?;
                self.attachment
                    .check(BrowserAttachmentOrigin::Site(origin), cancellation.clone())
                    .await?;
            }
        }
        self.attachment.alive(&cancellation)?;
        Ok(())
    }
}
impl BrowserAuthorization for Authorization {
    fn authorize_session_preparation(
        &self,
        preparation: BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let scope = self.clone();
        Box::pin(async move {
            scope
                .session_preparation_current(preparation, cancellation)
                .await
        })
    }

    fn check_session_preparation(
        &self,
        preparation: BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let scope = self.clone();
        Box::pin(async move {
            scope
                .session_preparation_current(preparation, cancellation)
                .await
        })
    }

    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let scope = self.clone();
        Box::pin(async move { scope.current(access, cancellation).await })
    }
    fn check(&self, access: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture {
        let scope = self.clone();
        Box::pin(async move { scope.current(access, cancellation).await })
    }
    fn attachment(&self) -> Option<Arc<dyn BrowserAttachmentAuthorization>> {
        Some(self.attachment.clone())
    }
}

async fn boundary(
    owner: &Computer,
    attachment: &browser_access::Attachment,
) -> Result<(Boundary, maka_agent_facts::language::Language), ToolError> {
    let configuration = attachment.current_global(owner).await?;
    // This ordinary Session handle is fresh. It carries no ended Run's pin.
    let store = owner
        .store
        .session(attachment.session())
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    let projection = store
        .session_projection::<maka_agent_api::session::StoredSessionConfiguration>(
            attachment.session(),
        )
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?
        .filter(|projection| !projection.session.archived)
        .ok_or_else(|| failed("Browser lease-child Session is no longer active"))?;
    let turn = projection
        .root_turn
        .filter(|turn| {
            turn.invocation.turn_id == attachment.turn() && turn.state.terminal_outcome().is_none()
        })
        .ok_or_else(|| failed("Browser lease-child turn is no longer active"))?;
    let snapshot = store
        .invocation_configuration(&turn.invocation)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?
        .ok_or_else(|| failed("Browser lease-child canonical boundary is unavailable"))?;
    if snapshot.boundary_revision != configuration.boundary_revision
        || snapshot.workspace_binding != Some(configuration.binding)
        || snapshot.workspace_identity.as_ref() != Some(&configuration.workspace.identity)
        || snapshot.cwd != configuration.workspace.path
        || configuration.permission_basis() != attachment.basis()
    {
        return Err(failed(
            "Browser lease-child boundary changed before admission",
        ));
    }
    Ok((
        Boundary::Session {
            boundary: SessionBoundary {
                workspace_origin: snapshot.workspace_origin,
                session_id: attachment.session().to_owned(),
                boundary_revision: snapshot.boundary_revision,
                sandbox_mode: snapshot.sandbox_mode,
                approval_policy: snapshot.approval_policy,
                cwd: snapshot.cwd,
            },
            workspace_identity: configuration.workspace.identity,
        },
        snapshot.language,
    ))
}

fn unknown(error: &ToolError) -> bool {
    matches!(
        error,
        ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::OperationCleanupUnconfirmed { .. }
    )
}

/// A queued service never holds up Stop while waiting for Stop's native lock.
/// Canonical Session commits and source-scope retirement revoke this wait before
/// any create/claim future is constructed or polled.
pub(super) async fn wait_native_current<'a>(
    owner: &Computer,
    native: &'a Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    attachment: &browser_access::Attachment,
    gate: &admission::Gate,
    cancellation: &CancellationToken,
) -> Result<tokio::sync::MutexGuard<'a, maka_computer_use::Session>, ToolError> {
    let store = owner
        .store
        .session(attachment.session())
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    let mut changes = store.subscribe_commits().map_err(failed)?;
    loop {
        changes.borrow_and_update();
        attachment.alive(cancellation)?;
        attachment.current_global(owner).await?;
        tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(failed("Browser lease-child service cancelled before native dispatch")),
            () = gate.wait_closed() => return Err(failed("Browser lease-child source scope retired before native dispatch")),
            guard = native.lock() => {
                attachment.alive(cancellation)?;
                attachment.current_global(owner).await?;
                attachment.alive(cancellation)?;
                return Ok(guard);
            }
            changed = changes.changed() => changed.map_err(|error| ToolError::Persistence(message(error)))?,
        }
    }
}

pub(super) async fn run(
    owner: Arc<Computer>,
    native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    attachment: Arc<browser_access::Attachment>,
    gate: Arc<admission::Gate>,
    request: BrowserLeaseChildRequest,
    effects: Arc<dyn BrowserHostEffects>,
) -> Result<(), ToolError> {
    if !owner.configuration.browser_preparation.popup
        && owner
            .configuration
            .browser_preparation
            .request_headers
            .is_empty()
    {
        // This only declines a new Maka adoption. It does not claim that an
        // Original provider's independently enabled hooks or effects are off.
        return Err(failed(
            "Maka popup adoption is disabled by Host preparation policy",
        ));
    }
    let cancellation = owner.stopping.child_token();
    attachment.alive(&cancellation)?;
    if request.turn_id != attachment.turn() {
        return Err(failed(
            "Browser lease-child request belongs to another turn",
        ));
    }
    let provenance = owner
        .popup_provenance
        .as_ref()
        .ok_or_else(|| failed("Browser lease-child native provenance is unavailable"))?;
    let (boundary, language) = boundary(&owner, &attachment).await?;
    let store = owner
        .store
        .session(attachment.session())
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    // Real durable T1 precedes construction/polling of any create/claim/native
    // future. The existing Host resource ticket already owns this service job.
    let receipt = store
        .begin_browser_lease_child(Request {
            source: maka_capabilities::call::Identity::BrowserLease {
                session_id: attachment.session().to_owned(),
                turn_id: attachment.turn().to_owned(),
            },
            owner: provenance.owner(attachment.session()),
            boundary,
            operation: Operation::BrowserLeaseChild {
                browser_id: request.browser_id.clone(),
                generation: request.generation.clone(),
                opener_subject: request.opener_subject.clone(),
                opener_tab_id: request.opener_tab_id,
                url: request.url.clone(),
            },
        })
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    let operation_id = receipt.id().to_string();
    let preparation_active = CancellationToken::new();
    let result = async {
        let _preparation_lifetime = preparation_active.clone().drop_guard();
        attachment.alive(&cancellation)?;
        attachment.current_global(&owner).await?;
        let authorization = Arc::new(
            Authorization::new(
                attachment.clone(),
                request.browser_id.clone(),
                request.url.clone(),
            )
            .with_session_preparation(
                &request,
                operation_id.clone(),
                preparation_active.clone(),
            ),
        );
        let settlement = admission::host_service_settlement(&owner, &native, gate.clone());
        let context = InvocationContext::new(attachment.session(), attachment.turn())
            .with_operation_id(operation_id)
            .with_browser_authorization(authorization)
            .with_browser_preparation_policy(maka_computer_use::BrowserPreparationPolicy {
                popup_enabled: owner.configuration.browser_preparation.popup,
                headers: owner
                    .configuration
                    .browser_preparation
                    .request_headers
                    .iter()
                    .map(|header| maka_computer_use::BrowserPreparationHeader {
                        name: header.name.clone(),
                        value: header.value.clone(),
                    })
                    .collect(),
            })
            .with_operation_settlement(settlement)
            .with_browser_host_effects(effects);
        wait_native_current(&owner, &native, &attachment, &gate, &cancellation)
            .await?
            .adopt_browser_lease_child(request, &context, &cancellation, language)
            .await
    }
    .await;
    let (outcome, result) = match result {
        Ok(value) => (Outcome::Completed { value }, Ok(())),
        Err(error) => {
            let outcome = if unknown(&error) {
                Outcome::Unknown {
                    message: error.to_string(),
                }
            } else {
                Outcome::Failed {
                    message: error.to_string(),
                }
            };
            (outcome, Err(error))
        }
    };
    receipt
        .settle(outcome)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    result
}
