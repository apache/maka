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

//! Cryptographic node identity, signed peer reachability leases, and resumable
//! byte-window peer streams across physical carrier switchover.

pub mod identity;
pub mod reachability;
pub mod resumable;
pub mod tls;

pub use identity::{IdentityError, NodeIdentity, PeerId, verify_signature};
pub use reachability::{
    DEFAULT_LEASE_TTL_MS, DirectRoute, DirectTransport, LeaseAcceptOutcome, LeaseError,
    LeaseReceiptStore, MAX_CLOCK_SKEW_MS, MAX_LEASE_LIFETIME_MS, MAX_RECOVERY_HORIZON_MS,
    MAX_ROUTES_PER_CLASS, MAX_SIGNED_LEASE_BYTES, PeerReachabilityLeaseV1, RelayRoute,
    SignedPeerReachabilityLeaseV1, UsableLease,
};
pub use resumable::{
    CarrierIo, MAX_CHUNK_BYTES, MAX_WINDOW_BYTES, RECOVERY_TIMEOUT, ResumablePeerStream,
    ResumableStreamControl, ResumableStreamError,
};
