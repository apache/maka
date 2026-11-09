use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

struct AppDirectory(PathBuf);
impl Drop for AppDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn app(config: &str) -> AppDirectory {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = AppDirectory(std::env::temp_dir().join(format!(
        "nsh-cli-tui-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    fs::create_dir_all(dir.0.join("runtime/tui")).unwrap();
    fs::write(
        dir.0.join("App.tsx"),
        "import { mount, Text } from 'nsh'; mount(() => <Text>Hello</Text>);",
    )
    .unwrap();
    fs::write(dir.0.join("nsh.json"), config).unwrap();
    let host = dir.0.join("runtime/tui/nsh-tui-host");
    fs::write(&host, "#!/bin/sh\nprintf 'host arguments: %s\\n' \"$*\"\nread answer\nprintf 'host input: %s\\n' \"$answer\"\necho host-diagnostic >&2\n").unwrap();
    fs::set_permissions(host, fs::Permissions::from_mode(0o755)).unwrap();
    dir
}

fn run(app: &AppDirectory, extra: &[&str]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_nsh"))
        .args(["run", "--target", "tui", "--port", "0"])
        .arg(&app.0)
        .args(extra)
        .env("NSH_RUNTIME", app.0.join("runtime"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"terminal input\n")
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn tui_shows_startup_progress_and_keeps_running_host_diagnostics_in_its_log() {
    let app = app(r#"{"tui":{"pointsPerCell":"10x20"}}"#);
    for extra in [vec![], vec!["-v", "--points-per-cell", "6x12"]] {
        let output = run(&app, &extra);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let shown = String::from_utf8(output.stdout).unwrap();
        assert!(shown.contains("host input: terminal input"), "{shown}");
        assert!(shown.contains("--dev-server ws://127.0.0.1:"), "{shown}");
        assert!(
            shown.contains(if extra.is_empty() {
                "--points-per-cell 10x20"
            } else {
                "--points-per-cell 6x12"
            }),
            "{shown}"
        );
        assert!(!shown.contains("built"), "{shown}");
        let progress = String::from_utf8(output.stderr).unwrap();
        assert!(progress.contains("built"), "{progress}");
        assert!(!progress.contains("host-diagnostic"), "{progress}");
        let logs = fs::read_to_string(app.0.join(".nsh/tui.log")).unwrap();
        assert!(logs.contains("host-diagnostic"), "{logs}");
    }
}

#[test]
fn tui_rejects_invalid_cell_dimensions_before_launching() {
    for value in ["0x16", "8x-1", "NaNx16", "8xinf", "8", "8x16x32"] {
        let app = app("{}");
        let output = run(&app, &["--points-per-cell", value]);
        assert!(!output.status.success(), "accepted {value}");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("host arguments"));
    }
}

#[test]
fn tui_leaves_out_cell_dimensions_of_nsh_json_it_cannot_read() {
    // A newer NSH's form (or a typo): warned of, and the default's taken.
    for value in ["0x16", "auto"] {
        let app = app(&format!(r#"{{"tui":{{"pointsPerCell":"{value}"}}}}"#));
        let output = run(&app, &[]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let shown = String::from_utf8_lossy(&output.stdout);
        assert!(shown.contains("--points-per-cell 8x16"), "{shown}");
        let all = format!("{shown}{}", String::from_utf8_lossy(&output.stderr));
        assert!(all.contains("tui.pointsPerCell"), "{all}");
    }
}

#[test]
fn tui_forwards_the_performance_monitor_flag_to_the_host() {
    let app = app("{}");
    let output = run(&app, &["--fps"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let shown = String::from_utf8(output.stdout).unwrap();
    assert!(shown.contains("--fps"), "{shown}");
}
