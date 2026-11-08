use std::{fs, os::unix::fs::PermissionsExt, process::Command};

#[test]
fn gpui_uses_its_workspaces_cargo_output_instead_of_a_stale_cli_sibling() {
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let dir = Directory(std::env::temp_dir().join(format!("nsh-cli-gpui-{}", std::process::id())));
    let root = &dir.0;
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("nsh.json"), "{}").unwrap();
    fs::write(
        root.join("App.tsx"),
        "import { mount, Text } from 'nsh'; mount(() => <Text>Hello</Text>);",
    )
    .unwrap();
    let bin = root.join("target/debug");
    let workspace = root.join("crates/gpui");
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(root.join("crates/nsh-ios-host")).unwrap();
    fs::write(root.join("crates/nsh-ios-host/Cargo.toml"), "").unwrap();
    fs::write(workspace.join("Cargo.toml"), "").unwrap();
    fs::copy(env!("CARGO_BIN_EXE_nsh"), bin.join("nsh")).unwrap();
    let executable = |path: &std::path::Path, text: &str| {
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    };
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
    // The fork keeps its workspace's target; standard Cargo can use a
    // configured directory. In either case a stale CLI sibling must lose.
    for target in [workspace.join("target"), root.join("custom target")] {
        let output = Command::new(bin.join("nsh"))
            .args(["run", "--target", "gpui", "--port", "0"])
            .arg(root)
            .env_remove("NSH_RUNTIME")
            .env("CARGO", &cargo)
            .env("GPUI_WORKSPACE", &workspace)
            .env("MOCK_TARGET", &target)
            .env("CARGO_TARGET_DIR", &target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("built"));
        assert!(target.join("launched").exists());
    }
}
