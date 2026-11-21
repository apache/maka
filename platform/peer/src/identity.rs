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

//! Ed25519 peer node identity and deterministic peer fingerprint.

use aws_lc_rs::{
    rand as lc_rand,
    signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use uuid::Uuid;

pub const ED25519_PUBLIC_KEY_LEN: usize = 32;
pub const ED25519_SEED_LEN: usize = 32;
pub const ED25519_SIGNATURE_LEN: usize = 64;
const PEER_ID_PREFIX: &str = "peer_";
const PEER_ID_HEX_LEN: usize = 64;

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("invalid peer id `{0}`: expected `peer_<64 lowercase hex chars>`")]
    InvalidPeerId(String),
    #[error("invalid Ed25519 public key encoding: {0}")]
    InvalidPublicKey(String),
    #[error("invalid Ed25519 seed encoding: {0}")]
    InvalidSeed(String),
    #[error("invalid Ed25519 signature encoding: {0}")]
    InvalidSignature(String),
    #[error("public key derives peer id `{actual}`, expected `{expected}`")]
    PeerIdMismatch { expected: PeerId, actual: PeerId },
    #[error("Ed25519 signature verification failed")]
    SignatureVerificationFailed,
    #[error("cryptographic failure: {0}")]
    Crypto(String),
    #[error("identity storage I/O failure: {0}")]
    Io(#[from] io::Error),
}

pub(crate) fn decode_canonical_base64(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.is_empty() || encoded.bytes().any(|b| b.is_ascii_whitespace()) {
        return Err("base64 string must not be empty or contain whitespace".into());
    }
    let bytes = BASE64.decode(encoded).map_err(|err| err.to_string())?;
    if BASE64.encode(&bytes) != encoded {
        return Err("non-canonical base64 padding or encoding".into());
    }
    Ok(bytes)
}

/// Canonical peer identifier: `peer_` followed by the 64-character lowercase
/// hex SHA-256 digest of the peer's 32-byte Ed25519 public key.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PeerId(String);

impl PeerId {
    pub fn parse(raw: impl Into<String>) -> Result<Self, IdentityError> {
        let raw = raw.into();
        let Some(hex_part) = raw.strip_prefix(PEER_ID_PREFIX) else {
            return Err(IdentityError::InvalidPeerId(raw));
        };
        if hex_part.len() != PEER_ID_HEX_LEN
            || !hex_part
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(IdentityError::InvalidPeerId(raw));
        }
        Ok(Self(raw))
    }

    pub fn from_public_key_bytes(public_key: &[u8]) -> Result<Self, IdentityError> {
        if public_key.len() != ED25519_PUBLIC_KEY_LEN {
            return Err(IdentityError::InvalidPublicKey(format!(
                "expected {ED25519_PUBLIC_KEY_LEN} bytes, got {}",
                public_key.len()
            )));
        }
        let digest = Sha256::digest(public_key);
        Ok(Self(format!("{PEER_ID_PREFIX}{}", hex::encode(digest))))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Deterministic 6-digit Short Authentication String (SAS) derived from two
    /// peers and a pairing nonce so both sides can visually confirm zero MITM.
    pub fn short_auth_code(&self, other: &Self, nonce: &str) -> String {
        let (first, second) = if self <= other {
            (self.as_str(), other.as_str())
        } else {
            (other.as_str(), self.as_str())
        };
        let mut hasher = Sha256::new();
        hasher.update(b"maka-peer-sas-v1\n");
        hasher.update(first.as_bytes());
        hasher.update(b"\n");
        hasher.update(second.as_bytes());
        hasher.update(b"\n");
        hasher.update(nonce.as_bytes());
        let digest = hasher.finalize();
        let raw = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
        format!("{raw:06}")
    }
}

impl fmt::Display for PeerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for PeerId {
    type Error = IdentityError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<PeerId> for String {
    fn from(value: PeerId) -> Self {
        value.0
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredNodeIdentityV1 {
    version: u32,
    peer_id: PeerId,
    public_key_base64: String,
    seed_base64: String,
}

/// Ed25519 node identity owning the private signing key without retaining
/// raw seed bytes in cloneable struct memory.
#[derive(Clone)]
pub struct NodeIdentity {
    peer_id: PeerId,
    public_key_bytes: [u8; ED25519_PUBLIC_KEY_LEN],
    public_key_base64: String,
    key_pair: Arc<Ed25519KeyPair>,
}

impl fmt::Debug for NodeIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NodeIdentity")
            .field("peer_id", &self.peer_id)
            .field("public_key_base64", &self.public_key_base64)
            .finish_non_exhaustive()
    }
}

impl NodeIdentity {
    pub fn generate() -> Result<Self, IdentityError> {
        let (identity, mut seed) = Self::generate_with_seed()?;
        seed.fill(0);
        Ok(identity)
    }

    fn generate_with_seed() -> Result<(Self, [u8; ED25519_SEED_LEN]), IdentityError> {
        let mut seed = [0u8; ED25519_SEED_LEN];
        lc_rand::fill(&mut seed)
            .map_err(|_| IdentityError::Crypto("CSPRNG failed to generate Ed25519 seed".into()))?;
        let identity = Self::from_seed(&seed)?;
        Ok((identity, seed))
    }

    pub fn from_seed(seed_bytes: &[u8; ED25519_SEED_LEN]) -> Result<Self, IdentityError> {
        let key_pair = Ed25519KeyPair::from_seed_unchecked(seed_bytes)
            .map_err(|err| IdentityError::Crypto(err.to_string()))?;
        let raw_public = key_pair.public_key().as_ref();
        let public_key_bytes: [u8; ED25519_PUBLIC_KEY_LEN] = raw_public.try_into().map_err(|_| {
            IdentityError::InvalidPublicKey(format!(
                "unexpected Ed25519 public key length {}",
                raw_public.len()
            ))
        })?;
        let peer_id = PeerId::from_public_key_bytes(&public_key_bytes)?;
        let public_key_base64 = BASE64.encode(public_key_bytes);
        Ok(Self {
            peer_id,
            public_key_bytes,
            public_key_base64,
            key_pair: Arc::new(key_pair),
        })
    }

