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

mod bindings;
mod engine;
mod webrtc_direct;
#[cfg(target_os = "windows")]
mod windows_lifecycle;

pub use bindings::{
    ConfigurePeerTransitOptions, ConnectPeerOptions, PeerConnectivitySnapshot, PeerEndpoint,
    PeerIdentitySignature, PeerReachabilitySnapshot, PeerStream, PeerTransitRelayCandidate,
    PeerTransitSnapshot, StartPeerEndpointOptions, ensure_peer_identity, sign_peer_identity,
    start_peer_endpoint, verify_peer_identity,
};
#[cfg(target_os = "windows")]
pub use windows_lifecycle::{
    WindowsTaskStatus, own_current_process_tree, windows_task_activate, windows_task_converge,
    windows_task_converge_launcher, windows_task_probe, windows_task_retire, windows_task_status,
    windows_task_uninstall, windows_task_verify, windows_task_verify_launcher,
};
