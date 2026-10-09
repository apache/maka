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

//! Importing a pack from a folder the person picked: its `pet.json` and
//! the one sprite sheet the manifest names, each read once through a
//! bounded snapshot, then installed into the library. Mirrors
//! `importPetPackFromDirectory` in apps/desktop/src/main/pet-pack-import.ts;
//! nothing else in the folder is read.
//!
//! Blocks on the file system: run it on the background executor.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use crate::manifest::PetPackManifest;
use crate::store::{
    PET_PACK_MANIFEST_FILE, PET_PACK_MANIFEST_MAX_BYTES, PET_PACK_SPRITE_SHEET_MAX_BYTES,
    PetPackStore, StoreErrorCode, parse_manifest, read_opened,
};

/// Why an import failed (`PetPackImportFailureReason`, less `cancelled`,
/// which is the file dialog's answer and never reaches here).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PetImportFailure {
    /// The picked path is not a plain, readable folder.
    InvalidDirectory,
    /// `pet.json` is missing, too large, not UTF-8 JSON, or not a valid
    /// `maka.pet/v1` manifest.
    InvalidManifest,
    /// The sprite sheet is missing, outside the folder, too large, or not
    /// the size and format the manifest names.
    InvalidAsset,
    /// The library already holds a pack with the manifest's id.
    AlreadyInstalled,
    ReadFailed,
}

/// Imports the pack in `source` into `store`.
pub fn import_from_directory(
    source: &Path,
    store: &PetPackStore,
) -> Result<PetPackManifest, PetImportFailure> {
    let root = admit_source_directory(source).ok_or(PetImportFailure::InvalidDirectory)?;
    let manifest =
        read_bounded_source_file(&root, PET_PACK_MANIFEST_FILE, PET_PACK_MANIFEST_MAX_BYTES)
            .ok()
            .and_then(|bytes| parse_manifest(&bytes))
            .ok_or(PetImportFailure::InvalidManifest)?;
    let sprite_sheet = read_bounded_source_file(
        &root,
        &manifest.sprite_sheet().path,
        PET_PACK_SPRITE_SHEET_MAX_BYTES,
    )
    .map_err(|_| PetImportFailure::InvalidAsset)?;
    store.install(&manifest, &sprite_sheet).map_err(|error| match error.code() {
        StoreErrorCode::AlreadyInstalled => PetImportFailure::AlreadyInstalled,
        StoreErrorCode::InvalidAsset => PetImportFailure::InvalidAsset,
        _ => {
            log::warn!("pet import: {error}");
            PetImportFailure::ReadFailed
        }
    })
}

/// `admitSourceDirectory`: a real directory (not a link to one), resolved.
fn admit_source_directory(source: &Path) -> Option<PathBuf> {
    let metadata = fs::symlink_metadata(source).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    fs::canonicalize(source).ok()
}

/// `readBoundedSourceFile`: the file at `relative` under `root` (already
/// resolved), which must resolve inside it through real directories, be a
/// regular file of at most `max_bytes`, and not change while it is opened.
fn read_bounded_source_file(root: &Path, relative: &str, max_bytes: u64) -> io::Result<Vec<u8>> {
    let segments: Vec<&str> = relative.split('/').collect();
    let candidate = segments.iter().fold(root.to_owned(), |path, segment| path.join(segment));
    let resolved = fs::canonicalize(&candidate)?;
    let inside = resolved.strip_prefix(root).is_ok_and(|rest| !rest.as_os_str().is_empty());
    if !inside {
        return Err(io::Error::other("Pet pack source file escapes the selected directory"));
    }
    let mut parent = root.to_owned();
    for segment in &segments[..segments.len().saturating_sub(1)] {
        parent = parent.join(segment);
        if !fs::symlink_metadata(&parent)?.is_dir() {
            return Err(io::Error::other("Pet pack source path contains a redirected directory"));
        }
    }
    let before = fs::symlink_metadata(&candidate)?;
    if !before.is_file() || before.len() > max_bytes {
        return Err(io::Error::other(format!(
            "Pet pack source file must be a regular file no larger than {max_bytes} bytes"
        )));
    }
    read_opened(File::open(&candidate)?, &before, max_bytes + 1, max_bytes)
}

