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

use super::*;
use maka_agent_facts::interaction::PermissionRequest;
use std::path::Component;

pub(super) async fn authorize(
    store: &maka_event_log::SessionStore,
    captured: Captured,
    configuration: &ResolvedConfiguration,
    tool: &'static str,
    input: &Value,
    context: &ToolCallContext,
    cancellation: &CancellationToken,
) -> Result<Captured, ToolError> {
    if matches!(captured.sandbox, Sandbox::Disabled) {
        return Ok(captured);
    }
    let grants = store
        .permission_grants(
            &context.invocation,
            Some(&context.tool_use_id()),
            &configuration.permission_basis(),
        )
        .await
        .map_err(|_| failed("Workspace permission observation unavailable"))?;
    let input = input.clone();
    let (mut captured, required) = tokio::task::spawn_blocking(move || {
        let mut captured = captured;
        for grant in grants {
            captured.sandbox = captured
                .sandbox
                .with_grant(&grant.permissions, &captured.ceiling)
                .map_err(failed)?;
        }
        let paths = maka_fs_tools::mutation_paths(tool, input, &captured.path)?;
        let mut requested = Vec::new();
        for path in paths {
            let lexical = Permissions {
                filesystem: vec![Rule::exact(&path, Access::Write)],
                network: Network::Denied,
            };
            if !captured.ceiling.permits(&lexical).map_err(failed)? {
                return Err(failed(
                    "Workspace metadata or Host-private files cannot be granted",
                ));
            }
            let (root, directory, relative) = match path.strip_prefix(&captured.path) {
                Ok(relative) => (
                    captured.path.clone(),
                    captured.directory.try_clone().map_err(failed)?,
                    relative.to_owned(),
                ),
                Err(_) => {
                    let root = path
                        .ancestors()
                        .last()
                        .ok_or_else(|| failed("Absolute file path required"))?;
                    let directory =
                        cap_std::fs::Dir::open_ambient_dir(root, cap_std::ambient_authority())
                            .map_err(failed)?;
                    (
                        root.to_owned(),
                        directory,
                        path.strip_prefix(root).map_err(failed)?.to_owned(),
                    )
                }
            };
            if relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
            {
                return Err(failed("Write does not support parent path components"));
            }
            let relative: PathBuf = relative
                .components()
                .filter(|part| *part != Component::CurDir)
                .collect();
            let resolved = match directory.canonicalize(&relative) {
                Ok(path) => path,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // A missing leaf is allowed; dangling links and absent parents are not.
                    match directory.symlink_metadata(&relative) {
                        Ok(_) => return Err(failed("Write target is a dangling link")),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(failed(error)),
                    }
                    let name = relative
                        .file_name()
                        .ok_or_else(|| failed("Write requires a file name"))?;
                    let parent = relative
                        .parent()
                        .filter(|path| !path.as_os_str().is_empty())
                        .unwrap_or(Path::new("."));
                    directory.canonicalize(parent).map_err(failed)?.join(name)
                }
                Err(error) => return Err(failed(error)),
            };
            let resolved: PathBuf = resolved
                .components()
                .filter(|part| *part != Component::CurDir)
                .collect();
            if (root == captured.path && resolved != relative)
                || directory
                    .symlink_metadata(&relative)
                    .is_ok_and(|m| m.is_symlink())
            {
                return Err(failed("Write does not support symlink targets"));
            }
            let permissions = Permissions {
                filesystem: vec![Rule::exact(root.join(resolved), Access::Write)],
                network: Network::Denied,
            };
            if !captured.ceiling.permits(&permissions).map_err(failed)? {
                return Err(failed(
                    "Workspace metadata or Host-private files cannot be granted",
                ));
            }
            if !captured.sandbox.permits(&permissions).map_err(failed)? {
                requested.extend(permissions.filesystem);
            }
        }
        let required = Permissions {
            filesystem: requested,
            network: Network::Denied,
        };
        required.validate().map_err(failed)?;
        Ok::<_, ToolError>((captured, required))
    })
    .await
    .map_err(failed)??;
    cancelled(cancellation)?;
    if required.filesystem.is_empty() {
        return Ok(captured);
    }
    let grant = maka_agent_authority::permissions::request(
        store,
        configuration,
        PermissionRequest {
            reason: format!("{tool} needs write access to these files."),
            command: None,
            permissions: required.clone(),
        },
        context,
        cancellation,
    )
    .await?;
    captured.sandbox = captured
        .sandbox
        .with_grant(&grant.permissions, &captured.ceiling)
        .map_err(failed)?;
    if !captured.sandbox.permits(&required).map_err(failed)? {
        return Err(failed(
            "Not all target files were approved; no files were changed",
        ));
    }
    Ok(captured)
}
