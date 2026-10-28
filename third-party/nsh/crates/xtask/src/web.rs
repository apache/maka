//! The web runtime and the website's demos: `nsh.wasm` (`nsh-platform-web`)
//! plus its JS runtime and player page, each demo of `website/demos/*.tsx`
//! compiled by `nsh build`, and the gallery (`examples/gallery`) published
//! with `nsh package --target web`, the website's showcase.
//!
//! ```text
//! <out>/index.html    the player: runs demos/<name>.nshc for `#<name>`
//! <out>/nsh-playground.wasm   the engine plus the TSX compiler (the playground)
//! <out>/demos/<name>.nshc     a demo compiled to bytecode
//! <out>/gallery/      the gallery as `nsh package --target web` writes it,
//!                     with its browser-host runtime:
//! <out>/gallery/nsh.<digest>.js     the DOM runtime (minified)
//! <out>/gallery/nsh.<digest>.wasm   the engine and core (no QuickJS)
//! ```
//!
//! The embedded demo player retains the bytecode-only QuickJS runtime.
//! The standalone gallery uses browser JavaScript and a separate Wasm.
//! `astro dev` serves the embedded player from its sources instead.

use std::{fs, path::Path};

use anyhow::Context as _;

use crate::{
    android,
    dist::{cargo, copy},
    term::{self, run},
};

const WASM: &str = "wasm32-unknown-unknown";

pub(crate) fn build(out: &Path) -> anyhow::Result<()> {
    let root = android::root();
    // Relative to the workspace, wherever `cargo xtask` runs from.
    let out = root.join(out);
    // The playground retains its compiler and QuickJS host.
    // Its own target directory: switching the feature would rebuild the
    // other one every time.
    cargo(
        &[
            "build",
            "--profile",
            "web",
            "-p",
            "nsh-platform-web",
            "--features",
            "compiler",
            "--target",
            WASM,
            "--target-dir",
            "target/web-playground",
        ],
        "nsh-playground.wasm",
    )?;
    cargo(&["build", "--release", "-p", "nsh-cli"], "nsh")?;
    fs::create_dir_all(out.join("demos"))?;
    copy(
        &root
            .join("target/web-playground")
            .join(WASM)
            .join("web/nsh_platform_web.wasm"),
        &out.join("nsh-playground.wasm"),
    )?;
    let web = root.join("crates/nsh-platform-web/web");
    // Embedded demos still load bytecode with the existing player API.
    // Do not substitute the standalone gallery's browser host here.
    cargo(
        &[
            "build",
            "--profile",
            "web",
            "-p",
            "nsh-platform-web",
            "--features",
            "bytecode-only",
            "--target",
            WASM,
        ],
        "the embedded web runtime",
    )?;
    let embedded = root.join("target").join(WASM).join("web");
    copy(
        &embedded.join("nsh_platform_web.wasm"),
        &embedded.join("nsh.wasm"),
    )?;
    copy(&embedded.join("nsh.wasm"), &out.join("nsh.wasm"))?;
    copy(&web.join("nsh.js"), &out.join("nsh.js"))?;

    let nsh = root.join(format!(
        "target/release/nsh{}",
        std::env::consts::EXE_SUFFIX
    ));
    let demos = root.join("website/demos");
    let tmp = root.join("target/web-demos");
    let step = term::Step::start("bundling the website's demos");
    let mut demos_built = 0;
    for entry in fs::read_dir(&demos).context("website/demos")? {
        let path = entry?.path();
        if path.extension().is_none_or(|e| e != "tsx") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .context("demo name")?
            .to_owned();
        let dir = tmp.join(&name);
        run(std::process::Command::new(&nsh)
            .args(["build", "--release", "-o"])
            .arg(&dir)
            .arg(&path))
        .with_context(|| format!("bundling {name}"))?;
        copy(
            &dir.join("bundle.nshc"),
            &out.join("demos").join(format!("{name}.nshc")),
        )?;
        let _ = fs::remove_file(out.join("demos").join(format!("{name}.js")));
        demos_built += 1;
    }
    if demos.join("assets").is_dir() {
        for entry in fs::read_dir(demos.join("assets"))? {
            let path = entry?.path();
            if path.is_file() {
                copy(
                    &path,
                    &out.join("assets").join(path.file_name().context("name")?),
                )?;
            }
        }
    }
    step.done(format!("bundled {demos_built} demos"));

    // The gallery, as apps are published: its own page and content-addressed
    // files, all relative, so it works under any base path of the site.
    let step = term::Step::start("packaging the gallery for the web");
    let packaged = tmp.join("gallery");
    if packaged.exists() {
        fs::remove_dir_all(&packaged)?;
    }
    run(std::process::Command::new(&nsh)
        .args(["package", "--target", "web", "-o"])
        .arg(&packaged)
        .arg(root.join("examples/gallery")))
    .context("packaging the gallery")?;
    let gallery = out.join("gallery");
    if gallery.exists() {
        fs::remove_dir_all(&gallery)?;
    }
    // `<packaged>/<the app's name>/`, the one directory there.
    let site = fs::read_dir(&packaged)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_dir())
        .context("nsh package wrote no site")?;
    fs::rename(&site, &gallery).or_else(|_| copy_dir(&site, &gallery))?;
    step.done("packaged the gallery");

    copy(&web.join("index.html"), &out.join("index.html"))?;
    // The embedded player and playground share the gallery's syntax data.
    let syntaxes = fs::read_dir(&gallery)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("nsh-syntaxes."))
        })
        .context("the gallery has no syntax data")?;
    copy(&syntaxes, &out.join("nsh-syntaxes.bin"))?;
    term::note(out.strip_prefix(&root).unwrap_or(&out).display());
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> anyhow::Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            copy(&entry.path(), &dest)?;
        }
    }
    Ok(())
}
