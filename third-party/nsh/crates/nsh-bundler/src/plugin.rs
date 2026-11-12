use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::anyhow;
use nsh_core::geometry::{Points, Size};
use oxc::span::SourceType;
use resvg::usvg::roxmltree;
use rolldown::{
    ModuleType,
    plugin::{
        HookLoadArgs, HookLoadOutput, HookLoadReturn, HookRenderChunkArgs, HookRenderChunkOutput,
        HookRenderChunkReturn, HookResolveIdArgs, HookResolveIdOutput, HookResolveIdReturn,
        HookTransformArgs, HookTransformOutput, HookTransformOutputMap, HookTransformReturn,
        HookUsage, Plugin, PluginContext, SharedLoadPluginContext, SharedTransformPluginContext,
    },
};

use crate::compile::{NativeModules, compile_native};

/// Compiles the app's modules with nsh's JSX compiler against the native
/// modules (kept as imports) and loads its assets.
#[derive(Debug)]
pub(crate) struct NshPlugin {
    /// Paths in error messages are shown relative to this directory.
    pub(crate) root: PathBuf,
    /// What `asset:/` URLs and the bundle's assets are named relative to:
    /// the app's directory (`Bundle::asset_root`), canonical.
    pub(crate) asset_root: PathBuf,
    /// The first compile error, already formatted. Rolldown wraps plugin
    /// errors in its own report; the bundler shows this one instead.
    pub(crate) error: Arc<Mutex<Option<String>>>,
    /// Asset files imported by the app (absolute paths).
    pub(crate) assets: Arc<Mutex<Vec<PathBuf>>>,
    /// Development bundle with hot module replacement: components and
    /// contexts of app modules are registered with the hot runtime.
    pub(crate) hot: bool,
    /// The app's themes (`nsh.json`).
    pub(crate) tailwind: Arc<ThemeSetup>,
    /// The entry module (it sets up the themes).
    pub(crate) entry: PathBuf,
    /// The native modules the app imports.
    pub(crate) natives: Arc<Mutex<std::collections::BTreeSet<String>>>,
    /// Static native imports whose namespaces hot factories require immediately.
    pub(crate) preloads: Option<Arc<Mutex<std::collections::BTreeSet<String>>>>,
    /// The native modules there are.
    pub(crate) modules: Arc<NativeModules>,
    /// A split bundle: dynamic imports of chunks call the runtime's chunk
    /// loader (`split.rs`).
    pub(crate) split: bool,
}

/// The `"tailwind"`, `"theme"`, `"appearance"` and `"statusBar"` of the
/// app's `nsh.json`.
#[derive(Debug, Default)]
pub(crate) struct ThemeSetup {
    /// The Tailwind theme as JSON, for the runtime (`None`: the default).
    pub(crate) json: Option<String>,
    /// Parsed, to check classes at build time.
    pub(crate) theme: nsh_core::tailwind::Theme,
    /// The app's design tokens (a shadcn `cssVars` theme file), checked.
    pub(crate) ui: Option<String>,
    /// `"appearance"`: `"light"` or `"dark"` (`None`: the system's).
    pub(crate) appearance: Option<&'static str>,
    /// `"statusBar"`, checked, as JSON: the status bar's default.
    pub(crate) status_bar: Option<String>,
    /// The app's translations (`locales/`) and the language data it ships
    /// (`"locales"`), as the runtime's `i18n` takes them: a module of their
    /// own the entry imports first ([`I18N_MODULE`]).
    pub(crate) i18n: Option<String>,
    /// What `appInfo()` reports (JSON): handed to the runtime by a module
    /// of its own the entry imports first ([`APP_MODULE`]).
    pub(crate) app: String,
}

/// The module that hands the runtime the app's information (`appInfo()`),
/// imported first by the entry, before the modules that may read it.
pub(crate) const APP_MODULE: &str = "virtual:nsh-app";
const APP_ID: &str = "\0nsh-app";

/// The module that hands the runtime the app's translations and language
/// data, imported first by the entry so that it runs before any other
/// module's code.
pub(crate) const I18N_MODULE: &str = "virtual:nsh-i18n";
const I18N_ID: &str = "\0nsh-i18n";

/// File types imported as image assets.
pub(crate) const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"];

/// File types imported as audio: the formats `Sound` and `AudioPlayer`
/// play on every platform (`docs/dev/audio-design.md`).
pub(crate) const AUDIO_EXTENSIONS: &[&str] = &["wav", "m4a", "aac", "mp3"];

/// File types imported as video: the formats `Video` plays.
pub(crate) const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "webm"];

/// The suffix that imports any file as its `asset:/` URL
/// (`import data from "./data.bin?url"`), as Vite's does.
pub(crate) const URL_SUFFIX: &str = "?url";

/// File types imported as fonts.
pub(crate) const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "woff", "woff2"];

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// The family name a font registers under ([`nsh_core::font_family`]).
fn font_family(data: &[u8]) -> Result<String, String> {
    nsh_core::font_family(data)
}

/// An SVG imported as `rel`: its size in points, as the native backends
/// size it ([`nsh_core::svg::size`]), and the build's warnings about what of
/// it browsers alone draw ([`svg_browser_only`]), naming the file.
fn svg_asset(rel: &str, data: &[u8]) -> Result<(Size<Points>, Vec<String>), nsh_core::svg::Error> {
    let size = nsh_core::svg::size(data)?;
    let warnings = svg_browser_only(data)
        .into_iter()
        .map(|difference| format!("{rel}: {difference}"))
        .collect();
    Ok((size, warnings))
}

