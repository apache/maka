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

use maka_agent_facts::tools::ToolFuture;
use maka_agent_facts::{language::Language, tools::ToolExecutor};
use maka_capabilities::computer::BrowserConnection;
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult, CellStore};
use maka_computer_use::{Driver, Session, facade};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "linux")]
mod linux_wheel;

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires HARNESS_GTK3_EXE and a disposable X11/AT-SPI desktop; launches only the task-owned GTK3 fixture"]
async fn linux_screenshot_only_keeps_exact_observed_elements_until_replacement() {
    struct OwnedFixture(std::process::Child);
    impl Drop for OwnedFixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    struct RefusalProbe {
        bridge: Arc<Bridge>,
        failures: Arc<Mutex<Vec<maka_agent_facts::tools::ToolError>>>,
    }
    impl ToolExecutor for RefusalProbe {
        fn names(&self) -> Vec<String> {
            self.bridge.names()
        }
        fn invoke(
            &self,
            name: String,
            input: Value,
            cancellation: CancellationToken,
        ) -> ToolFuture {
            let original = self.bridge.invoke(name, input, cancellation);
            let failures = self.failures.clone();
            Box::pin(async move {
                let result = original.await;
                if let Err(error) = &result {
                    failures.lock().await.push(error.clone());
                }
                result
            })
        }
    }
    fn element_row(state: &str, name: &str) -> usize {
        state
            .lines()
            .position(|line| line.contains(name))
            .unwrap_or_else(|| panic!("missing {name}: {state}"))
    }
    fn element(state: &str, name: &str) -> u64 {
        state
            .lines()
            .find(|line| line.contains(name))
            .unwrap_or_else(|| panic!("missing {name}: {state}"))
            .trim_start_matches(|ch: char| !ch.is_ascii_digit())
            .split(|ch: char| !ch.is_ascii_digit())
            .next()
            .unwrap()
            .parse()
            .unwrap()
    }
    let path = std::path::PathBuf::from(
        std::env::var_os("HARNESS_GTK3_EXE").expect("task-owned GTK3 fixture"),
    );
    assert!(path.is_file(), "missing fixture {path:?}");
    let mut command = if path.extension().is_some_and(|extension| extension == "py") {
        let mut command = std::process::Command::new("/usr/bin/python3");
        command.arg(&path);
        command
    } else {
        std::process::Command::new(&path)
    };
    let _fixture = OwnedFixture(
        command
            .env_remove("CUA_GTK3_TASK_STATE")
            .env("GTK_MODULES", "gail:atk-bridge")
            .env("NO_AT_BRIDGE", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut session = Session::new(driver.clone());
    session
        .configure(
            maka_capabilities::computer::Desktop::Local,
            vec![],
            Language::En,
        )
        .unwrap();
    let bridge = Arc::new(Bridge(
        Arc::new(Mutex::new(session)),
        "linux-gtk-snapshot",
        Language::En,
    ));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let window = loop {
        let windows = bridge
            .0
            .lock()
            .await
            .invoke(
                serde_json::from_value(json!({"method":"listWindows","options":{}})).unwrap(),
                &maka_computer_use::InvocationContext::new("linux-gtk-snapshot", "fixture-turn"),
                &CancellationToken::new(),
                Language::En,
            )
            .await
            .unwrap();
        let matches: Vec<_> = windows
            .as_array()
            .unwrap()
            .iter()
            .filter(|window| {
                window["title"] == "CuaTestHarness GTK3" && window["isOnScreen"] == true
            })
            .collect();
        if let [window] = matches.as_slice() {
            break window["id"].as_u64().unwrap();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fixture not uniquely visible: {windows}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("const app=await cua.getApp({{windowId:{window}}});"),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let first = texts(&output);
    assert!(!first.contains("Observation incomplete"), "{first}");
    let increment = element(&first, "btn-increment");
    let (ok, output) = evaluate(&repl, bridge.clone(), format!("await app.getScreenshot({{emit:false}}); await app.click({increment}); await app.getAXState({{disableDiffing:true}});")).await;
    let state = texts(&output);
    assert!(
        ok && state.contains("counter=1") && !state.contains("Observation incomplete"),
        "{state}"
    );
    let original = element(&state, "sld-value");
    let original_row = element_row(&state, "sld-value");
    let replace = element(&state, "btn-replace-slider");
    // Up increases this horizontal GTK scale from its zero lower bound.
    let membership_refusal =
        "element is not in this window's AT-SPI tree; refresh get_window_state()";
    let failures = Arc::new(Mutex::new(Vec::new()));
    let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            format!("await app.getScreenshot({{emit:false}}); await app.click({replace}); await app.getScreenshot({{emit:false}}); try {{ await app.scroll({original},'up',{{pixels:150}}); throw Error('replaced element accepted'); }} catch(error) {{ if (!(error instanceof Error) || error.message !== {membership_refusal:?}) throw error; }} await app.getAXState({{disableDiffing:true}});"),
            Arc::new(RefusalProbe {
                bridge: bridge.clone(),
                failures: failures.clone(),
            }),
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(20),
        )
        .await
        .unwrap();
    let ok = matches!(result, CellResult::Success { .. });
    let state = texts(&context.take_output());
    assert!(
        matches!(failures.lock().await.as_slice(),
            [maka_agent_facts::tools::ToolError::Failed(message)]
                if message == membership_refusal),
        "the exact old native identity must be refused before input, not become outcome-unknown"
    );
    assert!(ok && !state.contains("Observation incomplete"), "{state}");
    assert!(
        state.contains("slider_replaced=True") && state.contains("slider_value=0"),
        "{state}"
    );
    let fresh = element(&state, "sld-value");
    assert_eq!(
        element_row(&state, "sld-value"),
        original_row,
        "replacement must occupy the same rendered row to detect retargeting"
    );
    // Public IDs denote observed native identities, not row ordinals. A new
    // GTK object at the same position must never inherit the old selector.
    assert_ne!(
        fresh, original,
        "replacement needs its own observed public ID"
    );
    let (ok, output) = evaluate(&repl, bridge.clone(), format!("await app.getScreenshot({{emit:false}}); await app.scroll({fresh},'up',{{pixels:150}}); await app.getAXState({{disableDiffing:true}});")).await;
    let state = texts(&output);
    assert!(ok && !state.contains("Observation incomplete"), "{state}");
    let value: f64 = state
        .split("slider_value=")
        .nth(1)
        .unwrap()
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        value > 0.0,
        "fresh observed replacement must receive actual wheel input: {state}"
    );
    repl.close().await.unwrap();
    bridge.0.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires a disposable X11 desktop and D-Bus; creates only its own raw event-observer windows"]
async fn linux_public_scroll_preserves_native_pixels_coordinates_and_target_freshness() {
    async fn wait_for_window(bridge: &Bridge, id: u32) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let windows = bridge
                .0
                .lock()
                .await
                .invoke(
                    serde_json::from_value(json!({"method":"listWindows","options":{}})).unwrap(),
                    &maka_computer_use::InvocationContext::new(
                        "linux-wheel-fixture",
                        "fixture-turn",
                    ),
                    &CancellationToken::new(),
                    Language::En,
                )
                .await
                .unwrap();
            if windows
                .as_array()
                .unwrap()
                .iter()
                .any(|window| window["id"] == id && window["isOnScreen"] == true)
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "fixture window {id} was never visible; listWindows={windows}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    let mut fixture = linux_wheel::Window::new().await;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut session = Session::new(driver.clone());
    session
        .configure(
            maka_capabilities::computer::Desktop::Local,
            vec![],
            Language::En,
        )
        .unwrap();
    let bridge = Arc::new(Bridge(
        Arc::new(Mutex::new(session)),
        "linux-wheel-fixture",
        Language::En,
    ));
    wait_for_window(&bridge, fixture.id).await;
    let repl = Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("const app=await cua.getApp({{windowId:{}}});", fixture.id,),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    fixture.events().await;

    // These calls precede the first screenshot and use native window pixels.
    for (button, expected) in [("l", 1), ("r", 3), ("m", 2)] {
        let (ok, output) = evaluate(&repl, bridge.clone(), format!(
            "await app.click([37,41],{{mouseButton:{button:?}}}); await app.click([37,41],{{mouseButton:{button:?}}});",
        )).await;
        assert!(ok, "{}", texts(&output));
        let events = fixture.events().await;
        assert_eq!(events.len(), 4, "two no-screenshot clicks: {events:?}");
        for pair in events.as_chunks::<2>().0 {
            assert!(pair[0].press && !pair[1].press);
            assert!(pair.iter().all(|event| event.event == fixture.id
                && event.detail == expected
                && (event.event_x, event.event_y) == (37, 41)));
        }
    }

    for (pixels, direction, button, detents) in [
        (Some(1), "down", 5, 1),
        (Some(49), "down", 5, 1),
        (Some(149), "down", 5, 1),
        (Some(150), "down", 5, 2),
        (Some(250), "down", 5, 3),
        (None, "down", 5, 8),
        (Some(5100), "down", 5, 51),
        (Some(100), "up", 4, 1),
        (Some(100), "left", 6, 1),
        (Some(100), "right", 7, 1),
    ] {
        let distance = pixels
            .map(|pixels| format!(",{{pixels:{pixels}}}"))
            .unwrap_or_default();
        let (ok, output) = evaluate(&repl, bridge.clone(), format!(
            "await app.getScreenshot({{emit:false}}); await app.scroll([37,41],{direction:?}{distance});",
        )).await;
        assert!(ok, "{}", texts(&output));
        let events = fixture.events().await;
        eprintln!(
            "MAKA_PUBLIC_WHEEL {}",
            json!({"pixels":pixels,"direction":direction,"expected_detents":detents,"events":events})
        );
        assert_eq!(
            events.len(),
            detents * 2,
            "pixels={pixels:?} direction={direction}"
        );
        for pair in events.as_chunks::<2>().0 {
            assert!(pair[0].press && !pair[1].press);
            for event in pair {
                assert_eq!(event.event, fixture.id);
                assert_eq!(event.detail, button);
                assert_eq!((event.event_x, event.event_y), (37, 41));
                assert_ne!(event.response_type & 0x80, 0);
            }
            assert!(pair[1].time.wrapping_sub(pair[0].time) >= 36);
        }
        if detents >= 8 {
            let pairs = events.as_chunks::<2>().0;
            let mut gaps: Vec<_> = pairs
                .windows(2)
                .map(|pair| pair[1][0].time.wrapping_sub(pair[0][1].time))
                .collect();
            gaps.sort_unstable();
            assert!(gaps[gaps.len() / 2] < 36, "inter-detent gaps: {gaps:?}");
        }
    }

    let (ok, output) = evaluate(&repl, bridge.clone(),
        "await app.scroll([37,41],'d',{pixels:100}); await app.scroll([37,41],'u',{pixels:100}); await app.scroll([37,41],'l',{pixels:100}); await app.scroll([37,41],'r',{pixels:100});".into(),
    ).await;
    assert!(ok, "{}", texts(&output));
    let repeated = fixture.events().await;
    assert_eq!(
        repeated.len(),
        8,
        "the current screenshot survives multiple actions: {repeated:?}"
    );
    for (pair, button) in repeated.as_chunks::<2>().0.iter().zip([5, 4, 6, 7]) {
        assert!(pair[0].press && !pair[1].press);
        assert!(pair.iter().all(|event| event.event == fixture.id
            && event.detail == button
            && (event.event_x, event.event_y) == (37, 41)));
    }
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await app.click([37,41]); await app.click([37,41]);".into(),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let repeated = fixture.events().await;
    assert_eq!(
        repeated.len(),
        4,
        "clicks must not consume the current screenshot: {repeated:?}"
    );
    assert!(repeated.iter().all(|event| event.event == fixture.id
        && event.detail == 1
        && (event.event_x, event.event_y) == (37, 41)));
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await app.getAXState({emit:false}); await app.click([37,41]); await app.click([37,41]);"
            .into(),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let after_ax = fixture.events().await;
    assert_eq!(
        after_ax.len(),
        4,
        "AX-only replaces the image frame with native window pixels: {after_ax:?}"
    );
    assert!(after_ax.iter().all(|event| event.event == fixture.id
        && event.detail == 1
        && (event.event_x, event.event_y) == (37, 41)));
    for (pixels, expected) in [
        (0.0, "pixels must be a positive finite number."),
        (-1.0, "invalid value: integer `-1`, expected u16"),
        (0.1, "invalid type: floating point `0.1`, expected u16"),
        (49.5, "invalid type: floating point `49.5`, expected u16"),
        (149.5, "invalid type: floating point `149.5`, expected u16"),
        (150.1, "invalid type: floating point `150.1`, expected u16"),
        (65536.0, "invalid value: integer `65536`, expected u16"),
    ] {
        let (ok, output) = evaluate(&repl, bridge.clone(), format!(
            "await app.getScreenshot({{emit:false}}); try {{ await app.scroll([37,41],'down',{{pixels:{pixels}}}); throw Error('invalid pixels accepted'); }} catch(error) {{ if(!String(error).includes({expected:?})) throw error; }}",
        )).await;
        assert!(ok, "{}", texts(&output));
        assert!(
            fixture.events().await.is_empty(),
            "invalid pixels={pixels} dispatched input"
        );
    }
    let sibling = fixture.sibling().await;
    wait_for_window(&bridge, sibling).await;
    fixture.close().await;
    let (ok, output) = evaluate(&repl, bridge.clone(),
        "try { await app.scroll([37,41],'down',{pixels:100}); throw Error('closed target accepted'); } catch(error) { if(!String(error).includes('stale_target')) throw error; }".into(),
    ).await;
    assert!(ok, "{}", texts(&output));
    assert!(fixture.events_for(sibling).await.is_empty());
    repl.close().await.unwrap();
    bridge.0.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    fixture.finish().await;
}

mod browser_authorization;

struct Bridge(Arc<Mutex<Session>>, &'static str, Language);
impl ToolExecutor for Bridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let session = self.0.clone();
        let id = self.1;
        let language = self.2;
        Box::pin(async move {
            session
                .lock()
                .await
                .invoke(
                    serde_json::from_value(input).unwrap(),
                    &browser_authorization::context(id, "fixture-turn"),
                    &cancellation,
                    language,
                )
                .await
        })
    }
}

// Synthetic cursor rendering is an internal Session contract. The public App
// and Tab wrappers do not expose a moveCursor method.
async fn cursor_binding(bridge: &Bridge, input: Value) -> Value {
    let bound = bridge
        .invoke("cua".into(), input, CancellationToken::new())
        .await
        .unwrap();
    let handle = bound["handle"].clone();
    observe_cursor_target(bridge, &handle).await;
    handle
}

async fn observe_cursor_target(bridge: &Bridge, handle: &Value) {
    bridge
        .invoke(
            "cua".into(),
            json!({"method":"observe","handle":handle,"kind":"screenshot","options":{"emit":false}}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
}

async fn move_fixture_cursor(
    bridge: &Bridge,
    handle: &Value,
    point: [i32; 2],
) -> Result<Value, maka_agent_facts::tools::ToolError> {
    bridge
        .invoke(
            "cua".into(),
            json!({"method":"action","handle":handle,"action":{"kind":"moveCursor","target":point}}),
            CancellationToken::new(),
        )
        .await
}

async fn evaluate(repl: &Repl, bridge: Arc<Bridge>, source: String) -> (bool, Vec<CellOutput>) {
    let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            source,
            bridge,
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(20),
        )
        .await
        .unwrap();
    let ok = matches!(result, CellResult::Success { .. });
    if !ok {
        eprintln!("{result:?}");
    }
    (ok, context.take_output())
}
fn texts(output: &[CellOutput]) -> String {
    output
        .iter()
        .filter_map(|part| match part {
            CellOutput::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn index(state: &str, role: &str, name: &str) -> u64 {
    state
        .lines()
        .find(|line| line.contains(&format!(" {role} {name:?}")))
        .unwrap_or_else(|| panic!("missing {role} {name}: {state}"))
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires macOS Accessibility; compiles and operates a disposable native form"]
async fn native_form_retains_exact_ax_elements_and_verifies_submission() {
    let mut form = NativeForm::start(false).await;
    let window_id = form.window_id;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut native = Session::new(driver.clone());
    let windows = native
        .invoke(
            serde_json::from_value(json!({"method":"listWindows","options":{}})).unwrap(),
            &maka_computer_use::InvocationContext::new("browser-fixture", "fixture-turn"),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await
        .unwrap();
    let window = windows
        .as_array()
        .unwrap()
        .iter()
        .find(|window| window["id"] == window_id)
        .unwrap();
    let bridge = Arc::new(Bridge(
        Arc::new(Mutex::new(native)),
        "browser-fixture",
        Language::En,
    ));
    let clipboard = clipboard_snapshot();
    let repl = Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("const app=await cua.getApp({{windowId:{}}});", window["id"]),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let state = texts(&output);
    assert!(
        state
            .lines()
            .any(|line| line.contains("Disabled fixture") && line.contains("[disabled]")),
        "{state}"
    );
    assert!(
        state.contains("close button")
            && (state.contains("zoom button") || state.contains("full screen button")),
        "standard window controls must be named: {state}"
    );
    assert_eq!(form.command("delay350").await, "delay started");
    let (ok, delayed) = evaluate(
        &repl,
        bridge.clone(),
        "await app.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(
        ok && texts(&delayed).contains("Native delay ready"),
        "first observation missed the native update: {}",
        texts(&delayed)
    );
    let name = index(&state, "AXTextField", "Name");
    let message = index(&state, "AXTextArea", "Message");
    let button = index(&state, "AXButton", "Submit fixture");
    let (ok,output)=evaluate(&repl,bridge.clone(),format!("await app.click({name}); await app.selectText({name}, 'hello', {{prefix:'hello '}}); await app.paste('world'); await app.setValue({message}, 'placeholder'); await app.click({message}); await app.selectText({message}, 'placeholder'); await app.paste('<b>你好</b>', {{format:'html'}}); await app.click({button}); await app.getAXState({{disableDiffing:true}});")).await;
    assert!(ok, "{}", texts(&output));
    let submitted = form.line().await;
    let submitted: Value = serde_json::from_str(&submitted).unwrap();
    assert!(
        submitted["submitted"] == "hello world / 你好",
        "native paste did not produce the requested text; rich={}, font={}",
        submitted["rich"],
        submitted["font"]
    );
    assert!(
        submitted["bold"] == true,
        "native HTML paste lost bold formatting; rich={}, font={}",
        submitted["rich"],
        submitted["font"]
    );
    assert!(
        texts(&output).contains("hello world / 你好"),
        "{}",
        texts(&output)
    );
    assert!(
        clipboard == clipboard_snapshot(),
        "clipboard contents were not restored (or changed externally during the test)"
    );
    let (ok, output) = evaluate(&repl, bridge.clone(), "await app.getScreenshot();".into()).await;
    assert!(ok, "native screenshot capture failed");
    assert!(
        output
            .iter()
            .any(|part| matches!(part, CellOutput::Media { .. }))
    );
    let image = output
        .iter()
        .find_map(|part| match part {
            CellOutput::Media { content, .. } => Some(serde_json::to_value(content).unwrap()),
            _ => None,
        })
        .unwrap();
    use base64::Engine;
    let pixels = tiny_skia::Pixmap::decode_png(
        &base64::engine::general_purpose::STANDARD
            .decode(image["data"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let point: Value = serde_json::from_str(&form.command("canvas").await).unwrap();
    let x = point["point"][0].as_f64().unwrap() * f64::from(pixels.width());
    let y = point["point"][1].as_f64().unwrap() * f64::from(pixels.height());
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await app.click([{x},{y}]);"),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let click: Value = serde_json::from_str(&form.line().await).unwrap();
    assert!(
        (click["click"][0].as_f64().unwrap() - 50.0).abs() < 2.0
            && (click["click"][1].as_f64().unwrap() - 20.0).abs() < 2.0,
        "coordinate click must reach the observed canvas point: {click}"
    );
    let end_x = point["end"][0].as_f64().unwrap() * f64::from(pixels.width());
    let end_y = point["end"][1].as_f64().unwrap() * f64::from(pixels.height());
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await app.getScreenshot(); await app.drag([{x},{y}],[{end_x},{end_y}]);"),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let click: Value = serde_json::from_str(&form.line().await).unwrap();
    assert!((click["click"][0].as_f64().unwrap() - 50.0).abs() < 2.0);
    let drag: Value = serde_json::from_str(&form.line().await).unwrap();
    assert!(
        (drag["drag"][0].as_f64().unwrap() - 80.0).abs() < 2.0
            && (drag["drag"][1].as_f64().unwrap() - 25.0).abs() < 2.0,
        "drag must reach its observed endpoint: {drag}"
    );
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await app.getScreenshot(); await app.scroll([{x},{y}], 'down', 1);"),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let scroll: Value = serde_json::from_str(&form.line().await).unwrap();
    assert!(
        scroll["scroll"].as_f64().unwrap() < 0.0,
        "wheel input must reach the observed view: {scroll}"
    );
    for direction in ["down", "up", "left", "right"] {
        for amount in [1_i64, 37, 500] {
            let (ok, output) = evaluate(
                &repl, bridge.clone(),
                format!("try {{ await app.scroll([{x},{y}], '{direction}', {{pixels:{amount}}}); throw Error('unsupported pixels accepted'); }} catch(error) {{ if (!String(error).includes('macOS scroll accepts pages, not pixels.')) throw error; }}"),
            ).await;
            assert!(ok, "{}", texts(&output));
        }
    }
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await app.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(ok);
    let canvas_index = index(&texts(&output), "AXButton", "Event canvas");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("try {{ await app.scroll({canvas_index}, 'down', {{pixels:37}}); throw Error('unsupported indexed pixels accepted'); }} catch(error) {{ if (!String(error).includes('macOS scroll accepts pages, not pixels.')) throw error; }}"),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let event: Value = serde_json::from_str(&form.command("probe").await).unwrap();
    assert!(
        event.get("active").is_some() && event.get("mouse").is_some(),
        "refused pixels must not leave an input event before the fixture probe: {event}"
    );
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await app.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(ok);
    assert!(
        !texts(&output).contains("Menu fixture command"),
        "closed menu contents must not be advertised: {}",
        texts(&output)
    );
    let menu = index(&texts(&output), "AXMenuBarItem", "Fixture");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await app.click({menu}); await app.getAXState({{disableDiffing:true}});"),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let command = index(&texts(&output), "AXMenuItem", "Menu fixture command");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await app.click({command}); await app.getAXState();"),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let menu_result: Value = serde_json::from_str(&form.line().await).unwrap();
    assert_eq!(menu_result["menuWindow"], window_id);
    assert_eq!(form.command("second").await, "second ready");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await app.pressKey('super+j'); await app.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let menu_result: Value = serde_json::from_str(&form.line().await).unwrap();
    assert_eq!(
        menu_result["menuWindow"], window_id,
        "keyboard input must retain its exact window when another window is key: {menu_result}"
    );
    let name = index(&texts(&output), "AXTextField", "Name");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await app.click({name}); await app.selectText({name}, 'hello world');"),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    assert_eq!(form.command("second").await, "second ready");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await app.typeText('exact window'); await app.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(
        ok && texts(&output).contains("value=\"exact window\""),
        "typing must reach the bound window even when another window is key: {}",
        texts(&output)
    );
    let (ok, _) = evaluate(&repl, bridge.clone(), "await app.getScreenshot();".into()).await;
    assert!(ok);
    assert_eq!(form.command("move").await, "moved");
    let (ok, _) = evaluate(&repl, bridge.clone(), "await app.click([5,5]);".into()).await;
    assert!(
        !ok,
        "external window movement must reject old screenshot coordinates"
    );
    form.stop().await;
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!("await app.setValue({name}, 'wrong process');"),
    )
    .await;
    assert!(!ok);
    repl.close().await.unwrap();
    bridge.0.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires macOS Accessibility; observes a background fixture without keyboard input"]
async fn native_observation_recovers_after_busy_and_preserves_external_edits() {
    let mut form = NativeForm::start(true).await;
    assert_eq!(form.command("activity").await, "inactive");
    let driver = Arc::new(Mutex::new(Driver::default()));
    let bridge = Arc::new(Bridge(
        Arc::new(Mutex::new(Session::new(driver.clone()))),
        "browser-fixture",
        Language::En,
    ));
    let repl = Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!(
            "const app = await cua.getApp({{windowId:{}}}); await app.getAXStateAndScreenshot();",
            form.window_id
        ),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let name = index(&texts(&output), "AXTextField", "Name");

    // Hold the fixture's UI thread until the AX request times out, then
    // explicitly release it. No timing assumption or physical input is needed.
    assert_eq!(form.command("pause").await, "paused");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "try { await app.getAXState(); } catch (e) { nodeRepl.write(String(e)); }".into(),
    )
    .await;
    assert!(
        ok && texts(&output).contains("AX window unavailable"),
        "{}",
        texts(&output)
    );
    assert_eq!(form.command("resume").await, "resumed");

    let (ok, output) = evaluate(&repl, bridge.clone(), format!(
        "try {{ await app.setValue({name}, 'must not overwrite'); }} catch (e) {{ nodeRepl.write(String(e)); }}
         try {{ await app.click([5,5]); }} catch (e) {{ nodeRepl.write(String(e)); }}"
    )).await;
    assert!(
        ok && texts(&output).contains("stale_element")
            && texts(&output).contains("capture_required"),
        "{}",
        texts(&output)
    );
    let (ok, output) = evaluate(&repl, bridge.clone(), "await app.getAXState();".into()).await;
    assert!(
        ok && texts(&output).contains("hello hello"),
        "the same binding must recover without rebind: {}",
        texts(&output)
    );
    let name = index(&texts(&output), "AXTextField", "Name");

    assert_eq!(form.command("edit").await, "edited");
    let (ok, output) = evaluate(&repl, bridge.clone(), format!(
        "try {{ await app.selectText({name}, 'hello', {{prefix:'hello '}}); }} catch (e) {{ nodeRepl.write(String(e)); }}"
    )).await;
    assert!(
        ok && texts(&output).contains("text_not_found"),
        "{}",
        texts(&output)
    );
    let (ok, output) = evaluate(&repl, bridge.clone(), "await app.getAXState();".into()).await;
    assert!(
        ok && texts(&output).contains("externally edited"),
        "external edits must remain intact: {}",
        texts(&output)
    );

    assert_eq!(form.command("activity").await, "inactive");
    assert_eq!(form.command("close").await, "closed");
    assert!(
        form.app.try_wait().unwrap().is_none(),
        "the window closed, not the process"
    );
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!("await app.setValue({name}, 'closed window');"),
    )
    .await;
    assert!(
        !ok,
        "preserving a binding must not permit input to a closed window"
    );
    form.stop().await;
    repl.close().await.unwrap();
    bridge.0.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires a built MAKA_CUA_TEST_HOST and macOS desktop; synthetic cursors and background AX"]
async fn native_cursors_are_visible_independent_and_retire_without_moving_system_pointer() {
    use maka_computer_use::NativeEpochId;

    let executable = std::env::var_os("MAKA_CUA_TEST_HOST")
        .expect("build maka-cli and set MAKA_CUA_TEST_HOST to its executable");
    let mut form = NativeForm::start(true).await;
    let before: Value = serde_json::from_str(&form.command("probe").await).unwrap();
    let driver = Arc::new(Mutex::new(Driver::with_cursor_executable(
        executable.into(),
    )));
    let a = Arc::new(Bridge(
        Arc::new(Mutex::new(Session::new(driver.clone()))),
        "cursor-a",
        Language::En,
    ));
    let b = Arc::new(Bridge(
        Arc::new(Mutex::new(Session::new(driver.clone()))),
        "cursor-b",
        Language::En,
    ));
    let first = Repl::new(facade(), CellLimits::default()).unwrap();
    let second = Repl::new(facade(), CellLimits::default()).unwrap();
    let mut cursor_handles = Vec::new();
    for (repl, bridge, label, color, point) in [
        (&first, a.clone(), "Maka A", "blue", [100, 90]),
        (&second, b.clone(), "Maka B", "mint", [280, 160]),
    ] {
        let (ok,output)=evaluate(repl,bridge.clone(),format!(
            "await cua.cursor.configure({{label:{label:?},color:{color:?},reducedMotion:true}}); const app=await cua.getApp({{windowId:{}}}); await app.getScreenshot();",
            form.window_id
        )).await;
        assert!(ok, "{}", texts(&output));
        let handle = cursor_binding(
            &bridge,
            json!({"method":"getApp","target":{"windowId":form.window_id}}),
        )
        .await;
        let moved = move_fixture_cursor(&bridge, &handle, point).await.unwrap();
        assert_eq!(moved["visible"], true, "{moved}");
        cursor_handles.push(handle);
    }
    let (ok, output) = evaluate(&first, a.clone(), "await cua.cursor.getState();".into()).await;
    assert!(ok);
    let state: Value = serde_json::from_str(&texts(&output)).unwrap();
    let renderer = state["native"]["rendererPid"].as_u64().unwrap();

    // Capture the renderer's own transparent window, not the user's desktop.
    let inspection_epoch = NativeEpochId::new();
    let windows = Driver::invoke(
        &driver,
        "list_windows",
        json!({}),
        inspection_epoch,
        &CancellationToken::new(),
        Language::En,
    )
    .await
    .unwrap();
    let windows = windows.structured_content.unwrap();
    let overlay = windows["windows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|window| window["pid"] == renderer)
        .expect("native cursor window is in WindowServer inventory");
    let capture = Driver::invoke(
        &driver,
        "get_window_state",
        json!({
            "pid":renderer,"window_id":overlay["window_id"],"include_accessibility_tree":false,
            "include_screenshot":true,"max_image_dimension":1600
        }),
        inspection_epoch,
        &CancellationToken::new(),
        Language::En,
    )
    .await
    .unwrap();
    let value = serde_json::to_value(capture).unwrap();
    let encoded = value["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|part| part["type"] == "image")
        .unwrap()["data"]
        .as_str()
        .unwrap();
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let pixels = tiny_skia::Pixmap::decode_png(&bytes).unwrap();
    let blue = pixels
        .pixels()
        .iter()
        .filter(|p| {
            p.blue() > p.red().saturating_add(40) && p.blue() > p.green().saturating_add(20)
        })
        .count();
    let mint = pixels
        .pixels()
        .iter()
        .filter(|p| {
            p.green() > p.red().saturating_add(40) && p.green() > p.blue().saturating_add(10)
        })
        .count();
    assert!(
        blue > 15 && mint > 15,
        "both session colors must be present in the actual overlay image: blue={blue}, mint={mint}"
    );
    if let Some(path) = std::env::var_os("MAKA_CUA_CURSOR_ARTIFACT") {
        std::fs::write(path, bytes).unwrap();
    }
    let (ok, output) = evaluate(
        &first,
        a.clone(),
        "await app.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(ok);
    let state = texts(&output);
    let message = index(&state, "AXTextArea", "Message");
    let button = index(&state, "AXButton", "Submit fixture");
    let (ok,output)=evaluate(&first,a.clone(),format!("await app.setValue({message},'cursor probe'); await app.click({button}); await app.getAXState();")).await;
    assert!(
        ok,
        "a visible overlay must not obstruct background AX actions: {}",
        texts(&output)
    );
    let submitted: Value = serde_json::from_str(&form.line().await).unwrap();
    assert_eq!(submitted["submitted"], "hello hello / cursor probe");
    let moved = move_fixture_cursor(&b, &cursor_handles[1], [280, 160])
        .await
        .unwrap();
    assert_eq!(moved["visible"], true, "{moved}");
    first.close().await.unwrap();
    a.0.lock().await.close().await.unwrap();
    let (ok, output) = evaluate(&second, b.clone(), "await cua.cursor.getState();".into()).await;
    assert!(
        ok && texts(&output).contains("\"visible\":true"),
        "closing one session must not hide another: {}",
        texts(&output)
    );
    let after: Value = serde_json::from_str(&form.command("probe").await).unwrap();
    assert_eq!(
        before, after,
        "cursor display must not activate the fixture or move the system pointer (external user movement also changes this probe)"
    );
    second.close().await.unwrap();
    b.0.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    assert_ne!(
        unsafe { libc::kill(renderer as i32, 0) },
        0,
        "renderer must be reaped when Host closes"
    );
    form.stop().await;
}

#[cfg(target_os = "macos")]
struct NativeForm {
    app: tokio::process::Child,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    window_id: u64,
    _directory: tempfile::TempDir,
}

#[cfg(target_os = "macos")]
impl NativeForm {
    async fn start(background: bool) -> Self {
        assert!(
            unsafe { platform_macos::ax::bindings::AXIsProcessTrusted() },
            "native acceptance requires macOS Accessibility permission for the test host"
        );
        let directory = tempfile::tempdir().unwrap();
        let contents = directory.path().join("Maka Cua Fixture.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::write(contents.join("Info.plist"),r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.apache.maka.cua.fixture.FIXTURE_ID</string><key>CFBundleName</key><string>Maka Cua Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#.replace("FIXTURE_ID", &uuid::Uuid::new_v4().to_string())).unwrap();
        let executable = contents.join("MacOS/fixture");
        let compiled = tokio::process::Command::new("/usr/bin/swiftc")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/native-form.swift"
            ))
            .arg("-o")
            .arg(&executable)
            .output()
            .await
            .unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        let mut launch = tokio::process::Command::new(&executable);
        if background {
            launch.arg("--background");
        }
        let mut app = launch
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let lines = BufReader::new(app.stdout.take().unwrap()).lines();
        let mut fixture = Self {
            app,
            lines,
            window_id: 0,
            _directory: directory,
        };
        fixture.window_id = fixture
            .line()
            .await
            .strip_prefix("ready ")
            .unwrap()
            .parse()
            .unwrap();
        fixture
    }
    async fn line(&mut self) -> String {
        tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
            .await
            .expect("native fixture responds")
            .unwrap()
            .expect("native fixture remains alive")
    }
    async fn command(&mut self, command: &str) -> String {
        self.app
            .stdin
            .as_mut()
            .unwrap()
            .write_all(format!("{command}\n").as_bytes())
            .await
            .unwrap();
        self.line().await
    }
    async fn stop(&mut self) {
        self.app.kill().await.unwrap();
        self.app.wait().await.unwrap();
    }
}

#[cfg(target_os = "macos")]
fn clipboard_snapshot() -> Vec<Vec<(String, Vec<u8>)>> {
    objc2_app_kit::NSPasteboard::generalPasteboard()
        .pasteboardItems()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.types()
                        .iter()
                        .map(|kind| (kind.to_string(), item.dataForType(&kind).unwrap().to_vec()))
                        .collect()
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires Chrome; starts its own temporary headless profile and loopback fixture"]
async fn browser_form_uses_independent_repl_and_rejects_stale_document_and_tab() {
    let executable = std::env::var("MAKA_CUA_TEST_CHROME")
        .unwrap_or_else(|_| "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into());
    let profile = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let page = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut request = [0; 4096];
                let length = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..length]);
                let body = if request.starts_with("GET /scroll-fixture ") {
                    r#"<!doctype html><title>Scroll fixture</title>
<div role="region" aria-label="Scroll fixture target" tabindex="0" style="width:180px;height:60px;overflow:auto"><div style="width:1000px;height:1000px">Nested content</div></div>
<output id="wheel">Wheel pending</output>
<script>let moved=false;addEventListener('mousemove',()=>moved=true);addEventListener('wheel',event=>{document.getElementById('wheel').textContent='Wheel x='+event.deltaX+' y='+event.deltaY+' ratioX='+event.deltaX/innerWidth+' ratioY='+event.deltaY/innerHeight+' moved='+moved;moved=false;event.preventDefault();},{passive:false});</script>"#
                } else if request.starts_with("GET /iframe-child ") {
                    r#"<!doctype html><meta charset="utf-8"><title>Cross site child</title><input aria-label="Child name" id="child-name"><button onclick="parent.postMessage('Child submitted '+document.getElementById('child-name').value,'*')">Child submit</button>"#
                } else if request.starts_with("GET /iframe-shadow ") {
                    r#"<!doctype html><title>Shadow child</title><button onclick="parent.postMessage('Unexpected shadow input','*')">Shadow child submit</button>"#
                } else if request.starts_with("GET /iframe-next ") {
                    r#"<!doctype html><title>Cross site replacement</title><button onclick="parent.postMessage('Unexpected child input','*')">Replacement child submit</button>"#
                } else if request.starts_with("GET /race-replacement ") {
                    r#"<!doctype html><title>Replacement fixture</title><output id="result">Replacement document clean</output>
<script>addEventListener('pointerdown',()=>document.getElementById('result').textContent='Unexpected input');</script>"#
                } else if request.starts_with("GET /navigation-race ") {
                    r#"<!doctype html><title>Navigation race fixture</title>
<button onclick="globalThis.armed=true">Arm navigation race</button><button>Target fixture</button>
<script>new MutationObserver(records=>{if(globalThis.armed && records.some(r=>r.target.matches('[popover][aria-hidden=true]'))) location.replace('/race-replacement');}).observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:['style']});</script>"#
                } else {
                    r#"<!doctype html><meta charset="utf-8"><title>Maka Cua fixture</title>
<label>Name <input aria-label="Name" id="name" value="hello hello"></label>
<label>Message <textarea aria-label="Message" id="message"></textarea></label>
<select aria-label="Color" id="color"><option value="red-id">Red</option><option value="blue-id">Blue</option></select>
<button onclick="const pointer=document.querySelector('[popover][aria-hidden=true]'); const bounds=pointer.getBoundingClientRect(); const arrived=Math.abs(bounds.x+9.685922-event.clientX)<1 && Math.abs(bounds.y+9.685922-event.clientY)<1; document.getElementById('result').textContent=document.getElementById('name').value+' / '+document.getElementById('message').value+' / '+document.getElementById('color').value+' / cursor arrived: '+arrived">Submit fixture</button>
<output id="result" aria-live="polite"></output>
<output id="input-count">Fixture pointerdown count 0</output>
<script>let fixturePointerdowns=0;addEventListener('pointerdown',event=>{if(event.isTrusted)document.getElementById('input-count').textContent='Fixture pointerdown count '+(++fixturePointerdowns);});</script>
<iframe id="child" src="http://localhost:FIXTURE_PORT/iframe-child" style="margin:15px;width:380px;height:100px"></iframe>
<button onclick="document.getElementById('child').src='http://localhost:FIXTURE_PORT/iframe-next'">Navigate child</button>
<div id="shadow-host" style="width:320px;height:160px;margin:120px 0"><iframe id="shadow-child" src="http://localhost:FIXTURE_PORT/iframe-shadow" style="width:300px;height:140px"></iframe></div>
<button onclick="const host=document.getElementById('shadow-host');host.style.rotate=host.style.rotate==='90deg'?'none':'90deg'">Rotate shadow host</button>
<button onclick="const wrapper=document.getElementById('shadow-host').shadowRoot.getElementById('slot-wrapper');wrapper.style.rotate=wrapper.style.rotate==='90deg'?'none':'90deg'">Rotate slot wrapper</button>
<script>document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML='<div id="slot-wrapper"><slot></slot></div>';</script>
<script>addEventListener('message',event=>{if(event.source===document.getElementById('child').contentWindow || event.source===document.getElementById('shadow-child').contentWindow)document.getElementById('result').textContent=event.data;});</script>
<button disabled>Disabled fixture</button>
<button onclick="this.remove()">Remove fixture</button>
<div id="dom-only" onclick="document.getElementById('result').textContent='DOM fixture activated'" style="cursor:pointer">DOM-only fixture</div>
<button onclick="document.getElementById('result').textContent='Frame pending'; requestAnimationFrame(()=>requestAnimationFrame(()=>document.getElementById('result').textContent='Two frames ready'))">Two frames fixture</button>
<button onclick="document.getElementById('result').textContent='Delay pending'; setTimeout(()=>document.getElementById('result').textContent='Delay ready',120)">Delay fixture</button>
<style>@keyframes spin{to{transform:rotate(360deg)}} .decoration{animation:spin 1s linear infinite;pointer-events:none;width:20px;height:20px}</style><div aria-hidden="true" class="decoration">Spinner</div>"#
                };
                let body = body.replace("FIXTURE_PORT", &port.to_string());
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    let mut chrome = tokio::process::Command::new(executable)
        .args([
            "--headless=new",
            "--site-per-process",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-port=0",
            "--disable-gpu",
            // This disposable fixture has no credentials. An unavailable
            // desktop keyring can otherwise stall HTTP navigation under SSH.
            "--password-store=basic",
        ])
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .arg(&page)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(chrome.stderr.take().unwrap()).lines();
    let websocket = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(url) = line.strip_prefix("DevTools listening on ") {
                return url.to_owned();
            }
        }
        panic!("Chrome did not expose its test endpoint");
    })
    .await
    .unwrap();
    let logging =
        tokio::spawn(async move { while lines.next_line().await.ok().flatten().is_some() {} });
    // The debugging socket can precede the fixture's first document load.
    // Observe the task-owned page independently before testing public AX reads.
    {
        let observer = cua_driver_core::browser::cdp_ws::CdpConnection::connect_bounded(
            &websocket,
            usize::MAX,
        )
        .await
        .unwrap();
        let mut events = observer.subscribe();
        let mut last = Value::Null;
        let ready = tokio::time::timeout(Duration::from_secs(10), async {
            observer.call(None, "Target.setDiscoverTargets", json!({"discover":true})).await.unwrap();
            let target = loop {
                let targets = observer.call(None, "Target.getTargets", json!({})).await.unwrap();
                if let Some(target) = targets["targetInfos"].as_array().unwrap().iter()
                    .find(|target| target["type"] == "page" && target["url"] == page)
                {
                    break target["targetId"].as_str().unwrap().to_owned();
                }
                events.recv().await.expect("fixture browser closed before target discovery");
            };
            let attached = observer.call(None, "Target.attachToTarget", json!({"targetId":target,"flatten":true})).await.unwrap();
            let session = attached["sessionId"].as_str().unwrap();
            observer.call(Some(session), "Page.enable", json!({})).await.unwrap();
            observer.call(Some(session), "Runtime.enable", json!({})).await.unwrap();
            let expression = format!("(() => ({{url:location.href,title:document.title,readyState:document.readyState,ready:location.href==={} && document.readyState==='complete' && document.title==='Maka Cua fixture' && document.querySelector('#name')?.value==='hello hello' && document.querySelector('#message')!==null && document.querySelector('#color')?.options.length===2 && Boolean(document.querySelector('#shadow-host')?.shadowRoot?.querySelector('#slot-wrapper'))}}))()", json!(page));
            loop {
                match observer.call(Some(session), "Runtime.evaluate", json!({"expression":expression,"returnByValue":true})).await {
                    Ok(value) => {
                        last = value["result"]["value"].clone();
                        if last["ready"] == true { break; }
                    }
                    Err(error) => last = json!({"cdp_error":error.to_string()}),
                }
                loop {
                    let event = events.recv().await.expect("fixture browser closed before DOM readiness");
                    if event.session_id.as_deref() == Some(session)
                        && matches!(event.method.as_str(), "Runtime.executionContextCreated" | "Runtime.executionContextsCleared" | "Page.loadEventFired" | "Page.domContentEventFired" | "Page.frameNavigated" | "Page.frameStoppedLoading")
                    { break; }
                }
            }
            observer.call(None, "Target.detachFromTarget", json!({"sessionId":session})).await.unwrap();
        }).await;
        assert!(ready.is_ok(), "fixture DOM never became ready: {last}");
        eprintln!("MAKA_BROWSER_FIXTURE_READY {last}");
    }
    let url = reqwest::Url::parse(&websocket).unwrap();
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut native = Session::new(driver.clone());
    native
        .configure(
            maka_capabilities::computer::Desktop::Local,
            vec![BrowserConnection {
                id: "fixture".into(),
                endpoint: format!("http://127.0.0.1:{}", url.port().unwrap()),
            }],
            maka_agent_facts::language::Language::En,
        )
        .unwrap();
    let session = Arc::new(Mutex::new(native));
    let bridge = Arc::new(Bridge(session.clone(), "browser-fixture", Language::En));
    let repl = Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("const tab=await cua.getTab({{url:{}}});", json!(page)),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    // Browser points use CSS viewport coordinates without a prior screenshot.
    // Out-of-viewport input still refuses without dispatch, and the captured
    // language changes the AX label without changing the document's content.
    for (language, label) in [
        (Language::En, "Tab "),
        (Language::ZhCn, "标签页 "),
        (Language::ZhTw, "分頁 "),
    ] {
        let localized = Arc::new(Bridge(session.clone(), "browser-fixture", language));
        let (ok, output) = evaluate(&repl, localized,
            "await tab.getAXState({disableDiffing:true}); try { await tab.click([-1,0]); throw Error('input unexpectedly dispatched'); } catch (error) { if (!String(error).includes('Coordinate is outside the active tab content viewport')) throw error; nodeRepl.write(String(error)); } { const after=await tab.getAXState({disableDiffing:true,emit:false}); if (!after.includes('Fixture pointerdown count 0')) throw Error('rejected coordinates dispatched input: '+after); nodeRepl.write(after); }".into()).await;
        let output = texts(&output);
        assert!(
            ok && output.contains("Coordinate is outside the active tab content viewport")
                && output.contains(label),
            "{output}"
        );
        assert!(
            output.contains("Name")
                && output.contains("Maka Cua fixture")
                && output.contains("Fixture pointerdown count 0"),
            "rejected coordinates must not dispatch input: {output}"
        );
    }
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await tab.click([0,0]); await tab.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(
        ok && texts(&output).contains("Fixture pointerdown count 1"),
        "a CSS point must dispatch once before the first screenshot: {}",
        texts(&output)
    );
    let mut state = browser_cursor_scenario(
        driver.clone(),
        format!("http://127.0.0.1:{}", url.port().unwrap()),
        &page,
        bridge.clone(),
        &repl,
    )
    .await;
    let initial = state.clone();
    assert!(
        initial
            .lines()
            .any(|line| line.contains("Disabled fixture") && line.contains("[disabled]")),
        "{initial}"
    );
    assert!(!initial.contains("InlineTextBox"), "{initial}");
    let dom_only = index(&initial, "generic", "dom-only");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.click({dom_only}); await tab.getAXState({{disableDiffing:true}});"),
    )
    .await;
    assert!(
        ok && texts(&output).contains("DOM fixture activated"),
        "{}",
        texts(&output)
    );

    let child_name = index(&initial, "textbox", "Child name");
    let child_submit = index(&initial, "button", "Child submit");
    let (ok,output)=evaluate(&repl,bridge.clone(),format!("await tab.typeText({child_name}, '跨进程'); await tab.click({child_submit}); await tab.getAXState({{disableDiffing:true}});")).await;
    assert!(
        ok && texts(&output).contains("Child submitted 跨进程"),
        "{}",
        texts(&output)
    );
    let mut shadow_state = texts(&output);
    for control in ["Rotate shadow host", "Rotate slot wrapper"] {
        let shadow = index(&shadow_state, "button", "Shadow child submit");
        let rotate = index(&shadow_state, "button", control);
        let (ok, output) = evaluate(
            &repl,
            bridge.clone(),
            format!("await tab.click({rotate}); await tab.getAXState({{disableDiffing:true}});"),
        )
        .await;
        assert!(ok, "{}", texts(&output));
        let (ok, output) = evaluate(
            &repl,
            bridge.clone(),
            format!(
                "try {{ await tab.click({shadow}); }} catch (e) {{ nodeRepl.write(String(e)); }}"
            ),
        )
        .await;
        assert!(
            ok && texts(&output).contains("iframe owner occluded, transformed or detached"),
            "transformed {control} must refuse before child input: {}",
            texts(&output)
        );
        let (ok, output) = evaluate(
            &repl,
            bridge.clone(),
            "await tab.getAXState({disableDiffing:true});".into(),
        )
        .await;
        assert!(
            ok && !texts(&output).contains("Unexpected shadow input"),
            "{}",
            texts(&output)
        );
        // Restore geometry so transformed content cannot occlude later controls.
        let rotate = index(&texts(&output), "button", control);
        let (ok, output) = evaluate(
            &repl,
            bridge.clone(),
            format!("await tab.click({rotate}); await tab.getAXState({{disableDiffing:true}});"),
        )
        .await;
        assert!(ok, "{}", texts(&output));
        shadow_state = texts(&output);
    }
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await tab.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let child_navigate = index(&texts(&output), "button", "Navigate child");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!(
            "await tab.click({child_navigate}); await tab.getAXState({{disableDiffing:true}});"
        ),
    )
    .await;
    assert!(
        ok && texts(&output).contains("Replacement child submit"),
        "{}",
        texts(&output)
    );
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.click({child_submit});"),
    )
    .await;
    assert!(
        !ok,
        "child-only navigation must invalidate an old element index"
    );
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await tab.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(
        ok && !texts(&output).contains("Unexpected child input"),
        "{}",
        texts(&output)
    );

    let removed = index(&initial, "button", "Remove fixture");
    let disabled = index(&initial, "button", "Disabled fixture");
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.click({disabled});"),
    )
    .await;
    assert!(!ok, "disabled input must still refuse before dispatch");
    let (ok, output) = evaluate(&repl, bridge.clone(), format!("await tab.getAXState(); await tab.click({removed}); await tab.getAXState({{disableDiffing:true}});")).await;
    assert!(
        ok && !texts(&output).contains("Remove fixture"),
        "{}",
        texts(&output)
    );
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.click({removed});"),
    )
    .await;
    assert!(
        !ok,
        "a removed index must not select a different control after observation"
    );
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        "await tab.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(ok);
    let mut observed = texts(&output);
    for (button, expected) in [
        ("Two frames fixture", "Two frames ready"),
        ("Delay fixture", "Delay ready"),
    ] {
        let target = index(&observed, "button", button);
        let started = std::time::Instant::now();
        let (ok, output) = evaluate(
            &repl,
            bridge.clone(),
            format!("await tab.click({target}); await tab.getAXState({{disableDiffing:true}});"),
        )
        .await;
        observed = texts(&output);
        assert!(
            ok && observed.contains(expected),
            "first observation missed {expected}: ok={ok} {output:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "continuous decoration must not block observation"
        );
    }
    state = observed;
    for (text, diagnostic) in [("missing", "text_not_found"), ("hello", "ambiguous_text")] {
        let name = index(&state, "textbox", "Name");
        let (ok, output) = evaluate(&repl, bridge.clone(), format!(
            "try {{ await tab.selectText({name}, {text:?}); }} catch (e) {{ nodeRepl.write(String(e)); }}"
        )).await;
        assert!(
            ok && texts(&output).contains(diagnostic),
            "{}",
            texts(&output)
        );
        let (ok, output) = evaluate(
            &repl,
            bridge.clone(),
            "await tab.getAXState({disableDiffing:true});".into(),
        )
        .await;
        assert!(ok);
        state = texts(&output);
    }
    let name = index(&state, "textbox", "Name");
    let message = index(&state, "textbox", "Message");
    let color = index(&state, "combobox", "Color");
    let button = index(&state, "button", "Submit fixture");
    let (ok,output)=evaluate(&repl,bridge.clone(),format!("await cua.cursor.configure({{reducedMotion:false}}); await tab.selectText({name}, 'hello', {{prefix:'hello '}}); await tab.typeText(null, 'world'); await tab.setValue({message}, '你好'); await tab.setValue({color}, 'blue-id'); await tab.click({button}); await tab.getAXState({{disableDiffing:true}});")).await;
    assert!(ok, "{}", texts(&output));
    assert!(
        texts(&output).contains("hello world / 你好")
            && texts(&output).contains("cursor arrived: true"),
        "{}",
        texts(&output)
    );
    let (ok,output)=evaluate(&repl,bridge.clone(),"const screenshot=await tab.getScreenshot(); nodeRepl.write(screenshot instanceof Uint8Array);".into()).await;
    assert!(ok);
    assert!(
        output
            .iter()
            .any(|part| matches!(part, CellOutput::Media { .. }))
    );
    assert!(texts(&output).contains("true"));
    let (ok,output)=evaluate(&repl,bridge.clone(),format!("await tab.getAXState(); try {{await tab.setValue({color}, 'missing-option'); throw Error('invalid option accepted');}} catch (error) {{if (!String(error).includes('select option value is unavailable')) throw error;}} await tab.getAXState({{disableDiffing:true}});")).await;
    assert!(ok);
    assert!(
        texts(&output).contains("value=\"Blue\""),
        "invalid selection must preserve the selected value"
    );
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.setValue({name}, 'screenshot retained index'); await tab.getScreenshot({{emit:false}});"),
    )
    .await;
    assert!(ok);
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.click({button}); await tab.getAXState({{disableDiffing:true}});"),
    )
    .await;
    assert!(
        ok && texts(&output).contains("screenshot retained index / 你好")
            && texts(&output).contains("cursor arrived: true"),
        "a same-document screenshot must preserve observed element indices: {}",
        texts(&output)
    );
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!(
            "await tab.getAXState(); await tab.goto({});",
            json!(format!("{page}next"))
        ),
    )
    .await;
    assert!(ok);
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.setValue({name}, 'stale');"),
    )
    .await;
    assert!(!ok, "old document reference was reused");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!(
            "await tab.goto({}); await tab.getAXState({{disableDiffing:true}});",
            json!(format!("{page}navigation-race"))
        ),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let arm = index(&texts(&output), "button", "Arm navigation race");
    let target = index(&texts(&output), "button", "Target fixture");
    let (ok, output) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.click({arm}); try {{ await tab.click({target}); throw Error('replacement document received input'); }} catch (error) {{ if (!String(error).includes('stale_document')) throw error; }} await tab.getAXState({{disableDiffing:true}});"),
    ).await;
    assert!(
        ok && texts(&output).contains("Replacement document clean"),
        "{}",
        texts(&output)
    );
    let (ok, output) = evaluate(&repl,bridge.clone(),format!("await cua.cursor.configure({{enabled:false}}); await tab.goto({}); await tab.getAXState({{disableDiffing:true}});",json!(format!("{page}scroll-fixture")))).await;
    assert!(ok, "{}", texts(&output));
    let mut scroll_state = texts(&output);
    for (direction, distance, expected) in [
        ("down", json!(0.5), "Wheel x=0 y=50 "),
        ("right", json!(1), "Wheel x=180 y=0 "),
        ("up", json!(-0.5), "Wheel x=0 y=50 "),
        ("down", json!({"pixels":0.25}), "Wheel x=0 y=0.25 "),
        ("down", json!({"pixels":50001}), "Wheel x=0 y=50001 "),
    ] {
        let target = index(&scroll_state, "region", "Scroll fixture target");
        let (ok, output) = evaluate(
            &repl,
            bridge.clone(),
            format!(
                "await tab.scroll({target},{},{}); await tab.getAXState({{disableDiffing:true}});",
                json!(direction),
                distance
            ),
        )
        .await;
        scroll_state = texts(&output);
        assert!(
            ok && scroll_state.contains(expected) && scroll_state.contains("moved=true"),
            "{scroll_state}"
        );
    }
    let target = index(&scroll_state, "region", "Scroll fixture target");
    let (ok,output)=evaluate(&repl,bridge.clone(),format!("await tab.scroll({target},'down',0); await tab.getAXState(); await tab.getScreenshot({{emit:false}}); await tab.scroll([10,10],'down',0.5); await tab.getAXState({{disableDiffing:true}});")).await;
    assert!(
        ok && texts(&output).contains("ratioY=0.5"),
        "{}",
        texts(&output)
    );
    let (ok,output)=evaluate(&repl,bridge.clone(),"await tab.getAXState(); try { await tab.scroll([10,10],'down',{pixels:0}); throw Error('invalid pixel distance accepted'); } catch(error) { if(!String(error).includes('scroll pixels must be positive and finite')) throw error; }".into()).await;
    assert!(ok, "{}", texts(&output));
    let (ok, _) = evaluate(
        &repl,
        bridge.clone(),
        format!("await tab.getAXState(); await tab.back(); await tab.forward(); await tab.reload(); await tab.getAXState(); const browser=await cua.getBrowser({{id:'fixture'}}); const second=await cua.createBrowserTab(browser.browserId, {}); await second.close(); await tab.close();",json!(format!("{page}second"))),
    )
    .await;
    assert!(ok);
    for (language, recovery) in [
        (Language::En, "bind it again"),
        (Language::ZhCn, "重新绑定标签页"),
        (Language::ZhTw, "重新綁定分頁"),
    ] {
        let localized = Arc::new(Bridge(session.clone(), "browser-fixture", language));
        let (ok, output) = evaluate(&repl, localized,
            "try { await tab.getAXState(); throw Error('closed tab was rebound'); } catch (error) { if (!String(error).includes('stale_tab')) throw error; nodeRepl.write(String(error)); }".into()).await;
        let output = texts(&output);
        assert!(
            ok && output.contains("stale_tab") && output.contains(recovery),
            "{output}"
        );
    }
    let (ok, _) = evaluate(&repl, bridge, "await tab.getAXState();".into()).await;
    assert!(!ok, "closed tab was rebound");
    repl.close().await.unwrap();
    session.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    chrome.kill().await.unwrap();
    let _ = chrome.wait().await;
    logging.abort();
    server.abort();
}

