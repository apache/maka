//! An app's own Windows runner linked from the prebuilt runner's objects
//! (#1644), with no Rust or Visual Studio on the machine: the parts of
//! `nsh/base` the app does not import are left out of the executable.
//!
//! The release runner reaches each part but the core only through its
//! gate, `nsh_part_<name>`, which its build resolves to the part
//! (`-alternatename:nsh_part_<name>=nsh_have_<name>`, see
//! `crates/nsh-windows-app/build.rs`). Next to the runner, its link kit
//! `nsh-windows-app.link/` holds what linking it took: `link.rsp`, the
//! linker's arguments with `${KIT}` for the kit's own directory, and the
//! objects and libraries they name, rustc's metadata taken out. Linking
//! again with the gates of the parts nothing imports resolved to
//! `nsh_part_none` makes the linker drop those parts' code. The kit's
//! linker, `bin/ld.lld.exe`, is a component of the distribution
//! (`windows-linker`), added the first time an app is packaged.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::Context as _;

/// The arguments' file of a link kit.
const ARGS: &str = "link.rsp";

/// The link kit of `runner`, when it has one.
pub(crate) fn kit_for(runner: &Path) -> Option<PathBuf> {
    let stem = runner.file_stem()?;
    let kit = runner.with_file_name(format!("{}.link", stem.to_string_lossy()));
    kit.join(ARGS).is_file().then_some(kit)
}

/// Links `kit`'s runner to `out` with the parts whose gates are in `gates`
/// ([`crate::web::linked_gates`]) and none of the others.
pub(crate) fn link(kit: &Path, gates: &[String], out: &Path) -> anyhow::Result<Vec<String>> {
    let template = fs::read_to_string(kit.join(ARGS))
        .with_context(|| format!("read {}", kit.join(ARGS).display()))?;
    let (args, left_out) = args(&template, &slashes(kit), gates, &slashes(out));
    let rsp = out.with_extension("rsp");
    fs::write(
        &rsp,
        args.iter().map(|a| quote(a)).collect::<Vec<_>>().join("\n"),
    )?;
    let lld = linker(kit)?;
    let output = Command::new(&lld)
        .args(["-flavor", "gnu"])
        .arg(format!("@{}", rsp.display()))
        .output()
        .with_context(|| format!("run {}", lld.display()))?;
    let _ = fs::remove_file(&rsp);
    anyhow::ensure!(
        output.status.success(),
        "linking the runner failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(left_out)
}

/// The linker's arguments from `template` (one per line), for the kit in
/// `kit` and the executable `out`; and the parts left out, those whose
/// gate is not in `gates`.
fn args(template: &str, kit: &str, gates: &[String], out: &str) -> (Vec<String>, Vec<String>) {
    let mut left_out = Vec::new();
    let mut args: Vec<String> = template
        .lines()
        .map(|line| unquote(line.trim()))
        .filter(|line| !line.is_empty())
        .map(|line| {
            let line = line.replace("${KIT}", kit);
            match part_of_gate(&line) {
                Some(part) if !gates.iter().any(|g| *g == format!("nsh_part_{part}")) => {
                    let to = line.replace(&format!("=nsh_have_{part}"), "=nsh_part_none");
                    left_out.push(part.to_owned());
                    to
                }
                _ => line,
            }
        })
        .collect();
    args.extend(["-o".to_owned(), out.to_owned()]);
    (args, left_out)
}

/// The part whose gate the argument resolves (`...alternatename:
/// nsh_part_<part>=nsh_have_<part>`).
fn part_of_gate(arg: &str) -> Option<&str> {
    let (_, alias) = arg.split_once("alternatename:nsh_part_")?;
    let (part, have) = alias.split_once('=')?;
    (have == format!("nsh_have_{part}")).then_some(part)
}

/// Adds the kit's linker, the component `windows-linker`, when `kit` is
/// an installed distribution's and has no linker yet: the linker
/// (`rust-lld`) comes with the first app packaged, not with nsh.
pub(crate) fn ensure_linker(kit: &Path) -> anyhow::Result<()> {
    let own = own_linker(kit);
    if own.is_file() || std::env::var_os("NSH_LLD").is_some() {
        return Ok(());
    }
    match crate::component::distribution() {
        Some(root) if kit.starts_with(root.join("runtime")) => {
            crate::component::ensure(&root, "windows-linker", &own)
        }
        _ => Ok(()),
    }
}

fn own_linker(kit: &Path) -> PathBuf {
    kit.join("bin").join("ld.lld.exe")
}

/// The linker: the kit's own, else `NSH_LLD`, else the `rust-lld` of a
/// Rust toolchain.
fn linker(kit: &Path) -> anyhow::Result<PathBuf> {
    let own = own_linker(kit);
    if own.is_file() {
        return Ok(own);
    }
    if let Some(lld) = std::env::var_os("NSH_LLD") {
        return Ok(lld.into());
    }
    let sysroot = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .context("no linker in the runner's link kit, and no Rust toolchain for rust-lld")?;
    let sysroot = String::from_utf8_lossy(&sysroot.stdout).trim().to_owned();
    let lld = Path::new(&sysroot).join("lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe");
    anyhow::ensure!(lld.is_file(), "no rust-lld in {sysroot}");
    Ok(lld)
}

fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn quote(arg: &str) -> String {
    format!("\"{}\"", arg.replace('"', "\\\""))
}

fn unquote(arg: &str) -> String {
    arg.strip_prefix('"')
        .and_then(|a| a.strip_suffix('"'))
        .map_or_else(|| arg.to_owned(), |a| a.replace("\\\"", "\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = "\"-m\"\n\"i386pep\"\n\"${KIT}/lib/libnsh_base.a\"\n\
        \"-Xlink=-alternatename:nsh_part_editor=nsh_have_editor\"\n\
        \"-Xlink=-alternatename:nsh_part_plot=nsh_have_plot\"\n";

    #[test]
    fn the_gates_of_parts_not_imported_resolve_to_none() {
        let gates = ["nsh_part_core".to_owned(), "nsh_part_plot".to_owned()];
        let (args, left_out) = args(TEMPLATE, "C:/kit", &gates, "C:/out/App.exe");
        assert_eq!(
            args,
            [
                "-m",
                "i386pep",
                "C:/kit/lib/libnsh_base.a",
                "-Xlink=-alternatename:nsh_part_editor=nsh_part_none",
                "-Xlink=-alternatename:nsh_part_plot=nsh_have_plot",
                "-o",
                "C:/out/App.exe",
            ]
        );
        assert_eq!(left_out, ["editor"]);
    }

    #[test]
    fn a_kit_is_found_next_to_its_runner() {
        let dir = std::env::temp_dir().join(format!("nsh-link-kit-{}", std::process::id()));
        let kit = dir.join("nsh-windows-app.link");
        fs::create_dir_all(&kit).unwrap();
        let runner = dir.join("nsh-windows-app.exe");
        assert_eq!(kit_for(&runner), None);
        fs::write(kit.join(ARGS), TEMPLATE).unwrap();
        assert_eq!(kit_for(&runner), Some(kit));
        fs::remove_dir_all(&dir).unwrap();
    }
}
