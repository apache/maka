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

use crate::{
    Error, Network,
    filesystem::{Access, Policy, Scope},
    path,
};
use mxc_sdk::v1::{
    ContainerRequest, Containment, FilesystemPolicy, NetworkAction, NetworkEgressPolicy,
    NetworkIngressPolicy, NetworkPeerPolicy, NetworkPolicy, NetworkRulePolicy, UiPolicy,
    configs::{ProcessContainerConfig, ProcessContainerUi, ProcessContainerUiIsolation},
};
use std::{
    collections::HashMap,
    fs, io,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
};
use windows_sys::Win32::Foundation::{
    ERROR_BAD_NETPATH, ERROR_CONNECTION_UNAVAIL, ERROR_DEVICE_NOT_CONNECTED, ERROR_NOT_READY,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, GetDriveTypeW, GetLogicalDrives,
};

pub(super) fn prepare(
    filesystem: &Policy,
    network: &Network,
    cwd: &Path,
) -> Result<ContainerRequest, Error> {
    path::validate(cwd)?;
    let filesystem = filesystem.compile()?.process_snapshot()?.compile()?;
    if !filesystem.access(cwd).can_read() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sandbox denies its working directory",
        )
        .into());
    }
    let volumes = volume_roots(cwd)?;
    let policy = filesystem_policy(filesystem.policy(), &volumes, cwd)?;
    let mut native = ProcessContainerConfig::default();
    let mut desktop = ProcessContainerUi::default();
    desktop.isolation = ProcessContainerUiIsolation::Desktop;
    native.ui = Some(desktop);
    native.capabilities.push("registryRead".into());
    let mut request = ContainerRequest::new("");
    request.containment = Containment::ProcessContainer(native);
    request.filesystem = Some(policy);
    request.network = Some(network_policy(network));
    request.ui = Some(UiPolicy {
        disable: false,
        ..Default::default()
    });
    Ok(request)
}

