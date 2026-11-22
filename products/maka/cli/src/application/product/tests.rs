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

use super::*;
use serde_json::json;

#[test]
fn product_version_covers_authoring_and_each_named_package() {
    let version = |source, packages: &[(&str, &str)]| {
        super::fingerprint(
            source,
            packages
                .iter()
                .map(|(name, digest)| (name.to_string(), digest.to_string())),
        )
    };
    let original = version("author", &[("a", "one"), ("b", "two")]);
    assert_eq!(original, version("author", &[("b", "two"), ("a", "one")]));
    assert_ne!(original, version("changed", &[("a", "one"), ("b", "two")]));
    assert_ne!(
        original,
        version("author", &[("a", "changed"), ("b", "two")])
    );
    assert_ne!(
        original,
        version("author", &[("renamed", "one"), ("b", "two")])
    );
    assert_ne!(original, version("author", &[("a", "one")]));
}

#[test]
fn generated_product_version_matches_canonical_unicode_and_binary_vectors() {
    let files = [
        ("z", &[0, 255][..]),
        ("😀.js", "你好".as_bytes()),
        ("\u{e000}.js", b"x".as_slice()),
    ];
    let digest = maka_packages::content_digest(files);
    assert_eq!(
        digest,
        "sha256-1be108087645221ec647c9ce43ad7d10de9d6433c533fb2b67e1bb93609d302c"
    );
    assert_eq!(
        super::fingerprint(
            "author 😀\n",
            [("b".into(), "two".into()), ("a".into(), digest)]
        ),
        "sha256-41298191ef2403397572e03ff6aa1b82f8d5f839f32260bfa02925628406d86e"
    );
}

#[test]
fn stale_generated_version_cannot_admit_changed_candidates() {
    let manifest = json!({"schemaVersion":1,"id":"example.notes","application":{"host":{"implementation":{"kind":"javascript","module":"entry.js","realm":"shared"},"configuration":{"type":"object"}}}});
    let package = Package::new(BTreeMap::from([
        (
            "maka.extension.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        ),
        ("entry.js".into(), b"export function main() {}".to_vec()),
    ]))
    .unwrap();
    let packages = BTreeMap::from([("notes".to_owned(), package)]);
    let version = super::fingerprint(
        "author",
        packages
            .iter()
            .map(|(name, package)| (name.clone(), package.digest().to_owned())),
    );
    assert_eq!(
        super::verified_fingerprint("author", &packages, &version).unwrap(),
        version
    );
    assert!(super::verified_fingerprint("changed author", &packages, &version).is_err());
    let mut changed = packages.clone();
    let mut files = changed["notes"].files().clone();
    files
        .get_mut("entry.js")
        .unwrap()
        .extend_from_slice(b"\n// changed");
    changed.insert("notes".into(), Package::new(files).unwrap());
    assert!(super::verified_fingerprint("author", &changed, &version).is_err());
}
