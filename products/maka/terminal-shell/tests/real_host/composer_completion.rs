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
async fn composer_add_menu_reopens_after_dismissal_without_editing_the_draft() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let fixture = Fixture::open().await;
        let client = fixture.client().await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        let editor = view.surface().focused().unwrap();

        for _ in 0..3 {
            support::click_button(&mut view, "Add to message").await;
            support::wait_enabled_button(&mut view, "Reference a workspace file").await;
            view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
            wait_view_state(&mut view, |view, _| {
                !view
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.label == "Reference a workspace file")
            })
            .await;
            assert_eq!(view.surface().focused(), Some(editor));
        }

        support::click_button(&mut view, "Add to message").await;
        support::wait_enabled_button(&mut view, "Reference a workspace file").await;
        support::click_button(&mut view, "Add to message").await;
        wait_view_state(&mut view, |view, _| {
            !view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Reference a workspace file")
        })
        .await;
        support::click_button(&mut view, "Add to message").await;
        support::wait_enabled_button(&mut view, "Reference a workspace file").await;
        let viewport = view.surface().viewport();
        let metrics = view.surface().metrics();
        let columns = (viewport.width.0 / metrics.width().0).round() as u16;
        let rows = (viewport.height.0 / metrics.height().0).round() as u16;
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            view.handle_event(Event::Mouse(MouseEvent {
                kind,
                column: columns - 1,
                row: rows - 1,
                modifiers: KeyModifiers::NONE,
            }));
        }
        wait_view_state(&mut view, |view, _| {
            !view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Reference a workspace file")
        })
        .await;

        support::click_button(&mut view, "Add to message").await;
        support::click_button(&mut view, "Message commands").await;
        wait_view(&mut view, |screen| screen.contains("Search commands…")).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| !screen.contains("Search commands…")).await;
        support::click_button(&mut view, "Add to message").await;
        support::wait_enabled_button(&mut view, "Reference a workspace file").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_editable_composer(&mut view).await;
        assert_eq!(view.surface().focused(), Some(editor));
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            Some("")
        );
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);

        bindings.close().await.unwrap();
        drop(view);
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("composer add menu did not reopen after dismissal");
}
