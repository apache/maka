//! `.nshpkg`: building and verifying packages.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{
    Error,
    keys::{PublicKey, SecretKey, hex},
    trust::Certificate,
};

const MAGIC: &[u8; 4] = b"NSHP";
const FORMAT: u16 = 1;
const PREFIX: usize = 12;
const SIGNATURE: usize = 64;
const MAX_HEADER: usize = 16 << 20;
const PACKAGE: &str = "nsh-package-v1";

/// The app a package holds (from its `nsh.json`). Fields a newer signer
/// added are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct App {
    /// Reverse-DNS id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Version string (`1.2.0`).
    pub version: String,
    /// Build number: increases with every release; older builds are refused
    /// once a newer one was accepted.
    pub build: u64,
}

/// What a file in a package is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    /// The bundle's JS source.
    Source,
    /// The bundle as QuickJS bytecode.
    Bytecode,
    /// The source map.
    SourceMap,
    /// An asset (`asset:/<path>`).
    Asset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileEntry {
    path: String,
    /// `None`: a kind of a newer runtime.
    #[serde(with = "file_kind")]
    kind: Option<FileKind>,
    offset: u64,
    size: u64,
    sha256: String,
    /// Fields of a newer runtime, which may change what the bytes are.
    #[serde(flatten, skip_serializing)]
    unknown: BTreeMap<String, serde_json::Value>,
}

impl FileEntry {
    /// What the file is, if this runtime knows how to read it: a newer
    /// kind, or a field that may change what its bytes are (compressed,
    /// say), leaves it unused (it is still hashed).
    fn known_kind(&self) -> Option<FileKind> {
        self.kind.filter(|_| self.unknown.is_empty())
    }
}

/// [`FileKind`] or, for a kind this runtime does not know, `None`.
mod file_kind {
    use serde::{Deserialize as _, Deserializer, Serialize as _, Serializer};

    use super::FileKind;

    pub(super) fn serialize<S: Serializer>(
        kind: &Option<FileKind>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        kind.expect("packages are written with known kinds")
            .serialize(s)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<FileKind>, D::Error> {
        let kind = String::deserialize(d)?;
        Ok(serde_json::from_value(serde_json::Value::String(kind)).ok())
    }
}

/// A package's header (JSON). Nothing in it is believed before the
/// signature checks out. Fields a newer signer added are ignored, unless
/// `critical` names them (see the crate's "Format evolution").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    app: App,
    /// What the app declares it may reach (`nsh.json` `capabilities`).
    capabilities: Option<serde_json::Value>,
    /// The `BYTECODE_VERSION` its bytecode was compiled for.
    bytecode_version: String,
    /// The lowest runtime that runs it.
    min_runtime: String,
    /// Unix seconds when it was signed.
    created_at: u64,
    /// The release key's certificate.
    certificate: Certificate,
    files: Vec<FileEntry>,
    /// Fields a runtime must understand to run the package: a runtime that
    /// does not know one of them refuses it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    critical: Vec<String>,
    /// Fields of a newer runtime.
    #[serde(flatten, skip_serializing)]
    unknown: BTreeMap<String, serde_json::Value>,
}

/// What goes into a package.
#[derive(Debug, Clone)]
pub struct Contents {
    /// The app.
    pub app: App,
    /// Its declared capabilities (JSON form), if any.
    pub capabilities: Option<serde_json::Value>,
    /// The bundle's JS source.
    pub source: String,
    /// The bundle as bytecode, and the `BYTECODE_VERSION` it was compiled for.
    pub bytecode: Option<(Vec<u8>, String)>,
    /// The source map.
    pub source_map: Option<String>,
    /// Assets: path (as in `asset:/<path>`) and bytes.
    pub assets: Vec<(String, Vec<u8>)>,
    /// The lowest runtime that runs it, `MAJOR.MINOR.PATCH` (default: this
    /// one, [`crate::RUNTIME_VERSION`]). Older runtimes refuse the package;
    /// it must not be newer than this runtime.
    pub min_runtime: Option<String>,
}

fn check_path(path: &str) -> Result<(), Error> {
    // Assets are written under a directory with `Path::join`: on Windows a
    // `C:` segment would replace that directory and `name:stream` would
    // write an NTFS alternate data stream, so `:` is refused with `\`.
    let ok = !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..");
    if ok {
        Ok(())
    } else {
        Err(Error::Format(format!("invalid file path `{path}`")))
    }
}

