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

use super::{Endpoint, Runner};
use maka_sandbox::{Network, filesystem::Policy};
use std::{future::Future, io, path::PathBuf, pin::Pin};

pub type Preparation = Pin<Box<dyn Future<Output = io::Result<Launch>> + Send>>;

/// The process layer owns native I/O and process lifetime, while the executor
/// owns backend selection and recoverable filesystem authority. Preparation
/// is invoked only after durable execution admission, never while capturing a
/// command or deciding whether an approval is needed.
pub trait Backend: Send + Sync {
    fn prepare(
        &self,
        filesystem: Policy,
        network: Network,
        route: maka_network::Policy,
        executable: PathBuf,
        cwd: PathBuf,
    ) -> Preparation;
}

/// One already prepared, uniquely owned command tree. There is no fallback to
/// an unisolated launch if backend startup, transport or settlement fails.
pub enum Launch {
    Account {
        runner: Runner,
        endpoint: Endpoint,
        capabilities: Vec<uuid::Uuid>,
        proxy_address: Option<std::net::SocketAddr>,
    },
    Mxc {
        lease: super::MxcLease,
        executable: PathBuf,
        filesystem: Policy,
        network: Network,
        proxy: Option<std::sync::Arc<maka_network::proxy::Proxy>>,
        proxy_address: Option<std::net::SocketAddr>,
    },
}

impl Launch {
    pub(crate) fn proxy_address(&self) -> Option<std::net::SocketAddr> {
        match self {
            Self::Account { proxy_address, .. } | Self::Mxc { proxy_address, .. } => *proxy_address,
        }
    }

    pub(crate) async fn abort(self) -> io::Result<()> {
        match self {
            Self::Account { mut runner, .. } => runner.finish().await,
            Self::Mxc {
                mut lease, proxy, ..
            } => {
                if let Some(mut proxy) = proxy.and_then(std::sync::Arc::into_inner) {
                    proxy.close().await?;
                }
                lease.finish().await
            }
        }
    }

    pub(crate) async fn pipes(
        self,
        command: crate::command::Prepared,
    ) -> io::Result<crate::pipe::Spawned> {
        match self {
            Self::Account {
                runner,
                endpoint,
                capabilities,
                ..
            } => runner.pipes(endpoint, command, capabilities).await,
            Self::Mxc {
                lease,
                executable,
                filesystem,
                network,
                proxy,
                ..
            } => super::mxc::pipes(executable, filesystem, network, proxy, lease, command).await,
        }
    }

    pub(crate) async fn terminal(
        self,
        command: crate::command::Prepared,
        size: maka_plugin_core::terminal::TerminalSize,
    ) -> io::Result<(crate::pty::PtyChild, crate::pty::PtyIo)> {
        match self {
            Self::Account {
                runner,
                endpoint,
                capabilities,
                ..
            } => runner.terminal(endpoint, command, capabilities, size).await,
            Self::Mxc {
                lease,
                executable,
                filesystem,
                network,
                proxy,
                ..
            } => {
                super::mxc::terminal(executable, filesystem, network, proxy, lease, command, size)
                    .await
            }
        }
    }
}
