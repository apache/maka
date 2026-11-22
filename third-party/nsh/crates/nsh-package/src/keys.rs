//! Ed25519 keys and signed JSON blobs (certificates, revocation lists).

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::Error;

/// A signing key (an Ed25519 seed). Kept out of `Debug` output.
#[derive(Clone)]
pub struct SecretKey(SigningKey);

/// A verifying key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublicKey(VerifyingKey);

impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretKey({})", self.public().id())
    }
}

fn decode32(b64: &str, what: &str) -> Result<[u8; 32], Error> {
    let bytes = B64
        .decode(b64.trim())
        .map_err(|e| Error::Key(format!("{what} is not base64: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| Error::Key(format!("{what} must be 32 bytes")))
}

impl SecretKey {
    /// A fresh random key (not in WebAssembly).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn generate() -> Result<SecretKey, Error> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| Error::Key(format!("no randomness: {e}")))?;
        Ok(SecretKey(SigningKey::from_bytes(&seed)))
    }

    /// Reads the base64 form written by [`SecretKey::to_base64`].
    pub fn from_base64(b64: &str) -> Result<SecretKey, Error> {
        Ok(SecretKey(SigningKey::from_bytes(&decode32(
            b64,
            "a secret key",
        )?)))
    }

    /// The seed as base64.
    pub fn to_base64(&self) -> String {
        B64.encode(self.0.to_bytes())
    }

    /// Its public key.
    pub fn public(&self) -> PublicKey {
        PublicKey(self.0.verifying_key())
    }

    /// Signs `message` in `context` (each kind of signed data has its own,
    /// so a signature over one is never valid as another).
    pub(crate) fn sign(&self, context: &str, message: &[u8]) -> [u8; 64] {
        self.0.sign(&framed(context, message)).to_bytes()
    }
}

impl PublicKey {
    /// Reads the base64 form written by [`PublicKey::to_base64`].
    pub fn from_base64(b64: &str) -> Result<PublicKey, Error> {
        VerifyingKey::from_bytes(&decode32(b64, "a public key")?)
            .map(PublicKey)
            .map_err(|e| Error::Key(format!("not an Ed25519 public key: {e}")))
    }

    /// The key as base64.
    pub fn to_base64(&self) -> String {
        B64.encode(self.0.to_bytes())
    }

    /// Its id: the first 8 bytes of its SHA-256, in hex. Derived, so ids
    /// cannot collide by mistake or be misattributed.
    pub fn id(&self) -> String {
        hex(&Sha256::digest(self.0.to_bytes())[..8])
    }

    pub(crate) fn verify(&self, context: &str, message: &[u8], signature: &[u8]) -> bool {
        let Ok(signature) = Signature::from_slice(signature) else {
            return false;
        };
        self.0.verify(&framed(context, message), &signature).is_ok()
    }
}

/// `context \0 SHA-256(message)`: what is actually signed.
fn framed(context: &str, message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(context.len() + 33);
    out.extend_from_slice(context.as_bytes());
    out.push(0);
    out.extend_from_slice(&Sha256::digest(message));
    out
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A JSON body with its signature. The body is kept as the exact bytes that
/// were signed (base64), so verifying never depends on re-serializing JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Signed {
    /// The signed JSON, base64.
    pub(crate) body: String,
    /// Id of the key that signed it.
    pub(crate) signer: String,
    /// The signature, base64.
    pub(crate) signature: String,
}

impl Signed {
    pub(crate) fn sign<T: Serialize>(key: &SecretKey, context: &str, body: &T) -> Signed {
        let json = serde_json::to_vec(body).expect("serializable");
        Signed {
            body: B64.encode(&json),
            signer: key.public().id(),
            signature: B64.encode(key.sign(context, &json)),
        }
    }

    /// The body, without checking the signature: only for information the
    /// caller verifies otherwise (or merely displays).
    pub(crate) fn unchecked<T: for<'de> Deserialize<'de>>(&self) -> Result<T, Error> {
        let json = B64
            .decode(&self.body)
            .map_err(|e| Error::Format(format!("signed body: {e}")))?;
        serde_json::from_slice(&json).map_err(|e| Error::Format(format!("signed body: {e}")))
    }

    /// The body, if one of `keys` signed it in `context`.
    pub(crate) fn open<T: for<'de> Deserialize<'de>>(
        &self,
        context: &str,
        keys: &[PublicKey],
    ) -> Result<(T, PublicKey), Error> {
        let key = keys
            .iter()
            .find(|k| k.id() == self.signer)
            .ok_or_else(|| Error::UntrustedKey(self.signer.clone()))?;
        let json = B64
            .decode(&self.body)
            .map_err(|e| Error::Format(format!("signed body: {e}")))?;
        let signature = B64
            .decode(&self.signature)
            .map_err(|e| Error::Format(format!("signature: {e}")))?;
        if !key.verify(context, &json, &signature) {
            return Err(Error::BadSignature);
        }
        let body = serde_json::from_slice(&json)
            .map_err(|e| Error::Format(format!("signed body: {e}")))?;
        Ok((body, *key))
    }
}
