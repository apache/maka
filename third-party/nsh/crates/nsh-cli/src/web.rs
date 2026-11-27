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
    collections::{BTreeMap, BTreeSet},
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

mod compress;
mod prune;
mod split;

/// The packaged page; `{{…}}` are filled in by [`page`].
const PAGE: &str = include_str!("web/index.html");
/// The page's own styles, a file of the site so a strict `style-src`
/// ('self') applies them; `{{colors}}` is filled in by [`page_style`].
const PAGE_STYLE: &str = include_str!("web/index.css");
/// The page's scripts: files of their own, so a strict `script-src` allows
/// them ('self'), the first one a classic script the page runs as it is
/// parsed.
const PAGE_PREFETCH: &str = include_str!("web/prefetch.js");
const PAGE_START: &str = include_str!("web/start.js");
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
    // Before the runtime is built and the previous package removed.
    let base = page_base(config.web.base.as_deref())?;
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
    // Linked for the app: the parts of `nsh/base`, the standard modules
    // and the app's own UI sets it does not use are left out.
    let linkable =
        fs::read(&runtime.wasm).with_context(|| format!("read {}", runtime.wasm.display()))?;
    // A runtime whose crates call JS through wasm-bindgen: it runs on the
    // main module once it is split ([`link`]).
    let bindgen = crate::bindgen::needs(&linkable)
        .with_context(|| format!("read {}", runtime.wasm.display()))?
        .map(|version| BindgenRun::next_to(&runtime.wasm, version))
        .transpose()?;
    // `--shared-runtime`: the runtime's shared form, the same bytes for
    // every app on this NSH version wherever it is packaged, which the
    // browser downloads once when the apps serve it from one place
    // (`--asset-url`). nsh's own runtime only: an app with Rust components
    // or wasm-bindgen glue has one of its own.
    let shared = options.shared_runtime;
    if shared && (built.rust_root || bindgen.is_some()) {
        bail!(
            "--shared-runtime needs nsh's own runtime: an app with Rust components or wasm-bindgen glue has a runtime of its own"
        );
    }
    let dir = options.out.join(name);
    let step = ui::Step::start(format!("packaging {}", ui::path(&dir)));

    if dir.exists() {
        fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
    }
    let asset_base = options.asset_url.map(asset_url).transpose()?;
    // The files' URLs are absolute under `web.base`: the page is served at
    // every route of the app, with no `<base href>` ([`page`]).
    let site = Site::new(
        &dir,
        asset_base
            .as_ref()
            .map(|base| base.prefix.clone())
            .or_else(|| base.clone()),
    )?;
    let chunk_sides;
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
    // The gates the entry needs are linked into `nsh.wasm`; each other one
    // an app's chunks use is a side module of its own, which the page
    // loads before the first chunk that needs it runs (`chunkSides`), after
    // the side modules of the code it shares with other gates (`sides`).
    // A shared runtime (`--shared-runtime`) links none: every
    // gate is a side module, the same for every app, and the page loads
    // those the entry needs before the app starts (`entrySides`).
    let mut sides = serde_json::Map::new();
    let mut published = BTreeSet::new();
    let entry_sides: Vec<String>;
    // An app with Rust components of its own has a runtime built for it,
    // linkable as nsh's own, with a gate per UI set (`nsh_ui_set_*`).
    let (linked, glue, has_math, has_emoji) = {
        let plan = GatePlan::of(built);
        if let Some(whole) = &plan.whole {
            ui::warn(whole);
        }
        // `EmojiPicker`'s emoji, fetched by the first picker, wherever it is.
        let has_emoji =
            plan.main.iter().any(|g| g == EMOJI_GATE) || plan.lazy().contains(&EMOJI_GATE);
        let exports = prune::exports(&linkable)?;
        let (keep, lazy) = if shared {
            shared_split(&exports)
        } else {
            app_split(built, &plan, &linkable, &exports)?
        };
        let (split, glue) = link(&linkable, &keep, &lazy, bindgen.as_ref())?;
        for side in &split.sides {
            let file = side_file_name(&side.gates);
            let url = site.add(&format!("{file}.wasm"), &side.bytes)?;
            if let Some(gate) = &side.gate {
                published.insert(gate.clone());
            }
            sides.insert(side.name.clone(), side_entry(side, &url));
        }
        chunk_sides = plan.chunk_sides(&published);
        entry_sides = plan.entry_sides(&published, built.rust_root);
        // A runtime published whole has the typesetter in its main module.
        let has_math = published.contains(MATH_GATE)
            || (split.sides.is_empty() && exports.iter().any(|e| e == MATH_GATE));
        (split.main, glue, has_math, has_emoji)
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
    if has_math {
        data.insert(
            "math".into(),
            site.add(MATH_FONTS_FILE, nsh_base::MATH_FONTS)?.into(),
        );
    }
    if has_emoji {
        data.insert(
            "emoji".into(),
            site.add(EMOJI_FILE, nsh_base::EMOJI_DATA.as_bytes())?
                .into(),
        );
    }
    // The wasm-bindgen glue of a runtime whose crates call JS through
    // wasm-bindgen (`crate::bindgen`).
    let glue = glue
        .as_deref()
        .map(|path| publish_glue(&site, path))
        .transpose()?;
    if let Some(run) = &bindgen {
        run.remove_output()?;
    }
    // A Rust app has no code of its own besides its runtime: the page
    // mounts its root. Chunk id -> URL: the page hands the map to the
    // runtime, which fetches lazy chunks on demand. Static entry
    // dependencies are staged before startup.
    let modules = if built.rust_root {
        AppModules::default()
    } else {
        publish_modules(&site, &built.code, &built.chunks, built.native_use.as_ref())?
    };
    let AppModules {
        code,
        chunks,
        linked,
    } = modules;
    let mut assets = serde_json::Map::new();
    let mut fonts = Vec::new();
    for asset in built.assets_for(Some(nsh_core::platform::Os::Web)) {
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
    let icons = match config.icon(crate::package::PackageTarget::Web) {
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
        "sides": sides,
        "chunkSides": chunk_sides,
        "nativeExports": native_exports(built.native_use.as_ref()),
        "entryChunks": built.entry_imports,
        "host": host.map(|host| site.module(&host)),
    });
    if let Some(glue) = &glue {
        app["glue"] = glue.as_str().into();
    }
    app["runtime"] = site.module(&js).into();
    if linked {
        app["linked"] = true.into();
    }
    // Requested with the main module while the page is parsed: the side
    // modules the entry needs and those they import from.
    let entry_side_urls = side_urls(&sides, &entry_sides);
    if !entry_sides.is_empty() {
        app["entrySides"] = entry_sides.into();
    }
    let style = site.add("nsh-page.css", page_style(appearance).as_bytes())?;
    let prefetch = site.add("nsh-prefetch.js", PAGE_PREFETCH.as_bytes())?;
    let start = site.add("nsh-start.js", PAGE_START.as_bytes())?;
    if let Some(history) = config.web.history {
        app["history"] = history.into();
    }
    // The site's base, which the app's relative URLs resolve against
    // (the player's `baseURL`): the page is served at the app's routes.
    if let Some(base) = &base {
        app["base"] = base.as_str().into();
    }
    let html = page(&PageParts {
        name,
        appearance,
        base: base.as_deref(),
        icons: &icons,
        runtime: &site.module(&js),
        wasm: &wasm,
        entry_sides: &entry_side_urls,
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
        // The page fetches its files from another origin there.
        .map(|sources| match &asset_base {
            Some(base) => format!("{sources} {}", base.origin),
            None => sources,
        })
        .as_deref(),
        style: &style,
        prefetch: &prefetch,
        start: &start,
    });
    fs::write(dir.join("index.html"), html)?;
    // What static hosts send browsers that accept it (`.br`, `.gz`).
    compress::precompress(&dir)?;
    step.done(format!(
        "packaged {}{}",
        ui::path(&dir),
        ui::dim(format!(", {}", ui::bytes(dir_size(&dir))))
    ));
    // What a server with a strict policy allows: the page's scripts and
    // styles are files ('self'), and so are a linked app's modules; the
    // runtime shows in-memory images and `svg()`s in their color as `blob:`
    // URLs and reads clipboard images as `data:` URIs.
    let whole = !(linked || built.rust_root);
    ui::detail(format!(
        "under a Content-Security-Policy it needs script-src 'self' 'wasm-unsafe-eval'{}; img-src 'self' blob: data:{}",
        if whole { " blob: 'unsafe-inline'" } else { "" },
        if whole {
            " (script-src: it loads a native module whole)"
        } else {
            ""
        }
    ));
    if options.run {
        serve(&dir, base.as_deref().unwrap_or("/"))?;
    }
    Ok(())
}

/// What a shared runtime (`--shared-runtime`) keeps in its main
/// module and splits off, whatever the app uses: every export but the
/// gates, and every gate, in order. The same for every app on one
/// runtime, so are its modules; the app's own gates are its `entrySides`.
fn shared_split(exports: &[String]) -> (Vec<&str>, Vec<&str>) {
    let (mut lazy, keep): (Vec<&str>, Vec<&str>) = exports
        .iter()
        .map(String::as_str)
        .partition(|name| is_gate(name));
    lazy.sort_unstable();
    (keep, lazy)
}

/// What a runtime linked for `built` (not a shared one) by `plan` keeps in
/// its main module and splits off, of `exports`, those of `linkable`:
/// every export but the gates, and the gates of `plan.main`; each gate a
/// chunk loads later is lazy ([`GatePlan::lazy`]).
///
/// A Rust app's runtime splits off the gates it loads on demand
/// ([`rust_on_demand`]) whatever the plan, and leaves out those the app
/// never needs, with the code only they reach ([`prune::unused_gates`]),
/// rather than publishing side modules no page loads.
fn app_split<'a>(
    built: &Built,
    plan: &GatePlan,
    linkable: &[u8],
    exports: &'a [String],
) -> anyhow::Result<(Vec<&'a str>, Vec<&'a str>)> {
    let rust_part = |name: &str| built.rust_root && rust_on_demand(name);
    let mut keep: Vec<&str> = exports
        .iter()
        .map(String::as_str)
        .filter(|name| !is_gate(name) || (!rust_part(name) && plan.main.iter().any(|g| g == name)))
        .collect();
    let mut lazy: Vec<&str> = plan
        .lazy()
        .into_iter()
        .filter_map(|gate| exports.iter().find(|e| *e == gate).map(String::as_str))
        .collect();
    lazy.extend(exports.iter().map(String::as_str).filter(|n| rust_part(n)));
    if built.rust_root {
        let unused = prune::unused_gates(linkable)?;
        if !unused.is_empty() {
            ui::debug(format!(
                "web runtime: left out the gates the app does not need: {}",
                unused.join(", ")
            ));
            let used = |name: &&str| !unused.iter().any(|u| u == name);
            keep.retain(used);
            lazy.retain(used);
        }
    }
    Ok((keep, lazy))
}

/// The URLs of side modules `names` of the page's `sides`, each after the
/// side modules it imports from (`needs`), each once.
fn side_urls(sides: &serde_json::Map<String, serde_json::Value>, names: &[String]) -> Vec<String> {
    fn visit(
        sides: &serde_json::Map<String, serde_json::Value>,
        name: &str,
        seen: &mut BTreeSet<String>,
        urls: &mut Vec<String>,
    ) {
        if !seen.insert(name.to_owned()) {
            return;
        }
        let Some(side) = sides.get(name) else { return };
        for need in side["needs"].as_array().into_iter().flatten() {
            if let Some(need) = need.as_str() {
                visit(sides, need, seen, urls);
            }
        }
        if let Some(url) = side["url"].as_str() {
            urls.push(url.to_owned());
        }
    }
    let mut seen = BTreeSet::new();
    let mut urls = Vec::new();
    for name in names {
        visit(sides, name, &mut seen, &mut urls);
    }
    urls
}

/// The page's entry for side module `side`, published at `url` (its
/// `sides`): `{ url, gate?, needs, onDemand }`. The gates of the entry and
/// of the chunks it imports statically are in the main module
/// ([`GatePlan::of`]), so a side module only holds code that a chunk
/// imported later (`chunkSides`, the page's `prepareChunk`) or the first
/// formula (`loadData("math")`) needs: every one is `onDemand`, which
/// `prefetchSides` and `preloadSides` leave alone, and is fetched by the
/// load that needs it, after the side modules it `needs`. In a shared
/// runtime the entry's gates are side modules too, which the page loads
/// before the app starts (`entrySides`).
fn side_entry(side: &prune::split::Side, url: &str) -> serde_json::Value {
    let mut entry = serde_json::json!({ "url": url, "needs": side.needs, "onDemand": true });
    if let Some(gate) = &side.gate {
        entry["gate"] = gate.as_str().into();
    }
    entry
}

