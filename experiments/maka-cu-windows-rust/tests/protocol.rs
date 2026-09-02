use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};

// Transport-level regression that runs on every host. On Windows the same
// binary additionally exercises COM when pointed at a real HWND by the
// lifecycle driver; this test intentionally needs no desktop.
#[test]
fn malformed_json_gets_json_rpc_parse_error() {
    let exe = env!("CARGO_BIN_EXE_maka-cu-windows-rust");
    let mut child = Command::new(exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"not-json\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
        .unwrap();
    drop(child.stdin.take());
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    let status = child.wait().unwrap();
    assert!(status.success());
    let lines: Vec<_> = output
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect();
    assert_eq!(lines[0]["error"]["code"], json!(-32700));
    assert_eq!(lines[1]["result"]["protocol"], json!("maka.cu.windows/0"));
}

#[test]
fn control_cancel_settles_running_request() {
    let exe = env!("CARGO_BIN_EXE_maka-cu-windows-rust");
    let mut child = Command::new(exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    stdin
        .write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"debug_sleep\",\"params\":{\"ms\":120}}\n",
        )
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    stdin
        .write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"$/cancel\",\"params\":{\"id\":7}}\n",
        )
        .unwrap();
    let mut responses = Vec::new();
    for _ in 0..2 {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        responses.push(serde_json::from_str::<serde_json::Value>(&line).unwrap());
    }
    let cancellation = responses
        .iter()
        .find(|item| item["id"] == json!(8))
        .expect("cancel request must settle");
    assert_eq!(cancellation["result"]["cancelled"], json!(true));
    let original = responses
        .iter()
        .find(|item| item["id"] == json!(7))
        .expect("original request must settle");
    if cancellation["result"]["dispatchStarted"] == json!(true) {
        assert_eq!(original["result"]["sleptMs"], json!(120));
    } else {
        assert_eq!(original["error"]["code"], json!(-32001));
        assert_eq!(original["error"]["message"], json!("cancelled"));
    }
    stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"shutdown\"}\n")
        .unwrap();
    drop(stdin);
    let _ = child.wait().unwrap();
}

#[test]
fn shutdown_is_bounded_while_worker_is_busy() {
    let exe = env!("CARGO_BIN_EXE_maka-cu-windows-rust");
    let mut child = Command::new(exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"debug_sleep\",\"params\":{\"ms\":2000}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"shutdown\"}\n")
        .unwrap();
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], json!(2));
    assert_eq!(response["result"]["graceMs"], json!(1000));
    drop(stdin);
    let _ = child.wait().unwrap();
}
