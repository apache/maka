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

#![cfg(all(target_os = "linux", feature = "native-desktop"))]

//! Capture the candidate side of the shared native-geometry differential.
//! Observed refusals remain results; this suite does not assume a match.

use maka_agent_facts::{
    language::Language,
    tools::{ToolExecutor, ToolFuture},
};
use maka_capabilities::computer::Desktop;
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult, CellStore};
use maka_computer_use::{Driver, InvocationContext, Session, facade};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

const CASE: &str = "native.capture-scale-and-window-move";
const ACTION_MARKER: &str = "__maka_geometry_action__";
const CAPTURE_MARKER: &str = "__maka_geometry_capture__";
const CAPTURE_ERROR_MARKER: &str = "__maka_geometry_capture_error__";
const AX_MARKER: &str = "__maka_geometry_ax__";

struct Bridge(Arc<Mutex<Session>>);

impl ToolExecutor for Bridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let session = self.0.clone();
        Box::pin(async move {
            session
                .lock()
                .await
                .invoke(
                    serde_json::from_value(input).unwrap(),
                    &InvocationContext::new("native-geometry-fixture", "fixture-turn"),
                    &cancellation,
                    Language::En,
                )
                .await
        })
    }
}

fn digest(path: &Path) -> String {
    let mut source = std::fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    hex::encode(hash.finalize())
}

fn write_json(path: &Path, value: &Value) {
    let mut bytes = serde_json::to_vec_pretty(value).unwrap();
    bytes.push(b'\n');
    std::fs::write(path, bytes).unwrap();
}

fn relative(path: &Path, output: &Path) -> String {
    path.strip_prefix(output)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned()
}

struct Fixture {
    child: tokio::process::Child,
    stream: BufReader<UnixStream>,
    request_id: u64,
    _socket_directory: tempfile::TempDir,
}

impl Fixture {
    async fn start(source: &Path, cases: &Path, output: &Path) -> Self {
        let socket_directory = tempfile::tempdir().unwrap();
        let socket = socket_directory.path().join("geometry.sock");
        let fixture_output = output.join("fixture");
        assert!(
            !fixture_output.exists(),
            "use a fresh observer output directory"
        );
        let stdout = std::fs::File::create(output.join("fixture.stdout.log")).unwrap();
        let stderr = std::fs::File::create(output.join("fixture.stderr.log")).unwrap();
        let mut child = tokio::process::Command::new("/usr/bin/python3.12")
            .arg(source)
            .arg("--cases")
            .arg(cases)
            .arg("--socket")
            .arg(&socket)
            .arg("--output")
            .arg(&fixture_output)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let stream = loop {
            match UnixStream::connect(&socket).await {
                Ok(stream) => break stream,
                Err(error) => {
                    assert!(
                        child.try_wait().unwrap().is_none(),
                        "geometry observer exited before connecting: {}",
                        std::fs::read_to_string(output.join("fixture.stderr.log")).unwrap()
                    );
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "geometry observer socket did not become ready: {error}"
                    );
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        };
        Self {
            child,
            stream: BufReader::new(stream),
            request_id: 0,
            _socket_directory: socket_directory,
        }
    }

    async fn request(&mut self, mut value: Value) -> Value {
        self.request_id += 1;
        value["id"] = json!(self.request_id);
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.stream.get_mut().write_all(&bytes).await.unwrap();
        let mut line = String::new();
        assert_ne!(
            tokio::time::timeout(Duration::from_secs(15), self.stream.read_line(&mut line))
                .await
                .expect("geometry observer replies after its actual X11 barrier")
                .unwrap(),
            0,
            "geometry observer closed its control socket"
        );
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], self.request_id);
        assert_eq!(response["ok"], true, "fixture refused {value}: {response}");
        response["value"].clone()
    }

    async fn snapshot(&mut self, after_sequence: u64) -> Value {
        self.request(json!({"command":"snapshot","after_sequence":after_sequence}))
            .await
    }

    async fn finish(mut self) {
        self.request(json!({"command":"shutdown"})).await;
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .expect("geometry observer exits after shutdown")
            .unwrap();
        assert!(status.success(), "geometry observer failed: {status}");
    }
}

