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

//! Fixed official distributions; no caller-controlled URLs or destinations.
use crate::Agent;
use maka_plugins::{
    call::Scope,
    host::Services,
    http,
    storage::{Data, Directory, Mutation, Store, StoreError},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, future::Future, io::Write, time::Duration};
use tokio_util::sync::CancellationToken;

mod archive;

const VERSION: &str = "1.2.1";
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const MAX_CHUNK: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Antigravity is unavailable on this platform")]
    Unsupported,
    #[error("Antigravity installation cancelled")]
    Cancelled,
    #[error("Antigravity installation timed out")]
    Timeout,
    #[error("Antigravity download failed")]
    Download,
    #[error("Antigravity distribution integrity check failed")]
    Integrity,
    #[error("Antigravity installation file operation failed")]
    Files(#[from] std::io::Error),
    #[error("Antigravity private storage unavailable")]
    Storage(#[from] maka_plugins::storage::StoreError),
    #[error("Antigravity installation cleanup is unconfirmed")]
    Cleanup,
    #[error("Antigravity was installed but its temporary download could not be removed")]
    StagingCleanup,
}

#[derive(Clone)]
struct Release {
    platform: &'static str,
    url: String,
    server: &'static str,
    helper: &'static str,
    // Other official registry platforms have no upstream digest. Their first
    // HTTPS download digest is recorded, not misrepresented as a pinned hash.
    pinned: Option<&'static str>,
}

impl Release {
    fn current() -> Result<Self, Error> {
        Self::for_platform(std::env::consts::OS, std::env::consts::ARCH)
    }

    fn for_platform(os: &str, arch: &str) -> Result<Self, Error> {
        let (directory, platform) = match (os, arch) {
            ("macos", "aarch64") => ("macos", "darwin-arm64"),
            ("macos", "x86_64") => ("macos", "darwin-x86_64"),
            ("linux", "aarch64") => ("linux", "linux-arm64"),
            ("linux", "x86_64") => ("linux", "linux-x86_64"),
            ("windows", "aarch64") => ("windows", "windows-arm64"),
            ("windows", "x86_64") => ("windows", "windows-x86_64"),
            _ => return Err(Error::Unsupported),
        };
        Ok(Self {
            platform,
            url: format!(
                "https://dl.google.com/agy-extensions/releases/{directory}/agy-acp-server-{VERSION}-{platform}.zip"
            ),
            server: if os == "windows" {
                "agy_acp_server.exe"
            } else {
                "agy_acp_server.par"
            },
            helper: if os == "windows" {
                "localharness_external.exe"
            } else {
                "localharness_external"
            },
            pinned: (platform == "darwin-arm64")
                .then_some("0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c"),
        })
    }

    fn destination(&self) -> String {
        format!("antigravity-{VERSION}-{}", self.platform)
    }

    fn agent(&self, root: &std::path::Path) -> Agent {
        let directory = root.join(self.destination());
        let mut env = BTreeMap::from([
            (
                "ANTIGRAVITY_HARNESS_PATH".into(),
                directory.join(self.helper).to_string_lossy().into_owned(),
            ),
            ("PYTHONUNBUFFERED".into(), "1".into()),
        ]);
        // Verified Python browser suppression on Unix. Do not invent an
        // equivalent Windows command; the authentication bridge owns its UI.
        if !self.platform.starts_with("windows") {
            env.insert("BROWSER".into(), "/usr/bin/true".into());
        }
        Agent {
            id: "antigravity-acp".into(),
            display_name: "Antigravity".into(),
            executable: directory.join(self.server).to_string_lossy().into_owned(),
            args: if self.platform.starts_with("linux") {
                vec!["--uid=".into()]
            } else {
                vec![]
            },
            env,
        }
    }
}

#[derive(Clone)]
struct Control {
    cancellation: CancellationToken,
    deadline: tokio::time::Instant,
}
impl Control {
    fn check(&self, retiring: &CancellationToken) -> Result<(), Error> {
        if self.cancellation.is_cancelled() || retiring.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if tokio::time::Instant::now() >= self.deadline {
            return Err(Error::Timeout);
        }
        Ok(())
    }
    async fn wait<T>(&self, work: impl Future<Output = T>) -> Result<T, Error> {
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(Error::Cancelled),
            value = tokio::time::timeout_at(self.deadline, work) => value.map_err(|_| Error::Timeout),
        }
    }
}

