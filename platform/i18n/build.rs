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
use serde::Deserialize;
use std::{env, fs, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    default_locale: String,
    locales: Vec<LocaleEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleEntry {
    tag: String,
    #[serde(default)]
    fallbacks: Vec<String>,
}

fn variant_name(tag: &str) -> String {
    let mut out = String::new();
    for part in tag.split('-') {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            for ch in chars {
                out.push(ch.to_ascii_lowercase());
            }
        }
    }
    out
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let manifest_path = manifest_dir.join("../../locales.manifest.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let raw = fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", manifest_path.display()));
    let manifest: Manifest = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("invalid {}: {e}", manifest_path.display()));

    assert!(
        !manifest.locales.is_empty(),
        "locales.manifest.json must list at least one locale"
    );
    assert!(
        manifest
            .locales
            .iter()
            .any(|l| l.tag == manifest.default_locale),
        "defaultLocale {} is missing from locales list",
        manifest.default_locale
    );

    let variants: Vec<String> = manifest
        .locales
        .iter()
        .map(|l| variant_name(&l.tag))
        .collect();
    let count = manifest.locales.len();
    let mut code = String::new();

    code.push_str("#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]\n");
    code.push_str("#[repr(u8)]\n");
    code.push_str("pub enum BuiltinLocale {\n");
    for (entry, var) in manifest.locales.iter().zip(&variants) {
        if entry.tag == manifest.default_locale {
            code.push_str("    #[default]\n");
        }
        code.push_str(&format!("    {var},\n"));
    }
    code.push_str("}\n\n");

    code.push_str("impl BuiltinLocale {\n");
    code.push_str(&format!("    pub const COUNT: usize = {count};\n"));
    code.push_str(&format!("    pub const ALL: [Self; {count}] = [\n"));
    for var in &variants {
        code.push_str(&format!("        Self::{var},\n"));
    }
    code.push_str("    ];\n\n");

    code.push_str("    pub const fn index(self) -> usize {\n        self as usize\n    }\n\n");

    code.push_str("    pub const fn tag(self) -> &'static str {\n        match self {\n");
    for (entry, var) in manifest.locales.iter().zip(&variants) {
        code.push_str(&format!("            Self::{var} => {:?},\n", entry.tag));
    }
    code.push_str("        }\n    }\n\n");

    code.push_str("    pub const fn fallbacks(self) -> &'static [Self] {\n        match self {\n");
    for (entry, var) in manifest.locales.iter().zip(&variants) {
        let fbs: Vec<String> = entry
            .fallbacks
            .iter()
            .map(|fb| {
                assert!(
                    manifest.locales.iter().any(|l| l.tag == *fb),
                    "fallback {fb} for {} does not exist",
                    entry.tag
                );
                format!("Self::{}", variant_name(fb))
            })
            .collect();
        code.push_str(&format!(
            "            Self::{var} => &[{}],\n",
            fbs.join(", ")
        ));
    }
    code.push_str("        }\n    }\n\n");

    code.push_str("    pub fn from_exact_tag(tag: &str) -> Option<Self> {\n");
    code.push_str(
        "        Self::ALL.into_iter().find(|&locale| locale.tag().eq_ignore_ascii_case(tag))\n",
    );
    code.push_str("    }\n");
    code.push_str("}\n");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("manifest.rs");
    fs::write(out, code).unwrap();
}
