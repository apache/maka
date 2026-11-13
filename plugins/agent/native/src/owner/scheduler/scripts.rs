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

use super::*;
use maka_process::{ProcessOutcome, ShellExecutor, Termination};
use maka_sandbox::Sandbox;

pub(super) struct Check {
    pub id: String,
    pub revision: u64,
    pub result: Result<bool, String>,
}

impl Owner {
    pub(super) async fn check_automation(
        &self,
        approval: super::super::notifications::BackgroundApproval,
        source: String,
    ) -> Result<bool, String> {
        let session = self.session(&approval.target.session_id).await?;
        let config = session.configuration;
        if session.archived
            || config.binding != approval.target.binding
            || config.boundary_revision != approval.target.boundary_revision
            || config.workspace != approval.target.workspace
            || config.permissions != approval.target.permissions
        {
            return Err("Conversation access changed. Update this automation to continue.".into());
        }
        let sandbox = self
            .capture_sandbox(
                &config,
                approval
                    .sandbox_ceiling
                    .as_ref()
                    .unwrap_or(&Sandbox::Disabled),
            )
            .await?;
        let workspace = config.workspace;
        let executor = tokio::task::spawn_blocking(move || {
            let path = std::path::PathBuf::from(workspace.path);
            let directory = maka_fs_tools::directory::open(&path, &workspace.directory_identity)
                .map_err(reason)?;
            ShellExecutor::from_directory(path, directory.into_std_file(), sandbox).map_err(reason)
        })
        .await
        .map_err(reason)??;
        let network = self
            .configuration
            .network_configuration()
            .await
            .map_err(reason)?;
        let route =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(reason)?;
        let executor = executor.with_network_route(route);
        #[cfg(target_os = "linux")]
        let executor = executor.with_network_helper(self.helper.clone());
        #[cfg(windows)]
        let executor =
            executor.with_backend(Arc::new(maka_host_runtime::sandbox::windows::Backend::new(
                self.store.owned_root().map_err(reason)?.canonical_path(),
                &self.helper,
            )));
        run_script(
            executor,
            self.helper.clone(),
            source,
            self.stop.child_token(),
        )
        .await
    }
}

async fn run_script(
    executor: ShellExecutor,
    executable: std::path::PathBuf,
    source: String,
    cancellation: CancellationToken,
) -> Result<bool, String> {
    let args = [maka_js_runtime::automation::WORKER.to_owned()];
    let command = executor
        .command_program(executable, &args, &BTreeMap::new())
        .map_err(reason)?;
    let output = command
        .run_with_input(source.into_bytes(), 30_000, cancellation)
        .await
        .map_err(reason)?;
    match output.outcome {
        ProcessOutcome::Exited(status) if status.success() => {
            match output.stdout.lines().last().map(str::trim) {
                Some("true") => Ok(true),
                Some("false") => Ok(false),
                _ => Err("The script must print true or false on its last stdout line".into()),
            }
        }
        ProcessOutcome::Exited(status) => {
            let stderr = output.stderr.trim();
            Err(if stderr.is_empty() {
                format!("Script failed ({status})")
            } else {
                format!("Script failed ({status}): {stderr}")
            })
        }
        ProcessOutcome::Interrupted {
            reason: Termination::Timeout,
            ..
        } => Err("Script check timed out".into()),
        ProcessOutcome::Interrupted {
            reason: Termination::Cancelled,
            ..
        } => Err("Script check cancelled".into()),
    }
}
