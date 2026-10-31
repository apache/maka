//! The web as a target: `nsh package --target web` writes a static site
//! (as a frontend build does), and the dev server serves a web host page
//! (`nsh run --target web`).
//!
//! A packaged site, `<out>/<name>/`:
//!
//! ```text
//! index.html                       the app's page (the only file that changes in place)
//! manifest.webmanifest             name, icons, colors (installing it as an app)
//! nsh.<digest>.js                  the DOM runtime
//! nsh.<digest>.wasm                the engine, the core and the components
//! nsh-bindgen.<digest>.js          wasm-bindgen's glue, for crates that call JS (`crate::bindgen`)
//! snippets.<digest>/<crate>-<hash>/ the JS snippets the glue imports, under their own paths
//! app.<digest>.js                  the app's browser ES module
//! browser.<digest>/               the browser binding modules and licenses
//! host.<digest>.js                 the page's host (`nsh.json` `web.host`), when the app has one
//! <chunk>.<digest>.js              what `import()` loads, fetched when first imported
//! assets/<path>.<digest>.<ext>     `asset:/<path>`, loaded from its URL when used
//! icons/<size>.<digest>.png        favicon, apple-touch-icon, the manifest's
//! ```
//!
//! Every file but the page and the manifest has a digest of its content in
//! its name, so hosts cache them for good and a release only replaces the
//! page. The page names the others and maps `asset:/<path>` to its file;
//! fonts are fetched before the app starts, as text is measured with them
//! synchronously.
//!
//! The app's TSX runs as browser ES modules on the browser's JavaScript
//! engine; the development host's page does the same with development
//! bundles and hot updates.

