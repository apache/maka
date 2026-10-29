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
use maka_packages::Package;
use maka_ui_support::{budget::NativeBudget, file::read_selected};
use std::collections::BTreeMap;

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
        // The payload is an actual recorded Host operation. Only delivery of its
        // already-started read is held, so this exercises the observer race
        // without inventing an upload result or a second persistence authority.
        let build = fixture.directory.path().join("attachment-draft-ui");
        let compiled = tokio::task::spawn_blocking(move || {
            maka_ui_build::compile(
                &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../terminal-shell/tests/fixtures/attachment-draft.tsx"),
                &build,
            )
        })
        .await
        .unwrap()
        .unwrap();
        assert!(
            compiled.assets.is_empty(),
            "the draft fixture has no assets"
        );
        let package = Package::new(BTreeMap::from([
            (
                "maka.extension.json".into(),
                serde_json::to_vec(&json!({
                    "schemaVersion":1,
                    "id":"test.nsh.attachment-draft",
                    "application":{"ui":{
                        "module":"ui.js",
                        "configuration":{
                            "type":"object",
                            "properties":{"original":{},"reserved":{},"attachment":{}},
                            "required":["original","reserved","attachment"],
                            "additionalProperties":false
                        },
                        "imports":{},
                        "contributions":{"root":{"kind":"root"}}
                    }}
                }))
                .unwrap(),
            ),
            ("ui.js".into(), std::fs::read(compiled.module).unwrap()),
        ]))
        .unwrap();
        fixture
            .install_ui_root(
                package,
                json!({"original": original, "reserved": reserved, "attachment": attachment}),
            )
            .await;
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        view.resize(100, 24);
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
