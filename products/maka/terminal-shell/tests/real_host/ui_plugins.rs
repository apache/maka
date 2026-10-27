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
use maka_app_client::Client;
use maka_capabilities::call::Attachments;

const MODULE: &str = r#"
import { View, Text, signal } from 'nsh';
import { Button } from 'nsh/base';

const text = (children) => Text({
  style: { color: '#f0f1f3', fontSize: 14, lineHeight: 16 },
  get children() { return typeof children === 'function' ? children() : children; }
});

export function activate(context) {
  return {
    'open': {
      kind: 'command',
      run({ sessionId }) { context.openPanel('panel', { sessionId }); }
    },
    panel: {
      kind: 'panel',
      render(props) {
        const result = signal('Waiting for the Host');
        const sessionId = props.input.sessionId;
        const read = async () => {
          const observed = await context.services.session[0].query('observe', { sessionId });
          result.set('HOST_TITLE:' + observed.session.title);
        };
        return View({
          style: { flex: 1, minHeight: 0, gap: 12 },
          get children() { return [
            text(context.configuration.caption),
            Button({
              accessibilityLabel: 'Read actual session',
              style: { minHeight: 32, padding: 8 },
              onPress: () => { void read().catch((reason) => result.set(String(reason))); },
              get children() { return text('Read actual session'); }
            }),
            text(result)
          ]; }
        });
      }
    },
    preferences: {
      kind: 'settings',
      render() { return text('DYNAMIC_SETTINGS_READY'); }
    }
  };
}
"#;

async fn manage(client: &Client, method: &str, input: Value) -> Value {
    let mutation = client
        .mutation(
            Uuid::new_v4(),
            "management",
            method,
            input,
            Attachments::new(),
            None,
            Value::Null,
        )
        .await
        .unwrap();
    mutation.prepare().await.unwrap();
    let reply = mutation.confirm().await.unwrap();
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = reply.receipt
    else {
        panic!("management result is not recorded: {reply:?}");
    };
    assert_eq!(value["status"], "committed", "{method}: {value}");
    value["value"].clone()
}

async fn open_panel(view: &mut AppView) {
    shortcut(view, 'p');
    select_palette(
        view,
        "Search commands…",
        "Open dynamic panel",
        "Open dynamic panel",
    )
    .await;
}