/// Builds a package signed by `key`, which `certificate` certifies (it must
/// cover the app now). A minimum runtime must pass
/// [`crate::check_min_runtime`].
pub fn build(
    contents: &Contents,
    key: &SecretKey,
    certificate: &Certificate,
) -> Result<Vec<u8>, Error> {
    let claimed = certificate.claimed()?;
    if claimed.key != key.public() {
        return Err(Error::Certificate("it certifies another key".into()));
    }
    let created_at = crate::now();
    // Devices would refuse it: fail here instead.
    claimed.covers(&contents.app.id, created_at)?;
    if let Some(min) = &contents.min_runtime {
        crate::check_min_runtime(min).map_err(Error::Format)?;
    }
    assemble(contents, key, certificate, created_at)
}

/// Signs a package again with `key`, which `certificate` certifies (it must
/// cover the package's app now): for a platform that signs, with the key
/// its apps trust, what builds signed with keys of their own.
///
/// Only the certificate, the signing time and the signature change. The
/// files and every other header field stay as the first signer wrote them,
/// those a newer signer added included, and so does the minimum runtime,
/// which the tool that built the package knew. The package must be intact:
/// signed by its own certificate's key, its file table covering the data
/// and each file matching its hash. Whether a root trusts that certificate
/// is not checked: the new signer vouches for the package from now on, its
/// bytecode included.
pub fn resign(bytes: &[u8], key: &SecretKey, certificate: &Certificate) -> Result<Vec<u8>, Error> {
    let (header, data_start, signed) = self_signed(bytes)?;
    check_tiling(&header, data_start, signed)?;
    for file in &header.files {
        file_data(bytes, data_start, signed, file)?;
    }
    let claimed = certificate.claimed()?;
    if claimed.key != key.public() {
        return Err(Error::Certificate("it certifies another key".into()));
    }
    let created_at = crate::now();
    // Devices would refuse it: fail here instead.
    claimed.covers(&header.app.id, created_at)?;
    // The header as JSON: `Header` drops the fields this runtime does not
    // know, and dropping one `critical` names would lift its restriction.
    let mut json: serde_json::Value = serde_json::from_slice(&bytes[PREFIX..data_start])
        .map_err(|e| Error::Format(format!("header: {e}")))?;
    let fields = json
        .as_object_mut()
        .ok_or_else(|| Error::Format("the header is not an object".into()))?;
    fields.insert(
        "certificate".into(),
        serde_json::to_value(certificate).expect("serializable"),
    );
    fields.insert("createdAt".into(), created_at.into());
    let json = serde_json::to_vec(&json).expect("serializable");
    let mut out = Vec::with_capacity(PREFIX + json.len() + (signed - data_start) + SIGNATURE);
    // The magic, format and flags as they were.
    out.extend_from_slice(&bytes[..8]);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(&bytes[data_start..signed]);
    let signature = key.sign(PACKAGE, &out);
    out.extend_from_slice(&signature);
    Ok(out)
}

/// The package bytes, signed by `key`, without checking the certificate.
fn assemble(
    contents: &Contents,
    key: &SecretKey,
    certificate: &Certificate,
    created_at: u64,
) -> Result<Vec<u8>, Error> {
    let mut blobs: Vec<(String, FileKind, &[u8])> = vec![(
        "bundle.js".into(),
        FileKind::Source,
        contents.source.as_bytes(),
    )];
    let mut bytecode_version = String::new();
    if let Some((bytecode, version)) = &contents.bytecode {
        blobs.push(("bundle.nshc".into(), FileKind::Bytecode, bytecode));
        bytecode_version = version.clone();
    }
    if let Some(map) = &contents.source_map {
        blobs.push(("bundle.js.map".into(), FileKind::SourceMap, map.as_bytes()));
    }
    for (path, bytes) in &contents.assets {
        check_path(path)?;
        blobs.push((path.clone(), FileKind::Asset, bytes));
    }
    let mut files = Vec::with_capacity(blobs.len());
    let mut offset = 0u64;
    for (path, kind, data) in &blobs {
        files.push(FileEntry {
            path: path.clone(),
            kind: Some(*kind),
            offset,
            size: data.len() as u64,
            sha256: hex(&Sha256::digest(data)),
            unknown: BTreeMap::new(),
        });
        offset += data.len() as u64;
    }
    let header = Header {
        app: contents.app.clone(),
        capabilities: contents.capabilities.clone(),
        bytecode_version,
        min_runtime: contents
            .min_runtime
            .clone()
            .unwrap_or_else(|| crate::RUNTIME_VERSION.to_owned()),
        created_at,
        certificate: certificate.clone(),
        files,
        critical: Vec::new(),
        unknown: BTreeMap::new(),
    };
    let header = serde_json::to_vec(&header).expect("serializable");
    let mut out = Vec::with_capacity(PREFIX + header.len() + offset as usize + SIGNATURE);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    for (_, _, data) in &blobs {
        out.extend_from_slice(data);
    }
    let signature = key.sign(PACKAGE, &out);
    out.extend_from_slice(&signature);
    Ok(out)
}

