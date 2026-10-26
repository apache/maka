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

//! Owned Root access and durable single-Host source recovery.
use crate::application::HostError;
use base64::{Engine, engine::general_purpose::STANDARD};
use maka_event_log::{
    applications::{LoadedDeployment, PreparedApplication},
    root_store::RootStore,
};
use maka_packages::Package;
use maka_plugin_core::{
    composition::Input,
    deployment::{DeploymentRef, RemoteObservation},
};
use std::collections::BTreeMap;
use uuid::Uuid;

// Test Roots are fresh. Keep the initial owner through SQL startup: dropping and
// reacquiring it can race a parallel child's inherited OFD lease before exec.
#[cfg(test)]
pub(super) async fn create(root: std::path::PathBuf) -> Result<RootStore, HostError> {
    use maka_event_log::root::{RootNamespaces, RootOwner};
    let owner = tokio::task::spawn_blocking(move || {
        RootOwner::create(&root, &RootNamespaces::for_current_account()?)
    })
    .await??;
    Ok(maka_transport::open_store(std::sync::Arc::new(owner)).await?)
}

pub(super) fn decode_packages(
    files: Vec<BTreeMap<String, String>>,
) -> Result<Vec<Package>, HostError> {
    files
        .into_iter()
        .map(|files| {
            let files = files
                .into_iter()
                .map(|(name, encoded)| {
                    let bytes = STANDARD.decode(encoded)?;
                    Ok::<_, HostError>((name, bytes))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()?;
            Ok(Package::new(files)?)
        })
        .collect()
}
pub(super) async fn ensure(
    store: &RootStore,
    deployment: Uuid,
    input: &Input,
    observations: &[RemoteObservation],
    packages: &[Package],
) -> Result<(), HostError> {
    ensure_prepared(
        store,
        deployment,
        PreparedApplication::new(input.clone(), observations.to_vec(), packages.to_vec())?,
    )
    .await
    .map(|_| ())
}

pub(super) async fn ensure_prepared(
    store: &RootStore,
    deployment: Uuid,
    prepared: PreparedApplication,
) -> Result<LoadedDeployment, HostError> {
    let input = prepared.input();
    let observations = prepared.remote_exports();
    let packages = prepared.packages();
    let reference = DeploymentRef {
        state_domain: store.owned_root()?.root_id().into(),
        deployment,
        revision: 1,
    };
    if let Some(original) = store.load_application_at(&reference).await? {
        let mut actual: Vec<_> = original
            .packages()
            .iter()
            .map(Package::application_ref)
            .collect();
        let mut expected: Vec<_> = packages.iter().map(Package::application_ref).collect();
        actual.sort();
        expected.sort();
        if serde_json::to_value(&original.source().input)? != serde_json::to_value(input)?
            || serde_json::to_value(&original.source().remote_exports)?
                != serde_json::to_value(observations)?
            || actual != expected
        {
            return Err(
                "original product initialization source conflicts with stored revision 1".into(),
            );
        }
        // Initialization compares revision one, but execution selects the current
        // head. Reuse the original only while it remains the observed head.
        let head = store
            .read_application_metadata(deployment)
            .await?
            .ok_or("Host source missing")?;
        if head.source.reference == original.source().reference {
            return Ok(original);
        }
        store
            .load_application_at(&head.source.reference)
            .await?
            .ok_or_else(|| "Host source missing".into())
    } else {
        Ok(store
            .commit_prepared_application(deployment, 0, prepared)
            .await?)
    }
}

pub(super) async fn ensure_replacement(
    store: &RootStore,
    deployment: Uuid,
    expected: u64,
    input: &Input,
    observations: &[RemoteObservation],
    packages: &[Package],
) -> Result<(), HostError> {
    let current = store
        .load_application(deployment)
        .await?
        .ok_or("restore source missing")?;
    let mut actual: Vec<_> = current
        .packages()
        .iter()
        .map(Package::application_ref)
        .collect();
    let mut desired: Vec<_> = packages.iter().map(Package::application_ref).collect();
    actual.sort();
    desired.sort();
    let matches = actual == desired
        && serde_json::to_value(&current.source().input)? == serde_json::to_value(input)?
        && serde_json::to_value(&current.source().remote_exports)?
            == serde_json::to_value(observations)?;
    if matches
        && (current.source().reference.revision == expected
            || current.source().reference.revision == expected + 1)
    {
        return Ok(());
    }
    if current.source().reference.revision != expected {
        return Err("restoration conflicts with a later source revision".into());
    }
    store
        .commit_application(
            deployment,
            expected,
            input.clone(),
            observations.to_vec(),
            packages.to_vec(),
        )
        .await?;
    Ok(())
}
