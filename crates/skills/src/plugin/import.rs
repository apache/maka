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
use super::{Error, Skills, catalog};
use crate::{
    api::{
        ImportRejection, ImportSourceInput, ImportSourceResult, ImportedSource, ManagedSourceType,
    },
    publication::{self, Tree, UserStore},
};
use std::path::Path;
use tokio_util::sync::CancellationToken;

impl Skills {
    pub async fn import_source(
        &self,
        input: ImportSourceInput,
        source: maka_plugins::filesystem::ReadDirectory,
    ) -> Result<ImportSourceResult, Error> {
        let admitted = self.basis.owner.admit().map_err(|_| Error::Retired)?;
        let bytes = match read_source(&input.source_path, &source).await {
            Ok(bytes) => bytes,
            Err(reason) => return Ok(ImportSourceResult::Rejected { reason }),
        };
        let skills = self.clone();
        let receiver = self
            .basis
            .owner
            .spawn_resource("Skills source import", move |_| async move {
                let _admitted = admitted;
                let _serial = skills.mutations.write().await;
                let _invalidation = skills.input_revision.invalidate().await;
                let _notice = skills.notify_on_exit();
                let cancellation = skills.basis.owner.stopping().map_err(|e| e.to_string())?;
                let user = match skills.user_files(input.grant).await {
                    Ok(user) => user,
                    Err(error) => return Ok(Err(error)),
                };
                let result = async {
                    let publisher = user
                        .open(
                            UserStore::ManagedSources,
                            skills.private_publisher().await?,
                            true,
                        )
                        .await
                        .map_err(|e| Error::Source(e.to_string()))?
                        .ok_or_else(|| {
                            Error::Source("Managed Skills store is unavailable".into())
                        })?;
                    import(
                        publisher,
                        Path::new(&input.source_path),
                        bytes,
                        None,
                        &cancellation,
                    )
                    .await
                }
                .await;
                let settled = user
                    .finish()
                    .await
                    .map_err(|e| Error::Source(e.to_string()));
                *skills.user_recovery.lock().unwrap() =
                    result.as_ref().err().map(ToString::to_string);
                if let Err(error) = settled {
                    return Ok(Err(error));
                }
                Ok(result)
            })
            .map_err(|_| Error::Retired)?;
        receiver
            .await
            .map_err(|e| Error::OutcomeUnknown(e.to_string()))?
            .map_err(Error::OutcomeUnknown)?
    }
}

pub(super) async fn import(
    publisher: publication::Publisher,
    path: &Path,
    bytes: Vec<u8>,
    operation: Option<&publication::receipt::Operation>,
    cancellation: &CancellationToken,
) -> Result<ImportSourceResult, Error> {
    use ImportRejection as Rejection;
    let rejected = |reason| Ok(ImportSourceResult::Rejected { reason });
    let Some(id) = source_id(path) else {
        return rejected(Rejection::InvalidSkill);
    };
    let Ok(content) = std::str::from_utf8(&bytes) else {
        return rejected(Rejection::InvalidSkill);
    };
    let Ok(document) = crate::parse(content) else {
        return rejected(Rejection::InvalidSkill);
    };
    let source = ImportedSource {
        id: id.clone(),
        name: catalog::bounded(&document.manifest.name, 256).0,
        description: catalog::bounded(&document.manifest.description, 4096).0,
        category: catalog::managed_category(document.manifest.attributes.category.as_deref())
            .into(),
        source_type: ManagedSourceType::Local,
    };
    let mut tree = Tree::empty();
    tree.insert("SKILL.md", bytes)
        .map_err(|e| Error::Source(e.to_string()))?;
    match publisher
        .publish_operation(
            &id,
            None,
            Some(&tree),
            operation.map(|operation| {
                (
                    operation,
                    publication::receipt::Destination::Source { id: id.clone() },
                )
            }),
            cancellation,
        )
        .await
    {
        Ok(()) => Ok(ImportSourceResult::Imported { source }),
        Err(publication::Error::Conflict) => rejected(Rejection::AlreadyExists),
        Err(publication::Error::Cancelled) => Err(Error::Retired),
        Err(publication::Error::OutcomeUnknown(message)) => Err(Error::OutcomeUnknown(message)),
        Err(e) => Err(Error::Source(e.to_string())),
    }
}
fn source_id(path: &Path) -> Option<String> {
    let stem = if path.file_name()?.to_str()?.eq_ignore_ascii_case("SKILL.md") {
        path.parent()?.file_name()?.to_str()?
    } else {
        path.file_stem()?.to_str()?
    };
    let mut id = String::new();
    for character in stem.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            id.push(character.to_ascii_lowercase());
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    let id = id.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    let id = &id[..id.len().min(80)];
    crate::safe_source_id(id).then(|| id.into())
}

pub(super) async fn read_source(
    path: &str,
    source: &maka_plugins::filesystem::ReadDirectory,
) -> Result<Vec<u8>, ImportRejection> {
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(ImportRejection::BlockedPath)?;
    match source
        .read(maka_plugins::filesystem::ReadViewInput {
            file: maka_plugins::filesystem::entries::ReadFile {
                path: name.into(),
                offset: 0,
                limit: 1024 * 1024,
            },
            symlinks: maka_plugins::filesystem::Symlinks::Reject,
        })
        .await
    {
        Ok(page) if page.next_offset.is_none() => Ok(page.bytes),
        _ => Err(ImportRejection::BlockedPath),
    }
}