/// A package whose certificate, signature and hashes checked out. Only
/// [`crate::TrustStore::verify`] makes one (`non_exhaustive`), so holding
/// one is proof of verification — the only way to bytecode from a file.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct VerifiedPackage {
    /// The app.
    pub app: App,
    /// Its declared capabilities (JSON form), if any.
    pub capabilities: Option<serde_json::Value>,
    /// The bundle's JS source.
    pub source: String,
    /// Bytecode for this runtime (`None` when it was compiled for another).
    bytecode: Option<Vec<u8>>,
    /// The source map.
    pub source_map: Option<String>,
    /// Assets: path and bytes.
    pub assets: Vec<(String, Vec<u8>)>,
    /// SHA-256 of the whole package (hex): its identity for revocation.
    pub sha256: String,
    /// The release key's id.
    pub key_id: String,
    /// When it was signed (Unix seconds).
    pub created_at: u64,
    /// What this runtime left unused, as a newer signer wrote it: top-level
    /// header fields it does not know, files of kinds (or with fields) it
    /// does not know. Unknown `app` fields are ignored without a mention.
    /// Worth logging; the package is valid without them.
    pub ignored: Vec<String>,
}

impl VerifiedPackage {
    /// The bundle's bytecode, compiled for this runtime: safe to load, as
    /// its signature and hash were verified.
    pub fn bytecode(&self) -> Option<&[u8]> {
        self.bytecode.as_deref()
    }

    /// What accepting it later records ([`crate::TrustStore::accept_receipt`]),
    /// without keeping its files.
    pub fn receipt(&self) -> PackageReceipt {
        PackageReceipt {
            app: self.app.clone(),
            sha256: self.sha256.clone(),
            key_id: self.key_id.clone(),
        }
    }
}

/// A verified package's identity: what [`crate::TrustStore::accept_receipt`]
/// records once the embedding app decided to keep the package. Only
/// [`VerifiedPackage::receipt`] makes one (`non_exhaustive`), so a receipt
/// always stands for a package that was verified.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PackageReceipt {
    /// The app.
    pub app: App,
    /// SHA-256 of the whole package (hex).
    pub sha256: String,
    /// The release key's id.
    pub key_id: String,
}

/// Reads the header of `bytes` (unverified), where the files start and the
/// signed length.
fn header(bytes: &[u8]) -> Result<(Header, usize, usize), Error> {
    if bytes.len() < PREFIX + SIGNATURE || &bytes[..4] != MAGIC {
        return Err(Error::Format("bad magic".into()));
    }
    let format = u16::from_le_bytes([bytes[4], bytes[5]]);
    if format != FORMAT {
        return Err(Error::Format(format!(
            "format {format}, this runtime reads {FORMAT}"
        )));
    }
    let len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let signed = bytes.len() - SIGNATURE;
    if len > MAX_HEADER || PREFIX + len > signed {
        return Err(Error::Format("header length out of range".into()));
    }
    let header: Header = serde_json::from_slice(&bytes[PREFIX..PREFIX + len])
        .map_err(|e| Error::Format(format!("header: {e}")))?;
    Ok((header, PREFIX + len, signed))
}

/// Checks only the package signature against its own certificate's key —
/// for `nsh verify` without a root. Returns the header.
pub fn verify_signature(bytes: &[u8]) -> Result<Header, Error> {
    self_signed(bytes).map(|(header, ..)| header)
}

