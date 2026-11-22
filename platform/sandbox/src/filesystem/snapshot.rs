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

use super::{Access, Compiled, Policy, Rule};
use crate::{Error, path};
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

impl Compiled {
    /// Materialize existing deny-glob matches for native mechanisms that cannot
    /// match names dynamically. This is a launch snapshot, never a replacement
    /// for the policy used by Host file operations or future launches.
    ///
    /// Scans include hidden/ignored entries but do not follow directory links.
    /// A matching link denies its canonical target too. Incomplete scans fail;
    /// no partial result is returned and no filesystem changes occur here.
    pub fn process_snapshot(&self) -> Result<Policy, Error> {
        if self.policy.deny_globs.is_empty() {
            return Ok(self.policy.clone());
        }
        let mut roots = BTreeSet::new();
        let mut denied = BTreeSet::new();
        for pattern in &self.policy.deny_globs {
            let mut root = PathBuf::new();
            let mut wildcard = false;
            for part in Path::new(pattern).components() {
                if part
                    .as_os_str()
                    .to_string_lossy()
                    .contains(['*', '?', '[', '{'])
                {
                    wildcard = true;
                    break;
                }
                root.push(part);
            }
            if !wildcard {
                // A literal denial can protect a missing path with the native
                // guard machinery; it does not require a directory scan.
                match fs::symlink_metadata(&root) {
                    Ok(_) => {
                        denied.insert(materialized(&root)?);
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        denied.insert(root);
                    }
                    Err(error) => return Err(error.into()),
                }
            } else if root.parent().is_none() {
                return Err(Error::Unsupported(
                    "deny glob needs a literal directory prefix below the filesystem root".into(),
                ));
            } else {
                roots.insert(root);
            }
        }
        let mut scanned = BTreeSet::new();
        let mut pending: Vec<_> = roots.into_iter().collect();
        while let Some(directory) = pending.pop() {
            if !scanned.insert(directory.clone()) {
                continue;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            // Do not scan through an unrecorded ancestor alias. Resolving only
            // the eventual match would silently miss the policy's logical root.
            if !path::compare(&materialized(&directory)?, &directory).is_eq() {
                return Err(Error::Unsupported(
                    "deny glob directory prefix must be materialized on the execution Host".into(),
                ));
            }
            for entry in entries {
                let entry = entry?;
                let candidate = entry.path();
                path::validate(&candidate)?;
                let kind = entry.file_type()?;
                let text = path::glob_text(candidate.to_str().ok_or_else(|| {
                    Error::Invalid("deny glob scan encountered a non-Unicode path".into())
                })?)?;
                if self.denied.is_match(text) {
                    // Binding a symlink itself is not safe on either native
                    // backend. Mask its resolved target, including aliases.
                    denied.insert(materialized(&candidate)?);
                } else if kind.is_dir() {
                    pending.push(candidate);
                }
            }
        }
        let mut policy = self.policy.clone();
        policy.deny_globs.clear();
        // Glob denials cannot be reopened by a more specific ordinary rule.
        policy
            .rules
            .retain(|rule| !denied.iter().any(|root| path::within(&rule.path, root)));
        policy.rules.extend(
            denied
                .into_iter()
                .map(|root| Rule::subtree(root, Access::Deny)),
        );
        Ok(policy.compile()?.policy)
    }
}

fn materialized(path: &Path) -> Result<PathBuf, Error> {
    let canonical = fs::canonicalize(path)?;
    #[cfg(windows)]
    let canonical = {
        use std::path::{Component, Prefix};
        let mut parts = canonical.components();
        let mut result = match parts.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
                Prefix::VerbatimUNC(server, share) => {
                    let mut root = PathBuf::from(r"\\");
                    root.push(server);
                    root.push(share);
                    root
                }
                _ => return Err(Error::Invalid("unsupported canonical Windows path".into())),
            },
            _ => {
                return Err(Error::Invalid(
                    "canonical Windows path lacks a volume".into(),
                ));
            }
        };
        for part in parts {
            if let Component::Normal(name) = part {
                result.push(name);
            }
        }
        result
    };
    path::validate(&canonical)?;
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_snapshot_denies_hidden_directories_and_reopenings_without_mutating_authority() {
        let temp = tempfile::tempdir().unwrap();
        let root = materialized(temp.path()).unwrap();
        fs::create_dir_all(root.join(".hidden/private/nested")).unwrap();
        fs::write(root.join(".hidden/private/nested/file"), "secret").unwrap();
        fs::write(root.join("ordinary"), "public").unwrap();
        let original = Policy {
            default: Access::Read,
            rules: vec![Rule::subtree(
                root.join(".hidden/private/nested"),
                Access::Write,
            )],
            deny_globs: vec![format!("{}/**/private", root.display())],
        }
        .compile()
        .unwrap();
        let snapshot = original.process_snapshot().unwrap().compile().unwrap();
        assert_eq!(
            snapshot.access(&root.join(".hidden/private/nested/file")),
            Access::Deny
        );
        assert_eq!(snapshot.access(&root.join("ordinary")), Access::Read);
        fs::create_dir(root.join("private")).unwrap();
        assert_eq!(snapshot.access(&root.join("private/new")), Access::Read);
        assert_eq!(original.access(&root.join("private/new")), Access::Deny);
        assert_eq!(
            original
                .process_snapshot()
                .unwrap()
                .compile()
                .unwrap()
                .access(&root.join("private/new")),
            Access::Deny
        );
    }

    #[cfg(unix)]
    #[test]
    fn process_snapshot_denies_matching_link_targets_and_requires_a_literal_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = materialized(temp.path()).unwrap();
        fs::write(root.join("actual"), "secret").unwrap();
        std::os::unix::fs::symlink(root.join("actual"), root.join("key.secret")).unwrap();
        let mut policy = Policy {
            default: Access::Read,
            rules: vec![],
            deny_globs: vec![format!("{}/*.secret", root.display())],
        };
        assert_eq!(
            policy
                .compile()
                .unwrap()
                .process_snapshot()
                .unwrap()
                .compile()
                .unwrap()
                .access(&root.join("actual")),
            Access::Deny
        );
        policy.deny_globs = vec!["/**/*.secret".into()];
        assert!(matches!(
            policy.compile().unwrap().process_snapshot(),
            Err(Error::Unsupported(_))
        ));
    }
}
