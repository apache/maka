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
use super::validation::*;
use super::*;
pub fn locator(value: &CredentialLocator) -> ValidationResult {
    if let CredentialLocator::Connection { connection_id, .. } = value {
        entity_id(connection_id)?;
    }
    Ok(())
}
pub fn credential_basis(value: &CredentialVersionBasis) -> ValidationResult {
    locator(&value.locator)?;
    entity_id(&value.credential_id)?;
    revision(value.revision, true)
}
pub fn credential_target(value: &ConnectionCredentialTarget) -> ValidationResult {
    entity_id(&value.connection_id)?;
    revision(value.revision, true)?;
    slug(&value.slug)?;
    value.provider.validate()?;
    provider_configuration(&value.configuration)
}
pub fn credential_status(value: &CredentialStatus) -> ValidationResult {
    locator(&value.locator)?;
    match &value.state {
        CredentialState::Configured {
            credential_id,
            revision: r,
            updated_at,
        } => {
            entity_id(credential_id)?;
            revision(*r, true)?;
            revision(*updated_at, false)
        }
        CredentialState::Absent => Ok(()),
    }
}
pub fn normalize_headers(secret: &str) -> ValidationResult<String> {
    serde_json::to_string(&parse_headers(secret)?).map_err(|_| "invalid headers".into())
}

pub fn parse_headers(secret: &str) -> ValidationResult<std::collections::BTreeMap<String, String>> {
    let entries: std::collections::BTreeMap<String, String> =
        serde_json::from_str(secret).map_err(|_| "request headers must map names to strings")?;
    let mut result = std::collections::BTreeMap::new();
    let mut seen = std::collections::BTreeSet::new();
    for (raw, v) in entries {
        let name = super::headers::normalize_name(&raw)?;
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err("duplicate request header".into());
        }
        super::headers::validate_value(&v)?;
        result.insert(name.to_owned(), v);
    }
    Ok(result)
}
pub fn validate_set_credential(value: &SetCredentialInput) -> ValidationResult {
    locator(&value.locator)?;
    if matches!(
        value.locator,
        CredentialLocator::Connection {
            kind: ConnectionCredentialKind::Provider,
            ..
        }
    ) {
        return Err("provider credentials require an authentication receipt".into());
    }
    if let Some(expected) = &value.expected {
        entity_id(&expected.credential_id)?;
        revision(expected.revision, true)?;
    }
    if let Some(expected) = &value.expected_connection {
        if !matches!(value.locator, CredentialLocator::Connection { .. }) {
            return Err("only connection credentials accept target basis".into());
        }
        credential_target(expected)?;
    }
    if value.secret.is_empty() {
        return Err("empty credential".into());
    }
    if matches!(
        value.locator,
        CredentialLocator::Connection {
            kind: ConnectionCredentialKind::RequestHeaders,
            ..
        }
    ) {
        normalize_headers(&value.secret)?;
    }
    if matches!(
        value.locator,
        CredentialLocator::Connection {
            kind: ConnectionCredentialKind::Usage,
            ..
        }
    ) {
        UsageAccessKey::parse(&value.secret)?;
        if value.expected_connection.is_none() {
            return Err("usage credentials require their connection basis".into());
        }
    }
    Ok(())
}
pub fn normalize_set_credential(value: &mut SetCredentialInput) -> ValidationResult {
    validate_set_credential(value)?;
    if matches!(
        value.locator,
        CredentialLocator::Connection {
            kind: ConnectionCredentialKind::RequestHeaders,
            ..
        }
    ) {
        value.secret = normalize_headers(&value.secret)?;
    }
    Ok(())
}

pub fn delete_credential(value: &DeleteCredentialInput) -> ValidationResult {
    credential_basis(&value.expected)?;
    match (&value.expected.locator, &value.expected_connection) {
        (CredentialLocator::Connection { connection_id, .. }, Some(target)) => {
            credential_target(target)?;
            if *connection_id != target.connection_id {
                return Err("credential belongs to another connection".into());
            }
            Ok(())
        }
        (CredentialLocator::NetworkProxy { .. }, None) => Ok(()),
        _ => Err("credential deletion requires its connection basis".into()),
    }
}