/// [`verify_signature`], with where the files start and the signed length.
fn self_signed(bytes: &[u8]) -> Result<(Header, usize, usize), Error> {
    let (header, data_start, signed) = header(bytes)?;
    let key = header.certificate.claimed_key()?;
    if !key.verify(PACKAGE, &bytes[..signed], &bytes[signed..]) {
        return Err(Error::BadSignature);
    }
    Ok((header, data_start, signed))
}

/// The source map in a package, checked against its hash, after checking
/// only the package signature against its own certificate's key (as
/// [`verify_signature`]): for tools that map the stacks of errors a package
/// reported to the app's sources (`nsh symbolicate`).
pub fn source_map(bytes: &[u8]) -> Result<Option<String>, Error> {
    let (header, data_start, signed) = self_signed(bytes)?;
    let Some(file) = header
        .files
        .iter()
        .find(|f| f.known_kind() == Some(FileKind::SourceMap))
    else {
        return Ok(None);
    };
    let data = file_data(bytes, data_start, signed, file)?;
    String::from_utf8(data.to_vec())
        .map(Some)
        .map_err(|_| Error::Format("the source map is not UTF-8".into()))
}

/// Checks that the files tile the data exactly: nothing unaccounted for.
fn check_tiling(header: &Header, data_start: usize, signed: usize) -> Result<(), Error> {
    let total = header
        .files
        .iter()
        .try_fold(0u64, |sum, f| sum.checked_add(f.size));
    if total != Some((signed - data_start) as u64) {
        return Err(Error::Format(
            "the file table does not match the data".into(),
        ));
    }
    Ok(())
}

/// The bytes of `file`, checked against its hash.
fn file_data<'a>(
    bytes: &'a [u8],
    data_start: usize,
    signed: usize,
    file: &FileEntry,
) -> Result<&'a [u8], Error> {
    let begin = data_start
        .checked_add(file.offset as usize)
        .filter(|&b| b <= signed)
        .ok_or_else(|| Error::Format(format!("file `{}` out of range", file.path)))?;
    let end = begin
        .checked_add(file.size as usize)
        .filter(|&e| e <= signed)
        .ok_or_else(|| Error::Format(format!("file `{}` out of range", file.path)))?;
    let data = &bytes[begin..end];
    if hex(&Sha256::digest(data)) != file.sha256 {
        return Err(Error::Integrity(file.path.clone()));
    }
    Ok(data)
}

impl Header {
    /// The app.
    pub fn app(&self) -> &App {
        &self.app
    }

    /// The lowest runtime that runs the package (`0.2.0`).
    pub fn min_runtime(&self) -> &str {
        &self.min_runtime
    }
}

