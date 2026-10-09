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

//! Small files in the client's config directory: read them back whole, and
//! replace them so a reader never sees half a write. Both run on async-fs's
//! blocking pool, never on the UI thread.

use std::io;
use std::path::{Path, PathBuf};

/// The contents of the regular file at `path`, or `None` when it is missing,
/// is not a regular file, or is larger than `max_bytes` (then it is not
/// ours; the caller treats it as no value rather than stopping on it).
pub async fn read_config_file(path: &Path, max_bytes: u64) -> io::Result<Option<Vec<u8>>> {
    let metadata = match async_fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() > max_bytes {
        log::warn!("ignoring {}: not a small regular file", path.display());
        return Ok(None);
    }
    async_fs::read(path).await.map(Some)
}

/// Replaces the file at `path` with `contents`: writes a temporary file
/// beside it (creating the directory, owner-only, when missing) and renames
/// it over the target.
pub async fn write_config_file(path: PathBuf, contents: Vec<u8>) -> io::Result<()> {
    use futures_lite::AsyncWriteExt as _;

    let directory = path.parent().unwrap_or(Path::new(".")).to_owned();
    let mut builder = async_fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use async_fs::unix::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(&directory).await?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let temporary = directory.join(format!(".{name}-{}.tmp", unique_suffix()));
    let written = async {
        let mut file = async_fs::File::create(&temporary).await?;
        file.write_all(&contents).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        async_fs::rename(&temporary, &path).await
    }
    .await;
    if written.is_err() {
        let _ = async_fs::remove_file(&temporary).await;
    }
    written
}

/// Distinguishes this process's temporary files from another's.
pub(crate) fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

/// The file `name` in the client's config directory, beside
/// `client-instance-id` (on macOS `~/Library/Application Support/maka-gpui/<name>`).
pub fn client_config_file(name: &str) -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(host_client::CLIENT_CONFIG_DIRECTORY).join(name))
}
