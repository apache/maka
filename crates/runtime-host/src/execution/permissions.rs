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

use maka_runtime::execution::SandboxMode;
use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Policy, Rule},
};
use std::path::Path;

/// Resolve requested spellings on the execution Host before displaying or
/// recording consent. Missing leaves retain their resolved existing ancestor;
/// dangling links and inaccessible paths fail instead of becoming new authority.
pub(crate) fn materialize(
    mut permissions: maka_sandbox::grant::Permissions,
) -> Result<maka_sandbox::grant::Permissions, maka_sandbox::Error> {
    permissions.validate()?;
    for rule in &mut permissions.filesystem {
        let mut ancestor = rule.path.as_path();
        let mut missing = Vec::new();
        let resolved = loop {
            match ancestor.canonicalize() {
                Ok(resolved) => break resolved,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match ancestor.symlink_metadata() {
                        Ok(_) => return Err(error.into()),
                        Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                    missing.push(ancestor.file_name().ok_or(error)?);
                    ancestor = ancestor.parent().ok_or_else(|| {
                        maka_sandbox::Error::Invalid(
                            "permission path has no existing ancestor".into(),
                        )
                    })?;
                }
                Err(error) => return Err(error.into()),
            }
        };
        let mut path =
            std::path::PathBuf::from(maka_fs_tools::workspace::project::host_path(&resolved)?);
        for leaf in missing.into_iter().rev() {
            path.push(leaf);
        }
        rule.path = path;
    }
    permissions.validate()?;
    Ok(permissions)
}

/// The embedding supplies a captured, policy-limited root to contribution
/// callbacks. The plugin kernel must never derive authority from a cwd string.
pub(crate) fn read_root(
    mode: SandboxMode,
    cwd: &Path,
    state_root: &Path,
    origin: maka_runtime::execution::WorkspaceOrigin,
) -> Result<maka_plugins::filesystem::ReadRoot, maka_plugins::Error> {
    let (sandbox, _) = resolve(mode, cwd, state_root, origin)
        .map_err(|error| maka_plugins::Error::Invalid(error.to_string()))?;
    let root = maka_plugins::filesystem::ReadRoot::capture(cwd)
        .map_err(|error| maka_plugins::Error::Invalid(error.to_string()))?;
    match sandbox {
        Sandbox::Managed { filesystem, .. } => root.restrict(std::sync::Arc::new(
            filesystem
                .compile()
                .map_err(|error| maka_plugins::Error::Invalid(error.to_string()))?,
        )),
        _ => Ok(root),
    }
}

/// Resolve presets on the execution Host. The second policy is an immutable
/// ceiling for approved additions, not a mutable second Session authority.
pub(crate) fn resolve(
    mode: SandboxMode,
    cwd: &Path,
    state_root: &Path,
    origin: maka_runtime::execution::WorkspaceOrigin,
) -> Result<(Sandbox, Sandbox), maka_sandbox::Error> {
    resolve_inner(mode, cwd, state_root, origin, None)
}

/// Private data is captured from the owning Fiber's storage capability by the
/// Host issuer; command input must never supply this additional authority.
pub(crate) fn resolve_plugin(
    mode: SandboxMode,
    cwd: &Path,
    state_root: &Path,
    origin: maka_runtime::execution::WorkspaceOrigin,
    private_data: &Path,
) -> Result<(Sandbox, Sandbox), maka_sandbox::Error> {
    resolve_inner(mode, cwd, state_root, origin, Some(private_data))
}

