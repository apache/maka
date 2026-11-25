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

//! Remote Maka Host access without linking the Host runtime.

mod client;
mod link;
mod pairing;
mod store;

pub use client::{
    Attachments, ReadResource, RemoteCallHandle, RemoteClientError, RemoteDeploymentRef,
    RemoteHostConnection, RemoteSubscription,
};
pub use pairing::{PendingPairing, RedeemedPairing, RelayAuthorization};
pub use store::{HostProfile, SavedHosts};

pub use maka_remote_pairing::DeviceIdentity;
pub use maka_remote_transport::{PathSummary, TlsTrust};
