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

use crate::HostError;
use maka_fs_tools::workspace::directory::PublishedDirectory;
use std::path::PathBuf;

#[derive(
    Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(deny_unknown_fields)]
pub struct DirectoryRootSpec {
    pub label: String,
    pub path: PathBuf,
}

impl DirectoryRootSpec {
    /// Validate the published directory set and capture canonical paths once.
    pub fn normalize(specs: Vec<Self>) -> Result<Vec<Self>, HostError> {
        let mut roots: Vec<Self> = Vec::new();
        for spec in specs {
            let label = spec
                .label
                .trim_matches(|c| {
                    matches!(c,
                '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
                '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
                '\u{205f}' | '\u{3000}' | '\u{feff}')
                })
                .to_owned();
            if label.is_empty() || label.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}') {
                return Err("invalid project root label".into());
            }
            let directory = PublishedDirectory::open(&spec.path)?;
            if roots
                .iter()
                .any(|r| r.label == label || r.path == directory.path())
            {
                return Err("duplicate project root".into());
            }
            roots.push(Self {
                label,
                path: directory.path().to_owned(),
            });
        }
        Ok(roots)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_roots_have_no_count_cap_and_still_reject_duplicate_paths() {
        let directory = tempfile::tempdir().unwrap();
        let complete_label = "项目".repeat(32);
        let specs: Vec<_> = (0..12)
            .map(|i| {
                let path = directory.path().join(format!("project-{i}"));
                std::fs::create_dir(&path).unwrap();
                DirectoryRootSpec {
                    label: if i == 0 {
                        complete_label.clone()
                    } else {
                        format!("Project {i}")
                    },
                    path,
                }
            })
            .collect();
        let normalized = DirectoryRootSpec::normalize(specs.clone()).unwrap();
        assert_eq!(normalized.len(), 12);
        assert_eq!(normalized[0].label, complete_label);
        let mut duplicate = specs;
        duplicate.push(DirectoryRootSpec {
            label: "Another label".into(),
            path: duplicate[0].path.clone(),
        });
        assert!(DirectoryRootSpec::normalize(duplicate).is_err());
    }
}
