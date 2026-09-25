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

use crate::{args::Root, endpoint::LocalEndpoint};
use clap::Args;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_runtime_host::server::{Host, HostError, HostOptions};
use std::{
    io::{BufRead, Read},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Args)]
pub(super) struct Candidate {
    #[command(flatten)]
    root: Root,
    #[arg(long)]
    expected_root_id: String,
    #[arg(long)]
    startup_attempt_id: uuid::Uuid,
    #[arg(long)]
    generation: Option<String>,
    #[arg(long, default_value_t = 20_000, value_parser = clap::value_parser!(u64).range(1..=300_000))]
    initial_connection_timeout_ms: u64,
    #[arg(long, default_value_t = 1_000, value_parser = clap::value_parser!(u64).range(0..=300_000))]
    idle_grace_ms: u64,
    #[arg(long, default_value_t = 2_000, value_parser = clap::value_parser!(u64).range(1..=300_000))]
    handshake_timeout_ms: u64,
    /// A dedicated launcher-owned stdin pipe; EOF means the owner disappeared.
    #[arg(long)]
    owner_stdin: bool,
}

impl Candidate {
    pub(super) async fn run(self) -> Result<(), HostError> {
        if std::env::var_os("MAKA_RUNTIME_HOST_LAUNCH_OWNER_LEASE_FD").is_some()
            || std::env::var_os("NODE_CHANNEL_FD").is_some()
        {
            return Err("native candidate requires its dedicated launcher pipe, not Node IPC or an updater lease".into());
        }
        let root = RootOwner::open(&self.root.root, &RootNamespaces::for_current_account()?)?;
        if root.root_id() != self.expected_root_id {
            return Err("candidate State Root identity mismatch".into());
        }
        let deployment = crate::deployment::admit(&root, crate::deployment::Mode::OnDemand).await?;
        let websocket = match &deployment {
            Some(deployment) => Some(
                maka_runtime_host::server::websocket::WebSocketListener::bind(
                    deployment.websocket,
                    Vec::new(),
                )
                .await?,
            ),
            None => None,
        };
        let cancel = CancellationToken::new();
        let _cancel_on_exit = cancel.clone().drop_guard();
        let owner_lost = CancellationToken::new();
        if self.owner_stdin {
            watch_owner(owner_lost.clone())?;
        }
        let signals = super::signals::watch(cancel.clone())?;
        let host = Host::open_with_options(
            root,
            super::serve::global_instructions()?,
            HostOptions {
                input_roots: Default::default(),
                plugins: Default::default(),
                lifecycle_mode: maka_runtime_host::server::LifecycleMode::Ephemeral,
                skill_home: super::serve::home_directory()?,
                project_directory_roots: deployment
                    .as_ref()
                    .and_then(|deployment| deployment.project_directory_roots.clone()),
                generation: deployment
                    .as_ref()
                    .map(|deployment| deployment.generation())
                    .or(self.generation),
                handshake_timeout: Duration::from_millis(self.handshake_timeout_ms),
            },
        )
        .await?;
        let endpoint = LocalEndpoint::bind()?;
        let registration = host.publish_registration(
            &endpoint.path,
            websocket
                .as_ref()
                .map(|listener| listener.local_addr())
                .transpose()?,
        )?;
        let idle_host = host.clone();
        let idle_cancel = cancel.clone();
        let idle_grace = if deployment.is_some() {
            30_000
        } else {
            self.idle_grace_ms
        };
        let expiry = tokio::spawn(async move {
            idle_host
                .wait_until_idle(
                    Duration::from_millis(self.initial_connection_timeout_ms),
                    Duration::from_millis(idle_grace),
                )
                .await;
            idle_cancel.cancel();
        });
        let serving = super::serve::listen(endpoint, websocket, host.clone(), cancel);
        tokio::pin!(serving);
        let result = tokio::select! {
            biased;
            _ = owner_lost.cancelled() => {
                // EOF abandons an unaccepted startup. Once a client was admitted,
                // ordinary Host residency and idle expiry own this lifetime.
                host.abandon_unaccepted_startup();
                serving.await
            }
            result = &mut serving => result,
        };
        expiry.abort();
        let _ = expiry.await;
        drop(signals);
        let removed = registration.remove();
        result.and(removed)
    }
}

fn watch_owner(cancel: CancellationToken) -> Result<(), HostError> {
    // This is a process-lifetime input thread, not a Tokio blocking task: an open launcher
    // pipe must not keep the async runtime's shutdown waiting. Process exit closes stdin.
    std::thread::Builder::new()
        .name("launch-owner".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let result = std::io::stdin()
                .lock()
                .take(4097)
                .read_until(b'\n', &mut bytes);
            let released = result.is_ok()
                && bytes.len() <= 4096
                && bytes.last() == Some(&b'\n')
                && serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|value| {
                    value == serde_json::json!({"kind":"runtime-host-launch-owner-release"})
                });
            if !released {
                cancel.cancel();
            }
        })?;
    Ok(())
}
