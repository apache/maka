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

use maka_sandbox::{
    Error, Mode, Network, Sandbox,
    filesystem::{Access, Policy, Rule},
};
use std::path::{Path, PathBuf};

/// Resolve a workspace preset and its immutable metadata ceiling. Embeddings
/// must intersect both with their own private-state protections before use.
pub fn resolve(mode: Mode, cwd: &Path) -> Result<(Sandbox, Sandbox), Error> {
    if mode == Mode::DangerFullAccess {
        return Ok((Sandbox::Disabled, Sandbox::Disabled));
    }
    let mut filesystem = Policy::uniform(Access::Read);
    if mode == Mode::WorkspaceWrite {
        filesystem.rules.push(Rule::subtree(cwd, Access::Write));
        let temporary = [
            std::env::temp_dir(),
            #[cfg(unix)]
            PathBuf::from("/tmp"),
        ];
        for path in temporary {
            let path = path.canonicalize()?;
            let path = PathBuf::from(
                super::project::host_path(&path)
                    .map_err(|error| Error::Invalid(error.to_string()))?,
            );
            let rule = Rule::subtree(path, Access::Write);
            if !filesystem.rules.contains(&rule) {
                filesystem.rules.push(rule);
            }
        }
    }
    let base = Sandbox::Managed {
        filesystem,
        network: Network::Denied,
    };
    let mut rules = vec![
        Rule::subtree(cwd.join(".git"), Access::Read),
        Rule::subtree(cwd.join(".agents"), Access::Read),
        Rule::subtree(cwd.join(".maka"), Access::Read),
    ];
    rules.extend(
        super::git_metadata(cwd)?
            .into_iter()
            .map(|path| Rule::subtree(path, Access::Read)),
    );
    let ceiling = Sandbox::Managed {
        filesystem: Policy {
            default: Access::Write,
            rules,
            deny_globs: Vec::new(),
        },
        network: Network::Allowed,
    };
    Ok((base.intersect(&ceiling)?, ceiling))
}

/// Resolve requested spellings on the execution Host before displaying or
/// recording consent. Missing leaves retain their resolved existing ancestor;
/// dangling links and inaccessible paths fail instead of becoming new authority.
pub fn materialize(
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
        let mut path = std::path::PathBuf::from(super::project::host_path(&resolved)?);
        for leaf in missing.into_iter().rev() {
            path.push(leaf);
        }
        rule.path = path;
    }
    permissions.validate()?;
    Ok(permissions)
}
