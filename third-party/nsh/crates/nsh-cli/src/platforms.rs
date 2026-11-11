//! Platforms implemented outside NSH: `--target <name>` of `nsh dev`,
//! `nsh run`, `nsh test` and `nsh package` that is none of NSH's own targets
//! runs the executable `nsh-platform-<name>` found on `PATH`, as Cargo runs
//! `cargo-<name>` for a subcommand it does not know.
//!
//! The platform gets the command and every argument but `--target`'s
//! (`nsh-platform-miniprogram package . --out dist`), with the environment
//! `NSH` (this executable: the platform builds the app's bundle with it,
//! `$NSH build`), `NSH_VERSION` (its version) and `NSH_TARGET` (the name).
//! Its exit code is the command's. `docs/dev/platforms.md` describes the
//! protocol and what such a platform implements.

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

use anyhow::{Context as _, bail};
use clap::ValueEnum as _;

/// The commands whose `--target` may name a platform outside NSH.
const COMMANDS: &[&str] = &["dev", "run", "test", "package"];

/// The prefix of a platform's executable.
pub(crate) const PREFIX: &str = "nsh-platform-";

/// A command line handed to a platform outside NSH.
#[derive(Debug, PartialEq, Eq)]
struct External {
    /// The platform's name (`--target`'s value).
    name: String,
    /// The command and its arguments without `--target` and its value.
    args: Vec<OsString>,
}

/// Runs the command line `args` (with the program name first) on a platform
/// outside NSH when its `--target` names one: `None` when it does not (NSH
/// parses it), else the command's exit code.
pub(crate) fn dispatch(args: &[OsString]) -> Option<anyhow::Result<ExitCode>> {
    let external = external(args)?;
    let path = std::env::var_os("PATH").unwrap_or_default();
    Some(run(&external, &path))
}

/// The external command `args` asks for, if any.
fn external(args: &[OsString]) -> Option<External> {
    let rest = args.get(1..)?;
    // The global flags (`-v`) may come before the command.
    let command = rest
        .iter()
        .position(|a| !a.to_string_lossy().starts_with('-'))?;
    if !COMMANDS.contains(&rest[command].to_str()?) {
        return None;
    }
    let mut out = Vec::with_capacity(rest.len());
    let mut name = None;
    let mut i = 0;
    while i < rest.len() {
        let arg = rest[i].to_string_lossy();
        if i > command && name.is_none() {
            if arg == "--target" {
                name = Some(rest.get(i + 1)?.to_str()?.to_owned());
                i += 2;
                continue;
            }
            if let Some(value) = arg.strip_prefix("--target=") {
                name = Some(value.to_owned());
                i += 1;
                continue;
            }
            // `--` ends the options: what follows is not ours to read.
            if arg == "--" {
                out.extend(rest[i..].iter().cloned());
                break;
            }
        }
        out.push(rest[i].clone());
        i += 1;
    }
    let name = name?;
    (!is_builtin(&name)).then_some(External { name, args: out })
}

/// Whether `name` is one of NSH's own targets (of any of the commands, so
/// clap reports a target a command does not take).
fn is_builtin(name: &str) -> bool {
    let run = crate::run::Target::value_variants()
        .iter()
        .filter_map(|t| t.to_possible_value());
    let package = crate::package::PackageTarget::value_variants()
        .iter()
        .filter_map(|t| t.to_possible_value());
    run.chain(package).any(|v| v.matches(name, false))
}

/// Whether `name` can name a platform: lower-case ASCII letters, digits
/// and dashes, starting with a letter.
fn valid_name(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `nsh-platform-<name>`'s path among the directories of `path` (a `PATH`).
fn find(name: &str, path: &OsStr) -> Option<PathBuf> {
    let file = format!("{PREFIX}{name}{}", std::env::consts::EXE_SUFFIX);
    std::env::split_paths(path)
        .map(|dir| dir.join(&file))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Runs `external` with the platform found on `path`.
fn run(external: &External, path: &OsStr) -> anyhow::Result<ExitCode> {
    let name = &external.name;
    if !valid_name(name) {
        bail!(
            "`{name}` is not a target: NSH's are {}; a platform outside NSH is named in lower case \
             (`--target miniprogram`)",
            builtin_names()
        );
    }
    let Some(program) = find(name, path) else {
        bail!(
            "no target named `{name}`: NSH's are {}, and no `{PREFIX}{name}` was found on PATH \
             (a platform implemented outside NSH installs it there)",
            builtin_names()
        );
    };
    let nsh = std::env::current_exe().context("finding the nsh executable")?;
    let status = Command::new(&program)
        .args(&external.args)
        .env("NSH", nsh)
        .env("NSH_VERSION", env!("CARGO_PKG_VERSION"))
        .env("NSH_TARGET", name)
        .status()
        .with_context(|| format!("running {}", program.display()))?;
    Ok(match status.code() {
        Some(0) => ExitCode::SUCCESS,
        Some(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        None => ExitCode::FAILURE,
    })
}

/// NSH's own targets, for messages.
fn builtin_names() -> String {
    let mut names: Vec<String> = crate::run::Target::value_variants()
        .iter()
        .filter_map(|t| t.to_possible_value())
        .chain(
            crate::package::PackageTarget::value_variants()
                .iter()
                .filter_map(|t| t.to_possible_value()),
        )
        .filter(|v| !v.is_hide_set())
        .map(|v| v.get_name().to_owned())
        .collect();
    names.sort();
    names.dedup();
    names.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<OsString> {
        line.split_whitespace().map(OsString::from).collect()
    }

    #[test]
    fn builtin_targets_stay_nsh_s() {
        for line in [
            "nsh run . --target web",
            "nsh package --target ios-simulator",
            "nsh test . --target=macos",
            "nsh dev",
            "nsh build . --target miniprogram",
            "nsh run",
        ] {
            assert_eq!(external(&args(line)), None, "{line}");
        }
    }

    #[test]
    fn other_targets_go_to_their_platform() {
        assert_eq!(
            external(&args(
                "nsh -v package examples/counter --target miniprogram --out dist"
            )),
            Some(External {
                name: "miniprogram".into(),
                args: args("x -v package examples/counter --out dist")[1..].to_vec(),
            })
        );
        assert_eq!(
            external(&args("nsh run --target=miniprogram .")),
            Some(External {
                name: "miniprogram".into(),
                args: args("run ."),
            })
        );
        // Past `--`, a `--target` is the platform's own argument.
        assert_eq!(external(&args("nsh run . -- --target miniprogram")), None);
    }

    #[test]
    fn names_are_lower_case() {
        assert!(valid_name("miniprogram"));
        assert!(valid_name("harmony-os2"));
        assert!(!valid_name("Mini"));
        assert!(!valid_name("../x"));
        assert!(!valid_name("2d"));
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_platform_found_on_path() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("nsh-platforms-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("args.txt");
        let program = dir.join("nsh-platform-demo");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\necho \"$NSH_TARGET $*\" > '{}'\nexit 3\n",
                out.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let external = external(&args("nsh package . --target demo --out dist")).unwrap();
        let code = run(&external, dir.as_os_str()).unwrap();
        assert_eq!(code, ExitCode::from(3));
        assert_eq!(
            std::fs::read_to_string(&out).unwrap().trim(),
            "demo package . --out dist"
        );
        let missing = External {
            name: "absent".into(),
            args: vec![],
        };
        let error = run(&missing, dir.as_os_str()).unwrap_err().to_string();
        assert!(error.contains("nsh-platform-absent"), "{error}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