const TEXT_VIEW_GATE: &str = "nsh_part_text_view";
/// The gate of `TextView`'s formula typesetter; no chunk names it.
const MATH_GATE: &str = "nsh_feature_math";
/// The KaTeX fonts of the typesetter, which the page fetches with its code.
const MATH_FONTS_FILE: &str = "nsh-math.bin";
/// The gate of `EmojiPicker`.
const EMOJI_GATE: &str = "nsh_part_emoji_picker";
/// Whether a Rust app's runtime (`built.rust_root`) publishes gate `name`
/// as a side module the page loads on demand, whatever the plan: the parts
/// of `nsh/base` (`nsh_part_*`), whose components the app makes by name
/// (`ComponentElement::by_name`), so each loads when one first mounts
/// (what the app makes by type is linked where it is used, in the main
/// module); and shaders ([`SHADER_GATE`]), whose translation to GLSL ES
/// (naga) loads when the app first shows one.
fn rust_on_demand(name: &str) -> bool {
    name.starts_with("nsh_part_") || name == SHADER_GATE
}

/// Shaders: the core's compiler of their sources and their translation to
/// GLSL ES (`nsh-platform-web`'s `shader.rs`).
const SHADER_GATE: &str = "nsh_feature_shader";
/// `EmojiPicker`'s emoji, which the page fetches for the first picker.
const EMOJI_FILE: &str = "nsh-emoji.bin";

/// The modules published for an app from its linkable runtime: the main
/// module with `keep` and side modules for `lazy` ([`split::split`]).
///
/// A runtime whose crates call JS through wasm-bindgen (`bindgen`) is split
/// the same way first: wasm-bindgen rewrites the module it reads and keeps
/// its `linking` and `reloc.*` sections, which then no longer describe it.
/// It runs on the main module alone, which keeps what it reads and
/// rewrites, and must still have what the side modules import from it
/// ([`split::check_processed`]). Its glue is returned with the modules.
pub(crate) fn link(
    linkable: &[u8],
    keep: &[&str],
    lazy: &[&str],
    bindgen: Option<&BindgenRun>,
) -> anyhow::Result<(prune::split::Split, Option<PathBuf>)> {
    let mut split = split::split(linkable, keep, lazy, bindgen.is_some())?;
    let Some(run) = bindgen else {
        return Ok((split, None));
    };
    let input = run.out.join(format!("{}-split.wasm", run.name));
    fs::write(&input, &split.main).with_context(|| format!("write {}", input.display()))?;
    let glue = crate::bindgen::process(&input, &run.version, &run.out, &run.name);
    let _ = fs::remove_file(&input);
    let glue = glue?;
    let output = run.out.join(format!("{}.wasm", run.name));
    let processed = fs::read(&output).with_context(|| format!("read {}", output.display()));
    let main = processed.and_then(|processed| {
        split::check_processed(&split.main, &processed)?;
        prune::unlinked(&processed)
    });
    match main {
        Ok(main) => split.main = main,
        Err(error) => {
            let _ = run.remove_output();
            return Err(error);
        }
    }
    Ok((split, Some(glue)))
}

/// Where wasm-bindgen runs on a runtime's main module ([`link`]): the
/// version the runtime records, and the directory and name of its output
/// (`bindgen::process`).
pub(crate) struct BindgenRun {
    version: String,
    out: PathBuf,
    name: String,
}

impl BindgenRun {
    /// Its output next to the runtime `wasm`, named after it:
    /// `<runtime>-main.wasm`, `<runtime>-main-bindgen.js`.
    pub(crate) fn next_to(wasm: &Path, version: String) -> anyhow::Result<Self> {
        let out = wasm.parent().context("the web runtime has no directory")?;
        let stem = wasm
            .file_stem()
            .and_then(|s| s.to_str())
            .context("the web runtime has no name")?;
        Ok(BindgenRun {
            version,
            out: out.to_owned(),
            name: format!("{stem}-main"),
        })
    }

    /// Removes what [`link`] had wasm-bindgen write: the module, the glue
    /// and its snippets, once the package has them.
    pub(crate) fn remove_output(&self) -> anyhow::Result<()> {
        let glue = self.out.join(format!("{}-bindgen.js", self.name));
        let dir = crate::bindgen::output_dir(&glue);
        for file in [self.out.join(format!("{}.wasm", self.name)), glue] {
            if file.exists() {
                fs::remove_file(&file).with_context(|| format!("remove {}", file.display()))?;
            }
        }
        if dir.exists() {
            fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
        }
        Ok(())
    }
}

/// `nsh.json` `web.base`: a path from the host's root, ending in `/` (one
/// is added), in the form browsers send it: segments that are
/// [sent as written](is_sent_as_written). The prefix of the page's URLs, the
/// address `--run` prints and the path [`nsh_dev::SiteServer::start_at`]
/// matches requests against are then one string, which a browser neither
/// encodes (`/应用/` is `/%E5%BA%94%E7%94%A8/`) nor normalizes (`/a/%2e/`
/// is `/a/`); it has no empty segment either (`/a//`), which hosts collapse.
fn page_base(base: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(base) = base else { return Ok(None) };
    let segments = base
        .strip_prefix('/')
        .map(|path| path.strip_suffix('/').unwrap_or(path));
    let valid = base == "/" || segments.is_some_and(|path| path.split('/').all(is_sent_as_written));
    if !valid {
        bail!(
            "nsh.json web.base: {base:?} is not a path from the host's root as browsers send it \
             (ASCII letters, digits, `-`, `.`, `_`, `~` and %XX escapes), as \"/apps/counter/\""
        );
    }
    Ok(Some(if base.ends_with('/') {
        base.to_owned()
    } else {
        format!("{base}/")
    }))
}

/// Whether browsers send a path segment as it is written: not empty, not a
/// dot segment, and only unreserved characters (RFC 3986) and
/// percent-escapes, none of a `.` (the URL parser reads `%2e` as a dot).
fn is_sent_as_written(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => i += 1,
            b'%' => match bytes.get(i + 1..i + 3) {
                Some(hex)
                    if hex.iter().all(u8::is_ascii_hexdigit)
                        && !hex.eq_ignore_ascii_case(b"2e") =>
                {
                    i += 3
                }
                _ => return false,
            },
            _ => return false,
        }
    }
    true
}

/// Whether `name` is the export of a part of `nsh/base`, of a standard
/// module, of a feature (shaders) or of one of the app's own UI sets
/// ([`ui_set_gate`]), which a runtime linked for an app keeps only when it
/// uses them.
fn is_gate(name: &str) -> bool {
    ["nsh_part_", "nsh_std_", "nsh_feature_", UI_SET_GATE]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// What the app imports by name from each native module: the browser host
/// declares these names at start (`nativeExports`), so a chunk importing a
/// name a side module registers later still links. More than the app
/// gets is harmless: a name nothing registers stays `undefined`. The
/// host makes these modules with only these names, so an app that loads a
/// module by a computed specifier (`import(name)`) declares none.
fn native_exports(uses: Option<&nsh_bundler::NativeUse>) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if uses.is_some_and(|u| u.computed_import) {
        return out.into();
    }
    for (module, imported) in uses.map(|u| &u.imports).into_iter().flatten() {
        if let nsh_bundler::Imported::Names(names) = imported
            && !names.is_empty()
        {
            out.insert(module.clone(), names.iter().cloned().collect());
        }
    }
    out.into()
}

/// The app's modules as [`publish_modules`] wrote them.
#[derive(Default)]
struct AppModules {
    /// The entry's URL (empty for a Rust app, which has none).
    code: String,
    /// Each chunk's URL by its id.
    chunks: serde_json::Map<String, serde_json::Value>,
    /// Whether they import one another and the native modules by their
    /// files' URLs (the runtime's `linked`).
    linked: bool,
}

/// Writes the app's modules: its entry `code` (which chunks import as
/// `bundle.js`) and its `chunks`. Linked, their static imports name the
/// files they are published as, the entry and the chunks by relative URLs
/// and each native module by its facade, a file too ([`facade`]): the
/// browser resolves them with no import map, an inline script a strict
/// `script-src` refuses. A module's name carries the digest of everything
/// it imports, directly or not, so a file keeps its name only while what
/// it links to does. Not linked when the app imports a native module
/// whole (a namespace, `import()`), whose names only the runtime knows:
/// the runtime makes the map and the facades as the app starts.
fn publish_modules(
    site: &Site,
    code: &str,
    chunks: &[crate::build::BuiltChunk],
    uses: Option<&nsh_bundler::NativeUse>,
) -> anyhow::Result<AppModules> {
    const ENTRY: &str = "bundle.js";
    // Each native module the app imports by name, by its facade's path.
    let by_name = uses.filter(|uses| {
        !uses.computed_import
            && uses
                .imports
                .values()
                .all(|imported| matches!(imported, nsh_bundler::Imported::Names(_)))
    });
    let facades = match by_name {
        Some(uses) => {
            let mut facades = BTreeMap::new();
            for (specifier, imported) in &uses.imports {
                let nsh_bundler::Imported::Names(names) = imported else {
                    continue;
                };
                let names: Vec<&str> = names.iter().map(String::as_str).collect();
                let slug: String = specifier
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                    .collect();
                let path = site.put(
                    &format!("facades/{slug}.js"),
                    facade(specifier, &names).as_bytes(),
                )?;
                facades.insert(specifier.clone(), path);
            }
            Some(facades)
        }
        None => None,
    };
    let Some(facades) = facades else {
        let mut published = serde_json::Map::new();
        for chunk in chunks {
            let stem = chunk.id.strip_suffix(".js").unwrap_or(&chunk.id);
            let url = site.add(&format!("{stem}.js"), chunk.code.as_bytes())?;
            published.insert(chunk.id.clone(), url.into());
        }
        return Ok(AppModules {
            code: site.add("app.js", code.as_bytes())?,
            chunks: published,
            linked: false,
        });
    };
    // The modules by id, chunks' as they import them (`./Screen.js` is
    // `Screen.js`), and the ids of the modules each imports statically.
    let mut modules: BTreeMap<String, (&str, String)> = BTreeMap::new();
    modules.insert(ENTRY.to_owned(), (code, "app.js".to_owned()));
    for chunk in chunks {
        let id = chunk.id.trim_start_matches("./");
        let stem = id.strip_suffix(".js").unwrap_or(id);
        modules.insert(id.to_owned(), (&chunk.code, format!("{stem}.js")));
    }
    let mut imports: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (id, (code, _)) in &modules {
        let mut found = Vec::new();
        nsh_bundler::rewrite_imports(id, code, |source| {
            if let Some(target) = join_path(id, source).filter(|t| modules.contains_key(t)) {
                found.push(target);
            }
            None
        })
        .map_err(anyhow::Error::msg)?;
        imports.insert(id, found);
    }
    // Every module's name, from the digest of the modules it reaches and
    // the facades.
    let mut names = BTreeMap::new();
    for id in modules.keys() {
        let mut reached = BTreeSet::from([id.as_str()]);
        let mut queue = vec![id.as_str()];
        while let Some(next) = queue.pop() {
            for target in &imports[next] {
                if reached.insert(target) {
                    queue.push(target);
                }
            }
        }
        let mut hasher = Sha256::new();
        for reached in &reached {
            hasher.update(reached.as_bytes());
            hasher.update([0]);
            hasher.update(modules[*reached].0.as_bytes());
            hasher.update([0]);
        }
        for (specifier, path) in &facades {
            hasher.update(specifier.as_bytes());
            hasher.update([0]);
            hasher.update(path.as_bytes());
            hasher.update([0]);
        }
        names.insert(
            id.as_str(),
            with_digest(&modules[id].1, &hex_digest(&hasher.finalize())),
        );
    }
    let mut published = AppModules {
        linked: true,
        ..AppModules::default()
    };
    for (id, (code, _)) in &modules {
        let name = &names[id.as_str()];
        let linked = nsh_bundler::rewrite_imports(id, code, |source| {
            let target = match join_path(id, source) {
                Some(target) if modules.contains_key(&target) => &names[target.as_str()],
                _ => facades.get(source)?,
            };
            Some(url_path(&relative_path(name, target)))
        })
        .map_err(anyhow::Error::msg)?;
        site.write(name, linked.as_bytes())?;
        let url = site.url(name);
        if id == ENTRY {
            published.code = url;
        }
    }
    for chunk in chunks {
        let name = &names[chunk.id.trim_start_matches("./")];
        published
            .chunks
            .insert(chunk.id.clone(), site.url(name).into());
    }
    Ok(published)
}

