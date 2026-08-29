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

use libp2p::{Multiaddr, PeerId, multiaddr::Protocol};

use super::PeerError;

pub(super) fn address_with_expected_peer(
    address: &Multiaddr,
    expected_peer: PeerId,
) -> Result<Multiaddr, PeerError> {
    match peer_id_from_address(address) {
        Some(actual) if actual != expected_peer => Err(PeerError::new(
            "peer_identity_mismatch",
            "route hint names a different peer identity",
        )),
        Some(_) => Ok(address.clone()),
        None => Ok(address.clone().with(Protocol::P2p(expected_peer))),
    }
}

pub(super) fn address_with_peer(address: Multiaddr, peer_id: PeerId) -> Multiaddr {
    if peer_id_from_address(&address) == Some(peer_id) {
        address
    } else {
        address.with(Protocol::P2p(peer_id))
    }
}

pub(super) fn peer_id_from_address(address: &Multiaddr) -> Option<PeerId> {
    address.iter().find_map(|protocol| match protocol {
        Protocol::P2p(peer_id) => Some(peer_id),
        _ => None,
    })
}

pub(super) fn coordination_relay_peer_id(address: &Multiaddr) -> Result<PeerId, PeerError> {
    base_relay_peer_id(address, "coordination_unavailable", "coordination relay")
}

pub(crate) fn transit_relay_peer_id(address: &Multiaddr) -> Result<PeerId, PeerError> {
    base_relay_peer_id(address, "transit_unavailable", "transit relay")
}

fn base_relay_peer_id(
    address: &Multiaddr,
    error_code: &'static str,
    label: &str,
) -> Result<PeerId, PeerError> {
    let mut peer_id = None;
    for protocol in address.iter() {
        match protocol {
            Protocol::P2p(_) if peer_id.is_some() => {
                return Err(PeerError::new(
                    error_code,
                    format!("{label} address must name exactly one peer"),
                ));
            }
            Protocol::P2p(value) => peer_id = Some(value),
            Protocol::P2pCircuit => {
                return Err(PeerError::new(
                    error_code,
                    format!("{label} address must be a base relay address"),
                ));
            }
            _ => {}
        }
    }
    match (peer_id, address.iter().last()) {
        (Some(peer_id), Some(Protocol::P2p(terminal))) if peer_id == terminal => Ok(peer_id),
        _ => Err(PeerError::new(
            error_code,
            format!("{label} address must end with its peer identity"),
        )),
    }
}

pub(super) fn is_relayed_address(address: &Multiaddr) -> bool {
    address
        .iter()
        .any(|protocol| matches!(protocol, Protocol::P2pCircuit))
}

pub(super) fn relay_peer_id_from_circuit_address(address: &Multiaddr) -> Option<PeerId> {
    let mut previous_peer = None;
    for protocol in address.iter() {
        match protocol {
            Protocol::P2p(peer_id) => previous_peer = Some(peer_id),
            Protocol::P2pCircuit => return previous_peer,
            _ => {}
        }
    }
    None
}
