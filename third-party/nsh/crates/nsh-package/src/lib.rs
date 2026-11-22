//! Signed app packages and the trust that verifies them.
//!
//! # Keys: two levels
//!
//! A **root key** stays offline; apps embedding nsh trust its public key
//! (several roots may be trusted, which is how roots rotate). A root
//! certifies **release keys** ([`certify`]): a [`Certificate`] names the
//! release key, the time window it may sign in and the app ids it may sign
//! for (`com.longbridge.*`). Packages are signed by a release key and carry
//! its certificate, so release keys rotate without updating the apps that
//! trust the root. Every key id is derived from its public key
//! ([`PublicKey::id`]).
//!
//! # Signing again
//!
//! [`resign`] signs a package again with another release key: a platform
//! that signs, with the key its apps trust, what builds signed with keys of
//! their own (CI's, which test apps trust). Only the certificate, the
//! signing time and the signature change; the files and every other header
//! field are kept as written, those this runtime does not know included,
//! and so is the minimum runtime. The package must be intact (its own
//! signature, file table and hashes); its first certificate is not checked
//! against any root, as the new signer vouches for it from then on.
//!
//! # Revocation and rollback
//!
//! A root also signs **revocation lists** ([`Revocations`]): release keys and
//! package hashes that must not load any more. Each list has a sequence
//! number; a trust store only accepts a list newer than the one it has, so an
//! old list cannot be replayed to un-revoke something. A trust store also
//! remembers the highest build it accepted per app id and refuses older
//! builds (an attacker cannot serve an older, vulnerable signed package).
//! With a state directory ([`TrustStore::open`]) both survive restarts.
//!
//! # Package format (`.nshpkg`)
//!
//! All integers little-endian.
//!
//! ```text
//! offset  size  field
//! 0       4     magic "NSHP"
//! 4       2     format version (1)
//! 6       2     flags (0)
//! 8       4     H: header length
//! 12      H     header (UTF-8 JSON, see [`Header`])
//! 12+H    B     the files' bytes, concatenated in header order
//! 12+H+B  64    Ed25519 signature by the release key over everything before it
//! ```
//!
//! The signature covers every byte before it, so nothing in a package can
//! change without invalidating it; its identity (for revocation) is the
//! SHA-256 of the whole file. A package always carries the bundle's source;
//! bytecode is an extra that only loads when the runtime's
//! `BYTECODE_VERSION` matches (QuickJS bytecode is trusted input: loading
//! crafted bytecode is memory corruption, so it is only ever loaded from a
//! verified package or the app's own signed resources).
//!
//! # Format evolution
//!
//! Packages outlive the runtime that reads them: a host app in the field
//! runs packages signed by newer tools. So an addition is optional unless
//! said otherwise, and what a runtime does not know never widens what a
//! package may do:
//!
//! - header and `app` fields it does not know are ignored;
//! - a file of a kind it does not know, or with a field it does not know
//!   (which may change what its bytes are), is not used; it still tiles
//!   the data and is hashed;
//! - a header field it must not ignore (a new restriction, a new meaning
//!   of the bytes) is named in the header's `critical` list, and a runtime
//!   that does not know a field listed there refuses the package;
//! - capabilities it does not know are not granted, and an unknown key
//!   inside one drops that capability (`Capabilities::from_json_lenient`).
//!
//! Signers write `critical` only when it is not empty, and nothing else
//! older runtimes do not read. What was ignored is in
//! [`VerifiedPackage::ignored`]. An incompatible change bumps the format
//! version, which runtimes require to match. All of this applies to
//! runtimes the package's minimum runtime admits: older ones refuse it
//! ([`Error::RuntimeTooOld`]).

mod keys;
mod package;
mod trust;

pub use crate::{
    keys::{PublicKey, SecretKey},
    package::{
        App, Contents, FileKind, Header, PackageReceipt, VerifiedPackage, build, resign,
        source_map, verify_signature,
    },
    trust::{Certificate, Revocations, TrustStore, certify, revoke},
};

