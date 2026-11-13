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

#[path = "src/automation/transpile.rs"]
mod typescript;

use deno_core::ExtensionFileSourceCode;
use std::{collections::BTreeSet, error::Error, fmt::Write, fs, path::PathBuf, sync::Arc};

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    println!(
        "cargo:rustc-env=MAKA_DENO_TARGET={}",
        std::env::var("TARGET")?
    );
    println!("cargo:rerun-if-changed=src/automation/transpile.rs");
    use deno_resolver::npm::{DenoInNpmPackageChecker, NpmResolver};
    use sys_traits::impls::RealSys;
    let extensions = [
        deno_crypto::deno_crypto::init(None),
        deno_http::deno_http::init(Default::default()),
        deno_node_crypto::deno_node_crypto::init(),
        deno_node::deno_node::init::<DenoInNpmPackageChecker, NpmResolver<RealSys>, RealSys>(
            None,
            deno_fs::sync::MaybeArc::new(deno_fs::RealFs),
        ),
        deno_websocket::deno_websocket::init(),
        deno_fetch::deno_fetch::init(Default::default()),
        deno_fs::deno_fs::init(deno_fs::sync::MaybeArc::new(deno_fs::RealFs)),
        deno_io::deno_io::init(None),
        deno_net::deno_net::init(None, None),
        deno_os::deno_os::init(None),
        deno_process::deno_process::init(None),
        deno_telemetry::deno_telemetry::init(),
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
                let text = if source.specifier.ends_with("deno_node/_process/process.ts")
                    || source.specifier == "node:process"
                {
                    text.replace("__NODE_VERSION__", deno_node::NODE_VERSION)
                } else {
                    text
                };
                let path = std::path::Path::new(source.specifier);
                let is_ts = source.specifier.starts_with("node:")
                    || path.extension().is_some_and(|extension| extension == "ts");
                let text = if is_ts || !text.is_ascii() {
                    typescript::transpile(&text, path, is_ts)?
                } else {
                    text
                };
                if !text.is_ascii() {
                    return Err(format!(
                        "Deno extension source is not ASCII: {}",
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
