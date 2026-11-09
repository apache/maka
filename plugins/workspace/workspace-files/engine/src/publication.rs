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

//! Conditional single-item publication through the existing selected workspace.
//! The coordinator orders cooperating writers; this is not a kernel content CAS
//! against external processes and does not promise a multi-file transaction.
use crate::{failed, scoped::Authority, write::WriteCoordinator, write_target::Target};
use maka_agent_facts::{
    durable::{ContentRef, ExternalPublicationId},
    tools::ToolError,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishChange {
    pub publication: ExternalPublicationId,
    pub index: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceIdentity {
    pub device: u64,
    pub inode: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationChange {
    pub path: PathBuf,
    pub expected: PublicationEntry,
    pub candidate: PublicationEntry,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PublicationEntry {
    Missing,
    File { content: ContentRef, mode: u32 },
    Directory { mode: u32 },
    Symlink { target: PathBuf },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PublicationResult {
    Applied,
    Conflict { reason: PublicationConflict },
    Unsupported { reason: PublicationUnsupported },
    NotAttempted { reason: PublicationNotAttempted },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicationConflict {
    WorkspaceIdentity,
    EntryType,
    Mode,
    Content,
    EntryVisibility,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicationUnsupported {
    StructuralChange,
    UncapturedWorkspace,
    ModePlatform,
    AliasedTarget,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicationNotAttempted {
    Cancelled,
}

use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek},
    path::Component,
    sync::atomic::AtomicBool,
};
use tokio_util::sync::CancellationToken;

pub(crate) const BUFFER_BYTES: usize = 64 * 1024;

/// The native boundary supplies an already owned immutable fixed-slot resource.
/// Seeking reopens no path and creates no authority or external effect.
pub trait PublicationContent: Read + Seek + Send {}
impl<T: Read + Seek + Send> PublicationContent for T {}

pub(crate) enum SourceCheck {
    Matched,
    Changed,
    Uncaptured,
}
pub(crate) enum Capture {
    Ready(Target),
    Refused(PublicationResult),
}

pub(crate) fn run(
    authority: &Authority,
    coordinator: &WriteCoordinator,
    change: PublicationChange,
    source: SourceIdentity,
    mut content: Option<Box<dyn PublicationContent>>,
    cancellation: &CancellationToken,
    started: &AtomicBool,
) -> Result<PublicationResult, ToolError> {
    if cancellation.is_cancelled() {
        return Ok(cancelled());
    }
    if change.path.as_os_str().is_empty()
        || change
            .path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(failed("publication requires a normalized relative path"));
    }
    for entry in [&change.expected, &change.candidate] {
        match entry {
            PublicationEntry::File { content, mode } => {
                content.validate().map_err(failed)?;
                if mode & !0o777 != 0 {
                    return Err(failed(
                        "publication file mode is outside the captured permission bits",
                    ));
                }
            }
            PublicationEntry::Missing => {}
            _ => return Ok(unsupported(PublicationUnsupported::StructuralChange)),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (authority, coordinator, source, content, started);
        return Ok(unsupported(PublicationUnsupported::ModePlatform));
    }
    #[cfg(unix)]
    {
        match (&change.candidate, content.as_mut()) {
            (
                PublicationEntry::File {
                    content: expected, ..
                },
                Some(reader),
            ) => {
                let actual = match hash_reader(reader.as_mut(), cancellation) {
                    Ok(reference) => reference,
                    Err(_) if cancellation.is_cancelled() => return Ok(cancelled()),
                    Err(error) => return Err(error),
                };
                if actual != *expected {
                    return Err(failed(
                        "immutable publication resource differs from the original manifest",
                    ));
                }
                reader.rewind().map_err(io_error)?;
            }
            (PublicationEntry::File { .. }, None) => {
                return Err(failed(
                    "publication write requires the original content resource",
                ));
            }
            (PublicationEntry::Missing, None) => {}
            (_, Some(_)) => {
                return Err(failed(
                    "publication deletion does not accept a content resource",
                ));
            }
            _ => unreachable!("structural changes refused above"),
        }
        let _guard = coordinator
            .mutation
            .lock()
            .map_err(|_| failed("Write coordinator poisoned"))?;
        if cancellation.is_cancelled() {
            return Ok(cancelled());
        }
        match authority.publication_source(&source)? {
            SourceCheck::Matched => {}
            SourceCheck::Changed => return Ok(conflict(PublicationConflict::WorkspaceIdentity)),
            SourceCheck::Uncaptured => {
                return Ok(unsupported(PublicationUnsupported::UncapturedWorkspace));
            }
        }
        let mode_only = matches!((&change.expected, &change.candidate),
            (PublicationEntry::File { content: before, .. }, PublicationEntry::File { content: after, .. }) if before == after);
        let mut target = match Target::capture_publication(
            authority,
            &change.path,
            &change.expected,
            mode_only,
        )? {
            Capture::Ready(target) => target,
            Capture::Refused(result) => return Ok(result),
        };
        match target.publication_condition(&change.expected, cancellation) {
            Ok(Some(reason)) => return Ok(conflict(reason)),
            Ok(None) => {}
            Err(_) if cancellation.is_cancelled() => return Ok(cancelled()),
            Err(error) => return Err(error),
        }
        if cancellation.is_cancelled() {
            return Ok(cancelled());
        }
        let mutation = match (change.candidate, content) {
            (
                PublicationEntry::File {
                    content: expected,
                    mode,
                },
                Some(mut reader),
            ) => {
                if mode_only {
                    target.apply_publication_mode(mode, cancellation, started)
                } else {
                    target.apply_publication(
                        reader.as_mut(),
                        &expected,
                        mode,
                        cancellation,
                        started,
                    )
                }
            }
            (PublicationEntry::Missing, None) => {
                if matches!(change.expected, PublicationEntry::Missing) {
                    return Ok(PublicationResult::Applied);
                }
                target.delete(cancellation, started)
            }
            _ => unreachable!("candidate resource shape checked before admission"),
        };
        if let Err(error) = mutation {
            if !started.load(std::sync::atomic::Ordering::SeqCst) {
                if cancellation.is_cancelled() {
                    return Ok(cancelled());
                }
            }
            return Err(error);
        }
        match authority.publication_source(&source) {
            Ok(SourceCheck::Matched) => Ok(PublicationResult::Applied),
            _ => Err(ToolError::OutcomeUnknown("publication wrote through its original FD but selected workspace visibility changed".into())),
        }
    }
}

pub(crate) fn hash_reader(
    reader: &mut (impl Read + ?Sized),
    cancellation: &CancellationToken,
) -> Result<ContentRef, ToolError> {
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0; BUFFER_BYTES];
    loop {
        if cancellation.is_cancelled() {
            return Err(failed("publication cancelled before mutation"));
        }
        let n = match reader.read(&mut buffer) {
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error(error)),
        };
        if n == 0 {
            break;
        }
        bytes = bytes
            .checked_add(n as u64)
            .ok_or_else(|| failed("publication input length overflow"))?;
        digest.update(&buffer[..n]);
    }
    Ok(ContentRef {
        digest: finish_digest(digest),
        bytes,
    })
}
pub(crate) fn conflict(reason: PublicationConflict) -> PublicationResult {
    PublicationResult::Conflict { reason }
}
pub(crate) fn unsupported(reason: PublicationUnsupported) -> PublicationResult {
    PublicationResult::Unsupported { reason }
}
fn cancelled() -> PublicationResult {
    PublicationResult::NotAttempted {
        reason: PublicationNotAttempted::Cancelled,
    }
}
fn io_error(error: std::io::Error) -> ToolError {
    ToolError::Io {
        kind: error.kind(),
        message: error.to_string(),
    }
}

pub(crate) fn finish_digest(digest: Sha256) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(7 + 64);
    encoded.push_str("sha256:");
    for byte in digest.finalize() {
        write!(encoded, "{byte:02x}").expect("formatting into a String is infallible");
    }
    encoded
}
