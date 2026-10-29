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

use crate::{BinaryFileMetadata, ReadOutput, ReadScope, failed};
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use cap_std::{
    ambient_authority,
    fs::{Dir, File, OpenOptions},
};
use maka_agent_facts::read::ReadRequest;
use maka_agent_facts::tools::ToolError;
use maka_sandbox::filesystem::Compiled;
use std::sync::Arc;
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

mod directory;
mod path;
pub(crate) use directory::Directory;

struct Root {
    path: PathBuf,
    aliases: Vec<PathBuf>,
    dir: Dir,
}

pub(crate) struct Authority {
    cwd: PathBuf,
    scope: CapturedScope,
    policy: Option<Arc<Compiled>>,
}

pub(crate) struct Route {
    pub root: Directory,
    pub relative: PathBuf,
    pub root_path: PathBuf,
}

enum CapturedScope {
    Restricted(Vec<Root>),
    Workspace(Root),
    Unrestricted,
}

impl Authority {
    pub(crate) fn from_directory(
        path: PathBuf,
        dir: Dir,
        policy: Option<Arc<Compiled>>,
    ) -> Result<Self, ToolError> {
        if !path.is_absolute() {
            return Err(failed("Captured directory location must be absolute"));
        }
        let root = Root {
            aliases: vec![path.clone()],
            path: path.clone(),
            dir,
        };
        let scope = if policy.is_some() {
            CapturedScope::Workspace(root)
        } else {
            CapturedScope::Restricted(vec![root])
        };
        Ok(Self {
            cwd: path.clone(),
            policy,
            scope,
        })
    }
    pub(crate) fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub(crate) fn write_display_path(&self, path: &Path) -> Result<String, ToolError> {
        let absolute = path::resolve(&self.cwd, path)?;
        let normalized: PathBuf = absolute.components().collect();
        dunce::simplified(&normalized)
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| failed("Write path must be UTF-8"))
    }

    pub(crate) fn routes(&self, path: &Path) -> Result<Vec<Route>, ToolError> {
        self.routes_for(path, false)
    }

    pub(crate) fn read_routes(&self, path: &Path) -> Result<Vec<Route>, ToolError> {
        self.routes_for(path, true)
    }

    fn routes_for(&self, path: &Path, read: bool) -> Result<Vec<Route>, ToolError> {
        let mut absolute = path::resolve(&self.cwd, path)?;
        if let CapturedScope::Workspace(root) = &self.scope {
            // Ordinary workspace operations retain the selected directory even
            // across a rename. External paths are admitted by the same policy.
            if let Ok(relative) = absolute.strip_prefix(&root.path) {
                let parent = relative
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."));
                if root.dir.canonicalize(relative).is_ok()
                    || (root
                        .dir
                        .symlink_metadata(relative)
                        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                        && root.dir.canonicalize(parent).is_ok())
                {
                    return Ok(vec![Route {
                        root: Directory::new(
                            root.dir.try_clone().map_err(io_error)?,
                            root.path.clone(),
                            self.policy.clone(),
                        ),
                        relative: relative.to_owned(),
                        root_path: root.path.clone(),
                    }]);
                }
            }
            // A fallback through the host namespace must never follow a
            // replacement of the selected workspace after an approval wait.
            use cap_fs_ext::MetadataExt;
            let observed = Dir::open_ambient_dir(&root.path, ambient_authority())
                .and_then(|dir| dir.dir_metadata())
                .map_err(io_error)?;
            let held = root.dir.dir_metadata().map_err(io_error)?;
            if (observed.dev(), observed.ino()) != (held.dev(), held.ino()) {
                return Err(failed(
                    "Selected workspace changed during file authorization",
                ));
            }
        }
        match &self.scope {
            CapturedScope::Unrestricted | CapturedScope::Workspace(_) => {
                if let Some(policy) = &self.policy {
                    if read {
                        let normalized: PathBuf = absolute.components().collect();
                        if !absolute.components().any(|c| c == Component::ParentDir)
                            && !policy.access(dunce::simplified(&normalized)).can_read()
                        {
                            return Err(failed("filesystem policy denies Read access"));
                        }
                        // Host-root capabilities reject absolute symlinks too.
                        // Resolve the spelling, then authorize and open the
                        // resolved path without following links again.
                        absolute = absolute.canonicalize().map_err(io_error)?;
                    } else if matches!(self.scope, CapturedScope::Workspace(_)) {
                        if absolute.components().any(|c| c == Component::ParentDir) {
                            return Err(failed(
                                "Write does not support parent (..) path components",
                            ));
                        }
                        let name = absolute
                            .file_name()
                            .ok_or_else(|| failed("Write requires a file name"))?;
                        absolute = absolute
                            .parent()
                            .ok_or_else(|| failed("Write requires a parent directory"))?
                            .canonicalize()
                            .map_err(io_error)?
                            .join(name);
                    }
                }
                let root = absolute
                    .ancestors()
                    .last()
                    .ok_or_else(|| failed("absolute path required"))?;
                Ok(vec![Route {
                    root: Directory::new(
                        Dir::open_ambient_dir(root, ambient_authority()).map_err(io_error)?,
                        root.to_owned(),
                        self.policy.clone(),
                    ),
                    relative: absolute
                        .strip_prefix(root)
                        .map_err(|_| failed("invalid Write path"))?
                        .to_owned(),
                    root_path: root.to_owned(),
                }])
            }
            CapturedScope::Restricted(roots) => path::candidates(roots, &absolute)
                .into_iter()
                .map(|(root, relative, _)| {
                    Ok(Route {
                        root: Directory::new(
                            root.dir.try_clone().map_err(io_error)?,
                            root.path.clone(),
                            self.policy.clone(),
                        ),
                        relative: relative.to_owned(),
                        root_path: root.path.clone(),
                    })
                })
                .collect(),
        }
    }

    pub(crate) fn new(cwd: &Path, scope: ReadScope) -> Result<Self, ToolError> {
        if !cwd.is_absolute() {
            return Err(failed("Session cwd must be absolute"));
        }
        let cwd = cwd.canonicalize().map_err(io_error)?;
        if !cwd.is_dir() {
            return Err(failed("Session cwd must be a directory"));
        }
        let paths = match scope {
            ReadScope::Policy(policy) => {
                return Ok(Self {
                    cwd,
                    scope: CapturedScope::Unrestricted,
                    policy: Some(policy),
                });
            }
            ReadScope::Restricted { roots } => roots,
            ReadScope::Unrestricted => {
                return Ok(Self {
                    cwd,
                    scope: CapturedScope::Unrestricted,
                    policy: None,
                });
            }
        };
        if paths.is_empty() {
            return Err(failed("Read requires an admitted root"));
        }
        let mut roots: Vec<Root> = Vec::new();
        for path in paths {
            if !path.is_absolute() {
                return Err(failed("Read roots must be absolute"));
            }
            let canonical = path.canonicalize().map_err(io_error)?;
            if let Some(root) = roots.iter_mut().find(|root| root.path == canonical) {
                if !root.aliases.contains(&path) {
                    root.aliases.push(path);
                }
                continue;
            }
            let dir = Dir::open_ambient_dir(&canonical, ambient_authority()).map_err(io_error)?;
            let mut aliases = vec![canonical.clone()];
            if path != canonical {
                aliases.push(path);
            }
            roots.push(Root {
                path: canonical,
                aliases,
                dir,
            });
        }
        Ok(Self {
            cwd,
            scope: CapturedScope::Restricted(roots),
            policy: None,
        })
    }

    fn open(&self, absolute: &Path) -> Result<File, ToolError> {
        if self.policy.is_some() {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            options.custom_flags(libc::O_NONBLOCK);
            let mut error = failed("path is outside the admitted Read roots");
            for route in self.read_routes(absolute)? {
                match route.root.open_with(&route.relative, &options) {
                    Ok(file) => return Ok(file),
                    Err(reason) => error = io_error(reason),
                }
            }
            return Err(error);
        }
        let roots = match &self.scope {
            CapturedScope::Restricted(roots) => roots,
            CapturedScope::Workspace(_) => unreachable!("workspace always has a policy"),
            CapturedScope::Unrestricted => {
                let mut options = std::fs::OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NONBLOCK);
                }
                return options.open(absolute).map(File::from_std).map_err(io_error);
            }
        };
        let mut options = OpenOptions::new();
        options.read(true);
        // A FIFO must not block before we can inspect the opened file type.
        #[cfg(unix)]
        options.custom_flags(libc::O_NONBLOCK);
        let mut error = failed("path is outside the admitted Read roots");
        for (root, relative, _) in path::candidates(roots, absolute) {
            if relative
                .components()
                .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
            {
                return Err(failed("invalid relative Read path"));
            }
            match root.dir.open_with(relative, &options) {
                Ok(file) => return Ok(file),
                Err(reason) => error = io_error(reason),
            }
        }
        Err(error)
    }

    pub(crate) fn binary_metadata(
        &self,
        path: String,
        cancellation: CancellationToken,
    ) -> Result<BinaryFileMetadata, ToolError> {
        check_cancelled(&cancellation)?;
        let absolute = path::resolve(&self.cwd, Path::new(&path))?;
        let file = self.open(&absolute)?;
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() {
            return Err(failed("Read supports only regular files"));
        }
        let name = absolute
            .file_name()
            .ok_or_else(|| failed("Binary Read requires a file name"))?
            .to_string_lossy()
            .into_owned();
        check_cancelled(&cancellation)?;
        Ok(BinaryFileMetadata {
            name,
            bytes: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .map(cap_std::time::SystemTime::into_std),
        })
    }

    pub(crate) fn copy_binary<W, F>(
        &self,
        path: String,
        create: F,
        cancellation: CancellationToken,
    ) -> Result<W, ToolError>
    where
        W: Write,
        F: FnOnce(BinaryFileMetadata) -> Result<W, ToolError>,
    {
        check_cancelled(&cancellation)?;
        let absolute = path::resolve(&self.cwd, Path::new(&path))?;
        let mut file = self.open(&absolute)?;
        let before = file.metadata().map_err(io_error)?;
        if !before.is_file() {
            return Err(failed("Read supports only regular files"));
        }
        let name = absolute
            .file_name()
            .ok_or_else(|| failed("Binary Read requires a file name"))?
            .to_string_lossy()
            .into_owned();
        check_cancelled(&cancellation)?;
        let mut writer = create(BinaryFileMetadata {
            name,
            bytes: before.len(),
            modified: before
                .modified()
                .ok()
                .map(cap_std::time::SystemTime::into_std),
        })?;
        let mut copied = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            check_cancelled(&cancellation)?;
            let count = file.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            copied = copied
                .checked_add(count as u64)
                .filter(|&length| length <= before.len())
                .ok_or_else(|| failed("Read file changed during binary copy"))?;
            check_cancelled(&cancellation)?;
            writer.write_all(&buffer[..count]).map_err(io_error)?;
        }
        check_cancelled(&cancellation)?;
        let after = file.metadata().map_err(io_error)?;
        if copied != before.len()
            || after.len() != before.len()
            || after.modified().ok() != before.modified().ok()
        {
            return Err(failed("Read file changed during binary copy"));
        }
        check_cancelled(&cancellation)?;
        Ok(writer)
    }

    pub(crate) fn read(
        &self,
        input: ReadRequest,
        page_budget: usize,
        cancellation: CancellationToken,
    ) -> Result<ReadOutput, ToolError> {
        check_cancelled(&cancellation)?;
        let path = Path::new(input.path());
        // Dispatch on the requested extension, including symlink aliases. Never
        // reopen the resolved pathname outside the captured directory capability.
        let image = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                ["png", "jpg", "jpeg", "gif", "webp"]
                    .iter()
                    .any(|known| ext.eq_ignore_ascii_case(known))
            });
        // Keep parent components intact for capability resolution, so symlink/..
        // semantics cannot be changed by a lexical normalization.
        let absolute = path::resolve(&self.cwd, path)?;
        let mut file = self.open(&absolute)?;
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() {
            return Err(failed("Read supports only regular files"));
        }
        if image {
            let mut bytes = Vec::new();
            let mut chunk = [0_u8; 8192];
            loop {
                check_cancelled(&cancellation)?;
                let count = file.read(&mut chunk).map_err(io_error)?;
                if count == 0 {
                    break;
                }
                bytes
                    .try_reserve(count)
                    .map_err(|error| failed(error.to_string()))?;
                bytes.extend_from_slice(&chunk[..count]);
            }
            check_cancelled(&cancellation)?;
            let mime_type = crate::image::validate(&bytes)?;
            check_cancelled(&cancellation)?;
            return Ok(ReadOutput::Image {
                bytes,
                mime_type: mime_type.into(),
            });
        }
        let page = text_page(&mut file, &input, page_budget, &cancellation)?;
        check_cancelled(&cancellation)?;
        Ok(ReadOutput::Text(page))
    }
}