use std::{
    collections::BTreeSet,
    fmt::Write as _,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use anyhow::{Context as _, bail};
use sha2::{Digest as _, Sha256};

use crate::{
    build::Built,
    package::{AppConfig, PackageOptions},
    runtime::{self, WebRuntime},
    ui,
};

mod prune;

/// The packaged page; `{{…}}` are filled in by [`page`].
const PAGE: &str = include_str!("web/index.html");
/// The development host's page, which the dev server serves at `/`.
const DEV_PAGE: &str = include_str!("web/dev.html");

/// The UI sets the web runtime serves: nsh's, and for an app with
/// Rust components of its own the app's set too (its runtime is built with
/// the sets this command line has, `rust_app::RustApp::web`).
fn ui_sets() -> Vec<String> {
    crate::ui_sets()
        .iter()
        .map(|set| set.specifier.clone())
        .collect()
}

/// Hex digits of the SHA-256 in content-addressed names.
const DIGEST_LEN: usize = 10;

/// Ports `--run` tries first (the next free one is used).
const PORT: u16 = 4173;

/// Writes the site `<out>/<name>/` and, with `--run`, serves it on this
/// machine (the address is printed for the user to open).
pub(crate) fn package(
    options: &PackageOptions<'_>,
    config: &AppConfig,
    name: &str,
    id: &str,
    built: &Built,
) -> anyhow::Result<()> {
    let served = ui_sets();
    let missing: Vec<&str> = built
        .ui_sets
        .iter()
        .map(String::as_str)
        .filter(|set| !served.iter().any(|s| s == set))
        .collect();
    if !missing.is_empty() {
        bail!(
            "the web runtime has no {}, which the app imports",
            missing.join(", ")
        );
    }
    let runtime = runtime::package_web()?;
    let dir = options.out.join(name);
    let step = ui::Step::start(format!("packaging {}", ui::path(&dir)));
    if dir.exists() {
        fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
    }
    let site = Site::new(&dir)?;
    let js = fs::read_to_string(&runtime.js)
        .with_context(|| format!("read {}", runtime.js.display()))?;
    let browser_path =
        publish_browser_host(&site, runtime.js.parent().context("runtime has no parent")?)?;
    let js = js.replace(
        "./browser/runtime.js",
        &format!("./{browser_path}/runtime.js"),
    );
    // About a third of its size: the runtime is downloaded before anything
    // shows (the app's code is minified as it is bundled).
    let js = nsh_bundler::minify_module("nsh.js", &js).map_err(anyhow::Error::msg)?;
    let js = site.add("nsh.js", js.as_bytes())?;
    // Linked for the app: the parts of `nsh/base` and the standard
    // modules it does not use are left out. An app with Rust components of
    // its own has a runtime built for it.
    let linkable =
        fs::read(&runtime.wasm).with_context(|| format!("read {}", runtime.wasm.display()))?;
    let linked = match crate::rust_app::current() {
        Some(_) => linkable,
        None => {
            let gates = linked_gates(built.native_use.as_ref());
            let exports = prune::exports(&linkable)?;
            let keep: Vec<&str> = exports
                .iter()
                .map(String::as_str)
                .filter(|name| !is_gate(name) || gates.iter().any(|g| g == name))
                .collect();
            prune::prune(&linkable, &keep)?
        }
    };
    let wasm = site.add("nsh.wasm", &linked)?;
    // What the runtime fetches when it first needs it: the syntaxes it
    // highlights code with, which every page would download otherwise.
    let mut data = serde_json::Map::new();
    if let Some(path) = &runtime.syntaxes {
        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        data.insert(
            "syntaxes".into(),
            site.add(runtime::SYNTAXES, &bytes)?.into(),
        );
    }
    // The wasm-bindgen glue of a runtime whose crates call JS through
    // wasm-bindgen (`crate::bindgen`).
    let glue = runtime
        .glue
        .as_deref()
        .map(|path| publish_glue(&site, path))
        .transpose()?;
    // A Rust app has no code of its own besides its runtime: the page
    // mounts its root.
    let code = if built.rust_root {
        String::new()
    } else {
        site.add("app.js", built.code.as_bytes())?
    };
    // Chunk id -> URL: the page hands the map to the runtime, which fetches
    // lazy chunks on demand. Static entry dependencies are staged before startup.
    let mut chunks = serde_json::Map::new();
    for chunk in &built.chunks {
        let stem = chunk.id.strip_suffix(".js").unwrap_or(&chunk.id);
        let url = site.add(&format!("{stem}.js"), chunk.code.as_bytes())?;
        chunks.insert(chunk.id.clone(), url.into());
    }
    let mut assets = serde_json::Map::new();
    let mut fonts = Vec::new();
    for asset in &built.assets {
        let bytes = fs::read(&asset.source).with_context(|| format!("read {}", asset.path))?;
        let url = site.add(&format!("assets/{}", asset.path), &bytes)?;
        if is_font(&asset.path) {
            fonts.push(asset.path.clone());
        }
        assets.insert(asset.path.clone(), url.into());
    }
    // The page imports it as it is: one module, its imports absolute URLs.
    let host = match &config.web.host {
        Some(path) => {
            let path = crate::package::web_host_module(options.entry, path)?;
            let bytes = fs::read(&path)
                .with_context(|| format!("read nsh.json web.host {}", path.display()))?;
            Some(site.add("host.js", &bytes)?)
        }
        None => None,
    };
    let icons = match &config.icon {
        Some(icon) => Icons::write(&site, icon)?,
        None => Icons::default(),
    };
    let (fonts, chunk_fonts) = font_loads(&fonts, &built.code, &built.chunks);
    let appearance = Appearance::of(config);
    fs::write(
        dir.join("manifest.webmanifest"),
        manifest(name, id, appearance, &icons),
    )?;
    let mut app = serde_json::json!({
        "id": id,
        "wasm": wasm,
        "code": code,
        "capabilities": built.capabilities_json(),
        "rust": built.rust_root,
        "assets": assets,
        "data": data,
        "fonts": fonts,
        "chunkFonts": chunk_fonts,
        "chunks": chunks,
        "entryChunks": built.entry_imports,
        "host": host,
    });
    if let Some(glue) = &glue {
        app["glue"] = glue.as_str().into();
    }
    let html = page(&PageParts {
        name,
        appearance,
        icons: &icons,
        runtime: &js,
        wasm: &wasm,
        glue: glue.as_deref(),
        code: &code,
        fonts: &fonts
            .iter()
            .map(|path| assets[path].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>(),
        app: &app,
        connect: connect_src(
            built.capabilities.as_ref(),
            &page_connect(&config.web.connect)?,
        )
        .as_deref(),
    });
    fs::write(dir.join("index.html"), html)?;
    step.done(format!(
        "packaged {}{}",
        ui::path(&dir),
        ui::dim(format!(", {}", ui::bytes(dir_size(&dir))))
    ));
    if options.run {
        serve(&dir)?;
    }
    Ok(())
}

/// Whether `name` is the export of a part of `nsh/base`, of a standard
/// module or of a feature (shaders), which a runtime linked for an app
/// keeps only when it uses them.
fn is_gate(name: &str) -> bool {
    ["nsh_part_", "nsh_std_", "nsh_feature_"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// The gates ([`is_gate`]) a runtime linked for an app that uses `uses` of
/// the native modules keeps: `nsh/base`'s core, the part of each other
/// name it imports from `nsh/base` (`nsh/base/plot` is the plot part's),
/// `zlib`'s operations when it imports `zlib`, and shaders when it may
/// make a shader view (`NativeUse::shader`, or an import of `Shader`). What the bundler cannot
/// tell apart (no analysis, `import * as`, an `import()` of a computed
/// specifier) keeps everything, so a runtime never lacks what an app needs.
pub(crate) fn linked_gates(uses: Option<&nsh_bundler::NativeUse>) -> Vec<String> {
    let all = || {
        let mut gates: Vec<String> = nsh_base::parts::ALL
            .iter()
            .map(|(name, _)| format!("nsh_part_{name}"))
            .collect();
        gates.push("nsh_std_zlib".into());
        gates.push("nsh_feature_shader".into());
        gates
    };
    let Some(uses) = uses else { return all() };
    if uses.computed_import {
        return all();
    }
    let mut gates = vec!["nsh_part_core".to_owned()];
    if uses.shader {
        gates.push("nsh_feature_shader".into());
    }
    let mut add = |gate: String| {
        if !gates.contains(&gate) {
            gates.push(gate);
        }
    };
    for (module, imported) in &uses.imports {
        match module.as_str() {
            "zlib" => add("nsh_std_zlib".into()),
            // Shaders are `nsh`'s `Shader` element.
            "nsh" => match imported {
                nsh_bundler::Imported::All => add("nsh_feature_shader".into()),
                nsh_bundler::Imported::Names(names) => {
                    if names.iter().any(|n| n == "Shader") {
                        add("nsh_feature_shader".into());
                    }
                }
            },
            "nsh/base/plot" => add("nsh_part_plot".into()),
            nsh_base::SPECIFIER => match imported {
                nsh_bundler::Imported::All => return all(),
                nsh_bundler::Imported::Names(names) => {
                    for name in names {
                        if let Some(part) = part_of(name) {
                            add(format!("nsh_part_{part}"));
                        }
                    }
                }
            },
            _ => {}
        }
    }
    gates
}

/// The part of `nsh/base` beyond its core that exports `name`.
fn part_of(name: &str) -> Option<&'static str> {
    static PARTS: OnceLock<Vec<(&'static str, BTreeSet<String>)>> = OnceLock::new();
    let parts = PARTS.get_or_init(|| {
        let core = core_exports();
        nsh_base::parts::ALL
            .iter()
            .filter(|(name, _)| *name != "core")
            .map(|(name, part)| {
                let set =
                    nsh_base::registry_of([nsh_base::parts::core as nsh_base::parts::Part, *part]);
                let names = set_exports(&set)
                    .into_iter()
                    .filter(|n| !core.contains(n))
                    .collect();
                (*name, names)
            })
            .collect()
    });
    parts
        .iter()
        .find(|(_, names)| names.contains(name))
        .map(|(part, _)| *part)
}

/// The names a UI set exports: components, classes, modules and values.
fn set_exports(set: &nsh_core::element::Registry) -> BTreeSet<String> {
    let mut names: BTreeSet<String> = set.specs().iter().map(|s| s.export.to_string()).collect();
    names.extend(set.class_specs().iter().map(|c| c.name.to_owned()));
    names.extend(set.module_specs().iter().map(|m| m.name.to_owned()));
    names.extend(set.native_value_names().iter().map(|n| (*n).to_owned()));
    names
}

/// What `nsh/base`'s core part exports (`nsh_base::parts::core`, with
/// the navigation and `Input` every set has).
fn core_exports() -> &'static BTreeSet<String> {
    static EXPORTS: OnceLock<BTreeSet<String>> = OnceLock::new();
    EXPORTS.get_or_init(|| {
        set_exports(&nsh_base::registry_of([
            nsh_base::parts::core as nsh_base::parts::Part
        ]))
    })
}

/// Serves the site `dir` on this machine, as a CDN would (`nsh_dev::SiteServer`),
/// until stopped; prints its address.
fn serve(dir: &Path) -> anyhow::Result<()> {
    let mut server = None;
    for port in (PORT..PORT + 10).chain([0]) {
        if let Ok(s) =
            nsh_dev::SiteServer::start(SocketAddr::from(([127, 0, 0, 1], port)), dir.into())
        {
            server = Some(s);
            break;
        }
    }
    let server = server.context("no free port to serve the site on")?;
    let url = format!("http://127.0.0.1:{}/", server.local_addr().port());
    ui::note(format!("serving {} at {url}", ui::path(dir)));
    let _stoppable = ui::Stoppable::new();
    while !ui::stop_requested() {
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

/// The browser host's modules and their licenses next to `nsh.js` in
/// `root` (its `browser/`), by name: what the page imports them as. None
/// without the directory (a runtime that only runs a Rust app).
fn browser_host_paths(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let dir = root.join("browser");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(&dir)
        .with_context(|| format!("read {}", dir.display()))?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.retain(|path| {
        path.extension()
            .is_some_and(|ext| ext == "js" || ext == "txt")
    });
    paths.sort();
    Ok(paths)
}

/// The dev host's copies of the browser host's files ([`browser_host_paths`]),
/// served under `browser/`.
fn browser_host_files(root: &Path) -> anyhow::Result<Vec<(String, Vec<u8>)>> {
    browser_host_paths(root)?
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .context("host file has no name")?
                .to_string_lossy()
                .into_owned();
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            Ok((format!("browser/{name}"), bytes))
        })
        .collect()
}

/// Version the complete facade directory together so relative ES imports
/// remain valid, and every public file keeps immutable cache semantics.
fn publish_browser_host(site: &Site, root: &Path) -> anyhow::Result<String> {
    let mut files = Vec::new();
    let mut content = Vec::new();
    for path in browser_host_paths(root)? {
        let name = path
            .file_name()
            .context("host file has no name")?
            .to_string_lossy()
            .into_owned();
        let code = fs::read_to_string(&path)?;
        let code = if name.ends_with(".js") {
            nsh_bundler::minify_module(&name, &code).map_err(anyhow::Error::msg)?
        } else {
            code
        };
        content.extend_from_slice(name.as_bytes());
        content.push(0);
        content.extend_from_slice(code.as_bytes());
        files.push((name, code));
    }
    let directory = format!("browser.{}", digest(&content));
    for (name, code) in files {
        site.write(&format!("{directory}/{name}"), code.as_bytes())?;
    }
    Ok(directory)
}

/// Adds the wasm-bindgen glue `path` (`crate::bindgen`) to `site`, named by
/// its content as the runtime is, and returns its URL. The snippets it
/// imports go under one directory named by all of them and their paths
/// (`snippets.<digest>/`), where they keep the paths they have under
/// `snippets/`: their imports of one another resolve as in development.
fn publish_glue(site: &Site, path: &Path) -> anyhow::Result<String> {
    let glue = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut snippets = Vec::new();
    for (name, file) in crate::bindgen::snippets(path)? {
        let bytes = fs::read(&file).with_context(|| format!("read {}", file.display()))?;
        snippets.push((name, bytes));
    }
    let glue = if snippets.is_empty() {
        glue
    } else {
        let mut all = Vec::new();
        for (name, bytes) in &snippets {
            all.extend(name.as_bytes());
            all.push(0);
            all.extend((bytes.len() as u64).to_le_bytes());
            all.extend(bytes);
        }
        let dir = format!("snippets.{}", digest(&all));
        for (name, bytes) in &snippets {
            let name = name.strip_prefix("snippets/").unwrap_or(name);
            site.write(&format!("{dir}/{name}"), bytes)?;
        }
        crate::bindgen::link_snippets(&glue, &dir)
    };
    let glue =
        nsh_bundler::minify_module(crate::bindgen::GLUE, &glue).map_err(anyhow::Error::msg)?;
    site.add(crate::bindgen::GLUE, glue.as_bytes())
}

/// The first [`DIGEST_LEN`] hex digits of the SHA-256 of `bytes`.
fn digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(DIGEST_LEN);
    for byte in digest.iter().take(DIGEST_LEN.div_ceil(2)) {
        let _ = write!(hex, "{byte:02x}");
    }
    hex.truncate(DIGEST_LEN);
    hex
}

/// Files by their path on the server.
pub(crate) type Files = Vec<(String, Vec<u8>)>;

/// The dev server's web host: its page and the runtime's files, for
/// `nsh_dev::DevServer::serve_web`. `nsh.version` names the runtime the
/// page was served with: an app with Rust components of its own gets a new
/// one when its Rust code changes (the session starts again), and a page
/// that reconnects to a server with another one loads again.
/// `rust`: a Rust app's runtime (`nsh.json` `"root"`), whose page runs its
/// root rather than the bundles the server sends. The page still names its
/// host module as `{{host}}`: [`with_page_host`] fills it in for an app.
pub(crate) fn dev_host(runtime: &WebRuntime, rust: bool) -> anyhow::Result<(String, Files)> {
    let read = |path: &Path| fs::read(path).with_context(|| format!("read {}", path.display()));
    let ui_sets = serde_json::to_string(&ui_sets())?;
    let js = read(&runtime.js)?;
    let wasm = read(&runtime.wasm)?;
    let glue = runtime.glue.as_deref().map(read).transpose()?;
    // `nsh.js` fetches the syntaxes next to itself when code is highlighted.
    let syntaxes = runtime.syntaxes.as_deref().map(read).transpose()?;
    // The snippets the glue imports, at the paths it imports them by.
    let snippets = match &runtime.glue {
        Some(path) => crate::bindgen::snippets(path)?
            .into_iter()
            .map(|(name, file)| Ok((name, read(&file)?)))
            .collect::<anyhow::Result<Vec<_>>>()?,
        None => Vec::new(),
    };
    // The browser host's modules, which `nsh.js` imports from `./browser/`.
    let browser = browser_host_files(runtime.js.parent().context("runtime has no parent")?)?;
    let mut parts = vec![digest(&js), digest(&wasm)];
    parts.extend(
        browser
            .iter()
            .map(|(name, bytes)| digest(&[name.as_bytes(), bytes].concat())),
    );
    parts.extend(glue.as_deref().map(digest));
    parts.extend(
        snippets
            .iter()
            .map(|(name, bytes)| digest(&[name.as_bytes(), bytes].concat())),
    );
    let version = digest(&parts.concat().into_bytes());
    let page = DEV_PAGE
        .replace(
            "{{protocol}}",
            &nsh_dev::protocol::PROTOCOL_VERSION.to_string(),
        )
        .replace("{{ui_sets}}", &ui_sets)
        .replace("{{runtime}}", &serde_json::to_string(&version)?)
        .replace("{{rust}}", if rust { "true" } else { "false" })
        .replace(
            "{{glue}}",
            if glue.is_some() {
                "\"./nsh-bindgen.js\""
            } else {
                "null"
            },
        );
    let mut files = vec![
        ("nsh.js".to_owned(), js),
        ("nsh.wasm".to_owned(), wasm),
        ("nsh.version".to_owned(), version.into_bytes()),
    ];
    files.extend(browser);
    if let Some(glue) = glue {
        files.push((crate::bindgen::GLUE.to_owned(), glue));
    }
    files.extend(snippets);
    if let Some(syntaxes) = syntaxes {
        files.push((runtime::SYNTAXES.to_owned(), syntaxes));
    }
    Ok((page, files))
}

/// The dev host's page and files ([`dev_host`]) for the app at `entry`:
/// with its page's host module (`nsh.json` `web.host`) as `nsh-host.js`,
/// read now (a change takes another session), or none.
pub(crate) fn with_page_host(
    (page, mut files): (String, Files),
    entry: &Path,
) -> anyhow::Result<(String, Files)> {
    let module = crate::package::read_config(entry)?
        .web
        .host
        .map(|host| crate::package::web_host_module(entry, &host))
        .transpose()?;
    let host = match module {
        Some(path) => {
            let bytes = fs::read(&path)
                .with_context(|| format!("read nsh.json web.host {}", path.display()))?;
            files.retain(|(name, _)| name != PAGE_HOST);
            files.push((PAGE_HOST.to_owned(), bytes));
            format!("\"./{PAGE_HOST}\"")
        }
        None => "null".to_owned(),
    };
    Ok((page.replace("{{host}}", &host), files))
}

/// Where the dev host serves the page's host module ([`with_page_host`]).
const PAGE_HOST: &str = "nsh-host.js";

/// The app's appearance (`nsh.json` `appearance`): the page's background
/// and theme color before the app draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Appearance {
    Light,
    Dark,
    System,
}

impl Appearance {
    fn of(config: &AppConfig) -> Appearance {
        match config.appearance.as_deref() {
            Some("light") => Appearance::Light,
            Some("dark") => Appearance::Dark,
            _ => Appearance::System,
        }
    }

    /// The background in light and dark mode.
    fn colors(self) -> (&'static str, &'static str) {
        match self {
            Appearance::Light => (LIGHT, LIGHT),
            Appearance::Dark => (DARK, DARK),
            Appearance::System => (LIGHT, DARK),
        }
    }
}

const LIGHT: &str = "#ffffff";
const DARK: &str = "#000000";

/// A directory files are added to under content-addressed names.
struct Site {
    dir: PathBuf,
}

impl Site {
    fn new(dir: &Path) -> anyhow::Result<Site> {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        Ok(Site { dir: dir.into() })
    }

    /// Writes `bytes` as `path` with their digest in its name
    /// ([`hashed_name`]); returns its URL relative to the page.
    fn add(&self, path: &str, bytes: &[u8]) -> anyhow::Result<String> {
        let name = hashed_name(path, bytes);
        self.write(&name, bytes)?;
        Ok(url_path(&name))
    }

    /// Writes `bytes` as `path`, a name that changes with them already (in
    /// a directory named by its content).
    fn write(&self, path: &str, bytes: &[u8]) -> anyhow::Result<()> {
        let file = self.dir.join(path);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&file, bytes).with_context(|| format!("write {}", file.display()))
    }
}