async fn cell(
    repl: &Repl,
    bridge: Arc<Bridge>,
    source: String,
    path: &Path,
    output: &Path,
) -> (Vec<CellOutput>, Value) {
    let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            source.clone(),
            bridge,
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(20),
        )
        .await;
    let parts = context.take_output();
    let serialized_result = match &result {
        Ok(result) => serde_json::to_value(result).unwrap(),
        Err(error) => json!({"transport_error":error.to_string()}),
    };
    write_json(
        path,
        &json!({"source":source,"result":serialized_result,"outputs":parts}),
    );
    let transcript = json!({"path":relative(path,output),"sha256":digest(path)});
    assert!(
        matches!(result, Ok(CellResult::Success { .. })),
        "public cell did not reach its own result marker: {}",
        path.display()
    );
    (parts, transcript)
}

fn marker(outputs: &[CellOutput], key: &str) -> Option<Value> {
    let rows: Vec<Value> = outputs
        .iter()
        .filter_map(|part| match part {
            CellOutput::Text { text } => serde_json::from_str::<Value>(text).ok(),
            _ => None,
        })
        .filter_map(|value| value.get(key).cloned())
        .collect();
    assert!(rows.len() <= 1, "duplicate public marker {key}");
    rows.into_iter().next()
}

fn image_geometry(bytes: &[u8]) -> (&'static str, u32, u32) {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        assert!(bytes.len() >= 24 && &bytes[12..16] == b"IHDR");
        return (
            "png",
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        );
    }
    assert!(bytes.starts_with(&[0xff, 0xd8]), "unknown screenshot codec");
    let mut position = 2;
    while position < bytes.len() {
        assert_eq!(bytes[position], 0xff, "invalid JPEG marker");
        while position < bytes.len() && bytes[position] == 0xff {
            position += 1;
        }
        let marker = *bytes.get(position).expect("truncated JPEG marker");
        position += 1;
        if matches!(marker, 0xd8 | 0x01 | 0xd0..=0xd7) {
            continue;
        }
        assert!(
            !matches!(marker, 0xd9 | 0xda),
            "JPEG has no frame dimensions"
        );
        let length = bytes
            .get(position..position + 2)
            .expect("truncated JPEG segment length");
        let length = usize::from(u16::from_be_bytes(length.try_into().unwrap()));
        assert!(length >= 2 && position + length <= bytes.len());
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            assert!(length >= 7);
            let height = u16::from_be_bytes(bytes[position + 3..position + 5].try_into().unwrap());
            let width = u16::from_be_bytes(bytes[position + 5..position + 7].try_into().unwrap());
            return ("jpeg", u32::from(width), u32::from(height));
        }
        position += length;
    }
    panic!("JPEG has no frame dimensions");
}

async fn wait_for_inventory(bridge: &Bridge, ready: &Value) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let windows = bridge
            .0
            .lock()
            .await
            .invoke(
                serde_json::from_value(json!({"method":"listWindows","options":{}})).unwrap(),
                &InvocationContext::new("native-geometry-fixture", "fixture-turn"),
                &CancellationToken::new(),
                Language::En,
            )
            .await
            .unwrap();
        if ["target", "sibling"].iter().all(|role| {
            windows.as_array().unwrap().iter().any(|window| {
                window["id"] == ready["windows"][*role]["window_id"] && window["isOnScreen"] == true
            })
        }) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "both actual observer windows must appear before binding: {windows}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires the task-owned shared geometry observer and an isolated X11/DBus/WM desktop"]
