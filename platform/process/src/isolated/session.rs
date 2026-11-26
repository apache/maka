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

use super::{Closure, Descriptor, FileIdentity, Started, evidence, publish_proof};
use std::{io, path::PathBuf};

/// The shared provider owner records the Run-local wire before forwarding it.
pub struct SessionSpool {
    resource: PathBuf,
    snapshot: FileIdentity,
    pub input: tokio::fs::File,
    pub output: tokio::fs::File,
}
impl SessionSpool {
    pub async fn open(resource: Descriptor) -> io::Result<Self> {
        let path = resource.resource_ref.clone();
        let (snapshot, input, output) = tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let pinned = evidence::pin(&path)?;
            let snapshot = evidence::snapshot_identity(&pinned.owner)?;
            let file = |name: &str| -> io::Result<std::fs::File> {
                #[cfg(unix)]
                {
                    use rustix::fs::{Mode, OFlags, openat};
                    Ok(openat(
                        &pinned.owner,
                        name,
                        OFlags::WRONLY
                            | OFlags::CREATE
                            | OFlags::EXCL
                            | OFlags::NOFOLLOW
                            | OFlags::CLOEXEC,
                        Mode::RUSR | Mode::WUSR,
                    )?
                    .into())
                }
                #[cfg(windows)]
                super::fs::create(&pinned.owner, name.as_ref())
            };
            let mut started = file("started.json")?;
            started.write_all(
                &serde_json::to_vec(&Started {
                    helper_pid: std::process::id(),
                })
                .map_err(io::Error::other)?,
            )?;
            started.sync_all()?;
            let input = file("stdin.bin")?;
            let output = file("stdout.bin")?;
            file("stderr.bin")?;
            Ok::<_, io::Error>((snapshot, input, output))
        })
        .await
        .map_err(io::Error::other)??;
        Ok(Self {
            resource: resource.resource_ref,
            snapshot,
            input: tokio::fs::File::from_std(input),
            output: tokio::fs::File::from_std(output),
        })
    }

    /// Call after the session acknowledged close or the shared OS group was reaped.
    pub async fn seal(self) -> io::Result<()> {
        tokio::try_join!(self.input.sync_all(), self.output.sync_all())?;
        let Self {
            resource, snapshot, ..
        } = self;
        tokio::task::spawn_blocking(move || {
            publish_proof(
                &resource,
                "closure.json",
                &Closure::SessionClosed {
                    resource: resource.clone(),
                    snapshot,
                },
            )
        })
        .await
        .map_err(io::Error::other)?
    }
}