/// The id of the module `source` names from module `from` (both paths of
/// the site), or `None` for a source that is not a relative path.
fn join_path(from: &str, source: &str) -> Option<String> {
    if !source.starts_with("./") && !source.starts_with("../") {
        return None;
    }
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for segment in source.split('/') {
        match segment {
            "." | "" => {}
            ".." => {
                parts.pop()?;
            }
            segment => parts.push(segment),
        }
    }
    Some(parts.join("/"))
}

/// The relative URL path of file `to` from file `from` (paths of the
/// site), as a module imports it: `./x.js`, `../x.js`.
fn relative_path(from: &str, to: &str) -> String {
    let mut from: Vec<&str> = from.split('/').collect();
    from.pop();
    let to: Vec<&str> = to.split('/').collect();
    let (dirs, file) = to.split_at(to.len() - 1);
    let common = from.iter().zip(dirs).take_while(|(a, b)| a == b).count();
    let mut out = if common == from.len() {
        "./".to_owned()
    } else {
        "../".repeat(from.len() - common)
    };
    for part in dirs[common..].iter().chain(file) {
        out.push_str(part);
        out.push('/');
    }
    out.pop();
    out
}

/// The module that stands for native module `specifier`, exporting `names`
/// as live bindings, read from the realm's namespace when it runs and again
/// when a later gate registers them (`browser/runtime.js`, `facadeURL`).
fn facade(specifier: &str, names: &[&str]) -> String {
    let key = serde_json::Value::from(specifier).to_string();
    let mut out = String::from("const host=globalThis.__nsh_browser_realm.modules;\n");
    let mut updates = String::new();
    for (index, name) in names.iter().enumerate() {
        let name = serde_json::Value::from(*name).to_string();
        let value = format!("host.get({key})[{name}]");
        let _ = writeln!(out, "let e{index}={value};export{{e{index} as {name}}};");
        let _ = write!(updates, "e{index}={value};");
    }
    if !updates.is_empty() {
        let _ = writeln!(
            out,
            "globalThis.__nsh_browser_realm.watch(()=>{{{updates}}});"
        );
    }
    out
}

/// Which gates ([`is_gate`]) a runtime published for an app links into its
/// main module and which each chunk loads as side modules.
#[derive(Debug, Default, PartialEq, Eq)]
struct GatePlan {
    /// Those of the entry and the chunks it imports statically: called
    /// before the app starts.
    main: Vec<String>,
    /// By chunk id, the gates its own code needs that `main` lacks (a
    /// chunk's static imports list theirs: the page prepares them too).
    chunks: BTreeMap<String, Vec<String>>,
    /// Why `main` keeps every gate when the bundler could have told which
    /// ones the app uses ([`whole_because`]), and in which code.
    whole: Option<Whole>,
}

/// What made a runtime linked for an app keep every gate: `why`, found in
/// `code` (the app's entry, or a chunk it imports statically).
#[derive(Debug, PartialEq, Eq)]
struct Whole {
    why: &'static str,
    code: String,
}

impl std::fmt::Display for Whole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the engine keeps every part of nsh/base, zlib and the shader compiler: {} ({}). Import NSH's modules by name to leave out what the app doesn't use",
            self.why, self.code
        )
    }
}

impl GatePlan {
    /// The plan for `built`: by what each chunk uses of the native
    /// modules; everything in the main module when that is not known for
    /// every chunk (a development or Rust app's build).
    fn of(built: &Built) -> Self {
        let per_chunk = built.entry_native_use.as_ref().and_then(|entry| {
            let chunks: Option<Vec<(&str, &nsh_bundler::NativeUse)>> = built
                .chunks
                .iter()
                .map(|c| c.native_use.as_ref().map(|u| (c.id.as_str(), u)))
                .collect();
            Some((entry, chunks?))
        });
        let Some((entry, chunks)) = per_chunk else {
            let whole = built
                .native_use
                .as_ref()
                .and_then(whole_because)
                .map(|why| Whole {
                    why,
                    code: "the app".to_owned(),
                });
            return Self {
                main: linked_gates(built.native_use.as_ref()),
                chunks: BTreeMap::new(),
                whole,
            };
        };
        let mut whole = whole_because(entry).map(|why| Whole {
            why,
            code: "the app's entry".to_owned(),
        });
        let mut first = entry.clone();
        for (id, uses) in &chunks {
            if built.entry_imports.iter().any(|e| e == id) {
                first.merge(uses);
                if whole.is_none() {
                    whole = whole_because(uses).map(|why| Whole {
                        why,
                        code: format!("its chunk {id}"),
                    });
                }
            }
        }
        let main = linked_gates(Some(&first));
        let mut plan = BTreeMap::new();
        for (id, uses) in chunks {
            if built.entry_imports.iter().any(|e| e == id) {
                continue;
            }
            let gates: Vec<String> = linked_gates(Some(uses))
                .into_iter()
                .filter(|g| !main.contains(g))
                .collect();
            if !gates.is_empty() {
                plan.insert(id.to_owned(), gates);
            }
        }
        Self {
            main,
            chunks: plan,
            whole,
        }
    }

    /// Every gate some chunk loads later, each once, sorted.
    fn lazy(&self) -> Vec<&str> {
        let mut set: BTreeSet<&str> = self.chunks.values().flatten().map(String::as_str).collect();
        // `TextView`'s formulas: asked for by the first one, wherever the
        // view is.
        if set.contains(TEXT_VIEW_GATE) || self.main.iter().any(|g| g == TEXT_VIEW_GATE) {
            set.insert(MATH_GATE);
        }
        set.into_iter().collect()
    }

    /// The page's `entrySides`: the gates of `main` that have a side module
    /// of those `published`, which the page loads before the app starts.
    /// None but in a shared runtime, whose main module has no gate, and
    /// none in a Rust app's runtime (`rust_root`): the gates it splits off
    /// ([`rust_on_demand`]) load when the app first makes a component of
    /// their part by name or first shows a shader.
    fn entry_sides(&self, published: &BTreeSet<String>, rust_root: bool) -> Vec<String> {
        self.main
            .iter()
            .filter(|gate| published.contains(*gate) && !(rust_root && rust_on_demand(gate)))
            .cloned()
            .collect()
    }

    /// The page's map, chunk id -> the side modules (named by their gates)
    /// it loads, of those `published`; a gate without a side module (the
    /// main module has it) is left out.
    fn chunk_sides(
        &self,
        published: &BTreeSet<String>,
    ) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();
        for (id, gates) in &self.chunks {
            let list: Vec<serde_json::Value> = gates
                .iter()
                .filter(|gate| published.contains(*gate))
                .map(|gate| gate.as_str().into())
                .collect();
            if !list.is_empty() {
                map.insert(id.clone(), list.into());
            }
        }
        map
    }
}

/// The gates ([`is_gate`]) a runtime linked for an app that uses `uses` of
/// the native modules keeps: `nsh/base`'s core, the part of each other
/// name it imports from `nsh/base` (`nsh/base/plot` is the plot part's),
/// `zlib`'s operations when it imports `zlib`, and shaders when it may
/// make a shader view (`NativeUse::shader`, or an import of one of
/// [`SHADER_EXPORTS`]). What the bundler cannot tell apart (no analysis,
/// `import * as` of a namespace used other than by reading its members by
/// name, an `import()` of a computed specifier) keeps everything,
/// so a runtime never lacks what an app needs.
/// An app's own UI sets (`nsh.json` `"rust"`) keep the gate of each one it
/// imports ([`ui_set_gate`]).
pub(crate) fn linked_gates(uses: Option<&nsh_bundler::NativeUse>) -> Vec<String> {
    linked_gates_of(uses, &app_set_specifiers())
}

/// Why [`linked_gates`] keeps every gate for code that uses `uses`, when
/// the bundler read it: what the code does that it cannot tell apart.
/// `None` when it keeps only what the code uses. [`linked_gates_of`]
/// keeps everything by this, so the warning and the pruning agree.
fn whole_because(uses: &nsh_bundler::NativeUse) -> Option<&'static str> {
    if uses.computed_import {
        return Some("it loads a module whose name is worked out as it runs, `import(name)`");
    }
    match uses.imports.get(nsh_base::SPECIFIER) {
        Some(nsh_bundler::Imported::All) => Some(
            "it takes nsh/base whole, a namespace (`import * as`) used other than by reading its members by name, or `import(\"nsh/base\")`",
        ),
        _ => None,
    }
}

/// The prefix of the gates of an app's own UI sets ([`ui_set_gate`]).
/// Not `nsh_set_`: the runtime's `nsh_set_base_url` and `nsh_set_dark`
/// would read as gates.
const UI_SET_GATE: &str = "nsh_ui_set_";

/// The export of the app's web runtime that registers the UI set imported
/// as `specifier` (`#[native_module("app/charts")]`): `nsh_ui_set_app_charts`,
/// every character but ASCII letters and digits written `_`. The generated
/// runtime exports it (`rust_app.rs`, `nsh_platform_web::ui_set!`).
pub(crate) fn ui_set_gate(specifier: &str) -> String {
    let name: String = specifier
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("{UI_SET_GATE}{name}")
}

/// The specifiers of the app's own UI sets: those the command serves
/// beyond nsh's own.
fn app_set_specifiers() -> Vec<String> {
    let own: Vec<&str> = crate::own_sets()
        .iter()
        .filter_map(|r| r.specifier())
        .collect();
    crate::ui_sets()
        .iter()
        .map(|set| set.specifier.clone())
        .filter(|s| !own.contains(&s.as_str()) && !s.starts_with("nsh/"))
        .collect()
}

/// [`linked_gates`] for an app whose own UI sets are `app_sets`: each one
/// it imports keeps its gate, and keeping everything keeps all of them.
fn linked_gates_of(uses: Option<&nsh_bundler::NativeUse>, app_sets: &[String]) -> Vec<String> {
    let all = || {
        let mut gates: Vec<String> = nsh_base::parts::ALL
            .iter()
            .map(|(name, _)| format!("nsh_part_{name}"))
            .collect();
        gates.push("nsh_std_zlib".into());
        gates.push("nsh_std_crypto".into());
        gates.push("nsh_std_url".into());
        gates.push("nsh_feature_shader".into());
        gates.extend(app_sets.iter().map(|s| ui_set_gate(s)));
        gates
    };
    let Some(uses) = uses else { return all() };
    if whole_because(uses).is_some() {
        return all();
    }
    let mut gates = Vec::new();
    if needs_base_core(uses, app_sets) {
        gates.push("nsh_part_core".to_owned());
    }
    if uses.global_crypto {
        gates.push("nsh_std_crypto".into());
    }
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
            "zlib" | "node:zlib" => add("nsh_std_zlib".into()),
            "crypto" | "node:crypto" => add("nsh_std_crypto".into()),
            // `domainToASCII` and `domainToUnicode`; `URL` is the browser's.
            "url" | "node:url" => add("nsh_std_url".into()),
            // Shaders are `nsh`'s shader elements.
            "nsh" => match imported {
                nsh_bundler::Imported::All => add("nsh_feature_shader".into()),
                nsh_bundler::Imported::Names(names) => {
                    if names.iter().any(|n| SHADER_EXPORTS.contains(&n.as_str())) {
                        add("nsh_feature_shader".into());
                    }
                }
            },
            "nsh/base/plot" => add("nsh_part_plot".into()),
            // Taken whole, it kept everything above ([`whole_because`]).
            nsh_base::SPECIFIER => {
                if let nsh_bundler::Imported::Names(names) = imported {
                    for name in names {
                        if let Some(part) = part_of(name) {
                            add(format!("nsh_part_{part}"));
                        }
                    }
                }
            }
            module if app_sets.iter().any(|s| s == module) => add(ui_set_gate(module)),
            _ => {}
        }
    }
    gates
}

