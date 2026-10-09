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

//! `connection.request-headers.query` and `connection.request-headers.replace`:
//! the custom HTTP headers a connection sends with every request. Their
//! values are secrets the Host keeps in its credential vault; a query
//! answers only the names, and a replace without a value keeps the one
//! saved under that name.
//!
//! Source: `packages/runtime-host/src/protocol/runtime-policy.ts`
//! (`RUNTIME_POLICY_OPERATION_SPECS`,
//! `decodeConnectionRequestHeadersQueryInput`,
//! `decodeConnectionRequestHeadersQueryResult`,
//! `decodeConnectionRequestHeadersReplaceInput`,
//! `decodeConnectionRequestHeadersReplaceResult`); an update is
//! `RequestHeaderUpdate`, checked by `normalizeRequestHeaderUpdates` in
//! packages/core/src/request-customization.ts.

use serde::{Deserialize, Serialize};

use crate::Operation;

/// `ConnectionRequestHeadersQueryInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionRequestHeadersQueryInput {
    pub connection_id: String,
}

impl ConnectionRequestHeadersQueryInput {
    pub fn new(connection_id: impl Into<String>) -> Self {
        Self { connection_id: connection_id.into() }
    }
}

/// `ConnectionRequestHeadersQueryResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionRequestHeadersQueryResult {
    /// The saved headers' names, in their order.
    Found {
        names: Vec<String>,
    },
    ConnectionNotFound,
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.request-headers.query` (mode `query`).
#[derive(Debug)]
pub enum ConnectionRequestHeadersQuery {}

impl Operation for ConnectionRequestHeadersQuery {
    const NAME: &'static str = "connection.request-headers.query";
    type Input = ConnectionRequestHeadersQueryInput;
    type Output = ConnectionRequestHeadersQueryResult;
}

/// `RequestHeaderUpdate`: a header to keep. Without a value it keeps the
/// value saved under its name. Its `Debug` leaves the value out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RequestHeaderUpdate {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

impl RequestHeaderUpdate {
    /// Keeps the value saved under `name`.
    pub fn keep(name: impl Into<String>) -> Self {
        Self { name: name.into(), value: None }
    }

    /// Saves `value` under `name`.
    pub fn set(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self { name: name.into(), value: Some(value.into()) }
    }
}

impl std::fmt::Debug for RequestHeaderUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RequestHeaderUpdate")
            .field("name", &self.name)
            .field("value", &self.value.as_ref().map(|_| "…"))
            .finish()
    }
}

/// `ConnectionRequestHeadersReplaceInput`: the whole set; a saved header
/// left out is deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionRequestHeadersReplaceInput {
    pub connection_id: String,
    /// At most 32, unique by name without regard to case.
    pub headers: Vec<RequestHeaderUpdate>,
}

impl ConnectionRequestHeadersReplaceInput {
    pub fn new(connection_id: impl Into<String>, headers: Vec<RequestHeaderUpdate>) -> Self {
        Self { connection_id: connection_id.into(), headers }
    }
}

/// `ConnectionRequestHeadersReplaceResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionRequestHeadersReplaceResult {
    /// Saved; the names as they now stand.
    Committed {
        names: Vec<String>,
    },
    /// The set was already saved as given.
    Unchanged {
        names: Vec<String>,
    },
    ConnectionNotFound,
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.request-headers.replace` (mode `command`).
#[derive(Debug)]
pub enum ConnectionRequestHeadersReplace {}

impl Operation for ConnectionRequestHeadersReplace {
    const NAME: &'static str = "connection.request-headers.replace";
    type Input = ConnectionRequestHeadersReplaceInput;
    type Output = ConnectionRequestHeadersReplaceResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_replace_keeps_saved_values_by_name_and_hides_new_ones() {
        let input = ConnectionRequestHeadersReplaceInput::new(
            "c1",
            vec![
                RequestHeaderUpdate::keep("HTTP-Referer"),
                RequestHeaderUpdate::set("X-Title", "Maka"),
            ],
        );
        assert_eq!(
            serde_json::to_value(&input).expect("encode"),
            json!({"connectionId": "c1",
                   "headers": [{"name": "HTTP-Referer"}, {"name": "X-Title", "value": "Maka"}]})
        );
        assert!(!format!("{input:?}").contains("Maka"), "the value stays out of logs");
    }

    #[test]
    fn results_decode_every_kind() {
        assert_eq!(
            serde_json::to_value(ConnectionRequestHeadersQueryInput::new("c1")).expect("encode"),
            json!({"connectionId": "c1"})
        );
        assert_eq!(
            serde_json::from_value::<ConnectionRequestHeadersQueryResult>(
                json!({"kind": "found", "names": ["X-Title"]})
            )
            .expect("decode"),
            ConnectionRequestHeadersQueryResult::Found { names: vec!["X-Title".into()] }
        );
        for (value, expected) in [
            (
                json!({"kind": "committed", "names": ["X-Title"]}),
                ConnectionRequestHeadersReplaceResult::Committed { names: vec!["X-Title".into()] },
            ),
            (
                json!({"kind": "unchanged", "names": []}),
                ConnectionRequestHeadersReplaceResult::Unchanged { names: vec![] },
            ),
            (
                json!({"kind": "connection_not_found"}),
                ConnectionRequestHeadersReplaceResult::ConnectionNotFound,
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<ConnectionRequestHeadersReplaceResult>(value)
                    .expect("decode"),
                expected
            );
        }
    }
}
