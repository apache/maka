//! Bundling an app (rolldown): release bundles and development bundles
//! with hot module replacement.
//! Windows network-share entries use an equivalent ordinary UNC path for rolldown.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

use rolldown::{
    Bundler, BundlerOptions, InputItem, OutputFormat, Platform, RawMinifyOptions, SourceMapType,
    plugin::Pluginable,
};
use rolldown_common::{ChunkFilenamesOutputOption, CodeSplittingMode, Output};

use crate::{compile, compile::strip_ansi, plugin};

/// What to bundle and how.
#[derive(Debug, Clone)]
pub struct BundleOptions {
    /// Entry module (usually `App.tsx`).
    pub entry: PathBuf,
    /// Minify the output (release builds).
    pub minify: bool,
    /// Split what `import()` loads into chunks of their own
    /// ([`Bundle::chunks`]), loaded on demand (published web apps);
    /// otherwise the bundle holds the whole app, dynamically imported
    /// modules included.
    pub split: bool,
    /// The UI sets the hosts serve, described (`nsh_base::registry()`
    /// and an app's own, as `SetDescription`s): their modules stay imports.
    pub ui_sets: Vec<nsh_core::element::description::SetDescription>,
}

/// A failed build, formatted for people.
#[derive(Debug, Clone)]
pub struct BundleError {
    /// With ANSI colors, for terminals.
    pub colored: String,
    /// Plain text, for on-device error screens.
    pub plain: String,
}

impl std::fmt::Display for BundleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.plain)
    }
}

impl std::error::Error for BundleError {}

impl BundleError {
    fn new(diagnostics: Vec<rolldown_error::BuildDiagnostic>) -> Self {
        let render = |color| {
            diagnostics
                .iter()
                .map(|d| d.to_diagnostic().convert_to_string(color))
                .collect::<Vec<_>>()
                .join("\n")
        };
        Self {
            colored: render(true),
            // Plugin messages may carry their own escape codes.
            plain: strip_ansi(&render(false)),
        }
    }

    fn other(err: impl std::fmt::Display) -> Self {
        let message = err.to_string();
        Self {
            colored: message.clone(),
            plain: message,
        }
    }
}

/// A bundled app.
#[derive(Debug, Clone)]
pub struct Bundle {
    /// The bundle (the entry chunk, [`nsh_core::js::ENTRY_CHUNK`]): an ES
    /// module importing the native modules.
    pub code: String,
    /// Source map (JSON) from `code` back to the app sources.
    pub source_map: Option<String>,
    /// Shared and lazy chunks, with [`BundleOptions::split`] (else
    /// none), in a stable order.
    pub chunks: Vec<Chunk>,
    /// Static dependency closure needed before evaluating the entry.
    pub entry_imports: Vec<String>,
    /// Imported resources and the logical paths their `asset:/` URIs name.
    pub assets: Vec<Asset>,
    /// Source and configuration files read by the build, as absolute paths.
    /// Development servers watch these even outside the entry directory.
    pub watch_files: Vec<PathBuf>,
    /// The native modules the app imports (`nsh`, `nsh/mobile`,
    /// `nsh/base`, an app's own UI set), sorted: what a host must
    /// serve to run it.
    pub natives: Vec<String>,
    /// What the app's code uses of them, by export, and whether it may read
    /// the global `crypto`: what a runtime built for it must serve.
    pub native_use: crate::NativeUse,
    /// What the app declares it may reach (`nsh.json` `capabilities`);
    /// `None` without a declaration.
    pub capabilities: Option<nsh_core::access::Capabilities>,
    /// Wall time spent bundling, in milliseconds.
    pub elapsed_ms: f64,
}

/// One imported resource, independently of where its source was installed.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
#[non_exhaustive]
pub struct Asset {
    /// Stable package-relative path used by the compiled `asset:/` URI.
    pub path: String,
    /// The actual file read during the build and watched during development.
    pub source: PathBuf,
}

/// A chunk of a split bundle: shared or lazy modules (with what
/// they share with other such chunks), an ES module of its own.
///
/// Chunks import each other and the entry chunk statically, by relative
/// file name (`import { x } from "./bundle.js"`); a dynamic import becomes
/// `__nsh_import("Screen.js", ["shared.js"])` ([`nsh_core::js::IMPORT_CHUNK`]):
/// the chunk and the chunks it imports statically, which the runtime makes
/// available (fetched on the web) before it imports the first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// Its id: its file name (`Screen.js`), stable from build to build while
    /// the app's modules keep their names. Packagers map ids to files or URLs
    /// (`app.<digest>.js`); the runtime asks for chunks by id.
    pub id: String,
    /// The chunk: an ES module.
    pub code: String,
    /// Source map (JSON) from `code` back to the app sources.
    pub source_map: Option<String>,
    /// The chunks it imports statically (ids, the entry chunk left out).
    pub imports: Vec<String>,
}

/// The `"capabilities"` of the `nsh.json` next to the entry, checked.
pub fn capabilities(
    dir: &std::path::Path,
) -> Result<Option<nsh_core::access::Capabilities>, BundleError> {
    let Ok(text) = std::fs::read_to_string(dir.join("nsh.json")) else {
        return Ok(None);
    };
    let config: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| BundleError::other(format!("nsh.json: {e}")))?;
    config
        .get("capabilities")
        .map(|c| {
            nsh_core::access::Capabilities::from_json(c)
                .map_err(|e| BundleError::other(format!("nsh.json: {e}")))
        })
        .transpose()
}

/// How bare imports resolve: the `"resolve"` of the `nsh.json` next to the
/// entry, checked.
#[derive(Debug, Default)]
struct ResolveSetup {
    /// The export conditions of npm packages (`None`: `browser`).
    conditions: Option<Vec<String>>,
    /// Specifiers replaced: by a path or another specifier (`None`: an
    /// empty module).
    alias: Vec<(String, Vec<Option<String>>)>,
}

