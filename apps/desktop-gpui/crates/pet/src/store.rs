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

//! The pet library: installed packs under `<stateRoot>/pets/v1/<id>/`, each
//! its `pet.json` and its sprite sheet. Mirrors `FilePetPackStore` in
//! packages/storage/src/pet-pack-store.ts rule for rule (owner-only
//! directories and files, a staged install renamed into place, a removal
//! renamed out of the way before it is deleted, bounded reads that stay
//! inside the pack), so Maka Desktop and this client read and write one
//! library when they share a State Root.
//!
//! Every call touches the file system and blocks: run it on the background
//! executor, never from `render`.

use std::fs::{self, File};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};

use crate::manifest::{PetPackId, PetPackManifest, PetSpriteFormat, validate_manifest};

/// `PET_PACK_DIRECTORY`, under the State Root.
pub const PET_PACK_DIRECTORY: [&str; 2] = ["pets", "v1"];
/// `PET_PACK_MANIFEST_FILE`.
pub const PET_PACK_MANIFEST_FILE: &str = "pet.json";
/// `PET_PACK_MANIFEST_MAX_BYTES`.
pub const PET_PACK_MANIFEST_MAX_BYTES: u64 = 64 * 1024;
/// `PET_PACK_SPRITE_SHEET_MAX_BYTES`.
pub const PET_PACK_SPRITE_SHEET_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// `PetPackStoreErrorCode` (less `invalid_id`, which [`PetPackId`] rules out).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreErrorCode {
    /// The sprite sheet offered for an install is not the size or format
    /// the manifest names.
    InvalidAsset,
    AlreadyInstalled,
    /// `pets` or `pets/v1` is not a plain directory.
    CorruptStore,
    /// An installed pack is not what the library wrote.
    CorruptPack,
    IoFailed,
}

/// `PetPackStoreError`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PetPackStoreError {
    code: StoreErrorCode,
    message: String,
}

impl PetPackStoreError {
    fn new(code: StoreErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn code(&self) -> StoreErrorCode {
        self.code
    }
}

fn corrupt_pack(id: &str, message: &str) -> PetPackStoreError {
    PetPackStoreError::new(StoreErrorCode::CorruptPack, format!("{message} ({id})"))
}

fn io_failed(message: &str, error: io::Error) -> PetPackStoreError {
    PetPackStoreError::new(StoreErrorCode::IoFailed, format!("{message}: {error}"))
}

/// An installed pack's sprite sheet (`PetSpriteSheetAsset`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PetSpriteSheetAsset {
    pub format: PetSpriteFormat,
    pub bytes: Vec<u8>,
}

/// The library of one State Root.
#[derive(Debug, Clone)]
pub struct PetPackStore {
    state_root: PathBuf,
    pets_root: PathBuf,
    root: PathBuf,
}

impl PetPackStore {
    /// The library of the State Root at `state_root`.
    pub fn new(state_root: impl Into<PathBuf>) -> Self {
        let state_root = state_root.into();
        let pets_root = state_root.join(PET_PACK_DIRECTORY[0]);
        let root = pets_root.join(PET_PACK_DIRECTORY[1]);
        Self { state_root, pets_root, root }
    }

