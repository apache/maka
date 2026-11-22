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
    filesystem::{Access, Compiled, Scope},
    launch::Launch,
};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs::{File, OpenOptions},
    io::{self, Seek, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::OpenOptionsExt,
    },
    path::{Path, PathBuf},
};

mod filter;
pub(crate) mod mounts;

pub(crate) fn prepare(
    policy: &Compiled,
    network: &Network,
    cwd: &Path,
    directory: Option<&File>,
) -> Result<Launch, Error> {
    if !Path::new("/usr/bin/bwrap").is_file() {
        return Err(Error::Unsupported(
            "install bubblewrap 0.11 or newer at /usr/bin/bwrap".into(),
        ));
    }
    let policy = policy.process_snapshot()?.compile()?;
    let mut registry = mounts::Registry::open(cwd)?;
    let (mut args, mut files) = match arguments(&policy, network, &mut registry, cwd, directory) {
        Ok(prepared) => prepared,
        Err(error) => {
            registry
                .abort()
                .map_err(|error| Error::CleanupUnconfirmed(error.to_string()))?;
            return Err(error);
        }
    };
    let (lease, sync) = registry.finish()?;
    args.extend(["--sync-fd".into(), sync.as_raw_fd().to_string().into()]);
    files.push(sync);
    args.extend(["--chdir".into(), cwd.as_os_str().to_owned(), "--".into()]);
    Ok(Launch::Wrapped {
        program: "/usr/bin/bwrap".into(),
        args,
        files,
        lease,
    })
}

