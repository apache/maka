//! Stamps the CLI with its source revision without changing crate versions.
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn short_sha(value: &str) -> Option<String> {
    (value.len() >= 7 && value.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| value[..7].to_owned())
}

/// Main-thread stack of the `nsh` binary. The JS host lets QuickJS use up
/// to 4 MB (`Limits::stack_bytes`), and the CLI evaluates on its main thread.
/// Windows reserves only 1 MB for that thread, so QuickJS overflowed the real
/// stack before its own limit tripped (#1191). Match the engine thread size.
const MAIN_STACK_BYTES: u64 = 8 << 20;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        match env::var("CARGO_CFG_TARGET_ENV").as_deref() {
            Ok("msvc") => println!("cargo:rustc-link-arg-bins=/STACK:{MAIN_STACK_BYTES}"),
            _ => println!("cargo:rustc-link-arg-bins=-Wl,--stack,{MAIN_STACK_BYTES}"),
        }
    }
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let root = manifest.parent().and_then(Path::parent);
    // A published crate can live inside someone else's Git repository.
    let checkout = root
        .is_some_and(|root| root.join(".git").exists() && root.join("crates/nsh-cli") == manifest);
    let revision = if checkout {
        // Packed branches acquire a loose ref on the next commit. Watch
        // the refs directory too, so creating that file refreshes the SHA.
        for name in ["HEAD", "refs", "packed-refs"] {
            if let Some(path) = git(&manifest, &["rev-parse", "--git-path", name]) {
                let path = manifest.join(path);
                if path.exists() {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
        git(&manifest, &["rev-parse", "HEAD"]).and_then(|s| short_sha(&s))
    } else {
        let vcs = manifest.join(".cargo_vcs_info.json");
        if vcs.exists() {
            println!("cargo:rerun-if-changed={}", vcs.display());
        }
        fs::read(vcs)
            .ok()
            .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
            .and_then(|data| data["git"]["sha1"].as_str().and_then(short_sha))
    };
    println!(
        "cargo:rustc-env=NSH_GIT_SHA={}",
        revision.as_deref().unwrap_or("unknown")
    );
}
