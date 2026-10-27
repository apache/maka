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
use maka_ui_support::{budget::NativeBudget, file::read_selected};
use maka_workbench::bindings::Bindings;
use nsh_engine::Bundle;
use nsh_platform_tui::AppOptions;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_late_original_upload_read_cannot_restore_a_removed_draft_attachment() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let fixture = Fixture::open().await;
        let client = fixture.client().await;
        let path = fixture.directory.path().join("selected.txt");
        std::fs::write(&path, b"original selected content").unwrap();
        let selected = read_selected(&path, &NativeBudget::default()).unwrap();
        let upload = client
            .upload_attachment(Uuid::new_v4(), &fixture.session, EDITOR, selected)
            .await
            .unwrap();
        let reserved = client
            .operation_for_upload(&fixture.session, EDITOR, upload.id())
            .await
            .unwrap();
        upload.prepare().await.unwrap();
        upload.confirm().await.unwrap();
        let original = client
            .operation_for_upload(&fixture.session, EDITOR, upload.id())
            .await
            .unwrap();
        let attachment = original
            .receipt
            .as_ref()
            .and_then(|receipt| match receipt {
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned { value },
                    ..
                } => Some(value["attachment"].clone()),
                _ => None,
            })
            .unwrap();
        let bindings = Bindings::new(client.clone(), tokio::runtime::Handle::current());
        let sets = vec![
            nsh_base::registry(),
            bindings.registry(Some(fixture.session.clone())),
        ];
        // The payload is an actual recorded Host operation. Only delivery of its
        // already-started read is held, so this exercises the observer race
        // without inventing an upload result or a second persistence authority.
        let source = format!(
            "const attachmentDraftFixture = {};\n{}",
            json!({"original": original, "reserved": reserved, "attachment": attachment}),
            include_str!(concat!(env!("OUT_DIR"), "/attachment-draft-fixture.js")),
        );
        let mut view = AppView::new(AppOptions {
            size: (100, 24),
            data_dir: Some(fixture.directory.path().join("draft-nsh")),
            ui_sets: Some(sets),
            ..Default::default()
        });
        view.load(Bundle::source(source).into()).unwrap();
        wait_view(&mut view, |screen| {
            screen.contains("files:0") && screen.contains("Uploading attachments")
        })
        .await;
        support::click_text(&mut view, "Deliver confirmed original read");
        wait_view(&mut view, |screen| screen.contains("files:1")).await;
        support::click_text(&mut view, "Save attachment draft");
        wait_view(&mut view, |screen| screen.contains("Draft saved")).await;
        assert_eq!(
            client
                .load_draft("agent", &fixture.session, EDITOR)
                .await
                .unwrap()
                .unwrap()
                .attachments
                .len(),
            1
        );
        assert!(
            client
                .pending_uploads(&fixture.session, EDITOR)
                .await
                .unwrap()
                .is_empty()
        );
        support::click_text(&mut view, "Remove selected attachment");
        wait_view(&mut view, |screen| {
            screen.contains("files:0") && screen.contains("Unsaved edit")
        })
        .await;
        support::click_text(&mut view, "Save attachment draft");
        wait_view(&mut view, |screen| screen.contains("Draft saved")).await;
        assert!(
            client
                .load_draft("agent", &fixture.session, EDITOR)
                .await
                .unwrap()
                .unwrap()
                .attachments
                .is_empty()
        );
        support::click_text(&mut view, "Deliver delayed original read");
        let (done, committed) = tokio::sync::oneshot::channel();
        view.control()
            .unwrap()
            .advance_clock(Duration::ZERO, move || {
                let _ = done.send(());
            });
        committed.await.unwrap();
        let screen = wait_view(&mut view, |screen| {
            screen.contains("files:0") && screen.contains("Delayed read delivered")
        })
        .await;
        assert!(!screen.contains("files:1"));
        assert!(
            client
                .load_draft("agent", &fixture.session, EDITOR)
                .await
                .unwrap()
                .unwrap()
                .attachments
                .is_empty()
        );
        bindings.close().await.unwrap();
        drop(view);
        fixture.finish().await;
    })
    .await
    .expect("attachment draft observer did not finish");
}
