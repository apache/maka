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

//! Async client for the Maka Runtime Host.
//!
//! The local transport is the Host's Unix domain socket on macOS and Linux
//! and its named pipe on Windows ([`LocalEndpoint`]); both carry one JSON
//! frame per line. A remote Host is reached over a WebSocket, one JSON
//! message per text frame, directly or through `ssh`. The client is
//! executor-agnostic: it uses `async-net`/`async-io` for sockets, timers, and
//! child processes (a named pipe's two halves run on the `blocking` pool)
//! and never spawns tasks itself. [`Connection::connect`]
//! returns a [`ConnectionPump`] future that the caller drives, e.g. with
//! GPUI's background executor or a thread running
//! `futures_lite::future::block_on`.
//!
//! An application normally does not hold a bare [`Connection`]: [`supervise`]
//! wraps discovery, the handshake, liveness probes, and reconnection in one
//! future and reports what happens as [`HostEvent`]s. The client instance id
//! it greets with should come from [`load_or_create_client_instance_id`], so
//! the Host sees the same client across launches.
//!
//! A Host on another machine is reached through a [`RemoteHostProfile`]:
//! a WebSocket over TLS, a plaintext WebSocket the user acknowledged, or
//! either kind of SSH forward ([`connect_remote`], [`RemoteConnector`] for a
//! supervised connection). [`pair_remote_host`] activates the pending
//! credential of a connection code, and [`RemoteProfileStore`] keeps
//! profiles, credentials, and the [`HostSelection`] (the default Host and
//! the enabled ones) in this client's config directory. With the
//! `test-support` feature, [`test_support`] scripts a remote Host.
//!
//! [`connect_or_spawn`] starts a local Host when none is registered for the
//! State Root, creating the State Root first if it does not exist; a
//! [`RootConnector`] built with [`RootConnector::spawning`] does that on
//! every attempt of a supervised connection. See the `launcher` module
//! re-exports ([`LaunchOptions`], [`MakaInstallation`], [`NodeRuntime`],
//! [`spawn_candidate`], [`prepare_state_root`]).
//!
//! ```no_run
//! use host_client::{ConnectOptions, Connected, Connection, discover_host, random_client_instance_id};
//! use host_protocol::{ClientHello, SessionCatalogQuery, SessionCatalogQueryInput};
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! futures_lite::future::block_on(async {
//!     let host = discover_host(std::path::Path::new("/path/to/state-root")).await?;
//!     let hello = ClientHello::new(random_client_instance_id());
//!     let options = ConnectOptions::default().with_expected_root_id(host.root_id.clone());
//!     let Connected { connection, pump, .. } =
//!         Connection::connect(&host.registration.endpoint, hello, options).await?;
//!     let (_, catalog) = futures_lite::future::zip(pump, async {
//!         let catalog = connection
//!             .request::<SessionCatalogQuery>(&SessionCatalogQueryInput::ListStart)
//!             .await;
//!         connection.shutdown();
//!         catalog
//!     })
//!     .await;
//!     println!("{:?}", catalog?);
//!     Ok(())
//! })
//! # }
//! ```

mod backoff;
mod blocker;
mod connection;
mod discovery;
mod endpoint;
mod identity;
mod launcher;
#[cfg(windows)]
mod named_pipe;
mod profiles;
mod pump;
mod remote;
mod requests;
mod selection;
mod ssh;
mod supervisor;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
mod websocket;

pub use backoff::ReconnectPolicy;
pub use blocker::{EpochMismatch, HostBlocker};
pub use connection::{ConnectError, ConnectOptions, Connected, Connection, RequestError};
pub use discovery::{
    DiscoveredHost, DiscoveryError, REGISTRATION_FILE, STORAGE_ROOT_MARKER_FILE, control_directory,
    control_namespace, discover_host, discover_registration, read_root_id,
};
pub use endpoint::{EndpointError, LocalEndpoint};
pub use identity::{
    CLIENT_CONFIG_DIRECTORY, CLIENT_IDENTITY_FILE, ClientIdentity, IdentityError, IdentityOrigin,
    client_identity_path, load_or_create_client_instance_id,
};
pub use launcher::*;
pub use profiles::{
    LOCAL_PROFILE_ID, ProfileError, ProfileStoreError, REMOTE_CREDENTIALS_FILE,
    REMOTE_PROFILES_FILE, RemoteHostEntry, RemoteHostProfile, RemoteProfileStore,
    ResolvedRemoteHost,
};
pub use pump::{ConnectionError, ConnectionPump, PUSH_CHANNEL_CAPACITY, PushEvent};
pub use remote::{
    PairingError, RemoteConnectError, RemoteConnectOptions, RemoteConnector, connect_remote,
    pair_remote_host,
};
pub use selection::{HOST_SELECTION_FILE, HostSelection};
pub use ssh::{ActivationError, SshError, SshFailure};
pub use supervisor::{
    AttemptError, AttemptReporter, ConnectionEvent, EVENT_CHANNEL_CAPACITY, HostConnector,
    HostEvent, RootConnector, Supervised, SupervisorHandle, SupervisorRun, error_chain, supervise,
};
pub use websocket::WebSocketError;

use host_protocol::ClientInstanceId;

/// A fresh random client instance id: a hyphenated UUID v4, as the TS CLI
/// generates for every local connection (`randomUUID()` in
/// `packages/cli/src/runtime-host-cli-context.ts`).
///
/// The Electron desktop instead persists one id per installation in
/// `runtime-host-client.json` (`client/client-instance-identity.ts`); this
/// client does the same through [`load_or_create_client_instance_id`].
pub fn random_client_instance_id() -> ClientInstanceId {
    ClientInstanceId::new(uuid::Uuid::new_v4().to_string())
        .expect("a hyphenated UUID is a valid client instance id")
}

#[cfg(all(test, unix))]
mod remote_tests;
#[cfg(all(test, unix))]
mod supervisor_tests;
#[cfg(all(test, unix))]
mod tests;
