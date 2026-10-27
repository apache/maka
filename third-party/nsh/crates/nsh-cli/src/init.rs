//! `nsh init` (a new app) and the TypeScript declarations editors read
//! (`.nsh/types`, refreshed by every command that builds an app).

use std::{fs, path::Path};

use anyhow::{Context as _, bail};

use crate::ui;

const APP: &str = r##"import { mount, signal, Text, View } from "nsh";

function App() {
  const count = signal(0);
  return (
    <View class="flex-1 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] items-center justify-center gap-4 bg-background">
      <Text class="text-3xl font-semibold text-foreground">{count()}</Text>
      <View
        onPress={() => count.update((c) => c + 1)}
        role="button"
        class="rounded-(--radius) bg-primary px-5 py-3 active:bg-primary/90"
      >
        <Text class="text-lg text-primary-foreground">Tap</Text>
      </View>
    </View>
  );
}

mount(App);
"##;

/// The test of [`APP`] (`nsh test`).
const APP_TEST: &str = r##"import { expect, open, test } from "nsh/test";

test("counts taps", async () => {
  const app = await open("./App.tsx");
  expect(app.texts()).toContain("0");
  await app.press("Tap");
  await app.press("Tap");
  expect(app.texts()).toContain("2");
});
"##;

/// NSH-generated files stay in `.nsh`; Cargo keeps its standard `target`.
const GITIGNORE: &str = ".nsh/\ntarget/\n";

/// What `nsh init` makes ([`init`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum Template {
    /// A TSX app: `App.tsx`, on QuickJS.
    Ts,
    /// An app written in Rust: a Cargo project whose root component
    /// `nsh.json` names (`"root"`), with no QuickJS.
    Rust,
    /// A TSX app with a Rust crate of its own at its root (`Cargo.toml` and
    /// `src/lib.rs` beside `App.tsx`), which exports a component, a module
    /// and a class to it.
    Mixed,
}

impl Template {
    /// The template the user picks on a terminal ([`ui::choose`]);
    /// [`Template::Ts`] when nobody can be asked.
    pub(crate) fn ask() -> anyhow::Result<Template> {
        if !ui::interactive() {
            return Ok(Template::Ts);
        }
        let picked = ui::choose(
            "What is the app written in?",
            &[
                ("ts", "TSX, on QuickJS"),
                ("rust", "Rust, with no JS runtime"),
                ("mixed", "TSX, with a Rust crate of its own"),
            ],
        )?;
        Ok([Template::Ts, Template::Rust, Template::Mixed][picked])
    }
}

