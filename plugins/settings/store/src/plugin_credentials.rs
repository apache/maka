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

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode};
use maka_capabilities::credentials::Record;
use maka_capabilities::credentials::Write;
use maka_capabilities::credentials::WriteResult;
use maka_plugin_core::storage::Namespace;
use maka_plugin_core::storage::validate_key;
use rusqlite::{Connection, OptionalExtension};

impl ConfigurationStore {
    pub async fn plugin_credential(
        &self,
        namespace: Namespace,
        key: String,
    ) -> Result<Option<Record>> {
        validate_key(&key).map_err(invalid)?;
        self.transaction(TransactionMode::Deferred, move |tx| {
            read(tx, &namespace, &key)
        })
        .await
    }
    /// Shares the private credential database and its SQL owner, never event-log
    /// history or general plugin storage. A lost response does not undo the CAS.
    pub async fn write_plugin_credential(
        &self,
        namespace: Namespace,
        input: Write,
    ) -> Result<WriteResult> {
        input.validate().map_err(invalid)?;
        self.transaction(TransactionMode::Immediate, move |tx| {
            let actual = read(tx, &namespace, &input.key)?.map(|record| record.revision);
            if actual != input.expected_revision { return Ok(WriteResult::Conflict { actual }); }
            let revision = actual.unwrap_or(0) + 1;
            tx.execute("INSERT INTO plugin_credentials (package_id, scope_id, key, revision, secret) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(package_id, scope_id, key) DO UPDATE SET revision = excluded.revision, secret = excluded.secret", rusqlite::params![namespace.package(), String::from(namespace.scope().clone()), &input.key, revision as i64, input.secret])?;
            Ok(WriteResult::Written { revision })
        }).await
    }
}
fn read(tx: &Connection, namespace: &Namespace, key: &str) -> Result<Option<Record>> {
    let row: Option<(i64, Option<String>)> = tx.prepare_cached("SELECT revision, secret FROM plugin_credentials WHERE package_id = ? AND scope_id = ? AND key = ?")?.query_row(rusqlite::params![namespace.package(), String::from(namespace.scope().clone()), key], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
    row.map(|(revision, secret)| {
        Ok(Record {
            revision: crate::database::unsigned(revision)?,
            secret,
        })
    })
    .transpose()
}
fn invalid(error: impl ToString) -> ConfigError {
    ConfigError::Invalid(error.to_string())
}
