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

//! Lightweight, desktop-free remote Maka Host client, pairing tickets,
//! 6-digit SAS verification, and saved Host profiles.
//!
//! Compiles on desktop platforms as well as iOS (`aarch64-apple-ios` and
//! `aarch64-apple-ios-sim`) without pulling in `maka-host-runtime`,
//! `maka-sandbox`, or local SQLite Host dependencies.

pub mod client;
pub mod store;

pub use client::{
    BoxedStream, MAX_CONTROL_FRAME_BYTES, MAX_WS_MESSAGE_BYTES, OpenStream, RemoteCallEvent,
    RemoteCallHandle, RemoteClientError, RemoteDeploymentRef, RemoteHostClient,
    RemoteHostConnection, RemoteSubscription, StreamIo, tcp_endpoint_opener,
};
pub use store::{
    HostViewFilter, PAIRING_URI_PREFIX, PairingTicketV1, RemoteHostError, SavedHostProfile,
    SavedHostStore,
};