/// Creates an app in `dir` from `template`:
///
/// - [`Template::Ts`]: `App.tsx` (the entry by convention), its test
///   `App.test.tsx` (`nsh test`), `nsh.json`, `tsconfig.json`, `.gitignore`
///   and the type declarations; existing files are kept.
/// - [`Template::Rust`]: a Cargo project (`Cargo.toml`, `src/lib.rs` with
///   the root component, `src/main.rs` for `cargo run`), `nsh.json`
///   naming the root, the root's test `App.test.tsx` with `tsconfig.json`
///   and the type declarations, `.gitignore` and a README.
/// - [`Template::Mixed`]: the TSX app with a crate beside its `App.tsx`
///   (`Cargo.toml`, `src/lib.rs`; `nsh.json` `"rust": "."`, no `"root"`)
///   that `App.tsx` imports, its test `App.test.tsx`, and a README.
///
/// The crates depend on nsh's crates on crates.io at this CLI's version,
/// or by path on the nsh checkout `nsh_source`: where the app's hosts take
/// nsh from too (`rust_app::Nsh::of`). A Rust or mixed app is made in a
/// directory without one: any of its files existing is a conflict.
pub(crate) fn init(
    dir: &Path,
    name: Option<String>,
    template: Template,
    nsh_source: Option<&Path>,
) -> anyhow::Result<()> {
    if template == Template::Ts && nsh_source.is_some() {
        bail!("--nsh-source is for the apps with Rust crates: --template rust or mixed");
    }
    let nsh_source = nsh_source
        .map(|source| {
            let source = dunce::canonicalize(source)
                .with_context(|| format!("--nsh-source: no {}", source.display()))?;
            if !source.join("crates/nsh-core/Cargo.toml").is_file() {
                bail!("--nsh-source: {} is not an nsh checkout", source.display());
            }
            Ok(source)
        })
        .transpose()?;
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let run = if dir == Path::new(".") {
        "nsh run".to_owned()
    } else {
        format!("nsh run {}", dir.display())
    };
    let dir = dunce::canonicalize(dir)?;
    let name = name.unwrap_or_else(|| {
        dir.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("app")
            .to_owned()
    });
    let id_part: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    let mut config = serde_json::json!({
        "name": name,
        "id": format!("com.example.{}", if id_part.is_empty() { "app" } else { &id_part }),
        "version": "1.0.0",
        "build": 1,
    });
    let slug = slug(&name);
    let specifier = format!("{slug}/native");
    let fill = |text: &str| {
        text.replace("__SPECIFIER__", &specifier)
            .replace("__APP_NAME__", &name)
    };
    let mut files = vec![(".gitignore", GITIGNORE.to_owned())];
    match template {
        Template::Ts => files.extend([
            ("App.tsx", APP.to_owned()),
            ("App.test.tsx", APP_TEST.to_owned()),
            ("tsconfig.json", nsh_bundler::TSCONFIG.to_owned()),
        ]),
        Template::Rust => {
            config["rust"] = ".".into();
            // `nsh run` / `nsh package` mount this root, with no JS runtime.
            config["root"] = "App".into();
            files.extend(rust_files(
                &name,
                config["id"].as_str().unwrap(),
                nsh_source.as_deref(),
            ));
            files.extend([
                ("src/lib.rs", fill(include_str!("templates/rust/lib.rs"))),
                (
                    "App.test.tsx",
                    include_str!("templates/rust/App.test.tsx").to_owned(),
                ),
                ("tsconfig.json", nsh_bundler::TSCONFIG.to_owned()),
                ("README.md", fill(include_str!("templates/rust/README.md"))),
            ]);
        }
        Template::Mixed => {
            // The crate is the app's directory, as a Rust app's; with no
            // `"root"`, `App.tsx` stays the entry.
            config["rust"] = ".".into();
            files.extend([
                ("App.tsx", fill(include_str!("templates/mixed/App.tsx"))),
                (
                    "App.test.tsx",
                    include_str!("templates/mixed/App.test.tsx").to_owned(),
                ),
                ("tsconfig.json", nsh_bundler::TSCONFIG.to_owned()),
                (
                    "Cargo.toml",
                    manifest(&rust_package_name(&name), nsh_source.as_deref(), false),
                ),
                ("src/lib.rs", fill(include_str!("templates/mixed/lib.rs"))),
                ("README.md", fill(include_str!("templates/mixed/README.md"))),
            ]);
        }
    }
    files.push((
        "nsh.json",
        format!("{}\n", serde_json::to_string_pretty(&config)?),
    ));
    if template != Template::Ts {
        // `.gitignore` aside, a Rust app's files all come together.
        for (file, _) in &files[1..] {
            if dir.join(file).exists() {
                bail!(
                    "{} already exists; create the app in a new directory",
                    ui::path(&dir.join(file))
                );
            }
        }
    }
    if files.iter().all(|(f, _)| dir.join(f).exists()) {
        bail!("{} already has an app", ui::path(&dir));
    }
    let (mut created, mut kept) = (Vec::new(), Vec::new());
    for (file, contents) in files {
        let path = dir.join(file);
        if path.exists() {
            kept.push(file);
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, contents).with_context(|| format!("write {}", path.display()))?;
        created.push(file);
    }
    // Every template has TypeScript: an entry, or a Rust root's test.
    write_types(&dir);
    let kept = if kept.is_empty() {
        String::new()
    } else {
        format!(" {}", ui::dim(format!("(kept {})", kept.join(", "))))
    };
    ui::done(format!(
        "created {}: {}{kept}",
        ui::path(&dir),
        created.join(", ")
    ));
    ui::note(format!("run it with `{run}`"));
    if template == Template::Rust {
        ui::note(format!(
            "or on this machine's desktop with `cargo run --manifest-path {}`",
            ui::path(&dir.join("Cargo.toml"))
        ));
    }
    Ok(())
}

