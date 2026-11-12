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

use crate::scoped::Directory as Dir;
use crate::{ReadExecutor, failed};
use glob::MatchOptions;
use maka_agent_facts::tools::ToolError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

mod pattern;
use pattern::{Segment, compile};

pub const GLOB_NAME: &str = "Glob";
pub const GLOB_DESCRIPTION: &str = "Find paths matching a Unix glob (*, ?, **, character classes), relative to the search directory. Returns the complete matching file set in the admitted search scope. Wildcard matching is case-insensitive on macOS and Windows, case-sensitive on Linux. Hidden names require an explicit dot; recursive wildcards do not follow directory symlinks. cwd is limited to the Session's admitted filesystem roots.";

pub fn glob_schema() -> Value {
    schemars::schema_for!(Input).into()
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Input {
    #[schemars(length(min = 1))]
    pattern: String,
    #[serde(default = "default_cwd")]
    #[schemars(length(min = 1))]
    cwd: String,
}
fn default_cwd() -> String {
    ".".into()
}

impl ReadExecutor {
    pub async fn glob(
        &self,
        input: Value,
        cancellation: CancellationToken,
    ) -> Result<Value, ToolError> {
        let input: Input = serde_json::from_value(input).map_err(|e| failed(e.to_string()))?;
        let segments = compile(&input.pattern)?;
        if input.cwd.is_empty() || input.cwd.contains("://") {
            return Err(failed("Glob cwd requires a filesystem directory"));
        }
        let authority = self.authority.clone();
        tokio::task::spawn_blocking(move || {
            let mut search = Search {
                cancellation,
                files: BTreeSet::new(),
            };
            search.check()?;
            let mut opened = None;
            let mut error = failed("Glob cwd is outside the admitted Read roots");
            for route in authority.read_routes(Path::new(&input.cwd))? {
                let root = route.root;
                let path = route.relative;
                match root.open_dir(if path.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    &path
                }) {
                    Ok(dir) => {
                        opened = Some(dir);
                        break;
                    }
                    Err(reason) => error = failed(format!("Glob cwd: {reason}")),
                }
            }
            let directory = opened.ok_or(error)?;
            if !segments.is_empty() {
                search.walk(&directory, &segments)?;
            }
            search.check()?;
            Ok(json!({"files":search.files,"complete":true}))
        })
        .await
        .map_err(|e| failed(format!("Glob worker failed: {e}")))?
    }
}

struct Search {
    cancellation: CancellationToken,
    files: BTreeSet<String>,
}

impl Search {
    fn check(&self) -> Result<(), ToolError> {
        if self.cancellation.is_cancelled() {
            return Err(failed("Glob cancelled"));
        }
        Ok(())
    }

    fn record(&mut self, relative: &Path) -> Result<(), ToolError> {
        let path = if relative.as_os_str().is_empty() {
            "."
        } else {
            relative
                .to_str()
                .ok_or_else(|| failed("Glob path is not UTF-8"))?
        };
        self.files.insert(path.to_owned());
        Ok(())
    }

    fn walk(&mut self, root: &Dir, segments: &[Segment]) -> Result<(), ToolError> {
        enum Work {
            Visit(PathBuf, usize),
            Record(PathBuf),
            Leave((String, usize)),
        }
        let mut pending = vec![Work::Visit(PathBuf::new(), 0)];
        let mut active = BTreeSet::new();
        while let Some(work) = pending.pop() {
            self.check()?;
            let (relative, index) = match work {
                Work::Record(path) => {
                    self.record(&path)?;
                    continue;
                }
                Work::Leave(identity) => {
                    active.remove(&identity);
                    continue;
                }
                Work::Visit(path, index) => (path, index),
            };
            if let Err(error) = root.check_read(&relative) {
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    continue;
                }
                return Err(failed(format!("Glob path: {error}")));
            }
            let Some(segment) = segments.get(index) else {
                self.record(&relative)?;
                continue;
            };
            if matches!(segment, Segment::Directory) {
                self.record(&relative)?;
                continue;
            }
            let last = index + 1 == segments.len();
            if let Segment::Literal(name) = segment {
                let child = relative.join(name);
                let metadata = match root.symlink_metadata(&child) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(failed(format!("Glob path: {error}"))),
                };
                if last {
                    self.record(&child)?;
                } else if metadata.is_dir() || metadata.is_symlink() {
                    pending.push(Work::Visit(child, index + 1));
                }
                continue;
            }
            let path = if relative.as_os_str().is_empty() {
                Path::new(".")
            } else {
                &relative
            };
            let identity = (
                root.open_dir(path)
                    .and_then(|directory| directory.identity())
                    .map_err(|e| failed(format!("Glob path: {e}")))?,
                index,
            );
            if !active.insert(identity.clone()) {
                continue;
            }
            pending.push(Work::Leave(identity));
            let recursive = matches!(segment, Segment::Recursive);
            let mut children = Vec::new();
            for entry in root
                .read_dir(path)
                .map_err(|e| failed(format!("Glob directory: {e}")))?
            {
                self.check()?;
                let entry = entry.map_err(|e| failed(format!("Glob directory entry: {e}")))?;
                children.push((
                    entry.file_name(),
                    entry
                        .file_type()
                        .map_err(|e| failed(format!("Glob file type: {e}")))?,
                ));
            }
            children.sort_by(|a, b| a.0.cmp(&b.0));
            for (name, kind) in children.into_iter().rev() {
                self.check()?;
                let name = name
                    .to_str()
                    .ok_or_else(|| failed("Glob path is not UTF-8"))?;
                let matched = match segment {
                    Segment::Recursive => !name.starts_with('.'),
                    Segment::Match(pattern) => pattern.matches_with(
                        name,
                        MatchOptions {
                            case_sensitive: cfg!(target_os = "linux"),
                            require_literal_separator: true,
                            require_literal_leading_dot: true,
                        },
                    ),
                    _ => unreachable!("literal and directory handled above"),
                };
                if !matched {
                    continue;
                }
                let child = relative.join(name);
                if let Err(error) = root.check_read(&child) {
                    if error.kind() == std::io::ErrorKind::PermissionDenied {
                        continue;
                    }
                    return Err(failed(format!("Glob path: {error}")));
                }
                if kind.is_dir() && (recursive || !last) {
                    pending.push(Work::Visit(
                        child.clone(),
                        if recursive { index } else { index + 1 },
                    ));
                }
                if last {
                    pending.push(Work::Record(child));
                }
            }
            if recursive {
                pending.push(Work::Visit(relative, index + 1));
            }
        }
        Ok(())
    }
}
