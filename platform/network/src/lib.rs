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

//! Immutable outbound routing shared by provider HTTP and WebSocket transport.
mod connection_tasks;
pub use connection_tasks::ConnectionTasks;
mod policy;
mod probe;
pub use probe::probe;
pub mod proxy;
mod tls_config;
pub use tls_config::TlsConfigCache;
mod tunnel;
mod websocket;
pub use policy::Policy;
pub use websocket::{Socket, connect_websocket};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid network proxy configuration")]
    InvalidProxy,
    #[error("network proxy authentication is not configured")]
    MissingCredentials,
    #[error("outbound HTTP headers cannot be represented")]
    InvalidHeaders,
    #[error("invalid WebSocket upgrade response")]
    InvalidUpgrade,
    #[error("outbound redirect limit")]
    RedirectLimit,
    #[error("outbound network request failed")]
    Transport(#[source] reqwest::Error),
}
impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::Transport(error)
    }
}
