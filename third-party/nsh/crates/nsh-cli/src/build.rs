use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::Context as _;
use nsh_bundler::{AppInfo, BundleError, BundleOptions};

use crate::ui;

/// A failed build, formatted for terminals and for device error screens.
#[derive(Debug)]
pub(crate) struct BuildError {
    pub(crate) colored: String,
    pub(crate) plain: String,
}

impl From<BundleError> for BuildError {
    fn from(err: BundleError) -> Self {
        Self {
            colored: err.colored,
            plain: err.plain,
        }
    }
}

impl From<nsh_js::JsError> for BuildError {
    fn from(err: nsh_js::JsError) -> Self {
        Self {
            colored: err.message.clone(),
            plain: err.message,
        }
    }
}

/// A compiled app, in memory.
pub(crate) struct Built {
    /// The bundle as JS source.
    pub(crate) code: String,
    /// The bundle as QuickJS bytecode.
    pub(crate) bytecode: Vec<u8>,
    /// Source map of `code`.
    pub(crate) source_map: Option<String>,
    /// Shared and lazy chunks for a split build ([`compile_split`]).
    pub(crate) chunks: Vec<BuiltChunk>,
    /// Static chunks required by the entry, including transitive imports.
    pub(crate) entry_imports: Vec<String>,
    /// The files the app ships: those it imports and those its UI sets'
    /// crates ship ([`crate_assets`]).
    pub(crate) assets: Vec<Asset>,
    /// The directory its imported assets are named from
    /// (`nsh_bundler::Bundle::asset_root`), where the dev server finds the
    /// media files a literal `asset:/` URL names; `None` for a Rust app.
    pub(crate) asset_root: Option<PathBuf>,
    /// Files of the last build, including shared sources outside the app.
    pub(crate) watch_files: Vec<PathBuf>,
    /// What the app declares it may reach (`nsh.json` `capabilities`).
    pub(crate) capabilities: Option<nsh_core::access::Capabilities>,
    /// The UI sets it imports, by specifier ([`imported_sets`]).
    pub(crate) ui_sets: Vec<String>,
    /// What its code uses of the native modules, by export
    /// (`nsh_bundler::Bundle::native_use`); `None` when unknown (a Rust
    /// app's, a development build's).
    pub(crate) native_use: Option<nsh_bundler::NativeUse>,
    /// What the entry chunk's own code uses of them
    /// (`nsh_bundler::Bundle::entry_native_use`); `None` when unknown, and
    /// then the chunks' are not used either: everything is the entry's.
    pub(crate) entry_native_use: Option<nsh_bundler::NativeUse>,
    /// How long bundling and compiling took.
    pub(crate) elapsed: Duration,
    /// A Rust app (`nsh.json` `"root"`, [`rust_root`]): no bundle, its
    /// runners mount its root.
    pub(crate) rust_root: bool,
}

/// What a Rust app (`nsh.json` `"root"`) ships besides its runner: the
/// files its crates register (no bundle: the runner mounts the root).
pub(crate) fn rust_root() -> Built {
    Built {
        code: String::new(),
        bytecode: Vec::new(),
        source_map: None,
        chunks: Vec::new(),
        entry_imports: Vec::new(),
        assets: crate_assets().collect(),
        asset_root: None,
        watch_files: Vec::new(),
        capabilities: None,
        ui_sets: Vec::new(),
        native_use: None,
        entry_native_use: None,
        elapsed: Duration::ZERO,
        rust_root: true,
    }
}

/// A chunk of a split build: app code `import()` loads on demand.
pub(crate) struct BuiltChunk {
    /// Its id (`Screen.js`): the name the app's code imports it by, stable
    /// while the app's modules keep their names. Packagers map it to the
    /// chunk's file or URL.
    pub(crate) id: String,
    /// The chunk as JS source (an ES module).
    pub(crate) code: String,
    /// The chunk as QuickJS bytecode.
    pub(crate) bytecode: Vec<u8>,
    /// Source map of `code`.
    pub(crate) source_map: Option<String>,
    /// What its own code uses of the native modules
    /// (`nsh_bundler::Bundle::chunk_native_use`); `None` when unknown.
    pub(crate) native_use: Option<nsh_bundler::NativeUse>,
}

