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

use crate::Error;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

mod intersection;
mod snapshot;

/// Equal-path conflict priority is different from authority breadth: deny wins.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Read,
    Write,
    Deny,
}
impl Access {
    pub fn can_read(self) -> bool {
        self != Self::Deny
    }
    pub fn can_write(self) -> bool {
        self == Self::Write
    }
    pub fn intersect(self, other: Self) -> Self {
        match (self, other) {
            (Self::Deny, _) | (_, Self::Deny) => Self::Deny,
            (Self::Read, _) | (_, Self::Read) => Self::Read,
            _ => Self::Write,
        }
    }

    pub(crate) fn union(self, other: Self) -> Self {
        match (self, other) {
            (Self::Write, _) | (_, Self::Write) => Self::Write,
            (Self::Read, _) | (_, Self::Read) => Self::Read,
            _ => Self::Deny,
        }
    }
}

#[derive(
    Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Subtree,
    Exact,
}

/// Paths have executor-native meaning. Validate and materialize them on the
/// execution host, never on a remote Desktop. This document alone grants nothing.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub path: PathBuf,
    pub scope: Scope,
    pub access: Access,
}
impl Rule {
    pub fn subtree(path: impl Into<PathBuf>, access: Access) -> Self {
        Self {
            path: path.into(),
            scope: Scope::Subtree,
            access,
        }
    }
    pub fn exact(path: impl Into<PathBuf>, access: Access) -> Self {
        Self {
            path: path.into(),
            scope: Scope::Exact,
            access,
        }
    }
}

/// Longest path wins; at the same path exact wins over subtree, then deny wins
/// over write over read. Deny globs are absolute and cannot be reopened by paths.
/// Matching directories deny their descendants.
/// Host file operations match at access time. Linux and Windows subprocesses
/// snapshot existing glob matches during preparation; macOS enforces them live.
/// Empty restricted policy denies all access, rather than falling back to defaults.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub default: Access,
    pub rules: Vec<Rule>,
    pub deny_globs: Vec<String>,
}
impl Policy {
    pub fn uniform(access: Access) -> Self {
        Self {
            default: access,
            rules: Vec::new(),
            deny_globs: Vec::new(),
        }
    }

    pub fn compile(&self) -> Result<Compiled, Error> {
        for rule in &self.rules {
            validate_path(&rule.path)?;
        }
        let mut builder = GlobSetBuilder::new();
        for pattern in &self.deny_globs {
            validate_path(Path::new(pattern))?;
            if pattern.contains('\0') || !Path::new(pattern).is_absolute() {
                return Err(Error::Invalid("deny glob must be an absolute path".into()));
            }
            builder.add(compile_glob(pattern)?);
        }
        let mut policy = self.clone();
        policy.rules.sort_by(|a, b| {
            crate::path::compare(&a.path, &b.path)
                .then(a.scope.cmp(&b.scope))
                .then(a.access.cmp(&b.access))
        });
        // Resolve duplicate rules once. Policy evaluation is independent of input order.
        let mut rules: Vec<Rule> = Vec::with_capacity(policy.rules.len());
        for rule in policy.rules {
            if let Some(previous) = rules.last_mut()
                && crate::path::compare(&previous.path, &rule.path).is_eq()
                && previous.scope == rule.scope
            {
                previous.access = previous.access.max(rule.access);
            } else {
                rules.push(rule);
            }
        }
        policy.rules = Vec::with_capacity(rules.len());
        policy.deny_globs.sort();
        policy.deny_globs.dedup();
        let mut compiled = Compiled {
            policy,
            denied: builder
                .build()
                .map_err(|error| Error::Invalid(error.to_string()))?,
        };
        // Parents precede descendants; subtree precedes exact at the same path.
        // Keep only authority transitions, not redundant mount/guard boundaries.
        // In particular a missing read-only path under a read-only parent needs
        // no synthetic mount and must not prevent a Linux command from starting.
        for rule in rules {
            if compiled.path_access(&rule.path, rule.scope == Scope::Exact) != rule.access {
                compiled.policy.rules.push(rule);
            }
        }
        Ok(compiled)
    }
}

