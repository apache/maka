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

use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Serialize)]
pub struct CompiledUi {
    module: PathBuf,
    assets: Vec<Asset>,
    pub inputs: Vec<PathBuf>,
}

#[derive(Serialize)]
struct Asset {
    path: String,
    file: PathBuf,
}

pub fn compile(entry: &Path, output: &Path) -> Result<CompiledUi> {
    let entry = fs::canonicalize(entry)?;
    let output = std::path::absolute(output)?;
    let mut host = nsh_core::element::Registry::ui_set("maka/host");
    host.native_values(&["host", "AttachmentPicker", "TerminalGrid", "UploadIntake"]);
    let bundled = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: entry.clone(),
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into(), host.into()],
    })?;
    fs::create_dir_all(&output)?;
    let module = output.join("bundle.js");
    fs::write(&module, bundled.code)?;
    let mut assets = Vec::with_capacity(bundled.assets.len());
    for (index, asset) in bundled.assets.iter().enumerate() {
        let file = output.join("assets").join(index.to_string());
        fs::create_dir_all(file.parent().unwrap())?;
        fs::copy(&asset.source, &file)?;
        assets.push(Asset {
            path: asset.path.clone(),
            file,
        });
    }
    let manifest = CompiledUi {
        module,
        assets,
        inputs: bundled.watch_files,
    };
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(manifest)
}
