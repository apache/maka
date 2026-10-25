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

use crate::{InvalidDocument, SkillDocument};
use crate::{SkillScope, SkillSource};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

mod location;
pub use location::LocationId;
pub(crate) mod source;
mod sources;
pub use sources::safe_source_id;

#[derive(Clone)]
pub struct Source {
    pub root: PathBuf,
    pub access: maka_capabilities::filesystem::ReadDirectory,
    pub directory: PathBuf,
    pub scope: SkillScope,
    pub source: SkillSource,
    pub reference_prefix: String,
}

impl Source {
    fn location(&self, id: String, precedence: usize) -> SkillLocation {
        SkillLocation {
            reference: format!("{}:{id}", self.reference_prefix),
            path: self.root.join(&self.directory).join(&id),
            discovery_root: self.root.clone(),
            id,
            scope: self.scope.clone(),
            source: self.source.clone(),
            precedence,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SkillLocation {
    pub reference: String,
    pub id: String,
    pub path: PathBuf,
    pub discovery_root: PathBuf,
    pub scope: SkillScope,
    pub source: SkillSource,
    pub precedence: usize,
}

#[derive(Debug, Clone)]
pub struct DiscoveredSkill {
    pub location: SkillLocation,
    pub document: SkillDocument,
    pub content_sha256: String,
    pub shadowed_by: Option<String>,
    pub resources: crate::Resources,
}

#[derive(Debug, Clone)]
pub struct RejectedSkill {
    pub location: SkillLocation,
    pub document: InvalidDocument,
    pub content_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryFailure {
    BlockedPath,
    ReadFailed,
}

#[derive(Debug, Clone)]
pub struct DiscoveryDiagnostic {
    pub path: PathBuf,
    pub scope: SkillScope,
    pub source: SkillSource,
    pub precedence: usize,
    pub reason: DiscoveryFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanError {
    Cancelled,
    Unavailable,
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Cancelled => "skill discovery cancelled",
            Self::Unavailable => "skill discovery worker is unavailable",
        })
    }
}
impl std::error::Error for ScanError {}

#[derive(Debug, Default)]
pub struct DiscoverySnapshot {
    pub inventory: Vec<DiscoveredSkill>,
    pub rejected: Vec<RejectedSkill>,
    pub diagnostics: Vec<DiscoveryDiagnostic>,
}

/// Owned blocking I/O; callers must join it before releasing execution ownership.
/// Preferences and capability gating are applied later, against this same snapshot.
pub async fn scan(
    sources: &[Source],
    cancellation: &CancellationToken,
) -> Result<DiscoverySnapshot, ScanError> {
    scan_impl(sources, cancellation, false).await
}

/// Include the immutable assets from this build after the selected filesystem sources.
/// Their paths are logical resource names; no filesystem capability is created.
pub async fn scan_with_bundled(
    sources: &[Source],
    cancellation: &CancellationToken,
) -> Result<DiscoverySnapshot, ScanError> {
    scan_impl(sources, cancellation, true).await
}

/// Prepare immutable build assets during service activation, before requests
/// need their catalog. No user files or filesystem capabilities are retained.
pub fn prepare_bundled() -> Result<(), ScanError> {
    sources::bundled()
        .map(|_| ())
        .map_err(|_| ScanError::Unavailable)
}

async fn scan_impl(
    sources: &[Source],
    cancellation: &CancellationToken,
    bundled: bool,
) -> Result<DiscoverySnapshot, ScanError> {
    let mut state = Scan {
        snapshot: DiscoverySnapshot::default(),
    };
    for (precedence, source) in sources.iter().enumerate() {
        check_cancelled(cancellation)?;
        let source = source.clone();
        let access = source.access.clone();
        let cancellation = cancellation.clone();
        state = access
            .with_reader(move |reader| {
                state.source(&source, &reader, precedence, &cancellation)?;
                Ok::<_, ScanError>(state)
            })
            .await
            .map_err(|error| match error {
                maka_capabilities::filesystem::ReadError::Retired => ScanError::Cancelled,
                _ => ScanError::Unavailable,
            })??;
    }
    check_cancelled(cancellation)?;
    if bundled {
        for source in sources::bundled().map_err(|_| ScanError::Unavailable)? {
            check_cancelled(cancellation)?;
            let root = PathBuf::from("bundled");
            state.snapshot.inventory.push(DiscoveredSkill {
                location: SkillLocation {
                    reference: format!("bundled:{}", source.id),
                    id: source.id.into(),
                    path: root.join(source.id),
                    discovery_root: root,
                    scope: SkillScope::Custom,
                    source: SkillSource::Maka,
                    precedence: sources.len(),
                },
                document: source.document,
                content_sha256: source.content_sha256,
                shadowed_by: None,
                resources: source.resources.capture(),
            });
        }
    }
    state.snapshot.resolve_precedence();
    Ok(state.snapshot)
}

struct Scan {
    snapshot: DiscoverySnapshot,
}
impl Scan {
    fn source(
        &mut self,
        source: &Source,
        reader: &maka_capabilities::filesystem::Reader<'_>,
        precedence: usize,
        cancellation: &CancellationToken,
    ) -> Result<(), ScanError> {
        let Self { snapshot } = self;
        let mut captured = match source::Captured::open(source, reader) {
            Ok(captured) => captured,
            Err(reason) => {
                snapshot.diagnostic(
                    source,
                    precedence,
                    source.root.join(&source.directory),
                    reason,
                );
                return Ok(());
            }
        };
        let entries = match captured.entries(cancellation) {
            Ok(entries) => entries,
            Err(source::EntriesError::Scan(error)) => return Err(error),
            Err(source::EntriesError::Read(reason)) => {
                snapshot.diagnostic(
                    source,
                    precedence,
                    source.root.join(&source.directory),
                    reason,
                );
                return Ok(());
            }
        };
        for name in entries {
            check_cancelled(cancellation)?;
            let path = source.root.join(&source.directory).join(&name);
            let Some(id) = name.to_str() else {
                snapshot.diagnostic(source, precedence, path, DiscoveryFailure::BlockedPath);
                continue;
            };
            let bytes = match captured.read_skill(&name, cancellation) {
                Ok(Some(read)) => read,
                Ok(None) => continue,
                Err(source::ReadError::Cancelled) => return Err(ScanError::Cancelled),
                Err(source::ReadError::Failure(reason)) => {
                    snapshot.diagnostic(source, precedence, path, reason);
                    continue;
                }
            };
            let location = source.location(id.into(), precedence);
            match crate::parse(&String::from_utf8_lossy(&bytes)) {
                Ok(document) => snapshot.inventory.push(DiscoveredSkill {
                    location,
                    document,
                    content_sha256: maka_agent_facts::artifact::content_digest(&bytes),
                    shadowed_by: None,
                    resources: crate::Resources::capture(
                        reader,
                        &source.directory.join(&name),
                        cancellation,
                    )?,
                }),
                Err(document) => snapshot.rejected.push(RejectedSkill {
                    location,
                    document: *document,
                    content_sha256: maka_agent_facts::artifact::content_digest(&bytes),
                }),
            }
        }

        Ok(())
    }
}

impl DiscoverySnapshot {
    fn diagnostic(
        &mut self,
        source: &Source,
        precedence: usize,
        path: PathBuf,
        reason: DiscoveryFailure,
    ) {
        self.diagnostics.push(DiscoveryDiagnostic {
            path,
            scope: source.scope.clone(),
            source: source.source.clone(),
            precedence,
            reason,
        });
    }
}

pub(crate) fn check_cancelled(token: &CancellationToken) -> Result<(), ScanError> {
    if token.is_cancelled() {
        Err(ScanError::Cancelled)
    } else {
        Ok(())
    }
}