    /// Asynchronously loads or atomically creates a node identity on the
    /// blocking thread pool so async executor threads never block on disk I/O.
    pub async fn load_or_create_async(path: impl Into<PathBuf>) -> Result<Self, IdentityError> {
        let path = path.into();
        tokio::task::spawn_blocking(move || Self::load_or_create(&path))
            .await
            .map_err(|err| IdentityError::Io(io::Error::other(err.to_string())))?
    }

    /// Loads an existing node identity from `path`, or atomically creates and
    /// persists a fresh identity with `0o600` permissions if absent.
    pub fn load_or_create(path: &Path) -> Result<Self, IdentityError> {
        match Self::load(path) {
            Ok(identity) => return Ok(identity),
            Err(IdentityError::Io(err)) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }

        let parent = path.parent().ok_or_else(|| {
            IdentityError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "identity file path must have a parent directory",
            ))
        })?;
        create_private_dir_if_missing(parent)?;

        let (generated, mut seed_bytes) = Self::generate_with_seed()?;
        let stored = StoredNodeIdentityV1 {
            version: 1,
            peer_id: generated.peer_id.clone(),
            public_key_base64: generated.public_key_base64.clone(),
            seed_base64: BASE64.encode(seed_bytes),
        };
        seed_bytes.fill(0);
        let encoded = serde_json::to_vec_pretty(&stored)
            .map_err(|err| IdentityError::Io(io::Error::other(err.to_string())))?;

        let temp_path = parent.join(format!(
            ".peer-identity-{}.tmp",
            Uuid::new_v4().simple()
        ));
        write_private_temp_file(&temp_path, &encoded)?;

        let link_result = fs::hard_link(&temp_path, path);
        let _ = fs::remove_file(&temp_path);

        match link_result {
            Ok(()) => Ok(generated),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Self::load(path),
            Err(err) => Err(IdentityError::Io(err)),
        }
    }

    pub fn load(path: &Path) -> Result<Self, IdentityError> {
        let bytes = fs::read(path)?;
        let stored: StoredNodeIdentityV1 = serde_json::from_slice(&bytes).map_err(|err| {
            IdentityError::InvalidSeed(format!("corrupt node identity JSON: {err}"))
        })?;
        if stored.version != 1 {
            return Err(IdentityError::InvalidSeed(format!(
                "unsupported node identity version {}",
                stored.version
            )));
        }
        let decoded_seed =
            decode_canonical_base64(&stored.seed_base64).map_err(IdentityError::InvalidSeed)?;
        let mut seed_bytes: [u8; ED25519_SEED_LEN] =
            decoded_seed.try_into().map_err(|vec: Vec<u8>| {
                IdentityError::InvalidSeed(format!(
                    "expected {ED25519_SEED_LEN} seed bytes, got {}",
                    vec.len()
                ))
            })?;
        let identity = Self::from_seed(&seed_bytes);
        seed_bytes.fill(0);
        let identity = identity?;
        if identity.peer_id != stored.peer_id {
            return Err(IdentityError::PeerIdMismatch {
                expected: stored.peer_id,
                actual: identity.peer_id,
            });
        }
        if identity.public_key_base64 != stored.public_key_base64 {
            return Err(IdentityError::InvalidPublicKey(
                "stored publicKeyBase64 does not match Ed25519 seed".into(),
            ));
        }
        Ok(identity)
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    pub fn public_key_bytes(&self) -> &[u8; ED25519_PUBLIC_KEY_LEN] {
        &self.public_key_bytes
    }

    pub fn public_key_base64(&self) -> &str {
        &self.public_key_base64
    }

    pub fn sign(&self, message: &[u8]) -> [u8; ED25519_SIGNATURE_LEN] {
        let sig = self.key_pair.sign(message);
        let mut out = [0u8; ED25519_SIGNATURE_LEN];
        out.copy_from_slice(sig.as_ref());
        out
    }

    pub fn sign_base64(&self, message: &[u8]) -> String {
        BASE64.encode(self.sign(message))
    }
}

/// Verifies that canonical `public_key_base64` hashes to `expected_peer_id` and
/// that canonical `signature_base64` is a valid Ed25519 signature over `message`.
pub fn verify_signature(
    expected_peer_id: &PeerId,
    public_key_base64: &str,
    message: &[u8],
    signature_base64: &str,
) -> Result<(), IdentityError> {
    let public_key =
        decode_canonical_base64(public_key_base64).map_err(IdentityError::InvalidPublicKey)?;
    let derived_peer_id = PeerId::from_public_key_bytes(&public_key)?;
    if &derived_peer_id != expected_peer_id {
        return Err(IdentityError::PeerIdMismatch {
            expected: expected_peer_id.clone(),
            actual: derived_peer_id,
        });
    }
    let signature =
        decode_canonical_base64(signature_base64).map_err(IdentityError::InvalidSignature)?;
    if signature.len() != ED25519_SIGNATURE_LEN {
        return Err(IdentityError::InvalidSignature(format!(
            "expected {ED25519_SIGNATURE_LEN} bytes, got {}",
            signature.len()
        )));
    }
    UnparsedPublicKey::new(&ED25519, &public_key)
        .verify(message, &signature)
        .map_err(|_| IdentityError::SignatureVerificationFailed)
}

fn create_private_dir_if_missing(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

fn write_private_temp_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}
