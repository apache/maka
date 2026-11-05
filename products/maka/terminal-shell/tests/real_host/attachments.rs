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

const ORIGINAL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";

async fn stored_draft(client: &Client, session: &str, expected: impl Fn(&Draft) -> bool) -> Draft {
    tokio::time::timeout(support::WAIT_TIMEOUT, async {
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
async fn directory_path_paste_remains_text_in_an_existing_composer() {
    let fixture = Fixture::open().await;
    let client = fixture.client().await;
    let directory = fixture.directory.path().join("未命名文件夹 2");
    std::fs::create_dir(&directory).unwrap();
    let expected = format!("查看 {}", directory.display());
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    wait_editable_composer(&mut view).await;
    view.handle_event(Event::Paste("查看 ".into()));
    commit_native_events(&mut view).await;
    view.handle_event(Event::Paste(format!("'{}'", directory.display())));
    wait_view_state(&mut view, |view, _| {
        view.surface()
            .input_context()
            .is_some_and(|input| input.text.as_deref() == Some(expected.as_str()))
    })
    .await;
    let draft = stored_draft(&client, &fixture.session, |draft| draft.text == expected).await;
    assert!(draft.attachments.is_empty());
    drop(view);
    bindings.close().await.unwrap();
    let bindings = maka_workbench::bindings::Bindings::new(
        fixture.client().await,
        tokio::runtime::Handle::current(),
    );
    let mut view = AppView::new(nsh_platform_tui::AppOptions {
        size: (120, 36),
        ..Default::default()
    });
    let source = format!(
        r#"
import {{ mount, signal, Text }} from 'nsh';
import {{ host }} from 'maka/host';
const result = signal('Selecting file');
host.stageFiles([{}]).then(
  () => result.set('Unexpected directory upload'),
  error => result.set(String(error).includes('selected path is not an absolute regular file')
    ? 'Directory rejected' : 'Unexpected failure'),
);
mount(() => Text({{ get children() {{ return result(); }} }}));
"#,
        json!(directory.to_str().unwrap())
    );
    let mut config =
        maka_workbench::configuration(bindings.registry(None), tokio::runtime::Handle::current());
    let mut capabilities = nsh_engine::Capabilities::all();
    capabilities.host = vec!["*".into()];
    config.context = config.context.with(bindings.reload());
    config.app = nsh_engine::Bundle::source(source)
        .with_policy(nsh_engine::Policy {
            declared: Some(capabilities),
            ..nsh_engine::Policy::development()
        })
        .into();
    view.load_with_config(config).unwrap();
    wait_view(&mut view, |screen| screen.contains("Directory rejected")).await;
    drop(view);
    bindings.close().await.unwrap();
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attachment_only_send_uses_the_selected_bytes_after_the_local_file_changes() {
    let mut fixture = Fixture::configured(support::Options {
        images: true,
        ..support::Options::default()
    })
    .await;
    let client = fixture.client().await;
    support::mutate(&client,"selectBackend",json!({"sessionId":fixture.session,"backend":{"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model","thinkingLevel":null}})).await;
    let bytes = STANDARD.decode(ORIGINAL_PNG).unwrap();
    let path = fixture.directory.path().join("original image.png");
    std::fs::write(&path, &bytes).unwrap();
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    wait_editable_composer(&mut view).await;
    view.handle_event(Event::Paste(format!("'{}'", path.display())));
    let stored = stored_draft(&client, &fixture.session, |draft| {
        draft.attachments.len() == 1
    })
    .await;
    assert!(stored.text.is_empty());
    assert_eq!(stored.attachments[0].name, "original image.png");
    let dropped = fixture.directory.path().join("dropped image.png");
    std::fs::write(&dropped, &bytes).unwrap();
    wait_editable_composer(&mut view).await;
    let composer = view.surface().focused().unwrap();
    view.control().unwrap().dispatch_event(
        composer,
        nsh_core::EventKind::FileDrop,
        nsh_core::EventPayload::FileDrop(vec![
            reqwest::Url::from_file_path(&dropped).unwrap().into(),
        ]),
    );
    let stored = stored_draft(&client, &fixture.session, |draft| {
        draft.attachments.len() == 2
    })
    .await;
    assert!(stored.text.is_empty());
    assert!(
        stored
            .attachments
            .iter()
            .any(|attachment| attachment.name == "dropped image.png")
    );
    std::fs::write(&dropped, b"the dropped local file changed").unwrap();
    std::fs::write(&path, b"the selected local file changed").unwrap();
    support::click_button(&mut view, "Send message").await;
    let mut request = fixture.next_request().await;
    let images: Vec<_> = request.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .filter_map(|message| message["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "image_url")
        .collect();
    let sent: Vec<Vec<u8>> = images
        .iter()
        .map(|image| {
            STANDARD
                .decode(
                    image["image_url"]["url"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("data:image/png;base64,")
                        .unwrap(),
                )
                .unwrap()
        })
        .collect();
    assert_eq!(sent, vec![bytes.clone(), bytes]);
    assert!(!request.body.to_string().contains(path.to_str().unwrap()));
    assert!(!request.body.to_string().contains(dropped.to_str().unwrap()));
    request.delta("Attachment received").await;
    request.finish().await;
    fixture.idle(&client, &fixture.session).await;
    wait_view(&mut view, |screen| screen.contains("Attachment received")).await;
    stored_draft(&client, &fixture.session, |draft| {
        draft.attachments.is_empty() && draft.text.is_empty()
    })
    .await;
    drop(view);
    bindings.close().await.unwrap();
    fixture.finish().await;
}
