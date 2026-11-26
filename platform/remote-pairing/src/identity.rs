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

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use std::{
    fmt, fs,
    io::{self, Read, Write},
    path::Path,
};
use zeroize::Zeroizing;

use crate::PairingError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DevicePublicKey(VerifyingKey);

impl fmt::Display for DevicePublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0.as_bytes()))
    }
}

pub fn parse_peer_id(id: &str) -> Result<DevicePublicKey, PairingError> {
    let mut bytes = [0; 32];
    if id.bytes().any(|b| b.is_ascii_uppercase()) || hex::decode_to_slice(id, &mut bytes).is_err() {
        return Err(PairingError::PeerId);
    }
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| PairingError::PeerId)?;
    if key.is_weak() || key.to_edwards().compress().to_bytes() != bytes {
        return Err(PairingError::PeerId);
    }
    Ok(DevicePublicKey(key))
}

impl DevicePublicKey {
    pub fn as_bytes(&self) -> &[u8; 32] {
        self.0.as_bytes()
    }

    pub(crate) fn verify(
        &self,
        domain: &[u8],
        payload: &[u8],
        signature: &[u8; 64],
    ) -> Result<(), PairingError> {
        self.0
            .verify_strict(
                &[domain, payload].concat(),
                &Signature::from_bytes(signature),
            )
            .map_err(|_| PairingError::Signature)
    }
}

pub struct DeviceIdentity(Zeroizing<[u8; 32]>);

impl DeviceIdentity {
    pub fn from_secret(secret: Zeroizing<[u8; 32]>) -> Self {
        Self(secret)
    }

    pub fn generate() -> Result<Self, PairingError> {
        let mut bytes = Zeroizing::new([0; 32]);
        getrandom::fill(&mut *bytes).map_err(PairingError::Random)?;
        Ok(Self(bytes))
    }

    /// For initializing a transport with the same endpoint identity.
    pub fn secret_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn public_key(&self) -> DevicePublicKey {
        DevicePublicKey(SigningKey::from_bytes(&self.0).verifying_key())
    }

    pub(crate) fn sign(&self, domain: &[u8], payload: &[u8]) -> [u8; 64] {
        SigningKey::from_bytes(&self.0)
            .sign(&[domain, payload].concat())
            .to_bytes()
    }

    pub fn load_or_create(path: &Path) -> Result<Self, PairingError> {
        match Self::load(path) {
            Ok(key) => return Ok(key),
            Err(PairingError::Io(err)) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent)?;
        let key = Self::generate()?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temp.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        temp.write_all(&*key.0)?;
        temp.as_file().sync_all()?;
        match temp.persist_noclobber(path) {
            Ok(_) => {
                #[cfg(unix)]
                fs::File::open(parent)?.sync_all()?;
                Ok(key)
            }
            Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => Self::load(path),
            Err(err) => Err(err.error.into()),
        }
    }

    fn load(path: &Path) -> Result<Self, PairingError> {
        let mut file = fs::File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != 32 {
            return Err(PairingError::IdentityFile);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o7777 != 0o600 {
                return Err(PairingError::IdentityFile);
            }
        }
        let mut bytes = Zeroizing::new([0; 32]);
        file.read_exact(&mut *bytes)?;
        Ok(Self(bytes))
    }
}