    /// `<stateRoot>/pets/v1`.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Every installed pack, in Desktop's order. One pack that is not what
    /// the library wrote fails the whole list, as in Desktop.
    // Runs on the background executor, as every call here does.
    #[allow(clippy::disallowed_methods)]
    pub fn list(&self) -> Result<Vec<PetPackManifest>, PetPackStoreError> {
        if !self.store_root_exists()? {
            return Ok(Vec::new());
        }
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_failed("Unable to list installed pet packs", error)),
        };
        let mut ids = Vec::new();
        for entry in entries {
            let entry =
                entry.map_err(|error| io_failed("Unable to list installed pet packs", error))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let file_type = entry.file_type().ok();
            let id = PetPackId::parse(&name)
                .filter(|_| file_type.is_some_and(|kind| kind.is_dir() && !kind.is_symlink()));
            match id {
                Some(id) => ids.push(id),
                None => return Err(corrupt_pack(&name, "Pet pack root contains an invalid entry")),
            }
        }
        ids.sort_by_key(PetPackId::collation_key);
        ids.into_iter().map(|id| self.read_installed_manifest(id)).collect()
    }

    /// The installed pack `id`, or `None` when there is none.
    pub fn get(&self, id: PetPackId) -> Result<Option<PetPackManifest>, PetPackStoreError> {
        if !self.store_root_exists()? {
            return Ok(None);
        }
        match fs::symlink_metadata(self.root.join(id.as_str())) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(corrupt_pack(
                    id.as_str(),
                    "Installed pet pack is not a regular directory",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_failed("Unable to inspect pet pack", error)),
        }
        self.read_installed_manifest(id).map(Some)
    }

    /// Installs `manifest` with `sprite_sheet` as its art: staged in a
    /// private directory beside the library and renamed into place, so a
    /// reader sees the whole pack or none of it.
    pub fn install(
        &self,
        manifest: &PetPackManifest,
        sprite_sheet: &[u8],
    ) -> Result<PetPackManifest, PetPackStoreError> {
        assert_sprite_sheet(manifest, sprite_sheet, StoreErrorCode::InvalidAsset)?;
        self.ensure_root()?;
        let id = manifest.id();
        let destination = self.root.join(id.as_str());
        match fs::symlink_metadata(&destination) {
            Ok(_) => {
                return Err(PetPackStoreError::new(
                    StoreErrorCode::AlreadyInstalled,
                    format!("Pet pack {id} is already installed"),
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_failed("Unable to install pet pack", error)),
        }
        let staging = make_staging_directory(&self.root)
            .map_err(|error| io_failed("Unable to install pet pack", error))?;
        let result = match stage(&staging, manifest, sprite_sheet, &destination) {
            Ok(()) => Ok(manifest.clone()),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                Err(PetPackStoreError::new(
                    StoreErrorCode::AlreadyInstalled,
                    format!("Pet pack {id} is already installed"),
                ))
            }
            Err(error) => Err(io_failed("Unable to install pet pack", error)),
        };
        // Gone already after a successful rename.
        fs::remove_dir_all(&staging).ok();
        result
    }

    /// The installed pack's sprite sheet, checked against its manifest.
    pub fn read_sprite_sheet(
        &self,
        id: PetPackId,
    ) -> Result<Option<PetSpriteSheetAsset>, PetPackStoreError> {
        let Some(manifest) = self.get(id)? else {
            return Ok(None);
        };
        let pack_root = self.root.join(id.as_str());
        let bytes = read_bounded_regular_file(
            &stored_asset_path(&pack_root, &manifest),
            PET_PACK_SPRITE_SHEET_MAX_BYTES,
            &pack_root,
        )
        .map_err(|_| corrupt_pack(id.as_str(), "Installed pet sprite sheet is unreadable"))?;
        assert_sprite_sheet(&manifest, &bytes, StoreErrorCode::CorruptPack)?;
        Ok(Some(PetSpriteSheetAsset { format: manifest.sprite_sheet().format, bytes }))
    }

    /// Removes the pack `id`: renamed out of the library first, so it is
    /// never half there, then deleted. `false` when it was not installed.
    pub fn remove(&self, id: PetPackId) -> Result<bool, PetPackStoreError> {
        if !self.store_root_exists()? {
            return Ok(false);
        }
        let destination = self.root.join(id.as_str());
        let quarantine = self.root.join(format!(".remove-{id}-{}", uuid::Uuid::new_v4()));
        match fs::rename(&destination, &quarantine) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_failed("Unable to unpublish pet pack", error)),
        }
        fs::remove_dir_all(&quarantine)
            .map_err(|error| io_failed("Unable to remove pet pack", error))?;
        Ok(true)
    }

    fn read_installed_manifest(&self, id: PetPackId) -> Result<PetPackManifest, PetPackStoreError> {
        let pack_root = self.root.join(id.as_str());
        let bytes = read_bounded_regular_file(
            &pack_root.join(PET_PACK_MANIFEST_FILE),
            PET_PACK_MANIFEST_MAX_BYTES,
            &pack_root,
        )
        .map_err(|_| corrupt_pack(id.as_str(), "Installed pet manifest is unreadable"))?;
        let manifest = parse_manifest(&bytes)
            .ok_or_else(|| corrupt_pack(id.as_str(), "Installed pet manifest is invalid"))?;
        if manifest.id() != id {
            return Err(corrupt_pack(
                id.as_str(),
                "Installed pet manifest id does not match its directory",
            ));
        }
        Ok(manifest)
    }

    fn ensure_root(&self) -> Result<(), PetPackStoreError> {
        let created = private_dir_builder(true)
            .create(&self.state_root)
            .and_then(|()| ensure_plain_directory(&self.pets_root))
            .and_then(|()| ensure_plain_directory(&self.root));
        created.map_err(|error| match error.kind() {
            io::ErrorKind::InvalidData => PetPackStoreError::new(
                StoreErrorCode::CorruptStore,
                "Pet pack store contains a redirected or non-directory root",
            ),
            _ => io_failed("Unable to create the pet pack store", error),
        })
    }

    /// Whether `pets/v1` exists, refusing a root that is a link or a file.
    fn store_root_exists(&self) -> Result<bool, PetPackStoreError> {
        for path in [&self.pets_root, &self.root] {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(PetPackStoreError::new(
                        StoreErrorCode::CorruptStore,
                        "Pet pack store contains a redirected or non-directory root",
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(io_failed("Unable to inspect the pet pack store", error)),
            }
        }
        Ok(true)
    }
}