/// The Rust app's Cargo project: its manifest and `src/main.rs`, which runs
/// the root on the desktop backends (`cargo run`).
fn rust_files(name: &str, id: &str, source: Option<&Path>) -> Vec<(&'static str, String)> {
    let package = rust_package_name(name);
    let main = include_str!("templates/rust/main.rs")
        .replace("__APP_CRATE__", &package.replace('-', "_"))
        .replace("__APP_TITLE__", &format!("{name:?}"))
        .replace("__APP_ID__", &format!("{id:?}"));
    vec![
        ("Cargo.toml", manifest(&package, source, true)),
        ("src/main.rs", main),
    ]
}

/// A crate's manifest: nsh's crates on crates.io at this CLI's version (or
/// by path in the checkout `source`). With `desktop`, the platforms' crates
/// for `src/main.rs`, with features chosen so `cargo run` runs the Rust root
/// without linking QuickJS. Its own workspace, so an app inside another
/// project builds on its own.
fn manifest(package: &str, source: Option<&Path>, desktop: bool) -> String {
    let version = env!("CARGO_PKG_VERSION");
    let dep = |name: &str, extra: &str| match source {
        Some(source) => format!(
            "{{ path = {:?}{extra} }}",
            source.join("crates").join(name).to_string_lossy()
        ),
        None if extra.is_empty() => format!("{version:?}"),
        None => format!("{{ version = {version:?}{extra} }}"),
    };
    let core = dep("nsh-core", "");
    let base = dep("nsh-base", "");
    let mut manifest = format!(
        r#"[package]
name = {package:?}
version = "0.1.0"
edition = "2024"
publish = false

[workspace]

[dependencies]
nsh-core = {core}
nsh-base = {base}
"#
    );
    if desktop {
        manifest.push_str("env_logger = \"0.11\"\n");
        for platform in ["linux", "macos", "windows"] {
            manifest.push_str(&format!(
                r#"
[target.'cfg(target_os = {platform:?})'.dependencies]
nsh-platform-{platform} = {}
"#,
                dep(
                    &format!("nsh-platform-{platform}"),
                    ", default-features = false"
                )
            ));
        }
    }
    manifest
}

/// The app's name as a lower-case slug (`My App` → `my-app`): its crates'
/// names and its import specifier (`my-app/native`).
fn slug(name: &str) -> String {
    let slug = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "app".to_owned()
    } else {
        slug
    }
}

/// A valid, non-reserved Cargo name, even for display names containing
/// whitespace, punctuation, Unicode or a leading digit.
fn rust_package_name(name: &str) -> String {
    format!("nsh-app-{}", slug(name))
}

/// The `tsconfig.json` files earlier versions of `nsh init` wrote, oldest
/// first: an app's that is one of them, unchanged, is nsh's to replace
/// ([`migrate_tsconfig`]).
const PREVIOUS_TSCONFIGS: &[&str] = &[
    include_str!("templates/tsconfig/1.json"),
    include_str!("templates/tsconfig/2.json"),
    include_str!("templates/tsconfig/3.json"),
    include_str!("templates/tsconfig/4.json"),
    include_str!("templates/tsconfig/5.json"),
];

/// What the app's `tsconfig.json` extends: nsh's settings
/// ([`nsh_bundler::TSCONFIG_BASE`]).
const TSCONFIG_BASE: &str = ".nsh/tsconfig.json";

/// Writes `.nsh/types` and `.nsh/tsconfig.json` in the app directory `dir`
/// (files whose contents did not change are left alone, so editors do not
/// reload them). Files nsh no longer generates (a module that moved) are
/// removed. An app's `tsconfig.json` from an earlier `nsh init`, unchanged,
/// becomes one extending `.nsh/tsconfig.json` ([`migrate_tsconfig`]).
pub(crate) fn write_types(dir: &Path) {
    let types = dir.join(".nsh/types");
    // The app's sets, and `nsh/test` for its test files.
    let mut sets = crate::ui_sets().to_vec();
    sets.push(nsh_core::element::description::SetDescription::from(
        &nsh_testing::registry(),
    ));
    let mut definitions = nsh_js::type_definitions(&sets);
    definitions.extend(nsh_bundler::type_definitions());
    // The theme's errors are the build's to report: its names are the
    // default's meanwhile.
    let tokens =
        nsh_bundler::theme_tokens(dir).unwrap_or_else(|_| nsh_base::Theme::default().into_tokens());
    definitions.push((
        "nsh/tokens.d.ts".to_owned(),
        nsh_bundler::tokens_declaration(&tokens),
    ));
    remove_stale(&types, &types, &definitions);
    let files = definitions
        .iter()
        .map(|(path, contents)| (types.join(path), contents.as_str()))
        .chain([(dir.join(TSCONFIG_BASE), nsh_bundler::TSCONFIG_BASE)]);
    for (path, contents) in files {
        if fs::read(&path).is_ok_and(|old| old == contents.as_bytes()) {
            continue;
        }
        let written = path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| fs::write(&path, contents));
        if let Err(err) = written {
            ui::warn(format!("cannot write {}: {err}", ui::path(&path)));
            return;
        }
    }
    migrate_tsconfig(dir);
    warn_undocumented(&crate::ui_sets());
}

