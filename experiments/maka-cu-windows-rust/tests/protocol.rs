/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};

fn hello_request(id: u64, image_dir: &std::path::Path) -> String {
    serde_json::to_string(&json!({
        "jsonrpc":"2.0", "id":id, "method":"host.hello",
        "params": {
            "protocol":"maka.cu/2", "host":{"name":"test","version":"0"},
            "hostPid":std::process::id(), "imageDir":image_dir, "allowGlobalPointer":false
        }
    }))
    .unwrap()
        + "\n"
}

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
    let image_dir = std::env::temp_dir().join(format!("maka-cu-protocol-{}", std::process::id()));
    std::fs::create_dir_all(&image_dir).unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("not-json\n{}", hello_request(1, &image_dir)).as_bytes())
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
    assert_eq!(lines[1]["result"]["protocol"], json!("maka.cu/2"));
    let _ = std::fs::remove_dir_all(image_dir);
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
    let image_dir = std::env::temp_dir().join(format!("maka-cu-cancel-{}", std::process::id()));
    std::fs::create_dir_all(&image_dir).unwrap();
    stdin
        .write_all(hello_request(1, &image_dir).as_bytes())
        .unwrap();
    let mut hello = String::new();
    reader.read_line(&mut hello).unwrap();
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
    let _ = std::fs::remove_dir_all(image_dir);
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
    let image_dir = std::env::temp_dir().join(format!("maka-cu-shutdown-{}", std::process::id()));
    std::fs::create_dir_all(&image_dir).unwrap();
    stdin
        .write_all(hello_request(1, &image_dir).as_bytes())
        .unwrap();
    let mut hello = String::new();
    reader.read_line(&mut hello).unwrap();
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
    let _ = std::fs::remove_dir_all(image_dir);
}
