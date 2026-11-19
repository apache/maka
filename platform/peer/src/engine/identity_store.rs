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

use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use libp2p::identity;
use tokio::io::AsyncWriteExt as _;

use super::{PeerError, native_error};

static TEMPORARY_KEY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) async fn load_or_create_key(path: &Path) -> Result<identity::Keypair, PeerError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => identity::Keypair::from_protobuf_encoding(&bytes)
            .map_err(|error| PeerError::new("peer_native_failed", error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(native_error)?;
            }
            let key = identity::Keypair::generate_ed25519();
            let encoded = key.to_protobuf_encoding().map_err(native_error)?;
            match publish_private_file(path, &encoded).await {
                Ok(()) => Ok(key),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let bytes = tokio::fs::read(path).await.map_err(native_error)?;
                    identity::Keypair::from_protobuf_encoding(&bytes)
                        .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))
                }
                Err(error) => Err(native_error(error)),
            }
        }
        Err(error) => Err(native_error(error)),
    }
}

pub(super) async fn load_key(path: &Path) -> Result<identity::Keypair, PeerError> {
    let bytes = tokio::fs::read(path).await.map_err(native_error)?;
    identity::Keypair::from_protobuf_encoding(&bytes)
        .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))
}

async fn publish_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let temporary = loop {
        let sequence = TEMPORARY_KEY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".maka-peer-key-{}-{sequence}.tmp",
            std::process::id()
        ));
        let mut options = tokio::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        match options.open(&candidate).await {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    let (temporary_path, mut file) = temporary;
    let publish = async {
        file.write_all(bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::hard_link(&temporary_path, path).await
    }
    .await;
    let cleanup = tokio::fs::remove_file(&temporary_path).await;
    publish?;
    cleanup
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_creation_adopts_one_published_identity() {
        let path = std::env::temp_dir().join(format!(
            "maka-peer-key-test-{}-{}",
            std::process::id(),
            TEMPORARY_KEY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let (first, second) = runtime.block_on(async {
            futures::future::join(load_or_create_key(&path), load_or_create_key(&path)).await
        });
        let first = first.expect("first identity");
        let second = second.expect("second identity");
        assert_eq!(first.public().to_peer_id(), second.public().to_peer_id());
        std::fs::remove_file(path).expect("remove test identity");
    }
}
