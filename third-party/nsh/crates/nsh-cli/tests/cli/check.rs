//! `nsh check` says what an app's `nsh.json` is ignored or refused, as the
//! commands that build or run the app do reading it.

use std::{fs, os::unix::fs::PermissionsExt, process::Command};

#[test]
fn check_warns_of_nsh_json_it_ignores() {
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let dir = Directory(std::env::temp_dir().join(format!("nsh-cli-check-{}", std::process::id())));
    let root = &dir.0;
    fs::create_dir_all(root).unwrap();
    // One key of a newer NSH, and one where a key's shape is wrong: both
    // are warned, as `nsh test` of the same app does.
    fs::write(
        root.join("nsh.json"),
        r##"{
            "window": { "width": 1000, "defaultSize": { "width": 1000, "height": 700 } },
            "futureKey": true
        }"##,
    )
    .unwrap();
    fs::write(
        root.join("App.tsx"),
        "import { mount, Text } from 'nsh'; mount(() => <Text>Hello</Text>);",
    )
    .unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    // The type check itself is not this test's subject: a `tsc` that passes.
    let tsc = root.join("tsc");
    fs::write(&tsc, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&tsc, fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nsh"))
        .args(["check", "--tsc"])
        .arg(&tsc)
        .arg(root)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{stderr}{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(stderr.contains(r#"unknown key "width""#), "{stderr}");
    assert!(stderr.contains("unknown key `futureKey`"), "{stderr}");
}
