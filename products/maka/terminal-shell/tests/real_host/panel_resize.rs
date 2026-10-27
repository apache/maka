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

fn preview_content_x(view: &AppView) -> f32 {
    view.accessibility_snapshot()
        .into_iter()
        .find(|node| {
            node.role == nsh_core::AccessibilityRole::Button && node.label == "Browse files"
        })
        .expect("workspace preview file tab is visible")
        .frame
        .origin
        .x
        .0
}

fn composer_width(view: &AppView) -> f32 {
    view.accessibility_snapshot()
        .into_iter()
        .find(|node| node.label == "Message composer")
        .expect("resident conversation composer is visible")
        .frame
        .size
        .width
        .0
}

fn mouse(view: &mut AppView, kind: MouseEventKind, column: u16, row: u16) {
    view.handle_event(Event::Mouse(MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }));
}

async fn commit_ui(view: &mut AppView) {
    view.poll().unwrap();
    let (committed, received) = tokio::sync::oneshot::channel();
    view.control()
        .unwrap()
        .advance_clock(Duration::ZERO, move || {
            let _ = committed.send(());
        });
    received.await.unwrap();
    support::tick(view);
}

async fn drag_right_divider(view: &mut AppView, count: usize, columns: i16) {
    let handle = workbench_divider(view, count, WorkbenchDivider::Preview)
        .expect("the preview divider follows the composer in the expected workbench layout");
    let metrics = view.surface().metrics();
    let cell = metrics.width().0;
    let column =
        ((handle.frame.origin.x.0 + handle.frame.size.width.0 / 2.0) / cell).floor() as u16;
    let row = ((handle.frame.origin.y.0 + handle.frame.size.height.0 / 2.0) / metrics.height().0)
        .floor() as u16;
    let target = column.checked_add_signed(columns).unwrap();
    let divider_before = handle.frame.origin.x.0;
    let content_before = preview_content_x(view);
    let composer_before = composer_width(view);
    let direction = f32::from(columns.signum());
    mouse(view, MouseEventKind::Down(MouseButton::Left), column, row);
    commit_ui(view).await;
    mouse(view, MouseEventKind::Drag(MouseButton::Left), target, row);
    commit_ui(view).await;
    wait_view_state(view, |view, _| {
        workbench_divider(view, count, WorkbenchDivider::Preview).is_some_and(|divider| {
            (divider.frame.origin.x.0 - divider_before) * direction >= 4.0 * cell
        }) && (preview_content_x(view) - content_before) * direction >= 4.0 * cell
    })
    .await;
    assert!(
        (composer_width(view) - composer_before) * direction >= -1.0,
        "the composer must not resize opposite to the conversation boundary"
    );
    let divider_dragged = workbench_divider(view, count, WorkbenchDivider::Preview)
        .unwrap()
        .frame;
    let content_dragged = preview_content_x(view);
    let composer_dragged = composer_width(view);
    mouse(view, MouseEventKind::Up(MouseButton::Left), target, row);
    commit_ui(view).await;
    // A stale Drag after release has no new Down and must not resize the pane.
    mouse(view, MouseEventKind::Drag(MouseButton::Left), column, row);
    commit_ui(view).await;
    assert_eq!(
        workbench_divider(view, count, WorkbenchDivider::Preview)
            .unwrap()
            .frame,
        divider_dragged,
        "a stale Drag after release must not move the divider"
    );
    assert!(
        (preview_content_x(view) - content_dragged).abs() < 1.0,
        "releasing the right divider must retain the preview width"
    );
    assert!(
        (composer_width(view) - composer_dragged).abs() < 1.0,
        "releasing the right divider must retain the conversation width"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_preview_divider_drags_both_ways_with_browser_open_and_closed() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::open().await;
        let client = fixture.client().await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.resize(200, 45);
        wait_focused_input(&mut view, "Message composer").await;
        support::click_button(&mut view, "Browse workspace files").await;
        for expected_handles in [2, 1] {
            wait_view_state(&mut view, |view, _| {
                workbench_divider(view, expected_handles, WorkbenchDivider::Preview).is_some()
            })
            .await;
            let content_before = preview_content_x(&view);
            drag_right_divider(&mut view, expected_handles, -8).await;
            drag_right_divider(&mut view, expected_handles, 5).await;
            let content_x = preview_content_x(&view);
            assert!(
                content_x < content_before - 2.0 * view.surface().metrics().width().0,
                "the asymmetric drags must leave a non-default preview width"
            );
            support::click_button(&mut view, "Close workspace preview").await;
            wait_view_state(&mut view, |view, _| {
                !view.accessibility_snapshot().iter().any(|node| {
                    node.role == nsh_core::AccessibilityRole::Button
                        && node.label == "Close workspace preview"
                })
            })
            .await;
            support::click_button(&mut view, "Browse workspace files").await;
            wait_view_state(&mut view, |view, _| {
                view.accessibility_snapshot().iter().any(|node| {
                    node.role == nsh_core::AccessibilityRole::Button
                        && node.label == "Browse files"
                        && (node.frame.origin.x.0 - content_x).abs() < 1.0
                })
            })
            .await;
            if expected_handles == 2 {
                support::click_button(&mut view, "Collapse session browser").await;
            }
        }
        evidence("workspace-preview-divider-drag", &view.snapshot());
        support::evidence_cells("workspace-preview-divider-drag", &view);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("workspace preview divider drag timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_preview_can_grow_at_standard_terminal_width() {
    let fixture = Fixture::open().await;
    let client = fixture.client().await;
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    view.resize(120, 40);
    wait_focused_input(&mut view, "Message composer").await;
    support::click_button(&mut view, "Choose model and effort").await;
    support::click_button(&mut view, "Use fixture-model · NSH fixture").await;
    wait_view_state(&mut view, |view, screen| {
        screen.contains("fixture-model") && model_menu_closed(view)
    })
    .await;
    tab_to_label(&mut view, "Message composer").await;
    wait_editable_composer(&mut view).await;
    let composer_id = view.surface().focused().unwrap();
    view.handle_event(Event::Paste("RESIZE_DRAFT 你好".into()));
    commit_ui(&mut view).await;
    support::wait_draft(&client, &fixture.session, "RESIZE_DRAFT 你好").await;
    support::wait_enabled_button(&mut view, "Send message").await;
    support::click_button(&mut view, "Browse workspace files").await;
    wait_view_state(&mut view, |view, _| {
        workbench_divider(view, 1, WorkbenchDivider::Preview).is_some()
    })
    .await;
    let composer_before = composer_width(&view);
    support::evidence_cells("workspace-preview-standard-width-before", &view);
    drag_right_divider(&mut view, 1, -24).await;
    assert!(
        composer_width(&view) <= composer_before - 4.0 * view.surface().metrics().width().0,
        "the standard-width composer must make room for the enlarged preview"
    );
    let nodes = view.accessibility_snapshot();
    let card = nodes
        .iter()
        .find(|node| node.label == "Conversation composer")
        .unwrap()
        .frame;
    for label in [
        "Message composer",
        "Add to message",
        "Sandbox and approvals",
        "Choose model and effort",
        "Send message",
    ] {
        let control = nodes.iter().find(|node| node.label == label).unwrap();
        let frame = control.frame;
        assert!(
            frame.size.width.0 > 0.0
                && frame.size.height.0 > 0.0
                && frame.origin.x.0 >= card.origin.x.0
                && frame.origin.y.0 >= card.origin.y.0
                && frame.origin.x.0 + frame.size.width.0 <= card.origin.x.0 + card.size.width.0
                && frame.origin.y.0 + frame.size.height.0 <= card.origin.y.0 + card.size.height.0,
            "{label} must fit inside the narrowed composer: control={frame:?}, card={card:?}"
        );
        tab_to_label(&mut view, label).await;
        assert!(
            view.accessibility_snapshot()
                .iter()
                .any(|node| node.label == label && node.focused)
        );
    }
    tab_to_label(&mut view, "Message composer").await;
    assert_eq!(view.surface().focused(), Some(composer_id));
    view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
    view.handle_event(Event::Paste(" + edited after resize".into()));
    commit_ui(&mut view).await;
    let expected = "RESIZE_DRAFT 你好 + edited after resize";
    assert_eq!(
        view.surface().input_context().unwrap().text.as_deref(),
        Some(expected)
    );
    support::wait_draft(&client, &fixture.session, expected).await;
    evidence("workspace-preview-standard-width-after", &view.snapshot());
    support::evidence_cells("workspace-preview-standard-width-after", &view);
    drop(view);
    bindings.close().await.unwrap();
    client.close().await.unwrap();
    fixture.finish().await;
}