/// This runtime's version (packages name the lowest they need).
pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Why a package, certificate or revocation list was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// Malformed data.
    #[error("not a valid nsh package: {0}")]
    Format(String),
    /// A key could not be read or made.
    #[error("key: {0}")]
    Key(String),
    /// Signed by a key this store does not trust.
    #[error("signed by key `{0}`, which is not trusted")]
    UntrustedKey(String),
    /// A signature does not verify.
    #[error("the signature does not verify")]
    BadSignature,
    /// The release key's certificate does not cover this package.
    #[error("the release key's certificate does not cover this package: {0}")]
    Certificate(String),
    /// The release key or the package was revoked.
    #[error("revoked: {0}")]
    Revoked(String),
    /// A build older than one already accepted for the app.
    #[error("app `{app}` build {build} is older than build {accepted}, which was accepted before")]
    Rollback {
        /// The app id.
        app: String,
        /// The package's build.
        build: u64,
        /// The highest build accepted before.
        accepted: u64,
    },
    /// The package needs a newer runtime.
    #[error("the package needs runtime {needs} or newer; this runtime is {runtime}")]
    RuntimeTooOld {
        /// What the package needs.
        needs: String,
        /// This runtime.
        runtime: String,
    },
    /// A file does not match its hash.
    #[error("file `{0}` does not match its hash")]
    Integrity(String),
    /// A revocation list older than (or as old as) the one the store has.
    #[error("revocation list {got} is not newer than list {have}")]
    StaleRevocations {
        /// The list offered.
        got: u64,
        /// The list the store has.
        have: u64,
    },
    /// The trust store's state could not be read or written.
    #[error("trust state: {0}")]
    State(String),
}

/// `*` (any), `prefix.*` (ids under `prefix.`) or an exact app id.
pub(crate) fn app_matches(pattern: &str, id: &str) -> bool {
    match pattern.strip_suffix(".*") {
        _ if pattern == "*" => true,
        Some(prefix) => {
            id.len() > prefix.len() + 1
                && id.starts_with(prefix)
                && id.as_bytes()[prefix.len()] == b'.'
        }
        None => pattern == id,
    }
}

/// Whether semver-like `have` (`1.2.3`) is at least `needs`. Missing parts
/// count as 0 (`1.2` is `1.2.0`); pre-release and build suffixes are
/// ignored (`0.2.0-beta.1` is `0.2.0`).
pub(crate) fn version_at_least(have: &str, needs: &str) -> bool {
    let parse = |v: &str| -> [u64; 3] {
        let mut parts = [0; 3];
        let core = v.split(['-', '+']).next().unwrap_or_default();
        for (part, text) in parts.iter_mut().zip(core.split('.')) {
            *part = text.parse().unwrap_or(0);
        }
        parts
    };
    parse(have) >= parse(needs)
}

/// Checks a package's minimum runtime before signing: `MAJOR.MINOR.PATCH`,
/// optionally with a pre-release (`-beta.1`) or build (`+abc`) suffix,
/// which comparisons ignore, and no newer than this runtime (nothing newer
/// is known to run what this runtime's tools built).
pub fn check_min_runtime(version: &str) -> Result<(), String> {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    let numeric = |p: &&str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    if parts.len() != 3 || !parts.iter().all(numeric) {
        return Err(format!(
            "minimum runtime `{version}` is not a version (MAJOR.MINOR.PATCH, e.g. 0.2.0)"
        ));
    }
    if !version_at_least(RUNTIME_VERSION, version) {
        return Err(format!(
            "minimum runtime {version} is newer than this runtime, {RUNTIME_VERSION}"
        ));
    }
    Ok(())
}

/// Unix seconds now.
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_their_numbers() {
        assert!(version_at_least("0.2.0", "0.2.0"));
        assert!(version_at_least("0.10.0", "0.9.9"));
        assert!(!version_at_least("0.1.9", "0.2.0"));
        // Missing parts are 0; suffixes do not count.
        assert!(version_at_least("1.2", "1.2.0"));
        assert!(version_at_least("0.2.0-beta.1", "0.2.0"));
        assert!(version_at_least("0.2.0", "0.2.0+abc"));
    }

    #[test]
    fn minimum_runtimes_are_versions_up_to_this_one() {
        assert!(check_min_runtime("0.0.1").is_ok());
        assert!(check_min_runtime(RUNTIME_VERSION).is_ok());
        assert!(check_min_runtime("0.0.1-beta.1").is_ok());
        for bad in [
            "", "1", "1.2", "1.2.x", "v1.2.3", "1.2.3.4", "1..3", "999.0.0",
        ] {
            assert!(check_min_runtime(bad).is_err(), "{bad}");
        }
    }
}