fn arguments(
    policy: &Compiled,
    network: &Network,
    registry: &mut mounts::Registry,
    cwd: &Path,
    directory: Option<&File>,
) -> Result<(Vec<OsString>, Vec<File>), Error> {
    let registry_roots = registry.roots().to_owned();
    let mut points = BTreeSet::from([PathBuf::from("/")]);
    for rule in &policy.policy().rules {
        if rule.scope == Scope::Exact && rule.path.is_dir() {
            return Err(Error::Unsupported(
                "exact directory permissions require a subtree policy on Linux".into(),
            ));
        }
        points.extend(rule.path.ancestors().map(Path::to_owned));
    }
    if directory.is_some() {
        points.extend(cwd.ancestors().map(Path::to_owned));
    }
    for root in &registry_roots {
        points.extend(root.ancestors().map(Path::to_owned));
    }
    let mut args: Vec<OsString> = [
        "--unshare-user",
        "--disable-userns",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--cap-drop",
        "ALL",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    if network != &Network::Allowed {
        args.push("--unshare-net".into());
    }
    let mut files = Vec::new();
    let mut readonly = Vec::new();
    for path in points {
        // Every policy boundary and ancestor is a mount point. This pins both
        // source identity and rename boundaries, including nested reopenings.
        let access = if registry_roots.contains(&path) {
            Access::Deny
        } else {
            policy.access(&path)
        };
        let file = match pin(&path) {
            Ok(file) => {
                registry.retain(&path)?;
                file
            }
            Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                let rule = policy.policy().rules.iter().find(|rule| rule.path == path);
                // Ancestors of a protected boundary are temporary directories,
                // retained by the same durable lease as the leaf. A requested
                // writable root is different: removing an empty output after
                // execution could erase the very result the caller asked for.
                if rule.is_some_and(|rule| rule.access == Access::Write) {
                    return Err(Error::Unsupported(format!(
                        "writable path {} does not exist; request write access to an existing parent and create the path inside the sandbox",
                        path.display()
                    )));
                }
                registry.create(&path, rule.is_none_or(|rule| rule.scope == Scope::Subtree))?;
                pin(&path)?
            }
            Err(error) => return Err(error),
        };
        let file = if path == cwd
            && let Some(captured) = directory
        {
            use std::os::unix::fs::MetadataExt;
            let expected = captured.metadata()?;
            let visible = file.metadata()?;
            if (expected.dev(), expected.ino()) != (visible.dev(), visible.ino()) {
                return Err(Error::Invalid("captured cwd identity changed".into()));
            }
            above_stdio(captured.try_clone()?)?
        } else {
            file
        };
        let metadata = file.metadata()?;
        if !(metadata.is_dir() || metadata.is_file()) {
            return Err(Error::Unsupported(
                "only regular files and directories can be granted".into(),
            ));
        }
        if access == Access::Deny {
            if metadata.is_dir() {
                args.extend([
                    "--perms".into(),
                    "0111".into(),
                    "--tmpfs".into(),
                    path.clone().into_os_string(),
                ]);
                // Allow traversal to explicitly reopened descendants, but no
                // listing, writes or access to hidden Host directory contents.
                readonly.push(path);
            } else {
                let empty = sealed(&[])?;
                args.extend([
                    "--perms".into(),
                    "0000".into(),
                    "--ro-bind-data".into(),
                    empty.as_raw_fd().to_string().into(),
                    path.into_os_string(),
                ]);
                files.push(empty);
            }
        } else {
            let flag = if access == Access::Write {
                "--bind-fd"
            } else {
                "--ro-bind-fd"
            };
            args.extend([
                flag.into(),
                file.as_raw_fd().to_string().into(),
                path.into_os_string(),
            ]);
            files.push(file);
        }
    }
    if policy.access(Path::new("/")) == Access::Deny {
        // Loader aliases grant no target access; explicit target mounts decide.
        for path in ["/bin", "/sbin", "/lib", "/lib64"] {
            if let Ok(target) = std::fs::read_link(path) {
                args.extend(["--symlink".into(), target.into_os_string(), path.into()]);
            }
        }
    }
    // Never expose host process handles, devices or WSL's duplicate distro root.
    // These runtime mounts remain private even under a broad filesystem grant.
    args.extend(
        ["--dev", "/dev", "--proc", "/proc"]
            .into_iter()
            .map(Into::into),
    );
    for path in ["/sys", "/run/WSL", "/mnt/wslg/distro"] {
        if Path::new(path).exists() {
            args.extend([
                "--perms".into(),
                "0000".into(),
                "--tmpfs".into(),
                path.into(),
                "--remount-ro".into(),
                path.into(),
            ]);
        }
    }
    // Include runtime mount targets before freezing synthetic ancestors.
    // Nonrecursive remount keeps explicitly reopened children writable.
    for path in readonly.into_iter().rev() {
        args.extend(["--remount-ro".into(), path.into_os_string()]);
    }
    let filter = sealed(&filter::compile(network)?)?;
    args.extend(["--seccomp".into(), filter.as_raw_fd().to_string().into()]);
    files.push(filter);
    Ok((args, files))
}

/// Pin a materialized source. Symlink swaps must not redirect a mount to another
/// grant; /proc exposes the kernel's name for the opened inode, not our input.
fn pin(path: &Path) -> Result<File, Error> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let file = above_stdio(file)?;
    if std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))? != path {
        return Err(Error::Invalid(format!(
            "sandbox path must be materialized: {}",
            path.display()
        )));
    }
    Ok(file)
}

fn above_stdio(file: File) -> io::Result<File> {
    if file.as_raw_fd() > 2 {
        return Ok(file);
    }
    // SAFETY: file is live; duplication allocates a fresh CLOEXEC descriptor.
    let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd was freshly allocated and has one owner.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn sealed(bytes: &[u8]) -> io::Result<File> {
    // SAFETY: valid terminated name; no pointers are retained.
    let fd = unsafe {
        libc::memfd_create(
            c"maka-sandbox".as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fresh descriptor transferred to its sole owner.
    let mut file = above_stdio(unsafe { File::from_raw_fd(fd) })?;
    file.write_all(bytes)?;
    file.rewind()?;
    let seals = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    // SAFETY: owned memfd, adding immutable seals.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}
