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
use mxc_sdk::mxc_common::{
    filesystem_object::{
        ExistingObjectComparison, compare_existing_filesystem_objects, normalize_object_conflicts,
    },
    logger::{Logger, Mode},
    models::{
        BaseProcessUiConfig, ContainerPolicy, NetworkAction, NetworkCidr, NetworkEgressPolicy,
        NetworkIngressPolicy, NetworkPeer, NetworkRule, UiPolicy,
    },
};
use std::{
    fs, io,
    net::{Ipv4Addr, Ipv6Addr},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};
use windows_sys::Win32::Foundation::{
    ERROR_BAD_NETPATH, ERROR_CONNECTION_UNAVAIL, ERROR_DEVICE_NOT_CONNECTED, ERROR_NOT_READY,
};
use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

pub(super) fn prepare(
    filesystem: &Policy,
    network: &Network,
    cwd: &Path,
) -> Result<ContainerPolicy, Error> {
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
    Ok(with_network(policy, network))
}

fn filesystem_policy(
    filesystem: &Policy,
    volumes: &[PathBuf],
    cwd: &Path,
) -> Result<ContainerPolicy, Error> {
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
        // Native deny paths are absolute masks, whereas Maka can explicitly
        // reopen a descendant. Such a policy must use a capable backend.
        if rule.access != Access::Deny
            && filesystem.rules.iter().any(|ancestor| {
                ancestor.access == Access::Deny
                    && ancestor.scope == Scope::Subtree
                    && !path::compare(&ancestor.path, &rule.path).is_eq()
                    && path::within(&rule.path, &ancestor.path)
            })
        {
            return Err(Error::Unsupported(
                "native MXC cannot reopen a descendant of a denied path".into(),
            ));
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
    let normalized = normalize(ContainerPolicy {
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
    normalize(ContainerPolicy {
        readonly_paths: strings(read)?,
        readwrite_paths: strings(write)?,
        denied_paths: normalized.denied_paths,
        ..Default::default()
    })
}

fn with_network(mut policy: ContainerPolicy, network: &Network) -> ContainerPolicy {
    let enabled = matches!(network, Network::Allowed);
    let proxied = matches!(network, Network::Restricted { .. });
    let default = if enabled {
        NetworkAction::Allow
    } else {
        NetworkAction::Deny
    };
    let mut egress = NetworkEgressPolicy {
        default,
        ..Default::default()
    };
    if proxied {
        // Codex's managed-network contract permits local clients and servers.
        // Maka's execution-owned proxy still enforces destination host+port.
        egress.allow.push(NetworkRule {
            to: vec![
                NetworkPeer {
                    cidr: NetworkCidr {
                        address: Ipv4Addr::new(127, 0, 0, 0).into(),
                        prefix_length: 8,
                    },
                    except: Vec::new(),
                },
                NetworkPeer {
                    cidr: NetworkCidr {
                        address: Ipv6Addr::LOCALHOST.into(),
                        prefix_length: 128,
                    },
                    except: Vec::new(),
                },
            ],
            ports: Vec::new(),
        });
    }
    policy.capabilities = vec!["registryRead".into()];
    policy.network_egress = Some(egress);
    policy.network_ingress = Some(NetworkIngressPolicy {
        default,
        host_loopback: if enabled || proxied {
            NetworkAction::Allow
        } else {
            NetworkAction::Deny
        },
    });
    policy.network_specified = true;
    policy.network_mode_specified = true;
    // PowerShell DLL startup requires Win32k and desktop handles. Keep the
    // default clipboard, input-injection and system-control restrictions.
    policy.ui = UiPolicy {
        disable: false,
        ..Default::default()
    };
    policy.base_process_ui = BaseProcessUiConfig {
        isolation: "desktop".into(),
        ..Default::default()
    };
    policy
}

fn normalize(mut policy: ContainerPolicy) -> Result<ContainerPolicy, Error> {
    let mut logger = Logger::new(Mode::Buffer);
    if let Some(normalized) =
        normalize_object_conflicts(&policy, &mut logger).map_err(io::Error::other)?
    {
        policy = normalized;
    }
    Ok(policy)
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
        || compare_existing_filesystem_objects(root, root) == ExistingObjectComparison::Same
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
                        if child.to_str().is_some()
                            && compare_existing_filesystem_objects(&child, &child)
                                == ExistingObjectComparison::Same
                        {
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
    use serde_json::json;

    #[test]
    fn native_policy_keeps_permissions_without_retired_dacl_fallback() {
        for (network, egress, ingress) in [
            (
                Network::Denied,
                json!({"default":"deny","allow":[],"deny":[]}),
                json!({"default":"deny","host_loopback":"deny"}),
            ),
            (
                Network::Allowed,
                json!({"default":"allow","allow":[],"deny":[]}),
                json!({"default":"allow","host_loopback":"allow"}),
            ),
            (
                Network::destination(crate::Destination::new("example.test", 443).unwrap()),
                json!({"default":"deny","allow":[{"to":[
                    {"cidr":{"address":"127.0.0.0","prefix_length":8},"except":[]},
                    {"cidr":{"address":"::1","prefix_length":128},"except":[]}
                ],"ports":[]}],"deny":[]}),
                json!({"default":"deny","host_loopback":"allow"}),
            ),
        ] {
            let policy = with_network(
                ContainerPolicy {
                    readonly_paths: vec![r"C:\readonly".into()],
                    readwrite_paths: vec![r"C:\writable".into()],
                    denied_paths: vec![r"C:\denied".into()],
                    ..Default::default()
                },
                &network,
            );
            assert!(policy.network_specified && policy.network_mode_specified);
            let wire = serde_json::to_value(policy).unwrap();
            assert_eq!(wire["network_egress"], egress);
            assert_eq!(wire["network_ingress"], ingress);
            assert_eq!(wire["readonly_paths"], json!([r"C:\readonly"]));
            assert_eq!(wire["readwrite_paths"], json!([r"C:\writable"]));
            assert_eq!(wire["denied_paths"], json!([r"C:\denied"]));
            assert_eq!(wire["capabilities"], json!(["registryRead"]));
            assert_eq!(
                wire["ui"],
                json!({"disable":false,"clipboard":"none","injection":false})
            );
            assert_eq!(
                wire["base_process_ui"],
                json!({"isolation":"desktop","desktopSystemControl":false,"systemSettings":"none","ime":false})
            );
            assert!(wire.get("fallback").is_none());
        }
    }
}
