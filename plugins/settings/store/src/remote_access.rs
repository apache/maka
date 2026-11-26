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

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode, vault};
use maka_remote_pairing::{RelayEndpoint, valid_relay_bearer};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteAccessConfig {
    pub enabled: bool,
    pub relay_only: bool,
    pub relays: Vec<RemoteRelayConfig>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteRelayConfig {
    pub endpoint: RelayEndpoint,
    pub ca_der_path: Option<PathBuf>,
    pub has_auth_token: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteAccessUpdate {
    pub enabled: bool,
    pub relay_only: bool,
    pub relays: Vec<RemoteRelayUpdate>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteRelayUpdate {
    pub endpoint: RelayEndpoint,
    pub ca_der_path: Option<PathBuf>,
    pub auth: RelayAuthUpdate,
}

// Write only: this type must never appear in a status or in persisted JSON.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "token", rename_all = "camelCase")]
pub enum RelayAuthUpdate {
    Keep,
    Clear,
    Replace(String),
}

#[derive(Serialize, Deserialize)]
struct SavedRelay {
    endpoint: RelayEndpoint,
    ca_der_path: Option<PathBuf>,
}

pub struct RemoteTransport {
    pub enabled: bool,
    pub relay_only: bool,
    pub relays: Vec<RemoteTransportRelay>,
}

// Trusted transport snapshot only; not serializable or printable.
pub struct RemoteTransportRelay {
    pub endpoint: RelayEndpoint,
    pub ca_der_path: Option<PathBuf>,
    pub auth_token: Option<String>,
}

// Not a service-level CredentialLocator: only Host administration can address these rows.
#[derive(Serialize)]
struct RelayTokenLocator<'a> {
    scope: &'static str,
    url: &'a str,
}

fn locator(url: &str) -> RelayTokenLocator<'_> {
    RelayTokenLocator {
        scope: "host_relay",
        url,
    }
}

fn saved(tx: &Connection) -> Result<(bool, bool, Vec<SavedRelay>)> {
    let (enabled, relay_only, relays): (bool, bool, String) = tx
        .prepare_cached(
            "SELECT enabled, relay_only, relays FROM host_remote_transport WHERE singleton = 1",
        )?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok((enabled, relay_only, serde_json::from_str(&relays)?))
}

fn public(tx: &Connection) -> Result<RemoteAccessConfig> {
    let (enabled, relay_only, saved) = saved(tx)?;
    let relays = saved
        .into_iter()
        .map(|relay| {
            let has_auth_token = tx
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM credentials WHERE locator = ?)")?
                .query_row(
                    [serde_json::to_string(&locator(&relay.endpoint.url))?],
                    |row| row.get(0),
                )?;
            Ok(RemoteRelayConfig {
                endpoint: relay.endpoint,
                ca_der_path: relay.ca_der_path,
                has_auth_token,
            })
        })
        .collect::<Result<_>>()?;
    Ok(RemoteAccessConfig {
        enabled,
        relay_only,
        relays,
    })
}

impl ConfigurationStore {
    pub async fn remote_access_config(&self) -> Result<RemoteAccessConfig> {
        self.transaction(TransactionMode::Deferred, public).await
    }

    /// Read a consistent, trusted-only transport snapshot, including Vault material.
    pub async fn remote_transport(&self) -> Result<RemoteTransport> {
        self.transaction(TransactionMode::Deferred, |tx| {
            let (enabled, relay_only, saved) = saved(tx)?;
            let relays = saved
                .into_iter()
                .map(|relay| {
                    let locator = locator(&relay.endpoint.url);
                    let auth_token = tx
                        .prepare_cached("SELECT secret FROM credentials WHERE locator = ?")?
                        .query_row([serde_json::to_string(&locator)?], |row| row.get(0))
                        .optional()?;
                    Ok(RemoteTransportRelay {
                        endpoint: relay.endpoint,
                        ca_der_path: relay.ca_der_path,
                        auth_token,
                    })
                })
                .collect::<Result<_>>()?;
            Ok(RemoteTransport {
                enabled,
                relay_only,
                relays,
            })
        })
        .await
    }

    pub async fn update_remote_access(
        &self,
        mut update: RemoteAccessUpdate,
        now: u64,
    ) -> Result<RemoteAccessConfig> {
        let invalid = |reason: &str| ConfigError::Invalid(reason.into());
        if update.enabled && update.relays.is_empty() {
            return Err(invalid("remote access requires a relay URL"));
        }
        let mut urls = BTreeSet::new();
        for relay in &mut update.relays {
            let endpoint = relay
                .endpoint
                .validate()
                .map_err(|error| invalid(&error.to_string()))?;
            if relay.ca_der_path.is_some() && relay.endpoint.cert_sha256.is_some() {
                return Err(invalid("choose either a relay leaf pin or a relay CA"));
            }
            if endpoint.url.scheme() != "https"
                && (relay.ca_der_path.is_some()
                    || matches!(relay.auth, RelayAuthUpdate::Replace(_)))
            {
                return Err(invalid(
                    "relay TLS trust and Bearer authentication require https://",
                ));
            }
            if let RelayAuthUpdate::Replace(token) = &relay.auth
                && !valid_relay_bearer(token)
            {
                return Err(invalid("invalid Bearer token"));
            }
            relay.endpoint.url = endpoint.url.to_string();
            if !urls.insert(relay.endpoint.url.clone()) {
                return Err(invalid("duplicate relay URL"));
            }
        }
        self.transaction(TransactionMode::Immediate, move |tx| {
            let (_, _, previous) = saved(tx)?;
            let mut changed = false;
            for relay in previous {
                if !urls.contains(&relay.endpoint.url) {
                    changed |= delete_token(tx, &locator(&relay.endpoint.url))?;
                }
            }
            let mut relays = Vec::with_capacity(update.relays.len());
            for relay in update.relays {
                let locator = locator(&relay.endpoint.url);
                match relay.auth {
                    RelayAuthUpdate::Keep => {}
                    RelayAuthUpdate::Clear => changed |= delete_token(tx, &locator)?,
                    RelayAuthUpdate::Replace(token) => {
                        vault::replace_secret(tx, &locator, &token, now)?;
                        changed = true;
                    }
                }
                relays.push(SavedRelay {
                    endpoint: relay.endpoint,
                    ca_der_path: relay.ca_der_path,
                });
            }
            if changed {
                vault::advance(tx)?;
            }
            tx.execute(
                "UPDATE host_remote_transport SET enabled = ?, relay_only = ?, relays = ? WHERE singleton = 1",
                params![update.enabled, update.relay_only, serde_json::to_string(&relays)?],
            )?;
            public(tx)
        }).await
    }
}

fn delete_token(tx: &Connection, locator: &RelayTokenLocator) -> Result<bool> {
    Ok(tx.execute(
        "DELETE FROM credentials WHERE locator = ?",
        [serde_json::to_string(locator)?],
    )? != 0)
}