/// Writes the pack into `staging` and renames it to `destination`.
fn stage(
    staging: &Path,
    manifest: &PetPackManifest,
    sprite_sheet: &[u8],
    destination: &Path,
) -> io::Result<()> {
    write_new_file(&staging.join(PET_PACK_MANIFEST_FILE), manifest.to_stored_json().as_bytes())?;
    let asset = stored_asset_path(staging, manifest);
    if let Some(parent) = asset.parent() {
        private_dir_builder(true).create(parent)?;
    }
    write_new_file(&asset, sprite_sheet)?;
    fs::rename(staging, destination)
}

/// A manifest read from `pet.json`'s bytes: strict UTF-8 (a leading byte
/// order mark is skipped, as `TextDecoder` does), JSON, then validated.
pub(crate) fn parse_manifest(bytes: &[u8]) -> Option<PetPackManifest> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).ok()?;
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    validate_manifest(&value).ok()
}

fn stored_asset_path(pack_root: &Path, manifest: &PetPackManifest) -> PathBuf {
    manifest
        .sprite_sheet()
        .path
        .split('/')
        .fold(pack_root.to_owned(), |path, segment| path.join(segment))
}

fn private_dir_builder(recursive: bool) -> fs::DirBuilder {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder
}

/// `ensurePlainDirectory`: `path` exists as a real directory, owner-only.
/// A link or a file in its place reads as [`io::ErrorKind::InvalidData`].
fn ensure_plain_directory(path: &Path) -> io::Result<()> {
    match private_dir_builder(false).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "not a plain directory"));
    }
    set_private(path, 0o700)
}

