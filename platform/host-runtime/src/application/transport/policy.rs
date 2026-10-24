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

//! Private invocation evidence from a trusted launcher or authenticated acceptor.
use super::Grant;
use super::wire::Source;
use crate::application::Result;
use crate::application::{Binding, Caller, Invocation, Policy, RecoveryInvocation};
use maka_capabilities::call::Identity;
use maka_capabilities::call::Issuer;
use maka_capabilities::call::Scope;
use maka_event_log::applications::intents::CallerConfirmation;
use maka_plugin_core::{
    composition::InstanceId,
    contract::{Contract, Interface, Transport},
    deployment::DeploymentRef,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

/// Trusted embedding input. Reading the same fields from a request is not approval.
#[derive(Clone)]
pub struct Peer {
    source: DeploymentRef,
    consumers: BTreeSet<InstanceId>,
}
impl Peer {
    pub fn new(source: DeploymentRef, consumers: BTreeSet<InstanceId>) -> Result<Self> {
        source.validate()?;
        if consumers.is_empty() || consumers.iter().any(|id| id.validate().is_err()) {
            return Err("invalid approved peer consumers".into());
        }
        Ok(Self { source, consumers })
    }
}
/// One trusted controller's exact-source approvals for its original caller deployment.
/// Updating this set never changes an endpoint or acknowledges request cleanup.
pub struct Peers {
    origin: DeploymentRef,
    approved: Mutex<Approvals>,
}
struct Approvals {
    // Revocation is terminal within this controller incarnation. Only a newly
    // committed revision may obtain a new ticket; retained tickets keep identity.
    latest: u64,
    tickets: BTreeMap<u64, Arc<PeerApproval>>,
}
/// An opaque ticket for this controller's original approval and incarnation.
pub struct PeerApproval {
    peer: Peer,
    incarnation: Arc<()>,
    active: AtomicBool,
}
impl PeerApproval {
    pub fn check(&self, source: &DeploymentRef, consumer: &InstanceId) -> Result<()> {
        if !self.active.load(Ordering::Acquire)
            || *source != self.peer.source
            || !self.peer.consumers.contains(consumer)
        {
            return Err("caller is not approved for this exact source".into());
        }
        Ok(())
    }
    pub fn live(&self) -> Result<()> {
        self.active
            .load(Ordering::Acquire)
            .then_some(())
            .ok_or("peer approval was revoked".into())
    }
}
impl Peers {
    pub fn new(peer: Peer) -> Arc<Self> {
        Arc::new(Self {
            origin: peer.source.clone(),
            approved: Mutex::new(Approvals {
                latest: peer.source.revision,
                tickets: BTreeMap::from([(
                    peer.source.revision,
                    Arc::new(PeerApproval {
                        peer,
                        incarnation: Arc::new(()),
                        active: AtomicBool::new(true),
                    }),
                )]),
            }),
        })
    }
    /// Trusted controller replaces the live approval set. Sessions keep their
    /// original ticket; removing an approval revokes admission, not execution custody.
    pub fn replace(&self, peers: Vec<Peer>) -> Result<()> {
        let mut current = self.approved.lock().unwrap();
        let next = self.prepare(&current, peers)?;
        Self::publish(&mut current, next);
        Ok(())
    }
    fn prepare(
        &self,
        current: &Approvals,
        peers: Vec<Peer>,
    ) -> Result<BTreeMap<u64, Arc<PeerApproval>>> {
        let mut next = BTreeMap::new();
        for peer in peers {
            if peer.source.state_domain != self.origin.state_domain
                || peer.source.deployment != self.origin.deployment
            {
                return Err("foreign approval deployment".into());
            }
            let revision = peer.source.revision;
            let ticket = match current.tickets.get(&revision) {
                Some(ticket) if ticket.peer.consumers == peer.consumers => ticket.clone(),
                Some(_) => return Err("exact-source consumer approval cannot be rewritten".into()),
                None if revision <= current.latest => {
                    return Err(
                        "revoked or superseded source requires a new committed revision".into(),
                    );
                }
                None => Arc::new(PeerApproval {
                    peer,
                    incarnation: Arc::new(()),
                    active: AtomicBool::new(true),
                }),
            };
            if next.insert(revision, ticket).is_some() {
                return Err("duplicate source approval".into());
            }
        }
        Ok(next)
    }
    fn publish(current: &mut Approvals, next: BTreeMap<u64, Arc<PeerApproval>>) {
        for (revision, ticket) in &current.tickets {
            if !next.contains_key(revision) {
                ticket.active.store(false, Ordering::Release);
            }
        }
        if let Some(revision) = next.keys().next_back() {
            current.latest = current.latest.max(*revision);
        }
        current.tickets = next;
    }
    fn updated(
        current: &Approvals,
        peer: Option<Peer>,
        retain: &BTreeSet<u64>,
    ) -> Result<Vec<Peer>> {
        let mut peers = current
            .tickets
            .values()
            .filter(|ticket| {
                retain.contains(&ticket.peer.source.revision)
                    && peer
                        .as_ref()
                        .is_none_or(|peer| ticket.peer.source != peer.source)
            })
            .map(|ticket| ticket.peer.clone())
            .collect::<Vec<_>>();
        peers.extend(peer);
        Ok(peers)
    }
    pub fn check_update(&self, peer: Option<Peer>, retain: &BTreeSet<u64>) -> Result<()> {
        let current = self.approved.lock().unwrap();
        self.prepare(&current, Self::updated(&current, peer, retain)?)?;
        Ok(())
    }
    pub fn update(&self, peer: Option<Peer>, retain: &BTreeSet<u64>) -> Result<()> {
        let mut current = self.approved.lock().unwrap();
        let next = self.prepare(&current, Self::updated(&current, peer, retain)?)?;
        Self::publish(&mut current, next);
        Ok(())
    }
    pub fn resolve(
        &self,
        source: &DeploymentRef,
        consumer: &InstanceId,
    ) -> Result<Arc<PeerApproval>> {
        let ticket = self
            .approved
            .lock()
            .unwrap()
            .tickets
            .get(&source.revision)
            .cloned()
            .ok_or("source is not approved")?;
        ticket.check(source, consumer)?;
        Ok(ticket)
    }
}
#[derive(Clone)]
pub struct Endpoint {
    pub(super) binding: Binding,
    pub(super) grant: Grant,
}
impl Endpoint {
    pub fn new(binding: Binding, grant: Grant) -> Result<Self> {
        check_grant(binding.contract(), &grant)?;
        Ok(Self { binding, grant })
    }
}
pub(super) fn check_grant(contract: &Contract, grant: &Grant) -> Result<()> {
    let Interface::Service { methods } = &contract.interface else {
        return Err("Application endpoint requires a service".into());
    };
    if contract.transport != Transport::Remote
        || grant.methods.is_empty()
        || grant.methods.iter().any(|name| !methods.contains_key(name))
    {
        return Err("invalid Application endpoint grant".into());
    }
    Ok(())
}
/// Explicit trusted launcher approval for one edge of native domain work.
/// Imports select providers; this separate declaration authorizes calls.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeGrant {
    pub origin: InstanceId,
    pub consumer: InstanceId,
    pub provider: InstanceId,
    pub export: String,
    pub methods: BTreeSet<String>,
    pub recovery: bool,
}
impl NativeGrant {
    pub fn validate(&self) -> Result<()> {
        if [&self.origin, &self.consumer, &self.provider]
            .iter()
            .any(|id| id.validate().is_err())
            || self.export.is_empty()
            || self.methods.is_empty()
            || self.methods.iter().any(|method| method.is_empty())
        {
            return Err("invalid native service grant".into());
        }
        Ok(())
    }
}
struct Evidence {
    approval: Arc<PeerApproval>,
    source: Source,
    endpoint: Endpoint,
}
#[derive(Default)]
pub struct PeerPolicy {
    issuer: Issuer,
    native: RwLock<Vec<NativeGrant>>,
}
impl PeerPolicy {
    pub fn with_native_grants(native: Vec<NativeGrant>) -> Result<Self> {
        for grant in &native {
            grant.validate()?;
        }
        Ok(Self {
            native: RwLock::new(native),
            ..Self::default()
        })
    }
    /// New native admissions use the current trusted configuration. Already
    /// accepted execution retains its original owner and is never cancelled here.
    pub(crate) fn replace_native_grants(&self, native: Vec<NativeGrant>) {
        *self.native.write().unwrap() = native;
    }
    pub fn issuer(&self) -> Issuer {
        self.issuer.clone()
    }
    pub(super) fn scope(
        &self,
        peer: &Arc<Peers>,
        source: Source,
        endpoint: Endpoint,
        cancel: CancellationToken,
    ) -> Result<Scope> {
        if source.request.is_nil() || source.mount.is_nil() {
            return Err("invalid peer request identity".into());
        }
        let approval = peer.resolve(&source.deployment, &source.consumer)?;
        self.issuer
            .issue_with(
                Identity::Remote {
                    request_id: source.request,
                },
                Evidence {
                    approval,
                    source,
                    endpoint,
                },
                cancel,
            )
            .map_err(|e| e.to_string())
    }
    fn evidence<'a>(&self, scope: &'a Scope) -> Result<&'a Evidence> {
        let evidence = self
            .issuer
            .evidence::<Evidence>(scope)
            .ok_or("Application peer evidence mismatch")?;
        if scope.identity
            != (Identity::Remote {
                request_id: evidence.source.request,
            })
        {
            return Err("Application request identity mismatch".into());
        }
        evidence.approval.live()?;
        Ok(evidence)
    }
}
impl Policy for PeerPolicy {
    fn caller(&self, scope: &Scope) -> Option<Caller> {
        let evidence = self.evidence(scope).ok()?;
        Some(Caller::new(
            evidence.approval.incarnation.clone(),
            evidence.source.deployment.clone(),
            evidence.source.consumer.clone(),
            evidence.source.mount,
        ))
    }
    fn admit(&self, invocation: Invocation<'_>) -> Result<()> {
        if let Some(e) = self.issuer.evidence::<Evidence>(invocation.scope) {
            e.approval.live()?;
        }
        if let Some(origin) = invocation.native_origin {
            return self
                .native
                .read()
                .unwrap()
                .iter()
                .any(|grant| {
                    &grant.origin == origin.instance()
                        && &grant.consumer == invocation.consumer.instance()
                        && &grant.provider == invocation.provider.instance()
                        && grant.export == invocation.export
                        && grant.methods.contains(invocation.method)
                })
                .then_some(())
                .ok_or("native service invocation is not granted".into());
        }
        let e = self.evidence(invocation.scope)?;
        if invocation.consumer != e.endpoint.binding.consumer()
            || invocation.provider != e.endpoint.binding.provider()
            || invocation.export != e.endpoint.binding.export()
            || invocation.contract != e.endpoint.binding.contract()
            || !e.endpoint.grant.methods.contains(invocation.method)
        {
            return Err("Application invocation is not granted".into());
        }
        Ok(())
    }
    fn confirm_peer_mutation(
        &self,
        invocation: Invocation<'_>,
        intent: &CallerConfirmation,
    ) -> Result<()> {
        let e = self.evidence(invocation.scope)?;
        if intent.caller != e.source.deployment
            || intent.consumer != e.source.consumer
            || intent.reference.operation != e.source.request
        {
            return Err("caller confirmation differs from the original peer request".into());
        }
        Ok(())
    }
    fn recover(&self, invocation: RecoveryInvocation<'_>) -> Result<()> {
        if let Some(e) = self.issuer.evidence::<Evidence>(invocation.scope) {
            e.approval.live()?;
        }
        if let Some(origin) = invocation.native_origin {
            return self
                .native
                .read()
                .unwrap()
                .iter()
                .any(|grant| {
                    grant.recovery
                        && &grant.origin == origin.instance()
                        && &grant.consumer == invocation.consumer.instance()
                        && grant.provider == invocation.reference.namespace
                        && grant.export == invocation.reference.export
                        && grant.methods.contains(&invocation.reference.method)
                })
                .then_some(())
                .ok_or("native operation recovery is not granted".into());
        }
        let e = self.evidence(invocation.scope)?;
        if !e.endpoint.grant.recovery || invocation.consumer != e.endpoint.binding.provider() {
            return Err("original receipt recovery is not granted".into());
        }
        Ok(())
    }
}
// Policy ownership is shared with the original Application, not a second kernel.
pub(super) type PolicyOwner = Arc<PeerPolicy>;