/// A file an app ships.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Asset {
    /// Its path among the app's assets (`asset:/<path>`), `/`-separated.
    pub(crate) path: String,
    /// The file.
    pub(crate) source: PathBuf,
}

/// The files the UI sets' crates ship (`Registry::assets`), published
/// under `@<package>/`.
pub(crate) fn crate_assets() -> impl Iterator<Item = Asset> {
    let assets: Vec<Asset> = crate::ui_sets()
        .iter()
        .flat_map(|set| &set.assets)
        .map(|file| Asset {
            path: file.path.clone(),
            source: PathBuf::from(&file.source),
        })
        .collect();
    assets.into_iter()
}

/// The native modules of `natives` that are UI sets (`nsh/base`, an
/// app's own): what a host must serve besides nsh's own modules, which
/// every host has.
fn imported_sets(natives: &[String]) -> Vec<String> {
    natives
        .iter()
        .filter(|spec| crate::ui_sets().iter().any(|set| set.specifier == **spec))
        .cloned()
        .collect()
}

/// The app's assets: `imported` (relative to the app's directory `root`,
/// the bundle's `asset_root`) and the UI sets' ([`crate_assets`]).
fn assets(root: &Path, imported: &[PathBuf]) -> Vec<Asset> {
    let mut assets: Vec<Asset> = imported
        .iter()
        .map(|rel| Asset {
            path: rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
            source: root.join(rel),
        })
        .chain(crate_assets())
        .collect();
    assets.sort_by(|a, b| a.path.cmp(&b.path));
    assets.dedup_by(|a, b| a.path == b.path);
    assets
}

impl Built {
    /// `capabilities.json` (written next to the bundle), when the app
    /// declares capabilities.
    pub(crate) fn capabilities_json(&self) -> Option<String> {
        self.capabilities.as_ref().map(|c| c.to_json().to_string())
    }

    /// `(3.2 KB js, 9.8 KB bytecode<, 2 chunks><more>, 21ms)`, dimmed.
    pub(crate) fn summary(&self, more: &str) -> String {
        let chunks = match self.chunks.len() {
            0 => String::new(),
            1 => ", 1 chunk".to_owned(),
            n => format!(", {n} chunks"),
        };
        ui::dim(format!(
            "({} js, {} bytecode{chunks}{more}, {})",
            ui::bytes(self.code.len()),
            ui::bytes(self.bytecode.len()),
            ui::duration(self.elapsed)
        ))
    }
}

impl BuildError {
    /// The error for a command that ends with it.
    pub(crate) fn into_error(self, entry: &Path) -> anyhow::Error {
        ui::failure(format!("building {} failed", ui::path(entry)), self.colored)
    }
}

/// Bundles `entry` and compiles it to bytecode: one bundle, holding what
/// `import()` loads too (native packages).
pub(crate) fn compile(entry: &Path, release: bool) -> Result<Built, BuildError> {
    compile_with(entry, release, false, release.into(), AppInfo::default())
}

/// [`compile`] in release mode for a package of `config`'s app (`split`:
/// as [`compile_split`] does, for web apps), giving it `config`'s version
/// and build number (`--version`, `--build`).
pub(crate) fn compile_package(
    entry: &Path,
    split: bool,
    config: &crate::package::AppConfig,
) -> Result<Built, BuildError> {
    compile_with(entry, true, split, true.into(), app_info(entry, config))
}