/// `dir/name.ext` → `dir/name.<digest>.ext` (`name.<digest>` without an
/// extension), the digest being the first [`DIGEST_LEN`] hex digits of
/// the SHA-256 of `bytes`.
fn hashed_name(path: &str, bytes: &[u8]) -> String {
    let hex = digest(bytes);
    let (dir, file) = match path.rsplit_once('/') {
        Some((dir, file)) => (format!("{dir}/"), file),
        None => (String::new(), path),
    };
    match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{dir}{stem}.{hex}.{ext}"),
        _ => format!("{dir}{file}.{hex}"),
    }
}

/// `path` as a relative URL: what is not unreserved (or `/`) escaped.
fn url_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b'@' => {
                out.push(byte as char)
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// When the page fetches each font (`fonts`, paths): those only chunks
/// register (their logical asset path occurs in the compiled import) come
/// with the chunk that needs them, by chunk id; the
/// others (the entry's, the UI sets', which the engine registers as it
/// starts) before the app starts. Fonts are read synchronously, so each
/// must be there before the code registering it runs.
fn font_loads(
    fonts: &[String],
    entry: &str,
    chunks: &[crate::build::BuiltChunk],
) -> (Vec<String>, serde_json::Map<String, serde_json::Value>) {
    let mut eager = Vec::new();
    let mut by_chunk = serde_json::Map::new();
    for font in fonts {
        let users: Vec<&crate::build::BuiltChunk> =
            chunks.iter().filter(|c| c.code.contains(font)).collect();
        if entry.contains(font) || users.is_empty() {
            eager.push(font.clone());
            continue;
        }
        for chunk in users {
            let list = by_chunk
                .entry(chunk.id.clone())
                .or_insert_with(|| serde_json::Value::Array(Vec::new()));
            if let serde_json::Value::Array(list) = list {
                list.push(font.clone().into());
            }
        }
    }
    (eager, by_chunk)
}

/// Fonts are read synchronously when the app starts or imports them: the
/// page fetches them first.
fn is_font(path: &str) -> bool {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    matches!(ext.as_deref(), Some("ttf" | "otf" | "ttc"))
}

/// The app's icon at the sizes browsers use, by URL.
#[derive(Default)]
struct Icons {
    /// The favicon (32 px).
    favicon: Option<String>,
    /// `apple-touch-icon` (180 px).
    touch: Option<String>,
    /// The manifest's (192 and 512 px).
    manifest: Vec<(u32, String)>,
}

impl Icons {
    fn write(site: &Site, icon: &Path) -> anyhow::Result<Icons> {
        let image = image::open(icon).with_context(|| format!("read {}", icon.display()))?;
        let png = |size: u32| -> anyhow::Result<String> {
            let scaled = image.resize_to_fill(size, size, image::imageops::FilterType::Lanczos3);
            let mut bytes = Vec::new();
            scaled
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .context("encode the icon")?;
            site.add(&format!("icons/{size}.png"), &bytes)
        };
        Ok(Icons {
            favicon: Some(png(32)?),
            touch: Some(png(180)?),
            manifest: vec![(192, png(192)?), (512, png(512)?)],
        })
    }
}

/// `manifest.webmanifest`: what a browser installs the app as.
fn manifest(name: &str, id: &str, appearance: Appearance, icons: &Icons) -> String {
    let (light, dark) = appearance.colors();
    let background = if appearance == Appearance::Dark {
        dark
    } else {
        light
    };
    let icons: Vec<_> = icons
        .manifest
        .iter()
        .map(|(size, url)| {
            serde_json::json!({ "src": url, "sizes": format!("{size}x{size}"), "type": "image/png" })
        })
        .collect();
    let manifest = serde_json::json!({
        "id": id,
        "name": name,
        "short_name": name,
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "background_color": background,
        "theme_color": background,
        "icons": icons,
    });
    serde_json::to_string_pretty(&manifest).unwrap_or_default()
}

/// `nsh.json` `web.connect`, checked as `capabilities.network.hosts` are:
/// patterns of letters, digits, `.`, `-`, `:` and brackets (nothing that
/// could end a CSP source).
fn page_connect(hosts: &[String]) -> anyhow::Result<Vec<nsh_core::access::HostPattern>> {
    hosts
        .iter()
        .map(|host| {
            nsh_core::access::HostPattern::new(host)
                .map_err(|e| anyhow::anyhow!("nsh.json web.connect: {e}"))
        })
        .collect()
}

/// The page's `connect-src` when the app restricts the hosts it reaches
/// (`capabilities.network`): the browser then refuses every request, and
/// every redirect hop, to another host, which nsh cannot see (the browser
/// follows redirects before telling). `'self'` stays: the page loads the
/// runtime, the code and the fonts with `fetch`, and the app's relative
/// URLs reach its own origin (nsh still checks those against the
/// declaration). `page`: the hosts the page's host module reaches
/// (`web.connect`), allowed to the page alone: nsh checks the app's
/// requests against its declaration before the browser sees them. `None`:
/// no declaration, or one (or `page`) that allows any host.
fn connect_src(
    capabilities: Option<&nsh_core::access::Capabilities>,
    page: &[nsh_core::access::HostPattern],
) -> Option<String> {
    let network = &capabilities?.network;
    let mut sources = vec!["'self'".to_owned()];
    let mut add = |scheme: &str, host: &str, port: Option<u16>| {
        let host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        let authority = if let Some(port) = port {
            format!("{host}:{port}")
        } else if host.ends_with(']') || !host.contains(':') {
            format!("{host}:*")
        } else {
            host.to_owned()
        };
        let source = format!("{scheme}://{authority}");
        if !sources.contains(&source) {
            sources.push(source);
        }
    };
    for host in network.hosts.iter().chain(page) {
        let host = host.as_str();
        if host == "*" {
            return None;
        }
        for scheme in ["http", "https", "ws", "wss"] {
            add(scheme, host, None);
        }
    }
    for grant in &network.http {
        let get = grant.methods.is_empty() || grant.methods.iter().any(|method| method == "GET");
        for scheme in ["http", "https", "ws", "wss"] {
            if !grant.schemes.is_empty() && !grant.schemes.iter().any(|s| s == scheme) {
                continue;
            }
            if matches!(scheme, "http" | "https") {
                add(scheme, grant.host.as_str(), grant.port);
            }
            // NSH checks a WebSocket handshake as GET over http/https,
            // or against a legacy ws/wss grant. CSP needs explicit schemes.
            if get {
                let websocket = match scheme {
                    "http" | "ws" => "ws",
                    _ => "wss",
                };
                add(websocket, grant.host.as_str(), grant.port);
            }
        }
    }
    Some(sources.join(" "))
}

/// What [`page`] fills in.
struct PageParts<'a> {
    name: &'a str,
    appearance: Appearance,
    icons: &'a Icons,
    /// URL of `nsh.js`.
    runtime: &'a str,
    wasm: &'a str,
    /// URL of the wasm-bindgen glue, if the runtime has one.
    glue: Option<&'a str>,
    code: &'a str,
    /// URLs of the fonts fetched before the app starts.
    fonts: &'a [String],
    /// What the page's script reads.
    app: &'a serde_json::Value,
    /// The page's `connect-src` ([`connect_src`]).
    connect: Option<&'a str>,
}

