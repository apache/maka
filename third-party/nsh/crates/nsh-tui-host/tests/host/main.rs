//! Standalone host acceptance through its bundle reader, event conversion and loop.

mod counter;

mod dev;

mod text_input;

mod performance;

mod hyperlink;

#[cfg(unix)]
mod lifecycle;

#[test]
fn the_host_captures_the_mouse_unless_asked_not_to() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_nsh-tui-host"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("--no-mouse"));
    assert!(help.contains("Leave the mouse to the terminal"));
}