/// Install or verify the immutable current-platform release in plugin private
/// storage. The caller owns admission and saving the returned Agent configuration.
pub async fn antigravity(
    host: &Services,
    data: &Directory,
    call: Scope,
    cancellation: &CancellationToken,
) -> Result<Agent, Error> {
    let release = Release::current()?;
    let control = Control {
        cancellation: cancellation.clone(),
        deadline: tokio::time::Instant::now() + Duration::from_secs(900),
    };
    let root = data.read_only().await?.location();
    let key = format!("install/{}", release.destination());
    // Private files are writable by the external process. Only Host KV may
    // anchor executable identity; cache-side metadata cannot confer trust.
    let record = host.storage.read(key.clone()).await?;
    let anchor = record
        .as_ref()
        .and_then(|row| row.data.value())
        .map(|value| {
            serde_json::from_value::<archive::Receipt>(value.clone()).map_err(|_| Error::Integrity)
        })
        .transpose()?;
    let existing = if let Some(receipt) = anchor {
        let release = release.clone();
        let control = control.clone();
        data.run(move |dir, retiring| {
            archive::existing(dir, &release, &receipt, &control, retiring)
        })
        .await??
    } else {
        false
    };
    if existing {
        return Ok(release.agent(&root));
    }
    let staging = format!(".antigravity-{}", uuid::Uuid::new_v4());
    let result = async {
        let staging = staging.clone();
        let control = control.clone();
        data.run(move |dir, retiring| {
            control.check(retiring)?;
            archive::prepare(dir, &staging)
        })
        .await??;
        Ok::<_, Error>(())
    }
    .await;
    let result = match result {
        Ok(()) => install(host, data, call, &release, &staging, &control).await,
        Err(error) => Err(error),
    };
    let result = match result {
        // Once files have been published, finish the accepted KV commit even
        // when caller cancellation arrives. A crash before it causes a fresh
        // official download on retry, never adoption of an unanchored cache.
        Ok(receipt) => {
            save_receipt(
                host.storage.as_ref(),
                key,
                record.map(|row| row.revision),
                receipt,
            )
            .await
        }
        Err(error) => Err(error),
    };
    // Only this attempt's UUID directory is removed. No concurrent install's
    // staging or published version can be collected by another attempt.
    let cleanup = data
        .run(move |dir, _| match dir.remove_dir_all(staging) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        })
        .await;
    if !matches!(cleanup, Ok(Ok(()))) {
        // Retirement can deny private-file cleanup after all active workers
        // have settled. Disk residue is not an unowned network/process effect.
        // Preserve the original failure (including cancellation) when present.
        return match result {
            Err(error) => Err(error),
            Ok(()) => Err(Error::StagingCleanup),
        };
    }
    result?;
    Ok(release.agent(&root))
}

async fn install(
    host: &Services,
    data: &Directory,
    call: Scope,
    release: &Release,
    staging: &str,
    control: &Control,
) -> Result<archive::Receipt, Error> {
    let response = control
        .wait(host.http.request(
            call,
            http::Request {
                url: release.url.clone(),
                method: http::Method::Get,
                headers: vec![],
                body: vec![],
            },
        ))
        .await?
        .map_err(|_| Error::Download)?;
    let result = async {
        if response.head.status != 200 || response.head.url != release.url {
            return Err(Error::Download);
        }
        let mut bytes = 0_u64;
        let mut hash = Sha256::new();
        while let Some(chunk) = control
            .wait(response.body.next())
            .await?
            .map_err(|_| Error::Download)?
        {
            bytes = bytes
                .checked_add(chunk.len() as u64)
                .ok_or(Error::Integrity)?;
            if bytes > MAX_ARCHIVE || chunk.len() > MAX_CHUNK {
                return Err(Error::Integrity);
            }
            hash.update(&chunk);
            let path = format!("{staging}/download.zip");
            let control = control.clone();
            data.run(move |dir, retiring| {
                control.check(retiring)?;
                let mut options = cap_std::fs::OpenOptions::new();
                options.append(true);
                dir.open_with(path, &options)?.write_all(&chunk)?;
                Ok::<_, Error>(())
            })
            .await??;
        }
        let digest = format!("{:x}", hash.finalize());
        if bytes == 0
            || release.pinned.is_some_and(|pinned| pinned != digest)
            || (release.platform == "darwin-arm64" && bytes != 111_725_488)
        {
            return Err(Error::Integrity);
        }
        let release = release.clone();
        let staging = staging.to_owned();
        let control = control.clone();
        let receipt = data
            .run(move |dir, retiring| {
                archive::publish(dir, &release, &staging, bytes, digest, &control, retiring)
            })
            .await??;
        Ok(receipt)
    }
    .await;
    if result.is_err() {
        response.body.cancel();
    }
    if !matches!(
        tokio::time::timeout(Duration::from_secs(5), response.body.close()).await,
        Ok(Ok(()))
    ) {
        return Err(Error::Cleanup);
    }
    result
}

async fn save_receipt(
    store: &dyn Store,
    key: String,
    revision: Option<u64>,
    receipt: archive::Receipt,
) -> Result<(), Error> {
    let value = serde_json::to_value(receipt).map_err(|_| Error::Integrity)?;
    match store
        .batch(vec![Mutation {
            key: key.clone(),
            expected_revision: revision,
            data: Data::Present(value.clone()),
        }])
        .await
    {
        Ok(_) => Ok(()),
        Err(error @ StoreError::Conflict { .. }) => {
            let winner = store.read(key).await?;
            if winner.as_ref().and_then(|row| row.data.value()) == Some(&value) {
                Ok(())
            } else {
                Err(error.into())
            }
        }
        Err(error) => Err(error.into()),
    }
}
