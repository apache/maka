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
    asset_root: Option<PathBuf>,
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
pub fn compile_cached(
    entry: &Path,
    output: &Path,
    asset_root: Option<&Path>,
    compiler: &str,
) -> Result<CompiledUi> {
    let entry = fs::canonicalize(entry)?;
    let output = std::path::absolute(output)?;
    let asset_root = asset_root.map(fs::canonicalize).transpose()?;
    let record = output.join("cache.json");
    if let Some(bytes) = read_optional(&record)? {
        match serde_json::from_slice::<Cache>(&bytes) {
            Ok(cache)
                if cache.entry == entry
                    && cache.output == output
                    && cache.asset_root == asset_root
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
    let manifest = compile(&entry, &output, asset_root.as_deref())?;
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
                asset_root,
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
pub fn compile(entry: &Path, output: &Path, asset_root: Option<&Path>) -> Result<CompiledUi> {
    let entry = fs::canonicalize(entry)?;
    let output = std::path::absolute(output)?;
    let mut host = nsh_core::element::Registry::ui_set("maka/host");
    host.native_values(&[
        "host",
        "AttachmentPicker",
        "ComposerInput",
        "TerminalGrid",
        "UploadIntake",
    ]);
    let bundled = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: entry.clone(),
        minify: false,
        split: false,
        fail_on_unresolved_imports: true,
        ui_sets: vec![nsh_base::registry().into(), host.into()],
        asset_root_from: asset_root.map(Path::to_path_buf),
        ..Default::default()
    })?;
    fs::create_dir_all(&output)?;
    let module = output.join("bundle.js");
    write_if_changed(&module, bundled.code.as_bytes())?;
    let mut assets = Vec::with_capacity(bundled.assets.len());
    for (index, asset) in bundled.assets.iter().enumerate() {
        let file = output.join("assets").join(index.to_string());
        write_if_changed(&file, &fs::read(bundled.asset_root.join(asset))?)?;
        assets.push(Asset {
            path: asset
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
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
    let directory = entry.parent().expect("canonical entry parent");
    let configuration = directory.join("nsh.json");
    if configuration.is_file() {
        return Some(configuration);
    }
    // An app's own entry stops discovery before an enclosing app's config.
    if fs::read_dir(directory).is_ok_and(|entries| {
        entries.filter_map(std::result::Result::ok).any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("App.tsx"))
        })
    }) {
        return None;
    }
    directory
        .ancestors()
        .skip(1)
        .map(|parent| parent.join("nsh.json"))
        .find(|path| path.is_file())
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
    fn assert_label(module: &Path, expected: &str) {
        let host = nsh_js::Host::new().unwrap();
        host.add_chunk_source("fixture.js", fs::read_to_string(module).unwrap(), None);
        host.eval_source("import { importModule } from 'nsh'; globalThis.compiledUi = await importModule('fixture.js');").unwrap();
        assert!(
            host.eval_script(
                "label",
                &format!(
                    "globalThis.compiledUi.label === {}",
                    serde_json::to_string(expected).unwrap()
                )
            )
            .unwrap()
        );
    }

    #[test]
    fn compilation_reuses_outputs_and_tracks_changed_removed_and_cleaned_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let entry = directory.path().join("entry.ts");
        let dependency = directory.path().join("label.ts");
        let output = directory.path().join("output");
        fs::write(&entry, "export { label } from './label';").unwrap();
        fs::write(&dependency, "export const label = 'original label';").unwrap();
        let compiled = compile_cached(&entry, &output, None, "compiler").unwrap();
        assert_label(&compiled.module, "original label");
        let unchanged = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        fs::File::options()
            .write(true)
            .open(&compiled.module)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(unchanged))
            .unwrap();
        compile_cached(&entry, &output, None, "compiler").unwrap();
        assert_eq!(
            fs::metadata(&compiled.module).unwrap().modified().unwrap(),
            unchanged
        );

        fs::write(&dependency, "export const label = 'updated 中文 label';").unwrap();
        compile_cached(&entry, &output, None, "compiler").unwrap();
        assert_label(&compiled.module, "updated 中文 label");

        fs::write(&entry, "export const label = 'inline label';").unwrap();
        fs::remove_file(dependency).unwrap();
        compile_cached(&entry, &output, None, "compiler").unwrap();
        assert_label(&compiled.module, "inline label");

        fs::remove_file(&compiled.module).unwrap();
        compile_cached(&entry, &output, None, "compiler").unwrap();
        assert_label(&compiled.module, "inline label");
        fs::remove_file(output.join("manifest.json")).unwrap();
        compile_cached(&entry, &output, None, "compiler").unwrap();
        let restored: CompiledUi =
            serde_json::from_slice(&fs::read(output.join("manifest.json")).unwrap()).unwrap();
        assert_label(&restored.module, "inline label");
    }

    #[test]
    fn missing_package_fails_before_writing_outputs_and_rebuilds_after_install() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let entry = root.join("entry.ts");
        let output = root.join("output");
        fs::write(
            &entry,
            "import { signal } from 'nsh'; import { label as packageLabel } from 'pele'; export const label = signal(packageLabel)();",
        )
        .unwrap();

        let error = compile_cached(&entry, &output, None, "compiler")
            .err()
            .expect("an unresolved package must fail the build");
        let diagnostic = error.to_string();
        assert!(diagnostic.contains("UNRESOLVED_IMPORT"), "{diagnostic}");
        assert!(diagnostic.contains("pele"), "{diagnostic}");
        assert!(diagnostic.contains("entry.ts"), "{diagnostic}");
        assert!(!output.exists());

        let package = root.join("node_modules/pele");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("package.json"),
            r#"{"name":"pele","type":"module","exports":"./index.js"}"#,
        )
        .unwrap();
        fs::write(
            package.join("index.js"),
            "export const label = 'bundled package';",
        )
        .unwrap();

        let compiled = compile_cached(&entry, &output, None, "compiler").unwrap();
        assert_label(&compiled.module, "bundled package");
    }

    #[test]
    fn shared_assets_use_the_declared_root_and_stage_the_original_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("plugin/ui")).unwrap();
        fs::create_dir_all(root.join("shared")).unwrap();
        fs::write(root.join("nsh.json"), "{}").unwrap();
        fs::write(root.join("plugin/ui/nsh.json"), "{}").unwrap();
        fs::write(
            root.join("shared/icon #.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="12"/>"#,
        )
        .unwrap();
        fs::write(root.join("shared/content.bin"), [0, 42, 255]).unwrap();
        fs::write(root.join("shared/view.ts"), "import icon from './icon #.svg'; import content from './content.bin?url'; export { icon, content };").unwrap();
        let entry = root.join("plugin/ui/entry.ts");
        fs::write(&entry, "export { icon, content } from '../../shared/view';").unwrap();
        let output = root.join("output");
        let compiled = compile_cached(&entry, &output, Some(root), "compiler").unwrap();
        let error = compile_cached(&entry, &output, None, "compiler")
            .err()
            .expect("a cached bundle must not bypass a changed asset root");
        assert!(
            error.to_string().contains("outside the app's directory"),
            "{error}"
        );
        assert_eq!(
            compiled
                .assets
                .iter()
                .map(|asset| asset.path.as_str())
                .collect::<Vec<_>>(),
            ["shared/content.bin", "shared/icon #.svg"]
        );
        for asset in &compiled.assets {
            assert_eq!(
                fs::read(&asset.file).unwrap(),
                fs::read(root.join(&asset.path)).unwrap()
            );
            assert!(
                compiled
                    .inputs
                    .contains(&fs::canonicalize(root.join(&asset.path)).unwrap())
            );
        }
        fs::write(root.join("shared/content.bin"), [3, 2, 1]).unwrap();
        let changed = compile_cached(&entry, &output, Some(root), "compiler").unwrap();
        let content = changed
            .assets
            .iter()
            .find(|asset| asset.path == "shared/content.bin")
            .unwrap();
        assert_eq!(fs::read(&content.file).unwrap(), [3, 2, 1]);
        // The source tree can be installed elsewhere without changing packaged names.
        let relocated = tempfile::tempdir().unwrap();
        fs::create_dir_all(relocated.path().join("plugin/ui")).unwrap();
        fs::create_dir_all(relocated.path().join("shared")).unwrap();
        for file in [
            "nsh.json",
            "plugin/ui/nsh.json",
            "plugin/ui/entry.ts",
            "shared/view.ts",
            "shared/icon #.svg",
            "shared/content.bin",
        ] {
            fs::copy(root.join(file), relocated.path().join(file)).unwrap();
        }
        let installed = compile(
            &relocated.path().join("plugin/ui/entry.ts"),
            &relocated.path().join("output"),
            Some(relocated.path()),
        )
        .unwrap();
        assert_eq!(
            installed
                .assets
                .iter()
                .map(|asset| &asset.path)
                .collect::<Vec<_>>(),
            changed
                .assets
                .iter()
                .map(|asset| &asset.path)
                .collect::<Vec<_>>()
        );
    }
}
