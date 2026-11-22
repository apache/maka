//! Release-key certificates, revocation lists and the trust store.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};

use crate::{
    Error, app_matches,
    keys::{PublicKey, SecretKey, Signed},
    package::{PackageReceipt, VerifiedPackage},
};

const CERTIFICATE: &str = "nsh-certificate-v1";
const REVOCATIONS: &str = "nsh-revocations-v1";

/// What a root says about a release key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CertificateBody {
    format: u32,
    /// The release key (base64).
    key: String,
    /// Unix seconds: packages signed before it are refused.
    not_before: u64,
    /// Unix seconds: packages signed after it are refused.
    not_after: u64,
    /// The app ids it may sign for (`*`, `prefix.*` or an id).
    apps: Vec<String>,
}

/// A release key certified by a root: carried by every package it signs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Certificate(pub(crate) Signed);

/// What a verified certificate allows.
#[derive(Debug, Clone)]
pub(crate) struct Certified {
    pub(crate) key: PublicKey,
    pub(crate) not_before: u64,
    pub(crate) not_after: u64,
    pub(crate) apps: Vec<String>,
}

impl Certificate {
    /// The JSON file form.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("serializable")
    }

    /// Reads the JSON file form.
    pub fn from_json(json: &str) -> Result<Certificate, Error> {
        serde_json::from_str(json).map_err(|e| Error::Format(format!("certificate: {e}")))
    }

    /// Checks the root's signature (one of `roots`) and returns what it
    /// certifies.
    pub(crate) fn open(&self, roots: &[PublicKey]) -> Result<Certified, Error> {
        let (body, _): (CertificateBody, _) = self.0.open(CERTIFICATE, roots)?;
        if body.format != 1 {
            return Err(Error::Format(format!("certificate format {}", body.format)));
        }
        Ok(Certified {
            key: PublicKey::from_base64(&body.key)?,
            not_before: body.not_before,
            not_after: body.not_after,
            apps: body.apps,
        })
    }

    /// The certified key's id, without checking the certificate.
    pub(crate) fn claimed_key(&self) -> Result<PublicKey, Error> {
        Ok(self.claimed()?.key)
    }

    /// What it certifies, without checking the root's signature (for the
    /// signer's own checks before it signs).
    pub(crate) fn claimed(&self) -> Result<Certified, Error> {
        let body: CertificateBody = self.0.unchecked()?;
        Ok(Certified {
            key: PublicKey::from_base64(&body.key)?,
            not_before: body.not_before,
            not_after: body.not_after,
            apps: body.apps,
        })
    }
}

/// Certifies `release` with `root` for `apps` (app id patterns), for
/// packages signed between `not_before` and `not_after` (Unix seconds).
pub fn certify(
    root: &SecretKey,
    release: &PublicKey,
    apps: &[String],
    not_before: u64,
    not_after: u64,
) -> Certificate {
    Certificate(Signed::sign(
        root,
        CERTIFICATE,
        &CertificateBody {
            format: 1,
            key: release.to_base64(),
            not_before,
            not_after,
            apps: apps.to_vec(),
        },
    ))
}

/// What a revocation list revokes.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RevocationsBody {
    format: u32,
    /// Increases with every list.
    sequence: u64,
    issued_at: u64,
    /// Release key ids.
    keys: BTreeSet<String>,
    /// Package SHA-256s (hex).
    packages: BTreeSet<String>,
}

/// A revocation list signed by a root key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Revocations(Signed);

impl Revocations {
    /// The JSON file form.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("serializable")
    }

    /// Reads the JSON file form.
    pub fn from_json(json: &str) -> Result<Revocations, Error> {
        serde_json::from_str(json).map_err(|e| Error::Format(format!("revocation list: {e}")))
    }

    /// Its sequence number, keys and packages, without checking the
    /// signature (to extend a list).
    pub fn contents(&self) -> Result<(u64, Vec<String>, Vec<String>), Error> {
        let body: RevocationsBody = self.0.unchecked()?;
        Ok((
            body.sequence,
            body.keys.into_iter().collect(),
            body.packages.into_iter().collect(),
        ))
    }
}

/// A revocation list from `root`: `keys` (release key ids) and `packages`
/// (SHA-256 hex) must not load any more. `sequence` must exceed the
/// previous list's.
pub fn revoke(
    root: &SecretKey,
    sequence: u64,
    keys: &[String],
    packages: &[String],
) -> Revocations {
    Revocations(Signed::sign(
        root,
        REVOCATIONS,
        &RevocationsBody {
            format: 1,
            sequence,
            issued_at: crate::now(),
            keys: keys.iter().cloned().collect(),
            packages: packages.iter().map(|p| p.to_ascii_lowercase()).collect(),
        },
    ))
}

/// Persisted state of a trust store.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    /// The newest revocation list accepted (as signed).
    revocations: Option<Revocations>,
    /// The highest build accepted per app id.
    builds: BTreeMap<String, u64>,
}

const STATE_FILE: &str = "nsh-trust.json";

/// The keys an app trusts, the revocations it knows and the builds it
/// accepted: verifies packages ([`TrustStore::verify`]).
#[derive(Debug, Default)]
pub struct TrustStore {
    roots: Vec<PublicKey>,
    state: State,
    /// Where the state persists.
    dir: Option<PathBuf>,
}

impl TrustStore {
    /// A store trusting nothing yet, kept in memory.
    pub fn new() -> TrustStore {
        TrustStore::default()
    }