/// What an SVG holds that browsers draw and the native image rasterizer
/// leaves out: animation (SMIL elements, CSS animations), an `<image>` that
/// references a file, a URL or a nested SVG document, and HTML
/// (`<foreignObject>`). Inline raster `data:` images draw natively.
fn svg_browser_only(data: &[u8]) -> Vec<&'static str> {
    let Ok(text) = std::str::from_utf8(data) else {
        return Vec::new();
    };
    let options = roxmltree::ParsingOptions {
        allow_dtd: true,
        ..roxmltree::ParsingOptions::default()
    };
    let Ok(doc) = roxmltree::Document::parse_with_options(text, options) else {
        return Vec::new();
    };
    let (mut animation, mut images, mut html) = (false, false, false);
    for node in doc.descendants().filter(|n| n.is_element()) {
        match node.tag_name().name() {
            "animate" | "animateColor" | "animateMotion" | "animateTransform" | "set" => {
                animation = true
            }
            "image" => {
                let href = node
                    .attribute("href")
                    .or_else(|| node.attribute(("http://www.w3.org/1999/xlink", "href")));
                images |= !href.is_some_and(inline_raster);
            }
            "foreignObject" => html = true,
            "style" => {
                animation |= node
                    .descendants()
                    .filter_map(|n| n.text())
                    .any(css_animates)
            }
            _ => {}
        }
        animation |= node.attribute("style").is_some_and(css_animates);
    }
    let mut found = Vec::new();
    if animation {
        found.push("its animation plays in browsers; native platforms draw the SVG still");
    }
    if images {
        found.push(
            "its <image> elements that reference files, URLs or SVG documents show only in \
             browsers; native platforms draw inline raster data images",
        );
    }
    if html {
        found.push(
            "its <foreignObject> content shows in browsers; native platforms draw the SVG \
             without it",
        );
    }
    found
}

/// Whether an `<image>` href is an inline raster `data:` image, the only
/// kind the native rasterizer loads.
fn inline_raster(href: &str) -> bool {
    let Some(rest) = href.strip_prefix("data:") else {
        return false;
    };
    // The MIME is trimmed and lowercased, as usvg's data URL parser reads it.
    let mime = rest
        .split([';', ','])
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
    )
}

/// Whether CSS (a style sheet or a `style` attribute) animates: a
/// `@keyframes` rule, or an `animation` or `animation-name` declaration
/// other than `none`; a selector or a comment that merely says "animation"
/// does not count.
fn css_animates(css: &str) -> bool {
    let mut rest = css;
    let mut code = String::with_capacity(css.len());
    // Comments are no CSS.
    while let Some(start) = rest.find("/*") {
        code.push_str(&rest[..start]);
        rest = rest[start + 2..]
            .split_once("*/")
            .map_or("", |(_, after)| after);
    }
    code.push_str(rest);
    let code = code.to_ascii_lowercase();
    code.split(['{', '}', ';']).any(|piece| {
        let piece = piece.trim_start();
        let at_rule = piece.strip_prefix('@').map(|rule| {
            rule.trim_start_matches("-webkit-")
                .trim_start_matches("-moz-")
        });
        if at_rule.is_some_and(|rule| rule.starts_with("keyframes")) {
            return true;
        }
        piece.split_once(':').is_some_and(|(property, value)| {
            let property = property.trim().trim_start_matches("-webkit-");
            matches!(property, "animation" | "animation-name") && value.trim() != "none"
        })
    })
}

/// `logo@2x.png` -> 2.0: the pixel density encoded in the file name.
fn density(path: &Path) -> f64 {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    match stem.rsplit_once('@').and_then(|(_, d)| d.strip_suffix('x')) {
        Some(d) => d.parse().unwrap_or(1.0),
        None => 1.0,
    }
}

/// Whether the file name says its density (`logo@2x.png`, `logo@1x.png`).
fn has_density(path: &Path) -> bool {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    stem.rsplit_once('@')
        .and_then(|(_, d)| d.strip_suffix('x'))
        .is_some_and(|d| d.parse::<f64>().is_ok())
}

/// `path` from `base` (`../shared/logo.png`), `/`-separated, for messages;
/// `path` itself when they share no root (another drive).
fn relative(path: &Path, base: &Path) -> String {
    let parts: Vec<_> = path.components().collect();
    let from: Vec<_> = base.components().collect();
    let common = parts.iter().zip(&from).take_while(|(a, b)| a == b).count();
    if common == 0 {
        return path.to_string_lossy().replace('\\', "/");
    }
    std::iter::repeat_n(Cow::Borrowed(".."), from.len() - common)
        .chain(
            parts[common..]
                .iter()
                .map(|c| c.as_os_str().to_string_lossy()),
        )
        .collect::<Vec<_>>()
        .join("/")
}

/// The pixel-density variants of image `path` (a file without a density
/// suffix): its siblings `<stem>@<scale>x.<ext>` for the scales of
/// [`nsh_core::IMAGE_SCALES`] above 1 that exist. Stat calls only: no
/// directory listing.
pub(crate) fn variants(path: &Path) -> Vec<(f32, PathBuf)> {
    if has_density(path) {
        return Vec::new();
    }
    let (Some(stem), Some(ext)) = (
        path.file_stem().and_then(|s| s.to_str()),
        path.extension().and_then(|e| e.to_str()),
    ) else {
        return Vec::new();
    };
    nsh_core::IMAGE_SCALES
        .into_iter()
        .filter(|s| *s != 1.0)
        .map(|s| (s, path.with_file_name(format!("{stem}@{s}x.{ext}"))))
        .filter(|(_, p)| p.is_file())
        .collect()
}

/// Why the `scale` variant `rel` of an image of `points` (its size in
/// points) does not fit it: its `pixels` are not the points times the
/// scale (to the pixel).
fn variant_mismatch(
    rel: &str,
    points: (f64, f64),
    scale: f32,
    pixels: (usize, usize),
) -> Option<String> {
    let scale = f64::from(scale);
    let expected = (points.0 * scale, points.1 * scale);
    let off = |want: f64, got: usize| (want - got as f64).abs() >= 1.0;
    (off(expected.0, pixels.0) || off(expected.1, pixels.1)).then(|| {
        format!(
            "{rel}: {}x{} pixels, expected {}x{} ({}x{} points at @{scale}x)",
            pixels.0, pixels.1, expected.0, expected.1, points.0, points.1
        )
    })
}

