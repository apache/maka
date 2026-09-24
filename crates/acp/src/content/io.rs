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

use super::{active, artifact};
use std::{io::Read, path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) async fn read(
    path: PathBuf,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, crate::Error> {
    let worker_cancel = cancel.child_token();
    let worker_guard = worker_cancel.clone().drop_guard();
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Prompt cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(30), tokio::task::spawn_blocking(move || read_file(path, worker_cancel))) => {
            result.map_err(|_| "Resource read timed out")??
        }
    };
    drop(worker_guard);
    result
}

fn read_file(path: PathBuf, cancel: CancellationToken) -> Result<Vec<u8>, crate::Error> {
    active(&cancel)?;
    if !path.is_absolute()
        || path
            .to_str()
            .is_none_or(|s| s.len() > 4096 || s.chars().any(char::is_control))
    {
        return Err("Invalid local resource path".into());
    }
    let before = std::fs::symlink_metadata(&path)?;
    if !before.is_file() {
        return Err("Resource must be a regular file, not a symlink".into());
    }
    if before.len() > artifact::MAX_ATTACHMENT_BYTES {
        return Err("Resource exceeds byte limit".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = options.open(&path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.len() > artifact::MAX_ATTACHMENT_BYTES {
        return Err("Invalid local resource file".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Err("Resource is a reparse point".into());
        }
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    let mut buffer = [0; 64 * 1024];
    loop {
        active(&cancel)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > artifact::MAX_ATTACHMENT_BYTES as usize {
            return Err("Resource exceeds byte limit".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    let after = file.metadata()?;
    if after.len() != opened.len()
        || bytes.len() as u64 != opened.len()
        || after.modified().ok() != opened.modified().ok()
    {
        return Err("Resource changed while reading".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn regular_file_and_cancelled_read() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"context").unwrap();
        let token = CancellationToken::new();
        assert_eq!(read(file.path().into(), &token).await.unwrap(), b"context");
        token.cancel();
        assert!(read(file.path().into(), &token).await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_fifo_and_symlink_without_blocking() {
        use std::{ffi::CString, os::unix::fs::symlink};
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        let name = CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let link = dir.path().join("link");
        symlink(&fifo, &link).unwrap();
        let token = CancellationToken::new();
        assert!(read(fifo, &token).await.is_err());
        assert!(read(link, &token).await.is_err());
    }
}
