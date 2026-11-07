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

use super::{advance, invalidate_test, status, status_basis, write_secret};
use crate::{ConfigError, ConfigurationStore, Result, TransactionMode, catalog};
use maka_agent_facts::configuration::headers::*;
use maka_agent_facts::configuration::*;
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeMap;

fn locator(id: String) -> CredentialLocator {
    CredentialLocator::Connection {
        connection_id: id,
        kind: ConnectionCredentialKind::RequestHeaders,
    }
}

fn read(tx: &Connection, locator: &CredentialLocator) -> Result<Option<String>> {
    tx.prepare_cached("SELECT secret FROM credentials WHERE locator = ?")?
        .query_row(rusqlite::params![serde_json::to_string(locator)?], |row| {
            row.get(0)
        })
        .optional()
        .map_err(Into::into)
}

fn parse(secret: Option<&str>) -> Result<BTreeMap<String, String>> {
    validation::parse_headers(secret.unwrap_or("{}")).map_err(ConfigError::Invalid)
}

impl ConfigurationStore {
    pub async fn request_headers(&self, id: String) -> Result<RequestHeadersQueryResult> {
        validation::entity_id(&id).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Deferred, move |tx| {
            let Some(connection) = catalog::find(tx, &id)? else {
                return Ok(RequestHeadersQueryResult::ConnectionNotFound);
            };
            let locator = locator(id);
            let secret = read(tx, &locator)?;
            Ok(RequestHeadersQueryResult::Found {
                names: parse(secret.as_deref())?.into_keys().collect(),
                basis: RequestHeadersBasis {
                    connection: catalog::basis(&connection),
                    credential: status_basis(&status(tx, &locator)?),
                },
            })
        })
        .await
    }

    /// Complete replacement under the vault's existing transaction owner.
    /// The name snapshot's connection and credential bases must still match.
    /// Missing values retain that known name's value; omitted names are deleted.
    pub async fn replace_request_headers(
        &self,
        mut input: RequestHeadersReplace,
        now: u64,
    ) -> Result<RequestHeadersReplaceResult> {
        input.normalize().map_err(ConfigError::Invalid)?;
        validation::revision(now, false).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Immediate, move |tx| {
            {
                let id = &input.expected.connection.connection_id;
                let Some(connection) = catalog::find(tx, id)? else {
                    return Ok(RequestHeadersReplaceResult::ConnectionNotFound);
                };
                let actual_connection = catalog::basis(&connection);
                if actual_connection != input.expected.connection {
                    return Ok(RequestHeadersReplaceResult::ConnectionStale {
                        expected: input.expected.connection,
                        actual: actual_connection,
                    });
                }
                let locator = locator(id.clone());
                let actual_credential = status_basis(&status(tx, &locator)?);
                if actual_credential != input.expected.credential {
                    return Ok(RequestHeadersReplaceResult::CredentialStale {
                        expected: input.expected.credential,
                        actual: actual_credential,
                    });
                }
                let previous = read(tx, &locator)?;
                let saved = parse(previous.as_deref())?;
                let by_name: BTreeMap<_, _> = saved
                    .iter()
                    .map(|(name, value)| (name.to_ascii_lowercase(), value))
                    .collect();
                let mut headers = BTreeMap::new();
                for update in input.headers {
                    let value =
                        match update.value {
                            Some(value) => value,
                            None => (*by_name.get(&update.name.to_ascii_lowercase()).ok_or_else(
                                || {
                                    ConfigError::Invalid(
                                        "new request header requires a value".into(),
                                    )
                                },
                            )?)
                            .clone(),
                        };
                    headers.insert(update.name, value);
                }
                // Retained values participate in the aggregate bound too.
                let secret = validation::normalize_headers(&serde_json::to_string(&headers)?)
                    .map_err(ConfigError::Invalid)?;
                let names = headers.keys().cloned().collect();
                if saved == headers && !(headers.is_empty() && previous.is_some()) {
                    return Ok(RequestHeadersReplaceResult::Unchanged {
                        names,
                        basis: input.expected,
                    });
                }
                if headers.is_empty() {
                    tx.execute(
                        "DELETE FROM credentials WHERE locator = ?",
                        rusqlite::params![serde_json::to_string(&locator)?],
                    )?;
                } else {
                    write_secret(tx, &locator, &secret, now)?;
                }
                invalidate_test(tx, &locator)?;
                advance(tx)?;
                let connection = catalog::find(tx, id)?
                    .ok_or_else(|| ConfigError::Invalid("connection disappeared".into()))?;
                Ok(RequestHeadersReplaceResult::Committed {
                    names,
                    basis: RequestHeadersBasis {
                        connection: catalog::basis(&connection),
                        credential: status_basis(&status(tx, &locator)?),
                    },
                })
            }
        })
        .await
    }
}
