//! Self-update of packaged nsh apps (`docs/dev/updater.md`).
//!
//! An app publishes a manifest, `latest.json`: a version and an asset per
//! `<os>-<arch>`. It comes from GitHub Releases
//! (`releases/latest/download/latest.json`, which needs no API call, so no
//! rate limit, and skips drafts and prereleases) or from any host serving
//! the same files. [`Config`] says where, [`Config::check`] decides from the
//! manifest's bytes whether there is a newer version, [`Download`] checks
//! the asset as it arrives and [`install`] replaces the installed app.
//!
//! A manifest may also offer a signed package (`.nshpkg`) of the app's TSX
//! ([`PackageAsset`]): an app whose `nsh.json` trusts package roots
//! ([`Packages`]) runs a newer build of its code without a new app
//! ([`Config::check_package`]; verifying and running it is `nsh-engine`'s
//! `updates`).
//!
//! No network here: the caller brings the bytes (the JS module `nsh/updater`
//! over the platform's HTTP stack, or a Rust app over its own), and no UI.

use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

#[cfg(any(
    all(target_os = "linux", not(target_env = "ohos")),
    target_os = "macos",
    windows
))]
pub mod install;

#[cfg(any(
    all(target_os = "linux", not(target_env = "ohos")),
    target_os = "macos",
    windows
))]
pub mod delta;

/// The name of the manifest, next to the release's assets.
pub const MANIFEST: &str = "latest.json";
/// The name of the manifest's detached signature.
pub const SIGNATURE: &str = "latest.json.sig";
/// The package's file holding the [`Config`], an asset of the app.
pub const CONFIG_ASSET: &str = "nsh-updater.json";
/// Keeps a signature over a manifest from being valid as any other signed
/// thing made with the same key (`nsh keygen`'s keys sign packages too).
const CONTEXT: &[u8] = b"nsh-updater-manifest\0";

/// Why an update cannot go on. Messages are for people.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The configuration is wrong.
    #[error("update configuration: {0}")]
    Config(String),
    /// The manifest is malformed, unsigned or for another app.
    #[error("update manifest: {0}")]
    Manifest(String),
    /// The download is not what the manifest says.
    #[error("update download: {0}")]
    Download(String),
    /// The downloaded app cannot replace this one.
    #[error("update install: {0}")]
    Install(String),
    /// The file system refused.
    #[error("update: {0}")]
    Io(#[from] std::io::Error),
}

/// Where an app finds its updates, and what it is now: `nsh.json`'s
/// `"updater"` with the app's id and version, as `nsh package` writes it.
/// Fields it does not know (a newer NSH's) are ignored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Config {
    /// The app's id: what finds the installed app ([`install`]). A manifest
    /// and the package it names may carry another id (an app moved to a new
    /// one): the manifest's signature is what binds an update to the app.
    pub id: String,
    /// The running version.
    pub version: String,
    /// The app's display name (`nsh.json` `"name"`), which the built-in
    /// update prompt shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `owner/repo`: updates from its GitHub Releases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github: Option<String>,
    /// The manifest's URL on a host of the app's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Other manifests the app may check instead, by name (`"beta"`): the
    /// app's code picks one by its name ([`Config::channel`]), never by its
    /// URL. Each needs HTTPS and `public_key`, as `url` does.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub channels: BTreeMap<String, String>,
    /// The Ed25519 key manifests are signed with (`nsh keygen`'s `.pub`).
    /// Required with `url` and `channels`; with `github`, unsigned manifests
    /// are refused once it is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    /// The build number of the bundle shipped in the app (`nsh.json`
    /// `"build"`): a package runs only when its build is newer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<u64>,
    /// Signed packages the app takes over the air; `None`: it takes none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packages: Option<Packages>,
}

/// `nsh.json`'s `"updater": { "packages": … }`: the app runs newer builds
/// of its code from signed packages (`.nshpkg`) certified by these roots.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[non_exhaustive]
pub struct Packages {
    /// The root public keys (`nsh keygen`'s `root.pub`, base64) whose
    /// certified release keys may sign the app's packages. At least one.
    pub roots: Vec<String>,
}

