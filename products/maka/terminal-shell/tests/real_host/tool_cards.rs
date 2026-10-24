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

use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn readable_tool_cards_preserve_paged_originals_across_workspace_changes_and_resize() {
    use base64::Engine as _;
    use nsh_platform_tui::ServiceOutput;
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::files("readText").await;
        let client = fixture.client().await;
        let path = fixture.directory.path().join("workspace/recorded.txt");
        // Cross the 8192 UTF-8-byte source boundary while staying inside the
        // real tool's 7500 UTF-16-unit model page, including its JSON envelope.
        let line = format!("{}😀\n", "中文".repeat(10));
        let original = format!("起点_原始\r\n\t保留空格  \r\n{}终点_原始\r\n\r\n", line.repeat(200));
        assert!(original.len() > 8192, "the real result must require multiple source pages");
        std::fs::write(&path, &original).unwrap();
        let sent = support::mutate(&client, "send", json!({
            "sessionId":fixture.session, "message":"Read the recorded document", "model":fixture.selection,
        })).await;
        assert_eq!(sent["kind"], "started", "{sent}");
        fixture.next_request().await.tool("WorkspaceDocument", json!({"path":"recorded.txt"})).await;
        let mut continuation = fixture.next_request().await;
        let tool_result = continuation.body["messages"].as_array().unwrap()
            .iter().rev().find(|message| message["role"] == "tool").unwrap()["content"]
            .as_str().unwrap();
        let result: Value = serde_json::from_str(tool_result)
            .unwrap_or_else(|error| panic!("actual readText tool result was not JSON: {error}: {tool_result}"));
        assert_eq!(result["kind"], "completed", "{result}");
        assert_eq!(result["value"]["content"], original);
        // The card must use the original Host source rather than reopen this path.
        std::fs::write(&path, "CHANGED_CURRENT_WORKSPACE").unwrap();

        let (mut view, bindings) = fixture.view(fixture.client().await, Some(fixture.session.clone()));
        view.surface_mut().set_host_services_enabled(true);
        view.resize(120, 40);
        wait_enabled_node(&mut view, "Process group").await;
        support::focus_activity(&mut view).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        support::click_button(&mut view, "Toggle tool WorkspaceDocument").await;
        let readable = wait_view(&mut view, |screen| screen.contains("Read lines") && screen.contains("起点_原始")).await;
        // The native accessibility bridge filters CR controls, retaining LF
        // and tabs. Byte-exact source preservation is checked by Copy below.
        let accessible_original = original.replace('\r', "");
        let text = view.accessibility_snapshot().into_iter()
            .find(|node| node.label == accessible_original)
            .expect("the readable native Text must include both ends of the original paged result");
        assert!(!text.label.contains("CHANGED_CURRENT_WORKSPACE"));
        view.drain_service_output().for_each(drop);
        let copy = support::wait_enabled_button(&mut view, "Copy read contents").await.id;
        support::click_button(&mut view, "Copy read contents").await;
        let copied_screen = wait_view_state(&mut view, |view, screen| screen.contains("Copied") && screen.contains("起点_原始") && view.accessibility_snapshot().iter().any(|node| node.id == copy && node.focused && !node.state.disabled)).await;
        let clipboard = view.drain_service_output().filter(|effect| matches!(effect, ServiceOutput::Clipboard(_))).collect::<Vec<_>>();
        assert_eq!(clipboard.len(), 1, "one read copy must emit one native clipboard effect");
        let ServiceOutput::Clipboard(copied) = &clipboard[0] else { unreachable!() };
        assert_eq!(copied.as_bytes(), original.as_bytes(), "copy must preserve the complete captured range without line-number chrome or current workspace contents");
        let sequence = clipboard[0].terminal_sequence(false);
        let payload = sequence.strip_prefix("\u{1b}]52;c;").and_then(|sequence| sequence.strip_suffix("\u{1b}\\")).expect("read copy must encode one complete OSC52 command");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(payload).unwrap(), original.as_bytes());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2, "copying the recorded range must not run the model or tool again");
        evidence("tool-read-paged-original", &readable);

        // The original-data action is now an icon. Check its real enabled
        // native target and complete frame rather than former link text.
        let original_visible = |view: &AppView| {
            let viewport = view.surface().viewport();
            view.accessibility_snapshot().iter().any(|node| {
                let frame = node.frame;
                node.role == nsh_core::AccessibilityRole::Button
                    && node.label == "Toggle original tool details"
                    && !node.state.disabled
                    && frame.size.width.0 > 0.0 && frame.size.height.0 > 0.0
                    && frame.origin.x.0 >= 0.0 && frame.origin.y.0 >= 0.0
                    && frame.origin.x.0 + frame.size.width.0 <= viewport.width.0
                    && frame.origin.y.0 + frame.size.height.0 <= viewport.height.0
            })
        };

        // Large originals scroll inside the card while its disclosure and
        // original-details action remain visible in the turn's own viewport.
        let before_wheel = view.accessibility_snapshot();
        let text_before = before_wheel.iter().find(|node| node.id == text.id && node.label == accessible_original)
            .expect("the same complete original Text must remain mounted after Copy");
        let chrome_before = ["Tool details", "Toggle tool WorkspaceDocument", "Toggle original tool details"]
            .map(|label| before_wheel.iter().find(|node| node.label == label).expect("the open tool reader chrome must be present"));
        support::scroll_snapshot_text(&mut view, &copied_screen, "起点_原始", MouseEventKind::ScrollDown);
        wait_view_state(&mut view, |view, screen| {
            let nodes = view.accessibility_snapshot();
            let Some(text_after) = nodes.iter().find(|node| node.id == text_before.id && node.label == accessible_original) else { return false; };
            if text_after.frame.origin.y.0 >= text_before.frame.origin.y.0 { return false; }
            assert_eq!(text_after.frame.origin.x, text_before.frame.origin.x, "one vertical wheel must preserve the original Text column");
            assert_eq!(text_after.frame.size, text_before.frame.size, "scrolling must preserve the complete original Text's layout");
            let viewport = view.surface().viewport();
            for before in chrome_before {
                let after = nodes.iter().find(|node| node.id == before.id && node.label == before.label)
                    .expect("inner reading must preserve the same tool reader chrome");
                assert_eq!(after.frame, before.frame, "inner reading must not move outer chrome {:?}", before.label);
                assert!(after.frame.size.width.0 > 0.0 && after.frame.size.height.0 > 0.0
                    && after.frame.origin.x.0 >= 0.0 && after.frame.origin.y.0 >= 0.0
                    && after.frame.origin.x.0 + after.frame.size.width.0 <= viewport.width.0
                    && after.frame.origin.y.0 + after.frame.size.height.0 <= viewport.height.0,
                    "tool reader chrome must remain visible: {:?} {:?}", after.label, after.frame);
            }
            screen.contains("Read file") && original_visible(view)
        }).await;
        assert!(support::wait_enabled_button(&mut view, "Toggle tool WorkspaceDocument").await.state.selected);
        tab_to_label(&mut view, "Tool details").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        let tail = wait_view(&mut view, |screen| screen.contains("终点_原始")).await;
        assert!(tail.contains("Read file") && original_visible(&view));
        assert!(support::wait_enabled_button(&mut view, "Toggle tool WorkspaceDocument").await.state.selected);
        evidence("tool-read-local-scroll-tail", &tail);
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("Read lines") && screen.contains("起点_原始")).await;

        // This switch shares the mounted reader; the literal JSON is still the exact result.
        support::click_button(&mut view, "Toggle original tool details").await;
        wait_view(&mut view, |screen| screen.contains("Original result")).await;
        let raw = view.accessibility_snapshot().into_iter().find_map(|node| {
            serde_json::from_str::<Value>(&node.label).ok().filter(|value| value == &result)
        });
        assert_eq!(raw, Some(result));
        view.resize(80, 24);
        support::focus_activity(&mut view).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("Read file")).await;
        assert!(support::wait_enabled_button(&mut view, "Toggle tool WorkspaceDocument").await.state.selected);
        tab_to_label(&mut view, "Toggle tool WorkspaceDocument").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let collapsed = wait_view(&mut view, |screen| screen.contains("Read file") && !screen.contains("Original result")).await;
        assert!(!support::wait_enabled_button(&mut view, "Toggle tool WorkspaceDocument").await.state.selected);
        evidence("tool-read-narrow-collapsed", &collapsed);
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("Original result")).await;
        support::click_button(&mut view, "Toggle original tool details").await;
        let narrow = wait_view(&mut view, |screen| screen.contains("Read lines") && screen.contains("起点_原始")).await;
        evidence("tool-read-narrow-reopened", &narrow);
        view.resize(120, 40);

        // Reading inside the card also pauses the enclosing turn's follower.
        // A real reasoning part appends another row to this same process group.
        support::focus_activity(&mut view).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        let wide = wait_view(&mut view, |screen| screen.contains("Search sessions…") && screen.contains("Read lines") && screen.contains("起点_原始")).await;
        support::scroll_snapshot_text(&mut view, &wide, "起点_原始", MouseEventKind::ScrollDown);
        let reading = wait_view_state(&mut view, |view, screen| screen.contains("Read file") && !screen.contains("起点_原始") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Return to latest" && !node.state.disabled)).await;
        assert!(support::wait_enabled_button(&mut view, "Toggle tool WorkspaceDocument").await.state.selected);
        let numbered_source = original.lines().enumerate()
            .filter(|(_, line)| !line.is_empty())
            .map(|(index, line)| ((index + 1).to_string(), line.to_owned())).collect::<Vec<_>>();
        // Keep exact source glyphs and screen coordinates. The enclosing
        // turn's right-edge scrollbar changes when another row arrives.
        let visible_source = |screen: &str| screen.lines().enumerate().filter_map(|(row, line)| {
            numbered_source.iter().find_map(|(number, source)| {
                let column = line.find(source.as_str())?;
                let gutter = line[..column].split(|ch: char| !ch.is_ascii_digit()).rfind(|part| !part.is_empty());
                (gutter == Some(number.as_str()))
                    .then(|| (row, line[..column].chars().count(), number.clone(), source.clone()))
            })
        }).collect::<Vec<_>>();
        let anchor = visible_source(&reading);
        assert!(!anchor.is_empty());
        continuation.thinking("INNER_STREAM_A").await;
        let anchored = wait_view(&mut view, |screen| screen.contains("Analyzing the request") && screen.contains("INNER_STREAM_A")).await;
        assert_eq!(visible_source(&anchored), anchor, "new same-group reasoning moved the original tool reader:\n{anchored}");
        assert!(anchored.contains("Read file") && original_visible(&view));
        assert!(support::wait_enabled_button(&mut view, "Toggle tool WorkspaceDocument").await.state.selected);
        evidence("tool-read-stream-keeps-local-position", &anchored);

        // Return through the real control, expand the actual new reasoning
        // source, then explicitly resume following before its height grows.
        support::click_button(&mut view, "Return to latest").await;
        wait_view(&mut view, |screen| screen.contains("Thinking · INNER_STREAM_A")).await;
        support::click_button(&mut view, "Thinking · INNER_STREAM_A").await;
        wait_enabled_node(&mut view, "INNER_STREAM_A").await;
        support::click_button(&mut view, "Return to latest").await;
        wait_focused_input(&mut view, "Message composer").await;
        wait_view_state(&mut view, |view, screen| screen.contains("INNER_STREAM_A") && !view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Return to latest")).await;
        let appended: String = (0..36).map(|line| format!("\nINNER_RESUMED_{line:02}")).collect();
        continuation.thinking(&appended).await;
        let resumed = wait_view(&mut view, |screen| screen.contains("INNER_RESUMED_35")).await;
        assert!(resumed.contains("INNER_RESUMED_34"), "the real expanded source tail must follow, rather than only its header:\n{resumed}");
        continuation.thinking("\nINNER_RESUMED_AFTER").await;
        let following = wait_view(&mut view, |screen| screen.contains("INNER_RESUMED_AFTER")).await;
        evidence("tool-read-return-resumes-real-stream", &following);

        continuation.delta("TOOL_CARD_TURN_CONTINUES").await;
        continuation.finish().await;
        fixture.idle(&client, &fixture.session).await;
        assert!(fixture.store.session(&fixture.session).await.unwrap().pending_interactions(&fixture.session).await.unwrap().is_empty());
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host readable tool card workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tool_cards_show_recorded_search_changes_and_business_failures_without_inventing_diffs() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for (method, input, marker) in [
            ("grep", json!({"pattern":"needle","path":"."}), "Matching lines"),
            ("write", json!({"path":"new.txt","content":"新文件_记录\n"}), "Recorded write"),
            ("edit", json!({"path":"original.txt","old_string":"needle","new_string":"替换_记录"}), "Recorded edit"),
            ("readText", json!({"path":"missing.txt"}), "Tool failed"),
        ] {
            let mut fixture = Fixture::files(method).await;
            let client = fixture.client().await;
            let path = fixture.directory.path().join("workspace/original.txt");
            std::fs::write(&path, "中文 needle\n").unwrap();
            let sent = support::mutate(&client, "send", json!({
                "sessionId":fixture.session,"message":"Use the selected Files method","model":fixture.selection,
            })).await;
            assert_eq!(sent["kind"], "started", "{method}: {sent}");
            fixture.next_request().await.tool("WorkspaceDocument", input).await;
            let continuation = fixture.next_request().await;
            let tool_result = continuation.body["messages"].as_array().unwrap()
                .iter().rev().find(|message| message["role"] == "tool").unwrap()["content"]
                .as_str().unwrap();
            let result: Value = serde_json::from_str(tool_result)
                .unwrap_or_else(|error| panic!("actual {method} tool result was not JSON: {error}: {tool_result}"));
            if method == "readText" {
                assert_eq!(result["kind"], "failed", "{result}");
            } else {
                assert_eq!(result["kind"], "completed", "{method}: {result}");
            }
            if method == "write" {
                assert_eq!(std::fs::read_to_string(fixture.directory.path().join("workspace/new.txt")).unwrap(), "新文件_记录\n");
            } else if method == "edit" {
                assert_eq!(std::fs::read_to_string(&path).unwrap(), "中文 替换_记录\n");
            }
            // Results are historical facts, including a real business-level failure.
            std::fs::write(&path, "LATER_WORKSPACE_CONTENT").unwrap();
            let (mut view, bindings) = fixture.view(fixture.client().await, Some(fixture.session.clone()));
            view.resize(120, 40);
            wait_enabled_node(&mut view, "Process group").await;
            support::focus_activity(&mut view).await;
            view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
            support::click_button(&mut view, "Toggle tool WorkspaceDocument").await;
            let screen = wait_view(&mut view, |screen| screen.contains(marker)).await;
            if matches!(method, "write" | "edit") {
                // Recorded results open first. Reach the original request
                // through the same local reader a user scrolls with End.
                // End uses the current range, so first let the separately
                // loaded original arguments finish rendering their full Text.
                let requested = if method == "write" { "新文件_记录\n" } else { "替换_记录" };
                wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.label == requested)).await;
                tab_to_label(&mut view, "Tool details").await;
                view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
                let arguments = wait_view(&mut view, |screen| {
                    if method == "write" {
                        screen.contains("Requested file contents") && screen.contains("新文件_记录")
                    } else {
                        screen.contains("Requested replacement") && screen.contains("替换_记录")
                    }
                }).await;
                evidence(&format!("tool-card-{method}-arguments"), &arguments);
            }
            let labels = view.accessibility_snapshot().into_iter().map(|node| node.label).collect::<Vec<_>>();
            assert!(!labels.iter().any(|label| label.contains("LATER_WORKSPACE_CONTENT")));
            match method {
                "grep" => assert!(labels.iter().any(|label| label.contains("中文 needle"))),
                "write" => {
                    assert!(labels.iter().any(|label| label == "File"));
                    assert!(labels.iter().any(|label| label == "new.txt"));
                    assert!(labels.iter().any(|label| label == "Requested file contents"));
                    assert!(labels.iter().any(|label| label == "新文件_记录\n"));
                    assert!(!labels.iter().any(|label| label == "Applied diff"));
                }
                "edit" => {
                    assert!(labels.iter().any(|label| label == "File"));
                    assert!(labels.iter().any(|label| label == "original.txt"));
                    assert!(labels.iter().any(|label| label == "Requested removal"));
                    assert!(labels.iter().any(|label| label == "needle"));
                    assert!(labels.iter().any(|label| label == "Requested replacement"));
                    assert!(labels.iter().any(|label| label == "替换_记录"));
                    assert!(!labels.iter().any(|label| label == "Applied diff"));
                }
                "readText" => {
                    assert!(labels.iter().any(|label| label == result["message"].as_str().unwrap()));
                    assert!(labels.iter().any(|label| label == "Error"));
                }
                _ => unreachable!(),
            }
            evidence(&format!("tool-card-{method}"), &screen);
            continuation.finish().await;
            fixture.idle(&client, &fixture.session).await;
            drop(view);
            bindings.close().await.unwrap();
            client.close().await.unwrap();
            fixture.finish().await;
        }
    }).await.expect("actual Files tool card workflow timed out");
}
