use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};

/// A scratch directory, removed when dropped.
struct Directory(PathBuf);

impl Directory {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("nsh-cli-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // The CLI reports the checkout's resolved path (macOS' temporary
        // directory is behind `/var` -> `/private/var`).
        Self(fs::canonicalize(&dir).unwrap())
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn executable(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Lays out a checkout of nsh at `root` that is also an app: its CLI is a
/// copy of this one in the profile directory `bin` (as Cargo lays one out)
/// beside a stale GPUI host, and a mock `cargo` builds a fresh host into
/// `$MOCK_TARGET`, which it reports as the GPUI workspace's target. Returns
/// that `cargo`.
fn gpui_checkout(root: &Path, bin: &Path) -> PathBuf {
    fs::write(root.join("nsh.json"), "{}").unwrap();
    fs::write(
        root.join("App.tsx"),
        "import { mount, Text } from 'nsh'; mount(() => <Text>Hello</Text>);",
    )
    .unwrap();
    let workspace = root.join("crates/gpui");
    fs::create_dir_all(bin).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(root.join("crates/nsh-ios-host")).unwrap();
    fs::write(root.join("crates/nsh-ios-host/Cargo.toml"), "").unwrap();
    fs::write(workspace.join("Cargo.toml"), "").unwrap();
    fs::write(bin.join(".cargo-lock"), "").unwrap();
    fs::copy(env!("CARGO_BIN_EXE_nsh"), bin.join("nsh")).unwrap();
    executable(&bin.join("nsh-gpui-host"), "#!/bin/sh\nexit 42\n");
    let cargo = root.join("cargo");
    executable(
        &cargo,
        r##"#!/bin/sh
set -eu
test "$PWD" = "$GPUI_WORKSPACE"
case " $* " in *' --target-dir '*) exit 43;; esac
case "$1" in
build)
    mkdir -p "$MOCK_TARGET/debug"
    printf '#!/bin/sh\ntouch "$MOCK_TARGET/launched"\n' > "$MOCK_TARGET/debug/nsh-gpui-host"
    chmod +x "$MOCK_TARGET/debug/nsh-gpui-host"
    ;;
metadata)
    printf '{"target_directory":"%s"}\n' "$MOCK_TARGET"
    ;;
*) exit 44;;
esac
"##,
    );
    cargo
}

/// `nsh run --target gpui` of the app at `root`, run as `nsh`, with the
/// mock `cargo` building into `target`.
fn run_gpui(nsh: &Path, root: &Path, cargo: &Path, target: &Path) -> Output {
    Command::new(nsh)
        .args(["run", "--target", "gpui", "--port", "0"])
        .arg(root)
        .env_remove("NSH_RUNTIME")
        .env("CARGO", cargo)
        .env("GPUI_WORKSPACE", root.join("crates/gpui"))
        .env("MOCK_TARGET", target)
        .env("CARGO_TARGET_DIR", target)
        .output()
        .unwrap()
}

/// The checkout's GPUI host was built and launched into `target`.
fn assert_built(output: &Output, target: &Path) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert!(stderr.contains("built"), "{stderr}");
    assert!(target.join("launched").exists(), "{stderr}");
}

#[test]
fn gpui_uses_its_workspaces_cargo_output_instead_of_a_stale_cli_sibling() {
    let dir = Directory::new("gpui");
    let root = &dir.0;
    let bin = root.join("target/debug");
    let cargo = gpui_checkout(root, &bin);
    // The fork keeps its workspace's target; standard Cargo can use a
    // configured directory. In either case a stale CLI sibling must lose.
    for target in [root.join("crates/gpui/target"), root.join("custom target")] {
        let output = run_gpui(&bin.join("nsh"), root, &cargo, &target);
        assert_built(&output, &target);
    }
}

/// A checkout whose `target/` links to a build cache: the CLI run from the
/// checkout's `target/debug` builds the checkout's host rather than running
/// the stale one beside its resolved path.
#[test]
fn a_checkout_build_through_a_linked_target_builds_its_runtimes() {
    let dir = Directory::new("linked-target");
    let root = dir.0.join("checkout");
    let cache = dir.0.join("cache");
    fs::create_dir_all(&root).unwrap();
    let cargo = gpui_checkout(&root, &cache.join("debug"));
    std::os::unix::fs::symlink(&cache, root.join("target")).unwrap();
    let target = root.join("crates/gpui/target");
    let output = run_gpui(&root.join("target/debug/nsh"), &root, &cargo, &target);
    assert_built(&output, &target);
}