/// Warns of the exports of `sets` (an app's crates') without a doc comment:
/// TSX sees them undocumented in the declarations and the editor.
fn warn_undocumented(sets: &[nsh_core::element::description::SetDescription]) {
    for set in sets {
        let missing = &set.undocumented;
        if missing.is_empty() {
            continue;
        }
        ui::warn(format!(
            "{} exports {} without a doc comment, which TSX sees in its declarations: {}",
            set.specifier,
            if missing.len() == 1 {
                "one item"
            } else {
                "items"
            },
            missing.join(", ")
        ));
    }
}

/// Replaces the app's `tsconfig.json` with [`nsh_bundler::TSCONFIG`] when
/// it is one an earlier `nsh init` wrote ([`PREVIOUS_TSCONFIGS`]) and the
/// app never changed, saying so: its settings are all nsh's, now kept in
/// `.nsh/tsconfig.json`. One the app changed is left as it is
/// (`nsh check` says what to change: [`tsconfig_extends_nsh`]).
fn migrate_tsconfig(dir: &Path) {
    let path = dir.join("tsconfig.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let text = text.replace("\r\n", "\n");
    if !PREVIOUS_TSCONFIGS.contains(&text.as_str()) {
        return;
    }
    match fs::write(&path, nsh_bundler::TSCONFIG) {
        Ok(()) => ui::note(format!(
            "updated {}, nsh's unchanged template, to extend {TSCONFIG_BASE}, where nsh keeps \
             its TypeScript settings current",
            ui::path(&path)
        )),
        Err(err) => ui::warn(format!("cannot update {}: {err}", ui::path(&path))),
    }
}

/// Whether the app's `tsconfig.json` in `dir` extends `.nsh/tsconfig.json`
/// (or names it otherwise: a list of `extends`). Without it, nsh's
/// settings reach the app only as they were when its `tsconfig.json` was
/// written.
pub(crate) fn tsconfig_extends_nsh(dir: &Path) -> bool {
    fs::read_to_string(dir.join("tsconfig.json")).is_ok_and(|text| text.contains(TSCONFIG_BASE))
}

/// Removes the files under `dir` (inside `types`) that are not among
/// `definitions`, and directories left empty.
fn remove_stale(types: &Path, dir: &Path, definitions: &[(String, String)]) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            remove_stale(types, &path, definitions);
            let _ = fs::remove_dir(&path);
        } else if let Ok(relative) = path.strip_prefix(types) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            if !definitions.iter().any(|(p, _)| *p == relative) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// [`write_types`] for the app whose entry is `entry`.