impl ResolveSetup {
    fn read(dir: &std::path::Path) -> Result<Self, BundleError> {
        let Ok(text) = std::fs::read_to_string(dir.join("nsh.json")) else {
            return Ok(Self::default());
        };
        let config: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| BundleError::other(format!("nsh.json: {e}")))?;
        let Some(resolve) = config.get("resolve") else {
            return Ok(Self::default());
        };
        let error = |m: &str| BundleError::other(format!("nsh.json: resolve: {m}"));
        let resolve = resolve
            .as_object()
            .ok_or_else(|| error("expected an object"))?;
        let mut setup = Self::default();
        for (key, value) in resolve {
            match key.as_str() {
                "conditions" => {
                    let list = value
                        .as_array()
                        .and_then(|a| a.iter().map(|c| c.as_str().map(str::to_owned)).collect())
                        .ok_or_else(|| error("conditions: expected an array of strings"))?;
                    setup.conditions = Some(list);
                }
                "alias" => {
                    let map = value
                        .as_object()
                        .ok_or_else(|| error("alias: expected an object"))?;
                    for (from, to) in map {
                        let to = match to {
                            serde_json::Value::Bool(false) => None,
                            // Paths are relative to `nsh.json`.
                            serde_json::Value::String(to)
                                if to.starts_with("./") || to.starts_with("../") =>
                            {
                                Some(dir.join(to).to_string_lossy().into_owned())
                            }
                            serde_json::Value::String(to) => Some(to.clone()),
                            _ => {
                                return Err(error(&format!(
                                    "alias: `{from}`: expected a path, a module or false"
                                )));
                            }
                        };
                        setup.alias.push((from.clone(), vec![to]));
                    }
                }
                other => return Err(error(&format!("unknown key `{other}`"))),
            }
        }
        Ok(setup)
    }

    /// Sets `options`' platform and resolution (`production`: the value of
    /// `process.env.NODE_ENV`, as rolldown sets it for the browser).
    fn apply(&self, options: &mut BundlerOptions, production: bool) {
        // npm packages resolve their browser builds by default: the runtime
        // has the web APIs (fetch, streams, ...), not Node's.
        let browser = self
            .conditions
            .as_ref()
            .is_none_or(|c| c.iter().any(|c| c == "browser"));
        options.platform = Some(if browser {
            Platform::Browser
        } else {
            Platform::Neutral
        });
        let mut resolve = rolldown_common::ResolveOptions::default();
        if let Some(conditions) = &self.conditions {
            // `module` as rolldown's default conditions have it.
            let mut names = conditions.clone();
            names.push("module".into());
            resolve.condition_names = Some(names);
        }
        if !browser {
            // What the browser platform has besides its condition and the
            // `browser` field.
            resolve.main_fields = Some(vec!["module".into(), "main".into()]);
            let env = if production {
                "'production'"
            } else {
                "'development'"
            };
            options.define = Some(
                [("process.env.NODE_ENV".to_owned(), env.to_owned())]
                    .into_iter()
                    .collect(),
            );
            options.optimization = Some(rolldown_common::OptimizationOption {
                pife_for_module_wrappers: Some(true),
                ..Default::default()
            });
        }
        if !self.alias.is_empty() {
            resolve.alias = Some(self.alias.clone());
        }
        options.resolve = Some(resolve);
        // tsconfig.json is the type checker's: its `paths` lead to `.nsh/types`'
        // declarations and it extends `.nsh/tsconfig.json`, which may not be
        // written yet. Aliases come from nsh.json, the JSX transform is nsh's.
        options.tsconfig = Some(rolldown_common::TsConfig::Auto(false));
    }
}

/// The design tokens of the app in `dir`: its `nsh.json` `"theme"` over
/// the default's (`nsh_base::Theme`), or the default's when it has none.
pub fn theme_tokens(dir: &std::path::Path) -> Result<nsh_core::element::Tokens, BundleError> {
    let Ok(text) = std::fs::read_to_string(dir.join("nsh.json")) else {
        return Ok(nsh_base::Theme::default().into_tokens());
    };
    let config: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| BundleError::other(format!("nsh.json: {e}")))?;
    match theme_json(dir, &config)? {
        Some(json) => Ok(nsh_base::Theme::from_json(&json)
            .map_err(|e| BundleError::other(format!("nsh.json: theme: {e}")))?
            .into_tokens()),
        None => Ok(nsh_base::Theme::default().into_tokens()),
    }
}

/// `nsh.json`'s `"theme"`: shadcn's `cssVars` in a file (a path relative
/// to `nsh.json`) or in place.
fn theme_json(
    dir: &std::path::Path,
    config: &serde_json::Value,
) -> Result<Option<String>, BundleError> {
    Ok(match config.get("theme") {
        None => None,
        Some(serde_json::Value::String(file)) => Some(
            std::fs::read_to_string(dir.join(file))
                .map_err(|e| BundleError::other(format!("nsh.json: theme: {file}: {e}")))?,
        ),
        Some(v) => Some(v.to_string()),
    })
}

/// The `"tailwind"`, `"theme"`, `"appearance"` and `"statusBar"` of the
/// `nsh.json` next to the entry, checked. `"theme"` is shadcn's `cssVars`
/// ([`theme_json`]).
fn tailwind_setup(dir: &std::path::Path) -> Result<Arc<plugin::ThemeSetup>, BundleError> {
    let mut setup = plugin::ThemeSetup::default();
    // The theme's tokens are classes (`bg-primary`): the default's unless
    // the app sets its own.
    let mut tokens = nsh_base::Theme::default().into_tokens();
    let path = dir.join("nsh.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        setup.theme.set_tokens(&tokens);
        return Ok(Arc::new(setup));
    };
    let config: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| BundleError::other(format!("nsh.json: {e}")))?;
    if let Some(tailwind) = config.get("tailwind") {
        let json = tailwind.to_string();
        setup.theme = nsh_core::tailwind::Theme::from_json(&json)
            .map_err(|e| BundleError::other(format!("nsh.json: tailwind: {e}")))?;
        setup.json = Some(json);
    }
    if let Some(json) = theme_json(dir, &config)? {
        tokens = nsh_base::Theme::from_json(&json)
            .map_err(|e| BundleError::other(format!("nsh.json: theme: {e}")))?
            .into_tokens();
        setup.ui = Some(json);
    }
    setup.theme.set_tokens(&tokens);
    if let Some(appearance) = config.get("appearance") {
        setup.appearance = match appearance.as_str() {
            Some("light") => Some("light"),
            Some("dark") => Some("dark"),
            Some("system") => None,
            _ => {
                return Err(BundleError::other(
                    "nsh.json: appearance: expected \"light\", \"dark\" or \"system\"",
                ));
            }
        };
    }
    if let Some(status_bar) = config.get("statusBar") {
        nsh_core::StatusBarSetting::from_json(status_bar)
            .map_err(|e| BundleError::other(format!("nsh.json: statusBar: {e}")))?;
        setup.status_bar = Some(status_bar.to_string());
    }
    Ok(Arc::new(setup))
}

/// Bundles an app, blocking the current thread.
pub fn bundle(options: &BundleOptions) -> Result<Bundle, BundleError> {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .map_err(BundleError::other)?
        .block_on(bundle_async(options))
}

fn canonical_bundler_entry(path: &std::path::Path) -> std::io::Result<PathBuf> {
    let entry = dunce::canonicalize(path)?;
    #[cfg(windows)]
    if let Some(candidate) = ordinary_unc_candidate(&entry)
        && std::fs::canonicalize(&candidate).is_ok_and(|actual| actual == entry)
    {
        // Rolldown cannot resolve the verbatim UNC spelling as an entry ID.
        // Only change its representation after proving the same native file.
        return Ok(candidate);
    }
    Ok(entry)
}