#[cfg(test)]
mod tests {
    use super::*;
    fn source(revision: u64) -> DeploymentRef {
        DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: uuid::Uuid::from_u128(1),
            revision,
        }
    }
    fn peer(revision: u64, consumer: u128) -> Peer {
        Peer::new(
            source(revision),
            BTreeSet::from([InstanceId(vec![uuid::Uuid::from_u128(consumer)])]),
        )
        .unwrap()
    }
    #[test]
    fn retained_ticket_is_original_and_revoked_ticket_never_revives() {
        let peers = Peers::new(peer(1, 2));
        let old = peers
            .resolve(&source(1), &InstanceId(vec![uuid::Uuid::from_u128(2)]))
            .unwrap();
        peers
            .update(Some(peer(2, 3)), &BTreeSet::from([1]))
            .unwrap();
        assert!(Arc::ptr_eq(
            &old,
            &peers
                .resolve(&source(1), &old.peer.consumers.first().unwrap().clone())
                .unwrap()
        ));
        assert!(
            peers
                .resolve(&source(2), old.peer.consumers.first().unwrap())
                .is_err()
        );
        peers.update(Some(peer(2, 3)), &BTreeSet::new()).unwrap();
        assert!(old.live().is_err());
        assert!(peers.replace(vec![peer(1, 2)]).is_err());
        assert!(old.live().is_err());
        assert!(
            peers
                .resolve(&source(1), old.peer.consumers.first().unwrap())
                .is_err()
        );
        // The same contents can be installed with a fresh immutable revision.
        peers.replace(vec![peer(3, 2)]).unwrap();
        assert!(
            peers
                .resolve(&source(3), old.peer.consumers.first().unwrap())
                .is_ok()
        );
    }
    #[test]
    fn failed_batch_and_preflight_leave_original_ticket_live() {
        let peers = Peers::new(peer(1, 2));
        let old = peers
            .resolve(&source(1), &InstanceId(vec![uuid::Uuid::from_u128(2)]))
            .unwrap();
        assert!(
            peers
                .check_update(Some(peer(1, 3)), &BTreeSet::new())
                .is_err()
        );
        assert!(peers.update(Some(peer(1, 3)), &BTreeSet::new()).is_err());
        let mut foreign = peer(3, 4);
        foreign.source.deployment = uuid::Uuid::from_u128(9);
        assert!(peers.replace(vec![peer(2, 3), foreign]).is_err());
        old.live().unwrap();
        assert!(
            peers
                .resolve(&source(2), &InstanceId(vec![uuid::Uuid::from_u128(3)]))
                .is_err()
        );
    }
    #[test]
    fn preflight_does_not_advance_latest_and_empty_update_cannot_reset_it() {
        let peers = Peers::new(peer(1, 2));
        peers
            .check_update(Some(peer(3, 2)), &BTreeSet::new())
            .unwrap();
        peers.update(Some(peer(2, 2)), &BTreeSet::new()).unwrap();
        peers.update(None, &BTreeSet::new()).unwrap();
        assert!(peers.update(Some(peer(2, 2)), &BTreeSet::new()).is_err());
        assert!(peers.replace(vec![peer(1, 2)]).is_err());
        peers.update(Some(peer(3, 2)), &BTreeSet::new()).unwrap();
    }
    #[test]
    fn retain_only_revokes_unused_host_without_empty_peer() {
        let peers = Peers::new(peer(1, 2));
        let old = peers
            .resolve(&source(1), &InstanceId(vec![uuid::Uuid::from_u128(2)]))
            .unwrap();
        peers.update(None, &BTreeSet::new()).unwrap();
        assert!(old.live().is_err());
        assert!(
            peers
                .resolve(&source(1), old.peer.consumers.first().unwrap())
                .is_err()
        );
    }
}