async fn browser_cursor_scenario(
    driver: Arc<Mutex<Driver>>,
    endpoint: String,
    page: &str,
    a: Arc<Bridge>,
    first: &Repl,
) -> String {
    let mut native = Session::new(driver);
    native
        .configure(
            maka_capabilities::computer::Desktop::Local,
            vec![BrowserConnection {
                id: "fixture".into(),
                endpoint,
            }],
            maka_agent_facts::language::Language::En,
        )
        .unwrap();
    let b = Arc::new(Bridge(
        Arc::new(Mutex::new(native)),
        "cursor-browser-b",
        Language::En,
    ));
    let second = Repl::new(facade(), CellLimits::default()).unwrap();
    let (ok,output)=evaluate(first,a.clone(),"await cua.cursor.configure({label:'Maka A',color:'blue',reducedMotion:true}); await tab.getScreenshot();".into()).await;
    assert!(ok, "{}", texts(&output));
    // The screenshot precedes A's first movement. Linux font antialiasing can
    // already contain blue pixels, so compare against this unchanged fixture.
    let background = cursor_colors(&image_bytes(&output));
    let a_cursor = cursor_binding(
        &a,
        json!({"method":"getTab","reference":{"url":page},"options":{}}),
    )
    .await;
    let moved = move_fixture_cursor(&a, &a_cursor, [90, 100]).await.unwrap();
    assert_eq!(moved["visible"], true, "{moved}");
    let (ok,output)=evaluate(&second,b.clone(),format!("await cua.cursor.configure({{label:'Maka B',color:'mint',reducedMotion:true}}); const tab=await cua.getTab({{url:{}}}); await tab.getScreenshot();",json!(page))).await;
    assert!(ok, "{}", texts(&output));
    let b_cursor = cursor_binding(
        &b,
        json!({"method":"getTab","reference":{"url":page},"options":{}}),
    )
    .await;
    let moved = move_fixture_cursor(&b, &b_cursor, [210, 160])
        .await
        .unwrap();
    assert_eq!(moved["visible"], true, "{moved}");
    // Both Sessions remain visible after the old per-action expiry deadline.
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    let (ok, output) = evaluate(first, a.clone(), "await tab.getScreenshot();".into()).await;
    assert!(ok);
    let bytes = image_bytes(&output);
    let (blue, mint) = cursor_colors(&bytes);
    assert!(
        blue > background.0 + 15 && mint > background.1 + 15,
        "both CDP cursor colors must be rendered: blue={blue}, mint={mint}"
    );
    if let Some(path) = std::env::var_os("MAKA_CUA_BROWSER_CURSOR_ARTIFACT") {
        std::fs::write(path, &bytes).unwrap();
    }
    let (ok, output) = evaluate(
        first,
        a.clone(),
        "await cua.cursor.configure({enabled:false}); await tab.getScreenshot();".into(),
    )
    .await;
    assert!(ok);
    let (blue, mint) = cursor_colors(&image_bytes(&output));
    assert!(
        blue == background.0 && mint > background.1 + 15,
        "disabling A must hide only A's cursor: blue={blue}, mint={mint}"
    );
    let (ok, _) = evaluate(
        first,
        a.clone(),
        "await cua.cursor.configure({enabled:true});".into(),
    )
    .await;
    assert!(ok);
    let moved = move_fixture_cursor(&a, &a_cursor, [90, 100]).await.unwrap();
    assert_eq!(moved["visible"], true, "{moved}");
    second.close().await.unwrap();
    b.0.lock().await.close().await.unwrap();
    let (ok, output) = evaluate(first, a.clone(), "await tab.getScreenshot();".into()).await;
    assert!(ok);
    let (blue, mint) = cursor_colors(&image_bytes(&output));
    assert!(
        blue > background.0 + 15 && mint == background.1,
        "closing B must remove only B's cursor: blue={blue}, mint={mint}"
    );
    a.invoke(
        "cua".into(),
        json!({"method":"action","handle":a_cursor,"action":{"kind":"reload"}}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    a.invoke(
        "cua".into(),
        json!({"method":"observe","handle":a_cursor,"kind":"ax","options":{"emit":false}}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let moved = move_fixture_cursor(&a, &a_cursor, [90, 100]).await.unwrap();
    assert_eq!(
        moved["visible"], true,
        "a current browser CSS point needs no screenshot after navigation: {moved}"
    );
    observe_cursor_target(&a, &a_cursor).await;
    let moved = move_fixture_cursor(&a, &a_cursor, [90, 100]).await.unwrap();
    assert_eq!(moved["visible"], true, "{moved}");
    let (ok, output) = evaluate(
        first,
        a,
        "await tab.getScreenshot(); await tab.getAXState({disableDiffing:true});".into(),
    )
    .await;
    assert!(ok, "{}", texts(&output));
    let state = texts(&output);
    assert!(
        !state.contains("Maka A"),
        "the decorative cursor must not enter the accessibility tree"
    );
    state
}
fn image_bytes(output: &[CellOutput]) -> Vec<u8> {
    use base64::Engine;
    let image = output
        .iter()
        .find_map(|part| match part {
            CellOutput::Media { content, .. } => Some(serde_json::to_value(content).unwrap()),
            _ => None,
        })
        .expect("screenshot output");
    base64::engine::general_purpose::STANDARD
        .decode(image["data"].as_str().unwrap())
        .unwrap()
}
fn cursor_colors(bytes: &[u8]) -> (usize, usize) {
    let pixels = tiny_skia::Pixmap::decode_png(bytes).unwrap();
    let blue = pixels
        .pixels()
        .iter()
        .filter(|p| {
            p.blue() > p.red().saturating_add(40) && p.blue() > p.green().saturating_add(20)
        })
        .count();
    let mint = pixels
        .pixels()
        .iter()
        .filter(|p| {
            p.green() > p.red().saturating_add(40) && p.green() > p.blue().saturating_add(10)
        })
        .count();
    (blue, mint)
}
