//! Stamps the CLI with its source revision, release channel and (for a
//! nightly) build date without
//! changing crate versions.
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

/// The UTC date of the build, `YYYY-MM-DD`: the night a nightly was packed.
/// `SOURCE_DATE_EPOCH` pins it for reproducible builds.
fn build_date() -> String {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let secs = env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs() as i64)
        });
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
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
    let revision = revision.as_deref().unwrap_or("unknown");
    println!("cargo:rustc-env=NSH_GIT_SHA={revision}");

    // The release channel the build is published on: the nightly workflow
    // sets `nightly`, `nsh update` stays on it. Anything else is `stable`.
    println!("cargo:rerun-if-env-changed=NSH_CHANNEL");
    let nightly = env::var("NSH_CHANNEL").as_deref() == Ok("nightly");
    println!(
        "cargo:rustc-env=NSH_CHANNEL={}",
        if nightly { "nightly" } else { "stable" }
    );
    let version = env::var("CARGO_PKG_VERSION").expect("package version");
    let version = if nightly {
        format!("{version} ({revision} nightly {})", build_date())
    } else {
        format!("{version} ({revision})")
    };
    println!("cargo:rustc-env=NSH_VERSION_TEXT={version}");
}
