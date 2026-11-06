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

//! One explicitly selected physical source, bound to the original Call.
use super::*;
use maka_capabilities::filesystem::OpenFile;
use maka_capabilities::filesystem::ReadDirectory;
use maka_capabilities::filesystem::ReadError;
use maka_capabilities::filesystem::ReadRoot;
use maka_capabilities::filesystem::Symlinks;
use maka_capabilities::filesystem::database;
use std::path::Path;

pub(super) struct SourceRead {
    pub source: ImportSource,
    pub adapter: maka_session_import::source::Source,
    files: ReadDirectory,
    scope: Scope,
    stopping: CancellationToken,
}
impl SourceRead {
    pub async fn open(owner: &Owner, source: ImportSource, scope: &Scope) -> Result<Self, Failure> {
        let private = owner
            .store
            .owned_root()
            .map_err(|_| Failure::Unavailable)?
            .canonical_path()
            .to_owned();
        let selected = workspace::observed(
            owner.import_roots.clone(),
            source.location.path(),
            owner.home.as_deref(),
            private.clone(),
        )
        .await
        .map_err(|_| Failure::Unavailable)?
        .ok_or(Failure::Unavailable)?;
        if selected.path != source.path {
            return Err(Failure::Changed);
        }
        let identity = selected.identity;
        let path = std::path::PathBuf::from(&source.path);
        let read_path = path.clone();
        let root = tokio::task::spawn_blocking(move || {
            use maka_sandbox::filesystem::{Access, Policy, Rule};
            let policy = Policy {
                default: Access::Read,
                rules: vec![Rule::subtree(&private, Access::Deny)],
                deny_globs: vec![],
            }
            .compile()
            .map_err(|_| Failure::Unavailable)?;
            let dir = maka_fs_tools::directory::open(&read_path, &identity)
                .map_err(|_| Failure::Unavailable)?;
            ReadRoot::from_handle(dir, read_path)
                .restrict(Arc::new(policy))
                .map_err(|_| Failure::Unavailable)
        })
        .await
        .map_err(|_| Failure::Unavailable)??;
        use maka_session_import::source::Location;
        let location = match &source.location {
            ImportLocation::Codex { .. } => Location::Codex {
                root: source.path.clone(),
            },
            ImportLocation::ClaudeCode { .. } => Location::ClaudeCode {
                root: source.path.clone(),
            },
            ImportLocation::OpenCode { database, .. } => {
                if !filename(database) {
                    return Err(Failure::Invalid);
                }
                Location::OpenCode {
                    database: path.join(database).to_str().ok_or(Failure::Invalid)?.into(),
                }
            }
        };
        Ok(Self {
            adapter: maka_session_import::source::Source {
                id: source.id,
                name: source.name.clone(),
                location,
            },
            source,
            files: root.bind_scope(scope),
            scope: scope.clone(),
            stopping: owner.stop.clone(),
        })
    }
    pub async fn validate(&self, owner: &Owner) -> Result<(), Failure> {
        if self.scope.cancellation.is_cancelled() || self.stopping.is_cancelled() {
            return Err(Failure::Unavailable);
        }
        let private = owner
            .store
            .owned_root()
            .map_err(|_| Failure::Unavailable)?
            .canonical_path()
            .to_owned();
        let observed = workspace::observed(
            owner.import_roots.clone(),
            self.source.location.path(),
            owner.home.as_deref(),
            private,
        )
        .await
        .map_err(|_| Failure::Unavailable)?
        .ok_or(Failure::Unavailable)?;
        if observed.path != self.source.path {
            return Err(Failure::Changed);
        }
        Ok(())
    }
}
fn filename(name: &str) -> bool {
    !name.is_empty()
        && !name.chars().any(char::is_control)
        && !name.contains(['/', '\\'])
        && name != "."
        && name != ".."
}
impl maka_session_import::access::ReadSource for SourceRead {
    fn directory(
        &self,
        path: String,
    ) -> BoxFuture<'_, Result<ReadDirectory, maka_session_import::Error>> {
        Box::pin(async move {
            if path != self.source.path
                || self.scope.cancellation.is_cancelled()
                || self.stopping.is_cancelled()
            {
                return Err(ReadError::Retired.into());
            }
            Ok(self.files.clone())
        })
    }
    fn query_database(
        &self,
        input: database::Read,
    ) -> BoxFuture<'_, Result<Vec<database::Table>, database::Error>> {
        Box::pin(async move {
            input.validate()?;
            let relative = Path::new(&input.path)
                .strip_prefix(&self.source.path)
                .map_err(|_| database::Error::Denied)?;
            // Current formats read a database immediately inside their selected directory.
            let name = relative
                .to_str()
                .filter(|name| filename(name))
                .ok_or(database::Error::Denied)?
                .to_owned();
            match &self.source.location {
                ImportLocation::OpenCode { database, .. } if database == &name => {}
                ImportLocation::Codex { .. }
                    if name.starts_with("state_") && name.ends_with(".sqlite") => {}
                _ => return Err(database::Error::Denied),
            }
            let names = name.clone();
            self.files
                .with_reader(move |reader| {
                    reader.file_info(OpenFile {
                        path: names.clone(),
                        symlinks: Symlinks::Reject,
                    })?;
                    for suffix in ["-wal", "-shm", "-journal"] {
                        match reader.file_info(OpenFile {
                            path: format!("{names}{suffix}"),
                            symlinks: Symlinks::Reject,
                        }) {
                            Ok(_) => {}
                            Err(ReadError::Io(error))
                                if error.kind() == std::io::ErrorKind::NotFound => {}
                            Err(error) => return Err(error),
                        }
                    }
                    Ok::<_, ReadError>(())
                })
                .await
                .map_err(read_error)?
                .map_err(read_error)?;
            let path = Path::new(&self.source.path).join(&name);
            let stopping = self.stopping.clone();
            let cancelled = self.scope.cancellation.clone();
            let mut ticket = self
                .scope
                .resources
                .reserve()
                .map_err(|_| database::Error::Cancelled)?;
            let result = tokio::task::spawn_blocking(move || {
                ticket.start();
                let result = database::query::read(&path, input.queries, &cancelled, &stopping);
                ticket.complete(Ok(()));
                result
            })
            .await
            .map_err(|_| database::Error::Unavailable("source reader failed".into()))?;
            self.files
                .file_info(OpenFile {
                    path: name,
                    symlinks: Symlinks::Reject,
                })
                .await
                .map_err(read_error)?;
            result
        })
    }
}
fn read_error(error: ReadError) -> database::Error {
    match error {
        ReadError::Retired => database::Error::Cancelled,
        ReadError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            database::Error::NotFound
        }
        _ => database::Error::Denied,
    }
}
