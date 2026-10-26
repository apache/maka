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

#![cfg(all(feature = "native-desktop", target_os = "linux"))]

use cua_driver_core::browser::cdp_ws::CdpConnection;
use maka_agent_facts::{language::Language, tools::ToolError};
use maka_capabilities::computer::{BrowserConnection, Desktop};
use maka_computer_use::{Driver, InvocationContext, Session, SessionOwner};
use serde_json::{Value, json};
use std::{collections::BTreeSet, process::Stdio, sync::Arc, time::Duration};
use tokio::{io::AsyncBufReadExt, io::AsyncWriteExt, io::BufReader, sync::Mutex};
use tokio_util::sync::CancellationToken;
use x11rb::protocol::xproto::ConnectionExt as _;

#[path = "fixtures/linux_wheel.rs"]
mod linux_wheel;

async fn call(session: &mut Session, actor: &str, command: Value) -> Result<Value, ToolError> {
    session
        .invoke(
            serde_json::from_value(command).unwrap(),
            &InvocationContext::new(actor, "composition-turn"),
            &CancellationToken::new(),
            Language::En,
        )
        .await
}

fn assert_click(events: &[linux_wheel::ObservedEvent], window: u32) {
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(events[0].press && !events[1].press, "{events:?}");
    for event in events {
        assert_eq!(event.event, window, "{events:?}");
        assert_eq!(event.detail, 1, "{events:?}");
        assert_eq!((event.event_x, event.event_y), (37, 41), "{events:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires a disposable X11 desktop and D-Bus; owns 65 real fixture windows in a separate process"]
async fn native_binds_more_than_sixty_four_real_windows_without_eviction_and_releases_epoch() {
    let mut fixture = linux_wheel::Window::new().await;
    let mut windows = vec![fixture.id];
    for _ in 1..65 {
        windows.push(fixture.sibling().await);
    }
    assert_eq!(windows.iter().copied().collect::<BTreeSet<_>>().len(), 65);
    let driver = Arc::new(Mutex::new(Driver::default()));
    let owner = SessionOwner::new(driver.clone());
    let mut session = owner.new_epoch().unwrap();
    session
        .configure(Desktop::Local, vec![], Language::En)
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let listed = call(
            &mut session,
            "native-composition",
            json!({"method":"listWindows","options":{}}),
        )
        .await
        .unwrap();
        if windows.iter().all(|window| {
            listed
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["id"] == *window && item["isOnScreen"] == true)
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "owned windows not all visible: {listed}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut handles = Vec::new();
    for window in &windows {
        let bound = call(
            &mut session,
            "native-composition",
            json!({"method":"getApp","target":{"windowId":window}}),
        )
        .await
        .unwrap();
        assert_eq!(bound["binding"]["windowId"], *window);
        handles.push(bound["handle"].clone());
    }
    assert_eq!(
        handles
            .iter()
            .map(Value::to_string)
            .collect::<BTreeSet<_>>()
            .len(),
        65
    );
    fixture.events().await;
    for (handle, window) in handles.iter().zip(&windows) {
        call(
            &mut session,
            "native-composition",
            json!({"method":"action","handle":handle,"action":{"kind":"click","target":[37,41],"options":{}}}),
        )
        .await
        .unwrap();
        let events = fixture.events_for(*window).await;
        eprintln!(
            "MAKA_NATIVE_COMPOSITION_EVENTS {}",
            json!({"window":window,"events":events})
        );
        assert_click(&events, *window);
    }
    fixture.close().await;
    let refused = call(
        &mut session,
        "native-composition",
        json!({"method":"action","handle":handles[0],"action":{"kind":"click","target":[37,41],"options":{}}}),
    )
    .await;
    assert!(matches!(refused, Err(ToolError::Failed(message)) if message.contains("stale_target")));
    for window in windows.iter().skip(1) {
        assert!(fixture.events_for(*window).await.is_empty());
    }
    call(
        &mut session,
        "native-composition",
        json!({"method":"action","handle":handles[64],"action":{"kind":"click","target":[37,41],"options":{}}}),
    )
    .await
    .unwrap();
    assert_click(&fixture.events_for(windows[64]).await, windows[64]);

    session.close_native().await.unwrap();
    let closed = call(
        &mut session,
        "native-composition",
        json!({"method":"action","handle":handles[64],"action":{"kind":"click","target":[37,41],"options":{}}}),
    )
    .await;
    assert!(matches!(closed, Err(ToolError::Failed(message)) if message.contains("closed")));
    let mut fresh = owner.new_epoch().unwrap();
    fresh
        .configure(Desktop::Local, vec![], Language::En)
        .unwrap();
    for handle in &handles {
        let stale = call(
            &mut fresh,
            "native-composition",
            json!({"method":"action","handle":handle,"action":{"kind":"click","target":[37,41],"options":{}}}),
        )
        .await;
        assert!(
            matches!(stale, Err(ToolError::Failed(message)) if message.contains("stale_target"))
        );
    }
    for window in windows.iter().skip(1) {
        assert!(fixture.events_for(*window).await.is_empty());
    }
    let rebound = call(
        &mut fresh,
        "native-composition",
        json!({"method":"getApp","target":{"windowId":windows[64]}}),
    )
    .await
    .unwrap();
    call(&mut fresh, "native-composition", json!({"method":"action","handle":rebound["handle"],"action":{"kind":"click","target":[37,41],"options":{}}})).await.unwrap();
    assert_click(&fixture.events_for(windows[64]).await, windows[64]);
    fresh.close_native().await.unwrap();
    owner.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    let (observer, _) = x11rb::connect(None).unwrap();
    for window in windows.iter().skip(1) {
        let geometry = observer.get_geometry(*window).unwrap().reply().unwrap();
        assert_eq!((geometry.width, geometry.height), (320, 240));
    }
    eprintln!(
        "MAKA_NATIVE_COMPOSITION {}",
        json!({"bound_windows":65,"exact_click_pairs":65,"surviving_windows_after_cleanup":64,"retired_handles_refused":65})
    );
    fixture.finish().await;
}

async fn visible_cursors(observer: &CdpConnection, page_session: &str) -> u64 {
    observer.call(Some(page_session), "Runtime.evaluate", json!({
        "expression":"Array.from(document.querySelectorAll('[popover][aria-hidden=true]')).filter(host => host.isConnected && host.matches(':popover-open') && host.style.display !== 'none').length",
        "returnByValue":true,
    })).await.unwrap()["result"]["value"].as_u64().unwrap()
}

async fn cursor_entries(observer: &CdpConnection, page_session: &str) -> Value {
    let tree = observer
        .call(Some(page_session), "Page.getFrameTree", json!({}))
        .await
        .unwrap();
    let world = observer.call(Some(page_session), "Page.createIsolatedWorld", json!({
        "frameId":tree["frameTree"]["frame"]["id"],"worldName":"maka-cua-cursor","grantUniveralAccess":false,
    })).await.unwrap();
    let result = observer.call(Some(page_session), "Runtime.evaluate", json!({
        "contextId":world["executionContextId"],
        "expression":"Object.fromEntries(Array.from(globalThis.__makaCursorRegistry ?? [], ([id, entry]) => [id, {retired:entry.retired === true,point:entry.point}]))",
        "returnByValue":true,
    })).await.unwrap();
    assert!(result.get("exceptionDetails").is_none(), "{result}");
    result["result"]["value"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; starts an isolated temporary headless profile and 65 logical cursor owners"]
async fn browser_composes_more_than_sixty_four_cursor_owners_and_finalizes_each_owner() {
    let executable = std::env::var("MAKA_CUA_TEST_CHROME").unwrap();
    let profile = tempfile::tempdir().unwrap();
    let mut chrome = tokio::process::Command::new(executable)
        .args([
            "--headless=new",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-port=0",
            "--disable-gpu",
            "--password-store=basic",
        ])
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(chrome.stderr.take().unwrap()).lines();
    let websocket = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(endpoint) = line.strip_prefix("DevTools listening on ") {
                return endpoint.to_owned();
            }
        }
        panic!("isolated Chrome did not expose its test endpoint");
    })
    .await
    .unwrap();
    let logging =
        tokio::spawn(async move { while lines.next_line().await.ok().flatten().is_some() {} });
    let observer = CdpConnection::connect_bounded(&websocket, usize::MAX)
        .await
        .unwrap();
    let mut events = observer.subscribe();
    observer
        .call(None, "Target.setDiscoverTargets", json!({"discover":true}))
        .await
        .unwrap();
    let page = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let targets = observer
                .call(None, "Target.getTargets", json!({}))
                .await
                .unwrap();
            if let Some(target) = targets["targetInfos"]
                .as_array()
                .unwrap()
                .iter()
                .find(|target| target["type"] == "page" && target["url"] == "about:blank")
            {
                return target["targetId"].as_str().unwrap().to_owned();
            }
            events.recv().await.expect("fixture target discovery ended");
        }
    })
    .await
    .unwrap();
    let attached = observer
        .call(
            None,
            "Target.attachToTarget",
            json!({"targetId":page,"flatten":true}),
        )
        .await
        .unwrap();
    let page_session = attached["sessionId"].as_str().unwrap();
    observer
        .call(Some(page_session), "Page.enable", json!({}))
        .await
        .unwrap();
    observer
        .call(Some(page_session), "Runtime.enable", json!({}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let ready = observer.call(Some(page_session), "Runtime.evaluate", json!({"expression":"document.readyState==='complete' && location.href==='about:blank'","returnByValue":true})).await.unwrap();
            if ready["result"]["value"] == true { break; }
            events.recv().await.expect("fixture readiness event stream ended");
        }
    }).await.unwrap();
    let port = reqwest::Url::parse(&websocket).unwrap().port().unwrap();
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut live = Vec::new();
    let mut ids = Vec::new();
    for index in 0..65 {
        let owner = SessionOwner::new(driver.clone());
        let mut session = owner.new_epoch().unwrap();
        session
            .configure(
                Desktop::Local,
                vec![BrowserConnection {
                    id: "fixture".into(),
                    endpoint: format!("http://127.0.0.1:{port}"),
                }],
                Language::En,
            )
            .unwrap();
        let configured = call(
            &mut session,
            "cursor-composition",
            json!({"method":"configureCursor","options":{"enabled":true,"reducedMotion":true}}),
        )
        .await
        .unwrap();
        ids.push(configured["settings"]["id"].as_str().unwrap().to_owned());
        let bound = call(&mut session, "cursor-composition", json!({"method":"browserTab","browserId":"fixture","reference":{"kind":"existing","id":page}})).await.unwrap();
        call(&mut session, "cursor-composition", json!({"method":"observe","handle":bound["handle"],"kind":"both","options":{"emit":false}})).await.unwrap();
        let moved = call(&mut session, "cursor-composition", json!({"method":"action","handle":bound["handle"],"action":{"kind":"moveCursor","target":[10+index,20]}})).await.unwrap();
        assert_eq!(moved["visible"], true, "owner {index}: {moved}");
        assert_eq!(
            moved["requestedPosition"][0].as_f64(),
            Some(f64::from(10 + index))
        );
        assert_eq!(moved["requestedPosition"][1].as_f64(), Some(20.0));
        live.push((owner, session));
    }
    assert_eq!(ids.iter().collect::<BTreeSet<_>>().len(), 65);
    assert_eq!(visible_cursors(&observer, page_session).await, 65);
    let entries = cursor_entries(&observer, page_session).await;
    eprintln!("MAKA_CURSOR_COMPOSITION_ENTRIES {entries}");
    assert_eq!(entries.as_object().unwrap().len(), 65);
    for (index, id) in ids.iter().enumerate() {
        assert_eq!(entries[id]["point"][0].as_f64(), Some((10 + index) as f64));
        assert_eq!(entries[id]["point"][1].as_f64(), Some(20.0));
        assert_eq!(entries[id]["retired"], false);
    }
    live[0].1.close_native().await.unwrap();
    assert_eq!(visible_cursors(&observer, page_session).await, 64);
    let retired = cursor_entries(&observer, page_session).await;
    assert_eq!(retired.as_object().unwrap().len(), 65);
    assert_eq!(retired[&ids[0]]["retired"], true);
    live[0].0.close().await.unwrap();
    let remaining = cursor_entries(&observer, page_session).await;
    assert_eq!(remaining.as_object().unwrap().len(), 64);
    assert!(remaining.get(&ids[0]).is_none());
    assert_eq!(remaining[&ids[64]]["point"][0].as_f64(), Some(74.0));
    assert_eq!(visible_cursors(&observer, page_session).await, 64);
    for (owner, session) in live.iter_mut().skip(1) {
        session.close_native().await.unwrap();
        owner.close().await.unwrap();
    }
    assert_eq!(visible_cursors(&observer, page_session).await, 0);
    assert_eq!(cursor_entries(&observer, page_session).await, json!({}));
    let final_targets = observer
        .call(None, "Target.getTargets", json!({}))
        .await
        .unwrap();
    assert!(
        final_targets["targetInfos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|target| target["targetId"] == page),
        "cleanup closed the user fixture tab: {final_targets}"
    );
    eprintln!(
        "MAKA_CURSOR_COMPOSITION {}",
        json!({"simultaneous_owners":65,"visible_before_cleanup":65,"visible_after_first_retire":64,"metadata_after_first_finalize":64,"visible_after_all_finalize":0,"metadata_after_all_finalize":0,"user_tab_preserved":true})
    );
    driver.lock().await.close().await.unwrap();
    observer
        .call(
            None,
            "Target.detachFromTarget",
            json!({"sessionId":page_session}),
        )
        .await
        .unwrap();
    chrome.kill().await.unwrap();
    chrome.wait().await.unwrap();
    logging.abort();
}