/// Whether an app that uses `uses` needs `nsh/base`'s core part: it
/// imports `nsh/base` or one of its parts, one of its own UI sets (whose
/// Rust components may build on the core's controls), or may give a view
/// a scroll bar theme of its own (the core draws built-in bars). An app
/// that only imports `nsh` gets the platform's scroll indicators either
/// way, and `AlertDialog` and `Toast` are `nsh/base`'s.
fn needs_base_core(uses: &nsh_bundler::NativeUse, app_sets: &[String]) -> bool {
    uses.scrollbar_theme
        || uses.imports.keys().any(|module| {
            module == nsh_base::SPECIFIER
                || module.starts_with(&format!("{}/", nsh_base::SPECIFIER))
                || app_sets.iter().any(|s| s == module)
        })
}

/// `nsh`'s exports whose views a shader draws: an import of one keeps the
/// shader compiler.
const SHADER_EXPORTS: &[&str] = &[
    "Shader",
    "ShaderEffect",
    "ShaderTransition",
    "ScreenEffect",
    "ScreenTransition",
];

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

/// Serves the site `dir` on this machine under `base` (`web.base`), as a
/// CDN would (`nsh_dev::SiteServer`), until stopped; prints its address.
fn serve(dir: &Path, base: &str) -> anyhow::Result<()> {
    let mut server = None;
    for port in (PORT..PORT + 10).chain([0]) {
        if let Ok(s) = nsh_dev::SiteServer::start_at(
            SocketAddr::from(([127, 0, 0, 1], port)),
            dir.into(),
            base,
        ) {
            server = Some(s);
            break;
        }
    }
    let server = server.context("no free port to serve the site on")?;
    let url = format!("http://127.0.0.1:{}{base}", server.local_addr().port());
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

fn minify_browser_host(name: &str, source: &str) -> anyhow::Result<String> {
    let code = nsh_bundler::minify_module(name, source).map_err(anyhow::Error::msg)?;
    // Module-mode compression removes strict directives. The bootstrap is
    // the one classic script: restore its ESM factories' strict semantics
    // after the final minification, before computing its content digest.
    Ok(if name == "bootstrap.js" {
        format!("\"use strict\";\n{code}")
    } else {
        code
    })
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
            minify_browser_host(&name, &code)?
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
    hex_digest(&Sha256::digest(bytes))
}

/// The first [`DIGEST_LEN`] hex digits of `digest`, a SHA-256.
fn hex_digest(digest: &[u8]) -> String {
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
    files.push((MATH_FONTS_FILE.to_owned(), nsh_base::MATH_FONTS.to_vec()));
    files.push((
        EMOJI_FILE.to_owned(),
        nsh_base::EMOJI_DATA.as_bytes().to_vec(),
    ));
    Ok((page, files))
}

/// The dev host's page and files ([`dev_host`]) for the app at `entry`:
/// with its page's host module (`nsh.json` `web.host`) as `nsh-host.js`,
/// read now (a change takes another session), or none, and its
/// `web.history`.
pub(crate) fn with_page_host(
    (page, mut files): (String, Files),
    entry: &Path,
) -> anyhow::Result<(String, Files)> {
    let web = crate::package::read_config(entry)?.web;
    let history = match web.history {
        Some(history) => history.to_string(),
        None => "null".to_owned(),
    };
    let module = web
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
    Ok((
        page.replace("{{host}}", &host)
            .replace("{{history}}", &history),
        files,
    ))
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

/// `--asset-url`: where a site's files are served from.
struct AssetUrl {
    /// What their URLs start with, ending in `/`.
    prefix: String,
    /// Its origin, which the page's `connect-src` allows.
    origin: String,
}

/// Checks `--asset-url` before anything is built ([`asset_url`]).
pub(crate) fn check_asset_url(url: &str) -> anyhow::Result<()> {
    asset_url(url).map(drop)
}

/// Reads `--asset-url`: an http(s) URL (`https://cdn.example.com/app/`)
/// without credentials, a query or a fragment. The path the page is served
/// under is `nsh.json`'s, not this.
fn asset_url(given: &str) -> anyhow::Result<AssetUrl> {
    let wrong = || {
        anyhow::anyhow!(
            "--asset-url is an http(s) URL (https://cdn.example.com/app/), not {given:?}"
        )
    };
    let url = url::Url::parse(given).map_err(|_| wrong())?;
    // An IPv6 host has no form in the CSP's `connect-src` it goes into.
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host(), Some(url::Host::Domain(_) | url::Host::Ipv4(_)))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(wrong());
    }
    let prefix = url.as_str().to_owned();
    let prefix = if prefix.ends_with('/') {
        prefix
    } else {
        format!("{prefix}/")
    };
    Ok(AssetUrl {
        prefix,
        origin: url.origin().ascii_serialization(),
    })
}

/// A directory files are added to under content-addressed names.
struct Site {
    dir: PathBuf,
    /// Where the files are served from, ending in `/`: `--asset-url`, else
    /// nsh.json `web.base` (a path from the host's root), or `None`: next
    /// to the page.
    base: Option<String>,
}

impl Site {
    fn new(dir: &Path, base: Option<String>) -> anyhow::Result<Site> {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        Ok(Site {
            dir: dir.into(),
            base,
        })
    }

    /// Writes `bytes` as `path` with their digest in its name
    /// ([`hashed_name`]); returns the URL the page names it by
    /// ([`Site::url`]).
    fn add(&self, path: &str, bytes: &[u8]) -> anyhow::Result<String> {
        Ok(self.url(&self.put(path, bytes)?))
    }

    /// Writes `bytes` as `path` with their digest in its name
    /// ([`hashed_name`]); returns that name, a path of the site.
    fn put(&self, path: &str, bytes: &[u8]) -> anyhow::Result<String> {
        let name = hashed_name(path, bytes);
        self.write(&name, bytes)?;
        Ok(name)
    }

    /// The URL of the site's file `name`: under `base`, else relative to
    /// the page.
    fn url(&self, name: &str) -> String {
        format!(
            "{}{}",
            self.base.as_deref().unwrap_or_default(),
            url_path(name)
        )
    }

    /// A URL [`Site::add`] gave as a module specifier the page imports: a
    /// relative one starts with `./`.
    fn module(&self, url: &str) -> String {
        match self.base {
            Some(_) => url.to_owned(),
            None => format!("./{url}"),
        }
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
    with_digest(path, &digest(bytes))
}

/// `dir/name.ext` → `dir/name.<hex>.ext` (`name.<hex>` without an
/// extension).
fn with_digest(path: &str, hex: &str) -> String {
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
/// register (`font("asset:/<path>")` in their code, as the bundler writes
/// font imports) come with the chunk that needs them, by chunk id; the
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
        let uri = format!("asset:/{font}");
        let users: Vec<&crate::build::BuiltChunk> =
            chunks.iter().filter(|c| c.code.contains(&uri)).collect();
        if entry.contains(&uri) || users.is_empty() {
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
    matches!(
        ext.as_deref(),
        Some("ttf" | "otf" | "ttc" | "woff" | "woff2")
    )
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

/// `manifest.webmanifest`: what a browser installs the app as. It stays
/// beside the page under `--asset-url` too: its name has no digest, and
/// its `start_url` and `scope` are the page's.
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
    /// nsh.json `web.base` ([`page_base`]), which the page's own URLs
    /// (the manifest's) start with.
    base: Option<&'a str>,
    icons: &'a Icons,
    /// The module specifier of `nsh.js`.
    runtime: &'a str,
    wasm: &'a str,
    /// URLs of the side modules the entry needs (`entrySides`), each after
    /// those it imports from ([`side_urls`]).
    entry_sides: &'a [String],
    /// URL of the wasm-bindgen glue, if the runtime has one.
    glue: Option<&'a str>,
    code: &'a str,
    /// URLs of the fonts fetched before the app starts.
    fonts: &'a [String],
    /// What the page's script reads.
    app: &'a serde_json::Value,
    /// The page's `connect-src` ([`connect_src`]).
    connect: Option<&'a str>,
    /// URL of the page's styles ([`page_style`]).
    style: &'a str,
    /// URLs of the page's scripts ([`PAGE_PREFETCH`], [`PAGE_START`]).
    prefetch: &'a str,
    start: &'a str,
}

/// The app's `index.html`. It holds no inline code or styles and no
/// `<base href>`, which a strict `style-src`, `script-src` and `base-uri`
/// refuse: under `web.base` it names every file by an absolute URL, so it
/// loads at any of the app's paths, and the player takes the base from
/// the app's JSON (`base`).
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
        "<link rel=\"manifest\" href=\"{}manifest.webmanifest\">",
        parts.base.unwrap_or_default()
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
    // The runtime, imported by the page's script once it has run.
    let _ = writeln!(
        head,
        "<link rel=\"modulepreload\" href=\"{}\">",
        parts.runtime
    );
    // Requested while the page is parsed, before the runtime has loaded
    // ([`PAGE_PREFETCH`]).
    let urls: Vec<&str> = [parts.wasm, parts.code]
        .into_iter()
        .filter(|url| !url.is_empty())
        .chain(parts.entry_sides.iter().map(String::as_str))
        .chain(parts.fonts.iter().map(String::as_str))
        .collect();
    let urls = serde_json::json!(urls).to_string().replace("</", "<\\/");
    let _ = writeln!(
        head,
        "<script type=\"application/json\" id=\"nsh-fetch\">{urls}</script>\n<script src=\"{}\"></script>",
        parts.prefetch
    );
    // JSON in a script: `</script>` in a string must not end it.
    let app = parts.app.to_string().replace("</", "<\\/");
    PAGE.replace("{{title}}", &escape_html(parts.name))
        .replace("{{head}}", head.trim_end())
        .replace("{{style}}", parts.style)
        .replace("{{start}}", parts.start)
        .replace("{{app}}", &app)
}

/// The page's styles ([`PAGE_STYLE`]) with its colors until the app draws
/// (and on its error screen).
fn page_style(appearance: Appearance) -> String {
    let (light, dark) = appearance.colors();
    let colors = |background: &str| {
        let text = if background == DARK {
            "#f2f2f7"
        } else {
            "#1c1c1e"
        };
        format!("html, body {{ background: {background}; color: {text}; }}")
    };
    let colors = match appearance {
        Appearance::System => format!(
            "{}\n@media (prefers-color-scheme: dark) {{ {} }}",
            colors(light),
            colors(dark)
        ),
        Appearance::Light | Appearance::Dark => colors(light),
    };
    PAGE_STYLE.replace("{{colors}}", &colors)
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
            _ if compress::is_copy(&entry.path()) => 0,
            _ => entry.metadata().map_or(0, |m| m.len() as usize),
        })
        .sum()
}

