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
use cua_driver_core::browser::{ExtensionAdapterMode, host_handoff::ConfiguredHandoff};

async fn configured() -> Result<Option<ConfiguredHandoff>, ToolError> {
    tokio::task::spawn_blocking(ConfiguredHandoff::load)
        .await
        .map_err(failed)?
        .map_err(failed)
}

pub(super) enum HandoffDiscovery {
    Selected {
        extension_id: String,
        hosts: std::collections::HashSet<u32>,
    },
    Unconfigured {
        managed: std::collections::HashSet<u32>,
    },
}

impl HandoffDiscovery {
    pub(super) fn allows(
        &self,
        endpoint: &cua_driver_core::browser::ExtensionEndpointIdentity,
    ) -> bool {
        match self {
            Self::Selected {
                extension_id,
                hosts,
            } => endpoint.extension_id == *extension_id && hosts.contains(&endpoint.host_pid),
            Self::Unconfigured { managed } => !managed.contains(&endpoint.host_pid),
        }
    }
}

pub(super) async fn selected_handoff_hosts() -> Result<HandoffDiscovery, ToolError> {
    tokio::task::spawn_blocking(|| {
        use cua_driver_core::browser::host_handoff::recorded_native_hosts;
        let configured = ConfiguredHandoff::load().map_err(failed)?;
        let receipts = recorded_native_hosts().map_err(failed)?;
        let mut managed = std::collections::HashSet::new();
        let mut selected = std::collections::HashSet::new();
        for (family, receipt) in receipts {
            if crate::identity::live_process(receipt.pid)?.as_deref() == Some(&receipt.identity) {
                managed.insert(receipt.pid);
                if configured
                    .as_ref()
                    .is_some_and(|config| config.browser() == family)
                {
                    selected.insert(receipt.pid);
                }
            }
        }
        // An opt-in executable selects its registration scope. An unconfigured
        // executable cannot borrow a managed native host without its user lease.
        Ok(if let Some(config) = configured {
            HandoffDiscovery::Selected {
                extension_id: config.extension_id().to_owned(),
                hosts: selected,
            }
        } else {
            HandoffDiscovery::Unconfigured { managed }
        })
    })
    .await
    .map_err(failed)?
}

impl Browsers {
    pub(super) async fn append_handoff_candidate(
        &self,
        browsers: &mut Vec<Value>,
    ) -> Result<(), ToolError> {
        let Some(config) = configured().await? else {
            return Ok(());
        };
        if browsers.iter().any(|browser| {
            browser["id"] == "chatgpt"
                || browser["metadata"]["extensionId"] == config.extension_id()
        }) {
            return Ok(());
        }
        browsers.push(json!({
            "id": "chatgpt", "name": "ChatGPT", "type": "extension", "availability": "on_demand",
            "apiProfile": {"mode":"ax", "user":true}, "tabs": [],
            "capabilities": {"browser": capability::browser_info(), "tab": capability::tab_info()},
            "metadata": {"extensionId": config.extension_id()}
        }));
        Ok(())
    }

    pub(super) async fn acquire_handoff(
        &self,
        options: &BrowserOptions,
        cancellation: &CancellationToken,
    ) -> Result<bool, ToolError> {
        let id = options.id.as_deref();
        if id.is_some_and(|id| {
            self.connections
                .iter()
                .any(|connection| connection.id == id)
        }) {
            return Ok(false);
        }
        if id.is_some_and(|id| {
            id != "chatgpt"
                && !self.extension_providers.iter().any(|provider| {
                    provider.id() == id
                        && provider.extension_mode() == Some(ExtensionAdapterMode::Chatgpt)
                })
        }) {
            return Ok(false);
        }
        let cell = self
            .host()
            .await
            .lock()
            .await
            .handoffs
            .get(&self.owner)
            .cloned();
        if let Some(cell) = cell
            && cell
                .lock()
                .await
                .as_ref()
                .is_some_and(|lease| lease.is_live())
        {
            return Ok(false);
        }
        let Some(config) = configured().await? else {
            return Ok(false);
        };
        if id.is_none() {
            if let Some(url) = &options.url {
                normalized_url(url)?;
            }
            if self
                .providers(None)?
                .iter()
                .any(|provider| provider.extension_mode() != Some(ExtensionAdapterMode::Chatgpt))
            {
                return Ok(false);
            }
        }
        self.acquire_owner_handoff(config, cancellation).await
    }

    async fn acquire_owner_handoff(
        &self,
        config: ConfiguredHandoff,
        cancellation: &CancellationToken,
    ) -> Result<bool, ToolError> {
        let cell = self
            .host()
            .await
            .lock()
            .await
            .handoffs
            .entry(self.owner)
            .or_default()
            .clone();
        let mut lease = cell.lock().await;
        if lease.as_ref().is_some_and(|lease| lease.is_live()) {
            return Ok(false);
        }
        if let Some(previous) = lease.as_mut() {
            previous.release().await?;
        }
        *lease = Some(crate::host_handoff::Lease::acquire(config, self.owner, cancellation).await?);
        Ok(true)
    }