/// Validated, deterministic matcher. Filesystem access still requires an OS
/// sandbox or a Host directory capability; string matching is not race protection.
pub struct Compiled {
    policy: Policy,
    denied: GlobSet,
}
impl Compiled {
    pub fn policy(&self) -> &Policy {
        &self.policy
    }
    pub fn access(&self, path: &Path) -> Access {
        if validate_path(path).is_err() {
            return Access::Deny;
        }
        if self.denied.is_empty() {
            return self.path_access(path, true);
        }
        // A denied directory also denies its descendants, including spellings
        // with repeated separators. Mapping errors must not erase a denial.
        for ancestor in path.ancestors() {
            let Some(text) = ancestor.to_str() else {
                return Access::Deny;
            };
            let Ok(text) = crate::path::glob_text(text) else {
                return Access::Deny;
            };
            if self.denied.is_match(text.as_str()) {
                return Access::Deny;
            }
        }
        self.path_access(path, true)
    }
    /// Authority inherited before this rule applies. An exact rule can override
    /// a subtree grant at the same path; a subtree rule inherits only its parents.
    pub fn inherited_access(&self, rule: &Rule) -> Access {
        self.policy
            .rules
            .iter()
            .filter(|ancestor| {
                ancestor.scope == Scope::Subtree
                    && crate::path::within(&rule.path, &ancestor.path)
                    && (rule.scope == Scope::Exact
                        || !crate::path::compare(&rule.path, &ancestor.path).is_eq())
            })
            .max_by_key(|ancestor| ancestor.path.components().count())
            .map_or(self.policy.default, |ancestor| ancestor.access)
    }
    /// Directory mutations affect descendants too. Unknown future glob matches
    /// cannot authorize moving a subtree; callers must keep those names in place.
    pub fn permits_subtree(&self, path: &Path, access: Access) -> bool {
        self.policy.deny_globs.is_empty()
            && self.access(path).intersect(access) == access
            && self.path_access(path, false).intersect(access) == access
            && self
                .policy
                .rules
                .iter()
                .filter(|rule| crate::path::within(&rule.path, path))
                .all(|rule| rule.access.intersect(access) == access)
    }
    fn path_access(&self, path: &Path, exact: bool) -> Access {
        self.policy
            .rules
            .iter()
            .filter(|rule| match rule.scope {
                Scope::Subtree => crate::path::within(path, &rule.path),
                Scope::Exact => exact && crate::path::compare(path, &rule.path).is_eq(),
            })
            .max_by_key(|rule| (rule.path.components().count(), rule.scope, rule.access))
            .map_or(self.policy.default, |rule| rule.access)
    }
}

pub(crate) fn validate_path(path: &Path) -> Result<(), Error> {
    crate::path::validate(path)
}