impl Config {
    /// Reads the file `nsh package` wrote, checked.
    pub fn parse(bytes: &[u8]) -> Result<Config, Error> {
        let config: Config =
            serde_json::from_slice(bytes).map_err(|e| Error::Config(e.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    /// Exactly one source, a well-formed repository or URL, channels with
    /// names and HTTPS URLs, the key a custom host needs, a version that
    /// compares.
    pub fn validate(&self) -> Result<(), Error> {
        semver::Version::parse(&self.version)
            .map_err(|e| Error::Config(format!("version {:?}: {e}", self.version)))?;
        match (&self.github, &self.url) {
            (Some(repo), None) => {
                let mut parts = repo.split('/');
                let valid = |part: Option<&str>| {
                    part.is_some_and(|p| {
                        !p.is_empty()
                            && p.chars()
                                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
                    })
                };
                if !valid(parts.next()) || !valid(parts.next()) || parts.next().is_some() {
                    return Err(Error::Config(format!(
                        "github: expected \"owner/repo\", got {repo:?}"
                    )));
                }
            }
            (None, Some(url)) => {
                check_url(url).map_err(Error::Config)?;
                if self.public_key.is_none() {
                    return Err(Error::Config(
                        "url: a custom host needs publicKey (`nsh keygen`'s .pub): whoever \
                         controls the host would otherwise control what the app runs"
                            .into(),
                    ));
                }
            }
            _ => {
                return Err(Error::Config("set one of github and url".into()));
            }
        }
        for (name, url) in &self.channels {
            let valid = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
            if !valid {
                return Err(Error::Config(format!(
                    "channels: {name:?} is not a name (letters, digits, \"-\", \"_\", \".\")"
                )));
            }
            check_url(url).map_err(|e| Error::Config(format!("channels.{name}: {e}")))?;
        }
        if !self.channels.is_empty() && self.public_key.is_none() {
            return Err(Error::Config(
                "channels: they need publicKey (`nsh keygen`'s .pub), as url does".into(),
            ));
        }
        if let Some(key) = &self.public_key {
            public_key(key)?;
        }
        if let Some(packages) = &self.packages {
            if packages.roots.is_empty() {
                return Err(Error::Config(
                    "packages.roots: name at least one root key (`nsh keygen`'s root.pub)".into(),
                ));
            }
            for root in &packages.roots {
                decode32(root, "packages.roots")?;
            }
        }
        Ok(())
    }

    /// The roots packages are verified against; empty when the app takes
    /// no packages.
    pub fn package_roots(&self) -> &[String] {
        self.packages.as_ref().map_or(&[], |p| &p.roots)
    }

    /// This configuration with the manifest of channel `name` (one of
    /// [`Config::channels`]) as its source: what [`Config::check`] and the
    /// other methods then read. Fails for a name the package does not
    /// declare, so the app's code chooses among the package's sources and
    /// cannot add one.
    pub fn channel(&self, name: &str) -> Result<Config, Error> {
        let url = self.channels.get(name).ok_or_else(|| {
            Error::Config(format!(
                "channel {name:?}: the package declares no such channel (`\"updater\": {{ \"channels\" }}`)"
            ))
        })?;
        Ok(Config {
            github: None,
            url: Some(url.clone()),
            channels: BTreeMap::new(),
            ..self.clone()
        })
    }

    /// The manifest's URL.
    pub fn manifest_url(&self) -> String {
        match (&self.github, &self.url) {
            (Some(repo), _) => {
                format!("https://github.com/{repo}/releases/latest/download/{MANIFEST}")
            }
            (_, Some(url)) => url.clone(),
            _ => unreachable!("validated"),
        }
    }

    /// The signature's URL, next to the manifest; `None`: nothing to check.
    pub fn signature_url(&self) -> Option<String> {
        self.public_key.as_ref()?;
        Some(resolve(&self.manifest_url(), SIGNATURE))
    }

    /// What the manifest offers this machine (`platform`: [`platform`]), if
    /// it is newer than the running version. Fails on a bad signature, a
    /// manifest for another app, or a URL that is not HTTPS.
    pub fn check(
        &self,
        manifest: &[u8],
        signature: Option<&[u8]>,
        platform: &str,
    ) -> Result<Option<Available>, Error> {
        let parsed = self.open(manifest, signature)?;
        let version = semver::Version::parse(&parsed.version)
            .map_err(|e| Error::Manifest(format!("version {:?}: {e}", parsed.version)))?;
        let current =
            semver::Version::parse(&self.version).map_err(|e| Error::Config(e.to_string()))?;
        if version <= current {
            return Ok(None);
        }
        let Some(asset) = parsed.platforms.get(platform) else {
            return Ok(None);
        };
        let url = resolve(&self.manifest_url(), &asset.url);
        check_url(&url).map_err(Error::Manifest)?;
        let localized_notes = self.localized_notes(parsed.localized_notes)?;
        Ok(Some(Available {
            version: parsed.version,
            notes: parsed.notes,
            localized_notes,
            url,
            sha256: asset.sha256.clone(),
            size: asset.size,
            delta: self.delta(&asset.deltas)?,
        }))
    }

    /// The package the manifest offers, if the app takes packages, its
    /// build is newer than `running_build` (the running package's, or the
    /// shipped bundle's) and `runtime` (this runtime's version) runs it.
    /// Fails as [`Config::check`] does, and on a package entry without a
    /// SHA-256. The package itself is not trusted from this: whoever
    /// downloads it verifies its signature against [`Packages::roots`].
    pub fn check_package(
        &self,
        manifest: &[u8],
        signature: Option<&[u8]>,
        running_build: u64,
        runtime: &str,
    ) -> Result<Option<AvailablePackage>, Error> {
        if self.package_roots().is_empty() {
            return Ok(None);
        }
        let parsed = self.open(manifest, signature)?;
        let Some(package) = parsed.package else {
            return Ok(None);
        };
        if package.build <= running_build || !version_at_least(runtime, &package.min_runtime) {
            return Ok(None);
        }
        if package.sha256.is_empty() {
            return Err(Error::Manifest("the package has no sha256".into()));
        }
        let url = resolve(&self.manifest_url(), &package.url);
        check_url(&url).map_err(Error::Manifest)?;
        let localized_notes = self.localized_notes(parsed.localized_notes)?;
        Ok(Some(AvailablePackage {
            version: package.version,
            build: package.build,
            notes: parsed.notes,
            localized_notes,
            url,
            sha256: package.sha256,
            size: package.size,
        }))
    }

    /// The manifest's notes files, their URLs absolute and HTTPS.
    /// The patch of `deltas` from the running version, its URL absolute.
    fn delta(&self, deltas: &[Delta]) -> Result<Option<Delta>, Error> {
        let Some(delta) = deltas.iter().find(|delta| delta.from == self.version) else {
            return Ok(None);
        };
        let mut delta = delta.clone();
        delta.url = resolve(&self.manifest_url(), &delta.url);
        check_url(&delta.url).map_err(Error::Manifest)?;
        Ok(Some(delta))
    }

    fn localized_notes(
        &self,
        mut notes: BTreeMap<String, NotesFile>,
    ) -> Result<BTreeMap<String, NotesFile>, Error> {
        for file in notes.values_mut() {
            file.url = resolve(&self.manifest_url(), &file.url);
            check_url(&file.url).map_err(Error::Manifest)?;
        }
        Ok(notes)
    }

    /// The manifest, its signature checked. Its id is not checked against
    /// the app's: an update may move the app to a new id or name, and the
    /// signature, with the manifest's URL, decides what installs.
    fn open(&self, manifest: &[u8], signature: Option<&[u8]>) -> Result<Manifest, Error> {
        if let Some(key) = &self.public_key {
            let signature =
                signature.ok_or_else(|| Error::Manifest("the manifest is not signed".into()))?;
            verify(key, manifest, signature)?;
        }
        let parsed: Manifest =
            serde_json::from_slice(manifest).map_err(|e| Error::Manifest(e.to_string()))?;
        Ok(parsed)
    }
}

/// Whether semver-like `have` (`1.2.3`) is at least `needs`, as packages
/// compare their minimum runtime: missing parts count as 0, pre-release
/// and build suffixes are ignored.
pub fn version_at_least(have: &str, needs: &str) -> bool {
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

/// `latest.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Manifest {
    /// The app's id.
    pub id: String,
    /// The version it offers.
    pub version: String,
    /// What changed, for the app to show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// `notes` in other languages, by BCP 47 tag (`en`, `zh-TW`, `ja`):
    /// each a file of its own, so a client downloads only the one its user
    /// reads. Their hashes are here, under the manifest's signature. `notes`
    /// stays the text for every other language and for older runtimes,
    /// which ignore this.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub localized_notes: BTreeMap<String, NotesFile>,
    /// By [`platform`]: `linux-x86_64`, `macos-aarch64`, `android`, `ios`.
    /// Empty in a release that only has a package (still written: older
    /// runtimes require it).
    #[serde(default)]
    pub platforms: BTreeMap<String, Asset>,
    /// A signed package of the app's code, for every platform: apps that
    /// take packages run it without a new app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageAsset>,
}

/// The signed package (`.nshpkg`) of a [`Manifest`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PackageAsset {
    /// The package's version string (its `nsh.json` `"version"`).
    pub version: String,
    /// The package's build number: newer than the running one to be
    /// offered.
    pub build: u64,
    /// Where it is, absolute or relative to the manifest.
    pub url: String,
    /// The package's SHA-256, in hex.
    pub sha256: String,
    /// The package's size in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// The lowest runtime that runs it (`MAJOR.MINOR.PATCH`), as its
    /// header says.
    pub min_runtime: String,
}

/// A newer package of the app's code ([`Config::check_package`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct AvailablePackage {
    /// Its version string.
    pub version: String,
    /// Its build number.
    pub build: u64,
    /// What changed (the manifest's notes).
    pub notes: Option<String>,
    /// The manifest's notes in other languages, by BCP 47 tag, their URLs
    /// absolute.
    pub localized_notes: BTreeMap<String, NotesFile>,
    /// Where it is, absolute.
    pub url: String,
    /// Its SHA-256, in hex.
    pub sha256: String,
    /// Its size in bytes.
    pub size: Option<u64>,
}

/// One language's notes in a [`Manifest`]: a text file beside it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct NotesFile {
    /// Where it is, absolute or relative to the manifest.
    pub url: String,
    /// Its SHA-256, in hex.
    pub sha256: String,
}

