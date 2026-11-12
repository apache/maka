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

#[cfg(target_os = "linux")]
pub use crate::linux::mounts::MountLease;
use crate::{Error, Sandbox};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

/// Platform preparation, not a second process command representation. The
/// process owner retains arguments, environment, I/O, cancellation and receipts.
pub enum Launch {
    Direct,
    Wrapped {
        program: PathBuf,
        args: Vec<OsString>,
        /// Mount and filter descriptors are CLOEXEC in the Host. The process
        /// owner must preserve them only in the child executing the wrapper.
        #[cfg(target_os = "linux")]
        files: Vec<std::fs::File>,
        #[cfg(target_os = "linux")]
        lease: MountLease,
    },
}

impl Sandbox {
    #[cfg(target_os = "linux")]
    pub fn prepare_with_private_network(
        &self,
        cwd: &Path,
        directory: Option<&std::fs::File>,
    ) -> Result<Launch, Error> {
        crate::path::validate(cwd)?;
        let Self::Managed {
            filesystem,
            network: network @ crate::Network::Restricted { .. },
        } = self
        else {
            return Err(Error::Invalid(
                "private gateway requires a destination-restricted policy".into(),
            ));
        };
        crate::linux::prepare(&filesystem.compile()?, network, cwd, directory)
    }
    /// Compile only after Host authorization. No process starts here. The caller
    /// appends its original executable and arguments after a wrapper's arguments.
    /// Failure must never fall back to Direct or retry the original effect.
    pub fn prepare(&self, cwd: &Path) -> Result<Launch, Error> {
        self.prepare_network(cwd, None, None)
    }

    /// Linux must mount the admitted cwd inode because bubblewrap resolves
    /// --chdir inside its new namespace after the outer process's fchdir.
    #[cfg(target_os = "linux")]
    pub fn prepare_captured(
        &self,
        cwd: &Path,
        directory: Option<&std::fs::File>,
    ) -> Result<Launch, Error> {
        self.prepare_network(cwd, None, directory)
    }

    /// The execution owner binds and retains the gateway before compiling this
    /// exception. It is launch data, never a user-provided policy override.
    pub fn prepare_with_proxy(
        &self,
        cwd: &Path,
        proxy: std::net::SocketAddr,
    ) -> Result<Launch, Error> {
        if !proxy.ip().is_loopback() || proxy.port() == 0 {
            return Err(Error::Invalid(
                "sandbox proxy must be a loopback listener".into(),
            ));
        }
        self.prepare_network(cwd, Some(proxy), None)
    }

    fn prepare_network(
        &self,
        cwd: &Path,
        proxy: Option<std::net::SocketAddr>,
        _directory: Option<&std::fs::File>,
    ) -> Result<Launch, Error> {
        crate::path::validate(cwd)?;
        match self {
            Self::Disabled => Ok(Launch::Direct),
            Self::External { .. } => Err(Error::Unsupported(
                "external isolation requires an executor-owned launch path".into(),
            )),
            Self::Managed {
                filesystem,
                network,
            } => {
                if matches!(network, crate::Network::Restricted { .. })
                    && (proxy.is_none() || !cfg!(target_os = "macos"))
                {
                    return Err(Error::Unsupported(
                        "destination-restricted execution requires a managed network proxy".into(),
                    ));
                }
                let filesystem = filesystem.compile()?;
                #[cfg(target_os = "macos")]
                {
                    crate::seatbelt::prepare(&filesystem, network, proxy)
                }
                #[cfg(target_os = "linux")]
                {
                    crate::linux::prepare(&filesystem, network, cwd, _directory)
                }
                #[cfg(windows)]
                {
                    let _ = (filesystem, network);
                    Err(Error::Unsupported(
                        "platform backend is not installed".into(),
                    ))
                }
            }
        }
    }
}