/// The app's `index.html`.
fn page(parts: &PageParts<'_>) -> String {
    let (light, dark) = parts.appearance.colors();
    let mut head = String::new();
    if let Some(sources) = parts.connect {
        let _ = writeln!(
            head,
            "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src {sources}\">"
        );
    }
    match parts.appearance {
        Appearance::System => {
            let _ = writeln!(
                head,
                "<meta name=\"color-scheme\" content=\"light dark\">\n\
                 <meta name=\"theme-color\" content=\"{light}\" media=\"(prefers-color-scheme: light)\">\n\
                 <meta name=\"theme-color\" content=\"{dark}\" media=\"(prefers-color-scheme: dark)\">"
            );
        }
        Appearance::Light | Appearance::Dark => {
            let scheme = if parts.appearance == Appearance::Dark {
                "dark"
            } else {
                "light"
            };
            let _ = writeln!(
                head,
                "<meta name=\"color-scheme\" content=\"{scheme}\">\n\
                 <meta name=\"theme-color\" content=\"{light}\">"
            );
        }
    }
    let _ = writeln!(
        head,
        "<link rel=\"manifest\" href=\"manifest.webmanifest\">"
    );
    if let Some(favicon) = &parts.icons.favicon {
        let _ = writeln!(
            head,
            "<link rel=\"icon\" type=\"image/png\" sizes=\"32x32\" href=\"{favicon}\">"
        );
    }
    if let Some(touch) = &parts.icons.touch {
        let _ = writeln!(head, "<link rel=\"apple-touch-icon\" href=\"{touch}\">");
    }
    // The runtime imports the glue as it loads (`nsh.js`' `glue`).
    if let Some(glue) = parts.glue {
        let _ = writeln!(head, "<link rel=\"modulepreload\" href=\"{glue}\">");
    }
    // Requested while the page is parsed, before the runtime has loaded, and
    // once: the page's script takes these responses (`fetches`) and reports
    // their errors (the empty `catch` only keeps a failure that happens
    // before then from being logged as unhandled). Not `<link rel=preload>`:
    // WebKit does not hand a preload still in flight to the `fetch` of the
    // same URL, which downloads the file again.
    let urls: Vec<&str> = [parts.wasm, parts.code]
        .into_iter()
        .filter(|url| !url.is_empty())
        .chain(parts.fonts.iter().map(String::as_str))
        .collect();
    let urls = serde_json::json!(urls).to_string().replace("</", "<\\/");
    let _ = writeln!(
        head,
        "<script>const fetches = new Map({urls}.map((url) => {{ const response = fetch(url); response.catch(() => {{}}); return [url, response]; }}));</script>"
    );
    // JSON in a script: `</script>` in a string must not end it.
    let app = parts.app.to_string().replace("</", "<\\/");
    // The page's colors until the app draws (and on its error screen).
    let colors = |background: &str| {
        let text = if background == DARK {
            "#f2f2f7"
        } else {
            "#1c1c1e"
        };
        format!("html, body {{ background: {background}; color: {text}; }}")
    };
    let colors = match parts.appearance {
        Appearance::System => format!(
            "  {}\n  @media (prefers-color-scheme: dark) {{ {} }}",
            colors(light),
            colors(dark)
        ),
        Appearance::Light | Appearance::Dark => format!("  {}", colors(light)),
    };
    PAGE.replace("{{title}}", &escape_html(parts.name))
        .replace("{{head}}", head.trim_end())
        .replace("{{colors}}", &colors)
        .replace("{{runtime}}", parts.runtime)
        .replace("{{app}}", &app)
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn dir_size(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            _ => entry.metadata().map_or(0, |m| m.len() as usize),
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_carry_the_digest_of_the_content() {
        let a = hashed_name("assets/img/logo@2x.png", b"one");
        assert!(a.starts_with("assets/img/logo@2x."), "{a}");
        assert!(a.ends_with(".png"), "{a}");
        assert_eq!(a.len(), "assets/img/logo@2x..png".len() + DIGEST_LEN);
        assert_eq!(a, hashed_name("assets/img/logo@2x.png", b"one"));
        assert_ne!(a, hashed_name("assets/img/logo@2x.png", b"two"));
        assert_eq!(
            hashed_name("LICENSE", b"x").len(),
            "LICENSE.".len() + DIGEST_LEN
        );
        assert!(hashed_name(".env", b"x").starts_with(".env."));
    }

    #[test]
    fn the_dev_page_runs_the_apps_page_host() {
        let dir = std::env::temp_dir().join(format!("nsh-web-dev-host-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("App.tsx");
        let base = || ("const HOST = {{host}};".to_owned(), Files::new());
        // No nsh.json, or one without `web.host`: no host.
        let (page, files) = with_page_host(base(), &entry).unwrap();
        assert_eq!(page, "const HOST = null;");
        assert!(files.is_empty());
        fs::write(dir.join("host.js"), "export function createHost() {}").unwrap();
        fs::write(dir.join("nsh.json"), r#"{ "web": { "host": "host.js" } }"#).unwrap();
        let (page, files) = with_page_host(base(), &entry).unwrap();
        assert_eq!(page, "const HOST = \"./nsh-host.js\";");
        assert_eq!(
            files,
            [(
                "nsh-host.js".to_owned(),
                b"export function createHost() {}".to_vec()
            )]
        );
        // Outside the app's directory: refused, as `nsh package` does.
        fs::write(
            dir.join("nsh.json"),
            r#"{ "web": { "host": "../host.js" } }"#,
        )
        .unwrap();
        assert!(with_page_host(base(), &entry).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    fn uses(imports: &[(&str, Option<&[&str]>)]) -> nsh_bundler::NativeUse {
        let mut uses = nsh_bundler::NativeUse::default();
        for (module, names) in imports {
            let imported = match names {
                Some(names) => {
                    nsh_bundler::Imported::Names(names.iter().map(|n| n.to_string()).collect())
                }
                None => nsh_bundler::Imported::All,
            };
            uses.imports.insert(module.to_string(), imported);
        }
        uses
    }

    #[test]
    fn a_linked_runtime_keeps_the_parts_and_modules_the_app_uses() {
        let gates = |imports: &[(&str, Option<&[&str]>)]| {
            let mut gates = linked_gates(Some(&uses(imports)));
            gates.sort();
            gates
        };
        let core: &[&str] = &["Button", "Switch", "Tabs", "Tab", "NavStack", "AlertDialog"];
        assert_eq!(
            gates(&[("nsh", Some(&["mount", "View"]))]),
            ["nsh_part_core"]
        );
        assert_eq!(
            gates(&[
                ("nsh", Some(&["mount"])),
                ("nsh/base", Some(core)),
                ("buffer", None),
                ("crypto", Some(&["createHash"])),
            ]),
            ["nsh_part_core"]
        );
        assert_eq!(
            gates(&[("nsh/base", Some(&["Button", "Editor"]))]),
            ["nsh_part_core", "nsh_part_editor"]
        );
        assert_eq!(
            gates(&[
                ("nsh/base", Some(&["TextView"])),
                ("zlib", Some(&["gzipSync"]))
            ]),
            ["nsh_part_core", "nsh_part_text_view", "nsh_std_zlib"]
        );
        assert_eq!(
            gates(&[("nsh/base/plot", Some(&["Plot"]))]),
            ["nsh_part_core", "nsh_part_plot"]
        );
        assert_eq!(
            gates(&[("nsh", Some(&["mount", "Shader"]))]),
            ["nsh_feature_shader", "nsh_part_core"]
        );
        let every = nsh_base::parts::ALL.len() + 2;
        assert_eq!(gates(&[("nsh/base", None)]).len(), every);
        let mut computed = uses(&[]);
        computed.computed_import = true;
        assert_eq!(linked_gates(Some(&computed)).len(), every);
        assert_eq!(linked_gates(None).len(), every);
    }

    #[test]
    fn the_dev_host_serves_the_syntaxes_next_to_nsh_js() {
        let dir = std::env::temp_dir().join(format!("nsh-web-syntaxes-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let syntaxes = dir.join(runtime::SYNTAXES);
        fs::write(&syntaxes, "dump").unwrap();
        let runtime = WebRuntime {
            wasm: dir.join("nsh-dev.wasm"),
            js: dir.join("nsh.js"),
            glue: None,
            syntaxes: Some(syntaxes),
        };
        fs::write(&runtime.js, "js").unwrap();
        fs::write(&runtime.wasm, "one").unwrap();
        let (_, files) = dev_host(&runtime, false).unwrap();
        let (_, bytes) = files
            .iter()
            .find(|(p, _)| p == "nsh-syntaxes.bin")
            .expect("the syntaxes are served");
        assert_eq!(bytes, b"dump");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The syntaxes copied from the workspace's two-face are a dump that
    /// the web runtime's syntect reads (`nsh-base`'s `syntax.rs`).
    #[test]
    fn the_syntaxes_file_is_a_dump_syntect_reads() {
        let dir = std::env::temp_dir().join(format!("nsh-web-dump-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml");
        let path = runtime::write_syntaxes(&manifest, &dir).unwrap();
        let set: syntect::parsing::SyntaxSet =
            syntect::dumps::from_uncompressed_data(&fs::read(path).unwrap()).unwrap();
        for language in ["rs", "tsx", "json"] {
            assert!(set.find_syntax_by_token(language).is_some(), "{language}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_dev_page_knows_its_runtime() {
        let dir = std::env::temp_dir().join(format!("nsh-web-dev-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let runtime = WebRuntime {
            wasm: dir.join("nsh-dev.wasm"),
            js: dir.join("nsh.js"),
            glue: None,
            syntaxes: None,
        };
        fs::write(&runtime.js, "js").unwrap();
        fs::write(&runtime.wasm, "one").unwrap();
        let (page, files) = dev_host(&runtime, false).unwrap();
        let version = |files: &Files| {
            let (_, bytes) = files.iter().find(|(p, _)| p == "nsh.version").unwrap();
            String::from_utf8(bytes.clone()).unwrap()
        };
        let first = version(&files);
        // A page reloads when the server's runtime is not the one it has.
        assert!(
            page.contains(&format!("const RUNTIME = \"{first}\";")),
            "{page}"
        );
        // The page's host is the app's (`with_page_host`).
        assert!(!page.replace("{{host}}", "").contains("{{"), "{page}");
        // `nsh/base` with its submodules, each a module the page serves.
        assert!(
            page.contains("const UI_SETS = [\"nsh/base\",\"nsh/base/plot\"];"),
            "{page}"
        );
        fs::write(&runtime.wasm, "two").unwrap();
        assert_ne!(version(&dev_host(&runtime, false).unwrap().1), first);
        assert!(
            dev_host(&runtime, true)
                .unwrap()
                .0
                .contains("const RUST = true;")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wasm_bindgen_glue_is_served_and_loaded_by_the_dev_page() {
        let dir = std::env::temp_dir().join(format!("nsh-web-glue-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut runtime = WebRuntime {
            wasm: dir.join("nsh-dev.wasm"),
            js: dir.join("nsh.js"),
            glue: None,
            syntaxes: None,
        };
        fs::write(&runtime.js, "js").unwrap();
        fs::write(&runtime.wasm, "one").unwrap();
        let (plain, plain_files) = dev_host(&runtime, false).unwrap();
        assert!(plain.contains("const GLUE = null;"), "{plain}");
        let names = |files: &Files| files.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
        assert_eq!(names(&plain_files), ["nsh.js", "nsh.wasm", "nsh.version"]);
        let glue = dir.join("nsh-dev-bindgen.js");
        fs::write(&glue, "export {};").unwrap();
        let snippet = crate::bindgen::output_dir(&glue).join("snippets/app-1/inline0.js");
        fs::create_dir_all(snippet.parent().unwrap()).unwrap();
        fs::write(&snippet, "export const a = 1;").unwrap();
        runtime.glue = Some(glue.clone());
        let (page, files) = dev_host(&runtime, false).unwrap();
        assert!(
            page.contains("const GLUE = \"./nsh-bindgen.js\";"),
            "{page}"
        );
        assert!(page.contains("glue: GLUE ?? undefined"), "{page}");
        // The glue's snippets at the paths it imports them by.
        assert_eq!(
            names(&files),
            [
                "nsh.js",
                "nsh.wasm",
                "nsh.version",
                "nsh-bindgen.js",
                "snippets/app-1/inline0.js"
            ]
        );
        // Another glue is another runtime: an open page loads again.
        let version = |files: &Files| {
            files
                .iter()
                .find(|(p, _)| p == "nsh.version")
                .unwrap()
                .1
                .clone()
        };
        fs::write(&glue, "export { a };").unwrap();
        assert_ne!(
            version(&files),
            version(&dev_host(&runtime, false).unwrap().1)
        );
        assert_ne!(version(&files), version(&plain_files));
        // So is another snippet.
        let before = version(&dev_host(&runtime, false).unwrap().1);
        fs::write(&snippet, "export const a = 2;").unwrap();
        assert_ne!(before, version(&dev_host(&runtime, false).unwrap().1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wasm_bindgen_snippets_are_published_under_one_directory_named_by_them() {
        let dir = std::env::temp_dir().join(format!("nsh-web-snippets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let glue = dir.join("runtime/nsh-bindgen.js");
        let snippets = crate::bindgen::output_dir(&glue).join("snippets/app-1");
        fs::create_dir_all(snippets.join("js")).unwrap();
        fs::write(
            &glue,
            "import { twice } from './snippets/app-1/inline0.js';\n\
             export function __nsh_imports() { return { twice }; }\n",
        )
        .unwrap();
        // A snippet that imports another one, as in development.
        fs::write(
            snippets.join("inline0.js"),
            "import { shout } from './js/shout.js';\n\
             export function twice(s) { return shout(s + s); }\n",
        )
        .unwrap();
        fs::write(
            snippets.join("js/shout.js"),
            "export function shout(s) { return s.toUpperCase(); }\n",
        )
        .unwrap();
        let publish = |name: &str| {
            let site = Site::new(&dir.join(name)).unwrap();
            let url = publish_glue(&site, &glue).unwrap();
            let published = fs::read_to_string(site.dir.join(&url)).unwrap();
            let snippets = fs::read_dir(&site.dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with("snippets."))
                .collect::<Vec<_>>();
            (site.dir.clone(), url, published, snippets)
        };
        let (site, url, published, found) = publish("one");
        assert!(
            url.starts_with("nsh-bindgen.") && url.ends_with(".js"),
            "{url}"
        );
        let [snippets] = found.as_slice() else {
            panic!("one directory of snippets: {found:?}");
        };
        assert_eq!(snippets.len(), "snippets.".len() + DIGEST_LEN);
        assert!(
            published.contains(&format!("./{snippets}/app-1/inline0.js")),
            "{published}"
        );
        // The snippets keep their paths and their imports of one another.
        let inline = fs::read_to_string(site.join(snippets).join("app-1/inline0.js")).unwrap();
        assert!(inline.contains("from './js/shout.js'"), "{inline}");
        assert!(site.join(snippets).join("app-1/js/shout.js").exists());
        // Another snippet is another directory, and another glue.
        fs::write(
            crate::bindgen::output_dir(&glue).join("snippets/app-1/js/shout.js"),
            "export function shout(s) { return s.toLowerCase(); }\n",
        )
        .unwrap();
        let (_, other_url, _, other) = publish("two");
        assert_ne!(other, found);
        assert_ne!(other_url, url);
        // Without snippets, only the glue.
        fs::remove_dir_all(crate::bindgen::output_dir(&glue)).unwrap();
        let (_, _, plain, none) = publish("three");
        assert!(none.is_empty(), "{none:?}");
        assert!(plain.contains("./snippets/app-1/inline0.js"), "{plain}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wasm_bindgen_glue_is_preloaded_by_the_package_page() {
        let icons = Icons::default();
        let app = serde_json::Value::Null;
        let parts = |glue| PageParts {
            name: "App",
            appearance: Appearance::System,
            icons: &icons,
            runtime: "nsh.0123456789.js",
            wasm: "nsh.0123456789.wasm",
            glue,
            code: "app.1.js",
            fonts: &[],
            app: &app,
            connect: None,
        };
        let with = page(&parts(Some("nsh-bindgen.0123456789.js")));
        assert!(
            with.contains("<link rel=\"modulepreload\" href=\"nsh-bindgen.0123456789.js\">"),
            "{with}"
        );
        assert!(with.contains("glue: app.glue"), "{with}");
        // Without wasm-bindgen the page names no glue.
        let without = page(&parts(None));
        assert!(!without.contains("modulepreload"), "{without}");
        assert!(!without.contains("bindgen"), "{without}");
    }

    #[test]
    fn urls_escape_what_names_may_hold() {
        assert_eq!(url_path("assets/a b/中.png"), "assets/a%20b/%E4%B8%AD.png");
        assert_eq!(url_path("assets/@nsh-base/x.ttf"), "assets/@nsh-base/x.ttf");
    }

    #[test]
    fn the_page_names_the_files_and_cannot_be_broken_out_of() {
        let app = serde_json::json!({ "code": "app.1.js", "x": "</script><b>" });
        let html = page(&PageParts {
            name: "A <b> & \"c\"",
            appearance: Appearance::System,
            icons: &Icons::default(),
            runtime: "nsh.0123456789.js",
            wasm: "nsh.0123456789.wasm",
            glue: None,
            code: "app.1.js",
            fonts: &["assets/f.1.ttf".to_owned()],
            app: &app,
            connect: Some("'self' api.example.com:*"),
        });
        assert!(html.contains("<title>A &lt;b&gt; &amp; &quot;c&quot;</title>"));
        assert!(html.contains("from \"./nsh.0123456789.js\""));
        let fetches = html
            .lines()
            .find(|line| line.starts_with("<script>const fetches = "))
            .unwrap_or_default();
        for url in ["nsh.0123456789.wasm", "app.1.js", "assets/f.1.ttf"] {
            assert!(fetches.contains(&format!("\"{url}\"")), "{fetches}");
        }
        assert!(html.contains("wasm: take(app.wasm)"));
        assert!(!html.contains("rel=\"preload\""));
        assert!(html.contains("media=\"(prefers-color-scheme: dark)\""));
        assert!(!html.contains("</script><b>"));
        assert!(!html.contains("{{"), "{html}");
        assert!(html.contains(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'self' api.example.com:*\">"
        ));
    }

    #[test]
    fn requests_are_limited_to_the_declared_hosts() {
        let caps =
            |json: serde_json::Value| nsh_core::access::Capabilities::from_json(&json).unwrap();
        assert_eq!(connect_src(None, &[]), None);
        assert_eq!(
            connect_src(Some(&caps(serde_json::json!({ "clipboard": true }))), &[]).as_deref(),
            Some("'self'")
        );
        let declared = caps(serde_json::json!({ "network": {
            "hosts": ["api.example.com", "*.cdn.example.com", "localhost:8080"],
            "http": [{ "host": "api.example.com", "methods": ["GET"] }],
        } }));
        assert_eq!(
            connect_src(Some(&declared), &[]).as_deref(),
            Some(
                "'self' http://api.example.com:* https://api.example.com:* ws://api.example.com:* wss://api.example.com:* http://*.cdn.example.com:* https://*.cdn.example.com:* ws://*.cdn.example.com:* wss://*.cdn.example.com:* http://localhost:8080 https://localhost:8080 ws://localhost:8080 wss://localhost:8080"
            )
        );
        let constrained = caps(serde_json::json!({ "network": {"http": [
            { "host": "secure.example.com", "methods": ["GET"], "schemes": ["https"], "port": 8443 },
            { "host": "upload.example.com", "methods": ["POST"], "schemes": ["https"], "port": 9443 },
            { "host": "legacy.example.com", "methods": ["GET"], "schemes": ["ws"], "port": 9000 }
        ]} }));
        assert_eq!(
            connect_src(Some(&constrained), &[]).as_deref(),
            Some(
                "'self' https://secure.example.com:8443 wss://secure.example.com:8443 https://upload.example.com:9443 ws://legacy.example.com:9000"
            )
        );
        let wildcard = caps(serde_json::json!({ "network": {"http": [
            { "host": "*", "methods": ["GET"], "schemes": ["https"], "port": 443 }
        ]} }));
        assert_eq!(
            connect_src(Some(&wildcard), &[]).as_deref(),
            Some("'self' https://*:443 wss://*:443")
        );
        let ipv6 = caps(serde_json::json!({ "network": {"http": [
            { "host": "::1", "methods": ["GET"], "schemes": ["http"], "port": 9877 },
            { "host": "[::2]", "methods": ["GET"], "schemes": ["https"] }
        ]} }));
        assert_eq!(
            connect_src(Some(&ipv6), &[]).as_deref(),
            Some("'self' http://[::1]:9877 ws://[::1]:9877 https://[::2]:* wss://[::2]:*")
        );
        let any = caps(serde_json::json!({ "network": { "hosts": ["*"] } }));
        assert_eq!(connect_src(Some(&any), &[]), None);
        // The page's host module's hosts (`web.connect`) join the app's; any
        // host there lifts the restriction too; none without a declaration.
        let page = page_connect(&["auth.example.com".into()]).unwrap();
        assert_eq!(
            connect_src(Some(&caps(serde_json::json!({}))), &page).as_deref(),
            Some(
                "'self' http://auth.example.com:* https://auth.example.com:* ws://auth.example.com:* wss://auth.example.com:*"
            )
        );
        assert_eq!(connect_src(None, &page), None);
        let anywhere = page_connect(&["*".into()]).unwrap();
        assert_eq!(
            connect_src(Some(&caps(serde_json::json!({}))), &anywhere),
            None
        );
        // Nothing that could end a CSP source.
        for bad in ["a.com; script-src *", "'unsafe-inline'", "a b", ""] {
            assert!(page_connect(&[bad.into()]).is_err(), "{bad}");
        }
    }

    #[test]
    fn fonts_only_chunks_register_come_with_them() {
        let chunk = |id: &str, code: &str| crate::build::BuiltChunk {
            id: id.to_owned(),
            code: code.to_owned(),
            bytecode: Vec::new(),
            source_map: None,
        };
        let fonts = ["a.ttf", "b.ttf", "@ui/c.ttf"].map(String::from);
        let chunks = [
            chunk(
                "Text.js",
                "font(assetUrl(`b.ttf`, import.meta.assetBase), `B`); font(assetUrl(`a.ttf`, import.meta.assetBase), `A`)",
            ),
            chunk(
                "Other.js",
                "font(assetUrl(`b.ttf`, import.meta.assetBase), `B`)",
            ),
        ];
        let (eager, by_chunk) = font_loads(
            &fonts,
            "font(assetUrl(`a.ttf`, import.meta.assetBase), `A`)",
            &chunks,
        );
        // The entry's, and the UI set's (which no code names), first.
        assert_eq!(eager, ["a.ttf", "@ui/c.ttf"]);
        assert_eq!(
            serde_json::Value::Object(by_chunk),
            serde_json::json!({ "Text.js": ["b.ttf"], "Other.js": ["b.ttf"] })
        );
    }

    #[test]
    fn manifests_follow_the_appearance() {
        let icons = Icons {
            manifest: vec![(192, "icons/192.a.png".to_owned())],
            ..Icons::default()
        };
        let json: serde_json::Value = serde_json::from_str(&manifest(
            "Demo",
            "com.example.demo",
            Appearance::Dark,
            &icons,
        ))
        .unwrap();
        assert_eq!(json["background_color"], "#000000");
        assert_eq!(json["display"], "standalone");
        assert_eq!(json["icons"][0]["sizes"], "192x192");
    }
}