async fn renderer_call(
    input: &mut tokio::process::ChildStdin,
    output: &mut BufReader<tokio::process::ChildStdout>,
    request: Value,
) -> Value {
    let started = std::time::Instant::now();
    eprintln!(
        "MAKA_NATIVE_CURSOR_REQUEST {}",
        json!({"kind":request["kind"],"id":request.get("id").or_else(||request["cursor"].get("id")),"unix_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()})
    );
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    input.write_all(&bytes).await.unwrap();
    let mut response = String::new();
    assert_ne!(output.read_line(&mut response).await.unwrap(), 0);
    let response: Value = serde_json::from_str(&response).unwrap();
    eprintln!(
        "MAKA_NATIVE_CURSOR_REPLY {}",
        json!({"kind":request["kind"],"id":request.get("id").or_else(||request["cursor"].get("id")),"elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"response":response})
    );
    assert_eq!(response["kind"], "render", "{response}");
    assert_eq!(response["state"]["status"], "ready", "{response}");
    response["state"].clone()
}

fn digest_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

struct CursorPixels {
    connection: x11rb::rust_connection::RustConnection,
    root: u32,
    background: u32,
    background_rgb: [u8; 3],
    depth: u8,
    visual: x11rb::protocol::xproto::Visualtype,
    format: x11rb::protocol::xproto::Format,
    byte_order: x11rb::protocol::xproto::ImageOrder,
    points: Vec<[u16; 2]>,
}

impl CursorPixels {
    fn new() -> Self {
        use x11rb::{connection::Connection, protocol::xproto::*, wrapper::ConnectionExt as _};
        let (connection, screen_index) = x11rb::connect(None).unwrap();
        let setup = connection.setup();
        let screen = &setup.roots[screen_index];
        assert!(
            screen.width_in_pixels >= 1440 && screen.height_in_pixels >= 900,
            "fixture requires its isolated1440x900 display"
        );
        let root = screen.root;
        let depth = screen.root_depth;
        let visual = *screen
            .allowed_depths
            .iter()
            .flat_map(|depth| &depth.visuals)
            .find(|visual| visual.visual_id == screen.root_visual)
            .unwrap();
        assert_eq!(visual.class, VisualClass::TRUE_COLOR);
        let format = *setup
            .pixmap_formats
            .iter()
            .find(|format| format.depth == depth)
            .unwrap();
        assert!(matches!(format.bits_per_pixel, 16 | 24 | 32));
        assert!(matches!(format.scanline_pad, 8 | 16 | 32));
        let byte_order = setup.image_byte_order;
        assert!(matches!(
            byte_order,
            ImageOrder::LSB_FIRST | ImageOrder::MSB_FIRST
        ));
        let masks = [visual.red_mask, visual.green_mask, visual.blue_mask];
        for mask in masks {
            assert_ne!(mask, 0);
            let shifted = mask >> mask.trailing_zeros();
            assert_eq!(shifted & (shifted + 1), 0, "noncontiguous RGB mask");
        }
        assert_eq!(
            masks[0] & masks[1] | masks[0] & masks[2] | masks[1] & masks[2],
            0
        );
        let color = connection
            .alloc_color(screen.default_colormap, 0x2020, 0x3030, 0x2020)
            .unwrap()
            .reply()
            .unwrap();
        let background_rgb = [
            Self::channel(color.pixel, visual.red_mask),
            Self::channel(color.pixel, visual.green_mask),
            Self::channel(color.pixel, visual.blue_mask),
        ];
        let background = connection.generate_id().unwrap();
        connection
            .create_window(
                depth,
                background,
                root,
                0,
                0,
                screen.width_in_pixels,
                screen.height_in_pixels,
                0,
                WindowClass::INPUT_OUTPUT,
                visual.visual_id,
                &CreateWindowAux::new()
                    .background_pixel(color.pixel)
                    .override_redirect(1u32),
            )
            .unwrap()
            .check()
            .unwrap();
        connection
            .change_property8(
                PropMode::REPLACE,
                background,
                AtomEnum::WM_NAME,
                AtomEnum::STRING,
                b"Maka owned cursor count background",
            )
            .unwrap()
            .check()
            .unwrap();
        connection.map_window(background).unwrap().check().unwrap();
        connection.flush().unwrap();
        let points: Vec<_> = (0..65u16)
            .map(|index| [80 + (index % 13) * 100, 80 + (index / 13) * 120])
            .collect();
        for (index, a) in points.iter().enumerate() {
            for b in points.iter().skip(index + 1) {
                assert!(
                    a[0] + 80 <= b[0]
                        || b[0] + 80 <= a[0]
                        || a[1] + 96 <= b[1]
                        || b[1] + 96 <= a[1]
                );
            }
        }
        eprintln!(
            "MAKA_NATIVE_CURSOR_PIXEL_FORMAT {}",
            json!({"root":root,"background_window":background,"background_pixel":color.pixel,"background_rgb16":[color.red,color.green,color.blue],"background_rgb8":background_rgb,"depth":depth,"visual":visual.visual_id,"rgb_masks":masks,"bits_per_pixel":format.bits_per_pixel,"scanline_pad":format.scanline_pad,"image_byte_order":u8::from(byte_order),"roi_size":[80,96],"roi_offset":[-16,-16],"points":points})
        );
        Self {
            connection,
            root,
            background,
            background_rgb,
            depth,
            visual,
            format,
            byte_order,
            points,
        }
    }

    fn channel(pixel: u32, mask: u32) -> u8 {
        let scale = mask >> mask.trailing_zeros();
        let value = (pixel & mask) >> mask.trailing_zeros();
        ((u64::from(value) * 255) / u64::from(scale)) as u8
    }

    fn theme_blue(&self) -> [u8; 3] {
        let mut rgb = [0; 3];
        for ((out, value), mask) in rgb.iter_mut().zip([102u8, 158, 255]).zip([
            self.visual.red_mask,
            self.visual.green_mask,
            self.visual.blue_mask,
        ]) {
            let scale = mask >> mask.trailing_zeros();
            let quantized = (u64::from(value) * u64::from(scale) + 127) / 255;
            *out = ((quantized * 255) / u64::from(scale)) as u8;
        }
        rgb
    }

    fn capture(&self) -> Vec<Vec<[u8; 3]>> {
        use x11rb::protocol::xproto::*;
        let stride = ((80usize * usize::from(self.format.bits_per_pixel))
            .div_ceil(usize::from(self.format.scanline_pad))
            * usize::from(self.format.scanline_pad))
            / 8;
        let bytes_per_pixel = usize::from(self.format.bits_per_pixel) / 8;
        self.points
            .iter()
            .map(|point| {
                let image = self
                    .connection
                    .get_image(
                        ImageFormat::Z_PIXMAP,
                        self.root,
                        (point[0] - 16) as i16,
                        (point[1] - 16) as i16,
                        80,
                        96,
                        u32::MAX,
                    )
                    .unwrap()
                    .reply()
                    .unwrap();
                assert_eq!(image.depth, self.depth);
                assert_eq!(image.visual, self.visual.visual_id);
                assert_eq!(image.data.len(), stride * 96);
                let mut rgb = Vec::with_capacity(80 * 96);
                for row in image.data.chunks_exact(stride) {
                    for bytes in row[..80 * bytes_per_pixel].chunks_exact(bytes_per_pixel) {
                        let pixel = if self.byte_order == ImageOrder::LSB_FIRST {
                            bytes.iter().enumerate().fold(0u32, |pixel, (index, byte)| {
                                pixel | (u32::from(*byte) << (8 * index))
                            })
                        } else {
                            bytes
                                .iter()
                                .fold(0u32, |pixel, byte| (pixel << 8) | u32::from(*byte))
                        };
                        rgb.push([
                            Self::channel(pixel, self.visual.red_mask),
                            Self::channel(pixel, self.visual.green_mask),
                            Self::channel(pixel, self.visual.blue_mask),
                        ]);
                    }
                }
                rgb
            })
            .collect()
    }

    fn overlay(&self) -> Option<u32> {
        use x11rb::{errors::ReplyError, protocol::ErrorKind, protocol::xproto::*};
        let mut overlays = Vec::new();
        for window in self
            .connection
            .query_tree(self.root)
            .unwrap()
            .reply()
            .unwrap()
            .children
        {
            let name = match self
                .connection
                .get_property(false, window, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 256)
                .unwrap()
                .reply()
            {
                Ok(name) => name,
                Err(ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Window => {
                    continue;
                }
                Err(error) => panic!("window name query failed: {error}"),
            };
            if name.value == b"Cua.AgentCursorOverlay.default" {
                overlays.push(window);
            }
        }
        assert!(
            overlays.len() <= 1,
            "unexpected shared overlay windows: {overlays:?}"
        );
        overlays.first().copied()
    }

    fn report(
        &self,
        phase: &str,
        baseline: &[Vec<[u8; 3]>],
        actual: &[Vec<[u8; 3]>],
    ) -> Vec<usize> {
        let blue = self.theme_blue();
        let hits: Vec<_> = actual
            .iter()
            .zip(baseline)
            .map(|(pixels, before)| {
                pixels
                    .iter()
                    .zip(before)
                    .filter(|(pixel, original)| **pixel == blue && *pixel != *original)
                    .count()
            })
            .collect();
        let hashes: Vec<_> = actual
            .iter()
            .map(|pixels| digest_bytes(&pixels.iter().flatten().copied().collect::<Vec<_>>()))
            .collect();
        let restored: Vec<_> = actual
            .iter()
            .zip(baseline)
            .map(|(now, before)| now == before)
            .collect();
        eprintln!(
            "MAKA_NATIVE_CURSOR_PIXELS {}",
            json!({"phase":phase,"theme_rgb":blue,"occupied_rois":hits.iter().filter(|count|**count>0).count(),"blue_pixel_counts":hits,"matches_baseline":restored,"rgb_sha256":hashes})
        );
        hits
    }

    async fn expect(&self, phase: &str, baseline: &[Vec<[u8; 3]>], expected: &[bool]) {
        let deadline = std::time::Instant::now() + Duration::from_millis(400);
        loop {
            let actual = self.capture();
            let blue = self.theme_blue();
            let hits: Vec<_> = actual
                .iter()
                .zip(baseline)
                .map(|(pixels, before)| {
                    pixels
                        .iter()
                        .zip(before)
                        .any(|(pixel, original)| *pixel == blue && pixel != original)
                })
                .collect();
            let valid = hits.as_slice() == expected
                && actual
                    .iter()
                    .zip(baseline)
                    .zip(expected)
                    .all(|((now, before), visible)| *visible || now == before);
            if valid && std::time::Instant::now() <= deadline {
                self.report(phase, baseline, &actual);
                return;
            }
            if std::time::Instant::now() >= deadline {
                use base64::Engine as _;
                self.report(phase, baseline, &actual);
                for (index, ((pixels, before), visible)) in
                    actual.iter().zip(baseline).zip(expected).enumerate()
                {
                    if hits[index] != *visible || (!visible && pixels != before) {
                        eprintln!(
                            "MAKA_NATIVE_CURSOR_FAILED_ROI {}",
                            json!({"phase":phase,"index":index,"point":self.points[index],"expected_visible":visible,"rgb_base64":base64::engine::general_purpose::STANDARD.encode(pixels.iter().flatten().copied().collect::<Vec<_>>()),"baseline_rgb_base64":base64::engine::general_purpose::STANDARD.encode(before.iter().flatten().copied().collect::<Vec<_>>())})
                        );
                    }
                }
                panic!(
                    "actual shared-surface pixels did not match {phase} within the existing400ms renderer bound"
                );
            }
            tokio::task::yield_now().await;
        }
    }
}

impl Drop for CursorPixels {
    fn drop(&mut self) {
        use x11rb::{connection::Connection, protocol::xproto::ConnectionExt as _};
        let _ = self.connection.destroy_window(self.background);
        let _ = self.connection.flush();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_HOST and a disposable1440x900 X11 desktop; counts65 real cursors on its shared overlay"]
async fn native_renderer_composes_more_than_sixty_four_cursors_and_eof_releases_surfaces() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let executable =
        std::env::var_os("MAKA_CUA_TEST_HOST").expect("set the built Maka host executable");
    let pixels = CursorPixels::new();
    assert!(
        pixels.overlay().is_none(),
        "fixture must start without another helper's overlay"
    );
    let baseline = pixels.capture();
    assert!(
        baseline
            .iter()
            .flatten()
            .all(|rgb| *rgb == pixels.background_rgb),
        "task-owned background must be painted before baseline"
    );
    pixels.report("baseline", &baseline, &baseline);
    let themes = tempfile::tempdir().unwrap();
    let theme_started = std::time::Instant::now();
    let theme = maka_computer_use::cursor::theme::compiled(maka_computer_use::cursor::Color::Blue);
    let bytes = cursor_overlay::encode_theme(&theme).unwrap();
    let decoded = cursor_overlay::decode_theme(&bytes).unwrap();
    assert_eq!(decoded.id, "org.apache.maka.cursor.blue");
    let path = themes.path().join(format!("{}.cua-theme", theme.id));
    std::fs::write(&path, &bytes).unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    eprintln!(
        "MAKA_NATIVE_CURSOR_THEME {}",
        json!({"path":path,"bytes":bytes.len(),"sha256":digest_bytes(&bytes),"id":decoded.id,"profile":decoded.profile,"file_uid":metadata.uid(),"file_gid":metadata.gid(),"file_mode":metadata.permissions().mode(),"encode_decode_write_ms":theme_started.elapsed().as_secs_f64()*1000.0})
    );
    let mut renderer = tokio::process::Command::new(executable)
        .arg("__maka-cua-cursor")
        .env("CUA_DRIVER_CURSOR_THEME_DIR", themes.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let renderer_pid = renderer.id().unwrap();
    let mut input = renderer.stdin.take().unwrap();
    let mut output = BufReader::new(renderer.stdout.take().unwrap());
    let ids: Vec<_> = (0..65).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    assert_eq!(ids.iter().collect::<BTreeSet<_>>().len(), 65);
    for (index, id) in ids.iter().enumerate() {
        let point = pixels.points[index];
        let state=renderer_call(&mut input,&mut output,json!({"kind":"update","cursor":{"id":id,"label":format!("Owner {index}"),"color":"blue","enabled":true,"reducedMotion":true},"point":point,"action":"idle","window":null})).await;
        assert_eq!(state["visible"], true, "owner {index}: {state}");
        assert_eq!(state["rendererPid"].as_u64(), Some(u64::from(renderer_pid)));
        assert_eq!(
            state["requestedPosition"][0].as_f64(),
            Some(f64::from(point[0]))
        );
        assert_eq!(
            state["requestedPosition"][1].as_f64(),
            Some(f64::from(point[1]))
        );
        assert_eq!(state["theme"], "org.apache.maka.cursor.blue");
    }
    let shared = pixels
        .overlay()
        .expect("actual shared native overlay must exist");
    pixels.expect("all65", &baseline, &[true; 65]).await;
    let removed = renderer_call(
        &mut input,
        &mut output,
        json!({"kind":"remove","id":ids[0]}),
    )
    .await;
    assert_eq!(removed["visible"], false);
    assert!(removed.get("requestedPosition").is_none());
    assert!(removed.get("theme").is_none());
    let mut remaining = [true; 65];
    remaining[0] = false;
    pixels
        .expect("after_first_remove64", &baseline, &remaining)
        .await;
    for id in ids.iter().skip(1) {
        let state = renderer_call(&mut input, &mut output, json!({"kind":"remove","id":id})).await;
        assert_eq!(state["visible"], false);
        assert!(state.get("requestedPosition").is_none());
    }
    pixels
        .expect("after_all_remove0", &baseline, &[false; 65])
        .await;
    assert_eq!(
        pixels.overlay(),
        Some(shared),
        "logical cursor cleanup must preserve its shared renderer until EOF"
    );
    drop(input);
    let status = tokio::time::timeout(Duration::from_secs(10), renderer.wait())
        .await
        .expect("renderer must exit after EOF")
        .unwrap();
    assert!(status.success(), "{status}");
    assert!(
        pixels.overlay().is_none(),
        "shared overlay window must disappear after EOF"
    );
    pixels.expect("after_eof0", &baseline, &[false; 65]).await;
    eprintln!(
        "MAKA_NATIVE_CURSOR_COMPOSITION {}",
        json!({"simultaneous_cursors":65,"shared_x11_windows":1,"independent_blue_rois":65,"after_first_remove":64,"after_all_remove":0,"after_eof_windows":0,"renderer_exit_success":true,"scope":"occupancy and lifecycle, not full artwork fidelity"})
    );
}