/// The module of an image import: its URL and size in points and, when
/// it has variants (their `scales`, above 1), the scales it ships in, 1
/// first. Without variants it is `{ url, size: { width, height } }`.
fn image_module(
    url: &str,
    (w, h): (impl std::fmt::Display, impl std::fmt::Display),
    scales: &[f32],
) -> String {
    let scales = if scales.is_empty() {
        String::new()
    } else {
        let list: Vec<String> = std::iter::once(1.0)
            .chain(scales.iter().copied())
            .map(|s| s.to_string())
            .collect();
        format!(", scales: [{}]", list.join(", "))
    };
    format!(
        "import {{ assetUrl }} from \"nsh:rt\";\nexport default {{ url: assetUrl({url:?}, import.meta.assetBase), size: {{ width: {w}, height: {h} }}{scales} }};"
    )
}

impl NshPlugin {
    /// The entry's first statement, giving the renderer the app's themes,
    /// appearance and status bar.
    fn prologue(&self) -> Option<String> {
        let json = |v: &Option<String>| match v {
            Some(json) => serde_json::Value::String(json.clone()).to_string(),
            None => "null".to_owned(),
        };
        let setup = &self.tailwind;
        let app = (!setup.app.is_empty()).then(|| format!("import {APP_MODULE:?};\n"));
        let i18n = setup
            .i18n
            .is_some()
            .then(|| format!("import {I18N_MODULE:?};\n"));
        let i18n = match (app, i18n) {
            (None, None) => None,
            (app, i18n) => Some(app.unwrap_or_default() + &i18n.unwrap_or_default()),
        };
        let call = (setup.json.is_some()
            || setup.ui.is_some()
            || setup.appearance.is_some()
            || setup.status_bar.is_some())
        .then(|| {
            format!(
                "_$setup({}, {}, {}, {});",
                json(&setup.json),
                json(&setup.ui),
                json(&setup.appearance.map(str::to_owned)),
                json(&setup.status_bar)
            )
        });
        match (i18n, call) {
            (None, None) => None,
            (i18n, call) => Some(i18n.unwrap_or_default() + &call.unwrap_or_default()),
        }
    }

    /// Records `message` as the build's error (shown as it is).
    fn refuse(&self, message: String) -> anyhow::Error {
        self.error
            .lock()
            .expect("error lock")
            .get_or_insert_with(|| message.clone());
        anyhow!(message)
    }

    /// `path` relative to the entry's directory with `/` separators, as
    /// module ids and messages name it on every system (asset URLs:
    /// [`NshPlugin::ship`]).
    fn rel(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// Ships the asset `path` with the app and names it (its `asset:/` URL
    /// without the scheme): its path in the app's directory, `/`-separated
    /// on every system. A file outside it fails the build: the files an app
    /// imports ship with it, and a package holds only its directory.
    fn ship(&self, path: &Path) -> anyhow::Result<String> {
        // Inside once real, always: a link in the app to a file outside it
        // (a pixel-density variant found beside an image, which the
        // resolver never saw) ships nothing a package could hold, and the
        // CLI's `asset_in_root` refuses links out too.
        let real = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let Ok(real_rel) = real.strip_prefix(&self.asset_root) else {
            let shown = match path.strip_prefix(&self.asset_root) {
                Ok(rel) => format!(
                    "`{}` links to {}, which",
                    rel.to_string_lossy().replace('\\', "/"),
                    real.display()
                ),
                Err(_) => format!("`{}`", relative(path, &self.asset_root)),
            };
            return Err(self.refuse(format!(
                "{shown} is outside the app's directory {}: the files an app imports ship with it, so move it inside",
                self.asset_root.display()
            )));
        };
        // Named as imported or found when that path is in the app, so a
        // variant that links elsewhere in it keeps its image's name
        // (`logo@2x.png`, which hosts derive from `logo.png`); else as
        // real (the resolver's own spelling, a drive letter's case).
        let rel = path
            .strip_prefix(&self.asset_root)
            .ok()
            .filter(|rel| {
                rel.components()
                    .all(|c| matches!(c, std::path::Component::Normal(_)))
            })
            .unwrap_or(real_rel);
        let name = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        // As named: the bundle lists it relative to the root.
        let file = self.asset_root.join(rel);
        self.assets.lock().expect("assets lock").push(file);
        Ok(name)
    }

    /// A module whose default export is the `asset:/` URL of `path`, which
    /// ships with the app.
    fn url_module(&self, path: &Path) -> anyhow::Result<HookLoadOutput> {
        let name = self.ship(path)?;
        let code = format!(
            "import {{ assetUrl }} from \"nsh:rt\";\nexport default assetUrl({:?}, import.meta.assetBase);",
            format!("asset:/{name}")
        );
        Ok(HookLoadOutput {
            code: code.into(),
            module_type: Some(ModuleType::Js),
            ..Default::default()
        })
    }

    fn fail(&self, path: &Path, detail: &str) -> anyhow::Error {
        let message = format!("{}\n{detail}", self.rel(path));
        self.error
            .lock()
            .expect("error lock")
            .get_or_insert_with(|| message.clone());
        anyhow!(message)
    }
}

impl Plugin for NshPlugin {
    fn name(&self) -> Cow<'static, str> {
        "nsh".into()
    }

    fn register_hook_usage(&self) -> HookUsage {
        let usage = HookUsage::ResolveId | HookUsage::Load | HookUsage::Transform;
        if self.split {
            usage | HookUsage::RenderChunk
        } else {
            usage
        }
    }

    async fn render_chunk(
        &self,
        _cx: &PluginContext,
        args: &HookRenderChunkArgs<'_>,
    ) -> HookRenderChunkReturn {
        // What each chunk imports statically, by file name.
        let imports: std::collections::HashMap<&str, Vec<String>> = args
            .chunks
            .values()
            .map(|c| {
                let own = c.filename.as_str();
                let imports =
                    crate::bundle::chunk_imports(c.imports.iter().map(|i| i.as_str()), own);
                (own, imports)
            })
            .collect();
        let rewritten = crate::split::rewrite_imports(&args.code, &args.chunk.filename, |id| {
            imports.get(id).map(Vec::as_slice)
        });
        Ok(rewritten.map(|(code, map)| HookRenderChunkOutput {
            code,
            map: HookTransformOutputMap::Sourcemap(Box::new(map)),
        }))
    }

