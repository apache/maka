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
use base64::Engine;
use maka_workbench::bindings::Bindings;
use nsh_engine::Bundle;
use nsh_platform_tui::AppOptions;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_file_gestures_keep_original_uploads_when_hidden_or_rebound() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let fixture = Fixture::open().await;
        let client = fixture.client().await;
        let other = support::mutate(&client, "create", json!({
            "title":"Other attachment owner","labels":[],
            "workspace":{"kind":"session","sessionId":fixture.session}
        })).await;
        let other = other["session"]["id"].as_str().unwrap();
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        let path = fixture.directory.path().join("original.png");
        std::fs::write(&path, &bytes).unwrap();
        let bindings = Bindings::new(client.clone(), tokio::runtime::Handle::current());
        let sets = vec![nsh_base::registry(), bindings.registry(Some(fixture.session.clone()))];
        let source = format!(r#"
import {{ mount, signal, Text, View }} from "nsh";
import {{ Button }} from "nsh/base";
import {{ host, AttachmentPicker }} from "maka/host";
const original = host.session(host.initialSession);
const other = host.session({other});
const selected = signal(original);
const visible = signal(true);
const report = signal("idle");
const count = signal(0);
const watching = original.watchUploads();
(async () => {{ for (;;) {{
    const operations = await watching.next();
    if (operations === null) return;
    count.set(operations.length);
}} }})();
mount(() => <View style={{{{width:"100%",padding:8,gap:8}}}}>
  <AttachmentPicker client={{selected()}} visible={{visible()}}
    pathLabel="Attachment path" pathPlaceholder="Absolute file path…"
    uploadLabel="Upload selected file" uploadingLabel="Uploading…" selectedFileLabel="Selected file"
    onStatus={{status => {{
    report.set(`${{status.kind}}:${{status.operationId}}:${{status.name}}`);
    if (status.kind === "reading") {{ visible.set(false); selected.set(other); }}
  }}}} />
  <Button accessibilityLabel="Show picker" onPress={{() => {{ selected.set(original); visible.set(true); }}}}>
    <Text>Show picker</Text>
  </Button>
  <Text>{{report()}}</Text><Text>{{`uploads:${{count()}}`}}</Text>
</View>);
"#, other=serde_json::to_string(other).unwrap());
        let source = nsh_bundler::compile_module("attachment-intake.tsx", &source,
            &sets.iter().map(Into::into).collect::<Vec<_>>()).unwrap();
        let mut view = AppView::new(AppOptions {
            size:(120,36), data_dir:Some(fixture.directory.path().join("picker-nsh")),
            ui_sets:Some(sets), ..Default::default()
        });
        view.load(Bundle::source(source).into()).unwrap();
        support::tick(&mut view);
        wait_view(&mut view, |screen| screen.contains("uploads:0")).await;
        assert!(client.pending_uploads(&fixture.session, EDITOR).await.unwrap().is_empty());

        // The path enters a native Input through actual user input, never JS props.
        super::tab_to_label(&mut view, "Attachment path").await;
        view.handle_event(Event::Paste(path.to_str().unwrap().into()));
        let (done, committed) = tokio::sync::oneshot::channel();
        view.control().unwrap().advance_clock(Duration::ZERO, move || { let _ = done.send(()); });
        committed.await.unwrap();
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), path.to_str());
        assert!(client.pending_uploads(&fixture.session, EDITOR).await.unwrap().is_empty());
        support::click_button(&mut view, "Upload selected file").await;
        let first = wait_view(&mut view, |screen| screen.contains("complete:") && screen.contains("uploads:1")).await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label=="Attachment path"));
        let original = client.pending_uploads(&fixture.session, EDITOR).await.unwrap();
        assert_eq!(original.len(), 1);
        assert!(first.contains(&original[0].id.to_string()));
        assert_eq!(original[0].upload.as_ref().unwrap().name, "original.png");
        assert!(client.pending_uploads(other, EDITOR).await.unwrap().is_empty());
        let Some(Receipt::Recorded {outcome:OperationOutcome::Returned {value},..}) = &original[0].receipt
            else { panic!("upload did not finish with an actual Host receipt: {:?}", original[0]); };
        assert_eq!(value["kind"], "uploaded");
        assert_eq!(value["attachment"]["sessionId"], fixture.session);
        let preview = client.query("agent", "attachmentImage", json!({
            "sessionId":fixture.session,"source":{"kind":"uploaded","id":value["attachment"]["id"]},"offset":0
        })).await.unwrap();
        assert_eq!(preview["data"], encoded);
        assert_eq!(preview["totalBytes"], bytes.len());
        assert_eq!(preview["digest"], "sha256:9dd3ba490b98e42f0933bc132655c484bdd8682731f639aaffe8c09bfd476dca");

        // The retained private selection also accepts Enter, with a fresh operation.
        support::click_text(&mut view, "Show picker");
        super::tab_to_label(&mut view, "Attachment path").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let second = wait_view(&mut view, |screen| screen.contains("complete:") && screen.contains("uploads:2")).await;
        let uploads = client.pending_uploads(&fixture.session, EDITOR).await.unwrap();
        assert_eq!(uploads.len(), 2);
        let latest = uploads.iter().find(|upload| upload.id != original[0].id).unwrap();
        assert!(second.contains(&latest.id.to_string()));
        assert!(latest.receipt.is_some());
        assert!(client.pending_uploads(other, EDITOR).await.unwrap().is_empty());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        // An idle local watcher is still waiting; it must not retain a launcher task.
        bindings.close().await.unwrap();
        drop(view);
        fixture.finish().await;
    }).await.expect("native attachment intake did not complete");
}
