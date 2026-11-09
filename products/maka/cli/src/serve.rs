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

use maka_host_runtime::{
    HostError,
    application::host::{Host, LifecycleMode, Options, websocket::WebSocketListener},
};
use serde_json::json;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    path: &Path,
    websocket: Option<std::net::SocketAddr>,
    expected_root: Option<&str>,
) -> Result<(), maka_host_runtime::HostError> {
    use maka_event_log::root::{ROOT_MARKER, RootNamespaces, RootOwner};
    let namespaces = RootNamespaces::for_current_account()?;
    let owner = if path.join(ROOT_MARKER).exists() {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            match RootOwner::open(path, &namespaces) {
                Ok(owner) => break owner,
                Err(error)
                    if expected_root.is_some()
                        && error.kind() == std::io::ErrorKind::WouldBlock
                        && tokio::time::Instant::now() < deadline =>
                {
                    // launchd can start the job while its registrar still
                    // holds Root. Admission happens only after acquisition.
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
    } else if expected_root.is_none() {
        RootOwner::create(path, &namespaces)?
    } else {
        return Err("service State Root must already be installed".into());
    };
    if expected_root.is_some_and(|expected| expected != owner.root_id()) {
        return Err("service State Root identity changed".into());
    }
    if expected_root.is_none() {
        let logs = maka_host_runtime::logs::Source::from_owner(&owner)?;
        eprintln!("Host diagnostics: {}", logs.path().display());
        crate::logging::capture(logs.open_capture()?)?;
    }
    let deployment = crate::deployment::admit(&owner, crate::deployment::Mode::Supervised).await?;
    if expected_root.is_some() && deployment.is_none() {
        return Err("service State Root must have a supervised deployment".into());
    }
    let websocket = match deployment
        .as_ref()
        .map(|deployment| deployment.websocket)
        .or(websocket)
    {
        Some(address) => Some(WebSocketListener::bind(address, Vec::new()).await?),
        None => None,
    };
    let host = crate::application::open_host(
        owner,
        Options {
            lifecycle_mode: LifecycleMode::Service,
            generation: deployment
                .as_ref()
                .map(|deployment| deployment.generation()),
            ..Default::default()
        },
        deployment
            .as_ref()
            .map(|deployment| {
                crate::application::Roots::Configured(deployment.project_directory_roots.clone())
            })
            .unwrap_or(crate::application::Roots::Saved),
        None,
    )
    .await?;
    serve_product(host, websocket).await
}
async fn serve_product(
    mut product: crate::application::ProductHost,
    websocket: Option<WebSocketListener>,
) -> Result<(), HostError> {
    let result = async {
    let host = &product.host;
    let endpoint = super::endpoint::LocalEndpoint::bind()?;
    let cancellation = CancellationToken::new();
    let _signals = super::signals::watch(cancellation.clone())?;
    let registration = host.publish_registration(
        &endpoint.path,
        websocket
            .as_ref()
            .map(|listener| listener.local_addr())
            .transpose()?,
    )?;
    let mut ready = json!({"kind":"ready","rootId":host.root_id(),"hostEpoch":host.epoch(),"socketPath":endpoint.path});
    if let Some(listener) = &websocket {
        ready["websocketUrl"] = format!("ws://{}/runtime-host", listener.local_addr()?).into();
    }
    println!("{ready}");
    let result = listen(endpoint, websocket, host.clone(), cancellation).await;
    result.and(registration.remove().map_err(Into::into))
    }.await;
    let cleanup = product.shutdown().await;
    result.and(cleanup)
}

pub(super) async fn listen(
    endpoint: super::endpoint::LocalEndpoint,
    websocket: Option<WebSocketListener>,
    host: Arc<Host>,
    cancellation: CancellationToken,
) -> Result<(), HostError> {
    host.serve(endpoint.listener, websocket, cancellation)
        .await
        .map_err(Into::into)
}

pub(super) fn home_directory() -> Result<Option<std::path::PathBuf>, maka_host_runtime::HostError> {
    #[cfg(unix)]
    let instructions = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(std::path::PathBuf::from);
    #[cfg(windows)]
    let instructions = Some(maka_sandbox::account_home()?);
    Ok(instructions)
}
