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
use std::{env, fs, path::Path, process::Command};

use super::ui;

fn files(directory: &Path, output: &mut Vec<std::path::PathBuf>) {
    let mut entries = fs::read_dir(directory)
        .expect("product source directory")
        .map(|entry| entry.expect("product source entry"))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let kind = entry.file_type().expect("product source type");
        assert!(
            !kind.is_symlink(),
            "product sources cannot contain symlinks"
        );
        if kind.is_dir() {
            files(&entry.path(), output);
        } else {
            assert!(kind.is_file(), "product source must be a regular file");
            output.push(entry.path());
        }
    }
}

pub fn bundle() {
    let crate_dir = std::path::PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let repo = crate_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    println!("cargo:rerun-if-changed=build/main.rs");
    println!("cargo:rerun-if-changed=build/product.rs");
    println!("cargo:rerun-if-changed=build/ui.rs");
    let output = std::path::PathBuf::from(env::var_os("OUT_DIR").unwrap());
    println!("cargo:rerun-if-env-changed=MAKA_JS_DEPS");
    let dependencies = env::var_os("MAKA_JS_DEPS")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| repo.to_owned());
    for path in [
        repo.join("package.json"),
        repo.join("package-lock.json"),
        dependencies.join("node_modules/.package-lock.json"),
        repo.join("products/maka/bundle/package.json"),
        repo.join("products/maka/bundle/scripts/build.mjs"),
        repo.join("products/maka/bundle/package-inputs.json"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    for path in [
        "products/maka/bundle/src",
        "packages/plugin-sdk/src",
        "plugins",
        "scripts/plugins",
    ] {
        // Watching directories includes additions and removals as well as edits.
        println!("cargo:rerun-if-changed={}", repo.join(path).display());
    }
    let ui_bundles = output.join("ui-bundles");
    if ui_bundles.exists() {
        fs::remove_dir_all(&ui_bundles).expect("replace generated UI bundles");
    }
    fs::create_dir_all(&ui_bundles).expect("create generated UI bundle directory");
    let ui_entries = output.join("ui-entries.json");
    let status = Command::new("node")
        .arg(repo.join("products/maka/bundle/scripts/build.mjs"))
        .arg("--ui-entries")
        .arg(&ui_entries)
        .current_dir(repo)
        .stdin(std::process::Stdio::null())
        .status()
        .expect("Node is required to read product UI declarations");
    assert!(status.success(), "product UI declaration discovery failed");
    let entries: Vec<std::path::PathBuf> =
        serde_json::from_slice(&fs::read(&ui_entries).expect("read product UI entries"))
            .expect("product UI source paths");
    let mut index = serde_json::Map::new();
    for (position, entry) in entries.iter().enumerate() {
        let manifest = ui::compile(entry, &ui_bundles.join(position.to_string()))
            .expect("compile product NSH UI entry");
        for input in &manifest.inputs {
            println!("cargo:rerun-if-changed={}", input.display());
        }
        index.insert(
            entry.to_string_lossy().into_owned(),
            serde_json::to_value(manifest).expect("compiled UI manifest"),
        );
    }
    fs::write(
        ui_bundles.join("index.json"),
        serde_json::to_vec_pretty(&index).expect("encode compiled UI bundle index"),
    )
    .expect("write compiled UI bundle index");
    let product = output.join("product");
    let status = Command::new("node")
        .arg(repo.join("products/maka/bundle/scripts/build.mjs"))
        .arg("--output")
        .arg(&product)
        .env("MAKA_UI_BUNDLE_DIR", &ui_bundles)
        .current_dir(repo)
        .stdin(std::process::Stdio::null())
        .status()
        .expect("Node is required to bundle ordinary product packages at build time");
    assert!(
        status.success(),
        "product bundle failed; install locked npm dependencies first"
    );
    let mut source = format!(
        "const PRODUCT_VERSION: &str = include_str!({:?});\nconst AUTHORING: &str = include_str!({:?});\nconst BUNDLED: &[Bundled] = &[\n",
        product.join("product-version.txt").to_str().unwrap(),
        product.join("authoring/composition.mjs").to_str().unwrap()
    );
    let packages = product.join("packages");
    let mut entries = fs::read_dir(&packages)
        .unwrap()
        .map(|entry| entry.unwrap())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        assert!(entry.file_type().unwrap().is_dir());
        let name = entry.file_name().into_string().unwrap();
        let mut paths = Vec::new();
        files(&entry.path(), &mut paths);
        source.push_str(&format!("Bundled {{ name: {name:?}, files: &[\n"));
        for path in paths {
            let relative = path
                .strip_prefix(entry.path())
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            source.push_str(&format!(
                "({relative:?}, include_bytes!({:?})),\n",
                path.to_str().unwrap()
            ));
        }
        source.push_str("] },\n");
    }
    source.push_str("];\n");
    fs::write(output.join("product-assets.rs"), source).unwrap();
}