/// [`compile`], with what `import()` loads split into chunks
/// ([`Built::chunks`]) loaded on demand (web apps).
pub(crate) fn compile_split(entry: &Path, release: bool) -> Result<Built, BuildError> {
    compile_with(entry, release, true, release.into(), AppInfo::default())
}

/// [`compile`] in release mode (minified), with the bytecode stripped as
/// `strip` says (signed packages keep their line tables by default), giving
/// the app `config`'s version and build number.
pub(crate) fn compile_release(
    entry: &Path,
    strip: nsh_js::Strip,
    config: &crate::package::AppConfig,
) -> Result<Built, BuildError> {
    compile_with(entry, true, false, strip, app_info(entry, config))
}

/// The identity a package of `config`'s app carries (after `--id`,
/// `--name`, `--version` and `--build`, with the defaults the package
/// writers use: [`crate::package::name_and_id`], `1.0.0`, build `1`), so
/// `appInfo()` reports what the package says it is.
fn app_info(entry: &Path, config: &crate::package::AppConfig) -> AppInfo {
    let (name, id) = crate::package::name_and_id(entry, config);
    let mut info = AppInfo::default();
    info.id = Some(id);
    info.name = Some(name);
    info.version = Some(config.version.clone().unwrap_or_else(|| "1.0.0".to_owned()));
    info.build = Some(u64::from(config.build.unwrap_or(1)));
    info
}

fn compile_with(
    entry: &Path,
    release: bool,
    split: bool,
    strip: nsh_js::Strip,
    app: AppInfo,
) -> Result<Built, BuildError> {
    let start = Instant::now();
    let mut bundle = nsh_bundler::bundle(&BundleOptions {
        entry: entry.to_path_buf(),
        minify: release,
        development: !release,
        split,
        fail_on_unresolved_imports: false,
        ui_sets: crate::ui_sets().to_vec(),
        app,
        asset_root_from: None,
    })?;
    let sources: Vec<(&str, &str)> = std::iter::once((nsh_js::BUNDLE_NAME, bundle.code.as_str()))
        .chain(
            bundle
                .chunks
                .iter()
                .map(|c| (c.id.as_str(), c.code.as_str())),
        )
        .collect();
    let mut compiled =
        nsh_js::compile_chunk_bytecode(&bundle.code, &sources, strip, &crate::ui_sets())?
            .into_iter();
    let bytecode = compiled.next().expect("entry bytecode");
    let mut chunk_native_use = std::mem::take(&mut bundle.chunk_native_use);
    let chunks = bundle
        .chunks
        .into_iter()
        .zip(compiled)
        .map(|(c, bytecode)| BuiltChunk {
            native_use: chunk_native_use.remove(&c.id),
            id: c.id,
            code: c.code,
            bytecode,
            source_map: c.source_map,
        })
        .collect();
    Ok(Built {
        code: bundle.code,
        bytecode,
        source_map: bundle.source_map,
        chunks,
        entry_imports: bundle.entry_imports,
        assets: assets(&bundle.asset_root, &bundle.assets),
        asset_root: Some(bundle.asset_root),
        watch_files: bundle.watch_files,
        capabilities: bundle.capabilities,
        ui_sets: imported_sets(&bundle.natives),
        native_use: Some(bundle.native_use),
        entry_native_use: Some(bundle.entry_native_use),
        elapsed: start.elapsed(),
        rust_root: false,
    })
}

/// Bundles `entry` for development with hot module replacement: the whole
/// app (source and bytecode) plus the modules, to compute later updates.
pub(crate) fn compile_hot(entry: &Path) -> Result<(Built, nsh_bundler::HotBundle), BuildError> {
    let start = Instant::now();
    let hot = nsh_bundler::bundle_hot(entry, &crate::ui_sets())?;
    let (code, source_map) = hot.script();
    let bytecode = nsh_js::compile_bytecode_with(&code, false, &crate::ui_sets())?;
    let built = Built {
        code,
        bytecode,
        source_map,
        chunks: Vec::new(),
        entry_imports: Vec::new(),
        assets: assets(&hot.asset_root, &hot.assets),
        asset_root: Some(hot.asset_root.clone()),
        watch_files: hot.watch_files.clone(),
        capabilities: hot.capabilities.clone(),
        ui_sets: imported_sets(hot.natives()),
        native_use: None,
        entry_native_use: None,
        elapsed: start.elapsed(),
        rust_root: false,
    };
    Ok((built, hot))
}

