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

use crate::args::Root;
use clap::Args;
use maka_agent_facts::configuration::policy::NetworkProxy;
use maka_agent_facts::configuration::policy::network_update::CredentialUpdate;
use maka_agent_facts::configuration::policy::network_update::Update;
use maka_agent_facts::configuration::policy::network_update::UpdateResult;
use maka_config::ConfigurationStore;
use maka_event_log::root::{RootNamespaces, RootOwner, initialize};
use maka_host_runtime::HostError;
use serde::Deserialize;
use std::{
    io::Read,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Args)]
pub(super) struct Init {
    #[command(flatten)]
    root: Root,
    /// Read initial proxy settings from stdin. Requires a new, empty root.
    #[arg(long)]
    pub(super) settings_stdin: bool,
}

/// Bootstrap secrets travel through stdin, never command arguments or diagnostics.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    network_proxy: Option<NetworkProxy>,
    proxy_password: Option<String>,
}

impl Init {
    pub async fn run(self) -> Result<(), HostError> {
        let namespaces = RootNamespaces::for_current_account()?;
        let id = if self.settings_stdin {
            let settings = Settings::parse(&settings_input().await?)?;
            let update = settings.proxy_update()?;
            // Never reconfigure an existing root or race its running Host.
            let owner = Arc::new(RootOwner::create(&self.root.root, &namespaces)?);
            let id = owner.root_id().to_owned();
            let store = ConfigurationStore::for_root(owner).await?;
            if let Some(update) = update {
                let now = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
                if !matches!(
                    store.update_network_proxy(update, now).await?,
                    UpdateResult::Committed { .. }
                ) {
                    return Err("initial proxy settings were not committed".into());
                }
            }
            store.close().await?;
            id
        } else {
            initialize(&self.root.root, &namespaces)?
        };
        println!("{}", serde_json::json!({"rootId":id}));
        Ok(())
    }
}

pub(crate) async fn settings_input() -> Result<Vec<u8>, HostError> {
    Ok(tokio::task::spawn_blocking(|| {
        let mut bytes = Vec::new();
        std::io::stdin().lock().read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    })
    .await??)
}

// Validate the entire input before handing it to a detached worker. If replay
// is cut short, only trailing whitespace may be lost from an accepted JSON value.
pub(crate) fn validate_settings_input(bytes: &[u8]) -> std::io::Result<()> {
    Settings::parse(bytes).map(|_| ())
}

impl Settings {
    fn parse(bytes: &[u8]) -> std::io::Result<Self> {
        serde_json::from_slice(bytes).map_err(|_| std::io::Error::other("invalid initial settings"))
    }

    fn proxy_update(&self) -> Result<Option<Update>, HostError> {
        let Some(proxy) = &self.network_proxy else {
            return if self.proxy_password.is_some() {
                Err("proxy password requires proxy settings".into())
            } else {
                Ok(None)
            };
        };
        let credential = match (proxy.auth_enabled, &self.proxy_password) {
            (true, Some(secret)) => CredentialUpdate::Replace {
                secret: secret.clone(),
                expected_target: None,
            },
            (false, None) => CredentialUpdate::Delete {},
            _ => return Err("proxy authentication does not match its credential".into()),
        };
        let mut update = Update {
            expected_policy_revision: 0,
            expected_credential: None,
            network_proxy: proxy.clone(),
            credential,
        };
        update.normalize()?;
        Ok(Some(update))
    }
}