async fn reload_request(
    view: &mut AppView,
    requests: &mut tokio::sync::mpsc::UnboundedReceiver<maka_workbench::reload::Request>,
) -> maka_workbench::reload::Request {
    loop {
        view.poll().unwrap();
        support::tick(view);
        match requests.try_recv() {
            Ok(request) => return request,
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                panic!("the native reload request owner closed");
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn input_barrier(view: &mut AppView) {
    let (committed, mut received) = tokio::sync::oneshot::channel();
    view.control()
        .unwrap()
        .advance_clock(Duration::ZERO, move || {
            let _ = committed.send(());
        });
    loop {
        view.poll().unwrap();
        support::tick(view);
        match received.try_recv() {
            Ok(()) => return,
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                panic!("the original engine stopped before its input barrier");
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installed_ui_module_uses_real_host_calls_and_tracks_configuration_and_disable() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::plugin_settings().await;
        let client = fixture.client().await;
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        let initial = client
            .query("management", "readUi", json!({}))
            .await
            .unwrap();
        let installed = manage(
            &client,
            "installSource",
            json!({
                "expectedRevision": initial["source"]["revision"],
                "files": {
                    "maka.extension.json": json!({
                        "schemaVersion": 1,
                        "id": "test.nsh.dynamic-ui",
                        "application": {"ui": {
                            "module": "ui.js",
                            "configuration": {
                                "type":"object",
                                "properties":{"caption":{"type":"string","default":"DYNAMIC_PANEL_INITIAL"}},
                                "additionalProperties":false
                            },
                            "imports": {
                                "session": {
                                    "contract":maka_agent_api::contract(),
                                    "cardinality":{"kind":"one"}
                                }
                            },
                            "contributions": {
                                "open":{"kind":"command","title":{"fallback":"Open dynamic panel","translations":{}}},
                                "panel":{"kind":"panel","title":{"fallback":"Dynamic panel","translations":{}}},
                                "preferences":{"kind":"settings","title":{"fallback":"Dynamic preferences","translations":{}}}
                            }
                        }}
                    }).to_string(),
                    "ui.js": MODULE
                }
            }),
        )
        .await;
        let inserted = manage(
            &client,
            "editComposition",
            json!({
                "expectedRevision": installed["source"]["revision"],
                "edits": [{
                    "kind":"insert","name":"dynamic-ui","package":installed["package"],
                    "usePackage":"ui","settings":[],
                    "bindings":{"session":[{"kind":"instance","path":["agent"],"export":"agent"}]}
                }]
            }),
        )
        .await;
        open_panel(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PANEL_INITIAL")).await;
        support::click_button(&mut view, "Read actual session").await;
        wait_view(&mut view, |screen| screen.contains("HOST_TITLE:NSH real Agent")).await;
        evidence("ui-plugin-real-host-panel", &view.snapshot());

        support::click_button(&mut view, "Close panel").await;
        shortcut(&mut view, 'p');
        select_palette(
            &mut view,
            "Search commands…",
            "Connections & models",
            "Connections & models",
        )
        .await;
        support::click_button(&mut view, "Dynamic preferences").await;
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_SETTINGS_READY")).await;
        support::click_button(&mut view, "Close settings").await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        let command = "/plugin:dynamic-ui:open";
        view.handle_event(Event::Paste(command.into()));
        support::wait_enabled_button(&mut view, command).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PANEL_INITIAL")).await;
        support::wait_draft(&client, &fixture.session, "").await;
        let catalog = client
            .query("management", "readUi", json!({"source": inserted}))
            .await
            .unwrap();
        let instance = catalog["instances"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["path"] == json!(["dynamic-ui"]))
            .unwrap()["instance"]
            .clone();
        let configured = manage(
            &client,
            "configure",
            json!({
                "expectedRevision": catalog["source"]["revision"],
                "instance": instance,
                "changes":[{"path":["caption"],"value":{"kind":"text","text":"DYNAMIC_CONFIG_UPDATED"}}]
            }),
        )
        .await;
        wait_view(&mut view, |screen| {
            screen.contains("DYNAMIC_CONFIG_UPDATED") && !screen.contains("DYNAMIC_PANEL_INITIAL")
        })
        .await;
        support::click_button(&mut view, "Close panel").await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste("DYNAMIC_PLUGIN_UNSENT_DRAFT".into()));
        let reload = bindings.reload();
        let mut requests = reload.take_requests();
        let disabled = manage(
            &client,
            "setEnabled",
            json!({
                "expectedRevision":configured["revision"],
                "instance":instance,"enabled":false
            }),
        )
        .await;
        let maka_workbench::reload::Request::Pause(ready) =
            reload_request(&mut view, &mut requests).await
        else {
            panic!("UI replacement must pause native input before flushing the draft");
        };
        view.surface_mut().set_input_paused(true);
        let paused_text = view.surface().input_context().unwrap().text;
        view.handle_event(Event::Paste("RELOAD_FENCED_INPUT_MUST_NOT_ENTER_DRAFT".into()));
        assert_eq!(view.surface().input_context().unwrap().text, paused_text);
        input_barrier(&mut view).await;
        view.poll().unwrap();
        support::tick(&mut view);
        input_barrier(&mut view).await;
        ready.send(Ok(())).unwrap();
        assert!(matches!(
            reload_request(&mut view, &mut requests).await,
            maka_workbench::reload::Request::Reload
        ));
        assert_eq!(reload.restored()["sessionId"], fixture.session);
        support::wait_draft(&client, &fixture.session, "DYNAMIC_PLUGIN_UNSENT_DRAFT").await;
        let disabled_catalog = client
            .query("management", "readUi", json!({"source": disabled}))
            .await
            .unwrap();
        assert!(disabled_catalog["instances"].as_array().unwrap().is_empty());
        drop(view);
        bindings.close().await.unwrap();

        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PLUGIN_UNSENT_DRAFT")).await;
        shortcut(&mut view, 'p');
        wait_focused_input(&mut view, "Search commands").await;
        view.handle_event(Event::Paste("Open dynamic panel".into()));
        wait_view(&mut view, |screen| screen.contains("No matches.")).await;
        support::click_button(&mut view, "Close commands").await;
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PLUGIN_UNSENT_DRAFT")).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("the installed NSH UI module did not follow the real Host lifecycle");
}