/// The notes of `locale` (a BCP 47 tag) among `notes`: its own tag, else
/// its language's (`zh` for `zh-TW`), compared without case; `None`: show
/// the manifest's `notes`.
pub fn notes_for<'a>(
    notes: &'a BTreeMap<String, NotesFile>,
    locale: &str,
) -> Option<&'a NotesFile> {
    let find = |tag: &str| {
        notes
            .iter()
            .find(|(have, _)| have.eq_ignore_ascii_case(tag))
            .map(|(_, file)| file)
    };
    find(locale).or_else(|| find(locale.split(['-', '_']).next()?))
}

/// The notes in `bytes`, downloaded for `file`: its text when the hash
/// matches.
pub fn open_notes(file: &NotesFile, bytes: Vec<u8>) -> Result<String, Error> {
    if sha256(&bytes) != file.sha256.to_ascii_lowercase() {
        return Err(Error::Manifest(format!(
            "{}: not the notes the manifest names",
            file.url
        )));
    }
    String::from_utf8(bytes).map_err(|_| Error::Manifest(format!("{}: not UTF-8", file.url)))
}

/// One platform's entry of a [`Manifest`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Asset {
    /// Where it is, absolute or relative to the manifest. With no `sha256`,
    /// a page to send the user to (a store's).
    pub url: String,
    /// The archive's SHA-256, in hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// The archive's size in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Patches from earlier versions to this one ([`delta`]): an app
    /// running `from` downloads one instead of the archive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deltas: Vec<Delta>,
}

