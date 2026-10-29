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

use super::{Result, failed};
use deno_core::{Extension, ExtensionFileSource};
use std::collections::BTreeSet;

struct EmbeddedExtensionSources {
    name: &'static str,
    js_files: &'static [ExtensionFileSource],
    esm_files: &'static [ExtensionFileSource],
    lazy_loaded_esm_files: &'static [ExtensionFileSource],
    lazy_loaded_js_files: &'static [ExtensionFileSource],
}

include!(concat!(env!("OUT_DIR"), "/plugin_extension_sources.rs"));

pub(super) fn embed(extensions: &mut [Extension]) -> Result<()> {
    for extension in extensions {
        let embedded = EXTENSIONS
            .iter()
            .find(|embedded| embedded.name == extension.name)
            .ok_or_else(|| failed(format!("missing embedded extension: {}", extension.name)))?;
        let mut specifiers = BTreeSet::new();
        for (files, embedded_files) in [
            (&mut extension.js_files, embedded.js_files),
            (&mut extension.esm_files, embedded.esm_files),
            (
                &mut extension.lazy_loaded_esm_files,
                embedded.lazy_loaded_esm_files,
            ),
            (
                &mut extension.lazy_loaded_js_files,
                embedded.lazy_loaded_js_files,
            ),
        ] {
            if files.len() != embedded_files.len() {
                return Err(failed(format!(
                    "embedded source count changed for extension {}",
                    extension.name
                )));
            }
            for (source, embedded_source) in files.to_mut().iter_mut().zip(embedded_files) {
                if source.specifier != embedded_source.specifier
                    || !specifiers.insert(source.specifier)
                    || !embedded_source.is_runtime_loadable()
                {
                    return Err(failed(format!(
                        "missing, reordered or duplicate embedded source: {}",
                        source.specifier
                    )));
                }
                source.code = embedded_source.code.clone();
            }
        }
    }
    Ok(())
}
