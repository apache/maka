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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_custom_root_starts_without_an_agent_in_its_source_or_parent_catalogue() {
    use maka_app_client::Journal;
    use maka_event_log::{
        root::{RootNamespaces, RootOwner, private_directory},
        root_store::RootStore,
    };
    use maka_host_runtime::{
        application::{
            NativeRegistry,
            host::{Client as HostClient, Configuration, Host},
            transport::{Grant, HostEndpoint},
        },
        ipc::LocalListener,
    };
    use maka_packages::Package;
    use maka_plugin_core::composition::InstanceId;
    use nsh_platform_tui::AppOptions;
    use std::{collections::BTreeMap, sync::Arc};
    use tokio_util::sync::CancellationToken;

    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        private_directory(directory.path()).unwrap();
        let owner = Arc::new(
            RootOwner::create(
                &directory.path().join("host"),
                &RootNamespaces {
                    ownership: directory.path().join("owners"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        );
        let store = Arc::new(RootStore::open(owner).await.unwrap());
        let manager = support::product_package("host-deployment-manager").await;
        let receipts = support::product_package("receipts").await;
        let gateway = support::product_package("deployment-gateway").await;
        let root = Package::new(BTreeMap::from([
            ("maka.extension.json".into(), serde_json::to_vec(&json!({
                "schemaVersion":1,"id":"test.nsh.no-agent-root",
                "application":{"ui":{
                    "module":"ui.js",
                    "configuration":{"type":"object","properties":{},"additionalProperties":false},
                    "imports":{},"contributions":{"root":{"kind":"root"}}
                }}
            })).unwrap()),
            ("ui.js".into(), br#"
import { Text, signal } from 'nsh';
export function activate(context) {
  return { root: { kind: 'root', render() {
    const result = signal('Checking the parent Host');
    void context.host.hasService('agent').then(
      (present) => result.set(present ? 'UNEXPECTED_AGENT' : 'CUSTOM_ROOT_WITHOUT_AGENT_READY'),
      (reason) => result.set(String(reason))
    );
    return Text({ style: { fontSize: 14, lineHeight: 20 }, get children() { return result(); } });
  } } };
}
"#.to_vec()),
        ])).unwrap();
        let node = |package: &Package, key: u128, use_package: &str, bindings: Value| {
            json!({
                "key":Uuid::from_u128(key),
                "package":{"source":"pinned","package":package.application_ref()},
                "usePackage":use_package,"configuration":{"values":{}},"bindings":bindings
            })
        };
        let deployment = Uuid::new_v4();
        store.commit_application(deployment, 0, serde_json::from_value(json!({
            "ui":{"path":["ui"],"id":"root"},
            "instances":{
                "management":node(&manager, 1, "host", json!({})),
                "receipts":node(&receipts, 2, "host", json!({})),
                "gateway":node(&gateway, 3, "host", json!({
                    "management":[{"kind":"instance","path":["management"],"export":"Management"}],
                    "receipts":[{"kind":"instance","path":["receipts"],"export":"Receipts"}]
                })),
                "ui":node(&root, 4, "ui", json!({}))
            }
        })).unwrap(), vec![], vec![manager, receipts, gateway, root]).await.unwrap();
        let endpoint = |import: &str, methods: &[&str], recovery| HostEndpoint {
            consumer: InstanceId(vec![Uuid::from_u128(3)]),
            import: import.into(),
            grant: Grant {
                methods: methods.iter().map(|name| (*name).into()).collect(),
                recovery,
            },
        };
        let host = Host::open(
            store,
            deployment,
            NativeRegistry::default(),
            None,
            Configuration::PublicHost {
                endpoints: BTreeMap::from([
                    (
                        "management".into(),
                        endpoint("management", &["readUi", "watch", "exportPackage"], false),
                    ),
                    ("receipts".into(), endpoint("receipts", &["read"], true)),
                ]),
                native: vec![],
                product_methods: Default::default(),
            },
        )
        .await
        .unwrap();
        let address = support::socket(directory.path(), "no-agent-root");
        let listener = LocalListener::bind(&address).unwrap();
        let server = tokio::spawn({
            let host = host.clone();
            async move { host.serve_local(listener, CancellationToken::new()).await }
        });
        let parent = HostClient::connect(&address, None).await.unwrap();
        assert!(parent.catalogue().describe("agent").is_err());
        let client = Client::new(
            parent,
            Journal::open(&directory.path().join("client.sqlite"))
                .await
                .unwrap(),
            "receipts".into(),
        )
        .unwrap();
        let bindings =
            maka_workbench::bindings::Bindings::new(client, tokio::runtime::Handle::current());
        let mut view = AppView::new(AppOptions {
            size: (100, 24),
            data_dir: Some(directory.path().join("nsh")),
            ..Default::default()
        });
        support::load_application(&mut view, &bindings, None);
        wait_view(&mut view, |screen| {
            screen.contains("CUSTOM_ROOT_WITHOUT_AGENT_READY")
        })
        .await;
        assert!(
            !view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Message composer")
        );
        drop(view);
        bindings.close().await.unwrap();
        host.shutdown().await.unwrap();
        server.await.unwrap().unwrap();
    })
    .await
    .expect("custom root required an Agent or the static Maka application");
}

const MODULE: &str = r#"
import { View, Text, signal } from 'nsh';
import { Button, Input } from 'nsh/base';

const text = (children) => Text({
  style: { color: '#f0f1f3', fontSize: 14, lineHeight: 16 },
  get children() { return typeof children === 'function' ? children() : children; }
});

export function activate(context) {
  let snapshot = () => null;
  return {
    root: {
      kind: 'root',
      render(props) {
        const note = signal(props.restored === null ? '' : props.restored.note);
        snapshot = () => ({ note: note() });
        return View({
          style: { flex: 1, padding: 12, gap: 12 },
          get children() { return [
            text('CUSTOM_ROOT:' + context.configuration.caption),
            text(props.restored === null ? 'ROOT_RESTORED:none' : 'ROOT_RESTORED:' + props.restored.note),
            Input({
              accessibilityLabel: 'Custom root editor',
              style: { height: 40, color: '#f0f1f3', fontSize: 14 },
              get value() { return note(); },
              onChange: (value) => note.set(value)
            }),
            text(() => 'ROOT_PRIVATE:' + note())
          ]; }
        });
      },
      async prepareReload() { return snapshot(); }
    },
    alternate: {
      kind: 'root',
      render(props) {
        return text(props.restored === null ? 'OTHER_ROOT_RESTORED:none' : 'OTHER_ROOT_RECEIVED_FOREIGN_STATE');
      }
    },
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

async fn select_root(client: &Client, path: &str, id: &str) -> Value {
    let metadata = client.query("management", "read", json!({})).await.unwrap();
    let mut input = metadata["source"]["input"].clone();
    input["ui"] = json!({"path":[path],"id":id});
    manage(
        client,
        "replaceSource",
        json!({
            "expectedRevision":metadata["source"]["reference"]["revision"],
            "document":{
                "input":input,
                "remoteExports":metadata["source"]["remoteExports"],
                "packages":metadata["packages"]
            }
        }),
    )
    .await
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

async fn reload_ui(
    view: &mut AppView,
    bindings: &maka_workbench::bindings::Bindings,
    requests: &mut tokio::sync::mpsc::UnboundedReceiver<maka_workbench::reload::Request>,
    session: &str,
) {
    let maka_workbench::reload::Request::Pause(ready) = reload_request(view, requests).await else {
        panic!("UI replacement must pause native input before saving root state");
    };
    view.surface_mut().set_input_paused(true);
    let paused_text = view.surface().input_context().map(|input| input.text);
    view.handle_event(Event::Paste(
        "RELOAD_FENCED_INPUT_MUST_NOT_ENTER_DRAFT".into(),
    ));
    assert_eq!(
        view.surface().input_context().map(|input| input.text),
        paused_text
    );
    input_barrier(view).await;
    view.poll().unwrap();
    support::tick(view);
    input_barrier(view).await;
    ready.send(Ok(())).unwrap();
    assert!(matches!(
        reload_request(view, requests).await,
        maka_workbench::reload::Request::Reload
    ));
    support::load_application(view, bindings, Some(session.into()));
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
                                "root":{"kind":"root"},
                                "alternate":{"kind":"root"},
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
        manage(
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
        let custom = select_root(&client, "dynamic-ui", "root").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("CUSTOM_ROOT:DYNAMIC_CONFIG_UPDATED")
                && screen.contains("ROOT_RESTORED:none")
                && !view.accessibility_snapshot().iter().any(|node| node.label == "Message composer" || node.label == "New conversation")
        }).await;
        support::wait_draft(&client, &fixture.session, "DYNAMIC_PLUGIN_UNSENT_DRAFT").await;
        tab_to_label(&mut view, "Custom root editor").await;
        view.handle_event(Event::Paste("PRIVATE_ROOT_EDIT".into()));
        wait_view(&mut view, |screen| screen.contains("ROOT_PRIVATE:PRIVATE_ROOT_EDIT")).await;
        manage(
            &client,
            "configure",
            json!({
                "expectedRevision":custom["revision"],
                "instance":instance,
                "changes":[{"path":["caption"],"value":{"kind":"text","text":"ROOT_CONFIG_UPDATED"}}]
            }),
        ).await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view(&mut view, |screen| {
            screen.contains("CUSTOM_ROOT:ROOT_CONFIG_UPDATED")
                && screen.contains("ROOT_RESTORED:PRIVATE_ROOT_EDIT")
                && screen.contains("ROOT_PRIVATE:PRIVATE_ROOT_EDIT")
        }).await;
        select_root(&client, "dynamic-ui", "alternate").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view(&mut view, |screen| {
            screen.contains("OTHER_ROOT_RESTORED:none")
                && !screen.contains("PRIVATE_ROOT_EDIT")
                && !screen.contains("CUSTOM_ROOT:")
        }).await;
        let restored = select_root(&client, "workbench-ui", "root").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_editable_composer(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PLUGIN_UNSENT_DRAFT")).await;
        open_panel(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("ROOT_CONFIG_UPDATED")).await;
        support::click_button(&mut view, "Close panel").await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        let disabled = manage(
            &client,
            "setEnabled",
            json!({
                "expectedRevision":restored["revision"],
                "instance":instance,"enabled":false
            }),
        )
        .await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        assert_eq!(reload.restored()["state"]["sessionId"], fixture.session);
        support::wait_draft(&client, &fixture.session, "DYNAMIC_PLUGIN_UNSENT_DRAFT").await;
        let disabled_catalog = client
            .query("management", "readUi", json!({"source": disabled}))
            .await
            .unwrap();
        assert!(!disabled_catalog["instances"].as_array().unwrap().iter().any(|item| item["path"] == json!(["dynamic-ui"])));
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