async fn linux_shared_capture_geometry_fixture() {
    let source = PathBuf::from(
        std::env::var_os("MAKA_NATIVE_GEOMETRY_FIXTURE")
            .expect("explicit task-owned geometry observer"),
    );
    let cases_path = PathBuf::from(
        std::env::var_os("MAKA_NATIVE_GEOMETRY_CASES").expect("shared immutable geometry cases"),
    );
    let output = PathBuf::from(
        std::env::var_os("MAKA_NATIVE_GEOMETRY_OUTPUT")
            .expect("private writable evidence directory"),
    );
    assert!(source.is_file() && cases_path.is_file() && output.is_dir());
    assert!(
        !output.join("capture.json").exists(),
        "use a fresh evidence directory"
    );
    let cases: Value = serde_json::from_slice(&std::fs::read(&cases_path).unwrap()).unwrap();
    assert_eq!(cases["case_id"], CASE);
    let stages = cases["stages"].as_array().unwrap();
    assert_eq!(stages.len(), 6);
    assert_eq!(
        stages
            .iter()
            .map(|stage| stage["calls"].as_array().unwrap().len())
            .sum::<usize>(),
        14
    );
    let transcripts = output.join("transcripts");
    let screenshots = output.join("screenshots");
    std::fs::create_dir(&transcripts).unwrap();
    std::fs::create_dir(&screenshots).unwrap();
    let mut capture = json!({
        "kind":"controlled-native-geometry-capture", "role":"candidate",
        "case_id":CASE, "completed":false, "runtime_pid":std::process::id(),
        "input_identities":{
            "fixture_sha256":digest(&source),"cases_sha256":digest(&cases_path),
            "binary_sha256":digest(&std::env::current_exe().unwrap())
        },
        "rebind_public_app":"Each stage makes a fresh public getApp call; no claim of new backend object identity.",
        "stages":[]
    });
    let capture_path = output.join("capture.json");
    write_json(&capture_path, &capture);
    let mut fixture = Fixture::start(&source, &cases_path, &output).await;
    let ready = fixture.request(json!({"command":"ready"})).await;
    let fixture_pid = ready["pid"].as_u64().unwrap();
    assert_ne!(fixture_pid, u64::from(std::process::id()));
    assert_eq!(fixture.child.id().map(u64::from), Some(fixture_pid));
    for role in ["target", "sibling"] {
        assert_eq!(ready["windows"][role]["pid"], fixture_pid);
    }
    capture["fixture_pid"] = json!(fixture_pid);
    capture["initial_fixture"] = ready.clone();
    write_json(&capture_path, &capture);

    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut session = Session::new(driver.clone());
    session
        .configure(Desktop::Local, vec![], Language::En)
        .unwrap();
    let bridge = Arc::new(Bridge(Arc::new(Mutex::new(session))));
    wait_for_inventory(&bridge, &ready).await;
    let repl = Repl::new(facade(), CellLimits::default());
    let mut calls = 0;
    for stage in stages {
        let id = stage["id"].as_str().unwrap();
        assert!(
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
            "stage id must be a filename component"
        );
        assert_eq!(stage["rebind_public_app"], true);
        let ready = fixture.request(json!({"command":"reset"})).await;
        let window = ready["windows"]["target"]["window_id"].as_u64().unwrap();
        let (parts, bind_transcript) = cell(
            &repl,
            bridge.clone(),
            format!(
                "globalThis.app=await cua.getApp({{windowId:{window}}}); nodeRepl.write(JSON.stringify({{__maka_geometry_bound__:true}}));"
            ),
            &transcripts.join(format!("{id}-bind.json")),
            &output,
        )
        .await;
        assert_eq!(marker(&parts, "__maka_geometry_bound__"), Some(json!(true)));
        let mut observed = json!({
            "id":id,"ready":ready,"bind_transcript":bind_transcript,
            "before":[],"actions":[]
        });
        capture["stages"]
            .as_array_mut()
            .unwrap()
            .push(observed.clone());
        write_json(&capture_path, &capture);

        for (index, step) in stage["before"].as_array().unwrap().iter().enumerate() {
            let before = fixture.snapshot(0).await;
            let sequence = before["sequence"].as_u64().unwrap();
            let mut row = json!({"index":index,"step":step,"fixture_before":before});
            match step["subject"].as_str() {
                Some("getScreenshot") => {
                    let code = format!(
                        "try {{ const image=await app.getScreenshot({}); nodeRepl.write(JSON.stringify({{__maka_geometry_capture__:Array.from(image)}})); }} catch(error) {{ nodeRepl.write(JSON.stringify({{__maka_geometry_capture_error__:String(error)}})); }}",
                        step["options"]
                    );
                    let (parts, transcript) = cell(
                        &repl,
                        bridge.clone(),
                        code.clone(),
                        &transcripts.join(format!("{id}-before-{index}.json")),
                        &output,
                    )
                    .await;
                    row["code"] = json!(code);
                    row["transcript"] = transcript;
                    assert!(
                        marker(&parts, CAPTURE_ERROR_MARKER).is_none(),
                        "stable screenshot precondition failed: {}",
                        row["transcript"]
                    );
                    let bytes: Vec<u8> = serde_json::from_value(
                        marker(&parts, CAPTURE_MARKER).expect("public screenshot byte marker"),
                    )
                    .unwrap();
                    let (codec, width, height) = image_geometry(&bytes);
                    assert!(width > 0 && height > 0);
                    let path = screenshots.join(format!("{id}-{index}.{codec}"));
                    std::fs::write(&path, bytes).unwrap();
                    row["result"] = json!({"ok":true});
                    row["capture"] = json!({
                        "path":relative(&path,&output),"sha256":digest(&path),
                        "codec":codec,"width":width,"height":height
                    });
                }
                Some("getAXState") => {
                    let code = format!(
                        "try {{ const value=await app.getAXState({}); nodeRepl.write(JSON.stringify({{__maka_geometry_ax__:{{ok:true,value}}}})); }} catch(error) {{ nodeRepl.write(JSON.stringify({{__maka_geometry_ax__:{{ok:false,error:String(error)}}}})); }}",
                        step["options"]
                    );
                    let (parts, transcript) = cell(
                        &repl,
                        bridge.clone(),
                        code.clone(),
                        &transcripts.join(format!("{id}-before-{index}.json")),
                        &output,
                    )
                    .await;
                    row["code"] = json!(code);
                    row["transcript"] = transcript;
                    row["result"] = marker(&parts, AX_MARKER).expect("public AX result marker");
                }
                None if step["fixture"] == "move_resize" => {
                    let mut request = step.clone();
                    request.as_object_mut().unwrap().remove("fixture");
                    request["command"] = json!("move_resize");
                    request["role"] = json!("target");
                    row["result"] = fixture.request(request).await;
                }
                _ => panic!("unknown shared geometry preparation: {step}"),
            }
            let after = fixture.snapshot(sequence).await;
            row["events"] = after["events"].clone();
            row["fixture_after"] = after;
            observed["before"].as_array_mut().unwrap().push(row);
            *capture["stages"]
                .as_array_mut()
                .unwrap()
                .last_mut()
                .unwrap() = observed.clone();
            write_json(&capture_path, &capture);
        }

        for (index, call) in stage["calls"].as_array().unwrap().iter().enumerate() {
            let call = call.as_str().unwrap();
            let before = fixture.snapshot(0).await;
            let sequence = before["sequence"].as_u64().unwrap();
            let code = format!(
                "try {{ {call} nodeRepl.write(JSON.stringify({{__maka_geometry_action__:{{ok:true}}}})); }} catch(error) {{ nodeRepl.write(JSON.stringify({{__maka_geometry_action__:{{ok:false,error:String(error)}}}})); }}"
            );
            let (parts, transcript) = cell(
                &repl,
                bridge.clone(),
                code.clone(),
                &transcripts.join(format!("{id}-action-{index}.json")),
                &output,
            )
            .await;
            let result = marker(&parts, ACTION_MARKER).expect("public action result marker");
            assert!(result["ok"].is_boolean(), "invalid public action result");
            let after = fixture.snapshot(sequence).await;
            let events = after["events"].clone();
            assert!(events.as_array().unwrap().iter().all(|event| {
                ["target", "sibling"]
                    .iter()
                    .any(|role| event["window_role"] == *role)
            }));
            observed["actions"].as_array_mut().unwrap().push(json!({
                "index":index,"code":code,"result":result,"transcript":transcript,
                "fixture_before":before,"fixture_after":after,"events":events
            }));
            calls += 1;
            *capture["stages"]
                .as_array_mut()
                .unwrap()
                .last_mut()
                .unwrap() = observed.clone();
            write_json(&capture_path, &capture);
        }
    }
    assert_eq!(calls, 14);
    repl.close().await.unwrap();
    bridge.0.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    capture["final_fixture"] = fixture.snapshot(0).await;
    fixture.finish().await;
    let baseline = &capture["stages"][0];
    assert_eq!(baseline["id"], "without_capture");
    for (index, button) in [(0, 1), (1, 5)] {
        let action = &baseline["actions"][index];
        assert_eq!(
            action["result"],
            json!({"ok":true}),
            "native positive control failed"
        );
        let events = action["events"].as_array().unwrap();
        assert_eq!(
            events.len(),
            2,
            "one actual native press/release pair is required"
        );
        assert_eq!(events[0]["type"], "press");
        assert_eq!(events[1]["type"], "release");
        for event in events {
            assert_eq!(event["window_role"], "target");
            assert_eq!(
                event["window_id"],
                baseline["ready"]["windows"]["target"]["window_id"]
            );
            assert_eq!(event["button"], button);
            assert_eq!(
                (event["event_x"].as_i64(), event["event_y"].as_i64()),
                (Some(37), Some(41))
            );
            assert_eq!(event["send_event"], true);
        }
    }
    capture["positive_controls_verified"] = json!(true);
    capture["completed"] = json!(true);
    capture["action_count"] = json!(calls);
    write_json(&capture_path, &capture);
    eprintln!("MAKA_NATIVE_GEOMETRY_CAPTURE {}", capture_path.display());
}
