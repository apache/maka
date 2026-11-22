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

//! Last successful public model catalogs. Payload validation and refresh lifetime
//! belong to the caller; this store owns their durable, atomic publication.

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode, catalog};
pub use maka_agent_facts::public_catalog::PublicCatalogBody;
use rusqlite::OptionalExtension;
use std::collections::BTreeMap;

type CachedCatalogRow = (String, String, Option<String>, Option<String>, i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PublicCatalogSource {
    ModelsDev,
    OpenRouter,
}

impl PublicCatalogSource {
    fn key(self) -> &'static str {
        match self {
            Self::ModelsDev => "models_dev",
            Self::OpenRouter => "openrouter",
        }
    }

    fn from_key(key: &str) -> Result<Self> {
        match key {
            "models_dev" => Ok(Self::ModelsDev),
            "openrouter" => Ok(Self::OpenRouter),
            _ => Err(ConfigError::Invalid("invalid public catalog source".into())),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PublicCatalogRecord {
    pub body: PublicCatalogBody,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    /// Successful fetch or conditional revalidation time, in Unix milliseconds.
    pub checked_at: i64,
}

impl PublicCatalogRecord {
    /// Compare the complete durable record during uncertain-write reconciliation.
    pub fn same_content(&self, other: &Self) -> std::result::Result<bool, serde_json::Error> {
        Ok(self.body.same_content(&other.body)?
            && self.etag == other.etag
            && self.last_modified == other.last_modified
            && self.checked_at == other.checked_at)
    }
}

#[derive(Debug, Clone)]
pub struct PublicCatalogSnapshot {
    pub catalog_revision: u64,
    pub sources: BTreeMap<PublicCatalogSource, PublicCatalogRecord>,
}

impl ConfigurationStore {
    pub async fn public_catalog(&self) -> Result<PublicCatalogSnapshot> {
        self.transaction(TransactionMode::Deferred, |tx| {
            let revision: i64 = tx
                .prepare_cached("SELECT revision FROM connection_catalog WHERE singleton = 1")?
                .query_row(rusqlite::params![], |row| row.get(0))?;
            let rows: Vec<CachedCatalogRow> = tx
                .prepare_cached(
                    "SELECT source, body, etag, last_modified, checked_at FROM public_catalog",
                )?
                .query_map(rusqlite::params![], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut sources = BTreeMap::new();
            for (source, body, etag, last_modified, checked_at) in rows {
                sources.insert(
                    PublicCatalogSource::from_key(&source)?,
                    PublicCatalogRecord {
                        body: PublicCatalogBody::from_json(body)?,
                        etag,
                        last_modified,
                        checked_at,
                    },
                );
            }
            Ok(PublicCatalogSnapshot {
                catalog_revision: crate::database::unsigned(revision)?,
                sources,
            })
        })
        .await
    }

    /// Publish an already validated payload. A 304 response can retain the
    /// original body and update its HTTP metadata without invalidating cursors.
    pub async fn put_public_catalog(
        &self,
        source: PublicCatalogSource,
        record: PublicCatalogRecord,
    ) -> Result<u64> {
        self.transaction(TransactionMode::Immediate, move |tx| {
            let previous: Option<String> = tx
                .prepare_cached("SELECT body FROM public_catalog WHERE source = ?")?
                .query_row(rusqlite::params![source.key()], |row| row.get(0))
                .optional()?;
            let previous = previous.map(PublicCatalogBody::from_json).transpose()?;
            let changed = match previous {
                Some(previous) => !previous.same_content(&record.body)?,
                None => true,
            };
            tx.execute(
                "INSERT INTO public_catalog(source, body, etag, last_modified, checked_at)
                     VALUES(?, ?, ?, ?, ?)
                     ON CONFLICT(source) DO UPDATE SET body = excluded.body,
                     etag = excluded.etag, last_modified = excluded.last_modified,
                     checked_at = excluded.checked_at",
                rusqlite::params![
                    source.key(),
                    record.body.as_raw().get(),
                    record.etag,
                    record.last_modified,
                    record.checked_at
                ],
            )?;
            let current = catalog::read(tx)?;
            if changed {
                catalog::advance(tx, current.revision, current.default_target.as_ref())
            } else {
                Ok(current.revision)
            }
        })
        .await
    }
}
