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

use super::{WriteAccess, WriteRule};
use maka_sandbox::filesystem::{Access, Policy, Rule, Scope};
use std::{collections::BTreeMap, io, os::windows::fs::MetadataExt, path::Path};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

// Native targets include deny descendants, not just caller-supplied rules.

pub(super) struct Plan {
    pub reads: Vec<Rule>,
    pub writes: Vec<WriteRule>,
}
impl Plan {
    pub fn compile(
        policy: &Policy,
        helper: &Path,
        executable: &Path,
        cwd: &Path,
    ) -> io::Result<Self> {
        let compiled = policy.compile().map_err(io::Error::other)?;
        let policy = compiled.policy();
        if policy.default != Access::Read || !policy.deny_globs.is_empty() {
            return Err(unsupported(
                "Windows execution requires a read-default path policy without deny globs",
            ));
        }
        if !compiled.access(cwd).can_read()
            || !compiled.access(executable).can_read()
            || !compiled.access(helper).can_read()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sandbox denies its working directory or executable",
            ));
        }
        let mut reads = BTreeMap::new();
        // Only launch-critical reads belong to account preparation. Broad
        // default reads are prepared independently for the installation group.
        reads.insert(cwd.to_owned(), (Scope::Subtree, compiled.access(cwd)));
        let owner = maka_event_log::root::windows::account_sid()?;
        if let Ok((_, file)) = maka_sandbox::windows::acl::Target::capture(executable)
            && maka_sandbox::windows::acl::manageable_by(&file, &owner)?
        {
            reads.insert(executable.to_owned(), (Scope::Exact, Access::Read));
        }
        for rule in &policy.rules {
            let metadata = rule.path.symlink_metadata().map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    unsupported(format!(
                        "sandbox boundary {} does not exist; request access to an existing parent and create the path inside the sandbox",
                        rule.path.display()
                    ))
                } else {
                    error
                }
            })?;
            if rule.scope == Scope::Exact && metadata.is_dir() {
                return Err(unsupported(
                    "exact directory policy needs a distinct descendant boundary",
                ));
            }
            if reads
                .insert(rule.path.clone(), (rule.scope, rule.access))
                .is_some_and(|(scope, _)| scope != rule.scope)
            {
                return Err(unsupported("conflicting Windows ACL scopes"));
            }
        }
        // Inherited denies do not override a child's explicit allow and never
        // reach protected DACLs. Pin direct denies for the existing subtree;
        // inherited entries still protect ordinary future children. A command
        // cannot create or change a DACL inside its denied surface.
        let mut directories = policy
            .rules
            .iter()
            .filter(|rule| rule.access == Access::Deny && rule.scope == Scope::Subtree)
            .map(|rule| rule.path.clone())
            .collect::<Vec<_>>();
        let mut visited = std::collections::BTreeSet::new();
        while let Some(directory) = directories.pop() {
            if !visited.insert(directory.clone()) {
                continue;
            }
            if !directory.symlink_metadata()?.is_dir() {
                continue;
            }
            let entries = match std::fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if compiled.access(&path) != Access::Deny {
                    continue;
                }
                let metadata = entry.metadata()?;
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(unsupported(
                        "Windows denied subtree contains a reparse point",
                    ));
                }
                let scope = if metadata.is_dir() {
                    Scope::Subtree
                } else {
                    Scope::Exact
                };
                reads.entry(path.clone()).or_insert((scope, Access::Deny));
                if metadata.is_dir() {
                    directories.push(path);
                }
            }
        }
        // Provider-based shells inspect ancestor metadata when entering cwd.
        // Do not reopen an explicitly denied ancestor merely for convenience.
        for path in [cwd, executable, helper] {
            for ancestor in path.ancestors() {
                if compiled.access(ancestor).can_read() && !reads.contains_key(ancestor) {
                    // Never acquire optional system-directory ACLs merely
                    // because this invocation happens to be elevated.
                    match maka_sandbox::windows::acl::Target::capture(ancestor) {
                        Ok((_, file)) => {
                            if !maka_sandbox::windows::acl::manageable_by(&file, &owner)? {
                                continue;
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => continue,
                        Err(error) => return Err(error),
                    }
                    reads
                        .entry(ancestor.to_owned())
                        .or_insert((Scope::Exact, Access::Read));
                }
            }
        }
        let mut writes = BTreeMap::new();
        for rule in &policy.rules {
            let access = if rule.access == Access::Write {
                if policy.rules.iter().any(|child| {
                    child.path != rule.path
                        && child.path.starts_with(&rule.path)
                        && child.access != Access::Write
                }) {
                    WriteAccess::Preserve
                } else {
                    WriteAccess::Allowed
                }
            } else {
                WriteAccess::Denied
            };
            writes.insert(rule.path.clone(), (rule.scope, access));
        }
        // A guard is useless if a writable intermediate directory can move
        // away with it. Protect every writable ancestor, not just rule roots.
        for rule in policy
            .rules
            .iter()
            .filter(|rule| rule.access != Access::Write)
        {
            for ancestor in rule.path.ancestors().skip(1) {
                if compiled.access(ancestor) == Access::Write {
                    // Only this directory must resist rename/delete. Its children
                    // already inherit the writable root's grant; propagating it
                    // again at every intermediate ancestor repeatedly walks the
                    // same tree during both preparation and settlement.
                    writes
                        .entry(ancestor.to_owned())
                        .and_modify(|(_, access)| *access = WriteAccess::Preserve)
                        .or_insert((Scope::Exact, WriteAccess::Preserve));
                    reads
                        .entry(ancestor.to_owned())
                        .or_insert((Scope::Exact, Access::Write));
                }
            }
        }
        reads.insert(helper.to_owned(), (Scope::Exact, Access::Read));
        Ok(Self {
            reads: reads
                .into_iter()
                .map(|(path, (scope, access))| Rule {
                    path,
                    scope,
                    access,
                })
                .collect(),
            writes: writes
                .into_iter()
                .map(|(path, (scope, access))| WriteRule {
                    path,
                    scope,
                    access,
                })
                .collect(),
        })
    }
}
fn unsupported(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intermediate_guards_do_not_repropagate_the_writable_tree() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_owned();
        let parent = root.join("nested");
        let protected = parent.join("protected");
        std::fs::create_dir_all(&protected).unwrap();
        let executable = std::env::current_exe().unwrap();
        let plan = Plan::compile(
            &Policy {
                default: Access::Read,
                rules: vec![
                    Rule::subtree(&root, Access::Write),
                    Rule::subtree(&protected, Access::Read),
                ],
                deny_globs: Vec::new(),
            },
            &executable,
            &executable,
            &root,
        )
        .unwrap();
        let root_write = plan.writes.iter().find(|rule| rule.path == root).unwrap();
        assert_eq!(root_write.scope, Scope::Subtree);
        assert!(matches!(root_write.access, WriteAccess::Preserve));
        let parent_write = plan.writes.iter().find(|rule| rule.path == parent).unwrap();
        assert_eq!(parent_write.scope, Scope::Exact);
        assert!(matches!(parent_write.access, WriteAccess::Preserve));
        let parent_read = plan.reads.iter().find(|rule| rule.path == parent).unwrap();
        assert_eq!(parent_read.scope, Scope::Exact);
    }
}
