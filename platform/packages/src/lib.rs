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

mod bundle;
mod io;
mod manifest;
mod path;
pub use io::PackageIoError;
pub use manifest::Manifest;
pub use path::validate_path;

use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub const MANIFEST_FILE: &str = "maka.extension.json";

/// Validated immutable bytes. Retained instances keep their exact package alive.
#[derive(Clone, Debug)]
pub struct Package(Arc<PackageData>);

#[derive(Debug)]
struct PackageData {
    manifest: Manifest,
    files: BTreeMap<String, Vec<u8>>,
    digest: String,
}

impl Package {
    pub fn new(files: BTreeMap<String, Vec<u8>>) -> Result<Self, Error> {
        if files.is_empty() {
            return Err(Error::Invalid("package must contain files".into()));
        }
        let mut paths = BTreeSet::new();
        for path in files.keys() {
            validate_path(path)?;
            if !paths.insert(path.to_lowercase()) {
                return Err(Error::Invalid("package has case-colliding paths".into()));
            }
        }
        for path in &paths {
            for (index, _) in path.match_indices('/') {
                if paths.contains(&path[..index]) {
                    return Err(Error::Invalid("package file is also a directory".into()));
                }
            }
        }
        let bytes = files
            .get(MANIFEST_FILE)
            .ok_or_else(|| Error::Invalid("package manifest is missing".into()))?;
        let manifest: Manifest = serde_json::from_slice(bytes)
            .map_err(|error| Error::Invalid(format!("manifest: {error}")))?;
        manifest.validate()?;
        for entry in manifest
            .application
            .iter()
            .flat_map(|application| application.entries.values())
        {
            if let maka_plugin_core::package::Implementation::JavaScript { module, .. } =
                &entry.implementation
                && !files.contains_key(module)
            {
                return Err(Error::Invalid(format!(
                    "package entry is missing: {module}"
                )));
            }
        }
        let digest = content_digest(
            files
                .iter()
                .map(|(path, bytes)| (path.as_str(), bytes.as_slice())),
        );
        Ok(Self(Arc::new(PackageData {
            manifest,
            files,
            digest,
        })))
    }

    pub fn manifest(&self) -> &Manifest {
        &self.0.manifest
    }
    pub fn application_ref(&self) -> maka_plugin_core::package::PackageRef {
        maka_plugin_core::package::PackageRef {
            id: self.0.manifest.id.clone(),
            revision: self.0.digest.clone(),
        }
    }
    pub fn files(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.0.files
    }
    pub fn digest(&self) -> &str {
        &self.0.digest
    }
    pub fn file(&self, path: &str) -> Option<&[u8]> {
        self.0.files.get(path).map(Vec::as_slice)
    }
}

