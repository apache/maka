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

use std::path::Path;

use libp2p::identity;
use tokio::io::AsyncWriteExt as _;

use super::{PeerError, native_error};

pub(super) async fn load_or_create_key(path: &Path) -> Result<identity::Keypair, PeerError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => identity::Keypair::from_protobuf_encoding(&bytes)
            .map_err(|error| PeerError::new("peer_native_failed", error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(native_error)?;
            }
            let key = identity::Keypair::generate_ed25519();
            let encoded = key.to_protobuf_encoding().map_err(native_error)?;
            write_private_file(path, &encoded).await?;
            Ok(key)
        }
        Err(error) => Err(native_error(error)),
    }
}

#[cfg(unix)]
async fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), PeerError> {
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .await
        .map_err(native_error)?;
    file.write_all(bytes).await.map_err(native_error)?;
    file.sync_all().await.map_err(native_error)
}

#[cfg(not(unix))]
async fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), PeerError> {
    tokio::fs::write(path, bytes).await.map_err(native_error)
}