    async fn resolve_id(
        &self,
        _cx: &PluginContext,
        args: &HookResolveIdArgs<'_>,
    ) -> HookResolveIdReturn {
        let spec = args.specifier;
        if spec == I18N_MODULE && self.tailwind.i18n.is_some() {
            return Ok(Some(HookResolveIdOutput::from_id(I18N_ID)));
        }
        if spec == APP_MODULE && !self.tailwind.app.is_empty() {
            return Ok(Some(HookResolveIdOutput::from_id(APP_ID)));
        }
        if self.modules.contains(spec) {
            // Hot factories keep external import() expressions. Preloading
            // their namespaces would turn an optional native API into an
            // eager dependency, including on hosts where it is unavailable.
            self.natives
                .lock()
                .expect("natives lock")
                .insert(spec.to_owned());
            if !args.kind.is_dynamic()
                && let Some(preloads) = &self.preloads
            {
                preloads
                    .lock()
                    .expect("preloads lock")
                    .insert(spec.to_owned());
            }
            return Ok(Some(HookResolveIdOutput {
                external: Some(true.into()),
                ..HookResolveIdOutput::from_id(spec)
            }));
        }
        let from = args
            .importer
            .map(|i| format!("{}: ", self.rel(Path::new(i))))
            .unwrap_or_default();
        if spec == "solid-js" || spec.starts_with("solid-js/") {
            return Err(self.refuse(format!(
                "{from}`{spec}` is not part of nsh apps: import signal, computed, effect, batch, untracked, cleanup, context and mount from \"nsh\""
            )));
        }
        if spec.starts_with("nsh/") {
            // Named as nsh's modules are, and none of them: name the ones
            // there are.
            let modules: Vec<String> = self.modules.nsh().map(|m| format!("`{m}`")).collect();
            return Err(self.refuse(format!(
                "{from}nsh has no module `{spec}`: nsh's modules are {}",
                modules.join(", ")
            )));
        }
        if let Some(file) = spec.strip_suffix(URL_SUFFIX) {
            let path = if Path::new(file).is_absolute() {
                PathBuf::from(file)
            } else if file.starts_with("./") || file.starts_with("../") {
                let dir = args
                    .importer
                    .and_then(|i| Path::new(i).parent())
                    .unwrap_or(&self.root);
                dir.join(file)
            } else {
                return Err(self.refuse(format!(
                    "{from}`{spec}`: a `{URL_SUFFIX}` import names its file by a relative path"
                )));
            };
            if !path.is_file() {
                return Err(self.refuse(format!("{from}`{spec}`: no such file")));
            }
            let path = dunce::canonicalize(&path).unwrap_or(path);
            return Ok(Some(HookResolveIdOutput::from_id(format!(
                "{}{URL_SUFFIX}",
                path.to_string_lossy()
            ))));
        }
        // Rolldown may otherwise replace unsupported Node builtins with browser
        // shims. These are absent from the reference runtime catalog.
        if ["events", "assert", "util", "string_decoder", "fs"].contains(&spec)
            || spec.starts_with("node:")
            || spec.starts_with("@nsh/llrt-types/")
            || spec.starts_with("nsh:")
        {
            return Err(self.refuse(format!("{from}nsh has no module `{spec}`")));
        }
        Ok(None)
    }

    async fn load(&self, _cx: SharedLoadPluginContext, args: &HookLoadArgs<'_>) -> HookLoadReturn {
        if args.id == I18N_ID
            && let Some(json) = &self.tailwind.i18n
        {
            let code = format!(
                "import {{ i18n }} from \"nsh:rt\";\ni18n({});",
                serde_json::Value::String(json.clone())
            );
            return Ok(Some(HookLoadOutput {
                code: code.into(),
                module_type: Some(ModuleType::Js),
                ..Default::default()
            }));
        }
        if args.id == APP_ID && !self.tailwind.app.is_empty() {
            // `setup`'s fifth argument; a runtime that predates it ignores it.
            let code = format!(
                "import {{ setup }} from \"nsh:rt\";\nsetup(null, null, null, null, {});",
                serde_json::Value::String(self.tailwind.app.clone())
            );
            return Ok(Some(HookLoadOutput {
                code: code.into(),
                module_type: Some(ModuleType::Js),
                ..Default::default()
            }));
        }
        if let Some(file) = args.id.strip_suffix(URL_SUFFIX) {
            return Ok(Some(self.url_module(Path::new(file))?));
        }
        let path = Path::new(args.id);
        let rel = self.rel(path);
        if has_extension(path, FONT_EXTENSIONS) {
            // A font import is its family name; the runtime registers the
            // font before the first frame.
            let data = std::fs::read(path).map_err(|e| self.fail(path, &e.to_string()))?;
            let family = font_family(&data)
                .map_err(|e| self.fail(path, &format!("cannot read font: {e}")))?;
            let name = self.ship(path)?;
            let code = format!(
                "import {{ font, assetUrl }} from \"nsh:rt\";\nexport default font(assetUrl({uri:?}, import.meta.assetBase), {family:?});",
                uri = format!("asset:/{name}"),
            );
            return Ok(Some(HookLoadOutput {
                code: code.into(),
                module_type: Some(ModuleType::Js),
                ..Default::default()
            }));
        }
        if has_extension(path, AUDIO_EXTENSIONS) || has_extension(path, VIDEO_EXTENSIONS) {
            // An audio or video import is its URL, for `Sound.load`,
            // `AudioPlayer` and `Video`'s `src`; the file ships with the app.
            return Ok(Some(self.url_module(path)?));
        }
        if !has_extension(path, IMAGE_EXTENSIONS) {
            return Ok(None);
        }
        // An image import is an asset descriptor; the natural size (in
        // points) lets the image lay out before it is decoded. An SVG's is
        // its own (a file name's `@2x` does not apply), as the native
        // backends read it, written as the shortest number that is the
        // `f32` they lay it out at; drawn for the screen at any ratio, it
        // ships no pixel-density variants. A bitmap's variants ship with it,
        // and the core loads the one for the screen.
        let ((w, h), variants) = if has_extension(path, &["svg"]) {
            let data = std::fs::read(path).map_err(|e| self.fail(path, &e.to_string()))?;
            let (size, warnings) =
                svg_asset(&rel, &data).map_err(|e| self.fail(path, &e.to_string()))?;
            for warning in warnings {
                log::warn!(target: "nsh::build", "{warning}");
            }
            let size = (size.width.0.to_string(), size.height.0.to_string());
            (size, Vec::new())
        } else {
            let dim = imagesize::size(path)
                .map_err(|e| self.fail(path, &format!("cannot read image: {e}")))?;
            let scale = density(path);
            let (w, h) = (dim.width as f64 / scale, dim.height as f64 / scale);
            let variants = variants(path);
            for (scale, variant) in &variants {
                let d = imagesize::size(variant)
                    .map_err(|e| self.fail(variant, &format!("cannot read image: {e}")))?;
                if let Some(warning) =
                    variant_mismatch(&self.rel(variant), (w, h), *scale, (d.width, d.height))
                {
                    log::warn!(target: "nsh::build", "{warning}");
                }
            }
            ((w.to_string(), h.to_string()), variants)
        };
        let name = self.ship(path)?;
        for (_, variant) in &variants {
            self.ship(variant)?;
        }
        let scales: Vec<f32> = variants.iter().map(|(s, _)| *s).collect();
        let code = image_module(&format!("asset:/{name}"), (w, h), &scales);
        Ok(Some(HookLoadOutput {
            code: code.into(),
            module_type: Some(ModuleType::Js),
            ..Default::default()
        }))
    }