fn set_private(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

/// `mkdtemp(join(root, '.install-'))`, owner-only.
fn make_staging_directory(root: &Path) -> io::Result<PathBuf> {
    loop {
        let suffix: String = std::iter::repeat_with(fastrand::alphanumeric).take(6).collect();
        let staging = root.join(format!(".install-{suffix}"));
        match private_dir_builder(false).create(&staging) {
            Ok(()) => {
                set_private(&staging, 0o700)?;
                return Ok(staging);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

/// Writes a file that must not exist yet (`flag: 'wx'`), owner-only.
fn write_new_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    set_private(path, 0o600)
}

/// Whether `path` resolves inside `root` (and is not `root` itself).
fn resolves_inside(root: &Path, path: &Path) -> io::Result<bool> {
    let (root, path) = (fs::canonicalize(root)?, fs::canonicalize(path)?);
    Ok(path.strip_prefix(&root).is_ok_and(|relative| !relative.as_os_str().is_empty()))
}

/// Reads the regular file at `path`, which must resolve inside
/// `containment_root`, be no larger than `max_bytes`, and not change
/// between the look and the open (`readBoundedRegularFile`).
fn read_bounded_regular_file(
    path: &Path,
    max_bytes: u64,
    containment_root: &Path,
) -> io::Result<Vec<u8>> {
    if !resolves_inside(containment_root, path)? {
        return Err(io::Error::other("Pet pack file escapes its package root"));
    }
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || before.len() > max_bytes {
        return Err(io::Error::other(format!(
            "Pet pack file must be a regular file no larger than {max_bytes} bytes"
        )));
    }
    let file = File::open(path)?;
    let limit = before.len().min(max_bytes) + 1;
    read_opened(file, &before, limit, max_bytes)
}

/// Reads at most `limit` bytes of `file`, which must still be the file
/// `before` describes; more than `max_bytes` is an error.
pub(crate) fn read_opened(
    file: File,
    before: &fs::Metadata,
    limit: u64,
    max_bytes: u64,
) -> io::Result<Vec<u8>> {
    let opened = file.metadata()?;
    if !opened.is_file() || !same_file(before, &opened) {
        return Err(io::Error::other("Pet pack file changed while opening"));
    }
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(io::Error::other(format!("Pet pack file exceeds {max_bytes} bytes")));
    }
    Ok(bytes)
}

fn same_file(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        before.dev() == opened.dev() && before.ino() == opened.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (before, opened);
        true
    }
}

/// `assertSpriteSheet`: one to 4 MB of the manifest's format, exactly the
/// grid's size.
pub(crate) fn assert_sprite_sheet(
    manifest: &PetPackManifest,
    bytes: &[u8],
    code: StoreErrorCode,
) -> Result<(), PetPackStoreError> {
    let id = manifest.id();
    if bytes.is_empty() || bytes.len() as u64 > PET_PACK_SPRITE_SHEET_MAX_BYTES {
        return Err(PetPackStoreError::new(
            code,
            format!(
                "Pet sprite sheet must be between 1 and {PET_PACK_SPRITE_SHEET_MAX_BYTES} bytes ({id})"
            ),
        ));
    }
    let size = image_dimensions(bytes, manifest.sprite_sheet().format).ok_or_else(|| {
        PetPackStoreError::new(code, format!("Pet sprite sheet has an invalid image header ({id})"))
    })?;
    let expected = manifest.sprite_sheet().size();
    if size != expected {
        return Err(PetPackStoreError::new(
            code,
            format!(
                "Pet sprite sheet must be {}x{}, got {}x{} ({id})",
                expected.0, expected.1, size.0, size.1
            ),
        ));
    }
    Ok(())
}

/// The pixel size a PNG or WebP header declares (`readImageDimensions`).
pub fn image_dimensions(bytes: &[u8], format: PetSpriteFormat) -> Option<(u32, u32)> {
    match format {
        PetSpriteFormat::Png => png_dimensions(bytes),
        PetSpriteFormat::Webp => webp_dimensions(bytes),
    }
}

fn u32_be(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u16_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?)))
}

fn u24_le(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 3)?;
    Some(u32::from(b[0]) | (u32::from(b[1]) << 8) | (u32::from(b[2]) << 16))
}

/// `readPngDimensions`.
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 33
        || !bytes.starts_with(SIGNATURE)
        || u32_be(bytes, 8)? != 13
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }
    let (width, height) = (u32_be(bytes, 16)?, u32_be(bytes, 20)?);
    (width != 0 && height != 0).then_some((width, height))
}

