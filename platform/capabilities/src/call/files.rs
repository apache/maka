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

//! One trusted caller-owned temporary directory; no authority or handle registry.
use super::ReadResource;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

pub struct OwnedTempDirectory {
    path: PathBuf,
    state: Mutex<State>,
}
struct State {
    owned: Option<tempfile::TempDir>,
    directory: Option<Dir>,
    open: bool,
}
impl OwnedTempDirectory {
    /// Called by an already admitted native Host/worker. The prefix is fixed
    /// implementation data; this constructor accepts no model-selected root.
    pub fn create(prefix: &str) -> Result<Self, String> {
        let owned = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .map_err(|e| e.to_string())?;
        let path = owned.path().to_owned();
        let directory = Dir::open_ambient_dir(&path, cap_std::ambient_authority())
            .map_err(|e| e.to_string())?;
        Ok(Self {
            path,
            state: Mutex::new(State {
                owned: Some(owned),
                directory: Some(directory),
                open: true,
            }),
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn is_open(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.open)
    }
    /// Blocking native I/O. Its caller must join the same future, including on
    /// cancellation; dropping it cannot acknowledge physical settlement.
    pub fn write(
        &self,
        name: &str,
        resource: &dyn ReadResource,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, String> {
        if name.is_empty()
            || name == "."
            || name == ".."
            || name
                .chars()
                .any(|c| c == '/' || c == '\\' || c.is_control())
        {
            return Err("Temporary resource file name must be one component".into());
        }
        self.write_file_name(name, resource, cancellation)
    }
    /// Preserve an actual selected file's OS basename. Upload callers hold a
    /// separate directory for each file and have already admitted its source.
    pub fn write_file_name(
        &self,
        name: &str,
        resource: &dyn ReadResource,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, String> {
        let mut components = Path::new(name).components();
        if name.contains('\0')
            || !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
        {
            return Err("Temporary selected file name must be one OS path component".into());
        }
        let state = self.state.lock().map_err(|e| e.to_string())?;
        if !state.open {
            return Err("Temporary resource directory is closed".into());
        }
        let cancelled = || {
            if cancellation.is_cancelled() {
                Err("Temporary resource write cancelled".to_owned())
            } else {
                Ok(())
            }
        };
        cancelled()?;
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let temporary = format!(".maka-resource-{}", uuid::Uuid::new_v4());
        let mut file = state
            .directory
            .as_ref()
            .ok_or("Temporary resource directory is closed")?
            .open_with(&temporary, &options)
            .map_err(|e| e.to_string())?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("Temporary resource output is not a regular file".into());
        }
        let expected = resource.bytes();
        let mut offset = 0;
        while offset < expected {
            cancelled()?;
            let end = offset.saturating_add(64 * 1024).min(expected);
            let bytes = resource.read(offset..end)?;
            if bytes.len() != end - offset {
                return Err("Immutable resource changed during temporary publication".into());
            }
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            offset = end;
        }
        if resource.bytes() != expected {
            return Err("Immutable resource length changed during temporary publication".into());
        }
        file.flush().map_err(|e| e.to_string())?;
        drop(file);
        cancelled()?;
        // Publish by renaming within the retained capability. A planted
        // symlink or hard link at the final name is replaced, never followed.
        let directory = state
            .directory
            .as_ref()
            .ok_or("Temporary resource directory is closed")?;
        directory
            .rename(&temporary, directory, name)
            .map_err(|e| e.to_string())?;
        Ok(self.path.join(name))
    }
    /// Refuse new writes first, then remove through the exact retained
    /// directory capability. A failed cleanup retains custody for retry.
    pub fn close(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.open = false;
        if let Some(directory) = &state.directory {
            directory
                .try_clone()
                .and_then(Dir::remove_open_dir_all)
                .map_err(|e| e.to_string())?;
        }
        state.directory = None;
        state.owned = None;
        Ok(())
    }
}
