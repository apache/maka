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

use super::{Policy, Record, now_ms, read, write};
use crate::{
    deployment::{self, Admission, Deployment, RootId, directory, query, store, update::Action},
    distribution,
};
use clap::Args;
use maka_event_log::root::FileLease;
use maka_host_runtime::HostError;
use semver::Version;
use std::{path::Path, process::Stdio, sync::Arc};

#[derive(Args)]
pub(crate) struct Reconcile {
    #[arg(long)]
    root_id: RootId,
}

impl Reconcile {
    pub async fn run(self) -> Result<(), HostError> {
        crate::operation::check()?;
        let directory = directory(&self.root_id.0)?;
        let store::Installation::Installed(current) = store::read(&directory).await? else {
            return Ok(());
        };
        current.validate_record(&directory)?;
        if current.root_id != self.root_id.0 {
            return Err("deployment root identity differs".into());
        }
        if current.admission != Admission::Active {
            return Ok(());
        }
        // Pending can already carry a newer schema while Active still serves
        // old code. Select its executor before any policy writer or migration.
        let pending = query::pending(&directory, &current).await?;
        let executor = pending
            .as_ref()
            .map(|pending| &pending.deployment)
            .unwrap_or(&current)
            .executable
            .clone();
        if std::env::current_exe()?.canonicalize()? != executor {
            return execute(
                &executor,
                &[
                    "host".into(),
                    "auto-update".into(),
                    "--root-id".into(),
                    current.root_id,
                ],
            )
            .await;
        }
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock"))?);
        let previous = read(&directory).await?;
        if previous.policy == Policy::Manual || previous.next_check_ms > now_ms()? {
            return Ok(());
        }
        let mut claim = previous.clone();
        claim.next_check_ms = now_ms()? + 10 * 60 * 1000;
        claim.last_error = None;
        write(&directory, lease.clone(), &current, &previous, &claim).await?;
        drop(lease);
        // Neither the executor nor Root is held across any network request.
        let result = perform(&current, pending, &claim).await;
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock"))?);
        let store::Installation::Installed(active) = store::read(&directory).await? else {
            return Ok(());
        };
        // The new executable may have migrated policy storage. Its next
        // scheduled invocation owns completion bookkeeping; an old writer
        // must not open the newer schema after successful handoff.
        if active.executable != executor
            || query::pending(&directory, &active)
                .await?
                .is_some_and(|pending| pending.deployment.executable != executor)
        {
            return Ok(());
        }
        let previous = read(&directory).await?;
        if active.deployment_id != current.deployment_id || previous != claim {
            return Ok(());
        }
        let mut next = previous.clone();
        match result {
            Ok(()) => {
                if query::pending(&directory, &active).await?.is_none() {
                    next.next_check_ms = now_ms()? + 60 * 60 * 1000;
                }
            }
            Err(error) => next.last_error = Some(error.to_string().chars().take(2048).collect()),
        }
        write(&directory, lease, &active, &previous, &next).await
    }
}

async fn perform(
    current: &Deployment,
    pending: Option<super::super::updates::Pending>,
    claim: &Record,
) -> Result<(), HostError> {
    if let Some(target) = pending {
        // A frozen intent wins over channel changes and failed download retries.
        execute(
            &target.deployment.executable,
            &deployment::Expected::from_deployment(current, claim.revision)
                .arguments(Action::Reconcile),
        )
        .await?;
        return Ok(());
    }
    let version = distribution::preview_version().await?;
    let artifact = distribution::fetch(version).await?;
    execute(
        &artifact.executable,
        &deployment::Expected::from_deployment(current, claim.revision).arguments(Action::Update),
    )
    .await?;
    Ok(())
}

pub(in crate::deployment) async fn execute(
    executable: &Path,
    args: &[String],
) -> Result<(), HostError> {
    let mut command = tokio::process::Command::new(executable);
    crate::operation::check()?;
    let remaining = crate::operation::remaining(std::time::Duration::from_secs(180));
    command
        .args(args)
        .args(["--timeout-ms", &remaining.as_millis().max(1).to_string()])
        .stdin(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    let status = tokio::time::timeout(remaining, command.status())
        .await
        .map_err(
            |_| "update executor outcome is unconfirmed; query deployment status before recovery",
        )??;
    if !status.success() {
        return Err(format!("native update executor failed: {status}").into());
    }
    Ok(())
}

#[derive(Args)]
pub(crate) struct Upgrade {
    #[command(flatten)]
    expected: deployment::Expected,
    /// Exact native package version. Omit to resolve rust-preview once.
    #[arg(long)]
    version: Option<Version>,
}

impl Upgrade {
    pub async fn run(self) -> Result<(), HostError> {
        crate::operation::check()?;
        let version = match self.version {
            Some(version) => version,
            None => distribution::preview_version().await?,
        };
        let artifact = distribution::fetch(version).await?;
        // The selected distribution writes its own configuration and stages the
        // correct Windows console/service executable; arbitrary --source is absent.
        execute(
            &artifact.executable,
            &self.expected.arguments(Action::Update),
        )
        .await
    }
}