    async fn transform(
        &self,
        _cx: SharedTransformPluginContext,
        args: &HookTransformArgs<'_>,
    ) -> HookTransformReturn {
        let jsx_module = matches!(args.module_type, ModuleType::Tsx | ModuleType::Jsx);
        // Rolldown's own helpers.
        if args.id.starts_with('\0') {
            return Ok(None);
        }
        let path = Path::new(args.id);
        let entry = path == self.entry;
        let script = matches!(args.module_type, ModuleType::Ts | ModuleType::Js);
        // A module that reads `import.meta` gets its own URL (`metaUrl`).
        // (JSON, text and CSS modules are not code, whatever they say.)
        let meta = script && args.code.contains("import.meta");
        if !(jsx_module || entry || self.hot && script || meta) {
            return Ok(None);
        }
        let hot_key = self.hot.then(|| self.rel(path));
        // By module type, not file name: asset modules (`logo.png`) are JS.
        let source_type = match args.module_type {
            ModuleType::Tsx => SourceType::tsx(),
            ModuleType::Jsx => SourceType::jsx(),
            ModuleType::Ts => SourceType::ts(),
            _ => SourceType::mjs(),
        };
        if jsx_module {
            let rel = self.rel(path);
            for u in crate::classes::check(args.code, source_type, &self.tailwind.theme) {
                log::warn!(target: "nsh::build", "{rel}:{}:{}: unknown class `{}`", u.line, u.column, u.class);
            }
        }
        let prologue = if entry { self.prologue() } else { None };
        let compiled = compile_native(
            path,
            source_type,
            args.code,
            prologue.as_deref(),
            hot_key.as_deref(),
            Some(&self.rel(path)),
            &self.modules,
        )
        .map_err(|detail| self.fail(path, &detail))?;
        if !compiled.destructured.is_empty() {
            let rel = self.rel(path);
            for d in &compiled.destructured {
                log::warn!(target: "nsh::build", "{rel}:{}:{}: {}", d.line, d.column, d.message());
            }
        }
        Ok(Some(HookTransformOutput {
            code: Some(compiled.code),
            map: compiled.map.into(),
            module_type: Some(ModuleType::Js),
            ..Default::default()
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::{BundleOptions, bundle};

    /// The header of a `w`×`h` PNG: all the image size reader looks at.
    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        out.extend(w.to_be_bytes());
        out.extend(h.to_be_bytes());
        out.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
        out
    }

    /// An app importing `import` (from `img/`), with `files` (name, pixel
    /// size) in `img/`.
    fn app(name: &str, import: &str, files: &[(&str, (u32, u32))]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nsh-variants-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("img")).unwrap();
        for (file, (w, h)) in files {
            std::fs::write(dir.join("img").join(file), png(*w, *h)).unwrap();
        }
        std::fs::write(
            dir.join("App.tsx"),
            format!(
                "import {{ Image, mount }} from \"nsh\";\nimport icon from \"./img/{import}\";\nglobalThis.importedAsset = icon;\nmount(() => <Image src={{icon}} />);\n"
            ),
        )
        .unwrap();
        dir
    }

    fn try_bundle(dir: &Path) -> Result<crate::Bundle, crate::BundleError> {
        bundle(&BundleOptions {
            entry: dir.join("App.tsx"),
            minify: false,
            split: false,
            ui_sets: Vec::new(),
            ..Default::default()
        })
    }

    fn bundled(dir: &Path) -> crate::Bundle {
        try_bundle(dir).unwrap()
    }

    fn assets(bundle: &crate::Bundle) -> Vec<String> {
        bundle
            .assets
            .iter()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    fn svg(body: &str) -> Vec<u8> {
        format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">{body}</svg>"#)
            .into_bytes()
    }

    /// An audio import is its `asset:/` URL, and the file ships.
    #[test]
    fn an_audio_import_is_its_url_and_ships() {
        let dir = std::env::temp_dir().join(format!("nsh-audio-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sounds")).unwrap();
        std::fs::write(dir.join("sounds/tap.wav"), b"RIFF").unwrap();
        std::fs::write(
            dir.join("App.tsx"),
            "import { Sound, mount, View } from \"nsh\";\nimport tap from \"./sounds/tap.wav\";\nSound.load(tap);\nmount(() => <View />);\n",
        )
        .unwrap();
        let bundle = bundled(&dir);
        assert!(
            bundle.code.contains("\"asset:/sounds/tap.wav\""),
            "{}",
            bundle.code
        );
        assert_eq!(assets(&bundle), ["sounds/tap.wav"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The entry hands the runtime the app's information first, from
    /// `nsh.json`, a release build saying it is one, and the version and
    /// build a package gives in place of `nsh.json`'s.
    #[test]
    fn the_entry_hands_over_the_apps_information_first() {
        let dir = std::env::temp_dir().join(format!("nsh-app-info-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "name": "Notes", "id": "com.example.notes", "version": "1.2.0", "build": 4 }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("early.ts"),
            "import { appInfo } from \"nsh\";\nexport const early = appInfo();\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("App.tsx"),
            "import { mount, Text } from \"nsh\";\nimport { early } from \"./early\";\nmount(() => <Text>{early.version}</Text>);\n",
        )
        .unwrap();
        let info = |code: &str| {
            let at = code.find("setup(null, null, null, null, ").expect(code);
            let early = code.find("appInfo()").expect(code);
            assert!(at < early, "the information comes first: {code}");
            let json: String = serde_json::from_str(
                code[at + "setup(null, null, null, null, ".len()..]
                    .split(");")
                    .next()
                    .unwrap(),
            )
            .unwrap();
            serde_json::from_str::<serde_json::Value>(&json).unwrap()
        };
        let options = |development: bool| BundleOptions {
            entry: dir.join("App.tsx"),
            minify: !development,
            development,
            ..Default::default()
        };
        let development = info(&bundle(&options(true)).unwrap().code);
        assert_eq!(
            development,
            serde_json::json!({
                "id": "com.example.notes", "name": "Notes", "version": "1.2.0", "build": 4,
                "development": true,
            })
        );
        let mut release = options(false);
        // A nested entry still reads the app's root configuration.
        std::fs::create_dir_all(dir.join("screens")).unwrap();
        std::fs::write(
            dir.join("screens/Home.tsx"),
            "import { mount, Text } from \"nsh\";\nimport { early } from \"../early\";\nmount(() => <Text>{early.version}</Text>);\n",
        )
        .unwrap();
        let nested = BundleOptions {
            entry: dir.join("screens/Home.tsx"),
            ..options(true)
        };
        assert_eq!(info(&bundle(&nested).unwrap().code), development);
        release.app = crate::AppInfo {
            id: Some("com.acme.renamed".into()),
            version: Some("2.0.0".into()),
            build: Some(9),
            ..Default::default()
        };
        // Minified: the JSON as the minifier quotes it.
        let release = bundle(&release).unwrap().code.replace('\\', "");
        for part in [
            r#""id":"com.acme.renamed""#,
            r#""version":"2.0.0""#,
            r#""build":9"#,
            r#""development":false"#,
        ] {
            assert!(release.contains(part), "{part}: {release}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A video import is its `asset:/` URL, and the file ships.
    #[test]
    fn a_video_import_is_its_url_and_ships() {
        let dir = std::env::temp_dir().join(format!("nsh-video-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("media")).unwrap();
        std::fs::write(dir.join("media/intro.mp4"), b"mp4").unwrap();
        std::fs::write(
            dir.join("App.tsx"),
            "import { mount, Video } from \"nsh\";\nimport intro from \"./media/intro.mp4\";\nmount(() => <Video src={intro} />);\n",
        )
        .unwrap();
        let bundle = bundled(&dir);
        assert!(
            bundle.code.contains("\"asset:/media/intro.mp4\""),
            "{}",
            bundle.code
        );
        assert_eq!(assets(&bundle), ["media/intro.mp4"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A `?url` import is the file's `asset:/` URL, whatever its type, and
    /// the file ships; a JSON file so imported is not bundled.
    #[test]
    fn a_url_import_is_its_url_and_ships() {
        let dir = std::env::temp_dir().join(format!("nsh-url-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::create_dir_all(dir.join("screens")).unwrap();
        std::fs::write(dir.join("data/model.bin"), b"\0\x01").unwrap();
        std::fs::write(
            dir.join("data/cities.json"),
            b"{\"secret\":\"in-the-file\"}",
        )
        .unwrap();
        std::fs::write(
            dir.join("screens/Home.tsx"),
            "import model from \"../data/model.bin?url\";\nimport cities from \"../data/cities.json?url\";\nexport const urls = [model, cities];\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("App.tsx"),
            "import { mount, Text } from \"nsh\";\nimport { urls } from \"./screens/Home\";\nmount(() => <Text>{urls.join()}</Text>);\n",
        )
        .unwrap();
        let bundle = bundled(&dir);
        assert!(
            bundle.code.contains("\"asset:/data/model.bin\""),
            "{}",
            bundle.code
        );
        assert!(
            bundle.code.contains("\"asset:/data/cities.json\""),
            "{}",
            bundle.code
        );
        assert!(!bundle.code.contains("in-the-file"), "{}", bundle.code);
        assert_eq!(assets(&bundle), ["data/cities.json", "data/model.bin"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A `?url` import names a file that is there, by a relative path.
    #[test]
    fn a_url_import_needs_a_file() {
        let dir =
            std::env::temp_dir().join(format!("nsh-url-import-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("App.tsx"),
            "import { mount, Text } from \"nsh\";\nimport data from \"./data.bin?url\";\nmount(() => <Text>{data}</Text>);\n",
        )
        .unwrap();
        let error = try_bundle(&dir)
            .expect_err("a missing file fails")
            .to_string();
        assert!(error.contains("`./data.bin?url`: no such file"), "{error}");
        std::fs::write(
            dir.join("App.tsx"),
            "import { mount, Text } from \"nsh\";\nimport data from \"some-package/data.bin?url\";\nmount(() => <Text>{data}</Text>);\n",
        )
        .unwrap();
        let error = try_bundle(&dir).expect_err("a bare name fails").to_string();
        assert!(error.contains("by a relative path"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn variant_probe_ships_the_siblings_and_lists_their_scales() {
        let dir = app(
            "ships",
            "flag.png",
            &[
                ("flag.png", (40, 30)),
                ("flag@2x.png", (80, 60)),
                ("flag@3x.png", (120, 90)),
                ("other@2x.png", (2, 2)),
            ],
        );
        let bundle = bundled(&dir);
        let host = nsh_js::Host::new().unwrap();
        host.eval_source(&bundle.code).unwrap();
        assert!(host.eval_script("image", "JSON.stringify([globalThis.importedAsset.url, globalThis.importedAsset.size, globalThis.importedAsset.scales]) === JSON.stringify(['asset:/img/flag.png', { width: 40, height: 30 }, [1, 2, 3]])").unwrap());
        for asset in &bundle.assets {
            assert!(bundle.watch_files.contains(&bundle.asset_root.join(asset)));
        }
        assert_eq!(
            assets(&bundle),
            ["img/flag.png", "img/flag@2x.png", "img/flag@3x.png"]
        );
    }

    #[test]
    fn variant_probe_finds_every_scale_and_skips_gaps() {
        let dir = app(
            "every",
            "a.webp",
            &[
                ("a.webp", (10, 10)),
                ("a@1.5x.webp", (15, 15)),
                ("a@4x.webp", (40, 40)),
            ],
        );
        let variants: Vec<f32> = variants(&dir.join("img/a.webp"))
            .into_iter()
            .map(|(s, _)| s)
            .collect();
        assert_eq!(variants, [1.5, 4.0]);
        let bundle = bundled(&dir);
        assert!(bundle.code.contains("1.5"), "{}", bundle.code);
        assert_eq!(
            assets(&bundle),
            ["img/a.webp", "img/a@1.5x.webp", "img/a@4x.webp"]
        );
    }

    #[test]
    fn variant_probe_leaves_an_nx_import_as_it_was() {
        let dir = app(
            "suffixed",
            "flag@3x.png",
            &[
                ("flag.png", (40, 30)),
                ("flag@2x.png", (80, 60)),
                ("flag@3x.png", (120, 90)),
            ],
        );
        assert!(variants(&dir.join("img/flag@3x.png")).is_empty());
        assert!(variants(&dir.join("img/flag@1x.png")).is_empty());
        let bundle = bundled(&dir);
        assert!(!bundle.code.contains("scales"), "{}", bundle.code);
        assert!(bundle.code.contains("asset:/img/flag@3x.png"));
        assert_eq!(assets(&bundle), ["img/flag@3x.png"]);
    }

    /// An app without variants ships its image alone, in a module without
    /// `scales` (`variant_probe_lists_the_scales_in_the_image_module` holds
    /// the module's text).
    #[test]
    fn variant_probe_changes_nothing_without_variants() {
        let dir = app("none", "flag.png", &[("flag.png", (40, 30))]);
        let bundle = bundled(&dir);
        assert!(
            bundle.code.contains("asset:/img/flag.png"),
            "{}",
            bundle.code
        );
        assert!(!bundle.code.contains("scales"), "{}", bundle.code);
        assert_eq!(assets(&bundle), ["img/flag.png"]);
    }

    #[test]
    fn variant_probe_warns_when_a_variant_has_the_wrong_size() {
        let fits = |scale, pixels| variant_mismatch("img/a@2x.png", (40.0, 30.0), scale, pixels);
        assert_eq!(fits(2.0, (80, 60)), None);
        assert_eq!(fits(3.0, (120, 90)), None);
        let warning = fits(2.0, (120, 90)).expect("a warning");
        assert!(
            warning.starts_with("img/a@2x.png: 120x90 pixels, expected 80x60"),
            "{warning}"
        );
        // 1.5x of an odd size: either rounding fits.
        let odd = |pixels| variant_mismatch("b@1.5x.png", (41.0, 31.0), 1.5, pixels);
        assert_eq!(odd((61, 46)), None);
        assert_eq!(odd((62, 47)), None);
        assert!(odd((60, 46)).is_some());
        // The bundle still builds, with the variant.
        let dir = app(
            "mismatch",
            "a.png",
            &[("a.png", (40, 30)), ("a@2x.png", (120, 90))],
        );
        assert_eq!(assets(&bundled(&dir)), ["img/a.png", "img/a@2x.png"]);
    }

    /// A variant that is no image fails the build, as the imported file
    /// does, naming it.
    #[test]
    fn variant_probe_fails_on_an_unreadable_variant() {
        let dir = app("unreadable", "a.png", &[("a.png", (40, 30))]);
        std::fs::write(dir.join("img/a@3x.png"), b"not an image").unwrap();
        let Err(error) = try_bundle(&dir) else {
            panic!("the build fails");
        };
        let error = error.to_string();
        assert!(
            error.starts_with("img/a@3x.png\ncannot read image: "),
            "{error}"
        );
    }

    /// A pixel-density variant that links out of the app fails the build,
    /// as an import of the file it links to would: found beside the image,
    /// it is in the app by name only, and no package could ship it.
    #[cfg(unix)]
    #[test]
    fn a_variant_linking_out_of_the_app_is_refused() {
        let dir = app("link-out", "a.png", &[("a.png", (40, 30))]);
        let outside = dir.with_file_name(format!(
            "{}-a@2x.png",
            dir.file_name().unwrap().to_string_lossy()
        ));
        std::fs::write(&outside, png(80, 60)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("img/a@2x.png")).unwrap();
        for error in [
            try_bundle(&dir).unwrap_err().plain,
            crate::bundle_hot(&dir.join("App.tsx"), &[])
                .unwrap_err()
                .plain,
        ] {
            assert!(error.contains("`img/a@2x.png` links to "), "{error}");
            assert!(error.contains("is outside the app's directory"), "{error}");
        }
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An imported image that links out of the app fails the build too
    /// (the resolver hands over the file it links to).
    #[cfg(unix)]
    #[test]
    fn an_image_linking_out_of_the_app_is_refused() {
        let dir = app("image-out", "a.png", &[]);
        let outside = dir.with_file_name(format!(
            "{}-a.png",
            dir.file_name().unwrap().to_string_lossy()
        ));
        std::fs::write(&outside, png(40, 30)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("img/a.png")).unwrap();
        let error = try_bundle(&dir).unwrap_err().plain;
        assert!(error.contains("is outside the app's directory"), "{error}");
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A variant linking to a file elsewhere in the app ships under its
    /// image's name, which hosts derive the variant's URL from, not the
    /// name of the file it links to.
    #[cfg(unix)]
    #[test]
    fn a_variant_linking_inside_the_app_keeps_its_name() {
        let dir = app("link-in", "a.png", &[("a.png", (40, 30))]);
        std::fs::create_dir_all(dir.join("hires")).unwrap();
        std::fs::write(dir.join("hires/big.png"), png(80, 60)).unwrap();
        std::os::unix::fs::symlink("../hires/big.png", dir.join("img/a@2x.png")).unwrap();
        let built = bundled(&dir);
        assert_eq!(assets(&built), ["img/a.png", "img/a@2x.png"]);
        let hot = crate::bundle_hot(&dir.join("App.tsx"), &[]).unwrap();
        let hot_code = hot.script().0;
        for code in [&built.code, &hot_code] {
            let host = nsh_js::Host::new().unwrap();
            host.eval_source(code).unwrap();
            assert!(host.eval_script("image", "JSON.stringify([globalThis.importedAsset.url, globalThis.importedAsset.size, globalThis.importedAsset.scales]) === JSON.stringify(['asset:/img/a.png', { width: 40, height: 30 }, [1, 2]])").unwrap());
        }
        let names: Vec<String> = hot
            .assets
            .iter()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(names, ["img/a.png", "img/a@2x.png"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn svg_import_warns_about_what_browsers_alone_draw() {
        let warnings = |body| svg_asset("icons/a.svg", &svg(body)).unwrap().1;
        assert!(warnings(r#"<rect width="5" height="5"/>"#).is_empty());
        assert!(
            warnings("<text>NSH</text>").is_empty(),
            "text draws natively"
        );
        for animated in [
            r#"<rect width="5" height="5"><animate attributeName="x" to="5" dur="1s"/></rect>"#,
            r#"<rect width="5" height="5"><animateTransform attributeName="transform" type="rotate" to="90" dur="1s"/></rect>"#,
            r#"<path d="M0 0h5"><animateMotion path="M0 0h5" dur="1s"/></path>"#,
            r#"<set attributeName="fill" to="red"/>"#,
            "<style>@keyframes spin { to { transform: rotate(1turn) } }</style>",
            "<style>@-webkit-keyframes spin { to { opacity: 0 } }</style>",
            "<style><![CDATA[ rect { animation: spin 1s } ]]></style>",
            "<style>rect{fill:red;animation-name:spin}</style>",
            r#"<rect width="5" height="5" style="animation: spin 1s"/>"#,
            r#"<rect width="5" height="5" style="fill: red; -webkit-animation: spin 1s"/>"#,
        ] {
            let found = warnings(animated);
            assert_eq!(found.len(), 1, "{animated}");
            assert!(found[0].contains("animation"), "{animated}: {found:?}");
        }
        for still in [
            "<style>.no-animation { fill: red }</style>",
            "<style>.animation:hover { fill: red }</style>",
            "<style>/* animation: spin 1s */ rect { fill: red }</style>",
            r#"<rect class="animation" width="5" height="5" style="fill: red"/>"#,
            r#"<rect id="animate" width="5" height="5"/>"#,
            r#"<rect width="5" height="5" style="animation: none"/>"#,
        ] {
            assert!(warnings(still).is_empty(), "{still}");
        }
        let images = warnings(
            r#"<image href="logo.png" width="5" height="5"/><image href="data:image/svg%2Bxml,%3Csvg/%3E" width="5" height="5"/>"#,
        );
        assert_eq!(images.len(), 1);
        assert!(images[0].starts_with("icons/a.svg: "), "{images:?}");
        assert!(images[0].contains("<image>"), "{images:?}");
        for href in [
            "data:image/png;base64,AAAA",
            "data: IMAGE/PNG;base64,AAAA",
            "data:image/PNG,AAAA",
        ] {
            let body = format!(r#"<image href="{href}" width="5" height="5"/>"#);
            let found = svg_asset("icons/a.svg", &svg(&body)).unwrap().1;
            assert!(
                found.is_empty(),
                "inline raster images draw natively: {href}: {found:?}"
            );
        }
        let html = warnings(r#"<foreignObject width="5" height="5"><p>NSH</p></foreignObject>"#);
        assert_eq!(html.len(), 1);
        assert!(html[0].contains("<foreignObject>"), "{html:?}");
        assert_eq!(
            warnings("<text>a</text><set/><image/><foreignObject/>").len(),
            3
        );
    }

    #[test]
    fn svg_import_sizes_and_rejects() {
        let (size, _) = svg_asset("a.svg", &svg("")).unwrap();
        assert_eq!(size, Size::new(Points(10.0), Points(10.0)));
        let error = svg_asset("a.svg", b"<svg><rect").unwrap_err();
        assert!(error.to_string().starts_with("invalid SVG: "), "{error}");
        assert!(svg_asset("a.svg", b"\x89PNG\r\n\x1a\n").is_err());
    }

    /// An SVG is drawn for the screen at any ratio: its `@Nx` siblings
    /// neither ship nor appear in `scales`.
    #[test]
    fn svg_import_ships_no_variants() {
        let dir = app("svg", "mark.svg", &[]);
        for file in ["mark.svg", "mark@2x.svg", "mark@3x.svg"] {
            std::fs::write(dir.join("img").join(file), svg("")).unwrap();
        }
        let bundle = bundled(&dir);
        assert!(!bundle.code.contains("scales"), "{}", bundle.code);
        assert_eq!(assets(&bundle), ["img/mark.svg"]);
    }

    #[test]
    fn a_font_import_names_its_family_from_truetype_woff_and_woff2() {
        for data in [
            &include_bytes!("../../../tests/compat/cases/layout/fonts/Pacifico-Regular.ttf")[..],
            &include_bytes!("../../../tests/compat/cases/layout/fonts/Pacifico-Regular.woff")[..],
            &include_bytes!("../../../tests/compat/cases/layout/fonts/Pacifico-Regular.woff2")[..],
        ] {
            assert_eq!(font_family(data).as_deref(), Ok("Pacifico"));
        }
        assert!(has_extension(
            Path::new("fonts/Inter.WOFF2"),
            FONT_EXTENSIONS
        ));
    }
}
