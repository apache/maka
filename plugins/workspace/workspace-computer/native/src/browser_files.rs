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

//! Host Session lifetime for owned temporary immutable resource outputs.
use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::{OwnedTempDirectory, ReadResource};
use maka_computer_use::{BrowserAssetDirectory, BrowserAssetFiles, FilesFuture};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
type Result<T> = std::result::Result<T, ToolError>;
fn failed(message: impl ToString) -> ToolError {
    ToolError::Failed(message.to_string())
}
fn cancelled(token: &CancellationToken) -> Result<()> {
    if token.is_cancelled() {
        Err(failed("Page asset file publication cancelled"))
    } else {
        Ok(())
    }
}
fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
}
#[derive(Clone)]
pub struct SessionFiles {
    state: Arc<Mutex<State>>,
}
struct State {
    open: bool,
    directories: Vec<Arc<OwnedTempDirectory>>,
}
impl Default for SessionFiles {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                open: true,
                directories: Vec::new(),
            })),
        }
    }
}
impl SessionFiles {
    /// Existing Host Epoch teardown calls this only after native effects settle.
    pub async fn close(&self) -> Result<()> {
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = state.lock().map_err(failed)?;
            state.open = false;
            while let Some(directory) = state.directories.last() {
                directory.close().map_err(|e| {
                    ToolError::CleanupUnconfirmed(format!(
                        "Page asset directory cleanup failed: {e}"
                    ))
                })?;
                state.directories.pop();
            }
            Ok(())
        })
        .await
        .map_err(failed)?
    }
}
impl BrowserAssetFiles for SessionFiles {
    fn snapshot(&self, name: String, bytes: Vec<u8>) -> Result<Arc<dyn ReadResource>> {
        if !name_valid(&name) {
            return Err(failed("Asset bundle file name must be one path component"));
        }
        Ok(maka_capabilities::call::immutable_bytes(name, bytes))
    }
    fn begin(
        &self,
        cancellation: CancellationToken,
    ) -> FilesFuture<Box<dyn BrowserAssetDirectory>> {
        let state = self.state.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut retained = state.lock().map_err(failed)?;
                cancelled(&cancellation)?;
                if !retained.open {
                    return Err(failed("Page asset file Session is closed"));
                }
                let native =
                    Arc::new(OwnedTempDirectory::create("maka-browser-assets-").map_err(failed)?);
                let path = native
                    .path()
                    .to_str()
                    .ok_or_else(|| failed("Page asset directory path is not UTF-8"))?
                    .to_owned();
                retained.directories.push(native.clone());
                Ok(Box::new(Directory {
                    path,
                    native,
                    state: state.clone(),
                }) as Box<dyn BrowserAssetDirectory>)
            })
            .await
            .map_err(failed)?
        })
    }
}
struct Directory {
    path: String,
    native: Arc<OwnedTempDirectory>,
    state: Arc<Mutex<State>>,
}
impl BrowserAssetDirectory for Directory {
    fn path(&self) -> &str {
        &self.path
    }
    fn write(
        &mut self,
        name: String,
        resource: Arc<dyn ReadResource>,
        cancellation: CancellationToken,
    ) -> FilesFuture<String> {
        let state = self.state.clone();
        let native = self.native.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let retained = state.lock().map_err(failed)?;
                cancelled(&cancellation)?;
                if !retained.open
                    || !retained
                        .directories
                        .iter()
                        .any(|current| Arc::ptr_eq(current, &native))
                {
                    return Err(failed("Page asset directory is closed"));
                }
                native
                    .write(&name, resource.as_ref(), &cancellation)
                    .map_err(failed)?
                    .to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| failed("Page asset file path is not UTF-8"))
            })
            .await
            .map_err(failed)?
        })
    }
    fn commit(&mut self, cancellation: CancellationToken) -> FilesFuture<()> {
        let state = self.state.clone();
        let native = self.native.clone();
        Box::pin(async move {
            cancelled(&cancellation)?;
            let retained = state.lock().map_err(failed)?;
            if !retained.open
                || !native.is_open()
                || !retained
                    .directories
                    .iter()
                    .any(|current| Arc::ptr_eq(current, &native))
            {
                return Err(failed("Page asset directory is closed"));
            }
            Ok(())
        })
    }
    fn abort(&mut self) -> FilesFuture<()> {
        let state = self.state.clone();
        let native = self.native.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut retained = state.lock().map_err(failed)?;
                if let Some(index) = retained
                    .directories
                    .iter()
                    .position(|current| Arc::ptr_eq(current, &native))
                {
                    native.close().map_err(|e| {
                        ToolError::CleanupUnconfirmed(format!(
                            "Page asset directory cleanup failed: {e}"
                        ))
                    })?;
                    retained.directories.swap_remove(index);
                }
                Ok(())
            })
            .await
            .map_err(failed)?
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    #[tokio::test]
    async fn real_files_preserve_multichunk_bytes_and_end_with_their_session() {
        let files = SessionFiles::default();
        let mut directory = files.begin(CancellationToken::new()).await.unwrap();
        let root = PathBuf::from(directory.path());
        let bytes = (0..150_001).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let resource = files.snapshot("asset.bin".into(), bytes.clone()).unwrap();
        let path = directory
            .write("asset.bin".into(), resource, CancellationToken::new())
            .await
            .unwrap();
        directory.commit(CancellationToken::new()).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        files.close().await.unwrap();
        assert!(!root.exists());
        assert!(
            directory
                .write(
                    "late".into(),
                    files.snapshot("late".into(), vec![]).unwrap(),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(files.begin(CancellationToken::new()).await.is_err());
        files.close().await.unwrap();
    }
    #[tokio::test]
    async fn traversal_and_abort_cannot_escape_or_outlive_owned_directory() {
        let files = SessionFiles::default();
        let mut directory = files.begin(CancellationToken::new()).await.unwrap();
        let root = PathBuf::from(directory.path());
        assert!(files.snapshot("../outside".into(), vec![1]).is_err());
        assert!(
            directory
                .write(
                    "../outside".into(),
                    files.snapshot("safe".into(), vec![1]).unwrap(),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        directory.abort().await.unwrap();
        assert!(!root.exists());
        files.close().await.unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn injected_symlink_is_never_followed_by_asset_write() {
        let files = SessionFiles::default();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("sentinel");
        std::fs::write(&sentinel, b"untouched").unwrap();
        let mut directory = files.begin(CancellationToken::new()).await.unwrap();
        std::os::unix::fs::symlink(&sentinel, PathBuf::from(directory.path()).join("asset"))
            .unwrap();
        let published = directory
            .write(
                "asset".into(),
                files.snapshot("asset".into(), b"changed".to_vec()).unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read(published).unwrap(), b"changed");
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"untouched");
        directory.abort().await.unwrap();
        files.close().await.unwrap();
    }
}
