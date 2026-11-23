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

//! Skill-local text captured while discovery's read capabilities are alive.
use crate::{DiscoveryFailure, ScanError};
use maka_agent_facts::read::ReadInput;
use maka_agent_facts::read::ReadPage;
use maka_capabilities::filesystem::Reader;
use maka_capabilities::filesystem::Symlinks;
use maka_capabilities::filesystem::entries::Kind;
use std::{
    collections::BTreeMap,
    path::{Component, Path},
    sync::{Arc, OnceLock},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
enum Resource {
    Text { content: Arc<str>, hash: String },
    Embedded(&'static EmbeddedText),
    Unavailable(DiscoveryFailure),
}

#[derive(Debug, Clone, Default)]
pub struct Resources {
    files: BTreeMap<String, Resource>,
    incomplete: bool,
}

/// Discovery needs only the original content hash. Pages share the text once read.
#[derive(Debug)]
pub(crate) struct EmbeddedText {
    frame: &'static [u8],
    pub(crate) hash: &'static str,
    decoded: OnceLock<String>,
}

impl EmbeddedText {
    pub(crate) const fn new(frame: &'static [u8], hash: &'static str) -> Self {
        Self {
            frame,
            hash,
            decoded: OnceLock::new(),
        }
    }

    pub(crate) fn content(&self) -> &str {
        self.decoded.get_or_init(|| {
            String::from_utf8(zstd::decode_all(self.frame).expect("bundled skill frame"))
                .expect("bundled UTF-8 skill resource")
        })
    }
}

impl Resources {
    pub(crate) fn embedded(
        files: &[(&str, Option<&'static EmbeddedText>)],
    ) -> Result<Self, ScanError> {
        let mut result = Self::default();
        for (path, text) in files {
            if !valid_path(path) {
                return Err(ScanError::Unavailable);
            }
            let resource = match text {
                Some(text) => Resource::Embedded(text),
                None => Resource::Unavailable(DiscoveryFailure::ReadFailed),
            };
            if result.files.insert((*path).into(), resource).is_some() {
                return Err(ScanError::Unavailable);
            }
        }
        Ok(result)
    }
    pub(crate) fn capture(
        reader: &Reader<'_>,
        directory: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Self, ScanError> {
        let root = directory
            .components()
            .filter_map(|part| match part {
                Component::Normal(value) => Some(value.to_str()),
                Component::CurDir => None,
                _ => Some(None),
            })
            .collect::<Option<Vec<_>>>()
            .ok_or(ScanError::Unavailable)?
            .join("/");
        let mut result = Self::default();
        result.walk(reader, &root, cancellation)?;
        Ok(result)
    }

    fn walk(
        &mut self,
        reader: &Reader<'_>,
        root: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), ScanError> {
        let mut pending = vec![String::new()];
        while let Some(relative) = pending.pop() {
            super::discovery::check_cancelled(cancellation)?;
            let path = if relative.is_empty() {
                root.into()
            } else {
                format!("{root}/{relative}")
            };
            let mut entries = Vec::new();
            let read = reader.visit_directory(&path, Symlinks::Reject, |entry| {
                super::discovery::check_cancelled(cancellation)
                    .map_err(|_| maka_capabilities::filesystem::ReadError::Retired)?;
                if !entry.name.starts_with('.') && entry.name != "SKILL.md" {
                    entries.push(entry);
                }
                Ok(())
            });
            if matches!(read, Err(maka_capabilities::filesystem::ReadError::Retired)) {
                return Err(ScanError::Cancelled);
            }
            if read.is_err() {
                self.incomplete = true;
            }
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            for entry in entries {
                super::discovery::check_cancelled(cancellation)?;
                let relative = if relative.is_empty() {
                    entry.name
                } else {
                    format!("{relative}/{}", entry.name)
                };
                if !valid_path(&relative) {
                    continue;
                }
                let resource = match entry.kind {
                    Kind::Directory => {
                        pending.push(relative);
                        continue;
                    }
                    Kind::Other => Resource::Unavailable(DiscoveryFailure::BlockedPath),
                    Kind::File => match super::discovery::source::read_view(
                        reader,
                        Path::new(&format!("{root}/{relative}")),
                        cancellation,
                    ) {
                        Ok(Some(bytes)) => match String::from_utf8(bytes) {
                            Ok(content) => Resource::Text {
                                hash: maka_agent_facts::artifact::content_digest(
                                    content.as_bytes(),
                                ),
                                content: content.into(),
                            },
                            Err(_) => Resource::Unavailable(DiscoveryFailure::ReadFailed),
                        },
                        Err(super::discovery::source::ReadError::Cancelled) => {
                            return Err(ScanError::Cancelled);
                        }
                        Err(super::discovery::source::ReadError::Failure(reason)) => {
                            Resource::Unavailable(reason)
                        }
                        Ok(None) => Resource::Unavailable(DiscoveryFailure::ReadFailed),
                    },
                };
                self.files.insert(relative, resource);
            }
        }
        Ok(())
    }

    pub(crate) fn fingerprint(&self) -> (bool, Vec<(&str, &str)>) {
        (
            self.incomplete,
            self.files
                .iter()
                .map(|(path, resource)| {
                    (
                        path.as_str(),
                        match resource {
                            Resource::Text { hash, .. } => hash.as_str(),
                            Resource::Embedded(text) => text.hash,
                            Resource::Unavailable(DiscoveryFailure::BlockedPath) => "blocked",
                            Resource::Unavailable(DiscoveryFailure::ReadFailed) => "unreadable",
                        },
                    )
                })
                .collect(),
        )
    }

    pub fn page(&self, reference: &str, input: &ReadInput) -> Result<(String, ReadPage), String> {
        self.page_with_budget(reference, input, maka_agent_facts::read::MAX_PAGE_CHARS)
    }

    /// Reserve space for the calling service's result envelope in the model page budget.
    pub fn page_with_budget(
        &self,
        reference: &str,
        input: &ReadInput,
        budget: usize,
    ) -> Result<(String, ReadPage), String> {
        let mut request = input.resolve().map_err(|e| e.to_string())?;
        let prefix = format!("{reference}/");
        let path = if request.is_continuation() {
            request
                .path()
                .strip_prefix(&prefix)
                .ok_or("Skill continuation belongs to a different skill")?
                .to_owned()
        } else {
            request.path().to_owned()
        };
        if !valid_path(&path) {
            return Err("Skill resource path must stay inside this skill directory".into());
        }
        let content = match self.files.get(&path) {
            Some(Resource::Text { content, .. }) => content.as_ref(),
            Some(Resource::Embedded(text)) => text.content(),
            Some(Resource::Unavailable(_)) => {
                return Err(
                    "Skill resource was not a readable regular UTF-8 file at request capture"
                        .into(),
                );
            }
            None if self.incomplete => {
                return Err("Skill resource unavailable: directory capture was incomplete".into());
            }
            None => return Err("Skill resource not found in this request's snapshot".into()),
        };
        if !request.is_continuation() {
            request = ReadInput {
                path: format!("{prefix}{path}"),
                offset: input.offset,
                limit: input.limit,
            }
            .resolve()
            .map_err(|e| e.to_string())?;
        }
        Ok((
            path,
            request
                .page_with_budget(content, budget)
                .map_err(|e| e.to_string())?,
        ))
    }
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_resources_enforce_containment_and_uniqueness() {
        for files in [
            &[("../secret", None)][..],
            &[("/secret", None)],
            &[("a//b", None)],
            &[("a/./b", None)],
            &[("a\\b", None)],
            &[("a:b", None)],
            &[("a/.hidden", None)],
            &[("same", None), ("same", None)],
        ] {
            assert!(Resources::embedded(files).is_err());
        }
        let captured = Resources::embedded(&[("binary", None)]).unwrap();
        assert!(matches!(
            captured.files["binary"],
            Resource::Unavailable(DiscoveryFailure::ReadFailed)
        ));
    }
}