/// Verifies `bytes` against `roots`, refusing revoked release keys.
pub(crate) fn open(
    bytes: &[u8],
    roots: &[PublicKey],
    revoked_keys: &BTreeSet<String>,
    bytecode_version: &str,
) -> Result<VerifiedPackage, Error> {
    let (header, data_start, signed) = header(bytes)?;
    // The certificate first: it says which key may have signed.
    let certified = header.certificate.open(roots)?;
    let key_id = certified.key.id();
    if revoked_keys.contains(&key_id) {
        return Err(Error::Revoked(format!("release key {key_id}")));
    }
    if !certified
        .key
        .verify(PACKAGE, &bytes[..signed], &bytes[signed..])
    {
        return Err(Error::BadSignature);
    }
    // Signed: the header can be believed from here on.
    if let Some(field) = header
        .critical
        .iter()
        .find(|f| header.unknown.contains_key(f.as_str()))
    {
        return Err(Error::Format(format!(
            "it needs `{field}`, which this runtime does not support (a newer runtime does)"
        )));
    }
    certified.covers(&header.app.id, header.created_at)?;
    if !crate::version_at_least(crate::RUNTIME_VERSION, &header.min_runtime) {
        return Err(Error::RuntimeTooOld {
            needs: header.min_runtime.clone(),
            runtime: crate::RUNTIME_VERSION.to_owned(),
        });
    }
    check_tiling(&header, data_start, signed)?;
    let mut package = VerifiedPackage {
        app: header.app.clone(),
        capabilities: header.capabilities.clone(),
        source: String::new(),
        bytecode: None,
        source_map: None,
        assets: Vec::new(),
        sha256: hex(&Sha256::digest(bytes)),
        key_id,
        created_at: header.created_at,
        ignored: header
            .unknown
            .keys()
            .map(|field| format!("header field `{field}`"))
            .collect(),
    };
    let mut seen_source = false;
    for file in &header.files {
        let data = file_data(bytes, data_start, signed, file)?;
        let Some(kind) = file.known_kind() else {
            package.ignored.push(format!("file `{}`", file.path));
            continue;
        };
        match kind {
            FileKind::Source => {
                package.source = String::from_utf8(data.to_vec())
                    .map_err(|_| Error::Format("source is not UTF-8".into()))?;
                seen_source = true;
            }
            FileKind::Bytecode if header.bytecode_version == bytecode_version => {
                package.bytecode = Some(data.to_vec());
            }
            // Compiled for another runtime: the source runs instead.
            FileKind::Bytecode => {}
            FileKind::SourceMap => package.source_map = String::from_utf8(data.to_vec()).ok(),
            FileKind::Asset => {
                check_path(&file.path)?;
                package.assets.push((file.path.clone(), data.to_vec()));
            }
        }
    }
    if !seen_source {
        return Err(Error::Format("no bundle source".into()));
    }
    Ok(package)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TrustStore, certify};

    fn contents(id: &str) -> Contents {
        Contents {
            app: App {
                id: id.into(),
                name: "Demo".into(),
                version: "1.0.0".into(),
                build: 1,
            },
            capabilities: None,
            source: "1".into(),
            bytecode: None,
            source_map: None,
            assets: Vec::new(),
            min_runtime: None,
        }
    }

    /// A signer that skips its own checks still cannot get past a device.
    #[test]
    fn devices_check_the_certificate_themselves() {
        let root = SecretKey::generate().unwrap();
        let release = SecretKey::generate().unwrap();
        let mut store = TrustStore::new();
        store.add_root(root.public());
        let cert = certify(
            &root,
            &release.public(),
            &["com.longbridge.*".into()],
            100,
            200,
        );

        let ok = assemble(&contents("com.longbridge.demo"), &release, &cert, 150).unwrap();
        assert!(store.verify(&ok, "v").is_ok());
        let other_app = assemble(&contents("com.evil.app"), &release, &cert, 150).unwrap();
        assert!(
            matches!(store.verify(&other_app, "v"), Err(Error::Certificate(m)) if m.contains("com.evil.app"))
        );
        let late = assemble(&contents("com.longbridge.demo"), &release, &cert, 201).unwrap();
        assert!(
            matches!(store.verify(&late, "v"), Err(Error::Certificate(m)) if m.contains("outside"))
        );
        let early = assemble(&contents("com.longbridge.demo"), &release, &cert, 99).unwrap();
        assert!(store.verify(&early, "v").is_err());
        // Another key's certificate.
        let thief = SecretKey::generate().unwrap();
        let stolen = assemble(&contents("com.longbridge.demo"), &thief, &cert, 150).unwrap();
        assert!(matches!(
            store.verify(&stolen, "v"),
            Err(Error::BadSignature)
        ));
    }

    /// A package for a newer runtime is refused with both versions named.
    #[test]
    fn devices_refuse_packages_for_newer_runtimes() {
        let root = SecretKey::generate().unwrap();
        let release = SecretKey::generate().unwrap();
        let mut store = TrustStore::new();
        store.add_root(root.public());
        let cert = certify(&root, &release.public(), &["*".into()], 0, u64::MAX);
        let newer = Contents {
            min_runtime: Some("999.0.0".into()),
            ..contents("com.example.demo")
        };
        let bytes = assemble(&newer, &release, &cert, 150).unwrap();
        let err = store.verify(&bytes, "v").unwrap_err();
        assert!(matches!(err, Error::RuntimeTooOld { ref needs, .. } if needs == "999.0.0"));
        assert!(err.to_string().contains(crate::RUNTIME_VERSION), "{err}");
    }

    /// `contents` as a newer signer would package it: the header (and the
    /// files' bytes) edited, then signed again.
    fn newer(
        contents: &Contents,
        key: &SecretKey,
        cert: &Certificate,
        edit: impl FnOnce(&mut serde_json::Value, &mut Vec<u8>),
    ) -> Vec<u8> {
        let bytes = assemble(contents, key, cert, 150).unwrap();
        let len = u32::from_le_bytes(bytes[8..PREFIX].try_into().unwrap()) as usize;
        let mut header = serde_json::from_slice(&bytes[PREFIX..PREFIX + len]).unwrap();
        let mut data = bytes[PREFIX + len..bytes.len() - SIGNATURE].to_vec();
        edit(&mut header, &mut data);
        let header = serde_json::to_vec(&header).unwrap();
        let mut out = bytes[..8].to_vec();
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(&data);
        let signature = key.sign(PACKAGE, &out);
        out.extend_from_slice(&signature);
        out
    }

    fn signer() -> (SecretKey, Certificate, TrustStore) {
        let root = SecretKey::generate().unwrap();
        let release = SecretKey::generate().unwrap();
        let cert = certify(&root, &release.public(), &["*".into()], 0, u64::MAX);
        let mut store = TrustStore::new();
        store.add_root(root.public());
        (release, cert, store)
    }

    /// Older runtimes refuse any field they do not know, so this signer
    /// writes only the fields they read.
    #[test]
    fn packages_keep_the_fields_older_runtimes_read() {
        let (key, cert, _) = signer();
        let bytes = assemble(&contents("com.example.demo"), &key, &cert, 150).unwrap();
        let (header, ..) = header(&bytes).unwrap();
        let json = serde_json::to_value(&header).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "app",
                "bytecodeVersion",
                "capabilities",
                "certificate",
                "createdAt",
                "files",
                "minRuntime"
            ]
        );
        let file = json["files"][0].as_object().unwrap();
        assert_eq!(file.len(), 5, "{file:?}");
    }

    /// A newer signer's optional additions: header and app fields are
    /// ignored, and so are files of new kinds, which stay signed and hashed.
    #[test]
    fn optional_fields_of_newer_packages_are_ignored() {
        let (key, cert, store) = signer();
        let extra = [7u8; 4];
        let bytes = newer(
            &contents("com.example.demo"),
            &key,
            &cert,
            |header, data| {
                header["future"] = serde_json::json!({ "x": 1 });
                header["app"]["channel"] = "beta".into();
                header["files"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({
                        "path": "extra.bin",
                        "kind": "chunk",
                        "offset": data.len(),
                        "size": extra.len(),
                        "sha256": hex(&Sha256::digest(extra)),
                    }));
                data.extend_from_slice(&extra);
            },
        );
        let package = store.verify(&bytes, "v").unwrap();
        assert_eq!(package.source, "1");
        assert_eq!(
            package.ignored,
            ["header field `future`", "file `extra.bin`"]
        );

        // The new file is still checked against its hash.
        let bad = newer(
            &contents("com.example.demo"),
            &key,
            &cert,
            |header, data| {
                header["files"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({
                        "path": "extra.bin",
                        "kind": "chunk",
                        "offset": data.len(),
                        "size": extra.len(),
                        "sha256": hex(&Sha256::digest(b"else")),
                    }));
                data.extend_from_slice(&extra);
            },
        );
        assert!(matches!(store.verify(&bad, "v"), Err(Error::Integrity(p)) if p == "extra.bin"));
    }

    /// A file with a field this runtime does not know is not used: its
    /// bytes may not be what the kind says (compressed bytecode would be
    /// memory corruption).
    #[test]
    fn files_with_unknown_fields_are_not_used() {
        let (key, cert, store) = signer();
        let with_bytecode = Contents {
            bytecode: Some((vec![1, 2, 3], "v".into())),
            ..contents("com.example.demo")
        };
        assert!(
            store
                .verify(&assemble(&with_bytecode, &key, &cert, 150).unwrap(), "v")
                .unwrap()
                .bytecode()
                .is_some()
        );
        let bytes = newer(&with_bytecode, &key, &cert, |header, _| {
            header["files"][1]["compression"] = "zstd".into();
        });
        let package = store.verify(&bytes, "v").unwrap();
        assert!(package.bytecode().is_none());
        assert_eq!(package.source, "1");
        assert_eq!(package.ignored, ["file `bundle.nshc`"]);
    }

    /// A package's header as JSON, with every field it holds.
    fn header_json(bytes: &[u8]) -> serde_json::Value {
        let len = u32::from_le_bytes(bytes[8..PREFIX].try_into().unwrap()) as usize;
        serde_json::from_slice(&bytes[PREFIX..PREFIX + len]).unwrap()
    }

    /// Signing again keeps what a newer signer wrote, which this runtime
    /// does not know: dropping a field named in `critical` would lift the
    /// restriction it stands for on runtimes that know it.
    #[test]
    fn resigning_keeps_what_newer_signers_wrote() {
        let (ci, ci_cert, _) = signer();
        let (key, cert, store) = signer();
        let with_bytecode = Contents {
            bytecode: Some((vec![1, 2, 3], "v".into())),
            ..contents("com.example.demo")
        };
        let extra = [7u8; 4];
        let original = newer(&with_bytecode, &ci, &ci_cert, |header, data| {
            header["expiresAt"] = 1.into();
            header["critical"] = serde_json::json!(["expiresAt"]);
            header["app"]["channel"] = "beta".into();
            header["files"][1]["compression"] = "zstd".into();
            header["files"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "path": "extra.bin",
                    "kind": "chunk",
                    "offset": data.len(),
                    "size": extra.len(),
                    "sha256": hex(&Sha256::digest(extra)),
                }));
            data.extend_from_slice(&extra);
        });
        let bytes = resign(&original, &key, &cert).unwrap();
        let json = header_json(&bytes);
        assert_eq!(json["expiresAt"], 1);
        assert_eq!(json["critical"], serde_json::json!(["expiresAt"]));
        assert_eq!(json["app"]["channel"], "beta");
        assert_eq!(json["files"][1]["compression"], "zstd");
        assert_eq!(json["files"][2]["kind"], "chunk");
        // Still refused here, as before: this runtime does not know `expiresAt`.
        assert!(
            matches!(store.verify(&bytes, "v"), Err(Error::Format(m)) if m.contains("`expiresAt`"))
        );
    }

    /// The minimum runtime stays even when it is newer than the signing
    /// tool, which `build` refuses: the tool that built it knew it.
    #[test]
    fn resigning_keeps_a_minimum_runtime_newer_than_this_one() {
        let (ci, ci_cert, _) = signer();
        let (key, cert, _) = signer();
        let newer_runtime = Contents {
            min_runtime: Some("999.0.0".into()),
            ..contents("com.example.demo")
        };
        let original = assemble(&newer_runtime, &ci, &ci_cert, 150).unwrap();
        let bytes = resign(&original, &key, &cert).unwrap();
        assert_eq!(verify_signature(&bytes).unwrap().min_runtime(), "999.0.0");
    }

    /// A signer that wrote wrong hashes or a file table that leaves bytes
    /// out made a package no device runs: it is not signed again.
    #[test]
    fn resigning_checks_the_files() {
        let (ci, ci_cert, _) = signer();
        let (key, cert, _) = signer();
        let wrong_hash = newer(&contents("com.example.demo"), &ci, &ci_cert, |header, _| {
            header["files"][0]["sha256"] = hex(&Sha256::digest(b"else")).into();
        });
        assert!(
            matches!(resign(&wrong_hash, &key, &cert), Err(Error::Integrity(p)) if p == "bundle.js")
        );
        let untiled = newer(&contents("com.example.demo"), &ci, &ci_cert, |_, data| {
            data.extend_from_slice(b"hidden");
        });
        assert!(matches!(
            resign(&untiled, &key, &cert),
            Err(Error::Format(_))
        ));
    }

    /// What a package names in `critical` must be understood: a runtime
    /// that does not know such a field refuses the package.
    #[test]
    fn critical_fields_must_be_understood() {
        let (key, cert, store) = signer();
        let bytes = newer(&contents("com.example.demo"), &key, &cert, |header, _| {
            header["expiresAt"] = 1.into();
            header["critical"] = serde_json::json!(["expiresAt"]);
        });
        assert!(
            matches!(store.verify(&bytes, "v"), Err(Error::Format(m)) if m.contains("`expiresAt`"))
        );
        // Fields it knows are understood.
        let bytes = newer(&contents("com.example.demo"), &key, &cert, |header, _| {
            header["critical"] = serde_json::json!(["minRuntime"]);
        });
        assert!(store.verify(&bytes, "v").is_ok());
    }
}