/// Exact bundle identity, independent of declaration parsing or execution admission.
pub fn content_digest<'a>(files: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> String {
    // The existing bundle format sorts paths as JavaScript strings (UTF-16).
    let mut files: Vec<_> = files.into_iter().collect();
    files.sort_unstable_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
    let mut hash = Sha256::new();
    for (path, content) in files {
        hash.update((path.len() as u64).to_be_bytes());
        hash.update(path.as_bytes());
        hash.update((content.len() as u64).to_be_bytes());
        hash.update(content);
    }
    format!("sha256-{}", hex::encode(hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checked_application_rejects_conflicting_and_invalid_authoring() {
        use maka_plugin_core::package::{CheckedDeclaration, EntryTarget, Packages};
        let manifest = json!({"schemaVersion":1,"id":"example.checked","application":{"entries":{"host":{
            "implementation":{"kind":"native","implementation":"example.checked"},
            "configuration":{"type":"object"}, "imports":{}, "exports":{}
        }}}});
        let package = Package::new(BTreeMap::from([(
            MANIFEST_FILE.into(),
            serde_json::to_vec(&manifest).unwrap(),
        )]))
        .unwrap();
        let declaration = package.manifest().application.as_ref().unwrap();
        assert_eq!(
            serde_json::to_value(declaration).unwrap(),
            manifest["application"]
        );
        let reference = package.application_ref();
        let mut packages = Packages::default();
        packages
            .insert_checked(reference.clone(), declaration.clone())
            .unwrap();
        let mut changed = declaration.declaration().clone();
        changed
            .entries
            .get_mut(&EntryTarget::Host)
            .unwrap()
            .configuration = json!({"type":"string"}).into();
        assert!(
            packages
                .insert_checked(reference.clone(), CheckedDeclaration::new(changed).unwrap())
                .is_err()
        );
        assert_eq!(packages.get(&reference).unwrap(), declaration.declaration());
        let mut edited = declaration.declaration().clone();
        edited
            .entries
            .get_mut(&EntryTarget::Host)
            .unwrap()
            .configuration = json!({"type":42}).into();
        assert!(packages.insert(reference.clone(), edited.clone()).is_err());
        assert!(CheckedDeclaration::new(edited).is_err());
        assert_eq!(packages.get(&reference).unwrap(), declaration.declaration());
        let mut invalid = manifest;
        invalid["application"]["entries"]["host"]["configuration"] = json!({"type":42});
        let error = Package::new(BTreeMap::from([(
            MANIFEST_FILE.into(),
            serde_json::to_vec(&invalid).unwrap(),
        )]))
        .unwrap_err()
        .to_string();
        assert!(error.contains("invalid application declaration"));
    }

    #[test]
    fn author_descriptions_round_trip_with_localized_copy() {
        let manifest = json!({"schemaVersion":1,"id":"example.notes", "displayName":"Notes", "description":"Write and find your notes.", "localizations":{"zh-CN":{"displayName":"笔记","description":"记录和查找笔记。"}}, "application":{"entries":{"host":{"implementation":{"kind":"native","implementation":"example.notes"},"configuration":{"type":"object"}}}}});
        let package = Package::new(BTreeMap::from([(
            MANIFEST_FILE.into(),
            serde_json::to_vec(&manifest).unwrap(),
        )]))
        .unwrap();
        let restored = Package::from_bundle(&package.to_bundle()).unwrap();
        let presentation = restored.manifest().presentation();
        assert_eq!(presentation.display_name.as_str(), "Notes");
        assert_eq!(
            presentation.localizations["zh-CN"].description.as_str(),
            "记录和查找笔记。"
        );
    }

    #[test]
    fn large_manifest_preserves_declarations_and_invalid_json_is_rejected() {
        // Multi-presentation applications carry complete nominal contracts.
        // Their complete manifest survives the same immutable bundle round trip.
        let manifest = json!({
            "schemaVersion":1,"id":"large.application",
            "application":{"entries":{"host":{
                "implementation":{"kind":"native","implementation":"example.host"},
                "configuration":{"description":"a".repeat(300 * 1024)}
            }}}
        });
        let bytes = serde_json::to_vec(&manifest).unwrap();
        assert!(bytes.len() > 256 * 1024);
        let files = BTreeMap::from([(MANIFEST_FILE.into(), bytes)]);
        let package = Package::new(files).unwrap();
        assert_eq!(
            Package::from_bundle(&package.to_bundle()).unwrap().digest(),
            package.digest()
        );
        let invalid_json = BTreeMap::from([(MANIFEST_FILE.into(), b"{invalid".to_vec())]);
        assert!(
            matches!(Package::new(invalid_json), Err(Error::Invalid(reason)) if reason.starts_with("manifest:"))
        );
    }

    #[test]
    fn application_packages_validate_variants_and_allow_pure_composition() {
        let declaration = json!({
            "entries": {"tui": {
                "implementation": {"kind":"javascript", "module":"desktop.mjs", "realm":"dedicated"},
                "configuration": {"type":"object"}, "imports": {}, "exports": {}
            }}
        });
        let files = BTreeMap::from([
            (
                MANIFEST_FILE.into(),
                serde_json::to_vec(
                    &json!({"schemaVersion":1,"id":"example","application":declaration}),
                )
                .unwrap(),
            ),
            ("desktop.mjs".into(), b"export default {}".to_vec()),
        ]);
        let package = Package::new(files.clone()).unwrap();
        let reference = package.application_ref();
        reference.validate().unwrap();
        assert_eq!(reference.revision, package.digest());
        assert_eq!(
            Package::from_bundle(&package.to_bundle())
                .unwrap()
                .application_ref(),
            reference
        );
        let mut missing = files.clone();
        missing.remove("desktop.mjs");
        assert!(Package::new(missing).is_err());
        let mut invalid = files.clone();
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&invalid[MANIFEST_FILE]).unwrap();
        manifest["schemaVersion"] = json!(0);
        invalid.insert(MANIFEST_FILE.into(), serde_json::to_vec(&manifest).unwrap());
        assert!(Package::new(invalid).is_err());
        let mut mixed = files;
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&mixed[MANIFEST_FILE]).unwrap();
        manifest["runtime"] = json!({"entry":"desktop.mjs","sdkVersion":3});
        mixed.insert(MANIFEST_FILE.into(), serde_json::to_vec(&manifest).unwrap());
        assert!(Package::new(mixed).is_err());

        let structural = Package::new(BTreeMap::from([(
            MANIFEST_FILE.into(),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"id":"product","application":{"composition":{"children":{}}}
            }))
            .unwrap(),
        )]))
        .unwrap();
        assert!(
            structural
                .manifest()
                .application
                .as_ref()
                .unwrap()
                .composition
                .is_some()
        );
    }

    #[test]
    fn package_pins_exact_bytes_and_rejects_cross_platform_path_aliases() {
        let manifest = serde_json::to_vec(&json!({
            "schemaVersion":1,"id":"graph","application":{"entries":{"host":{"implementation":{"kind":"native","implementation":"example.host"},"configuration":{"type":"object"}}}}
        })).unwrap();
        let files = BTreeMap::from([
            (MANIFEST_FILE.into(), manifest),
            ("index.mjs".into(), b"export default {}".to_vec()),
        ]);
        let package = Package::new(files.clone()).unwrap();
        let bundle = package.to_bundle();
        assert_eq!(
            Package::from_bundle(&bundle).unwrap().digest(),
            package.digest()
        );
        let encoded: serde_json::Value = serde_json::from_slice(&bundle).unwrap();
        // One package digest covers file bytes, paths, and membership.
        for (field, replacement) in [("content", "Y29ycnVwdA=="), ("path", "renamed.mjs")] {
            let mut corrupt = encoded.clone();
            corrupt["files"][0][field] = json!(replacement);
            assert_eq!(
                Package::from_bundle(&serde_json::to_vec(&corrupt).unwrap()).unwrap_err(),
                Error::Invalid("bundle package digest mismatch".into())
            );
        }
        let mut missing = encoded.clone();
        missing["files"].as_array_mut().unwrap().remove(0);
        assert_eq!(
            Package::from_bundle(&serde_json::to_vec(&missing).unwrap()).unwrap_err(),
            Error::Invalid("bundle package digest mismatch".into())
        );
        let mut reordered = encoded;
        reordered["files"].as_array_mut().unwrap().reverse();
        assert_eq!(
            Package::from_bundle(&serde_json::to_vec(&reordered).unwrap())
                .unwrap()
                .digest(),
            package.digest()
        );
        let mut updated = files.clone();
        updated.insert(
            "index.mjs".into(),
            b"export default { updated: true }".to_vec(),
        );
        assert_ne!(package.digest(), Package::new(updated).unwrap().digest());
        assert_eq!(package.file("index.mjs").unwrap(), b"export default {}");
        for path in [
            "../escape",
            "INDEX.MJS",
            "index.mjs/child",
            "dir/CON.txt",
            "C:payload",
            "trailing.",
        ] {
            let mut invalid = files.clone();
            invalid.insert(path.into(), vec![]);
            assert!(Package::new(invalid).is_err(), "{path}");
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("invalid package data: {0}")]
    Invalid(String),
}