fn filesystem_policy(
    filesystem: &Policy,
    volumes: &[PathBuf],
    cwd: &Path,
) -> Result<FilesystemPolicy, Error> {
    let mut read = Vec::new();
    let mut write = Vec::new();
    let mut deny = Vec::new();
    if filesystem.default != Access::Deny {
        for volume in volumes {
            if filesystem.default == Access::Read && !implicit_read_root(volume, cwd) {
                continue;
            }
            match fs::read_dir(volume) {
                Ok(_) => {}
                Err(error) if inaccessible_volume(&error) => continue,
                Err(error) => return Err(error.into()),
            }
            match filesystem.default {
                Access::Read => read.push(volume.clone()),
                Access::Write => write.push(volume.clone()),
                Access::Deny => unreachable!(),
            }
        }
    }
    for rule in &filesystem.rules {
        if rule.scope == Scope::Exact || rule.access != Access::Deny {
            match fs::metadata(&rule.path) {
                Ok(metadata) if rule.scope == Scope::Exact && metadata.is_dir() => {
                    return Err(Error::Unsupported(
                        "native MXC cannot express an exact directory permission".into(),
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if fs::symlink_metadata(&rule.path).is_ok() {
                        return Err(Error::Invalid(
                            "MXC policy contains a dangling filesystem link".into(),
                        ));
                    }
                    if rule.access != Access::Deny {
                        return Err(Error::Unsupported(
                            "native MXC ignores missing filesystem grants; prepare existing boundaries before launch".into(),
                        ));
                    }
                }
                Err(error) => return Err(error.into()),
                Ok(_) => {}
            }
        }
        for paths in [&mut read, &mut write, &mut deny] {
            paths.retain(|path| !crate::path::compare(path, &rule.path).is_eq());
        }
        match rule.access {
            Access::Read => read.push(rule.path.clone()),
            Access::Write => write.push(rule.path.clone()),
            Access::Deny => deny.push(rule.path.clone()),
        }
    }
    // Resolve junction/hardlink identities before expanding volume grants so
    // generated children inherit any restriction on the volume itself.
    let normalized = normalize(FilesystemPolicy {
        readonly_paths: strings(read)?,
        readwrite_paths: strings(write)?,
        denied_paths: strings(deny)?,
        ..Default::default()
    })?;
    let readonly = paths(&normalized.readonly_paths);
    let denied = paths(&normalized.denied_paths);
    let mut write = expand_volume_roots(paths(&normalized.readwrite_paths), volumes)?;
    write.retain(|path| !contains(&readonly, path) && !contains(&denied, path));
    let mut read = expand_volume_roots(readonly, volumes)?;
    read.retain(|path| !contains(&write, path) && !contains(&denied, path));
    normalize(FilesystemPolicy {
        readonly_paths: strings(read)?,
        readwrite_paths: strings(write)?,
        denied_paths: normalized.denied_paths,
        ..Default::default()
    })
}

fn network_policy(network: &Network) -> NetworkPolicy {
    let default = if matches!(network, Network::Allowed) {
        NetworkAction::Allow
    } else {
        NetworkAction::Deny
    };
    let restricted = matches!(network, Network::Restricted { .. });
    let loopback = NetworkRulePolicy {
        to: Some(vec![
            NetworkPeerPolicy::new("127.0.0.0/8"),
            NetworkPeerPolicy::new("::1/128"),
        ]),
        ports: None,
    };
    NetworkPolicy {
        egress: Some(NetworkEgressPolicy {
            default: Some(default),
            allow: restricted.then(|| vec![loopback]),
            deny: None,
        }),
        ingress: Some(NetworkIngressPolicy {
            default: Some(default),
            host_loopback: Some(if restricted {
                NetworkAction::Allow
            } else {
                default
            }),
        }),
        runtime_config: None,
    }
}

fn object(path: &Path) -> io::Result<(u64, [u8; 16])> {
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let id = crate::windows::file_identity(&file)?;
    Ok((id.VolumeSerialNumber, id.FileId.Identifier))
}

// PSEC grants apply to objects. All spellings of a junction or hardlink
// must carry the intersection of their permissions, including generated grants.
fn normalize(policy: FilesystemPolicy) -> Result<FilesystemPolicy, Error> {
    let mut entries = Vec::new();
    let mut access_by_id = HashMap::new();
    for (paths, access) in [
        (policy.readonly_paths, Access::Read),
        (policy.readwrite_paths, Access::Write),
        (policy.denied_paths, Access::Deny),
    ] {
        for path in paths {
            let id = match object(Path::new(&path)) {
                Ok(id) => {
                    access_by_id
                        .entry(id)
                        .and_modify(|a: &mut Access| *a = a.intersect(access))
                        .or_insert(access);
                    Some(id)
                }
                Err(error) if access == Access::Deny && error.kind() == io::ErrorKind::NotFound => {
                    None
                }
                Err(error) => return Err(error.into()),
            };
            entries.push((path, id, access));
        }
    }
    let mut result = FilesystemPolicy::default();
    for (path, id, access) in entries {
        match id.map_or(access, |id| access_by_id[&id]) {
            Access::Read => result.readonly_paths.push(path),
            Access::Write => result.readwrite_paths.push(path),
            Access::Deny => result.denied_paths.push(path),
        }
    }
    Ok(result)
}

fn volume_roots(cwd: &Path) -> io::Result<Vec<PathBuf>> {
    // SAFETY: GetLogicalDrives takes no arguments and returns a drive bitmask.
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut roots: Vec<_> = (0..26)
        .filter(|index| mask & (1 << index) != 0)
        .map(|index| PathBuf::from(format!("{}:\\", char::from(b'A' + index as u8))))
        .collect();
    // UNC working directories do not appear in GetLogicalDrives.
    if let Some(root) = cwd.ancestors().last()
        && !contains(&roots, root)
    {
        roots.push(root.into());
    }
    Ok(roots)
}

fn implicit_read_root(root: &Path, cwd: &Path) -> bool {
    const DRIVE_REMOTE: u32 = 4;
    let wide: Vec<_> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: the root is NUL terminated for this call.
    (unsafe { GetDriveTypeW(wide.as_ptr()) }) != DRIVE_REMOTE
        || path::within(cwd, root)
        || object(root).is_ok()
}

// PSEC volume-root grants do not recurse. Like Codex, grant their current
// immediate children as a launch snapshot; a later root-level child is ungranted.
fn expand_volume_roots(roots: Vec<PathBuf>, volumes: &[PathBuf]) -> Result<Vec<PathBuf>, Error> {
    let mut expanded = Vec::new();
    for root in roots {
        if contains(volumes, &root) {
            match fs::read_dir(&root) {
                Ok(entries) => {
                    for entry in entries {
                        let child = entry?.path();
                        if child.to_str().is_some() && object(&child).is_ok() {
                            expanded.push(child);
                        }
                    }
                }
                Err(error) if inaccessible_volume(&error) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        expanded.push(root);
    }
    expanded.sort_by(|a, b| path::compare(a, b));
    expanded.dedup_by(|a, b| path::compare(a, b).is_eq());
    Ok(expanded)
}

fn inaccessible_volume(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied
            | io::ErrorKind::NotFound
            | io::ErrorKind::NetworkUnreachable
            | io::ErrorKind::HostUnreachable
    ) || matches!(
        error.raw_os_error().map(|code| code as u32),
        Some(
            ERROR_NOT_READY
                | ERROR_DEVICE_NOT_CONNECTED
                | ERROR_BAD_NETPATH
                | ERROR_CONNECTION_UNAVAIL
        )
    )
}

fn contains(paths: &[PathBuf], path: &Path) -> bool {
    paths
        .iter()
        .any(|candidate| crate::path::compare(candidate, path).is_eq())
}

fn paths(paths: &[String]) -> Vec<PathBuf> {
    paths.iter().map(PathBuf::from).collect()
}

fn strings(paths: Vec<PathBuf>) -> Result<Vec<String>, Error> {
    paths
        .into_iter()
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|_| Error::Invalid("MXC requires Unicode filesystem paths".into()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricted_network_only_grants_loopback_peers() {
        let restricted =
            Network::destination(crate::Destination::new("example.test", 443).unwrap());
        for (network, default, loopback) in [
            (Network::Allowed, NetworkAction::Allow, NetworkAction::Allow),
            (Network::Denied, NetworkAction::Deny, NetworkAction::Deny),
            (restricted, NetworkAction::Deny, NetworkAction::Allow),
        ] {
            let policy = network_policy(&network);
            let egress = policy.egress.unwrap();
            assert_eq!(egress.default, Some(default));
            let ingress = policy.ingress.unwrap();
            assert_eq!(ingress.default, Some(default));
            assert_eq!(ingress.host_loopback, Some(loopback));
            if matches!(network, Network::Restricted { .. }) {
                assert_eq!(
                    egress.allow.unwrap(),
                    [NetworkRulePolicy {
                        to: Some(vec![
                            NetworkPeerPolicy::new("127.0.0.0/8"),
                            NetworkPeerPolicy::new("::1/128")
                        ]),
                        ports: None,
                    }]
                );
            } else {
                assert!(egress.allow.is_none());
            }
        }
    }
}
