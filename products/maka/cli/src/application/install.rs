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

use super::{HostError, Package, open_store};
use clap::Args;
use maka_plugin_core::deployment::management::PackageInstalled;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Args)]
pub(crate) struct InstallUrl {
    /// Business Host Root (default: ~/.maka/application/host). Stop its Host first.
    #[arg(long)]
    root: Option<PathBuf>,
    /// Omit to install into this Root's selected Host deployment.
    #[arg(long)]
    deployment: Option<Uuid>,
    #[arg(long)]
    url: String,
    /// Optional publisher-provided SHA-256 of the bundle bytes.
    #[arg(long)]
    sha256: Option<String>,
    /// Reject a source revision other than the one previously observed.
    #[arg(long)]
    expected_revision: Option<u64>,
}
impl InstallUrl {
    pub(super) async fn run(self) -> Result<(), HostError> {
        let store = open_store(super::product::root_path(self.root)?).await?;
        let result = async {
            let deployment = match self.deployment {
                Some(id) => id,
                None => {
                    let launch = store
                        .application_launch()
                        .await?
                        .ok_or("select --deployment for a Root without a saved product")?;
                    if launch.pending.is_some() {
                        return Err(
                            "finish the pending product operation before installing a package"
                                .into(),
                        );
                    }
                    launch.deployment
                }
            };
            let current = store
                .load_application(deployment)
                .await?
                .ok_or("deployment not found")?;
            let (source, mut packages, _, _) = current.into_parts();
            let revision = source.reference.revision;
            if self
                .expected_revision
                .is_some_and(|expected| expected != revision)
            {
                return Err("deployment revision conflict".into());
            }
            let bytes = maka_host_runtime::application::management::download_bundle(
                &self.url,
                self.sha256.as_deref(),
                &CancellationToken::new(),
            )
            .await?;
            let package =
                tokio::task::spawn_blocking(move || Package::from_bundle(&bytes)).await??;
            let reference = package.application_ref();
            if !packages
                .iter()
                .any(|old| old.application_ref() == reference)
            {
                packages.push(package);
            }
            let source = store
                .commit_application(
                    deployment,
                    revision,
                    source.input,
                    source.remote_exports,
                    packages,
                )
                .await?;
            Ok::<_, HostError>(PackageInstalled {
                source,
                package: reference,
            })
        }
        .await;
        store.drain().await;
        println!("{}", serde_json::to_string(&result?)?);
        Ok(())
    }
}