/// A zstd patch from the app of one version to the app of the
/// [`Manifest`]'s ([`delta`]). The app rebuilds its installed files as
/// [`delta::base`] does, checks them against `base`, applies the patch and
/// checks the result against `result`; on any difference it downloads the
/// archive instead.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Delta {
    /// The version it patches.
    pub from: String,
    /// The SHA-256 of that version's files, as [`delta::base`] writes them.
    pub base: String,
    /// Where the patch is, absolute or relative to the manifest.
    pub url: String,
    /// The patch's SHA-256, in hex.
    pub sha256: String,
    /// The patch's size in bytes.
    pub size: u64,
    /// The SHA-256 of what the patch makes: a `.tar` of the new app.
    pub result: String,
}

/// A newer version for this machine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Available {
    /// Its version.
    pub version: String,
    /// What changed.
    pub notes: Option<String>,
    /// What changed in other languages, by BCP 47 tag, their URLs
    /// absolute: [`notes_for`] picks one.
    pub localized_notes: BTreeMap<String, NotesFile>,
    /// Where it is, absolute.
    pub url: String,
    /// The archive's SHA-256; `None`: `url` is a page, not an archive.
    pub sha256: Option<String>,
    /// The archive's size.
    pub size: Option<u64>,
    /// The patch from the running version, if the manifest has one.
    pub delta: Option<Delta>,
}

/// This machine's key in [`Manifest::platforms`]: `<os>-<arch>` on the
/// desktop; `android`, `ios` or `harmonyos`, which update through a store or
/// a page (HarmonyOS's Rust target counts as Linux: `target_env = "ohos"`).
pub fn platform() -> String {
    let os = if cfg!(target_env = "ohos") {
        "harmonyos"
    } else {
        std::env::consts::OS
    };
    let arch = std::env::consts::ARCH;
    match os {
        "android" | "ios" | "harmonyos" => os.to_owned(),
        _ => format!("{os}-{arch}"),
    }
}

/// Signs a manifest's bytes with a secret key (`nsh keygen`'s `.secret`):
/// the contents of the `.sig`, base64.
pub fn sign(secret_key: &str, manifest: &[u8]) -> Result<String, Error> {
    let seed = decode32(secret_key, "secret key")?;
    let key = SigningKey::from_bytes(&seed);
    Ok(B64.encode(key.sign(&framed(manifest)).to_bytes()))
}