/// Bundles `entry` into `out/bundle.js`, `out/bundle.js.map` and
/// `out/bundle.nshc`; `split`: with each chunk next to them
/// (`Screen.js`, `Screen.js.map`, `Screen.nshc`).
/// A Rust app (`nsh.json` `"root"`, its crates built before this command
/// line ran) writes only `app.json` and its crates' assets: its runners
/// mount the root.
pub(crate) fn build(entry: &Path, out: &Path, release: bool, split: bool) -> anyhow::Result<()> {
    let compile = if split { compile_split } else { compile };
    let built = if crate::rust_app::is_root(entry) {
        rust_root()
    } else {
        compile(entry, release).map_err(|e| e.into_error(entry))?
    };
    fs::create_dir_all(out).with_context(|| format!("create {}", out.display()))?;
    let map = built.source_map.as_deref().unwrap_or_default();
    let mut files = vec![
        ("bundle.js".to_owned(), built.code.as_bytes()),
        ("bundle.js.map".to_owned(), map.as_bytes()),
        ("bundle.nshc".to_owned(), &built.bytecode[..]),
    ];
    if built.rust_root {
        // No bundle; one left from a TSX entry would not be this app.
        for (name, _) in files.drain(..) {
            let _ = fs::remove_file(out.join(name));
        }
    }
    for chunk in &built.chunks {
        let stem = chunk.id.strip_suffix(".js").unwrap_or(&chunk.id);
        let map = chunk.source_map.as_deref().unwrap_or_default();
        files.push((chunk.id.clone(), chunk.code.as_bytes()));
        files.push((format!("{}.map", chunk.id), map.as_bytes()));
        files.push((format!("{stem}.nshc"), &chunk.bytecode[..]));
    }
    for (name, bytes) in files {
        let path = out.join(name);
        fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
    }
    // The app's id, which names where it keeps its data, and the schemes
    // it claims (`Bundle::read`).
    let app = out.join("app.json");
    let id = crate::package::app_id(entry)?;
    let config = crate::package::read_config(&dunce::canonicalize(entry)?)?;
    let schemes = config.url_schemes();
    fs::write(
        &app,
        crate::package::app_json(
            {
                let mut info = serde_json::json!({ "id": id });
                config.add_file_types_to_app_json(&mut info);
                info
            },
            &schemes,
            config.window.as_ref(),
        ),
    )
    .with_context(|| format!("write {}", app.display()))?;
    let declared = out.join("capabilities.json");
    match built.capabilities_json() {
        Some(json) => {
            fs::write(&declared, json).with_context(|| format!("write {}", declared.display()))?
        }
        None => {
            let _ = fs::remove_file(&declared);
        }
    }
    // Assets keep their paths: `asset:/img/a.png` -> `out/assets/img/a.png`.
    for asset in &built.assets {
        let dest = out.join("assets").join(&asset.path);
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::copy(&asset.source, &dest).with_context(|| format!("copy {}", asset.path))?;
    }
    let assets = match built.assets.len() {
        0 => String::new(),
        1 => ", 1 asset".to_owned(),
        n => format!(", {n} assets"),
    };
    if built.rust_root {
        ui::done(format!(
            "built the Rust app {} into {} {}",
            ui::path(entry),
            ui::path(out),
            ui::dim(format!("(no bundle: its runners mount the root{assets})"))
        ));
    } else {
        ui::done(format!(
            "built {} into {} {}",
            ui::path(entry),
            ui::path(out),
            built.summary(&assets)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Separates development bundling, hot-script assembly and QuickJS compilation.
    /// Run with `cargo test -p nsh-cli bench_dev_startup -- --ignored --nocapture`.
    #[test]
    #[ignore = "startup measurement on the counter and gallery"]
    fn bench_dev_startup() {
        use std::time::Instant;

        let sets = crate::ui_sets();
        for app in ["counter", "gallery"] {
            let entry = PathBuf::from(format!("../../examples/{app}/App.tsx"));
            for run in 0..3 {
                let start = Instant::now();
                let hot = nsh_bundler::bundle_hot(&entry, &sets).unwrap();
                let bundled = start.elapsed();
                let start = Instant::now();
                let (code, _) = hot.script();
                let assembled = start.elapsed();
                let start = Instant::now();
                let bytecode = nsh_js::compile_bytecode_with(&code, false, &sets).unwrap();
                let compiled = start.elapsed();
                assert!(!bytecode.is_empty());
                eprintln!(
                    "{app} run {run}: bundle {bundled:?}, script {assembled:?}, bytecode {compiled:?}; {} source bytes, {} bytecode bytes",
                    code.len(),
                    bytecode.len()
                );
            }
        }
    }

    #[test]
    fn hosts_must_serve_the_ui_sets_an_app_imports() {
        let natives = ["nsh", "nsh/mobile", "nsh/base"].map(String::from);
        assert_eq!(super::imported_sets(&natives), ["nsh/base"]);
    }

    #[test]
    fn imported_assets_keep_their_paths_under_the_app() {
        let assets = super::assets(
            Path::new("/app"),
            &[PathBuf::from("img/a.png"), PathBuf::from("b.ttf")],
        );
        let paths: Vec<_> = assets
            .iter()
            .map(|a| (a.path.as_str(), a.source.clone()))
            .collect();
        assert_eq!(
            paths,
            [
                ("b.ttf", PathBuf::from("/app/b.ttf")),
                ("img/a.png", PathBuf::from("/app/img/a.png")),
            ]
        );
    }

    /// An entry below its app (`tests/SubApp.tsx`, which a test opens)
    /// ships the files it imports from anywhere in the app, named from the
    /// app's directory as the app's own entry names them (#1483).
    #[test]
    fn an_entry_below_its_app_ships_assets_named_from_the_app() {
        let dir = std::env::temp_dir().join(format!("nsh-cli-sub-assets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::create_dir_all(dir.join("tests")).unwrap();
        std::fs::write(dir.join("nsh.json"), "{}").unwrap();
        std::fs::write(dir.join("App.tsx"), "export {};\n").unwrap();
        // A PNG's header: all the bundler reads of it.
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend(4u32.to_be_bytes());
        png.extend(4u32.to_be_bytes());
        png.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
        std::fs::write(dir.join("assets/dot.png"), &png).unwrap();
        std::fs::write(
            dir.join("tests/SubApp.tsx"),
            "import { Image, mount } from \"nsh\";\nimport dot from \"../assets/dot.png\";\nmount(() => <Image src={dot} />);\n",
        )
        .unwrap();
        let root = dunce::canonicalize(&dir).unwrap();
        let check = |built: &super::Built| {
            assert!(
                built.code.contains("\"asset:/assets/dot.png\""),
                "{}",
                built.code
            );
            let asset = built
                .assets
                .iter()
                .find(|a| a.path == "assets/dot.png")
                .expect("the image ships");
            assert_eq!(asset.source, root.join("assets/dot.png"));
            assert!(asset.source.is_file());
            assert_eq!(built.asset_root.as_deref(), Some(root.as_path()));
        };
        let entry = dir.join("tests/SubApp.tsx");
        check(&super::compile(&entry, false).unwrap());
        check(&super::compile_hot(&entry).unwrap().0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
