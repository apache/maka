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

mod storage;
pub(super) mod worker;

use super::{Deployment, RootId, directory, service, store};
use clap::{Args, ValueEnum};
use maka_event_log::root::FileLease;
use maka_host_runtime::HostError;
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};
pub(super) use storage::{read, write};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Policy {
    #[default]
    Manual,
    RustPreview,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub revision: u64,
    pub policy: Policy,
    pub next_check_ms: i64,
    pub last_error: Option<String>,
}

#[derive(Args)]
pub(crate) struct Configure {
    #[arg(long)]
    root_id: RootId,
    /// Omit to observe the saved policy without mutation.
    #[arg(long, value_enum)]
    policy: Option<Policy>,
    #[arg(long, requires = "policy", required_if_eq_any([("policy", "manual"), ("policy", "rust-preview")]))]
    expected_policy_revision: Option<u64>,
    #[arg(long, requires = "policy", required_if_eq_any([("policy", "manual"), ("policy", "rust-preview")]))]
    expected_deployment_id: Option<Uuid>,
}

impl Configure {
    pub async fn run(self) -> Result<(), HostError> {
        crate::operation::check()?;
        let directory = directory(&self.root_id.0)?;
        let store::Installation::Installed(current) = store::read(&directory).await? else {
            return Err("Host deployment is absent or incomplete".into());
        };
        current.validate_record(&directory)?;
        if current.root_id != self.root_id.0 {
            return Err("deployment root identity differs".into());
        }
        let Some(policy) = self.policy else {
            println!("{}", serde_json::to_string(&read(&directory).await?)?);
            return Ok(());
        };
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock"))?);
        match store::read(&directory).await? {
            store::Installation::Installed(active) if active == current => {}
            _ => return Err("deployment changed; query again".into()),
        }
        current.require_active()?;
        if Some(current.deployment_id) != self.expected_deployment_id {
            return Err("deployment identity changed".into());
        }
        let previous = read(&directory).await?;
        if Some(previous.revision) != self.expected_policy_revision {
            return Err("update policy changed; query again".into());
        }
        if policy != Policy::Manual {
            // First-generation previews lack this entrypoint. Do not register a
            // scheduler which can never work; upgrade the active Host first.
            let mut command = tokio::process::Command::new(&current.executable);
            command
                .args(["host", "auto-update", "--help"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
            let status =
                tokio::time::timeout(std::time::Duration::from_secs(5), command.status()).await??;
            if !status.success() {
                return Err(
                    "upgrade the installed native Host before enabling automatic updates".into(),
                );
            }
        }
        let mut next = previous.clone();
        if previous.policy != policy {
            next.revision = previous
                .revision
                .checked_add(1)
                .filter(|value| *value <= 9_007_199_254_740_991)
                .ok_or("update policy revision is exhausted")?;
            next.policy = policy;
            next.next_check_ms = 0;
            next.last_error = None;
            write(&directory, lease.clone(), &current, &previous, &next).await?;
        }
        // Authority is already committed. A failed projection is repairable by
        // repeating the same policy request; it must never be called a rollback.
        let projection = service::schedule(current, policy != Policy::Manual, lease).await;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Result {
            policy: Record,
            scheduling_error: Option<String>,
        }
        println!(
            "{}",
            serde_json::to_string(&Result {
                policy: next,
                scheduling_error: projection.err().map(|error| error.to_string()),
            })?
        );
        Ok(())
    }
}

pub(super) async fn require_revision(directory: &Path, revision: u64) -> Result<(), HostError> {
    let record = read(directory).await?;
    if record.revision != revision || record.policy == Policy::Manual {
        return Err("automatic update policy changed".into());
    }
    Ok(())
}

pub(super) fn now_ms() -> Result<i64, HostError> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}
