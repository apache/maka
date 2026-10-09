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

//! One bot sidecar per State Root, across every process of this client.
//!
//! Two sidecars on one State Root would poll the same bot tokens and answer
//! every message twice. The supervisor holds an exclusive advisory lock on
//! `<config>/maka-gpui/bots/<rootId>.lock` for as long as it runs; the
//! operating system drops it when the process ends, however it ends. The lock
//! is per open file, so a second window of the same process is refused too.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

/// The directory under the client's config directory that holds the locks.
const LOCK_DIRECTORY: &str = "bots";

/// The default lock directory (on macOS
/// `~/Library/Application Support/maka-gpui/bots`).
pub fn default_lock_directory() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(host_client::CLIENT_CONFIG_DIRECTORY).join(LOCK_DIRECTORY))
}

/// Held while this process runs the State Root's bot sidecar.
#[derive(Debug)]
pub struct InstanceLock {
    path: PathBuf,
    _file: File,
}

#[derive(Debug, Error)]
#[non_exhaustive]
pub enum InstanceLockError {
    /// Another window or another instance of this client runs the bots of
    /// this State Root.
    #[error("the chat bots of this State Root already run in another window or client")]
    Held { path: PathBuf },
    #[error("failed to lock {}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl InstanceLock {
    /// Takes the lock for `root_id` in `directory`, creating both (owner-only)
    /// if needed; fails at once when it is held.
    pub async fn acquire(directory: &Path, root_id: &str) -> Result<Self, InstanceLockError> {
        let directory = directory.to_owned();
        let path = directory.join(format!("{root_id}.lock"));
        let target = path.clone();
        // File locking blocks in the kernel; keep it off the caller's thread.
        blocking::unblock(move || {
            let io_error = |source| InstanceLockError::Io { path: target.clone(), source };
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt as _;
                builder.mode(0o700);
            }
            builder.create(&directory).map_err(io_error)?;
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let file = options.open(&target).map_err(io_error)?;
            match file.try_lock() {
                Ok(()) => Ok(Self { path: target, _file: file }),
                Err(TryLockError::WouldBlock) => Err(InstanceLockError::Held { path: target }),
                Err(TryLockError::Error(source)) => Err(io_error(source)),
            }
        })
        .await
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use futures_lite::future::block_on;

    use super::*;

    #[test]
    fn a_second_holder_is_refused_until_the_first_lets_go() {
        let directory = std::env::temp_dir()
            .join(format!("bots-instance-lock-{}", uuid::Uuid::new_v4().simple()));
        let first = block_on(InstanceLock::acquire(&directory, "root-a")).expect("first");
        match block_on(InstanceLock::acquire(&directory, "root-a")) {
            Err(InstanceLockError::Held { path }) => assert_eq!(path, first.path()),
            other => panic!("expected the lock to be held, got {other:?}"),
        }
        // Another State Root is another lock.
        let other = block_on(InstanceLock::acquire(&directory, "root-b")).expect("other root");
        drop(first);
        let again = block_on(InstanceLock::acquire(&directory, "root-a")).expect("released");
        drop((again, other));
        std::fs::remove_dir_all(directory).ok();
    }
}
