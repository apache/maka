//! Bundles and compiles `app/` as `nsh build` does, into `$OUT_DIR/app`
//! (`bundle.js`, its source map, `bundle.nshc`, `app.json`,
//! `capabilities.json` when the app declares any, `assets/`), which
//! `main.rs` runs: `cargo run` alone builds the example and its app.
//!
//! The bundler compiles the app against nsh's own modules and UI set; the
//! host's set (`host/trading`) and components are reached by name at run
//! time (`nativeModule`, `nativeComponent`), so the build needs nothing of
//! them.

use std::{
    fs,
    path::{Path, PathBuf},
};

use nsh_bundler::BundleOptions;

fn main() {
    let dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("app");
    // The app's sources, its `nsh.json` and anything it imports from there.
    println!("cargo:rerun-if-changed={}", dir.display());
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("app");
    // `nsh build --release` in a release build: minified, bytecode stripped.
    let release = std::env::var("PROFILE").is_ok_and(|p| p == "release");
    if let Err(message) = build(&dir.join("App.tsx"), &out, release) {
        // Cargo shows a failed build script's output: the code frame.
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn build(entry: &Path, out: &Path, release: bool) -> Result<(), String> {
    // `nsh/base` as the toolchain takes it: data (`SetDescription`).
    let ui_sets = vec![nsh_core::element::description::SetDescription::from(
        nsh_base::registry(),
    )];
    let bundle = nsh_bundler::bundle(&BundleOptions {
        entry: entry.to_path_buf(),
        minify: release,
        split: false,
        ui_sets: ui_sets.clone(),
    })
    .map_err(|e| e.plain)?;
    let bytecode =
        nsh_js::compile_bytecode_with(&bundle.code, release, &ui_sets).map_err(|e| e.message)?;
    let _ = fs::remove_dir_all(out);
    let write = |name: &str, bytes: &[u8]| {
        let path = out.join(name);
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
    };
    write("bundle.js", bundle.code.as_bytes())?;
    write(
        "bundle.js.map",
        bundle.source_map.as_deref().unwrap_or_default().as_bytes(),
    )?;
    write("bundle.nshc", &bytecode)?;
    // The app's id, which names where it keeps its data (`Bundle::read`).
    let config = fs::read_to_string(entry.with_file_name("nsh.json"))
        .ok()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
    let id = config
        .as_ref()
        .and_then(|c| c["id"].as_str())
        .ok_or("app/nsh.json needs an `id`")?;
    write(
        "app.json",
        serde_json::json!({ "id": id }).to_string().as_bytes(),
    )?;
    if let Some(capabilities) = &bundle.capabilities {
        write(
            "capabilities.json",
            capabilities.to_json().to_string().as_bytes(),
        )?;
    }
    // Assets keep their paths: `asset:/img/a.png` -> `assets/img/a.png`;
    // the UI sets' under `@<package>/`.
    let root = entry.parent().unwrap();
    let imported = bundle.assets.iter().map(|rel| {
        let path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        (path, root.join(rel))
    });
    let shipped = ui_sets
        .iter()
        .flat_map(|set| &set.assets)
        .map(|file| (file.path.clone(), PathBuf::from(&file.source)));
    for (path, source) in imported.chain(shipped) {
        let bytes = fs::read(&source).map_err(|e| format!("read {}: {e}", source.display()))?;
        write(&format!("assets/{path}"), &bytes)?;
    }
    Ok(())
}