/// Checks a manifest's signature (the base64 of [`sign`]).
pub fn verify(public: &str, manifest: &[u8], signature: &[u8]) -> Result<(), Error> {
    let key = public_key(public)?;
    let bad = || Error::Manifest("the signature does not match the app's publicKey".to_owned());
    let text = std::str::from_utf8(signature).map_err(|_| bad())?;
    let bytes = B64.decode(text.trim()).map_err(|_| bad())?;
    let signature = Signature::from_slice(&bytes).map_err(|_| bad())?;
    key.verify_strict(&framed(manifest), &signature)
        .map_err(|_| bad())
}

fn framed(manifest: &[u8]) -> Vec<u8> {
    [CONTEXT, manifest].concat()
}

fn public_key(key: &str) -> Result<VerifyingKey, Error> {
    VerifyingKey::from_bytes(&decode32(key, "publicKey")?)
        .map_err(|e| Error::Config(format!("publicKey: {e}")))
}

fn decode32(text: &str, what: &str) -> Result<[u8; 32], Error> {
    B64.decode(text.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| Error::Config(format!("{what}: expected 32 bytes of base64")))
}

/// HTTPS only, or plain HTTP to this machine (a local test).
fn check_url(url: &str) -> Result<(), String> {
    let loopback = ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|prefix| {
            url.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
        });
    if url.starts_with("https://") || loopback {
        Ok(())
    } else {
        Err(format!("{url:?} is not an https:// URL"))
    }
}

/// `url` as an absolute URL, relative ones next to `base`.
fn resolve(base: &str, url: &str) -> String {
    if url.contains("://") {
        return url.to_owned();
    }
    let path_end = base.find(['?', '#']).unwrap_or(base.len());
    match base[..path_end].rfind('/') {
        Some(slash) => format!("{}{url}", &base[..=slash]),
        None => url.to_owned(),
    }
}

/// An archive as it arrives: refuses more bytes than the manifest says, and
/// [`Download::finish`] anything but its hash and size.
#[derive(Debug)]
pub struct Download {
    hash: Sha256,
    received: u64,
    sha256: String,
    size: Option<u64>,
}

impl Download {
    /// Starts one, for what the manifest says of it.
    pub fn new(sha256: &str, size: Option<u64>) -> Download {
        Download {
            hash: Sha256::new(),
            received: 0,
            sha256: sha256.to_ascii_lowercase(),
            size,
        }
    }

    /// Counts and hashes `chunk`; the bytes so far.
    pub fn update(&mut self, chunk: &[u8]) -> Result<u64, Error> {
        self.received += chunk.len() as u64;
        if self.size.is_some_and(|size| self.received > size) {
            return Err(Error::Download(format!(
                "more than the {} bytes the manifest says",
                self.size.unwrap_or_default()
            )));
        }
        self.hash.update(chunk);
        Ok(self.received)
    }

    /// Whether what arrived is what the manifest says.
    pub fn finish(self) -> Result<(), Error> {
        if let Some(size) = self.size
            && size != self.received
        {
            return Err(Error::Download(format!(
                "{} bytes, the manifest says {size}",
                self.received
            )));
        }
        let actual = hex(&self.hash.finalize());
        if actual != self.sha256 {
            return Err(Error::Download(format!(
                "SHA-256 {actual}, the manifest says {}",
                self.sha256
            )));
        }
        Ok(())
    }
}

