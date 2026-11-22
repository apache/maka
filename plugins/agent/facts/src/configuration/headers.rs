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

use super::{
    ConnectionCredentialKind, ConnectionVersionBasis, CredentialLocator, CredentialVersionBasis,
    validation::{self, ValidationResult},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestHeaderUpdate {
    pub name: String,
    #[serde(
        default,
        deserialize_with = "super::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub value: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestHeadersQuery {
    pub connection_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestHeadersReplace {
    pub expected: RequestHeadersBasis,
    pub headers: Vec<RequestHeaderUpdate>,
}

impl RequestHeadersReplace {
    pub fn normalize(&mut self) -> ValidationResult {
        self.expected.validate()?;
        normalize_updates(&mut self.headers)
    }
}

/// Public, secret-free basis captured together with the visible header names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestHeadersBasis {
    pub connection: ConnectionVersionBasis,
    #[serde(deserialize_with = "Option::deserialize")]
    pub credential: Option<CredentialVersionBasis>,
}

impl RequestHeadersBasis {
    pub fn validate(&self) -> ValidationResult {
        validation::basis(&self.connection)?;
        if let Some(credential) = &self.credential {
            validation::credential_basis(credential)?;
            if credential.locator
                != (CredentialLocator::Connection {
                    connection_id: self.connection.connection_id.clone(),
                    kind: ConnectionCredentialKind::RequestHeaders,
                })
            {
                return Err("request headers credential basis does not match connection".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestHeadersQueryResult {
    Found {
        names: Vec<String>,
        basis: RequestHeadersBasis,
    },
    ConnectionNotFound,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestHeadersReplaceResult {
    Committed {
        names: Vec<String>,
        basis: RequestHeadersBasis,
    },
    Unchanged {
        names: Vec<String>,
        basis: RequestHeadersBasis,
    },
    ConnectionNotFound,
    ConnectionStale {
        expected: ConnectionVersionBasis,
        actual: ConnectionVersionBasis,
    },
    CredentialStale {
        #[serde(deserialize_with = "Option::deserialize")]
        expected: Option<CredentialVersionBasis>,
        #[serde(deserialize_with = "Option::deserialize")]
        actual: Option<CredentialVersionBasis>,
    },
}

pub fn normalize_updates(updates: &mut [RequestHeaderUpdate]) -> ValidationResult {
    let mut seen = BTreeSet::new();
    for update in updates {
        update.name = normalize_name(&update.name)?.into();
        if !seen.insert(update.name.to_ascii_lowercase()) {
            return Err("duplicate request header".into());
        }
        if let Some(value) = &update.value {
            validate_value(value)?;
        }
    }
    Ok(())
}

pub(crate) fn normalize_name(raw: &str) -> ValidationResult<&str> {
    let name = raw.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    if name.is_empty()
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&c))
    {
        return Err("invalid header name".into());
    }
    if [
        "authorization",
        "connection",
        "content-length",
        "content-type",
        "host",
        "proxy-authorization",
        "transfer-encoding",
        "x-api-key",
    ]
    .contains(&name.to_ascii_lowercase().as_str())
    {
        return Err("protected request header".into());
    }
    Ok(name)
}

pub(crate) fn validate_value(value: &str) -> ValidationResult {
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c == '\t' || (' '..='~').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c))
    {
        return Err("invalid header value".into());
    }
    Ok(())
}
