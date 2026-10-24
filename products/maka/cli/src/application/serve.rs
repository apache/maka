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

//! Explicit persisted deployment served by the public Host owner.
use clap::Args;
use maka_host_runtime::{
    HostError,
    application::{
        NativeRegistry,
        host::{Configuration, Host, LifecycleMode, Options},
        transport::{HostEndpoint, NativeGrant},
    },
};
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Args)]
pub(crate) struct Serve {
    /// Existing State Root containing the committed Host deployment.
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    deployment: uuid::Uuid,
    /// Public endpoint selections and their explicit method grants in JSON.
    #[arg(long, value_name = "FILE")]
    endpoints: PathBuf,
    /// Explicit grants for native background calls in JSON.
    #[arg(long, value_name = "FILE")]
    native: Option<PathBuf>,
}
pub(super) fn native(
    catalog: Arc<maka_product_native::catalog::Catalog>,
) -> Result<NativeRegistry, HostError> {
    let mut native = NativeRegistry::default();
    maka_product_native::provide(&mut native, catalog)?;
    Ok(native)
}
pub(super) async fn run(args: Serve) -> Result<(), HostError> {
    let owner = tokio::task::spawn_blocking(move || {
        maka_event_log::root::RootOwner::open(
            &args.root,
            &maka_event_log::root::RootNamespaces::for_current_account()?,
        )
    })
    .await??;
    let logs = maka_host_runtime::logs::Source::from_owner(&owner)?;
    eprintln!("Host diagnostics: {}", logs.path().display());
    crate::logging::capture(logs.open_capture()?)?;
    let endpoints: BTreeMap<String, HostEndpoint> = super::read_json(&args.endpoints)?;
    let grants: Vec<NativeGrant> = args
        .native
        .as_deref()
        .map(super::read_json)
        .transpose()?
        .unwrap_or_default();
    let store = Arc::new(maka_transport::open_store(Arc::new(owner)).await?);
    let catalog = async {
        let configuration = maka_config::ConfigurationStore::for_root(store.owned_root()?).await?;
        Ok::<_, HostError>(maka_product_native::catalog::RuntimeCatalog::open(configuration).await?)
    }
    .await;
    let mut catalog = match catalog {
        Ok(catalog) => catalog,
        Err(error) => {
            store.drain().await;
            return Err(error);
        }
    };
    let opened = async {
        Ok::<_, HostError>(
            Host::open_with_options(
                store.clone(),
                args.deployment,
                native(catalog.catalog())?,
                Some(maka_host_js::factory(Default::default())),
                Configuration::PublicHost {
                    endpoints,
                    native: grants,
                    product_methods: Default::default(),
                },
                Options {
                    lifecycle_mode: LifecycleMode::Service,
                    ..Default::default()
                },
            )
            .await?,
        )
    }
    .await;
    let host = match opened {
        Ok(host) => super::ProductHost::admitted(host, catalog),
        Err(error) => {
            let cleanup = catalog.shutdown().await;
            store.drain().await;
            cleanup.map_err(HostError::from)?;
            return Err(error);
        }
    };
    serve(host).await
}
async fn serve(mut product: super::ProductHost) -> Result<(), HostError> {
    let result = async {
    let host = &product.host;
    let endpoint = crate::endpoint::LocalEndpoint::bind()?;
    let cancellation = CancellationToken::new();
    let _signals = crate::signals::watch(cancellation.clone())?;
    let registration = host.publish_registration(&endpoint.path, None)?;
    println!(
        "{}",
        json!({"kind":"ready","rootId":host.root_id(),"hostEpoch":host.epoch(),"socketPath":endpoint.path})
    );
    let result = crate::serve::listen(endpoint, None, host.clone(), cancellation).await;
    result.and(registration.remove().map_err(Into::into))
    }.await;
    let cleanup = product.shutdown().await;
    result.and(cleanup)
}
