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

use futures_util::future::BoxFuture;
use maka_capabilities::{
    call::{Identity, Issuer, Scope},
    http,
    storage::Directories,
};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_external_agent::install;
use maka_plugin_core::storage::Namespace;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

// Replay the official archive from disk so release verification works offline.
struct Archive(PathBuf);
struct Body(tokio::sync::Mutex<tokio::fs::File>);
impl http::Client for Archive {
    fn request(
        &self,
        _: Scope,
        request: http::Request,
    ) -> BoxFuture<'_, Result<http::Response, http::Error>> {
        Box::pin(async move {
            let file = tokio::fs::File::open(&self.0)
                .await
                .map_err(|e| http::Error::Failed(e.to_string()))?;
            Ok(http::Response {
                head: http::Head {
                    status: 200,
                    url: request.url,
                    headers: vec![],
                },
                body: Arc::new(Body(tokio::sync::Mutex::new(file))),
            })
        })
    }
}
impl http::Body for Body {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async move {
            let mut chunk = vec![0; 1024 * 1024];
            let n = self
                .0
                .lock()
                .await
                .read(&mut chunk)
                .await
                .map_err(|e| http::Error::Failed(e.to_string()))?;
            chunk.truncate(n);
            Ok((n != 0).then_some(chunk))
        })
    }
    fn cancel(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
#[ignore = "requires MAKA_ACP_RELEASE_ARCHIVE pointing to the current platform's official distribution"]
async fn official_receipt_delivers_both_release_files_to_the_private_task()
-> Result<(), Box<dyn std::error::Error>> {
    let archive = Archive(
        std::env::var_os("MAKA_ACP_RELEASE_ARCHIVE")
            .ok_or("MAKA_ACP_RELEASE_ARCHIVE is required")?
            .into(),
    );
    let temp = tempfile::tempdir()?;
    let dir = temp.path();
    let owner = Arc::new(RootOwner::create(
        &dir.join("state"),
        &RootNamespaces {
            ownership: dir.join("owners"),
            control: dir.join("control"),
        },
    )?);
    let root = owner.canonical_path().to_owned();
    let store =
        Arc::new(maka_transport::open_store(owner, &maka_product_native::root_migrations()).await?);
    let ns = Namespace::new(
        maka_agent_api::acp::IMPLEMENTATION,
        maka_plugin_core::scope::Scope::Profile,
    )?;
    let kv = maka_host_runtime::storage::Storage::new(store.clone(), "release/".into(), ns.clone());
    let stop = CancellationToken::new();
    let call = Issuer::default().issue(Identity::Native, stop.clone())?;
    let data = Directories::open(&root)?.bind(&ns, call.clone())?;
    let agent = install::antigravity(&kv, &archive, &data, call, &stop).await?;
    let executable = Path::new(&agent.executable);
    let program = install::installed_program(&kv, &data, executable).await?;
    let expected = [
        (program.executable.name, program.executable.sha256),
        (program.helper.name, program.helper.sha256),
    ];
    store.shutdown().await?;

    let source = dir.join("workspace");
    std::fs::create_dir(&source)?;
    let mut task = super::private_release_task(&source, &root).await?;
    let mut command = maka_process::Command::private_task(executable);
    task.bind_installed_program(&mut command, Arc::new(program))
        .await?;
    let runtime = task.inputs().join("runtime");
    for (name, digest) in expected {
        assert_eq!(super::file_digest(&runtime.join(name))?, digest, "{name}");
    }
    task.into_no_launch_seal().record().await?;
    Ok(())
}
