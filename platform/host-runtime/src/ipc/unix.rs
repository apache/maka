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

use super::Error;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use tokio::net::{UnixListener, UnixStream};

/// Refuses to overwrite an existing socket. Its owner cleans up only its own
/// inode after all connections have drained.
pub struct LocalListener {
    listener: UnixListener,
    path: PathBuf,
    identity: (u64, u64),
}

impl LocalListener {
    pub fn bind(path: &Path) -> Result<Self, Error> {
        // Socket mode is not an atomic bind option: the enclosing directory
        // must already exclude other accounts before the socket exists.
        let parent = path
            .parent()
            .ok_or("socket parent directory required")?
            .canonicalize()?;
        let directory = parent.metadata()?;
        if directory.uid() != unsafe { libc::geteuid() } || directory.mode() & 0o077 != 0 {
            return Err("socket parent must be a private current-account directory".into());
        }
        let path = parent.join(path.file_name().ok_or("socket filename required")?);
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let meta = path.symlink_metadata()?;
        Ok(Self {
            listener,
            path,
            identity: (meta.dev(), meta.ino()),
        })
    }

    pub async fn accept(&mut self) -> std::io::Result<UnixStream> {
        self.listener.accept().await.map(|(socket, _)| socket)
    }
}

impl Drop for LocalListener {
    fn drop(&mut self) {
        if self
            .path
            .symlink_metadata()
            .is_ok_and(|m| (m.dev(), m.ino()) == self.identity)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Connect only to the private endpoint selected by the trusted embedding.
pub async fn connect(path: &Path) -> Result<UnixStream, Error> {
    let stream = UnixStream::connect(path).await?;
    if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "IPC peer must belong to the current account",
        )
        .into());
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn private_socket_keeps_readable_terminal_after_write_eof_and_owns_only_its_inode() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let path = directory.path().join("ipc.sock");
        let mut listener = LocalListener::bind(&path).unwrap();
        assert_eq!(path.symlink_metadata().unwrap().mode() & 0o777, 0o600);
        assert!(LocalListener::bind(&path).is_err());
        let mut waiting = Box::pin(listener.accept());
        assert!(futures_util::poll!(&mut waiting).is_pending());
        drop(waiting);
        let mut client = connect(&path).await.unwrap();
        let mut server = listener.accept().await.unwrap();
        client.write_all("私有".as_bytes()).await.unwrap();
        client.shutdown().await.unwrap();
        let mut input = Vec::new();
        server.read_to_end(&mut input).await.unwrap();
        assert_eq!(input, "私有".as_bytes());
        server.write_all(b"terminal").await.unwrap();
        server.flush().await.unwrap();
        let mut terminal = [0; 8];
        client.read_exact(&mut terminal).await.unwrap();
        assert_eq!(&terminal, b"terminal");
        drop(client);
        drop(server);
        // A pathname replacement belongs to someone else, even in this private
        // test directory. The original listener cannot unlink the replacement.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        drop(listener);
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    }
    #[tokio::test]
    async fn public_socket_parent_is_rejected_before_any_endpoint_is_created() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = directory.path().join("ipc.sock");
        assert!(LocalListener::bind(&path).is_err());
        assert!(!path.exists());
    }
}
