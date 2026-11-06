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

use maka_agent_facts::configuration::*;
use rusqlite::{Connection, OptionalExtension};
mod headers;
mod write;
pub(crate) use write::{replace_secret, write_secret};

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode, catalog};

impl ConfigurationStore {
    pub async fn credential_status(
        &self,
        locator: CredentialLocator,
    ) -> Result<CredentialVaultQueryResult> {
        validation::locator(&locator).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Deferred, move |tx| {
            if let CredentialLocator::Connection { connection_id, .. } = &locator
                && catalog::find(tx, connection_id)?.is_none()
            {
                return Ok(CredentialVaultQueryResult::ConnectionNotFound);
            }
            Ok(CredentialVaultQueryResult::Status {
                status: status(tx, &locator)?,
            })
        })
        .await
    }

    pub async fn set_credential(
        &self,
        mut input: SetCredentialInput,
        now: u64,
    ) -> Result<SetCredentialResult> {
        validation::normalize_set_credential(&mut input).map_err(ConfigError::Invalid)?;
        validation::revision(now, false).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Immediate, move |tx| {
            if let Some(conflict) =
                connection_conflict(tx, &input.locator, input.expected_connection.as_ref())?
            {
                return Ok(conflict);
            }
            let previous = status(tx, &input.locator)?;
            let actual = status_basis(&previous);
            let expected = input.expected.as_ref().map(|basis| CredentialVersionBasis {
                locator: input.locator.clone(),
                credential_id: basis.credential_id.clone(),
                revision: basis.revision,
            });
            if expected != actual {
                return Ok(CredentialMutationResult::CredentialStale { expected, actual });
            }
            write_secret(tx, &input.locator, &input.secret, now)?;
            invalidate_test(tx, &input.locator)?;
            Ok(CredentialMutationResult::Committed {
                vault_revision: advance(tx)?,
                status: status(tx, &input.locator)?,
            })
        })
        .await
    }

    pub async fn delete_credential(
        &self,
        input: DeleteCredentialInput,
    ) -> Result<DeleteCredentialResult> {
        validation::delete_credential(&input).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Immediate, move |tx| {
            if let Some(conflict) = connection_conflict(
                tx,
                &input.expected.locator,
                input.expected_connection.as_ref(),
            )? {
                return Ok(conflict);
            }
            let previous = status(tx, &input.expected.locator)?;
            let actual = status_basis(&previous);
            if actual.as_ref() != Some(&input.expected) {
                return Ok(CredentialMutationResult::CredentialStale {
                    expected: Some(input.expected),
                    actual,
                });
            }
            tx.execute(
                "DELETE FROM credentials WHERE locator = ?",
                rusqlite::params![serde_json::to_string(&input.expected.locator)?],
            )?;
            invalidate_test(tx, &input.expected.locator)?;
            Ok(CredentialMutationResult::Committed {
                vault_revision: advance(tx)?,
                status: status(tx, &input.expected.locator)?,
            })
        })
        .await
    }

    /// Trusted execution/export access only. Public status/catalog projections
    /// never call this or receive secret material.
    pub async fn credential_secret(
        &self,
        locator: &CredentialLocator,
        expected: Option<&ConnectionCredentialTarget>,
    ) -> Result<Option<String>> {
        let locator = locator.clone();
        let expected = expected.cloned();
        self.transaction(TransactionMode::Deferred, move |tx| {
            if connection_conflict(tx, &locator, expected.as_ref())?.is_some() {
                return Err(ConfigError::Invalid(
                    "credential connection basis changed".into(),
                ));
            }
            tx.prepare_cached("SELECT secret FROM credentials WHERE locator = ?")?
                .query_row(rusqlite::params![serde_json::to_string(&locator)?], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(Into::into)
        })
        .await
    }
}

pub(crate) fn connection_conflict(
    tx: &Connection,
    locator: &CredentialLocator,
    expected: Option<&ConnectionCredentialTarget>,
) -> Result<Option<CredentialMutationResult>> {
    let CredentialLocator::Connection { connection_id, .. } = locator else {
        return Ok(None);
    };
    let Some(row) = catalog::find(tx, connection_id)? else {
        return Ok(Some(CredentialMutationResult::ConnectionNotFound));
    };
    if let Some(expected) = expected
        && (expected.connection_id != row.connection_id
            || expected.revision != row.revision
            || expected.slug != row.slug
            || expected.provider != row.provider
            || expected.configuration != row.configuration)
    {
        return Ok(Some(CredentialMutationResult::ConnectionStale {
            expected: ConnectionVersionBasis {
                connection_id: expected.connection_id.clone(),
                revision: expected.revision,
            },
            actual: Some(catalog::basis(&row)),
        }));
    }
    Ok(None)
}

pub(crate) fn status(tx: &Connection, locator: &CredentialLocator) -> Result<CredentialStatus> {
    let saved: Option<(String, i64, i64)> = tx
        .prepare_cached(
            "SELECT credential_id, revision, updated_at FROM credentials WHERE locator = ?",
        )?
        .query_row(rusqlite::params![serde_json::to_string(locator)?], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    Ok(CredentialStatus {
        locator: locator.clone(),
        state: match saved {
            Some((credential_id, revision, updated_at)) => CredentialState::Configured {
                credential_id,
                revision: crate::database::unsigned(revision)?,
                updated_at: crate::database::unsigned(updated_at)?,
            },
            None => CredentialState::Absent,
        },
    })
}

pub(crate) fn status_basis(status: &CredentialStatus) -> Option<CredentialVersionBasis> {
    status.basis()
}

pub(crate) fn advance(tx: &Connection) -> Result<u64> {
    let previous: i64 = tx
        .prepare_cached("SELECT revision FROM credential_vault WHERE singleton = 1")?
        .query_row(rusqlite::params![], |row| row.get(0))?;
    let next = catalog::next_revision(crate::database::unsigned(previous)?)?;
    tx.execute(
        "UPDATE credential_vault SET revision = ? WHERE singleton = 1",
        rusqlite::params![next as i64],
    )?;
    Ok(next)
}

fn invalidate_test(tx: &Connection, locator: &CredentialLocator) -> Result<()> {
    if matches!(locator, CredentialLocator::NetworkProxy { .. }) {
        return crate::network::invalidate_tests(tx);
    }
    if let CredentialLocator::Connection { connection_id, .. } = locator
        && let Some(mut row) = catalog::find(tx, connection_id)?
        && row.last_test.is_some()
    {
        row.last_test = None;
        row.revision = catalog::next_revision(row.revision)?;
        catalog::write_entry(tx, &row)?;
        let current = catalog::read(tx)?;
        catalog::advance(tx, current.revision, current.default_target.as_ref())?;
    }
    Ok(())
}