pub(crate) fn compile_glob(pattern: &str) -> Result<globset::Glob, Error> {
    GlobBuilder::new(&crate::path::glob_text(pattern)?)
        .literal_separator(true)
        .backslash_escape(false)
        .build()
        .map_err(|error| Error::Invalid(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_authority_uses_subtree_rules_instead_of_exact_parent_access() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let policy = Policy {
            default: Access::Read,
            rules: vec![
                Rule::subtree(root, Access::Write),
                Rule::exact(root, Access::Read),
                Rule::subtree(root.join("metadata"), Access::Read),
                Rule::subtree(root.join("metadata/output"), Access::Write),
                Rule::exact(root.join("file"), Access::Read),
            ],
            deny_globs: Vec::new(),
        }
        .compile()
        .unwrap();
        assert_eq!(policy.access(root), Access::Read);
        assert_eq!(policy.access(&root.join("ordinary")), Access::Write);
        for (path, scope, inherited) in [
            (root.to_path_buf(), Scope::Subtree, Access::Read),
            (root.to_path_buf(), Scope::Exact, Access::Write),
            (root.join("metadata"), Scope::Subtree, Access::Write),
            (root.join("metadata/output"), Scope::Subtree, Access::Read),
            (root.join("file"), Scope::Exact, Access::Write),
        ] {
            let rule = policy
                .policy()
                .rules
                .iter()
                .find(|rule| rule.path == path && rule.scope == scope)
                .unwrap();
            assert_eq!(policy.inherited_access(rule), inherited, "{path:?}");
        }
    }

    #[test]
    fn normalization_removes_noop_boundaries_without_erasing_nested_reopenings() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let rules = vec![
            Rule::subtree(root.join("missing"), Access::Read),
            Rule::exact(root, Access::Write),
            Rule::subtree(root.join("writable"), Access::Write),
            Rule::subtree(root.join("writable/metadata"), Access::Read),
            Rule::subtree(root.join("writable/metadata/read"), Access::Read),
            Rule::exact(root.join("writable/metadata/file"), Access::Write),
        ];
        for rules in [rules.clone(), rules.into_iter().rev().collect()] {
            let policy = Policy {
                default: Access::Read,
                rules,
                deny_globs: vec![],
            }
            .compile()
            .unwrap();
            assert_eq!(policy.policy().rules.len(), 4);
            assert!(
                !policy.permits_subtree(root, Access::Write),
                "exact directory permission does not cover children"
            );
            assert!(
                !policy.permits_subtree(&root.join("writable"), Access::Write),
                "nested read-only boundary cannot move"
            );
            assert!(policy.permits_subtree(&root.join("writable/ordinary"), Access::Write));
            for (path, access) in [
                ("", Access::Write),
                ("missing", Access::Read),
                ("writable/new", Access::Write),
                ("writable/metadata", Access::Read),
                ("writable/metadata/read/new", Access::Read),
                ("writable/metadata/file", Access::Write),
                ("writable/metadata/file/child", Access::Read),
            ] {
                assert_eq!(policy.access(&root.join(path)), access, "{path}");
            }
            assert_eq!(policy.policy().compile().unwrap().policy(), policy.policy());
        }
    }

    #[test]
    fn deny_globs_cover_separator_aliases_and_directory_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let policy = Policy {
            default: Access::Write,
            rules: vec![],
            deny_globs: vec![format!("{}//private", root.display())],
        }
        .compile()
        .unwrap();
        for suffix in ["private", "private/child", "/private//child"] {
            assert_eq!(
                policy.access(&root.join(suffix.trim_start_matches('/'))),
                Access::Deny
            );
        }
        assert_eq!(policy.access(&root.join("public/child")), Access::Write);
    }

    #[cfg(windows)]
    #[test]
    fn windows_denials_use_native_casing_and_parsed_unc_roots() {
        let policy = Policy {
            default: Access::Write,
            rules: vec![Rule::subtree(r"\\server\share\private", Access::Deny)],
            deny_globs: vec!["C:/data/École".into(), "C:/data/I".into()],
        }
        .compile()
        .unwrap();
        for path in [
            "//SERVER/share/private/child",
            "C:/DATA/école/child",
            "C:/data/i/child",
        ] {
            assert_eq!(policy.access(Path::new(path)), Access::Deny, "{path}");
        }
        assert_eq!(
            policy.access(Path::new("//SERVER/share/public")),
            Access::Write
        );
        // Compare with the native path comparator, not linguistic assumptions
        // about Unicode casing (notably Turkish I and supplementary characters).
        let names = ["I", "ı", "İ", "σ", "ς", "ß", "É", "é", "𐐀", "𐐨"];
        for denied in names {
            let root = PathBuf::from(format!("C:/data/{denied}"));
            let matcher = Policy {
                default: Access::Write,
                rules: vec![],
                deny_globs: vec![root.to_str().unwrap().into()],
            }
            .compile()
            .unwrap();
            for candidate in names {
                let path = PathBuf::from(format!("C:/data/{candidate}"));
                let expected = if crate::path::compare(&root, &path).is_eq() {
                    Access::Deny
                } else {
                    Access::Write
                };
                assert_eq!(
                    matcher.access(&path.join("child")),
                    expected,
                    "{denied} / {candidate}"
                );
            }
        }
    }
}
