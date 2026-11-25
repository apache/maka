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

use std::{
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// Provisions and tears down a temporary Windows Account sandbox on non-PSEC
/// hosts (such as Windows Server CI runners) when MXC is unavailable. On PSEC
/// hosts this is a no-op so tests exercise zero-UAC MXC without setup.
pub struct WindowsSandboxGuard {
    state_root: Option<PathBuf>,
}

impl WindowsSandboxGuard {
    pub async fn setup(state_root: &Path) -> io::Result<Self> {
        if maka_sandbox::windows::mxc::is_available() {
            return Ok(Self { state_root: None });
        }
        if std::env::var_os("CI").is_none()
            && std::env::var_os("MAKA_WINDOWS_ACCOUNT_SANDBOX_TESTS").is_none()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "non-PSEC Windows account sandbox tests mutate local sandbox accounts and WFP rules; set CI=1 or MAKA_WINDOWS_ACCOUNT_SANDBOX_TESTS=1 in an elevated disposable environment",
            ));
        }
        let state_root = state_root.to_owned();
        let setup_root = state_root.clone();
        tokio::task::spawn_blocking(move || Self::setup_blocking(&setup_root))
            .await
            .map_err(io::Error::other)??;
        Ok(Self {
            state_root: Some(state_root),
        })
    }

    fn setup_blocking(state_root: &Path) -> io::Result<()> {
        use maka_host_runtime::sandbox::windows::{Installation, Status};
        let installation = Installation::new(state_root);
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if installation.status()? == Status::Removing {
                Self::remove_blocking(state_root)?;
            }
            match installation.begin_setup() {
                Ok(setup) => {
                    let result = (|| {
                        let configured = setup.request().apply()?;
                        setup.finish(configured)
                    })();
                    if result.is_err() {
                        let _ = Self::remove_blocking(state_root);
                    }
                    return result;
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn remove_blocking(state_root: &Path) -> io::Result<()> {
        use maka_host_runtime::sandbox::windows::Installation;
        let installation = Installation::new(state_root);
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            match installation.begin_removal() {
                Ok(removal) => {
                    let receipt = removal
                        .request()
                        .map(|request| request.apply())
                        .transpose()?;
                    return removal.finish(receipt);
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub async fn teardown(mut self) -> io::Result<()> {
        let Some(state_root) = self.state_root.take() else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || Self::remove_blocking(&state_root))
            .await
            .map_err(io::Error::other)?
    }
}

impl Drop for WindowsSandboxGuard {
    fn drop(&mut self) {
        if let Some(state_root) = self.state_root.take() {
            let _ = Self::remove_blocking(&state_root);
        }
    }
}