/// The file name (without extension) of a side module holding the code of
/// `gates`: what it is for, in kebab case, without the gates' kind
/// (`nsh_part_rich_editor` -> `nsh-rich-editor`); a module several gates
/// share names them with `~` (`nsh-editor~text-view`, unreserved in URLs), the first three and
/// how many more. An app's UI set keeps `app-`, so it never meets NSH's.
fn side_file_name(gates: &[String]) -> String {
    fn short(gate: &str) -> String {
        let name = ["nsh_part_", "nsh_std_", "nsh_feature_"]
            .iter()
            .find_map(|p| gate.strip_prefix(p))
            .map(str::to_owned)
            .or_else(|| gate.strip_prefix("nsh_ui_set_").map(|s| format!("app_{s}")))
            .unwrap_or_else(|| gate.strip_prefix("nsh_").unwrap_or(gate).to_owned());
        name.replace('_', "-")
    }
    let mut parts: Vec<String> = gates.iter().take(3).map(|g| short(g)).collect();
    if gates.len() > 3 {
        parts.push(format!("{}-more", gates.len() - 3));
    }
    format!("nsh-{}", parts.join("~"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rust_app_loads_its_parts_and_shaders_on_demand() {
        assert!(rust_on_demand("nsh_part_rich_editor"));
        // naga's GLSL ES back end, which an app without shaders never loads
        // (#3048).
        assert!(rust_on_demand(SHADER_GATE));
        assert!(is_gate(SHADER_GATE));
        // What the engine runs from the start stays in the main module.
        assert!(!rust_on_demand("nsh_std_zlib"));
        assert!(!rust_on_demand(&ui_set_gate("app/charts")));
    }

    #[test]
    fn a_rust_app_loads_a_part_when_it_first_makes_one_of_its_components() {
        let marker = nsh_core::element::__private::BY_NAME_MARKER;
        let wasm = prune::tests::module_named(
            "nsh_part_plot",
            &format!("nsh_core::element::component::{marker}"),
        );
        let exports = prune::exports(&wasm).unwrap();
        let built = crate::build::rust_root();
        // Not known what a Rust app uses: every gate is the entry's.
        let plan = GatePlan::of(&built);
        assert!(plan.main.iter().any(|g| g == "nsh_part_plot"));
        let (keep, lazy) = app_split(&built, &plan, &wasm, &exports).unwrap();
        assert_eq!(keep, ["a"]);
        assert_eq!(lazy, ["nsh_part_plot"]);
        // Its side modules wait for their first use, not for the start.
        let published = BTreeSet::from(["nsh_part_plot".to_owned(), SHADER_GATE.to_owned()]);
        assert!(plan.entry_sides(&published, true).is_empty());
        // Another app's entry gates with side modules (a shared runtime's)
        // load before it starts.
        assert_eq!(
            plan.entry_sides(&published, false),
            ["nsh_part_plot", SHADER_GATE]
        );
    }

    #[test]
    fn a_rust_app_leaves_out_the_gates_it_never_needs() {
        // No component made by name. The runtime calls no JS through
        // wasm-bindgen, which makes no difference.
        let wasm =
            prune::tests::module_named("nsh_part_plot", "nsh_core::element::component::missing_x");
        let exports = prune::exports(&wasm).unwrap();
        let built = crate::build::rust_root();
        let plan = GatePlan::of(&built);
        let (keep, lazy) = app_split(&built, &plan, &wasm, &exports).unwrap();
        assert_eq!(keep, ["a"]);
        assert!(lazy.is_empty());

        // Another app's runtime keeps the gates its plan has.
        let mut tsx = crate::build::rust_root();
        tsx.rust_root = false;
        let plan = GatePlan::of(&tsx);
        let (keep, lazy) = app_split(&tsx, &plan, &wasm, &exports).unwrap();
        assert_eq!(keep, ["nsh_part_plot", "a"]);
        assert!(lazy.is_empty());
    }

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
    fn the_published_bootstrap_is_a_strict_classic_script() {
        let dir = std::env::temp_dir().join(format!("nsh-web-bootstrap-{}", std::process::id()));
        let root = dir.join("host");
        fs::create_dir_all(root.join("browser")).unwrap();
        // Export a detached-call probe without letting module-mode compression
        // fold away the call that observes strictness in the published script.
        let source = "\"use strict\"; globalThis.bootstrapThis = function () { return this; };";
        fs::write(root.join("browser/bootstrap.js"), source).unwrap();
        let site = Site::new(&dir.join("site"), None).unwrap();
        let published = publish_browser_host(&site, &root).unwrap();
        let code = fs::read_to_string(site.dir.join(published).join("bootstrap.js")).unwrap();
        let host = nsh_js::Host::new().unwrap();
        host.eval_script("bootstrap.js", &code).unwrap();
        assert!(
            host.eval_script("check.js", "(0, bootstrapThis)() === undefined")
                .unwrap()
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_dev_page_runs_the_apps_page_host() {
        let dir = std::env::temp_dir().join(format!("nsh-web-dev-host-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("App.tsx");
        let base = || {
            (
                "const HOST = {{host}}; const HISTORY = {{history}};".to_owned(),
                Files::new(),
            )
        };
        // No nsh.json, or one without `web.host`: no host, and the
        // player's own default for the history.
        let (page, files) = with_page_host(base(), &entry).unwrap();
        assert_eq!(page, "const HOST = null; const HISTORY = null;");
        assert!(files.is_empty());
        fs::write(dir.join("host.js"), "export function createHost() {}").unwrap();
        fs::write(
            dir.join("nsh.json"),
            r#"{ "web": { "host": "host.js", "history": false } }"#,
        )
        .unwrap();
        let (page, files) = with_page_host(base(), &entry).unwrap();
        assert_eq!(
            page,
            "const HOST = \"./nsh-host.js\"; const HISTORY = false;"
        );
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
    fn native_exports_are_the_names_imported_unless_a_specifier_is_computed() {
        let mut app = uses(&[("nsh", Some(&["View"])), ("nsh/base", None)]);
        assert_eq!(
            native_exports(Some(&app)),
            serde_json::json!({ "nsh": ["View"] })
        );
        app.computed_import = true;
        assert_eq!(native_exports(Some(&app)), serde_json::json!({}));
    }

    fn chunk(id: &str, code: &str) -> crate::build::BuiltChunk {
        crate::build::BuiltChunk {
            id: id.into(),
            code: code.into(),
            bytecode: Vec::new(),
            source_map: None,
            native_use: None,
        }
    }

    /// The sources of the static imports of the module at `path`, a file
    /// of `dir`, resolved as the browser resolves them: paths of `dir`.
    fn linked_imports(dir: &Path, path: &str) -> Vec<String> {
        let code = fs::read_to_string(dir.join(path)).unwrap();
        let mut sources = Vec::new();
        nsh_bundler::rewrite_imports(path, &code, |source| {
            sources.push(source.to_owned());
            None
        })
        .unwrap();
        sources
            .iter()
            .map(|source| {
                join_path(path, source).unwrap_or_else(|| panic!("{path}: bare {source}"))
            })
            .collect()
    }

    /// A strict `script-src` runs an app whose native imports are all by
    /// name: its modules import one another and the facades of the native
    /// modules, files too, by their URLs, so the realm needs no import map
    /// (inline) and no `blob:` URL. One importing a module whole leaves
    /// the map to the runtime.
    #[test]
    fn modules_link_to_their_files_when_every_native_import_is_by_name() {
        let dir = std::env::temp_dir().join(format!("nsh-web-imports-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let site = Site::new(&dir, None).unwrap();
        let entry = "import{View as a}from\"nsh\";import{s}from\"./shared.js\";\
                     export const e=1;const L=()=>__nsh_import(`Later.js`,[`shared.js`]);";
        let chunks = |later: &str| {
            vec![
                chunk(
                    "shared.js",
                    "import{e}from\"./bundle.js\";export const s=e;",
                ),
                chunk("Later.js", later),
                chunk(
                    "screens/Deep.js",
                    "import{s}from\"../shared.js\";import{View}from\"nsh\";export{s,View};",
                ),
                chunk("leaf.js", "export const l=1;"),
            ]
        };
        let later = "import{s}from\"./shared.js\";import x from\"nsh\";export default [s,x];";
        let mut app = uses(&[
            ("nsh", Some(&["View", "default"])),
            ("nsh/effects", Some(&[])),
        ]);
        let published = publish_modules(&site, entry, &chunks(later), Some(&app)).unwrap();
        assert!(published.linked);
        let code = published.code.clone();
        assert!(code.starts_with("app.") && code.ends_with(".js"), "{code}");
        let url = |id: &str| published.chunks[id].as_str().unwrap().to_owned();
        // Every module imports files of the site, at the paths they have.
        let files = [
            &code,
            &url("shared.js"),
            &url("Later.js"),
            &url("screens/Deep.js"),
        ];
        for file in files {
            for import in linked_imports(&dir, file) {
                assert!(dir.join(&import).is_file(), "{file}: {import}");
            }
        }
        assert_eq!(
            linked_imports(&dir, &code),
            [
                linked_imports(&dir, &url("Later.js"))[1].clone(),
                url("shared.js")
            ]
        );
        assert_eq!(
            linked_imports(&dir, &url("shared.js")),
            std::slice::from_ref(&code)
        );
        let deep = linked_imports(&dir, &url("screens/Deep.js"));
        assert_eq!(deep[0], url("shared.js"));
        assert!(deep[1].starts_with("facades/nsh."), "{deep:?}");
        let source = fs::read_to_string(dir.join(url("screens/Deep.js"))).unwrap();
        assert!(source.contains("from\"../shared."), "{source}");
        let facade = fs::read_to_string(dir.join(&deep[1])).unwrap();
        assert!(
            facade.contains("let e0=host.get(\"nsh\")[\"View\"];export{e0 as \"View\"};"),
            "{facade}"
        );
        assert!(facade.contains("export{e1 as \"default\"}"), "{facade}");
        assert!(facade.contains(".watch(()=>{e0="), "{facade}");
        // Lazy chunks are still loaded by id.
        let source = fs::read_to_string(dir.join(&code)).unwrap();
        assert!(
            source.contains("__nsh_import(`Later.js`,[`shared.js`])"),
            "{source}"
        );
        // The same app, the same names; a module changed renames only the
        // modules that reach it (`Later.js` is loaded, not imported).
        let again = publish_modules(&site, entry, &chunks(later), Some(&app)).unwrap();
        assert_eq!(
            (&again.code, &again.chunks),
            (&published.code, &published.chunks)
        );
        let changed =
            publish_modules(&site, entry, &chunks("export default 2;"), Some(&app)).unwrap();
        assert_eq!(changed.code, published.code);
        assert_eq!(changed.chunks["shared.js"], published.chunks["shared.js"]);
        assert_ne!(changed.chunks["Later.js"], published.chunks["Later.js"]);
        // Files of another origin (`--asset-url`) are named by their URLs
        // and import one another relatively.
        let cdn = Site::new(&dir, Some("https://cdn.example.com/a/".into())).unwrap();
        let on_cdn = publish_modules(&cdn, entry, &chunks(later), Some(&app)).unwrap();
        assert_eq!(on_cdn.code, format!("https://cdn.example.com/a/{code}"));
        // A module imported whole: the runtime makes the map.
        app.imports
            .insert("nsh/base".into(), nsh_bundler::Imported::All);
        let whole = publish_modules(&site, entry, &chunks(later), Some(&app)).unwrap();
        assert!(!whole.linked);
        assert_eq!(
            fs::read_to_string(dir.join(&whole.code)).unwrap(),
            entry,
            "kept as bundled"
        );
        app.imports.remove("nsh/base");
        app.computed_import = true;
        assert!(
            !publish_modules(&site, entry, &chunks(later), Some(&app))
                .unwrap()
                .linked
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relative_paths_are_what_modules_import() {
        assert_eq!(join_path("a.js", "./b.js").as_deref(), Some("b.js"));
        assert_eq!(join_path("x/a.js", "../b.js").as_deref(), Some("b.js"));
        assert_eq!(join_path("x/a.js", "./y/b.js").as_deref(), Some("x/y/b.js"));
        assert_eq!(join_path("a.js", "../b.js"), None);
        assert_eq!(join_path("a.js", "nsh"), None);
        assert_eq!(relative_path("a.1.js", "b.2.js"), "./b.2.js");
        assert_eq!(relative_path("x/a.1.js", "b.2.js"), "../b.2.js");
        assert_eq!(
            relative_path("a.1.js", "facades/nsh.2.js"),
            "./facades/nsh.2.js"
        );
        assert_eq!(relative_path("x/y/a.js", "x/z/b.js"), "../z/b.js");
        for (from, to) in [
            ("a.js", "x/y/b.js"),
            ("x/y/a.js", "b.js"),
            ("x/a.js", "x/b.js"),
        ] {
            assert_eq!(
                join_path(from, &relative_path(from, to)).as_deref(),
                Some(to)
            );
        }
    }

    /// A namespace read by name (`base.EmojiPicker`, so that shells without
    /// the export still run the app) declares the names read, which the
    /// browser host's facade exports, and links their parts only.
    #[test]
    fn a_namespace_read_by_name_declares_and_links_what_it_reads() {
        let natives = |s: &str| s == "nsh" || s.starts_with("nsh/");
        let mut read = nsh_bundler::NativeUse::default();
        read.add(
            r#"import * as base from "nsh/base"; import { View } from "nsh";
            const EmojiPicker = base.EmojiPicker;
            export const Picker = (p) => (EmojiPicker ? _$c(EmojiPicker, p) : _$c(View, {}));"#,
            natives,
        );
        assert_eq!(
            native_exports(Some(&read)),
            serde_json::json!({ "nsh": ["View"], "nsh/base": ["EmojiPicker"] })
        );
        assert_eq!(whole_because(&read), None);
        assert_eq!(
            linked_gates_of(Some(&read), &[]),
            ["nsh_part_core", EMOJI_GATE]
        );
        // Passed on, it may be read for anything: every export, every gate.
        let mut passed = nsh_bundler::NativeUse::default();
        passed.add(
            r#"import * as base from "nsh/base"; base.EmojiPicker; use(base);"#,
            natives,
        );
        assert_eq!(native_exports(Some(&passed)), serde_json::json!({}));
        assert!(whole_because(&passed).is_some());
        let gates = linked_gates_of(Some(&passed), &[]);
        assert!(gates.contains(&"nsh_part_editor".to_owned()));
        assert!(gates.contains(&"nsh_feature_shader".to_owned()));
    }

    #[test]
    fn an_app_set_gate_is_named_by_its_specifier() {
        assert_eq!(ui_set_gate("app/charts"), "nsh_ui_set_app_charts");
        assert_eq!(ui_set_gate("@acme/ui-kit"), "nsh_ui_set__acme_ui_kit");
        assert!(is_gate(&ui_set_gate("app/charts")));
        // The runtime's own setters are not gates.
        assert!(!is_gate("nsh_set_base_url"));
        assert!(!is_gate("nsh_set_dark"));
    }

    #[test]
    fn a_linked_runtime_keeps_the_app_sets_the_app_imports() {
        let sets = ["app/charts".to_owned(), "app/storage".to_owned()];
        let gates = linked_gates_of(
            Some(&uses(&[
                ("app/charts", Some(&["Chart"])),
                ("nsh", Some(&["View"])),
            ])),
            &sets,
        );
        assert!(gates.contains(&"nsh_ui_set_app_charts".to_owned()));
        assert!(!gates.contains(&"nsh_ui_set_app_storage".to_owned()));
        // Not known: every set.
        let all = linked_gates_of(None, &sets);
        assert!(all.contains(&"nsh_ui_set_app_charts".to_owned()));
        assert!(all.contains(&"nsh_ui_set_app_storage".to_owned()));
        let mut computed = nsh_bundler::NativeUse::default();
        computed.computed_import = true;
        assert!(
            linked_gates_of(Some(&computed), &sets).contains(&"nsh_ui_set_app_storage".to_owned())
        );
    }

    #[test]
    fn a_linked_runtime_keeps_the_parts_and_modules_the_app_uses() {
        let gates = |imports: &[(&str, Option<&[&str]>)]| {
            let mut gates = linked_gates(Some(&uses(imports)));
            gates.sort();
            gates
        };
        let core: &[&str] = &["Button", "Switch", "Tabs", "Tab", "NavStack", "AlertDialog"];
        // Only `nsh`: no core part, no standard modules.
        assert!(gates(&[("nsh", Some(&["mount", "View"]))]).is_empty());
        assert_eq!(
            gates(&[
                ("nsh", Some(&["mount"])),
                ("nsh/base", Some(core)),
                ("buffer", None),
                ("crypto", Some(&["createHash"])),
                ("url", Some(&["domainToASCII"])),
            ]),
            ["nsh_part_core", "nsh_std_crypto", "nsh_std_url"]
        );
        // A scroll bar theme of a view's own is drawn by the core part.
        let mut themed = uses(&[("nsh", Some(&["ScrollView"]))]);
        themed.scrollbar_theme = true;
        assert_eq!(linked_gates(Some(&themed)), ["nsh_part_core"]);
        // The globals of `crypto` need its operations.
        let mut global = uses(&[("nsh", Some(&["View"]))]);
        global.global_crypto = true;
        assert_eq!(linked_gates(Some(&global)), ["nsh_std_crypto"]);
        assert_eq!(
            gates(&[("nsh/base", Some(&["Button", "Editor"]))]),
            ["nsh_part_core", "nsh_part_editor"]
        );
        // Menus, popups, pickers, the command palette and toasts are
        // parts apart from the core.
        assert_eq!(
            gates(&[(
                "nsh/base",
                Some(&["Button", "Select", "Menu", "Tooltip", "Toast", "toast"])
            )]),
            [
                "nsh_part_core",
                "nsh_part_menu",
                "nsh_part_overlays",
                "nsh_part_select",
                "nsh_part_toast"
            ]
        );
        assert_eq!(
            gates(&[("nsh/base", Some(&["Combobox", "Command"]))]),
            ["nsh_part_combobox", "nsh_part_command", "nsh_part_core"]
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
            ["nsh_feature_shader"]
        );
        let every = nsh_base::parts::ALL.len() + 4;
        assert_eq!(gates(&[("nsh/base", None)]).len(), every);
        let mut computed = uses(&[]);
        computed.computed_import = true;
        assert_eq!(linked_gates(Some(&computed)).len(), every);
        assert_eq!(linked_gates(None).len(), every);
    }

    #[test]
    fn a_plan_that_keeps_every_gate_says_why_and_where() {
        let chunk = |id: &str, uses: nsh_bundler::NativeUse| crate::build::BuiltChunk {
            id: id.to_owned(),
            code: String::new(),
            bytecode: Vec::new(),
            source_map: None,
            native_use: Some(uses),
        };
        let mut computed = uses(&[("nsh", Some(&["View"]))]);
        computed.computed_import = true;
        let mut built = crate::build::rust_root();
        built.rust_root = false;
        built.entry_native_use = Some(uses(&[("nsh", Some(&["View"]))]));
        built.entry_imports = vec!["shared.js".into()];
        built.chunks = vec![
            chunk("shared.js", computed.clone()),
            chunk("Later.js", uses(&[("nsh/base", None)])),
        ];
        let whole = GatePlan::of(&built).whole.unwrap();
        assert_eq!(whole.code, "its chunk shared.js");
        assert!(whole.why.contains("import(name)"));
        assert!(whole.to_string().contains("Import NSH's modules by name"));

        // The entry's own reason comes first; a chunk loaded later doesn't
        // make the engine whole (its gates are side modules).
        built.entry_native_use = Some(uses(&[("nsh/base", None)]));
        let whole = GatePlan::of(&built).whole.unwrap();
        assert_eq!(whole.code, "the app's entry");
        assert!(whole.why.contains("nsh/base whole"));
        built.entry_native_use = Some(uses(&[("nsh", Some(&["View"]))]));
        built.chunks[0] = chunk("shared.js", uses(&[]));
        assert_eq!(GatePlan::of(&built).whole, None);

        // Not read at all (a development or Rust app's build): nothing to say.
        built.entry_native_use = None;
        built.native_use = None;
        assert_eq!(GatePlan::of(&built).whole, None);
    }

    #[test]
    fn chunks_load_the_gates_the_entry_lacks_as_side_modules() {
        let chunk = |id: &str, uses: Option<nsh_bundler::NativeUse>| crate::build::BuiltChunk {
            id: id.to_owned(),
            code: String::new(),
            bytecode: Vec::new(),
            source_map: None,
            native_use: uses,
        };
        let mut built = crate::build::rust_root();
        built.rust_root = false;
        built.entry_native_use = Some(uses(&[("nsh/base", Some(&["Button"]))]));
        built.entry_imports = vec!["shared.js".into()];
        built.chunks = vec![
            chunk("shared.js", Some(uses(&[("zlib", Some(&["gzipSync"]))]))),
            chunk(
                "Editor.js",
                Some(uses(&[("nsh/base", Some(&["Editor", "Button"]))])),
            ),
            chunk(
                "Docs.js",
                Some(uses(&[
                    ("nsh/base", Some(&["Editor", "TextView"])),
                    ("zlib", None),
                ])),
            ),
            chunk("Plain.js", Some(uses(&[("nsh", Some(&["View"]))]))),
        ];
        let mut all = uses(&[]);
        for c in &built.chunks {
            all.merge(c.native_use.as_ref().unwrap());
        }
        built.native_use = Some(all);
        let plan = GatePlan::of(&built);
        assert_eq!(plan.main, ["nsh_part_core", "nsh_std_zlib"]);
        assert_eq!(
            plan.chunks,
            BTreeMap::from([
                ("Editor.js".to_owned(), vec!["nsh_part_editor".to_owned()]),
                (
                    "Docs.js".to_owned(),
                    vec![
                        "nsh_part_editor".to_owned(),
                        "nsh_part_text_view".to_owned()
                    ]
                ),
            ])
        );
        assert_eq!(
            plan.lazy(),
            ["nsh_feature_math", "nsh_part_editor", "nsh_part_text_view"]
        );
        // The page's map: only gates with a published side module.
        let published = BTreeSet::from(["nsh_part_editor".to_owned()]);
        assert_eq!(
            serde_json::Value::Object(plan.chunk_sides(&published)),
            serde_json::json!({
                "Docs.js": ["nsh_part_editor"],
                "Editor.js": ["nsh_part_editor"],
            })
        );

        assert_eq!(plan.whole, None);

        // A chunk whose use is unknown: everything is the entry's.
        built.chunks.push(chunk("Unknown.js", None));
        let plan = GatePlan::of(&built);
        assert!(plan.chunks.is_empty());
        assert_eq!(plan.main, linked_gates(built.native_use.as_ref()));
        built.entry_native_use = None;
        assert!(GatePlan::of(&built).chunks.is_empty());
    }

    #[test]
    fn a_shared_runtime_splits_off_every_gate_whatever_the_app_uses() {
        let exports: Vec<String> = [
            "nsh_start",
            "nsh_std_zlib",
            "nsh_part_menu",
            "nsh_pump",
            "nsh_part_core",
            "nsh_feature_shader",
            "nsh_set_dark",
        ]
        .map(String::from)
        .to_vec();
        let (keep, lazy) = shared_split(&exports);
        // `nsh_set_*` reads like a gate but is not one.
        assert_eq!(keep, ["nsh_start", "nsh_pump", "nsh_set_dark"]);
        assert_eq!(
            lazy,
            [
                "nsh_feature_shader",
                "nsh_part_core",
                "nsh_part_menu",
                "nsh_std_zlib"
            ]
        );
    }

    #[test]
    fn the_entry_side_modules_load_after_what_they_import_each_once() {
        let sides = serde_json::json!({
            "nsh_part_core": { "url": "nsh-core.1.wasm", "needs": ["nsh_shared_a"], "gate": "nsh_part_core" },
            "nsh_part_menu": { "url": "nsh-menu.2.wasm", "needs": ["nsh_shared_a", "nsh_shared_b"], "gate": "nsh_part_menu" },
            "nsh_shared_a": { "url": "nsh-core~menu.3.wasm", "needs": [] },
            "nsh_shared_b": { "url": "nsh-menu~overlays.4.wasm", "needs": ["nsh_shared_a"] },
        });
        let sides = sides.as_object().unwrap();
        let names = ["nsh_part_core", "nsh_part_menu", "nsh_part_none"].map(String::from);
        assert_eq!(
            side_urls(sides, &names),
            [
                "nsh-core~menu.3.wasm",
                "nsh-core.1.wasm",
                "nsh-menu~overlays.4.wasm",
                "nsh-menu.2.wasm"
            ]
        );
        assert!(side_urls(sides, &[]).is_empty());
    }

    #[test]
    fn the_page_requests_the_entry_side_modules_with_the_main_module() {
        let app = serde_json::json!({ "code": "app.1.js", "entrySides": ["nsh_part_core"] });
        let html = page(&PageParts {
            name: "Shared",
            appearance: Appearance::System,
            base: None,
            icons: &Icons::default(),
            runtime: "./nsh.0123456789.js",
            wasm: "nsh.0123456789.wasm",
            entry_sides: &[
                "nsh-core~menu.3.wasm".to_owned(),
                "nsh-core.1.wasm".to_owned(),
            ],
            glue: None,
            code: "app.1.js",
            fonts: &[],
            app: &app,
            connect: None,
            style: "nsh-page.1.css",
            prefetch: "nsh-prefetch.1.js",
            start: "nsh-start.1.js",
        });
        let fetches = html
            .lines()
            .find(|line| line.starts_with("<script type=\"application/json\" id=\"nsh-fetch\">"))
            .unwrap_or_default();
        assert!(
            fetches.contains(
                "[\"nsh.0123456789.wasm\",\"app.1.js\",\"nsh-core~menu.3.wasm\",\"nsh-core.1.wasm\"]"
            ),
            "{fetches}"
        );
        // The page's script loads them before the app starts.
        assert!(PAGE_START.contains("player.loadSides(app.entrySides, app.sides)"));
        assert!(PAGE_START.contains("prefetched:"));
    }

    #[test]
    fn side_modules_are_fetched_only_by_the_load_that_needs_them() {
        let side = |name: &str, gate: Option<&str>, needs: &[&str]| prune::split::Side {
            name: name.to_owned(),
            gate: gate.map(str::to_owned),
            gates: vec![gate.unwrap_or("nsh_part_fields").to_owned()],
            needs: needs.iter().map(|n| (*n).to_owned()).collect(),
            bytes: Vec::new(),
        };
        // A gate's module keeps its gate and the modules it needs, which
        // `loadSide` loads first.
        assert_eq!(
            side_entry(
                &side(
                    "nsh_part_fields",
                    Some("nsh_part_fields"),
                    &["nsh_shared_1"]
                ),
                "nsh-fields.0123456789.wasm"
            ),
            serde_json::json!({
                "url": "nsh-fields.0123456789.wasm",
                "gate": "nsh_part_fields",
                "needs": ["nsh_shared_1"],
                "onDemand": true,
            })
        );
        // A shared one is only ever loaded as what a gate's module needs.
        assert_eq!(
            side_entry(
                &side("nsh_shared_1", None, &[]),
                "nsh-shared.0123456789.wasm"
            ),
            serde_json::json!({
                "url": "nsh-shared.0123456789.wasm",
                "needs": [],
                "onDemand": true,
            })
        );
        assert_eq!(
            side_entry(&side("nsh_feature_math", Some(MATH_GATE), &[]), "m.wasm")["onDemand"],
            true
        );
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
        assert!(
            !page
                .replace("{{host}}", "")
                .replace("{{history}}", "")
                .contains("{{"),
            "{page}"
        );
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
        assert_eq!(
            names(&plain_files),
            [
                "nsh.js",
                "nsh.wasm",
                "nsh.version",
                MATH_FONTS_FILE,
                EMOJI_FILE
            ]
        );
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
                "snippets/app-1/inline0.js",
                MATH_FONTS_FILE,
                EMOJI_FILE
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
            let site = Site::new(&dir.join(name), None).unwrap();
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
            base: None,
            icons: &icons,
            runtime: "./nsh.0123456789.js",
            wasm: "nsh.0123456789.wasm",
            entry_sides: &[],
            glue,
            code: "app.1.js",
            fonts: &[],
            app: &app,
            connect: None,
            style: "nsh-page.1.css",
            prefetch: "nsh-prefetch.1.js",
            start: "nsh-start.1.js",
        };
        let with = page(&parts(Some("nsh-bindgen.0123456789.js")));
        assert!(
            with.contains("<link rel=\"modulepreload\" href=\"nsh-bindgen.0123456789.js\">"),
            "{with}"
        );
        assert!(PAGE_START.contains("glue: app.glue"));
        // Without wasm-bindgen the page names no glue.
        let without = page(&parts(None));
        assert!(
            !without.contains("modulepreload\" href=\"nsh-bindgen"),
            "{without}"
        );
        assert!(!without.contains("bindgen"), "{without}");
    }

    #[test]
    fn an_asset_url_is_an_http_url() {
        let read = |url: &str| asset_url(url).map(|a| (a.prefix, a.origin));
        assert_eq!(
            read("https://cdn.example.com/app/").unwrap(),
            (
                "https://cdn.example.com/app/".into(),
                "https://cdn.example.com".into()
            )
        );
        assert_eq!(
            read("http://127.0.0.1:8791").unwrap(),
            (
                "http://127.0.0.1:8791/".into(),
                "http://127.0.0.1:8791".into()
            )
        );
        assert_eq!(
            read("https://cdn.example.com/my app/").unwrap().0,
            "https://cdn.example.com/my%20app/"
        );
        for wrong in [
            "/app/",
            "app/",
            "//cdn.example.com/",
            "ftp://cdn.example.com/",
            "https://user:pw@cdn.example.com/",
            "https://cdn.example.com/?v=1",
            "https://cdn.example.com/#x",
            "http://[::1]:8794/",
        ] {
            assert!(read(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn a_site_under_an_asset_url_names_its_files_there() {
        let dir = std::env::temp_dir().join(format!("nsh-asset-url-{}", std::process::id()));
        let relative = Site::new(&dir.join("relative"), None).unwrap();
        let url = relative.add("app.js", b"x").unwrap();
        assert!(!url.contains('/') && url.starts_with("app."), "{url}");
        assert_eq!(relative.module(&url), format!("./{url}"));
        let based = Site::new(
            &dir.join("based"),
            Some("https://cdn.example.com/app/".into()),
        )
        .unwrap();
        let url = based.add("assets/a b.png", b"x").unwrap();
        assert!(
            url.starts_with("https://cdn.example.com/app/assets/a%20b."),
            "{url}"
        );
        assert_eq!(based.module(&url), url);
        // The file itself is written in the site's directory, as without one.
        assert!(
            based
                .dir
                .join("assets")
                .read_dir()
                .unwrap()
                .next()
                .is_some()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn urls_escape_what_names_may_hold() {
        assert_eq!(url_path("assets/a b/中.png"), "assets/a%20b/%E4%B8%AD.png");
        assert_eq!(url_path("assets/@nsh-base/x.ttf"), "assets/@nsh-base/x.ttf");
    }

    #[test]
    fn the_base_is_a_path_from_the_root() {
        assert_eq!(page_base(None).unwrap(), None);
        assert_eq!(page_base(Some("/")).unwrap().as_deref(), Some("/"));
        assert_eq!(
            page_base(Some("/apps/counter")).unwrap().as_deref(),
            Some("/apps/counter/")
        );
        assert_eq!(
            page_base(Some("/apps/counter/")).unwrap().as_deref(),
            Some("/apps/counter/")
        );
        // What the page, `--run` and the server take is what a browser
        // resolves the base to.
        let host = url::Url::parse("http://127.0.0.1:4173/sports/football").unwrap();
        for base in [
            "/",
            "/apps/counter/",
            "/%E5%BA%94%E7%94%A8/counter/",
            "/v1.2/a-b_c~d/",
            "/apps/a%2fb/",
        ] {
            let page = page_base(Some(base)).unwrap().unwrap();
            assert_eq!(host.join(&page).unwrap().path(), page, "{base}");
        }
        for base in [
            "apps/",
            "//",
            "//cdn.example.com/",
            "/apps//counter/",
            "/apps/counter//",
            "https://example.com/",
            "/a/../b/",
            "/a/./b/",
            "/apps/%2e/counter/",
            "/apps/%2E%2E/counter/",
            "/apps/.%2e/counter/",
            "/应用/counter/",
            "/a%zz/",
            "/a%e/",
            "/a b/",
            "/a?x/",
            "/a#x/",
            "/a\\b/",
            "/a\"><script>/",
        ] {
            assert!(page_base(Some(base)).is_err(), "{base}");
        }
        let html = page(&PageParts {
            name: "A",
            appearance: Appearance::Light,
            base: Some("/apps/counter/"),
            icons: &Icons::default(),
            runtime: "./nsh.0123456789.js",
            wasm: "nsh.0123456789.wasm",
            entry_sides: &[],
            glue: None,
            code: "app.1.js",
            fonts: &[],
            app: &serde_json::json!({}),
            connect: None,
            style: "nsh-page.1.css",
            prefetch: "nsh-prefetch.1.js",
            start: "nsh-start.1.js",
        });
        // No `<base href>` (a strict `base-uri` refuses it): the page's own
        // URLs start with the base.
        assert!(!html.contains("<base"), "{html}");
        assert!(
            html.contains("<link rel=\"manifest\" href=\"/apps/counter/manifest.webmanifest\">")
        );
    }

    #[test]
    fn the_page_names_the_files_and_cannot_be_broken_out_of() {
        let app = serde_json::json!({ "code": "app.1.js", "x": "</script><b>" });
        let html = page(&PageParts {
            name: "A <b> & \"c\"",
            appearance: Appearance::System,
            base: None,
            icons: &Icons::default(),
            runtime: "./nsh.0123456789.js",
            wasm: "nsh.0123456789.wasm",
            entry_sides: &[],
            glue: None,
            code: "app.1.js",
            fonts: &["assets/f.1.ttf".to_owned()],
            app: &app,
            connect: Some("'self' api.example.com:*"),
            style: "nsh-page.1.css",
            prefetch: "nsh-prefetch.1.js",
            start: "nsh-start.1.js",
        });
        assert!(html.contains("<title>A &lt;b&gt; &amp; &quot;c&quot;</title>"));
        assert!(html.contains("<link rel=\"modulepreload\" href=\"./nsh.0123456789.js\">"));
        let fetches = html
            .lines()
            .find(|line| line.starts_with("<script type=\"application/json\" id=\"nsh-fetch\">"))
            .unwrap_or_default();
        for url in ["nsh.0123456789.wasm", "app.1.js", "assets/f.1.ttf"] {
            assert!(fetches.contains(&format!("\"{url}\"")), "{fetches}");
        }
        // No inline code: a strict `script-src` ('self') runs the page.
        for script in html.split("<script").skip(1) {
            let tag = &script[..script.find('>').unwrap()];
            let body = &script[tag.len() + 1..script.find("</script>").unwrap()];
            assert!(
                tag.contains(" src=\"") || tag.contains("type=\"application/json\""),
                "{tag}"
            );
            assert!(!tag.contains(" src=\"") || body.is_empty(), "{tag}");
        }
        assert!(html.contains("<script src=\"nsh-prefetch.1.js\"></script>"));
        assert!(html.contains("<script type=\"module\" src=\"nsh-start.1.js\"></script>"));
        // No inline styles either: a strict `style-src` ('self') styles the
        // page, whose own rules are a file.
        assert!(!html.contains("<style"), "{html}");
        assert!(!html.contains("<base"), "{html}");
        assert!(!html.contains(" style=\""), "{html}");
        assert!(html.contains("<link rel=\"stylesheet\" href=\"nsh-page.1.css\">"));
        assert!(PAGE_START.contains("wasm: take(app.wasm)"));
        assert!(!html.contains("rel=\"preload\""));
        assert!(html.contains("media=\"(prefers-color-scheme: dark)\""));
        assert!(!html.contains("</script><b>"));
        assert!(!html.contains("{{"), "{html}");
        assert!(html.contains(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'self' api.example.com:*\">"
        ));
    }

    #[test]
    fn the_page_styles_follow_the_appearance() {
        let system = page_style(Appearance::System);
        assert!(!system.contains("{{"), "{system}");
        assert!(
            system.contains("@media (prefers-color-scheme: dark)"),
            "{system}"
        );
        assert!(system.contains("#status"), "{system}");
        let light = page_style(Appearance::Light);
        assert!(!light.contains("@media (prefers-color-scheme"), "{light}");
        assert!(light.contains(&format!("background: {}", Appearance::Light.colors().0)));
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
            native_use: None,
        };
        let fonts = ["a.ttf", "b.ttf", "@ui/c.ttf"].map(String::from);
        let chunks = [
            chunk(
                "Text.js",
                "font(`asset:/b.ttf`, `B`); font(`asset:/a.ttf`, `A`)",
            ),
            chunk("Other.js", "font(`asset:/b.ttf`, `B`)"),
        ];
        let (eager, by_chunk) = font_loads(&fonts, "font(`asset:/a.ttf`, `A`)", &chunks);
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

    /// The `Accept` header of a browser loading a page.
    const BROWSER: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    /// The strings after each `prefix` in `text`, up to the quote that
    /// opened them (the prefix's).
    fn quoted_after(text: &str, prefix: &str) -> Vec<String> {
        let quote = prefix
            .chars()
            .find(|c| matches!(c, '"' | '\''))
            .expect("a prefix with a quote");
        text.split(prefix)
            .skip(1)
            .filter_map(|rest| rest.split_once(quote).map(|(s, _)| s.to_owned()))
            .collect()
    }

    /// The relative URLs of the modules a module imports (`from "./x.js"`,
    /// `import("./x.js")`) and of the scripts it loads by its own URL
    /// (`new URL("./realm.js", import.meta.url)`), which the browser
    /// resolves against the module's URL; bare specifiers go through the
    /// import map.
    fn module_imports(js: &str) -> Vec<String> {
        let mut specifiers = Vec::new();
        for prefix in [
            "from \"",
            "from '",
            "import(\"",
            "import('",
            "new URL(\"",
            "new URL('",
        ] {
            specifiers.extend(quoted_after(js, prefix));
        }
        specifiers.retain(|s| {
            (s.starts_with("./") || s.starts_with("../") || s.starts_with('/')) && !s.contains("${")
        });
        specifiers
    }

    /// The URLs a page names for the browser to load: its tags' `href` and
    /// `src` (but `<base>`'s), and in its scripts the modules they import,
    /// the relative URLs they hold (`"./nsh.wasm"`), the files the head
    /// requests (`fetches`) and the packaged app's files (`const app`).
    fn page_references(html: &str) -> Vec<String> {
        let mut urls = Vec::new();
        for tag in html.split('<').skip(1) {
            let tag = &tag[..tag.find('>').unwrap_or(tag.len())];
            if ["link ", "script ", "img "]
                .iter()
                .any(|t| tag.starts_with(t))
            {
                urls.extend(quoted_after(tag, " href=\""));
                urls.extend(quoted_after(tag, " src=\""));
            }
        }
        for script in html.split("<script").skip(1) {
            let tag = &script[..script.find('>').unwrap()];
            let body = &script[tag.len() + 1..script.find("</script>").unwrap()];
            // The files the head requests (`nsh-fetch`) and the packaged
            // app's, read by their keys (`nsh-app`): its chunk ids
            // (`"./chunk.js"`) are not URLs.
            if tag.contains("id=\"nsh-fetch\"") {
                urls.extend(serde_json::from_str::<Vec<String>>(body).unwrap());
                continue;
            }
            let app = tag
                .contains("id=\"nsh-app\"")
                .then(|| serde_json::from_str::<serde_json::Value>(body).unwrap());
            if app.is_none() {
                urls.extend(module_imports(body));
                urls.extend(
                    quoted_after(body, "\"./")
                        .into_iter()
                        .filter(|s| !s.ends_with('/'))
                        .map(|s| format!("./{s}")),
                );
            }
            if let Some(app) = app {
                let strings = |value: &serde_json::Value| value.as_str().map(str::to_owned);
                for key in ["runtime", "wasm", "glue", "code", "host"] {
                    urls.extend(strings(&app[key]).filter(|url| !url.is_empty()));
                }
                for key in ["assets", "data", "chunks"] {
                    urls.extend(
                        app[key]
                            .as_object()
                            .into_iter()
                            .flatten()
                            .filter_map(|(_, url)| strings(url)),
                    );
                }
                urls.extend(
                    app["sides"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .filter_map(|(_, side)| strings(&side["url"])),
                );
            }
        }
        urls
    }

    /// What a browser fetches to start the page at `url`: the page, asked
    /// for as a browser asks for one, every file it names
    /// ([`page_references`]), resolved as the browser resolves them
    /// (against its `<base href>`, else its own URL), and every module
    /// those import, against the module's URL. Each URL with its status.
    fn load_page(url: &str) -> Vec<(String, u16)> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .build()
            .into();
        let get = |url: &url::Url, accept: &str| {
            let mut response = agent
                .get(url.as_str())
                .header("Accept", accept)
                .call()
                .unwrap();
            let body = response
                .body_mut()
                .with_config()
                .limit(64 << 20)
                .read_to_vec()
                .unwrap();
            (
                response.status().as_u16(),
                String::from_utf8_lossy(&body).into_owned(),
            )
        };
        let url = url::Url::parse(url).unwrap();
        let (status, html) = get(&url, BROWSER);
        assert_eq!(status, 200, "{url}");
        assert!(html.starts_with("<!doctype html>"), "{url}: {html}");
        let base = match quoted_after(&html, "<base href=\"").first() {
            Some(href) => url.join(href).unwrap(),
            None => url.clone(),
        };
        let mut queue: std::collections::VecDeque<url::Url> = page_references(&html)
            .iter()
            .map(|reference| base.join(reference).unwrap())
            .collect();
        let mut seen = BTreeSet::new();
        let mut loaded = Vec::new();
        while let Some(url) = queue.pop_front() {
            if !seen.insert(url.to_string()) {
                continue;
            }
            let (status, body) = get(&url, "*/*");
            if status == 200 && url.path().ends_with(".js") {
                queue.extend(module_imports(&body).iter().map(|s| url.join(s).unwrap()));
            }
            loaded.push((url.to_string(), status));
        }
        loaded
    }

    #[test]
    fn the_dev_page_loads_its_files_at_the_apps_paths() {
        let dir = std::env::temp_dir().join(format!("nsh-web-dev-paths-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // The runtime's own modules, with its browser host's, and a glue
        // importing a snippet.
        let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../nsh-platform-web/web");
        let glue = dir.join("nsh-dev-bindgen.js");
        fs::write(
            &glue,
            "import { a } from './snippets/app-1/inline0.js';\nexport { a };",
        )
        .unwrap();
        let snippet = crate::bindgen::output_dir(&glue).join("snippets/app-1/inline0.js");
        fs::create_dir_all(snippet.parent().unwrap()).unwrap();
        fs::write(&snippet, "export const a = 1;").unwrap();
        let runtime = WebRuntime {
            wasm: dir.join("nsh-dev.wasm"),
            js: web.join("nsh.js"),
            glue: Some(glue),
            syntaxes: None,
        };
        fs::write(&runtime.wasm, "wasm").unwrap();
        // The app's page host (`web.host`).
        fs::write(dir.join("host.js"), "export function createHost() {}").unwrap();
        fs::write(dir.join("nsh.json"), r#"{ "web": { "host": "host.js" } }"#).unwrap();
        let (page, files) =
            with_page_host(dev_host(&runtime, false).unwrap(), &dir.join("App.tsx")).unwrap();
        let server =
            nsh_dev::DevServer::start("127.0.0.1:0".parse().unwrap(), "", None, |_| {}).unwrap();
        server.serve_web(page, files);
        let origin = format!("http://{}", server.local_addr());
        for path in [
            "/",
            "/football",
            "/sports/football",
            "/sports/football/?tab=live",
        ] {
            let loaded = load_page(&format!("{origin}{path}"));
            let missing: Vec<_> = loaded.iter().filter(|(_, status)| *status != 200).collect();
            assert!(missing.is_empty(), "{path}: {missing:?}");
            for file in [
                "/nsh.js",
                "/nsh.wasm",
                "/nsh.version",
                "/nsh-bindgen.js",
                "/snippets/app-1/inline0.js",
                "/nsh-host.js",
                "/browser/runtime.js",
                "/browser/bootstrap.js",
                "/browser/realm.js",
            ] {
                let file = format!("{origin}{file}");
                assert!(
                    loaded.iter().any(|(url, _)| *url == file),
                    "{path}: {file} is not among {loaded:?}"
                );
            }
        }
        drop(server);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_packaged_page_loads_its_files_at_the_apps_paths() {
        let dir = std::env::temp_dir().join(format!("nsh-web-site-paths-{}", std::process::id()));
        // A site as `package` writes it: the page and the files it names,
        // the runtime importing its browser host, the app importing a chunk
        // and a native module's facade.
        let files = [
            (
                "nsh.0123456789.js",
                "import(\"./browser.0123456789/runtime.js\");",
            ),
            (
                "browser.0123456789/runtime.js",
                "import { a } from \"./dom.js\";",
            ),
            ("browser.0123456789/dom.js", "export const a = 1;"),
            ("nsh.1111111111.wasm", "wasm"),
            ("nsh-bindgen.2222222222.js", "export {};"),
            (
                "app.3333333333.js",
                "import { View } from \"./facades/nsh.cccccccccc.js\"; import(\"./chunk-a.aaaaaaaaaa.js\");",
            ),
            ("chunk-a.aaaaaaaaaa.js", "export {};"),
            ("facades/nsh.cccccccccc.js", "export const View = 1;"),
            ("host.7777777777.js", "export function createHost() {}"),
            ("assets/fonts/Inter.4444444444.ttf", "ttf"),
            ("assets/img/logo.8888888888.png", "png"),
            ("nsh-syntaxes.9999999999.bin", "syntaxes"),
            ("nsh-side-plot.bbbbbbbbbb.wasm", "wasm"),
            ("icons/32.5555555555.png", "png"),
            ("icons/180.6666666666.png", "png"),
            ("manifest.webmanifest", "{}"),
            ("nsh-page.1.css", ""),
            ("nsh-prefetch.1.js", ""),
            ("nsh-start.1.js", ""),
        ];
        // The page `package` writes for `web.base` (its files under it, as
        // `Site::url` names them), or without one.
        let write = |base: Option<&str>| {
            let _ = fs::remove_dir_all(&dir);
            for (path, content) in files {
                let path = dir.join(path);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, content).unwrap();
            }
            let at = |path: &str| format!("{}{path}", base.unwrap_or_default());
            let runtime = match base {
                Some(_) => at("nsh.0123456789.js"),
                None => "./nsh.0123456789.js".to_owned(),
            };
            let app = serde_json::json!({
                "runtime": runtime,
                "wasm": at("nsh.1111111111.wasm"),
                "glue": at("nsh-bindgen.2222222222.js"),
                "code": at("app.3333333333.js"),
                "host": at("host.7777777777.js"),
                "assets": {
                    "fonts/Inter.ttf": at("assets/fonts/Inter.4444444444.ttf"),
                    "img/logo.png": at("assets/img/logo.8888888888.png"),
                },
                "data": { "syntaxes": at("nsh-syntaxes.9999999999.bin") },
                "fonts": ["fonts/Inter.ttf"],
                "chunkFonts": {},
                "chunks": { "chunk-a.js": at("chunk-a.aaaaaaaaaa.js") },
                "sides": { "plot": { "url": at("nsh-side-plot.bbbbbbbbbb.wasm"), "needs": [] } },
                "linked": true,
            });
            let icons = Icons {
                favicon: Some(at("icons/32.5555555555.png")),
                touch: Some(at("icons/180.6666666666.png")),
                manifest: Vec::new(),
            };
            let page = page(&PageParts {
                name: "Sports",
                appearance: Appearance::System,
                base,
                icons: &icons,
                runtime: &runtime,
                wasm: &at("nsh.1111111111.wasm"),
                entry_sides: &[],
                glue: Some(&at("nsh-bindgen.2222222222.js")),
                code: &at("app.3333333333.js"),
                fonts: &[at("assets/fonts/Inter.4444444444.ttf")],
                app: &app,
                connect: None,
                style: &at("nsh-page.1.css"),
                prefetch: &at("nsh-prefetch.1.js"),
                start: &at("nsh-start.1.js"),
            });
            fs::write(dir.join("index.html"), page).unwrap();
        };
        // What the page at `path` loads: every file of the site, at `base`.
        let loads_the_site = |origin: &str, base: &str, path: &str| {
            let loaded = load_page(&format!("{origin}{path}"));
            let mut expected: Vec<_> = files
                .iter()
                .map(|(file, _)| format!("{origin}{base}{file}"))
                .collect();
            expected.sort();
            let mut urls: Vec<_> = loaded.iter().map(|(url, _)| url.clone()).collect();
            urls.sort();
            assert_eq!(urls, expected, "{path}");
            let missing: Vec<_> = loaded.iter().filter(|(_, status)| *status != 200).collect();
            assert!(missing.is_empty(), "{path}: {missing:?}");
        };
        // `web.base`, at the host's root and under a path, one of them
        // percent-encoded (`/应用/counter/`), as `package` takes it: the
        // page names its files by absolute URLs, with no `<base href>` for
        // a strict `base-uri` to refuse, and loads them at every path.
        for base in ["/", "/apps/counter", "/%E5%BA%94%E7%94%A8/counter/"] {
            let base: &str = &page_base(Some(base)).unwrap().unwrap();
            write(Some(base));
            let server =
                nsh_dev::SiteServer::start_at("127.0.0.1:0".parse().unwrap(), dir.clone(), base)
                    .unwrap();
            let origin = format!("http://{}", server.local_addr());
            for path in [
                "",
                "football",
                "sports/football",
                "sports/football/?tab=live",
            ] {
                loads_the_site(&origin, base, &format!("{base}{path}"));
            }
        }
        // Without one, the page's files are relative to it: it loads where
        // it is and one segment below, and at deeper paths it misses them.
        write(None);
        let server =
            nsh_dev::SiteServer::start("127.0.0.1:0".parse().unwrap(), dir.clone()).unwrap();
        let origin = format!("http://{}", server.local_addr());
        loads_the_site(&origin, "/", "/");
        loads_the_site(&origin, "/", "/football");
        let nested = load_page(&format!("{origin}/sports/football"));
        assert!(
            nested
                .iter()
                .any(|(url, status)| url.ends_with("/sports/nsh.0123456789.js") && *status == 404),
            "{nested:?}"
        );
        drop(server);
        let _ = fs::remove_dir_all(&dir);
    }
}