/// `readWebpDimensions`: the RIFF container, then the first chunk's
/// VP8X, VP8, or VP8L header.
fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 25 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    if u64::from(u32_le(bytes, 4)?) + 8 != bytes.len() as u64 {
        return None;
    }
    let chunk_size = u64::from(u32_le(bytes, 16)?);
    if 20 + chunk_size > bytes.len() as u64 {
        return None;
    }
    match &bytes[12..16] {
        b"VP8X" if chunk_size >= 10 && bytes.len() >= 30 => {
            Some((1 + u24_le(bytes, 24)?, 1 + u24_le(bytes, 27)?))
        }
        b"VP8 "
            if chunk_size >= 10
                && bytes.len() >= 30
                && bytes.get(23..26) == Some(&[0x9d, 0x01, 0x2a][..]) =>
        {
            Some((u16_le(bytes, 26)? & 0x3fff, u16_le(bytes, 28)? & 0x3fff))
        }
        b"VP8L" if chunk_size >= 5 && bytes[20] == 0x2f => {
            let bits = u32_le(bytes, 21)?;
            Some((1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)))
        }
        _ => None,
    }
}

#[cfg(test)]
// Test setup reads and writes fixture files synchronously.
#[allow(clippy::disallowed_methods)]
pub(crate) mod tests {
    use serde_json::json;

    use super::*;
    use crate::manifest::PET_PACK_SCHEMA_V1;

    /// A directory under the system's temporary one, removed when dropped.
    pub(crate) struct TempDir(pub(crate) PathBuf);