/// The SHA-256 of `bytes` in hex, as a manifest has it.
pub fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

    fn public() -> String {
        let seed = decode32(SECRET, "").unwrap();
        B64.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes())
    }

    fn config() -> Config {
        Config {
            id: "com.example.app".into(),
            version: "1.2.0".into(),
            github: Some("owner/repo".into()),
            ..Config::default()
        }
    }

    fn manifest(version: &str, url: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "id": "com.example.app",
            "version": version,
            "platforms": { "linux-x86_64": { "url": url, "sha256": "ab", "size": 2 } },
        }))
        .unwrap()
    }

    #[test]
    fn localized_notes_are_files_beside_the_manifest() {
        let zh_tw = sha256("修復".as_bytes());
        let bytes = serde_json::to_vec(&serde_json::json!({
            "id": "com.example.app",
            "version": "2.0.0",
            "notes": "Fixes",
            "localizedNotes": {
                "zh-TW": { "url": "notes.zh-TW.md", "sha256": zh_tw },
                "ja": { "url": "https://cdn.example.com/notes.ja.md", "sha256": "ab" },
            },
            "platforms": { "linux-x86_64": { "url": "a.tar.gz", "sha256": "ab", "size": 2 } },
        }))
        .unwrap();
        let available = config()
            .check(&bytes, None, "linux-x86_64")
            .unwrap()
            .unwrap();
        assert_eq!(available.notes.as_deref(), Some("Fixes"));
        let file = notes_for(&available.localized_notes, "zh-tw").unwrap();
        assert_eq!(
            file.url,
            "https://github.com/owner/repo/releases/latest/download/notes.zh-TW.md"
        );
        assert_eq!(
            open_notes(file, "修復".as_bytes().to_vec()).unwrap(),
            "修復"
        );
        assert!(open_notes(file, b"tampered".to_vec()).is_err());
        assert_eq!(
            notes_for(&available.localized_notes, "ja-JP").unwrap().url,
            "https://cdn.example.com/notes.ja.md"
        );
        assert!(notes_for(&available.localized_notes, "zh-CN").is_none());
        assert!(notes_for(&available.localized_notes, "en").is_none());
        // A manifest without them reads as before, and writes as before.
        let plain = config()
            .check(&manifest("2.0.0", "a.tar.gz"), None, "linux-x86_64")
            .unwrap()
            .unwrap();
        assert!(plain.localized_notes.is_empty());
        let written = serde_json::to_value(Manifest::default()).unwrap();
        assert!(written.get("localizedNotes").is_none());
        // Notes over plain HTTP are refused as archives are.
        let http = serde_json::to_vec(&serde_json::json!({
            "id": "com.example.app",
            "version": "2.0.0",
            "localizedNotes": { "ja": { "url": "http://x.dev/ja.md", "sha256": "ab" } },
            "platforms": { "linux-x86_64": { "url": "a.tar.gz", "sha256": "ab", "size": 2 } },
        }))
        .unwrap();
        assert!(config().check(&http, None, "linux-x86_64").is_err());
    }

    #[test]
    fn github_reads_the_latest_release_without_the_api() {
        assert_eq!(
            config().manifest_url(),
            "https://github.com/owner/repo/releases/latest/download/latest.json"
        );
    }

    #[test]
    fn a_config_has_one_good_source() {
        assert!(config().validate().is_ok());
        for repo in ["owner", "a/b/c", "a/", "/b", "a/b?c"] {
            let config = Config {
                github: Some(repo.into()),
                ..config()
            };
            assert!(config.validate().is_err(), "{repo}");
        }
        let none = Config {
            github: None,
            ..config()
        };
        assert!(none.validate().is_err());
        let both = Config {
            url: Some("https://x.dev/latest.json".into()),
            public_key: Some(public()),
            ..config()
        };
        assert!(both.validate().is_err());
    }

    #[test]
    fn a_custom_host_needs_a_key_and_https() {
        let custom = |url: &str, key| Config {
            github: None,
            url: Some(url.into()),
            public_key: key,
            ..config()
        };
        assert!(
            custom("https://x.dev/latest.json", None)
                .validate()
                .is_err()
        );
        assert!(
            custom("http://x.dev/latest.json", Some(public()))
                .validate()
                .is_err()
        );
        assert!(
            custom("http://localhost.evil.dev/l.json", Some(public()))
                .validate()
                .is_err()
        );
        assert!(
            custom("https://x.dev/latest.json", Some(public()))
                .validate()
                .is_ok()
        );
    }

    fn with_channels(channels: &[(&str, &str)]) -> Config {
        Config {
            public_key: Some(public()),
            channels: channels
                .iter()
                .map(|(name, url)| ((*name).to_owned(), (*url).to_owned()))
                .collect(),
            ..config()
        }
    }

    #[test]
    fn channels_need_names_https_and_a_key() {
        assert!(
            with_channels(&[("beta", "https://x.dev/beta/latest.json")])
                .validate()
                .is_ok()
        );
        assert!(
            with_channels(&[("beta", "http://x.dev/beta/latest.json")])
                .validate()
                .is_err()
        );
        for name in ["", "a b", "a/b"] {
            assert!(
                with_channels(&[(name, "https://x.dev/l.json")])
                    .validate()
                    .is_err(),
                "{name:?}"
            );
        }
        let unsigned = Config {
            public_key: None,
            ..with_channels(&[("beta", "https://x.dev/beta/latest.json")])
        };
        assert!(unsigned.validate().is_err());
        // The packaged file keeps them; one without any reads as before.
        let beta = with_channels(&[("beta", "https://x.dev/beta/latest.json")]);
        let bytes = serde_json::to_vec(&beta).unwrap();
        assert_eq!(Config::parse(&bytes).unwrap(), beta);
        let plain = serde_json::to_value(config()).unwrap();
        assert!(plain.get("channels").is_none());
    }

    #[test]
    fn a_channel_is_chosen_by_a_declared_name_only() {
        let config = with_channels(&[("beta", "https://x.dev/beta/latest.json")]);
        let beta = config.channel("beta").unwrap();
        assert_eq!(beta.manifest_url(), "https://x.dev/beta/latest.json");
        assert_eq!(
            beta.signature_url().as_deref(),
            Some("https://x.dev/beta/latest.json.sig")
        );
        assert!(beta.validate().is_ok());
        assert!(config.channel("nightly").is_err());
        assert!(config.channel("https://evil.dev/latest.json").is_err());
        // The default source stays the package's own.
        assert_eq!(
            config.manifest_url(),
            "https://github.com/owner/repo/releases/latest/download/latest.json"
        );
        // Archives resolve next to the channel's manifest; the signature,
        // the id and the newer version are checked as on the default.
        let bytes = manifest("2.0.0", "a.tar.gz");
        let signature = sign(SECRET, &bytes).unwrap();
        let available = beta
            .check(&bytes, Some(signature.as_bytes()), "linux-x86_64")
            .unwrap()
            .unwrap();
        assert_eq!(available.url, "https://x.dev/beta/a.tar.gz");
        assert!(beta.check(&bytes, None, "linux-x86_64").is_err());
        let older = manifest("1.1.0", "a.tar.gz");
        let signature = sign(SECRET, &older).unwrap();
        assert!(
            beta.check(&older, Some(signature.as_bytes()), "linux-x86_64")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn the_patch_from_the_running_version_is_offered() {
        let delta = |from: &str| {
            serde_json::json!({ "from": from, "base": "aa", "url": format!("from-{from}.patch"),
                                "sha256": "bb", "size": 3, "result": "cc" })
        };
        let manifest = |deltas: serde_json::Value| {
            serde_json::to_vec(&serde_json::json!({
                "id": "com.example.app", "version": "1.3.0",
                "platforms": { "linux-x86_64": { "url": "a.tar.gz", "sha256": "ab", "size": 2,
                                                 "deltas": deltas } },
            }))
            .unwrap()
        };
        let check = |bytes: Vec<u8>| {
            config()
                .check(&bytes, None, "linux-x86_64")
                .unwrap()
                .unwrap()
        };
        let available = check(manifest(serde_json::json!([
            delta("1.1.0"),
            delta("1.2.0")
        ])));
        let offered = available.delta.unwrap();
        assert_eq!(offered.from, "1.2.0");
        assert_eq!(
            offered.url,
            "https://github.com/owner/repo/releases/latest/download/from-1.2.0.patch"
        );
        assert!(
            check(manifest(serde_json::json!([delta("1.1.0")])))
                .delta
                .is_none()
        );
        // Older manifests have none.
        assert!(check(manifest(serde_json::json!([]))).delta.is_none());
    }

    #[test]
    fn only_a_newer_version_for_this_platform_is_offered() {
        let check = |version: &str, platform: &str| {
            config()
                .check(&manifest(version, "app.tar.gz"), None, platform)
                .unwrap()
        };
        assert!(check("1.2.0", "linux-x86_64").is_none());
        assert!(check("1.1.9", "linux-x86_64").is_none());
        assert!(check("1.3.0", "macos-aarch64").is_none());
        let available = check("1.10.0", "linux-x86_64").unwrap();
        assert_eq!(available.version, "1.10.0");
        assert_eq!(
            available.url,
            "https://github.com/owner/repo/releases/latest/download/app.tar.gz"
        );
    }

    #[test]
    fn signatures_are_checked_when_a_key_is_set() {
        let signed = Config {
            public_key: Some(public()),
            ..config()
        };
        let bytes = manifest("2.0.0", "a.tar.gz");
        let signature = sign(SECRET, &bytes).unwrap();
        assert!(
            signed
                .check(&bytes, Some(signature.as_bytes()), "linux-x86_64")
                .unwrap()
                .is_some()
        );
        // Unsigned, tampered with, signed by another key.
        assert!(signed.check(&bytes, None, "linux-x86_64").is_err());
        let tampered = manifest("3.0.0", "a.tar.gz");
        assert!(
            signed
                .check(&tampered, Some(signature.as_bytes()), "linux-x86_64")
                .is_err()
        );
        let other = sign("AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=", &bytes).unwrap();
        assert!(
            signed
                .check(&bytes, Some(other.as_bytes()), "linux-x86_64")
                .is_err()
        );
    }

    #[test]
    fn a_manifest_of_another_id_is_taken_plain_http_is_refused() {
        // An app moving to a new id: the signature binds, not the id.
        let other = manifest("2.0.0", "https://x.dev/a.tar.gz");
        let other = String::from_utf8(other)
            .unwrap()
            .replace("com.example.app", "com.other");
        let found = config()
            .check(other.as_bytes(), None, "linux-x86_64")
            .unwrap()
            .unwrap();
        assert_eq!(found.version, "2.0.0");
        let plain = manifest("2.0.0", "http://x.dev/a.tar.gz");
        assert!(config().check(&plain, None, "linux-x86_64").is_err());
    }

    fn takes_packages() -> Config {
        Config {
            build: Some(3),
            packages: Some(Packages {
                roots: vec![public()],
            }),
            ..config()
        }
    }

    fn package_manifest(build: u64, min_runtime: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "id": "com.example.app",
            "version": "1.2.0",
            "notes": "Fixes",
            "package": {
                "version": "1.2.1", "build": build, "url": "com.example.app-5.nshpkg",
                "sha256": "ab", "size": 2, "minRuntime": min_runtime,
            },
        }))
        .unwrap()
    }

    #[test]
    fn package_roots_are_keys() {
        assert!(takes_packages().validate().is_ok());
        let none = Config {
            packages: Some(Packages { roots: vec![] }),
            ..config()
        };
        assert!(none.validate().is_err());
        let bad = Config {
            packages: Some(Packages {
                roots: vec!["not a key".into()],
            }),
            ..config()
        };
        assert!(bad.validate().is_err());
        // The packaged file keeps them.
        let bytes = serde_json::to_vec(&takes_packages()).unwrap();
        assert_eq!(Config::parse(&bytes).unwrap(), takes_packages());
    }

    #[test]
    fn only_a_newer_package_this_runtime_runs_is_offered() {
        let check = |config: &Config, build, min: &str, running| {
            config
                .check_package(&package_manifest(build, min), None, running, "0.5.0")
                .unwrap()
        };
        let available = check(&takes_packages(), 5, "0.5.0", 3).unwrap();
        assert_eq!((available.version.as_str(), available.build), ("1.2.1", 5));
        assert_eq!(available.notes.as_deref(), Some("Fixes"));
        assert_eq!(
            available.url,
            "https://github.com/owner/repo/releases/latest/download/com.example.app-5.nshpkg"
        );
        // Not newer than what runs, a newer runtime needed, or no roots.
        assert!(check(&takes_packages(), 5, "0.5.0", 5).is_none());
        assert!(check(&takes_packages(), 2, "0.5.0", 3).is_none());
        assert!(check(&takes_packages(), 5, "0.6.0", 3).is_none());
        assert!(check(&takes_packages(), 5, "0.5.0-beta.1", 3).is_some());
        assert!(check(&config(), 5, "0.5.0", 3).is_none());
        // A manifest without a package, or of only a package.
        let plain = manifest("1.3.0", "a.tar.gz");
        assert!(
            takes_packages()
                .check_package(&plain, None, 3, "0.5.0")
                .unwrap()
                .is_none()
        );
        assert!(
            takes_packages()
                .check(&package_manifest(5, "0.5.0"), None, "linux-x86_64")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn package_manifests_are_checked_as_others() {
        let signed = Config {
            public_key: Some(public()),
            ..takes_packages()
        };
        let bytes = package_manifest(5, "0.1.0");
        assert!(signed.check_package(&bytes, None, 3, "0.5.0").is_err());
        let signature = sign(SECRET, &bytes).unwrap();
        assert!(
            signed
                .check_package(&bytes, Some(signature.as_bytes()), 3, "0.5.0")
                .unwrap()
                .is_some()
        );
        let plain = serde_json::to_vec(&serde_json::json!({
            "id": "com.example.app", "version": "1.0.0",
            "package": { "version": "1", "build": 9, "url": "http://x.dev/p.nshpkg",
                         "sha256": "ab", "minRuntime": "0.1.0" },
        }))
        .unwrap();
        assert!(
            takes_packages()
                .check_package(&plain, None, 3, "0.5.0")
                .is_err()
        );
    }

    #[test]
    fn downloads_must_match_the_manifest() {
        let bytes = b"archive";
        let mut good = Download::new(&sha256(bytes), Some(7));
        assert_eq!(good.update(bytes).unwrap(), 7);
        assert!(good.finish().is_ok());

        let mut wrong = Download::new(&sha256(b"other!!"), Some(7));
        wrong.update(bytes).unwrap();
        assert!(wrong.finish().is_err());

        let mut long = Download::new(&sha256(bytes), Some(3));
        assert!(long.update(bytes).is_err());

        let mut short = Download::new(&sha256(b"arc"), Some(7));
        short.update(b"arc").unwrap();
        assert!(short.finish().is_err());
    }
}
