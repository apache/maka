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

use crate::{ConfigurationStore, Result, TransactionMode, policy, vault};
use maka_agent_facts::configuration::CredentialLocator;
use maka_agent_facts::configuration::CredentialStatus;
use maka_agent_facts::configuration::PasswordKind;
use maka_agent_facts::configuration::policy::NetworkProxy;
use rusqlite::{Connection, OptionalExtension};
mod update;
pub(crate) use update::invalidate_tests;

/// Secret material for one immutable outbound routing decision. Never serialized.
#[derive(Clone)]
pub struct NetworkConfiguration {
    pub proxy: NetworkProxy,
    pub password: Option<String>,
}

pub(crate) struct NetworkSnapshot {
    pub configuration: NetworkConfiguration,
    credential: CredentialStatus,
}
impl NetworkSnapshot {
    pub fn read(tx: &Connection) -> Result<Self> {
        let proxy = policy::read(tx)?.policy.network_proxy;
        let locator = CredentialLocator::NetworkProxy {
            kind: PasswordKind::Password,
        };
        let credential = vault::status(tx, &locator)?;
        let password = tx
            .prepare_cached("SELECT secret FROM credentials WHERE locator = ?")?
            .query_row(rusqlite::params![serde_json::to_string(&locator)?], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(Self {
            configuration: NetworkConfiguration { proxy, password },
            credential,
        })
    }
    pub fn changed(&self, tx: &Connection) -> Result<bool> {
        if policy::read(tx)?.policy.network_proxy != self.configuration.proxy {
            return Ok(true);
        }
        if self.configuration.proxy.enabled && self.configuration.proxy.auth_enabled {
            let current = vault::status(tx, &self.credential.locator)?;
            return Ok(vault::status_basis(&current) != vault::status_basis(&self.credential));
        }
        Ok(false)
    }
}
impl ConfigurationStore {
    pub async fn network_configuration(&self) -> Result<NetworkConfiguration> {
        self.transaction(TransactionMode::Deferred, |tx| {
            Ok(NetworkSnapshot::read(tx)?.configuration)
        })
        .await
    }
}