pub(crate) fn write_types_for(entry: &Path) {
    if let Some(dir) = dunce::canonicalize(entry)
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
    {
        write_types(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nsh-init-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn read(dir: &Path, file: &str) -> String {
        fs::read_to_string(dir.join(file)).unwrap_or_else(|e| panic!("{file}: {e}"))
    }

    fn config(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&read(dir, "nsh.json")).unwrap()
    }

    #[test]
    fn a_ts_app_is_a_tsx_entry_with_its_declarations() {
        let dir = directory("ts");
        init(&dir, Some("My App".into()), Template::Ts, None).unwrap();
        assert!(read(&dir, "App.tsx").contains("mount(App)"));
        assert!(read(&dir, "App.test.tsx").contains("from \"nsh/test\""));
        assert_eq!(read(&dir, "tsconfig.json"), nsh_bundler::TSCONFIG);
        assert_eq!(read(&dir, ".gitignore"), GITIGNORE);
        assert!(dir.join(".nsh/types/nsh/index.d.ts").is_file());
        // Its test file's module is declared.
        assert!(dir.join(".nsh/types/nsh/test.d.ts").is_file());
        let config = config(&dir);
        assert_eq!(config["name"], "My App");
        assert!(config.get("rust").is_none() && config.get("root").is_none());
        for file in ["Cargo.toml", "src", "native", "README.md"] {
            assert!(!dir.join(file).exists(), "{file}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_ts_apps_tsconfig_extends_the_settings_nsh_keeps_current() {
        let dir = directory("tsconfig");
        init(&dir, None, Template::Ts, None).unwrap();
        assert!(tsconfig_extends_nsh(&dir));
        let base = read(&dir, ".nsh/tsconfig.json");
        assert_eq!(base, nsh_bundler::TSCONFIG_BASE);
        assert!(
            base.contains("\"ESNext.Disposable\""),
            "`using` type-checks"
        );
        assert!(base.contains("./types/nsh/globals.d.ts"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unchanged_tsconfig_of_an_earlier_init_is_migrated() {
        for (i, old) in PREVIOUS_TSCONFIGS.iter().enumerate() {
            let dir = directory("migrate");
            // As a Windows checkout might have it.
            fs::write(dir.join("tsconfig.json"), old.replace('\n', "\r\n")).unwrap();
            write_types(&dir);
            assert_eq!(
                read(&dir, "tsconfig.json"),
                nsh_bundler::TSCONFIG,
                "template {i}"
            );
            assert!(tsconfig_extends_nsh(&dir));
            fs::remove_dir_all(dir).unwrap();
        }
        // Without `ESNext.Disposable`: the template of #146's time lacked it.
        assert!(!PREVIOUS_TSCONFIGS[3].contains("ESNext.Disposable"));
    }

    #[test]
    fn a_tsconfig_the_app_changed_is_kept_and_flagged() {
        let dir = directory("changed");
        let changed = PREVIOUS_TSCONFIGS[4].replace("\"strict\": true", "\"strict\": false");
        fs::write(dir.join("tsconfig.json"), &changed).unwrap();
        write_types(&dir);
        assert_eq!(read(&dir, "tsconfig.json"), changed);
        assert!(!tsconfig_extends_nsh(&dir));
        assert!(dir.join(".nsh/tsconfig.json").is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_ts_app_keeps_existing_files() {
        let dir = directory("tsx");
        fs::write(dir.join("App.tsx"), "user entry").unwrap();
        init(&dir, None, Template::Ts, None).unwrap();
        assert!(!dir.join("Cargo.toml").exists());
        assert_eq!(read(&dir, "App.tsx"), "user entry");
        assert!(
            init(&dir, None, Template::Ts, None).is_err(),
            "it has an app"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_rust_app_is_a_cargo_project_naming_its_root() {
        let dir = directory("rust");
        init(&dir, Some("123 My App".into()), Template::Rust, None).unwrap();
        let config = config(&dir);
        assert_eq!(read(&dir, ".gitignore"), GITIGNORE);
        assert!(!dir.join(".cargo/config.toml").exists());
        assert_eq!(config["rust"], ".");
        assert_eq!(config["root"], "App");
        assert_eq!(config["name"], "123 My App");
        assert!(read(&dir, "Cargo.toml").contains("name = \"nsh-app-123-my-app\""));
        assert!(read(&dir, "src/main.rs").contains("nsh_app_123_my_app::App"));
        let lib = read(&dir, "src/lib.rs");
        assert!(
            lib.contains("#[native_module(\"123-my-app/native\")]"),
            "{lib}"
        );
        assert!(lib.contains("pub fn App()"), "{lib}");
        let readme = read(&dir, "README.md");
        assert!(readme.starts_with("# 123 My App\n"), "{readme}");
        assert!(
            readme.contains("import { App } from \"123-my-app/native\";"),
            "{readme}"
        );
        assert_eq!(read(&dir, ".gitignore"), GITIGNORE);
        // No TSX entry: the root is the app; its test is TypeScript, with
        // the declarations of `nsh/test`.
        assert!(!dir.join("App.tsx").exists());
        assert!(read(&dir, "App.test.tsx").contains("open(\".\")"));
        assert_eq!(read(&dir, "tsconfig.json"), nsh_bundler::TSCONFIG);
        assert!(dir.join(".nsh/types/nsh/test.d.ts").is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_mixed_app_is_a_tsx_entry_with_a_crate() {
        let dir = directory("mixed");
        init(&dir, Some("My App".into()), Template::Mixed, None).unwrap();
        let config = config(&dir);
        // The crate is the app's directory; `App.tsx` stays the entry.
        assert_eq!(config["rust"], ".");
        assert!(config.get("root").is_none());
        assert_eq!(crate::entry::resolve(&dir).unwrap(), dir.join("App.tsx"));
        let app = read(&dir, "App.tsx");
        assert!(
            app.contains("import { Badge, Counter, Format } from \"my-app/native\";"),
            "{app}"
        );
        assert!(
            app.contains("<Badge")
                && app.contains("new Counter()")
                && app.contains("Format.times(")
        );
        let lib = read(&dir, "src/lib.rs");
        assert!(lib.contains("#[native_module(\"my-app/native\")]"), "{lib}");
        for export in ["#[component]", "#[module]", "#[class]"] {
            assert!(lib.contains(export), "{export}");
        }
        let manifest = read(&dir, "Cargo.toml");
        assert!(manifest.contains("name = \"nsh-app-my-app\""), "{manifest}");
        // No `src/main.rs`: the app runs its TSX entry.
        assert!(!manifest.contains("nsh-platform"), "{manifest}");
        assert_eq!(read(&dir, "tsconfig.json"), nsh_bundler::TSCONFIG);
        assert!(read(&dir, "App.test.tsx").contains("open(\"./App.tsx\")"));
        assert!(read(&dir, "README.md").contains("my-app/native"));
        assert_eq!(read(&dir, ".gitignore"), GITIGNORE);
        assert!(dir.join(".nsh/types/nsh/index.d.ts").is_file());
        for file in ["native", "src/main.rs"] {
            assert!(!dir.join(file).exists(), "{file}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rust_and_mixed_apps_refuse_conflicts_before_writing() {
        for (template, file) in [
            (Template::Rust, "Cargo.toml"),
            (Template::Rust, "src/lib.rs"),
            (Template::Mixed, "Cargo.toml"),
            (Template::Mixed, "src/lib.rs"),
            (Template::Mixed, "App.tsx"),
        ] {
            let dir = directory("conflict");
            fs::create_dir_all(dir.join(file).parent().unwrap()).unwrap();
            fs::write(dir.join(file), "user code").unwrap();
            let error = init(&dir, None, template, None).unwrap_err().to_string();
            assert!(error.contains("already exists"), "{error}");
            assert_eq!(read(&dir, file), "user code");
            assert!(!dir.join("nsh.json").exists());
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn crates_take_nsh_from_crates_io_or_a_checkout() {
        let version = env!("CARGO_PKG_VERSION");
        let published = manifest("app", None, true);
        assert!(
            published.contains(&format!("nsh-core = {version:?}")),
            "{published}"
        );
        assert!(published.contains(&format!(
            "nsh-platform-macos = {{ version = {version:?}, default-features = false }}"
        )));
        let checkout =
            dunce::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        let core = checkout.join("crates").join("nsh-core");
        for desktop in [true, false] {
            let local = manifest("app", Some(&checkout), desktop);
            assert!(
                local.contains(&format!(
                    "nsh-core = {{ path = {:?} }}",
                    core.to_string_lossy()
                )),
                "{local}"
            );
            assert_eq!(
                local.contains("default-features = false }"),
                desktop,
                "{local}"
            );
            assert!(!local.contains(&format!("{version:?}")), "{local}");
        }
        // Only a checkout, and only for apps with crates.
        let dir = directory("not-a-checkout");
        let error = init(&dir.join("app"), None, Template::Mixed, Some(&dir))
            .unwrap_err()
            .to_string();
        assert!(error.contains("not an nsh checkout"), "{error}");
        assert!(!dir.join("app").exists());
        let error = init(&dir.join("app"), None, Template::Ts, Some(&checkout))
            .unwrap_err()
            .to_string();
        assert!(error.contains("--template rust or mixed"), "{error}");
        assert!(!dir.join("app").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn display_names_produce_valid_cargo_names_and_escaped_rust_literals() {
        assert_eq!(rust_package_name("你好"), "nsh-app-app");
        assert_eq!(rust_package_name("123 APP / demo"), "nsh-app-123-app-demo");
        assert_eq!(slug("你好"), "app");
        let files = rust_files("a\"b\nc", "com.example.abc", None);
        let main = &files
            .iter()
            .find(|(name, _)| *name == "src/main.rs")
            .unwrap()
            .1;
        assert!(main.contains(r#"title: "a\"b\nc".to_owned()"#));
    }
}