    /// A store whose revocations and accepted builds persist in `dir`
    /// (`nsh-trust.json`; the directory is created).
    pub fn open(dir: impl Into<PathBuf>) -> Result<TrustStore, Error> {
        let dir = dir.into();
        let state = match std::fs::read_to_string(dir.join(STATE_FILE)) {
            Ok(json) => serde_json::from_str(&json).map_err(|e| Error::State(e.to_string()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(Error::State(e.to_string())),
        };
        Ok(TrustStore {
            roots: Vec::new(),
            state,
            dir: Some(dir),
        })
    }

    /// Trusts `root` (certificates and revocation lists it signs).
    pub fn add_root(&mut self, root: PublicKey) {
        if !self.roots.contains(&root) {
            self.roots.push(root);
        }
    }

    /// The trusted roots.
    pub fn roots(&self) -> &[PublicKey] {
        &self.roots
    }

    /// Accepts a revocation list signed by a trusted root, if it is newer
    /// than the one the store has. Returns its sequence number.
    pub fn update_revocations(&mut self, list: Revocations) -> Result<u64, Error> {
        let (body, _): (RevocationsBody, _) = list.0.open(REVOCATIONS, &self.roots)?;
        let have = self.revocations().map_or(0, |r| r.sequence);
        if body.sequence <= have && self.state.revocations.is_some() {
            return Err(Error::StaleRevocations {
                got: body.sequence,
                have,
            });
        }
        self.state.revocations = Some(list);
        self.save()?;
        Ok(body.sequence)
    }

    /// The revocations in force: the stored list, if a trusted root signed
    /// it (roots may be added after opening).
    fn revocations(&self) -> Option<RevocationsBody> {
        let list = self.state.revocations.as_ref()?;
        list.0
            .open::<RevocationsBody>(REVOCATIONS, &self.roots)
            .ok()
            .map(|(body, _)| body)
    }

    /// Verifies a package: its release key's certificate (signed by a
    /// trusted root, covering the app id and the signing time, not revoked),
    /// its signature, every file's hash, its build against the builds
    /// accepted before, and the runtime it needs. Bytecode is kept only when
    /// it was compiled for `bytecode_version` (the runtime's).
    pub fn verify(&self, bytes: &[u8], bytecode_version: &str) -> Result<VerifiedPackage, Error> {
        let revoked = self.revocations().unwrap_or_default();
        let package = crate::package::open(bytes, &self.roots, &revoked.keys, bytecode_version)?;
        if revoked.packages.contains(&package.sha256) {
            return Err(Error::Revoked(format!("package {}", package.sha256)));
        }
        if let Some(&accepted) = self.state.builds.get(&package.app.id)
            && package.app.build < accepted
        {
            return Err(Error::Rollback {
                app: package.app.id.clone(),
                build: package.app.build,
                accepted,
            });
        }
        Ok(package)
    }

    /// Records that `package` was installed: older builds of its app are
    /// refused from now on. [`TrustStore::accept_receipt`] with its
    /// receipt.
    pub fn accept(&mut self, package: &VerifiedPackage) -> Result<(), Error> {
        self.accept_receipt(&package.receipt())
    }

    /// Records that the verified package `receipt` stands for was installed
    /// ([`VerifiedPackage::receipt`]): older builds of its app are refused
    /// from now on. Until then, the builds accepted before still verify, so
    /// an embedding app can run a new package and accept it once it proved
    /// healthy, or go back to the one it had. Refused if the package or its
    /// release key was revoked since it was verified (accepting it would
    /// refuse the builds the app can still go back to); a build at or below
    /// the one accepted changes nothing.
    pub fn accept_receipt(&mut self, receipt: &PackageReceipt) -> Result<(), Error> {
        let revoked = self.revocations().unwrap_or_default();
        if revoked.keys.contains(&receipt.key_id) {
            return Err(Error::Revoked(format!("release key {}", receipt.key_id)));
        }
        if revoked.packages.contains(&receipt.sha256) {
            return Err(Error::Revoked(format!("package {}", receipt.sha256)));
        }
        let build = self.state.builds.entry(receipt.app.id.clone()).or_insert(0);
        if receipt.app.build > *build {
            *build = receipt.app.build;
            self.save()?;
        }
        Ok(())
    }

    /// The highest build of app `id` accepted so far: older ones are
    /// refused.
    pub fn accepted_build(&self, id: &str) -> Option<u64> {
        self.state.builds.get(id).copied()
    }

    fn save(&self) -> Result<(), Error> {
        let Some(dir) = &self.dir else { return Ok(()) };
        std::fs::create_dir_all(dir).map_err(|e| Error::State(e.to_string()))?;
        let json = serde_json::to_vec_pretty(&self.state).expect("serializable");
        // Written whole, then renamed: a crash never leaves half a file.
        let tmp = dir.join(format!("{STATE_FILE}.tmp"));
        std::fs::write(&tmp, json).map_err(|e| Error::State(e.to_string()))?;
        std::fs::rename(&tmp, dir.join(STATE_FILE)).map_err(|e| Error::State(e.to_string()))
    }
}

impl Certified {
    /// Whether this certificate lets its key sign `app` at `signed_at`.
    pub(crate) fn covers(&self, app: &str, signed_at: u64) -> Result<(), Error> {
        if !self.apps.iter().any(|p| app_matches(p, app)) {
            return Err(Error::Certificate(format!(
                "it does not cover app `{app}` (only {})",
                self.apps.join(", ")
            )));
        }
        if signed_at < self.not_before || signed_at > self.not_after {
            return Err(Error::Certificate(format!(
                "the package was signed at {signed_at}, outside {}..{}",
                self.not_before, self.not_after
            )));
        }
        Ok(())
    }
}