fn text_page(
    file: &mut impl Read,
    input: &ReadRequest,
    page_budget: usize,
    cancellation: &CancellationToken,
) -> Result<maka_agent_facts::read::ReadPage, ToolError> {
    let mut scan = input.scan_with_budget(page_budget);
    let mut buffer = [0_u8; 8192 + 3];
    let mut carry = 0;
    let mut binary = false;
    loop {
        check_cancelled(cancellation)?;
        let count = file
            .read(&mut buffer[carry..carry + 8192])
            .map_err(io_error)?;
        if count == 0 {
            break;
        }
        let length = carry + count;
        let text = match std::str::from_utf8(&buffer[..length]) {
            Ok(text) => text,
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&buffer[..error.valid_up_to()]).expect("validated UTF-8 prefix")
            }
            Err(_) => return Err(failed("Read requires UTF-8 text")),
        };
        let valid = text.len();
        binary |= text.contains('\0');
        scan.push(text);
        carry = length - valid;
        buffer.copy_within(valid..length, 0);
    }
    check_cancelled(cancellation)?;
    if carry != 0 {
        return Err(failed("Read requires UTF-8 text"));
    }
    if binary {
        return Err(failed("Read does not support binary files"));
    }
    scan.finish().map_err(|error| failed(error.to_string()))
}

fn check_cancelled(token: &CancellationToken) -> Result<(), ToolError> {
    if token.is_cancelled() {
        Err(failed("Read cancelled"))
    } else {
        Ok(())
    }
}

fn io_error(error: std::io::Error) -> ToolError {
    ToolError::Io {
        kind: error.kind(),
        message: format!("Read filesystem error: {error}"),
    }
}

#[cfg(test)]
mod tests;
