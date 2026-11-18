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

use super::{Closure, Descriptor, FileIdentity, Started, evidence, publish_proof, write_json_new};
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
        let path = resource.resource_ref;
        let (resource, snapshot) = tokio::task::spawn_blocking(move || {
            let pinned = evidence::pin(&path)?;
            Ok::<_, io::Error>((path, evidence::snapshot_identity(&pinned.owner)?))
        })
        .await
        .map_err(io::Error::other)??;
        let dir = resource.join("owner");
        write_json_new(
            &dir.join("started.json"),
            &Started {
                helper_pid: std::process::id(),
            },
        )
        .await?;
        let file = |name| {
            let path = dir.join(name);
            async move {
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(path)
                    .await
            }
        };
        let (input, output, _) =
            tokio::try_join!(file("stdin.bin"), file("stdout.bin"), file("stderr.bin"))?;
        Ok(Self {
            resource,
            snapshot,
            input,
            output,
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
