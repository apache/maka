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

use deno_core::ExtensionFileSourceCode;
use std::{collections::BTreeSet, error::Error, fmt::Write, fs, path::PathBuf, sync::Arc};

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    let extensions = [
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false,
            Default::default(),
        ),
    ];
    let mut generated = String::from(
        "// Generated from the original Deno extension declarations; do not edit.\n\
         static EXTENSIONS: &[EmbeddedExtensionSources] = &[\n",
    );
    let mut extension_names = BTreeSet::new();
    for extension in extensions {
        if extension.name.is_empty() || !extension_names.insert(extension.name) {
            return Err(format!("invalid or duplicate Deno extension: {}", extension.name).into());
        }
        writeln!(
            generated,
            "EmbeddedExtensionSources {{ name: {:?},",
            extension.name
        )?;
        let mut specifiers = BTreeSet::new();
        for (field, files) in [
            ("js_files", &*extension.js_files),
            ("esm_files", &*extension.esm_files),
            ("lazy_loaded_esm_files", &*extension.lazy_loaded_esm_files),
            ("lazy_loaded_js_files", &*extension.lazy_loaded_js_files),
        ] {
            writeln!(generated, "{field}: &[")?;
            for source in files {
                if source.specifier.is_empty() || !specifiers.insert(source.specifier) {
                    return Err(format!(
                        "invalid or duplicate source in {}: {}",
                        extension.name, source.specifier
                    )
                    .into());
                }
                let text = match &source.code {
                    ExtensionFileSourceCode::LoadedFromFsDuringSnapshot(path) => {
                        println!("cargo:rerun-if-changed={path}");
                        fs::read_to_string(path).map_err(|error| {
                            format!("cannot embed {} from {path}: {error}", source.specifier)
                        })?
                    }
                    ExtensionFileSourceCode::LoadedFromMemoryDuringSnapshot(code) => {
                        code.to_string()
                    }
                    ExtensionFileSourceCode::Computed(code) => code.to_string(),
                    _ => source.load()?.to_string(),
                };
                if !text.is_ascii() {
                    return Err(format!(
                        "cannot embed {}: Deno extension sources must be ASCII",
                        source.specifier
                    )
                    .into());
                }
                writeln!(
                    generated,
                    "deno_core::ExtensionFileSource::new({:?}, deno_core::ascii_str!({text:?})),",
                    source.specifier
                )?;
            }
            writeln!(generated, "],")?;
        }
        writeln!(generated, "}},")?;
    }
    writeln!(generated, "];")?;
    let destination = PathBuf::from(std::env::var_os("OUT_DIR").ok_or("missing Cargo OUT_DIR")?)
        .join("plugin_extension_sources.rs");
    if fs::read(&destination).ok().as_deref() != Some(generated.as_bytes()) {
        fs::write(destination, generated)?;
    }
    Ok(())
}
