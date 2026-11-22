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

use crate::{Error, Transcript, catalog};
use maka_capabilities::filesystem::OpenFile;
use maka_capabilities::filesystem::ReadDirectory;
use maka_capabilities::filesystem::Symlinks;
use maka_plugin_core::storage;
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Store;
use maka_plugin_core::storage::StoreError;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};
use uuid::Uuid;

const KEY: &str = "sources";

/// Paths belong to the selected Host, never to the client running the picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Location {
    Codex { root: String },
    ClaudeCode { root: String },
    OpenCode { database: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: Uuid,
    pub name: String,
    pub location: Location,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub source_id: Uuid,
    pub source_revision: u64,
    pub session_id: String,
    /// Catalog artifact, not an ambient-path capability.
    pub path: String,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub sources: Vec<Source>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: Option<u64>,
    pub configuration: Configuration,
}
impl Configuration {
    pub fn validate(&self) -> Result<(), Error> {
        let mut seen = BTreeSet::new();
        for source in &self.sources {
            if !seen.insert(source.id) {
                return Err(Error::Invalid("duplicate import source identity"));
            }
            source.validate()?;
        }
        Ok(())
    }
}
impl Source {
    pub fn validate(&self) -> Result<(), Error> {
        if self.name.trim().is_empty() || self.name.chars().any(char::is_control) {
            return Err(Error::Invalid("invalid import source name"));
        }
        let path = match &self.location {
            Location::Codex { root } | Location::ClaudeCode { root } => root,
            Location::OpenCode { database } => database,
        };
        if path.chars().any(char::is_control) || !Path::new(path).is_absolute() {
            return Err(Error::Invalid(
                "import source requires an absolute Host path",
            ));
        }
        Ok(())
    }

    pub async fn catalog(
        &self,
        views: &(impl crate::access::ReadSource + ?Sized),
        query: catalog::Query,
    ) -> Result<catalog::Page, Error> {
        self.validate()?;
        match &self.location {
            Location::Codex { root } => catalog::codex(views, root.clone(), query).await,
            Location::ClaudeCode { root } => {
                catalog::list(
                    &directory(views, root.clone()).await?,
                    catalog::Format::ClaudeCode,
                    query,
                )
                .await
            }
            Location::OpenCode { database } => {
                catalog::opencode(views, database.clone(), query).await
            }
        }
    }

    pub async fn read_exact(
        &self,
        views: &(impl crate::access::ReadSource + ?Sized),
        selection: &Selection,
        sink: &mut dyn crate::ExactSink,
    ) -> Result<crate::ExactTranscript, Error> {
        self.validate()?;
        if selection.source_id != self.id {
            return Err(Error::Invalid("selection belongs to another source"));
        }
        crate::transcript::identity(&selection.session_id)?;
        let (root, format) = match &self.location {
            Location::OpenCode { database } => {
                if &selection.path != database {
                    return Err(Error::Invalid("selected database has changed"));
                }
                return crate::opencode::read_exact(
                    views,
                    database.clone(),
                    &selection.session_id,
                    sink,
                )
                .await;
            }
            Location::Codex { root } => (root, catalog::Format::Codex),
            Location::ClaudeCode { root } => (root, catalog::Format::ClaudeCode),
        };
        let file = directory(views, root.clone())
            .await?
            .open_file(OpenFile {
                path: selection.path.clone(),
                symlinks: Symlinks::Reject,
            })
            .await?;
        let result = match format {
            catalog::Format::Codex => {
                crate::codex::read_exact(views, &file, &selection.session_id, sink).await
            }
            catalog::Format::ClaudeCode => {
                crate::claude::read_exact(views, &file, &selection.session_id, sink).await
            }
        };
        match (result, file.close().await) {
            (Err(primary), Err(cleanup)) => Err(Error::Cleanup {
                primary: Box::new(primary),
                cleanup,
            }),
            (_, Err(cleanup)) => Err(cleanup.into()),
            (result, Ok(())) => result,
        }
    }

    pub async fn read(
        &self,
        views: &(impl crate::access::ReadSource + ?Sized),
        selection: &Selection,
    ) -> Result<Transcript, Error> {
        self.validate()?;
        if selection.source_id != self.id {
            return Err(Error::Invalid("selection belongs to another source"));
        }
        crate::transcript::identity(&selection.session_id)?;
        let (root, format) = match &self.location {
            Location::OpenCode { database } => {
                if &selection.path != database {
                    return Err(Error::Invalid("selected database has changed"));
                }
                return crate::opencode::read(views, database.clone(), &selection.session_id).await;
            }
            Location::Codex { root } => (root, catalog::Format::Codex),
            Location::ClaudeCode { root } => (root, catalog::Format::ClaudeCode),
        };
        let file = directory(views, root.clone())
            .await?
            .open_file(OpenFile {
                path: selection.path.clone(),
                symlinks: Symlinks::Reject,
            })
            .await?;
        let result = match format {
            catalog::Format::Codex => crate::codex::read(&file, &selection.session_id).await,
            catalog::Format::ClaudeCode => crate::claude::read(&file, &selection.session_id).await,
        };
        file.close().await?;
        result
    }
}

async fn directory(
    views: &(impl crate::access::ReadSource + ?Sized),
    path: String,
) -> Result<ReadDirectory, Error> {
    views.directory(path).await
}

pub async fn read(store: &dyn Store) -> Result<Snapshot, Error> {
    let record = store.read(KEY.into()).await?;
    let revision = record.as_ref().map(|record| record.revision);
    let configuration = record
        .and_then(|record| record.data.value().cloned())
        .map(serde_json::from_value::<Configuration>)
        .transpose()
        .map_err(invalid)?
        .unwrap_or_default();
    configuration.validate()?;
    Ok(Snapshot {
        revision,
        configuration,
    })
}

pub async fn save(
    store: &dyn Store,
    expected_revision: Option<u64>,
    configuration: Configuration,
) -> Result<Snapshot, Error> {
    configuration.validate()?;
    let record = store
        .batch(vec![Mutation {
            key: KEY.into(),
            expected_revision,
            data: Data::Present(serde_json::to_value(&configuration).map_err(invalid)?),
        }])
        .await?
        .pop()
        .ok_or_else(|| invalid("missing source configuration receipt"))?;
    Ok(Snapshot {
        revision: Some(record.revision),
        configuration,
    })
}

fn invalid(error: impl std::fmt::Display) -> storage::StoreError {
    StoreError::Unavailable(error.to_string())
}