fn resolve_inner(
    mode: SandboxMode,
    cwd: &Path,
    state_root: &Path,
    origin: maka_runtime::execution::WorkspaceOrigin,
    private_data: Option<&Path>,
) -> Result<(Sandbox, Sandbox), maka_sandbox::Error> {
    if mode == SandboxMode::DangerFullAccess {
        return Ok((Sandbox::Disabled, Sandbox::Disabled));
    }
    // RootOwner retains the native canonical path (verbatim on Windows),
    // whereas policy paths use the same Host spelling as workspace projections.
    let state_root = std::path::PathBuf::from(
        maka_fs_tools::workspace::project::host_path(state_root)
            .map_err(|error| maka_sandbox::Error::Invalid(error.to_string()))?,
    );
    let (base, metadata) = maka_fs_tools::workspace::permissions::resolve(mode, cwd)?;
    // A more specific metadata rule must not reopen a protected Host directory.
    let mut state_rules = vec![Rule::subtree(&state_root, Access::Deny)];
    let private_rule = private_data
        .map(|path| {
            maka_fs_tools::workspace::project::host_path(path)
                .map(|path| Rule::subtree(path, Access::Write))
                .map_err(|error| maka_sandbox::Error::Invalid(error.to_string()))
        })
        .transpose()?;
    if let Some(rule) = &private_rule {
        state_rules.push(rule.clone());
    }
    // These are Host-allocated execution areas, not plugin data or authority.
    // Reopen only this execution's cwd, never the allocation parent or siblings.
    if origin == maka_runtime::execution::WorkspaceOrigin::Allocated
        && cwd != state_root
        && cwd.starts_with(&state_root)
    {
        state_rules.push(Rule::subtree(cwd, Access::Write));
    }
    let ceiling = metadata.intersect(&Sandbox::Managed {
        filesystem: Policy {
            default: Access::Write,
            rules: state_rules,
            deny_globs: Vec::new(),
        },
        network: Network::Allowed,
    })?;
    let mut sandbox = base.intersect(&ceiling)?;
    if let Some(rule) = private_rule {
        sandbox = sandbox.with_grant(
            &maka_sandbox::grant::Permissions {
                filesystem: vec![rule],
                network: Network::Denied,
            },
            &ceiling,
        )?;
    }
    Ok((sandbox, ceiling))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn plugin_private_data_grants_only_the_owning_package_and_scope() {
        use maka_plugins::{composition::Scope, fiber::Fiber, storage::Directories};
        use maka_runtime::execution::WorkspaceOrigin;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let directories = Directories::open(&root).unwrap();
        let mut owners = Vec::new();
        let mut paths = Vec::new();
        for (package, entry, scope) in [
            ("example.installer", "first", Scope::Profile),
            ("example.installer", "second", Scope::Profile),
            ("example.neighbor", "first", Scope::Profile),
            ("example.installer", "first", Scope::Session("other".into())),
        ] {
            let owner = Fiber::new(package, entry, scope).unwrap();
            owner.begin_loading().unwrap();
            let path = directories
                .bind(owner.context())
                .unwrap()
                .read_only()
                .await
                .unwrap()
                .location();
            paths.push(std::path::PathBuf::from(
                maka_fs_tools::workspace::project::host_path(&path).unwrap(),
            ));
            owners.push(owner);
        }
        assert_eq!(paths[0], paths[1]);
        let own = &paths[0];
        let workspace = tempfile::tempdir().unwrap();
        let cwd = std::path::PathBuf::from(
            maka_fs_tools::workspace::project::host_path(&workspace.path().canonicalize().unwrap())
                .unwrap(),
        );
        for mode in [SandboxMode::ReadOnly, SandboxMode::WorkspaceWrite] {
            for cwd in [&cwd, own] {
                let (Sandbox::Managed { filesystem, .. }, ceiling) =
                    resolve_plugin(mode, cwd, &root, WorkspaceOrigin::Selected, own).unwrap()
                else {
                    unreachable!()
                };
                let policy = filesystem.compile().unwrap();
                assert_eq!(policy.access(&own.join("bin/agent")), Access::Write);
                for denied in [
                    paths[2].join("secret"),
                    paths[3].join("secret"),
                    own.parent().unwrap().join("other/secret"),
                    own.parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join("configuration-rust.sqlite"),
                ] {
                    assert_eq!(policy.access(&denied), Access::Deny);
                    assert!(
                        !ceiling
                            .permits(&maka_sandbox::grant::Permissions {
                                filesystem: vec![Rule::exact(denied, Access::Write)],
                                network: Network::Denied,
                            })
                            .unwrap()
                    );
                }
                assert_eq!(
                    policy.access(&cwd.join(".agents/instructions")),
                    Access::Read
                );
            }
        }
        for owner in owners {
            owner
                .shutdown(tokio::time::Instant::now() + std::time::Duration::from_secs(2))
                .await
                .unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn approval_resolves_aliases_and_missing_leaves_but_not_dangling_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let request = |path| maka_sandbox::grant::Permissions {
            filesystem: vec![Rule::exact(path, Access::Write)],
            network: Network::Denied,
        };
        let granted = materialize(request(alias.join("new/file"))).unwrap();
        assert_eq!(granted.filesystem[0].path, target.join("new/file"));
        // Replacing the alias after consent cannot retarget the recorded grant.
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(root.join("missing"), &alias).unwrap();
        assert_eq!(granted.filesystem[0].path, target.join("new/file"));
        assert!(materialize(request(alias.join("new/file"))).is_err());
    }

    #[test]
    fn managed_execution_areas_do_not_reopen_host_authority_or_neighbor_allocations() {
        let temp = tempfile::tempdir().unwrap();
        let native_root = temp.path().canonicalize().unwrap();
        let root = std::path::PathBuf::from(
            maka_fs_tools::workspace::project::host_path(&native_root).unwrap(),
        );
        for name in [
            "plugin-workspaces/first",
            "subagent-worktrees/first/worktree",
            "unrelated-allocation-name",
        ] {
            let cwd = root.join(name);
            std::fs::create_dir_all(&cwd).unwrap();
            let (Sandbox::Managed { filesystem, .. }, _) = resolve(
                SandboxMode::WorkspaceWrite,
                &cwd,
                &native_root,
                maka_runtime::execution::WorkspaceOrigin::Allocated,
            )
            .unwrap() else {
                unreachable!()
            };
            let policy = filesystem.compile().unwrap();
            assert_eq!(policy.access(&cwd.join("source.rs")), Access::Write);
            let (Sandbox::Managed { filesystem, .. }, _) = resolve(
                SandboxMode::WorkspaceWrite,
                &cwd,
                &native_root,
                maka_runtime::execution::WorkspaceOrigin::Selected,
            )
            .unwrap() else {
                unreachable!()
            };
            assert_eq!(
                filesystem.compile().unwrap().access(&cwd.join("source.rs")),
                Access::Deny,
                "a matching directory name or a user-selected locator is not an allocation grant"
            );
            assert_eq!(policy.access(&cwd.join(".agents/new")), Access::Read);
            assert_eq!(
                policy.access(&root.join("configuration-rust.sqlite")),
                Access::Deny
            );
            assert_eq!(
                policy.access(&root.join("plugin-workspaces/other/file")),
                Access::Deny
            );
            assert_eq!(
                policy.access(&root.join("subagent-worktrees/first/owner.json")),
                Access::Deny
            );
        }
        let (Sandbox::Managed { filesystem, .. }, _) = resolve(
            SandboxMode::WorkspaceWrite,
            &root,
            &native_root,
            maka_runtime::execution::WorkspaceOrigin::Allocated,
        )
        .unwrap() else {
            unreachable!()
        };
        assert_eq!(
            filesystem
                .compile()
                .unwrap()
                .access(&root.join("configuration-rust.sqlite")),
            Access::Deny
        );
    }
}
