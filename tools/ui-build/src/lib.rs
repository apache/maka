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

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Clone, Deserialize, Serialize)]
pub struct CompiledUi {
    pub module: PathBuf,
    pub assets: Vec<Asset>,
    pub inputs: Vec<PathBuf>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Asset {
    pub path: String,
    pub file: PathBuf,
}

#[derive(Deserialize, Serialize)]
struct Cache {
    entry: PathBuf,
    output: PathBuf,
    configuration: Option<PathBuf>,
    compiler: String,
    inputs: BTreeMap<PathBuf, String>,
    outputs: BTreeMap<PathBuf, String>,
    manifest: CompiledUi,
}

/// Use only for the UI tool or Cargo build script, never the complete product executable.
pub fn compiler_identity() -> Result<String> {
    let path = std::env::current_exe()?;
    let metadata = fs::metadata(&path)?;
    // Cargo recreates these local compiler artifacts when their code or dependencies change.
    Ok(format!(
        "{path:?}:{}:{:?}",
        metadata.len(),
        metadata.modified()?
    ))
}

/// Compile a UI entry, reusing verified output when its compiler and inputs are unchanged.
pub fn compile_cached(entry: &Path, output: &Path, compiler: &str) -> Result<CompiledUi> {
    let entry = fs::canonicalize(entry)?;
    let output = std::path::absolute(output)?;
    let record = output.join("cache.json");
    if let Some(bytes) = read_optional(&record)? {
        match serde_json::from_slice::<Cache>(&bytes) {
            Ok(cache)
                if cache.entry == entry
                    && cache.output == output
                    && cache.configuration == configuration(&entry)
                    && cache.compiler == compiler
                    && matches_files(&cache.inputs)?
                    && matches_files(&cache.outputs)? =>
            {
                return Ok(cache.manifest);
            }
            Ok(_) => {}
            Err(error) => eprintln!("rebuilding UI cache {}: {error}", record.display()),
        }
    }
    let started = SystemTime::now();
    let manifest = compile(&entry, &output)?;
    let inputs = fingerprint(&manifest.inputs)?;
    let outputs = fingerprint(
        &std::iter::once(manifest.module.clone())
            .chain(manifest.assets.iter().map(|asset| asset.file.clone()))
            .chain(std::iter::once(output.join("manifest.json")))
            .collect::<Vec<_>>(),
    )?;
    // Inputs written during compilation may not match the bytes read by the bundler.
    if manifest.inputs.iter().try_fold(true, |stable, input| {
        Ok::<_, io::Error>(stable && fs::metadata(input)?.modified()? <= started)
    })? {
        write_if_changed(
            &record,
            &serde_json::to_vec(&Cache {
                configuration: configuration(&entry),
                entry,
                output,
                compiler: compiler.into(),
                inputs,
                outputs,
                manifest: manifest.clone(),
            })?,
        )?;
    } else if record.exists() {
        fs::remove_file(record)?;
    }
    Ok(manifest)
}

/// Compile and stage a plugin's NSH module and assets without a persistent input cache.
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
    write_if_changed(&module, bundled.code.as_bytes())?;
    let mut assets = Vec::with_capacity(bundled.assets.len());
    for (index, asset) in bundled.assets.iter().enumerate() {
        let file = output.join("assets").join(index.to_string());
        write_if_changed(&file, &fs::read(&asset.source)?)?;
        assets.push(Asset {
            path: asset.path.clone(),
            file,
        });
    }
    let asset_directory = output.join("assets");
    if asset_directory.exists() {
        for entry in fs::read_dir(asset_directory)? {
            let path = entry?.path();
            if !assets.iter().any(|asset| asset.file == path) {
                fs::remove_file(path)?;
            }
        }
    }
    let mut inputs = bundled.watch_files;
    inputs.push(entry.clone());
    if let Some(configuration) = configuration(&entry) {
        inputs.push(configuration);
    }
    inputs.sort();
    inputs.dedup();
    let manifest = CompiledUi {
        module,
        assets,
        inputs,
    };
    write_if_changed(
        &output.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(manifest)
}

pub fn write_if_changed(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if read_optional(path)?.as_deref() != Some(bytes) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, bytes)?;
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn configuration(entry: &Path) -> Option<PathBuf> {
    let configuration = entry
        .parent()
        .expect("canonical entry parent")
        .join("nsh.json");
    configuration.is_file().then_some(configuration)
}

fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn fingerprint(paths: &[PathBuf]) -> io::Result<BTreeMap<PathBuf, String>> {
    paths
        .iter()
        .map(|path| Ok((path.clone(), digest(&fs::read(path)?))))
        .collect()
}

fn matches_files(expected: &BTreeMap<PathBuf, String>) -> io::Result<bool> {
    for (path, expected) in expected {
        if read_optional(path)?.is_none_or(|bytes| digest(&bytes) != *expected) {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn label(module: &Path) -> String {
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                "import { pathToFileURL } from 'node:url'; const ui = await import(pathToFileURL(process.argv[1])); console.log(ui.label);",
            ])
            .arg(module)
            .output()
            .expect("execute the compiled module with Node");
        assert!(
            output.status.success(),
            "compiled module failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("UTF-8 module output")
    }

    #[test]
    fn compilation_reuses_outputs_and_tracks_changed_removed_and_cleaned_inputs() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("package.json"),
            r#"{"type":"module"}"#,
        )
        .unwrap();
        let entry = directory.path().join("entry.ts");
        let dependency = directory.path().join("label.ts");
        let output = directory.path().join("output");
        fs::write(&entry, "export { label } from './label';").unwrap();
        fs::write(&dependency, "export const label = 'original label';").unwrap();
        let compiled = compile_cached(&entry, &output, "compiler").unwrap();
        assert_eq!(label(&compiled.module), "original label\n");
        let unchanged = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        fs::File::options()
            .write(true)
            .open(&compiled.module)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(unchanged))
            .unwrap();
        compile_cached(&entry, &output, "compiler").unwrap();
        assert_eq!(
            fs::metadata(&compiled.module).unwrap().modified().unwrap(),
            unchanged
        );

        fs::write(&dependency, "export const label = 'updated 中文 label';").unwrap();
        compile_cached(&entry, &output, "compiler").unwrap();
        assert_eq!(label(&compiled.module), "updated 中文 label\n");

        fs::write(&entry, "export const label = 'inline label';").unwrap();
        fs::remove_file(dependency).unwrap();
        compile_cached(&entry, &output, "compiler").unwrap();
        assert_eq!(label(&compiled.module), "inline label\n");

        fs::remove_file(&compiled.module).unwrap();
        compile_cached(&entry, &output, "compiler").unwrap();
        assert_eq!(label(&compiled.module), "inline label\n");
        fs::remove_file(output.join("manifest.json")).unwrap();
        compile_cached(&entry, &output, "compiler").unwrap();
        let restored: CompiledUi =
            serde_json::from_slice(&fs::read(output.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(label(&restored.module), "inline label\n");
    }
}