#[cfg(test)]
// Test setup writes fixture files synchronously.
#[allow(clippy::disallowed_methods)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::store::tests::{TempDir, pack_manifest, sprite_png};

    /// A pack folder with `manifest` and `sprite` at its `art/sheet.png`.
    fn folder(dir: &TempDir, manifest: &serde_json::Value, sprite: &[u8]) -> PathBuf {
        let source = dir.0.join("source");
        fs::create_dir_all(source.join("art")).expect("dir");
        fs::write(source.join("pet.json"), manifest.to_string()).expect("manifest");
        fs::write(source.join("art/sheet.png"), sprite).expect("sprite");
        source
    }

    #[test]
    fn a_good_folder_is_imported_once() {
        let dir = TempDir::new("import");
        let source = folder(&dir, &pack_manifest("pixel"), &sprite_png(16, 2, 2));
        let store = PetPackStore::new(dir.0.join("root"));
        let imported = import_from_directory(&source, &store).expect("import");
        assert_eq!(imported.display_name(), "Pixel");
        assert_eq!(store.list().expect("list"), [imported]);
        assert_eq!(import_from_directory(&source, &store), Err(PetImportFailure::AlreadyInstalled));
    }

    #[test]
    fn the_demo_pack_imports() {
        let dir = TempDir::new("demo");
        let store = PetPackStore::new(&dir.0);
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/demo-pet");
        let manifest = import_from_directory(&fixture, &store).expect("the demo pack");
        assert_eq!(
            (manifest.id().as_str(), manifest.sprite_sheet().frame_count),
            ("demo-blob", 12)
        );
    }

    #[test]
    fn each_failure_is_named_as_desktop_names_it() {
        let dir = TempDir::new("failures");
        let store = PetPackStore::new(dir.0.join("root"));
        let sprite = sprite_png(16, 2, 2);

        assert_eq!(
            import_from_directory(&dir.0.join("missing"), &store),
            Err(PetImportFailure::InvalidDirectory)
        );
        let file = dir.0.join("file");
        fs::write(&file, "x").expect("file");
        assert_eq!(import_from_directory(&file, &store), Err(PetImportFailure::InvalidDirectory));

        let mut manifest = pack_manifest("pixel");
        manifest["animations"]["idle"]["fps"] = json!(61);
        let source = folder(&dir, &manifest, &sprite);
        assert_eq!(import_from_directory(&source, &store), Err(PetImportFailure::InvalidManifest));
        fs::write(source.join("pet.json"), b"\xff not utf-8").expect("bytes");
        assert_eq!(import_from_directory(&source, &store), Err(PetImportFailure::InvalidManifest));
        // A byte order mark before the JSON is allowed, as `TextDecoder` skips it.
        let mut marked = b"\xef\xbb\xbf".to_vec();
        marked.extend(pack_manifest("marked").to_string().into_bytes());
        fs::write(source.join("pet.json"), marked).expect("bom");
        assert!(import_from_directory(&source, &store).is_ok());

        let source = folder(&dir, &pack_manifest("wrong-size"), &sprite_png(16, 1, 2));
        assert_eq!(import_from_directory(&source, &store), Err(PetImportFailure::InvalidAsset));
        fs::remove_file(source.join("art/sheet.png")).expect("remove");
        assert_eq!(import_from_directory(&source, &store), Err(PetImportFailure::InvalidAsset));
        #[cfg(unix)]
        {
            // A sheet that links out of the folder is not read.
            let outside = dir.0.join("outside.png");
            fs::write(&outside, &sprite).expect("outside");
            std::os::unix::fs::symlink(&outside, source.join("art/sheet.png")).expect("link");
            assert_eq!(import_from_directory(&source, &store), Err(PetImportFailure::InvalidAsset));
        }
    }
}
