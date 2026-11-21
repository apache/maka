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

//! Fail-closed `A -> C -> B` mesh transit authorization and stream relay.

use crate::roster::{MeshMemberEntry, SignedPeerMeshRosterV1};
use maka_peer::PeerId;
use std::{
    io,
    num::NonZeroUsize,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite, copy_bidirectional};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransitError {
    #[error("transit endpoints must be three distinct peers (source={source_peer}, relay={relay_peer}, target={target_peer})")]
    DegenerateHop {
        source_peer: PeerId,
        relay_peer: PeerId,
        target_peer: PeerId,
    },
    #[error("local node `{0}` is not authorized to relay in this mesh roster")]
    RelayNotAuthorized(PeerId),
    #[error("source peer `{0}` is not an active mesh member")]
    SourceNotAuthorized(PeerId),
    #[error("target peer `{0}` is not an active mesh member")]
    TargetNotAuthorized(PeerId),
    #[error("transit circuit capacity reached ({max_circuits})")]
    CapacityReached { max_circuits: NonZeroUsize },
}

#[derive(Debug)]
pub struct TransitCircuitGuard {
    active: Arc<AtomicUsize>,
}

impl Drop for TransitCircuitGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Enforces roster-backed fail-closed authorization and optional concurrency
/// limits on relay node C before bridging `A <-> C <-> B`.
#[derive(Clone, Debug)]
pub struct TransitPolicy {
    local_relay_peer_id: PeerId,
    max_circuits: Option<NonZeroUsize>,
    active_circuits: Arc<AtomicUsize>,
}

impl TransitPolicy {
    pub fn new(local_relay_peer_id: PeerId, max_circuits: Option<NonZeroUsize>) -> Self {
        Self {
            local_relay_peer_id,
            max_circuits,
            active_circuits: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn active_circuits(&self) -> usize {
        self.active_circuits.load(Ordering::Acquire)
    }

    pub fn admit_circuit(
        &self,
        roster: &SignedPeerMeshRosterV1,
        source: &PeerId,
        target: &PeerId,
    ) -> Result<TransitCircuitGuard, TransitError> {
        if source == target
            || source == &self.local_relay_peer_id
            || target == &self.local_relay_peer_id
        {
            return Err(TransitError::DegenerateHop {
                source_peer: source.clone(),
                relay_peer: self.local_relay_peer_id.clone(),
                target_peer: target.clone(),
            });
        }
        let inner = roster.roster();
        if !inner
            .member(&self.local_relay_peer_id)
            .is_some_and(MeshMemberEntry::can_transit)
        {
            return Err(TransitError::RelayNotAuthorized(
                self.local_relay_peer_id.clone(),
            ));
        }
        if !inner.member(source).is_some_and(MeshMemberEntry::is_active) {
            return Err(TransitError::SourceNotAuthorized(source.clone()));
        }
        if !inner.member(target).is_some_and(MeshMemberEntry::is_active) {
            return Err(TransitError::TargetNotAuthorized(target.clone()));
        }
        match self.max_circuits {
            None => {
                self.active_circuits.fetch_add(1, Ordering::AcqRel);
                Ok(TransitCircuitGuard {
                    active: self.active_circuits.clone(),
                })
            }
            Some(limit) => {
                let mut current = self.active_circuits.load(Ordering::Acquire);
                loop {
                    if current >= limit.get() {
                        return Err(TransitError::CapacityReached {
                            max_circuits: limit,
                        });
                    }
                    match self.active_circuits.compare_exchange_weak(
                        current,
                        current + 1,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    ) {
                        Ok(_) => {
                            return Ok(TransitCircuitGuard {
                                active: self.active_circuits.clone(),
                            });
                        }
                        Err(observed) => current = observed,
                    }
                }
            }
        }
    }
}

pub async fn bridge_transit_streams<A, B>(
    mut inbound_a: A,
    mut outbound_b: B,
    guard: TransitCircuitGuard,
) -> io::Result<(u64, u64)>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let result = copy_bidirectional(&mut inbound_a, &mut outbound_b).await;
    drop(guard);
    result
}