#[cfg(windows)]
fn ordinary_unc_candidate(path: &std::path::Path) -> Option<PathBuf> {
    use std::{
        ffi::OsString,
        path::{Component, Prefix},
    };

    let mut components = path.components();
    let Component::Prefix(prefix) = components.next()? else {
        return None;
    };
    let Prefix::VerbatimUNC(server, share) = prefix.kind() else {
        return None;
    };
    let mut root = OsString::from(r"\\");
    root.push(server);
    root.push(r"\");
    root.push(share);
    let mut candidate = PathBuf::from(root);
    for component in components {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => candidate.push(name),
            _ => return None,
        }
    }
    Some(candidate)
}

/// Bundles an app.
pub async fn bundle_async(options: &BundleOptions) -> Result<Bundle, BundleError> {
    let start = Instant::now();
    let entry = canonical_bundler_entry(&options.entry).map_err(|e| {
        BundleError::other(format!("entry not found: {}: {e}", options.entry.display()))
    })?;
    let cwd = entry
        .parent()
        .ok_or_else(|| BundleError::other("entry has no parent directory"))?
        .to_path_buf();
    let cwd_for_errors = cwd.clone();
    let cwd_root = cwd.clone();
    let tailwind = tailwind_setup(&cwd)?;
    let capabilities = capabilities(&cwd)?;
    let resolve = ResolveSetup::read(&cwd)?;
    let plugin_error = Arc::new(Mutex::new(None));
    let assets = Arc::new(Mutex::new(Vec::new()));
    let natives = Arc::new(Mutex::new(std::collections::BTreeSet::new()));
    let mut bundler_options = BundlerOptions {
        input: Some(vec![InputItem {
            import: entry.to_string_lossy().into_owned(),
            ..Default::default()
        }]),
        cwd: Some(cwd),
        // Nothing is written; this only makes source map paths relative
        // to the entry directory (`App.tsx`, not `../App.tsx`).
        dir: Some(".".into()),
        // Imports of the native modules stay.
        format: Some(OutputFormat::Esm),
        minify: Some(RawMinifyOptions::Bool(options.minify)),
        // Kept out of the code; used to symbolicate stack traces.
        sourcemap: Some(SourceMapType::Hidden),
        // Split: the entry is the module every chunk imports as
        // `./bundle.js`, chunks keep their names (packagers add
        // digests). Else dynamic imports are inlined.
        entry_filenames: options
            .split
            .then(|| ChunkFilenamesOutputOption::String(nsh_core::js::ENTRY_CHUNK.into())),
        chunk_filenames: options
            .split
            .then(|| ChunkFilenamesOutputOption::String("[name].js".into())),
        code_splitting: (!options.split).then_some(CodeSplittingMode::Bool(false)),
        ..Default::default()
    };
    resolve.apply(&mut bundler_options, options.minify);
    let mut bundler = Bundler::with_plugins(
        bundler_options,
        vec![Pluginable::new_shared(plugin::NshPlugin {
            split: options.split,
            root: cwd_for_errors,
            error: plugin_error.clone(),
            assets: assets.clone(),
            hot: false,
            tailwind,
            entry: entry.clone(),
            natives: natives.clone(),
            preloads: None,
            modules: Arc::new(compile::NativeModules::new(&options.ui_sets)),
        })],
    )
    .map_err(|e| BundleError::new(e.into_vec()))?;
    let output = bundler.generate().await.map_err(|e| {
        // Prefer our own compile error (clean code frame) over rolldown's
        // wrapped report of it.
        match plugin_error.lock().expect("error lock").take() {
            Some(message) => BundleError::other(message),
            None => BundleError::new(e.into_vec()),
        }
    })?;
    let mut entry_chunk = None;
    let mut chunks = Vec::new();
    for asset in output.assets {
        let Output::Chunk(chunk) = asset else {
            continue;
        };
        let map = chunk.map.as_ref().map(|m| m.to_json_string());
        if chunk.is_entry {
            entry_chunk = Some((
                chunk.code.clone(),
                map,
                chunk_imports(chunk.imports.iter().map(|i| i.as_str()), &chunk.filename),
            ));
        } else {
            chunks.push(Chunk {
                id: chunk.filename.to_string(),
                code: chunk.code.clone(),
                source_map: map,
                imports: chunk_imports(chunk.imports.iter().map(|i| i.as_str()), &chunk.filename),
            });
        }
    }
    let (code, source_map, imports) =
        entry_chunk.ok_or_else(|| BundleError::other("bundle produced no entry chunk"))?;
    chunks.sort_by(|a, b| a.id.cmp(&b.id));
    let entry_imports = entry_dependencies(imports, &chunks);
    let (assets, watch_files) = imported_assets(&assets, &bundler, &cwd_root);
    let natives = std::mem::take(&mut *natives.lock().expect("natives lock"));
    let codes = || std::iter::once(code.as_str()).chain(chunks.iter().map(|c| c.code.as_str()));
    if let Some(warning) = ungranted_host(codes(), capabilities.as_ref()) {
        log::warn!(target: "nsh::build", "{warning}");
    }
    let mut native_use = crate::NativeUse::default();
    for code in codes() {
        native_use.add(code, |specifier| natives.contains(specifier));
    }
    Ok(Bundle {
        code,
        source_map,
        chunks,
        entry_imports,
        assets,
        watch_files,
        natives: natives.into_iter().collect(),
        native_use,
        capabilities,
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

/// The bundler's imported files and the theme read by NSH's setup.
/// Follow static edges only; lazy entry points remain on demand.
fn entry_dependencies(mut pending: Vec<String>, chunks: &[Chunk]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    while let Some(id) = pending.pop() {
        let Some(chunk) = chunks.iter().find(|chunk| chunk.id == id) else {
            continue;
        };
        if seen.insert(id) {
            pending.extend(chunk.imports.iter().cloned());
        }
    }
    seen.into_iter().collect()
}

fn watch_files(bundler: &rolldown::Bundler, dir: &std::path::Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = bundler
        .watch_files()
        .iter()
        .map(|path| PathBuf::from(path.key().as_str()))
        .filter(|path| path.is_file())
        .collect();
    if let Ok(config) = std::fs::read_to_string(dir.join("nsh.json"))
        && let Ok(config) = serde_json::from_str::<serde_json::Value>(&config)
        && let Some(theme) = config.get("theme").and_then(|v| v.as_str())
        && let Ok(path) = dunce::canonicalize(dir.join(theme))
    {
        files.push(path);
    }
    files.sort();
    files.dedup();
    files
}

fn imported_assets(
    assets: &Mutex<Vec<Asset>>,
    bundler: &rolldown::Bundler,
    dir: &std::path::Path,
) -> (Vec<Asset>, Vec<PathBuf>) {
    let mut assets = std::mem::take(&mut *assets.lock().expect("assets lock"));
    let mut files = watch_files(bundler, dir);
    files.extend(assets.iter().map(|asset| asset.source.clone()));
    files.sort();
    files.dedup();
    assets.sort();
    assets.dedup_by(|a, b| a.path == b.path);
    (assets, files)
}

/// The warning for an app that imports `host` from `nsh` (in the bundle's
/// `codes`, where native imports stay imports) and grants itself none of
/// the host's functions (`capabilities.host`): each of its calls is
/// refused, as the host's functions are never granted by default.
fn ungranted_host<'a>(
    codes: impl IntoIterator<Item = &'a str>,
    capabilities: Option<&nsh_core::access::Capabilities>,
) -> Option<String> {
    let imports = codes.into_iter().any(imports_host);
    let granted = capabilities.is_some_and(|c| !c.host.is_empty());
    (imports && !granted).then(|| {
        "the app imports `host` from nsh and nsh.json declares no `capabilities.host`: every `host.call` is refused \
         (list the host's functions it calls, prefixes ending in `*`, or `true`)"
            .to_owned()
    })
}

/// Whether `code` imports `host` from `nsh` (`import { host } from "nsh"`,
/// renamed or not).
fn imports_host(code: &str) -> bool {
    code.match_indices("from \"nsh\"").any(|(at, _)| {
        let head = &code[..at];
        let Some(open) = head.rfind('{') else {
            return false;
        };
        head[open + 1..]
            .trim_end()
            .strip_suffix('}')
            .is_some_and(|names| {
                names
                    .split(',')
                    .any(|n| n.split_whitespace().next() == Some("host"))
            })
    })
}

/// The chunks of `imports` (the files a chunk imports statically; native
/// modules are not files), the entry chunk left out.
pub(crate) fn chunk_imports<'a>(imports: impl Iterator<Item = &'a str>, own: &str) -> Vec<String> {
    imports
        .filter(|i| i.ends_with(".js") && *i != nsh_core::js::ENTRY_CHUNK && *i != own)
        .map(str::to_owned)
        .collect()
}

/// A development bundle with hot module replacement: the app's modules,
/// each kept separate so an update can replace just the ones that changed.
#[derive(Debug, Clone)]
pub struct HotBundle {
    modules: Vec<HotModule>,
    /// Module id of the entry.
    entry: String,
    /// All native modules the app imports, for host UI-set validation.
    natives: Vec<String>,
    /// Native namespaces the factories require statically.
    preloads: Vec<String>,
    /// Asset files the app imports (as in [`Bundle::assets`]).
    pub assets: Vec<Asset>,
    /// Source and configuration files read by the build, as absolute paths.
    pub watch_files: Vec<PathBuf>,
    /// As in [`Bundle::capabilities`].
    pub capabilities: Option<nsh_core::access::Capabilities>,
    /// Wall time spent bundling, in milliseconds.
    pub elapsed_ms: f64,
}

#[derive(Debug, Clone)]
struct HotModule {
    /// Chunk file name, e.g. `App.js` (what `require` resolves to).
    id: String,
    code: String,
    map: Option<rolldown_sourcemap::SourceMap>,
    /// Rolldown's runtime helpers: never replaced in place.
    embedded: bool,
}

/// What a rebuild means for a running development bundle.
#[derive(Debug, Clone)]
pub enum HotPatch {
    /// No module changed.
    Unchanged,
    /// A script that replaces the changed modules in place; it evaluates to
    /// `false` when the update cannot be applied (the host reloads).
    Update {
        /// The script.
        code: String,
        /// Its source map (JSON).
        source_map: Option<String>,
    },
    /// The change needs a full reload.
    Reload,
}

impl HotBundle {
    /// As in [`Bundle::natives`].
    pub fn natives(&self) -> &[String] {
        &self.natives
    }

    /// The whole app as one script, an ES module: the native hot runtime
    /// and the app's static native imports, every module defined, and the
    /// start of the entry.
    pub fn script(&self) -> (String, Option<String>) {
        let mut joiner = rolldown_sourcemap::SourceJoiner::default();
        joiner.enable_sourcemap = true;
        let mut imports = String::from("import \"nsh:hot\";");
        let mut map = String::new();
        for (i, spec) in self.preloads.iter().enumerate() {
            imports.push_str(&format!("import * as __nsh_n{i} from {spec:?};"));
            // CommonJS interop must select the real ESM default object, including its getters.
            map.push_str(&format!("{spec:?}: {{...__nsh_n{i}, __esModule: true}},"));
        }
        joiner.append_source(imports);
        let start = format!("{HOT}.start({:?}, {{{map}}});", self.entry);
        for m in &self.modules {
            let open = format!(
                "{HOT}.define({:?}, function (module, exports, require) {{",
                m.id
            );
            let close = if m.embedded { "}, true);" } else { "});" };
            append_module(&mut joiner, m, &open, close);
        }
        joiner.append_source(start);
        let (code, map) = joiner.join();
        (code, map.map(|m| m.to_json_string()))
    }

    /// The update from `previous` (what hosts run) to this bundle.
    pub fn patch(&self, previous: &HotBundle) -> HotPatch {
        if self.entry != previous.entry {
            return HotPatch::Reload;
        }
        // A native module the running script did not import.
        if !self.natives.iter().all(|s| previous.natives.contains(s))
            || !self.preloads.iter().all(|s| previous.preloads.contains(s))
        {
            return HotPatch::Reload;
        }
        let old: std::collections::HashMap<&str, &HotModule> = previous
            .modules
            .iter()
            .map(|m| (m.id.as_str(), m))
            .collect();
        let changed: Vec<&HotModule> = self
            .modules
            .iter()
            .filter(|m| old.get(m.id.as_str()).is_none_or(|o| o.code != m.code))
            .collect();
        if changed.is_empty() {
            return HotPatch::Unchanged;
        }
        if changed.iter().any(|m| m.embedded) {
            return HotPatch::Reload;
        }
        let mut joiner = rolldown_sourcemap::SourceJoiner::default();
        joiner.enable_sourcemap = true;
        joiner.append_source(format!("{HOT}.update({{"));
        for m in changed {
            append_module(
                &mut joiner,
                m,
                &format!("{:?}: function (module, exports, require) {{", m.id),
                "},",
            );
        }
        joiner.append_source("});");
        let (code, map) = joiner.join();
        HotPatch::Update {
            code,
            source_map: map.map(|m| m.to_json_string()),
        }
    }
}

/// Name of the hot runtime's global (`nsh-js` `hot.rs`).
const HOT: &str = "__nsh_hot";

/// Appends a module's code between `open` and `close` (each on its own
/// line, so the module's own lines keep their source map).
fn append_module(
    joiner: &mut rolldown_sourcemap::SourceJoiner<'_>,
    m: &HotModule,
    open: &str,
    close: &str,
) {
    joiner.append_source(open.to_owned());
    match &m.map {
        Some(map) => joiner.append_source(rolldown_sourcemap::SourceMapSource::new(
            m.code.clone(),
            map.clone(),
        )),
        None => joiner.append_source(m.code.clone()),
    }
    joiner.append_source(close.to_owned());
}

/// Bundles an app for development with hot module replacement, blocking
/// the current thread (`ui_sets` as in [`BundleOptions::ui_sets`]).
pub fn bundle_hot(
    entry: &std::path::Path,
    ui_sets: &[nsh_core::element::description::SetDescription],
) -> Result<HotBundle, BundleError> {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .map_err(BundleError::other)?
        .block_on(bundle_hot_async(entry, ui_sets))
}

/// Bundles an app for development with hot module replacement.
pub async fn bundle_hot_async(
    entry: &std::path::Path,
    ui_sets: &[nsh_core::element::description::SetDescription],
) -> Result<HotBundle, BundleError> {
    let start = Instant::now();
    let entry = canonical_bundler_entry(entry)
        .map_err(|e| BundleError::other(format!("entry not found: {}: {e}", entry.display())))?;
    let cwd = entry
        .parent()
        .ok_or_else(|| BundleError::other("entry has no parent directory"))?
        .to_path_buf();
    let natives = Arc::new(Mutex::new(std::collections::BTreeSet::new()));
    let preloads = Arc::new(Mutex::new(std::collections::BTreeSet::new()));
    let plugin_error = Arc::new(Mutex::new(None));
    let assets = Arc::new(Mutex::new(Vec::new()));
    let tailwind = tailwind_setup(&cwd)?;
    let capabilities = capabilities(&cwd)?;
    let resolve = ResolveSetup::read(&cwd)?;
    let mut bundler_options = BundlerOptions {
        input: Some(vec![InputItem {
            import: entry.to_string_lossy().into_owned(),
            ..Default::default()
        }]),
        cwd: Some(cwd.clone()),
        dir: Some(".".into()),
        // One CommonJS chunk per module: modules can be replaced one by
        // one, and imports are read at use (`dep.name`), so a module run
        // again in place is seen by its importers.
        format: Some(OutputFormat::Cjs),
        preserve_modules: Some(true),
        // Every statement stays. Rolldown still leaves out the exports
        // no module imports: an edit that starts using one changes the
        // exporting module too, which then runs again.
        treeshake: rolldown_common::TreeshakeOptions::Boolean(false),
        sourcemap: Some(SourceMapType::Hidden),
        ..Default::default()
    };
    resolve.apply(&mut bundler_options, false);
    let mut bundler = Bundler::with_plugins(
        bundler_options,
        vec![Pluginable::new_shared(plugin::NshPlugin {
            root: cwd.clone(),
            error: plugin_error.clone(),
            assets: assets.clone(),
            hot: true,
            tailwind,
            entry: entry.clone(),
            natives: natives.clone(),
            preloads: Some(preloads.clone()),
            modules: Arc::new(compile::NativeModules::new(ui_sets)),
            split: false,
        })],
    )
    .map_err(|e| BundleError::new(e.into_vec()))?;
    let output = bundler.generate().await.map_err(|e| {
        match plugin_error.lock().expect("error lock").take() {
            Some(message) => BundleError::other(message),
            None => BundleError::new(e.into_vec()),
        }
    })?;
    let mut modules = Vec::new();
    let mut entry_id = None;
    for asset in output.assets {
        let Output::Chunk(chunk) = asset else {
            continue;
        };
        let id = chunk.filename.to_string();
        let embedded = chunk
            .module_ids
            .iter()
            .any(|m| m.as_str().starts_with('\0'));
        if chunk.is_entry {
            entry_id = Some(id.clone());
        }
        modules.push(HotModule {
            id,
            code: chunk.code.clone(),
            map: chunk.map.clone(),
            embedded,
        });
    }
    let (assets, watch_files) = imported_assets(&assets, &bundler, &cwd);
    let natives = std::mem::take(&mut *natives.lock().expect("natives lock"));
    if let Some(warning) = ungranted_host(
        modules.iter().map(|m| m.code.as_str()),
        capabilities.as_ref(),
    ) {
        log::warn!(target: "nsh::build", "{warning}");
    }
    Ok(HotBundle {
        modules,
        natives: natives.into_iter().collect(),
        preloads: std::mem::take(&mut *preloads.lock().expect("preloads lock"))
            .into_iter()
            .collect(),
        entry: entry_id.ok_or_else(|| BundleError::other("bundle produced no entry chunk"))?,
        assets,
        watch_files,
        capabilities,
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

#[cfg(all(test, windows))]
mod windows_bundler_path_tests {
    use std::{
        ffi::OsString,
        os::windows::ffi::{OsStrExt, OsStringExt},
        path::{Component, Path, Prefix},
    };

    use super::*;

    #[test]
    fn ordinary_unc_candidate_preserves_components_without_unicode_conversion() {
        assert_eq!(
            ordinary_unc_candidate(Path::new(r"\\?\UNC\server\share\目录\App.tsx")),
            Some(PathBuf::from(r"\\server\share\目录\App.tsx"))
        );
        let name = OsString::from_wide(&[0xd800, b'.' as u16, b't' as u16, b's' as u16]);
        let mut verbatim = PathBuf::from(r"\\?\UNC\server\share\");
        verbatim.push(&name);
        let mut ordinary = PathBuf::from(r"\\server\share\");
        ordinary.push(name);
        let candidate = ordinary_unc_candidate(&verbatim).unwrap();
        assert_eq!(
            candidate.as_os_str().encode_wide().collect::<Vec<_>>(),
            ordinary.as_os_str().encode_wide().collect::<Vec<_>>()
        );
    }

    #[test]
    fn other_path_namespaces_are_not_rewritten() {
        for path in [
            r"C:\app\App.tsx",
            r"\\?\C:\app\App.tsx",
            r"\\server\share\App.tsx",
            r"\\.\pipe\fixture",
            "/tmp/App.tsx",
        ] {
            assert!(ordinary_unc_candidate(Path::new(path)).is_none(), "{path}");
        }
    }

    #[test]
    fn canonical_bundler_entry_retains_the_existing_source_file_identity() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bundle.rs");
        let actual = std::fs::canonicalize(&source).unwrap();
        let entry = canonical_bundler_entry(&source).unwrap();
        assert_eq!(std::fs::canonicalize(&entry).unwrap(), actual);
        if matches!(actual.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimUNC(..)))
        {
            assert!(
                matches!(entry.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::UNC(..)))
            );
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn apps_calling_the_host_without_a_grant_are_warned() {
        use nsh_core::access::Capabilities;
        let caps = |json| Capabilities::from_json(&serde_json::from_str(json).unwrap()).unwrap();
        let host = ["import { View, host as h } from \"nsh\";"];
        assert!(
            super::ungranted_host(host, None)
                .unwrap()
                .contains("capabilities.host")
        );
        assert!(super::ungranted_host(host, Some(&caps("{}"))).is_some());
        assert!(super::ungranted_host(host, Some(&caps(r#"{"host": false}"#))).is_some());
        assert!(super::ungranted_host(host, Some(&caps(r#"{"host": ["a"]}"#))).is_none());
        assert!(super::ungranted_host(host, Some(&caps(r#"{"host": true}"#))).is_none());
        assert!(super::ungranted_host(["import { View } from \"nsh\";"], None).is_none());
    }

    use super::*;

    /// An app whose screens are imported on demand: the first imports what
    /// only the screens share, the second is also imported by the first.
    fn app(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nsh-split-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let files = [
            (
                "App.tsx",
                "import { mount, signal, Text, View } from \"nsh\";\n\
                 import { label } from \"./shared\";\n\
                 function App() {\n\
                   const screen = signal<any>(null);\n\
                   const open = (m: any) => screen.set(() => m.default);\n\
                   return <View>\n\
                     <Text onPress={() => import(\"./Screen\").then(open)}>{label(\"home\")}</Text>\n\
                     <Text onPress={() => import(\"./Settings\").then(open)}>settings</Text>\n\
                     {screen() && screen()()}\n\
                   </View>;\n\
                 }\n\
                 mount(App);\n",
            ),
            (
                "Screen.tsx",
                "import { Text } from \"nsh\";\n\
                 import { label } from \"./shared\";\n\
                 import { detail } from \"./detail\";\n\
                 export default function Screen() { return <Text onPress={() => import(\"./Settings\")}>{label(detail)}</Text>; }\n",
            ),
            (
                "Settings.tsx",
                "import { Text } from \"nsh\";\n\
                 import { detail } from \"./detail\";\n\
                 export default function Settings() { return <Text>{detail}</Text>; }\n",
            ),
            (
                "shared.ts",
                "export const label = (s: string) => `[${s}]`;\n",
            ),
            ("detail.ts", "export const detail = \"second screen\";\n"),
        ];
        for (file, code) in files {
            std::fs::write(dir.join(file), code).unwrap();
        }
        dir
    }

    fn bundle_app(dir: &std::path::Path, split: bool) -> Bundle {
        bundle(&BundleOptions {
            entry: dir.join("App.tsx"),
            minify: true,
            split,
            ui_sets: Vec::new(),
        })
        .unwrap()
    }

    #[test]
    fn retained_terminal_workbench_bundles_with_current_base_exports() {
        // Exercise the retained example's real import/asset graph. This is a
        // bundler smoke test, not a substitute for TypeScript or mounted UI tests.
        let bundled = bundle(&BundleOptions {
            entry: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../examples/terminal-workbench/App.tsx"),
            minify: false,
            split: false,
            ui_sets: vec![nsh_base::registry().into()],
        })
        .unwrap();
        assert!(bundled.code.contains("Service fleet"));
        assert!(
            bundled
                .watch_files
                .iter()
                .any(|path| path.ends_with("ui.tsx"))
        );
        assert!(
            bundled
                .watch_files
                .iter()
                .any(|path| path.ends_with("inspectors.tsx"))
        );
    }

    #[test]
    fn hot_bundles_keep_optional_native_imports_deferred() {
        let dir = app("hot-native-imports");
        std::fs::write(
            dir.join("App.tsx"),
            "import { mount, Text } from 'nsh';\n\
             function App() { return <Text onPress={() => import('buffer')}>Load</Text>; }\n\
             mount(App);",
        )
        .unwrap();
        let bundle = bundle_hot(&dir.join("App.tsx"), &[]).unwrap();
        let (code, _) = bundle.script();
        assert!(bundle.natives().iter().any(|name| name == "buffer"));
        assert!(code.contains("import(\"buffer\")"), "{code}");
        assert!(!code.contains("from \"buffer\""), "{code}");
        std::fs::write(
            dir.join("App.tsx"),
            "import { Buffer } from 'buffer'; export const bytes = Buffer.from('NSH');",
        )
        .unwrap();
        let eager = bundle_hot(&dir.join("App.tsx"), &[]).unwrap();
        assert!(matches!(eager.patch(&bundle), HotPatch::Reload));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn entry_dependencies_include_static_cycles_but_leave_lazy_chunks_deferred() {
        let chunk = |id: &str, imports: &[&str]| Chunk {
            id: id.to_owned(),
            code: String::new(),
            source_map: None,
            imports: imports.iter().map(|id| (*id).to_owned()).collect(),
        };
        let chunks = vec![
            chunk("ui.js", &["theme.js"]),
            chunk("theme.js", &["ui.js"]),
            chunk("screen.js", &["ui.js"]),
        ];
        assert_eq!(
            entry_dependencies(vec!["ui.js".into(), "nsh".into()], &chunks),
            vec!["theme.js", "ui.js"]
        );
    }

    #[test]
    fn split_bundles_load_dynamic_imports_as_chunks() {
        let dir = app("chunks");
        let bundle = bundle_app(&dir, true);
        let chunks: Vec<(&str, &[String])> = bundle
            .chunks
            .iter()
            .map(|c| (c.id.as_str(), c.imports.as_slice()))
            .collect();
        let detail = ["detail.js".to_owned()];
        assert_eq!(
            chunks,
            [
                ("Screen.js", &detail[..]),
                ("Settings.js", &detail[..]),
                ("detail.js", &[][..]),
            ]
        );
        // Each import names the chunks it needs.
        let code = &bundle.code;
        assert!(
            code.contains("__nsh_import(`Screen.js`,[`detail.js`])"),
            "{code}"
        );
        assert!(
            code.contains("__nsh_import(`Settings.js`,[`detail.js`])"),
            "{code}"
        );
        assert!(
            !code.replace("__nsh_import(", "").contains("import("),
            "{code}"
        );
        let screen = &bundle.chunks[0];
        assert!(
            screen.code.contains("from\"./bundle.js\""),
            "{}",
            screen.code
        );
        assert!(
            screen
                .code
                .contains("__nsh_import(`Settings.js`,[`detail.js`])"),
            "{}",
            screen.code
        );
        // Source maps still lead to the app's modules.
        let map = oxc_sourcemap::SourceMap::from_json_string(bundle.source_map.as_deref().unwrap())
            .unwrap();
        assert!(map.get_sources().any(|s| s.ends_with("App.tsx")));
        let map = oxc_sourcemap::SourceMap::from_json_string(screen.source_map.as_deref().unwrap())
            .unwrap();
        assert!(map.get_sources().any(|s| s.ends_with("Screen.tsx")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bundles_not_split_hold_what_they_import_dynamically() {
        let dir = app("inline");
        let bundle = bundle_app(&dir, false);
        assert!(bundle.chunks.is_empty());
        assert!(!bundle.code.contains("import("), "{}", bundle.code);
        assert!(!bundle.code.contains("__nsh_import"), "{}", bundle.code);
        assert!(bundle.code.contains("second screen"), "{}", bundle.code);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An app importing `files` (name, contents) as images.
    fn svg_app(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nsh-svg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("ui")).unwrap();
        let mut app = String::from(
            "import { Image, mount, View } from \"nsh\";\nglobalThis.importedAssets = [];\n",
        );
        for (i, (file, svg)) in files.iter().enumerate() {
            std::fs::write(dir.join(file), svg).unwrap();
            app.push_str(&format!(
                "import a{i} from \"../{file}\";\nglobalThis.importedAssets.push(a{i});\n"
            ));
        }
        app.push_str("mount(() => <View />);\n");
        std::fs::write(dir.join("ui/index.tsx"), app).unwrap();
        dir
    }

    fn bundle_dev(dir: &std::path::Path) -> Result<Bundle, BundleError> {
        bundle(&BundleOptions {
            entry: dir.join("ui/index.tsx"),
            minify: false,
            split: false,
            ui_sets: Vec::new(),
        })
    }

    #[test]
    fn svg_import_is_sized_in_points() {
        let icon = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20z"/></svg>"#;
        let logo = r#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="96" viewBox="0 0 48 24"/>"#;
        let odd = r#"<svg xmlns="http://www.w3.org/2000/svg" width="9.6" height="4.8"/>"#;
        let dir = svg_app(
            "size",
            &[
                ("icon.svg", icon),
                ("logo@2x.svg", logo),
                ("odd #@2x.svg", odd),
            ],
        );
        let bundle = bundle_dev(&dir).unwrap();
        let root = dunce::canonicalize(&dir).unwrap();
        assert_eq!(bundle.assets.len(), 3);
        let mut expected = Vec::new();
        let mut located = Vec::new();
        for (name, width, height) in [
            ("icon.svg", 24.0, 24.0),
            ("logo@2x.svg", 96.0, 48.0),
            ("odd #@2x.svg", 9.6, 4.8),
        ] {
            let asset = bundle
                .assets
                .iter()
                .find(|asset| asset.source == root.join(name))
                .unwrap();
            assert!(bundle.watch_files.contains(&asset.source));
            expected.push(serde_json::json!([
                format!("asset:/{}", asset.path),
                width,
                height
            ]));
            located.push(serde_json::json!([
                format!(
                    "asset:/plugin/package/ui/{}",
                    asset.path.replace(' ', "%20").replace('#', "%23")
                ),
                width,
                height,
            ]));
        }
        let host = nsh_js::Host::new().unwrap();
        host.eval_source(&bundle.code).unwrap();
        assert!(host.eval_script("check", &format!(
            "JSON.stringify(globalThis.importedAssets.map(a => [a.url, a.size.width, a.size.height])) === JSON.stringify({})",
            serde_json::to_string(&expected).unwrap(),
        )).unwrap());
        let plugin = nsh_js::Host::new().unwrap();
        plugin.add_chunk_source(
            "plugin.js",
            bundle.code,
            Some("asset:/plugin/package/ui/".into()),
        );
        plugin
            .eval_source("import { importModule } from 'nsh'; await importModule('plugin.js');")
            .unwrap();
        assert!(plugin.eval_script("check", &format!(
            "JSON.stringify(globalThis.importedAssets.map(a => [a.url, a.size.width, a.size.height])) === JSON.stringify({})",
            serde_json::to_string(&located).unwrap(),
        )).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn svg_import_of_an_invalid_svg_fails_naming_it() {
        let dir = svg_app(
            "invalid",
            &[(
                "broken.svg",
                "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect",
            )],
        );
        let error = bundle_dev(&dir).unwrap_err();
        assert!(error.plain.contains("broken.svg"), "{error}");
        assert!(error.plain.contains("invalid SVG: "), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_code_gets_its_import_meta_url_and_plain_js_keeps_its_imports() {
        let dir = std::env::temp_dir().join(format!("nsh-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, text) in [
            (
                "App.tsx",
                "import { mount, Text } from \"nsh\";\nimport data from \"./data.json\";\nimport { here } from \"./lib.js\";\nmount(() => <Text>{data.note + here}</Text>);\n",
            ),
            ("data.json", "{ \"note\": \"uses import.meta.url\" }"),
            (
                "lib.js",
                "import { unused } from \"./polyfill.js\";\nexport const here = import.meta.url;\n",
            ),
            (
                "polyfill.js",
                "globalThis.polyfilled = true;\nexport const unused = 1;\n",
            ),
        ] {
            std::fs::write(dir.join(name), text).unwrap();
        }
        let bundle = bundle_app(&dir, false);
        let code = &bundle.code;
        assert!(code.contains("uses import.meta.url"), "{code}");
        assert!(
            code.contains("metaUrl as ") && code.contains("(`lib.js`)"),
            "{code}"
        );
        assert!(code.contains("polyfilled"), "{code}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn development_bundles_require_what_they_import_dynamically() {
        let dir = app("hot");
        let (code, _) = bundle_hot(&dir.join("App.tsx"), &[]).unwrap().script();
        assert!(code.contains("require(\"./Screen.js\")"), "{code}");
        assert!(!code.contains("import("), "{code}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn shared_sources_and_external_themes_are_watched() {
        let dir = app("shared-watch");
        let entry_dir = dir.join("example");
        let ui = dir.join("ui");
        std::fs::create_dir_all(&entry_dir).unwrap();
        std::fs::create_dir_all(&ui).unwrap();
        std::fs::write(ui.join("index.ts"), "export const label = 'shared';").unwrap();
        std::fs::write(
            ui.join("theme.json"),
            r#"{"cssVars":{"theme":{},"light":{},"dark":{}}}"#,
        )
        .unwrap();
        std::fs::write(
            entry_dir.join("nsh.json"),
            r#"{"theme":"../ui/theme.json"}"#,
        )
        .unwrap();
        std::fs::write(
            entry_dir.join("App.tsx"),
            "import { mount, Text } from 'nsh'; import { label } from '../ui'; mount(() => <Text>{label}</Text>);",
        )
        .unwrap();
        let built = bundle_app(&entry_dir, false);
        let hot = bundle_hot(&entry_dir.join("App.tsx"), &[]).unwrap();
        for files in [&built.watch_files, &hot.watch_files] {
            assert!(files.contains(&dunce::canonicalize(ui.join("index.ts")).unwrap()));
            assert!(files.contains(&dunce::canonicalize(ui.join("theme.json")).unwrap()));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bundles_ignore_the_apps_tsconfig() {
        // As an app is before any nsh command wrote `.nsh/tsconfig.json`, with
        // `paths` only the type checker may follow.
        let dir = app("tsconfig");
        std::fs::write(
            dir.join("tsconfig.json"),
            r#"{ "extends": "./.nsh/tsconfig.json",
                 "compilerOptions": { "paths": { "./shared": ["./missing.d.ts"] } } }"#,
        )
        .unwrap();
        let code = bundle_app(&dir, false).code;
        assert!(code.contains("second screen"), "{code}");
        let hot = bundle_hot(&dir.join("App.tsx"), &[]).unwrap();
        assert!(
            hot.modules.iter().any(|m| m.id.contains("shared")),
            "{:?}",
            hot.modules
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An app importing a package whose browser build uses the DOM, a module
    /// an alias replaces and one it leaves out; `resolve` is its nsh.json's.
    fn resolving_app(name: &str, resolve: Option<&str>) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nsh-resolve-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pkg = dir.join("node_modules/entities");
        std::fs::create_dir_all(&pkg).unwrap();
        let files = [
            (
                "App.tsx",
                "import { decode } from \"entities\";\n\
                 import { name } from \"dom-only\";\n\
                 import \"polyfill\";\n\
                 console.log(decode(\"amp\"), name, process.env.NODE_ENV);\n",
            ),
            ("shim.ts", "export const name = \"shimmed\";\n"),
            (
                "node_modules/entities/package.json",
                r#"{ "name": "entities", "browser": "./dom.js",
                     "exports": { ".": { "browser": "./dom.js", "default": "./plain.js" } } }"#,
            ),
            (
                "node_modules/entities/dom.js",
                "export const decode = (s) => document.title + s;\n",
            ),
            (
                "node_modules/entities/plain.js",
                "export const decode = (s) => \"plain build \" + s;\n",
            ),
        ];
        for (file, code) in files {
            std::fs::write(dir.join(file), code).unwrap();
        }
        if let Some(resolve) = resolve {
            std::fs::write(
                dir.join("nsh.json"),
                format!("{{ \"resolve\": {resolve} }}"),
            )
            .unwrap();
        }
        dir
    }

    #[test]
    fn packages_resolve_their_browser_builds_by_default() {
        let dir = resolving_app(
            "default",
            Some(r#"{ "alias": { "dom-only": "./shim.ts", "polyfill": false } }"#),
        );
        let code = bundle_app(&dir, false).code;
        assert!(code.contains("document.title"), "{code}");
        assert!(code.contains("shimmed"), "{code}");
        assert!(code.contains("production"), "{code}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_conditions_replace_the_browser_condition() {
        let dir = resolving_app(
            "conditions",
            Some(
                r#"{ "conditions": ["worker"], "alias": { "dom-only": "./shim.ts", "polyfill": false } }"#,
            ),
        );
        let code = bundle_app(&dir, false).code;
        assert!(code.contains("plain build"), "{code}");
        assert!(!code.contains("document"), "{code}");
        assert!(code.contains("shimmed"), "{code}");
        // `process.env.NODE_ENV` is still defined, as for the browser.
        assert!(code.contains("production"), "{code}");
        assert!(!code.contains("process.env"), "{code}");
        let hot = bundle_hot(&dir.join("App.tsx"), &[]).unwrap();
        let module = hot
            .modules
            .iter()
            .find(|m| m.id.contains("plain"))
            .map(|m| &m.code);
        assert!(
            module.is_some_and(|c| c.contains("plain build")),
            "{:?}",
            hot.modules
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_options_are_checked() {
        for (resolve, message) in [
            (
                r#"{ "conditionz": [] }"#,
                "nsh.json: resolve: unknown key `conditionz`",
            ),
            (
                r#"{ "conditions": "worker" }"#,
                "nsh.json: resolve: conditions: expected an array of strings",
            ),
            (
                r#"{ "alias": { "a": 1 } }"#,
                "nsh.json: resolve: alias: `a`: expected a path, a module or false",
            ),
        ] {
            let dir = resolving_app("checked", Some(resolve));
            let error = bundle(&BundleOptions {
                entry: dir.join("App.tsx"),
                minify: true,
                split: false,
                ui_sets: Vec::new(),
            })
            .unwrap_err();
            assert_eq!(error.plain, message);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// An app whose entry is `code`.
    fn single(name: &str, code: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nsh-import-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("App.tsx"), code).unwrap();
        dir
    }

    fn bundling(dir: &std::path::Path) -> Result<Bundle, BundleError> {
        bundle(&BundleOptions {
            entry: dir.join("App.tsx"),
            minify: false,
            split: false,
            ui_sets: Vec::new(),
        })
    }

    /// What an app's code uses of the native modules, from every chunk of
    /// a split bundle, by the names they export (types left out).
    #[test]
    fn native_use_names_what_every_chunk_imports() {
        let dir = single(
            "use",
            "import { mount, signal, type Signal } from \"nsh\";\n\
             const count: Signal<number> = signal(0);\n\
             const screen = () => import(\"./Screen\");\n\
             mount(() => { count.set(1); return screen; });\n",
        );
        std::fs::write(
            dir.join("Screen.tsx"),
            "import { computed } from \"nsh\";\nexport default computed(() => 1);\n",
        )
        .unwrap();
        let bundle = bundle(&BundleOptions {
            entry: dir.join("App.tsx"),
            minify: true,
            split: true,
            ui_sets: Vec::new(),
        })
        .unwrap();
        assert!(!bundle.chunks.is_empty());
        let names = ["computed", "mount", "signal"].map(String::from);
        assert_eq!(
            bundle.native_use.imports.get("nsh"),
            Some(&crate::Imported::Names(names.into_iter().collect()))
        );
        assert!(!bundle.native_use.global_crypto && !bundle.native_use.computed_import);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn named_imports_the_module_does_not_export_fail_the_build() {
        let dir = single(
            "missing",
            "import { mount, Text } from \"nsh\";\n\
             import { AnimatedValu } from \"nsh\";\n\
             mount(() => <Text>{String(AnimatedValu)}</Text>);\n",
        );
        let error = bundling(&dir).unwrap_err().plain;
        assert!(error.contains("App.tsx"), "{error}");
        assert!(
            error.contains("`nsh` has no export `AnimatedValu`"),
            "{error}"
        );
        assert!(error.contains("2:"), "{error}");
        assert!(error.contains("did you mean `AnimatedValue`?"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn named_imports_of_what_a_module_exports_and_types_bundle() {
        let dir = single(
            "present",
            "import { mount, Text, type NoSuchType, NoSuchProps } from \"nsh\";\n\
             let props: NoSuchProps | NoSuchType | undefined;\n\
             import { AnimatedValue as V } from \"nsh\";\n\
             import type { Gone } from \"nsh\";\n\
             import * as animated from \"nsh\";\n\
             mount(() => <Text>{String(V)}{String(animated)}</Text>);\n",
        );
        bundling(&dir).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn development_bundles_refuse_what_a_ui_set_does_not_export() {
        let dir = single(
            "hot",
            "import { mount } from \"nsh\";\n\
             import { Buton } from \"nsh/base\";\n\
             mount(() => <Buton title=\"Go\" />);\n",
        );
        let ui_sets = [nsh_base::registry().into()];
        let Err(error) = bundle_hot(&dir.join("App.tsx"), &ui_sets) else {
            panic!("bundled");
        };
        let error = error.plain;
        assert!(
            error.contains("`nsh/base` has no export `Buton`"),
            "{error}"
        );
        assert!(error.contains("did you mean `Button`?"), "{error}");
        std::fs::write(
            dir.join("App.tsx"),
            "import { mount } from \"nsh\";\n\
             import { Button } from \"nsh/base\";\n\
             mount(() => <Button title=\"Go\" />);\n",
        )
        .unwrap();
        bundle_hot(&dir.join("App.tsx"), &ui_sets).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