    pub(super) async fn ensure_provider_handoff(
        &self,
        provider: &Provider,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        let Some(extension) = provider.extension() else {
            return Ok(());
        };
        if ExtensionAdapterMode::from_host_name(&extension.identity().adapter)
            != Some(ExtensionAdapterMode::Chatgpt)
        {
            return Ok(());
        }
        let cell = self
            .host()
            .await
            .lock()
            .await
            .handoffs
            .get(&self.owner)
            .cloned();
        if let Some(cell) = cell
            && cell
                .lock()
                .await
                .as_ref()
                .is_some_and(|lease| lease.is_live())
        {
            return Ok(());
        }
        let Some(config) = configured().await? else {
            return Ok(());
        };
        if self.acquire_owner_handoff(config, cancellation).await? {
            let endpoints = cua_driver_core::browser::discover_installed_extension_endpoints()
                .await
                .map_err(failed)?;
            if !endpoints
                .endpoints
                .iter()
                .any(|endpoint| endpoint.identity() == extension.identity())
            {
                return Err(failed(
                    "stale_browser: host generation changed during handoff; select the browser again",
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn release_browser(
        &mut self,
        browser_id: &str,
        turn: &str,
    ) -> Result<Value, ToolError> {
        if self
            .connections
            .iter()
            .any(|connection| connection.id == browser_id)
            || !(browser_id == "chatgpt"
                || browser_id.starts_with("extension:com.openai.codexextension:"))
        {
            return Err(failed(
                "browser.release is available for the on-demand ChatGPT connector",
            ));
        }
        self.retire_handoff_resources(Some(turn)).await?;
        self.release_handoff_user().await?;
        Ok(Value::Null)
    }

    pub(super) async fn retire_handoff_resources(
        &mut self,
        turn: Option<&str>,
    ) -> Result<(), ToolError> {
        let host = self.host().await;
        let cell = host.lock().await.handoffs.get(&self.owner).cloned();
        let Some(cell) = cell else {
            return Ok(());
        };
        if cell.lock().await.is_none() {
            return Ok(());
        }
        {
            let ledger = host.lock().await;
            for lease in ledger.tabs.values().filter(|lease| {
                lease.creator.owner == self.owner
                    && lease.creator.provider.extension_adapter()
                        == Some(ExtensionAdapterMode::Chatgpt)
            }) {
                if let Some(input) = &lease.input {
                    input.check_settled()?;
                }
                if turn.is_some_and(|turn| lease.creator.turn == turn)
                    && !matches!(lease.retention, ownership::Retention::Handoff)
                {
                    lease.retention.mark()?;
                }
            }
        }
        self.drain_handoff_controls().await?;
        for tab in self
            .targets
            .values_mut()
            .filter(|tab| tab.provider.extension_adapter() == Some(ExtensionAdapterMode::Chatgpt))
        {
            tab.begin_disconnect();
            tab.disconnect().await?;
            tab.refs.clear();
            tab.frames = frames::Frames::default();
            tab.frame = None;
            tab.previous = None;
        }
        if let Some(turn) = turn {
            let finished = host
                .lock()
                .await
                .finish_extension(self.owner, Some(turn), Some(ExtensionAdapterMode::Chatgpt))
                .await?;
            let finished: std::collections::HashSet<_> = finished.into_iter().collect();
            self.targets.retain(|_, tab| {
                tab.identity()
                    .is_ok_and(|identity| !finished.contains(&identity))
            });
        }
        host.lock()
            .await
            .park_extension_owner(self.owner, Some(ExtensionAdapterMode::Chatgpt))
            .await?;
        self.extension_providers
            .retain(|provider| provider.extension_adapter() != Some(ExtensionAdapterMode::Chatgpt));
        Ok(())
    }

    pub(super) async fn release_handoff_user(&self) -> Result<(), ToolError> {
        let host = self.host().await;
        let cell = host.lock().await.handoffs.get(&self.owner).cloned();
        let Some(cell) = cell else {
            return Ok(());
        };
        let mut held = cell.lock().await;
        let Some(lease) = held.as_mut() else {
            return Ok(());
        };
        let remaining = lease
            .release()
            .await
            .map_err(|error| ToolError::CleanupUnconfirmed(error.to_string()))?;
        *held = None;
        if remaining == 0 {
            // Every source transport is gone only after the last guardian user
            // receives its restoration acknowledgement. Other users keep their
            // canonical session connection for a later authorized attachment.
            host.lock().await.forget_parked_handoff(self.owner);
            self.driver
                .lock()
                .await
                .extension_browsers
                .close_adapter(self.owner, "com.openai.codexextension")
                .await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_handoff::Lease;
    use cua_driver_core::browser::host_handoff::transport::Listener;
    use cua_driver_core::browser::host_handoff::transport::{Connection, Message};

    #[tokio::test]
    async fn dead_supervisor_and_failed_restore_never_erase_release_debt() {
        for fail_restore in [false, true] {
            #[cfg(unix)]
            let parent = std::fs::canonicalize("/tmp").unwrap();
            #[cfg(windows)]
            let parent = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            let directory = tempfile::tempdir_in(parent).unwrap();
            let path = std::fs::canonicalize(directory.path()).unwrap().join("ipc");
            let mut listener = Listener::bind(&path).await.unwrap();
            let connection = Connection::connect(&path).await.unwrap();
            let server = tokio::spawn(async move {
                let mut client = listener.accept().await.unwrap();
                if fail_restore {
                    assert!(matches!(
                        client.receive().await.unwrap(),
                        Some(Message::Release)
                    ));
                    client
                        .send(&Message::Failed {
                            message: "restore fixture failed".into(),
                        })
                        .await
                        .unwrap();
                }
                drop(client);
                listener.close(&path).unwrap();
            });
            let lease = Lease::watch(connection);
            let browsers = crate::browser::Browsers::new(std::sync::Arc::new(
                tokio::sync::Mutex::new(crate::Driver::default()),
            ));
            let host = browsers.host().await;
            host.lock().await.handoffs.insert(
                browsers.owner,
                std::sync::Arc::new(tokio::sync::Mutex::new(Some(lease))),
            );
            let first = browsers.release_handoff_user().await.unwrap_err();
            let second = browsers.release_handoff_user().await.unwrap_err();
            assert!(matches!(first, ToolError::CleanupUnconfirmed(_)));
            assert_eq!(first.to_string(), second.to_string());
            server.await.unwrap();
        }
    }
}