    impl TempDir {
        pub(crate) fn new(name: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default();
            let path = std::env::temp_dir().join(format!(
                "pet-{name}-{}-{nanos}-{}",
                std::process::id(),
                fastrand::u32(..)
            ));
            fs::create_dir_all(&path).expect("temp dir");
            Self(fs::canonicalize(path).expect("canonical"))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    /// A 2×2 grid of `frame`-pixel frames, each a flat colour.
    pub(crate) fn sprite_png(frame: u32, columns: u32, rows: u32) -> Vec<u8> {
        let sheet = image::RgbaImage::from_fn(frame * columns, frame * rows, |x, y| {
            let index = (y / frame) * columns + x / frame;
            image::Rgba([(index * 40) as u8, 120, 200, 255])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(sheet)
            .write_to(&mut io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("png");
        png
    }

    /// A small pack: 16px frames, two columns by two rows.
    pub(crate) fn pack_manifest(id: &str) -> serde_json::Value {
        json!({
            "schema": PET_PACK_SCHEMA_V1,
            "id": id,
            "displayName": "Pixel",
            "description": "A test pet",
            "spriteSheet": {
                "path": "art/sheet.png", "format": "png", "frameWidth": 16, "frameHeight": 16,
                "columns": 2, "rows": 2, "frameCount": 4
            },
            "animations": {
                "idle": { "frames": [0, 1], "fps": 4, "loop": true },
                "working": { "frames": [1, 2], "fps": 8, "loop": true },
                "needs-input": { "frames": [2], "fps": 1, "loop": true },
                "ready": { "frames": [3, 0], "fps": 4, "loop": false, "fallback": "idle" },
                "blocked": { "frames": [3], "fps": 1, "loop": true }
            }
        })
    }

    fn manifest(id: &str) -> PetPackManifest {
        validate_manifest(&pack_manifest(id)).expect("valid")
    }

    fn id(value: &str) -> PetPackId {
        PetPackId::parse(value).expect("id")
    }

    #[test]
    fn an_install_lands_whole_and_reads_back() {
        let root = TempDir::new("install");
        let store = PetPackStore::new(root.0.join("state"));
        assert_eq!(store.list(), Ok(Vec::new()), "no library yet");
        assert_eq!(store.get(id("pixel")), Ok(None));

        let sprite = sprite_png(16, 2, 2);
        store.install(&manifest("pixel"), &sprite).expect("install");
        store.install(&manifest("a.pixel"), &sprite).expect("install");
        let listed: Vec<String> =
            store.list().expect("list").iter().map(|m| m.id().to_string()).collect();
        assert_eq!(listed, ["a.pixel", "pixel"]);
        let pack = store.root().join("pixel");
        assert!(pack.join("pet.json").is_file() && pack.join("art/sheet.png").is_file());
        let asset = store.read_sprite_sheet(id("pixel")).expect("read").expect("installed");
        assert_eq!(asset.bytes, sprite);
        // Nothing staged is left behind.
        let hidden = fs::read_dir(store.root())
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with('.'))
            .count();
        assert_eq!(hidden, 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = |path: &Path| fs::metadata(path).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode(store.root()), 0o700);
            assert_eq!(mode(&pack.join("pet.json")), 0o600);
        }

        let again = store.install(&manifest("pixel"), &sprite).expect_err("twice");
        assert_eq!(again.code(), StoreErrorCode::AlreadyInstalled);

        assert_eq!(store.remove(id("pixel")), Ok(true));
        assert_eq!(store.remove(id("pixel")), Ok(false));
        assert_eq!(store.get(id("pixel")), Ok(None));
    }

    #[test]
    fn a_sheet_of_the_wrong_size_or_format_is_refused() {
        let root = TempDir::new("sheet");
        let store = PetPackStore::new(&root.0);
        for (sprite, why) in [
            (sprite_png(16, 3, 2), "wider than the grid"),
            (sprite_png(8, 2, 2), "smaller frames"),
            (b"GIF89a".to_vec(), "not a PNG"),
            (Vec::new(), "empty"),
        ] {
            let refused = store.install(&manifest("pixel"), &sprite).expect_err(why);
            assert_eq!(refused.code(), StoreErrorCode::InvalidAsset, "{why}");
        }
        assert_eq!(store.list(), Ok(Vec::new()), "nothing was installed");
    }

    #[test]
    fn a_damaged_library_is_reported_not_guessed() {
        let root = TempDir::new("damaged");
        let store = PetPackStore::new(&root.0);
        store.install(&manifest("pixel"), &sprite_png(16, 2, 2)).expect("install");
        // A manifest whose id is not its directory's.
        fs::create_dir_all(store.root().join("other")).expect("dir");
        let other = pack_manifest("pixel").to_string();
        fs::write(store.root().join("other").join("pet.json"), other).expect("write");
        let failed = store.list().expect_err("corrupt");
        assert_eq!(failed.code(), StoreErrorCode::CorruptPack);
        fs::remove_dir_all(store.root().join("other")).expect("clean");
        // A stray file in the library.
        fs::write(store.root().join("notes.txt"), "hi").expect("write");
        assert_eq!(store.list().expect_err("stray").code(), StoreErrorCode::CorruptPack);
        fs::remove_file(store.root().join("notes.txt")).expect("clean");
        // A sheet replaced behind the library's back.
        fs::write(store.root().join("pixel/art/sheet.png"), sprite_png(16, 1, 1)).expect("write");
        let sheet = store.read_sprite_sheet(id("pixel")).expect_err("resized");
        assert_eq!(sheet.code(), StoreErrorCode::CorruptPack);
        #[cfg(unix)]
        {
            // `pets/v1` that is a link is not the library.
            let elsewhere = TempDir::new("elsewhere");
            let linked = TempDir::new("linked");
            fs::create_dir_all(linked.0.join("pets")).expect("pets");
            std::os::unix::fs::symlink(&elsewhere.0, linked.0.join("pets/v1")).expect("link");
            let linked = PetPackStore::new(&linked.0);
            assert_eq!(linked.list().expect_err("link").code(), StoreErrorCode::CorruptStore);
        }
    }

    #[test]
    fn webp_and_png_headers_read_as_desktops_parser_reads_them() {
        let png = sprite_png(16, 2, 2);
        assert_eq!(image_dimensions(&png, PetSpriteFormat::Png), Some((32, 32)));
        assert_eq!(image_dimensions(&png[..30], PetSpriteFormat::Png), None);
        // A lossless WebP of 33×17: `VP8L`, signature 0x2f, 14-bit sizes less one.
        let bits: u32 = 32 | (16 << 14);
        let mut webp = b"RIFF\0\0\0\0WEBPVP8L\x05\0\0\0\x2f".to_vec();
        webp.extend_from_slice(&bits.to_le_bytes());
        webp.push(0);
        let size = (webp.len() - 8) as u32;
        webp[4..8].copy_from_slice(&size.to_le_bytes());
        assert_eq!(image_dimensions(&webp, PetSpriteFormat::Webp), Some((33, 17)));
        webp.push(0);
        assert_eq!(image_dimensions(&webp, PetSpriteFormat::Webp), None, "container size");
    }
}
