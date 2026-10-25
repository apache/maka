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
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_app_client::{Client, Draft};

async fn stored_draft(client: &Client, session: &str, expected: impl Fn(&Draft) -> bool) -> Draft {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(draft) = client.load_draft("agent", session, EDITOR).await.unwrap()
                && expected(&draft)
            {
                return draft;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the complete attachment draft did not commit")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attachments_survive_restart_and_send_original_images_without_message_text() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::images().await;
        let client = fixture.client().await;
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";
        let bytes = STANDARD.decode(encoded).unwrap();
        let path = fixture.directory.path().join("original.png");
        std::fs::write(&path, &bytes).unwrap();
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        // Host defaults configure a route; this existing conversation still
        // needs the user's model choice before its first send.
        support::click_button(&mut view, "Choose model and effort").await;
        wait_view(&mut view, |screen| screen.contains("Search models…") && !screen.contains("Loading…")).await;
        support::click_button(&mut view, "Use fixture-model · NSH fixture").await;
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model") && model_menu_closed(view)).await;
        let chosen = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(chosen["session"]["backend"], json!({"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model","thinkingLevel":null}));
        support::click_button(&mut view, "Add to message").await;
        support::click_button(&mut view, "Attach files").await;
        super::tab_to_label(&mut view, "Attachment path").await;
        view.handle_event(Event::Paste(path.to_str().unwrap().into()));
        let (done, committed) = tokio::sync::oneshot::channel();
        view.control().unwrap().advance_clock(Duration::ZERO, move || { let _ = done.send(()); });
        committed.await.unwrap();
        support::click_button(&mut view, "Upload selected file").await;
        let first = stored_draft(&client, &fixture.session, |draft| draft.attachments.len() == 1).await;
        assert!(first.text.is_empty(), "the private selected path must never become draft text");
        assert_eq!(first.attachments[0].name, "original.png");
        assert_eq!(first.attachments[0].mime_type, "image/png");
        assert_eq!(first.attachments[0].bytes, 70);
        assert!(client.pending_uploads(&fixture.session, EDITOR).await.unwrap().is_empty());
        let first_id = first.attachments[0].id.clone();
        super::wait_enabled_node(&mut view, "Remove attachment original.png").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Attachment path"),
            "admitting the original upload must return to the composer");
        support::click_label(&mut view, "Remove attachment original.png");
        let removed = stored_draft(&client, &fixture.session, |draft| {
            draft.revision > first.revision && draft.attachments.is_empty()
        }).await;
        assert!(removed.text.is_empty());
        assert!(client.pending_uploads(&fixture.session, EDITOR).await.unwrap().is_empty(),
            "removal must not resurrect an already adopted original upload");

        // The second real gesture selects a new original operation/artifact. The
        // native owner retains the path while its inner input is hidden.
        super::tab_to_label(&mut view, "Message composer").await;
        super::shortcut(&mut view, 'u');
        super::tab_to_label(&mut view, "Attachment path").await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), path.to_str());
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let selected = stored_draft(&client, &fixture.session, |draft| {
            draft.revision > removed.revision && draft.attachments.len() == 1
        }).await;
        assert_ne!(selected.attachments[0].id, first_id);
        assert!(selected.text.is_empty());
        assert!(client.pending_uploads(&fixture.session, EDITOR).await.unwrap().is_empty());
        std::fs::write(&path, b"the selected local file has since changed").unwrap();
        // This is a new Client/Bindings on the same durable Journal, rather than
        // a JSX remount retaining the old in-memory attachment model.
        drop(view);
        bindings.close().await.unwrap();
        let restarted = fixture.client().await;
        let (mut view, bindings) = fixture.view(restarted.clone(), Some(fixture.session.clone()));
        super::wait_enabled_node(&mut view, "Open attachment original.png").await;
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model") && model_menu_closed(view)).await;
        let restored = restarted.load_draft("agent", &fixture.session, EDITOR).await.unwrap().unwrap();
        assert_eq!(restored.revision, selected.revision);
        assert_eq!(restored.attachments, selected.attachments);
        assert!(restored.text.is_empty());
        support::click_label(&mut view, "Open attachment original.png");
        wait_view(&mut view, |screen| screen.contains("Image preview") && screen.contains("1 × 1 · Original image")).await;
        support::click_label(&mut view, "Close workspace preview");
        wait_view(&mut view, |screen| !screen.contains("Image preview")).await;

        // An attachment-only message is a real send, with no synthetic text or
        // path substituted for the selected bytes.
        support::click_button(&mut view, "Send message").await;
        let mut request = fixture.next_request().await;
        let image_parts = request.body["messages"].as_array().unwrap().iter()
            .filter(|message| message["role"] == "user")
            .filter_map(|message| message["content"].as_array()).flatten()
            .filter(|part| part["type"] == "image_url").collect::<Vec<_>>();
        assert_eq!(image_parts.len(), 1);
        let image_url = image_parts[0]["image_url"]["url"].as_str().unwrap();
        assert_eq!(STANDARD.decode(image_url.strip_prefix("data:image/png;base64,").unwrap()).unwrap(), bytes);
        assert!(!request.body.to_string().contains(path.to_str().unwrap()));
        request.delta("ATTACHMENT_ONLY_ACCEPTED").await;
        request.finish().await;
        fixture.idle(&restarted, &fixture.session).await;
        wait_view(&mut view, |screen| screen.contains("ATTACHMENT_ONLY_ACCEPTED")).await;
        let cleared = stored_draft(&restarted, &fixture.session, |draft| draft.text.is_empty() && draft.attachments.is_empty()).await;
        assert!(cleared.revision >= selected.revision);
        let observed = restarted.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let history = restarted.query("agent", "history", json!({
            "sessionId":fixture.session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"
        })).await.unwrap();
        let user = history["chunks"].as_array().unwrap().iter()
            .find(|chunk| chunk["role"] == "user" && chunk["attachments"].as_array().is_some_and(|files| files.len() == 1))
            .expect("the canonical user row must survive an attachment-only empty body");
        assert_eq!(user["text"], "");
        assert_eq!(user["attachments"], json!([{"name":"original.png","mimeType":"image/png","bytes":70,"kind":"image"}]));
        let source = json!({"kind":"history","through":observed["through"],"position":user["position"],"attachmentIndex":0});
        let page = restarted.query("agent", "attachmentImage", json!({
            "sessionId":fixture.session,"source":source,"offset":0
        })).await.unwrap();
        assert_eq!(page["source"], source);
        assert_eq!(page["data"], encoded);
        assert_eq!(page["mimeType"], "image/png");
        assert_eq!(page["totalBytes"], 70);
        super::wait_enabled_node(&mut view, "Open attachment original.png").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Remove attachment original.png"),
            "the remaining thumbnail must belong to canonical history, not the cleared composer draft");
        support::click_label(&mut view, "Open attachment original.png");
        wait_view(&mut view, |screen| screen.contains("Image preview") && screen.contains("1 × 1 · Original image")).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("actual composer attachment workflow did not complete");
}
