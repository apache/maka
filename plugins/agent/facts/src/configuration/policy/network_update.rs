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

use super::{NetworkProxy, ProxyProtocol, codec};
use crate::configuration::{
    CredentialLocator, CredentialStatus, CredentialVersionBasis, PasswordKind, validation,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub fn locator() -> CredentialLocator {
    CredentialLocator::NetworkProxy {
        kind: PasswordKind::Password,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialTarget {
    pub protocol: ProxyProtocol,
    pub host: String,
    pub port: u16,
    pub username: String,
}
impl CredentialTarget {
    pub fn from_proxy(proxy: &NetworkProxy) -> Self {
        Self {
            protocol: proxy.protocol,
            host: codec::trim(&proxy.host).to_lowercase(),
            port: proxy.port,
            username: proxy.username.clone(),
        }
    }
    pub fn normalize(&mut self) -> Result<(), String> {
        if self
            .host
            .chars()
            .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
        {
            return Err("proxy target host contains controls".into());
        }
        self.host = codec::trim(&self.host).to_lowercase();
        if self.host.is_empty() || self.port == 0 {
            return Err("invalid proxy credential target".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialUpdate {
    Keep {},
    Delete {},
    Replace {
        secret: String,
        #[serde(
            rename = "expectedTarget",
            default,
            deserialize_with = "crate::configuration::present",
            skip_serializing_if = "Option::is_none"
        )]
        expected_target: Option<CredentialTarget>,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub expected_policy_revision: u64,
    pub expected_credential: Option<CredentialVersionBasis>,
    pub network_proxy: NetworkProxy,
    pub credential: CredentialUpdate,
}
impl Update {
    pub fn normalize(&mut self) -> Result<(), String> {
        validation::revision(self.expected_policy_revision, false)?;
        codec::proxy(&mut self.network_proxy)?;
        if let Some(basis) = &self.expected_credential {
            validation::credential_basis(basis)?;
            if basis.locator != locator() {
                return Err("expected network proxy credential".into());
            }
        }
        if !self.network_proxy.auth_enabled
            && !matches!(self.credential, CredentialUpdate::Delete {})
        {
            return Err("disabled proxy authentication requires credential deletion".into());
        }
        if let CredentialUpdate::Replace {
            secret,
            expected_target,
        } = &mut self.credential
        {
            if secret.is_empty() {
                return Err("invalid proxy credential secret".into());
            }
            if let Some(target) = expected_target {
                target.normalize()?;
            }
        }
        Ok(())
    }
}
pub fn decode(mut value: Value) -> Result<Update, String> {
    if value.get("expectedCredential").is_none() {
        return Err("missing credential basis".into());
    }
    codec::integer_field(&mut value, "expectedPolicyRevision");
    for (key, field) in [("networkProxy", "port"), ("expectedCredential", "revision")] {
        if let Some(v) = value.get_mut(key) {
            codec::integer_field(v, field);
        }
    }
    if let Some(v) = value
        .get_mut("credential")
        .and_then(|v| v.get_mut("expectedTarget"))
    {
        codec::integer_field(v, "port");
    }
    let mut input: Update =
        serde_json::from_value(value).map_err(|_| "invalid network proxy update")?;
    input.normalize()?;
    Ok(input)
}
#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "NetworkProxyUpdateResult")]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UpdateResult {
    Committed {
        revision: u64,
        credential_status: CredentialStatus,
    },
    RevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
    ProxyTargetMismatch {
        expected: CredentialTarget,
        actual: CredentialTarget,
    },
    CredentialStale {
        #[schemars(
            with = "maka_plugin_core::wire_schema::RequiredNullable<CredentialVersionBasis>"
        )]
        expected: Option<CredentialVersionBasis>,
        #[schemars(
            with = "maka_plugin_core::wire_schema::RequiredNullable<CredentialVersionBasis>"
        )]
        actual: Option<CredentialVersionBasis>,
    },
}

/// Effective routing ignores dormant settings and duplicate/order-only bypass edits.
pub fn same_route(a: &NetworkProxy, b: &NetworkProxy) -> bool {
    if !a.enabled || !b.enabled {
        return a.enabled == b.enabled;
    }
    let patterns = |v: &NetworkProxy| -> BTreeSet<String> {
        v.bypass_list
            .iter()
            .chain(&v.auto_bypass_domains)
            .map(|s| codec::trim(s).to_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    };
    a.protocol == b.protocol
        && codec::trim(&a.host).to_lowercase() == codec::trim(&b.host).to_lowercase()
        && a.port == b.port
        && a.auth_enabled == b.auth_enabled
        && (!a.auth_enabled || a.username == b.username)
        && patterns(a) == patterns(b)
}
