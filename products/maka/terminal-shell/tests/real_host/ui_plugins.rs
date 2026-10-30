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
                    "imports":{},"contributions":{
                        "root":{"kind":"root"},
                        "embedded":{"kind":"view","contract":"test.embedded"}
                    }
                }}
            })).unwrap()),
            ("ui.js".into(), br#"
import { Text, View, signal } from 'nsh';
export function activate(context) {
  return { exports: {
  embedded: { kind: 'view', contract: 'test.embedded', render(props) {
    return Text({ children: props.input.caption + (props.runtime === context.runtime ? ':SHARED_RUNTIME' : ':FOREIGN_RUNTIME') });
  } },
  root: { kind: 'root', render() {
    const result = signal('Checking the parent Host');
    void context.host.hasService('agent').then(
      (present) => result.set(present ? 'UNEXPECTED_AGENT' : 'CUSTOM_ROOT_WITHOUT_AGENT_READY'),
      (reason) => result.set(String(reason))
    );
    let rejected = false;
    try { context.runtime.view({ path: ['ui'], id: 'embedded' }, { id: 'test.wrong' }); }
    catch { rejected = true; }
    return View({ style: { flex: 1 }, get children() { return [
      Text({ style: { fontSize: 14, lineHeight: 20 }, get children() { return result(); } }),
      context.runtime.renderView({ path: ['ui'], id: 'embedded' }, { id: 'test.embedded' }, { caption: 'EMBEDDED_SELECTED' }),
      Text({ children: rejected ? 'VIEW_CONTRACT_REJECTED' : 'VIEW_CONTRACT_UNCHECKED' })
    ]; } });
  } } } };
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
                && screen.contains("EMBEDDED_SELECTED:SHARED_RUNTIME")
                && screen.contains("VIEW_CONTRACT_REJECTED")
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
import { cleanup, View, Text, signal } from 'nsh';
import { Button, Input } from 'nsh/base';

const text = (children) => Text({
  style: { color: '#f0f1f3', fontSize: 14, lineHeight: 16 },
  get children() { return typeof children === 'function' ? children() : children; }
});

export function activate(context) {
  const restored = context.restored;
  const note = signal(restored?.root?.note ?? '');
  const panelNote = signal(restored?.panel?.note ?? '');
  const blocked = signal(false);
  let rootUsed = restored?.root != null;
  return {
    exports: {
    root: {
      kind: 'root',
      render() {
        rootUsed = true;
        const watching = signal('ROOT_WATCH_IDLE');
        let stream;
        cleanup(() => { if (stream) void stream.close(); });
        const watch = async () => {
          const sessionId = context.host.initialSession;
          const observed = await context.services.session[0].query('observe', { sessionId });
          stream = await context.services.session[0].subscribe('watch', { sessionId, after: observed.through });
          watching.set('ROOT_WATCH_READY');
          while (await stream.next() !== null) {}
        };
        return View({
          style: { flex: 1, padding: 12, gap: 12 },
          get children() { return [
            text('CUSTOM_ROOT:' + context.configuration.caption),
            text(restored?.root == null ? 'ROOT_RESTORED:none' : 'ROOT_RESTORED:' + restored.root.note),
            Input({
              accessibilityLabel: 'Custom root editor',
              style: { height: 40, color: '#f0f1f3', fontSize: 14 },
              get value() { return note(); },
              onChange: ({ value }) => note.set(value)
            }),
            Button({
              accessibilityLabel: 'Watch original session',
              style: { minHeight: 32, padding: 8 },
              onPress: () => { void watch().catch((reason) => watching.set(String(reason))); },
              get children() { return text('Watch original session'); }
            }),
            text(watching),
            text(() => 'ROOT_PRIVATE:' + note())
          ]; }
        });
      }
    },
    alternate: {
      kind: 'root',
      render() {
        return text(restored?.alternate == null ? 'OTHER_ROOT_RESTORED:none' : 'OTHER_ROOT_RECEIVED_FOREIGN_STATE');
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
        const record = async () => {
          const observed = await context.services.session[0].query('observe', { sessionId });
          const operation = await context.services.session[0].mutation('metadata', {
            sessionId, expectedRevision: observed.session.revision,
            title: 'UI original receipt', labels: observed.session.labels
          });
          result.set('UI_OPERATION:' + operation.operationId);
        };
        return View({
          style: { flex: 1, minHeight: 0, gap: 12 },
          get children() { return [
            text(context.configuration.caption),
            Input({
              accessibilityLabel: 'Dynamic private editor',
              style: { height: 40, color: '#f0f1f3', fontSize: 14 },
              get value() { return panelNote(); },
              onChange: ({ value }) => panelNote.set(value)
            }),
            text(() => 'PANEL_PRIVATE:' + panelNote()),
            Button({
              get accessibilityLabel() { return blocked() ? 'Allow UI replacement' : 'Block UI replacement'; },
              style: { minHeight: 32, padding: 8 },
              onPress: () => { blocked.set(!blocked()); if (!blocked()) context.runtime.retryUpdates(); },
              get children() { return text(blocked() ? 'Allow UI replacement' : 'Block UI replacement'); }
            }),
            Button({
              accessibilityLabel: 'Read actual session',
              style: { minHeight: 32, padding: 8 },
              onPress: () => { void read().catch((reason) => result.set(String(reason))); },
              get children() { return text('Read actual session'); }
            }),
            Button({
              accessibilityLabel: 'Record original mutation',
              style: { minHeight: 32, padding: 8 },
              onPress: () => { void record().catch((reason) => result.set(String(reason))); },
              get children() { return text('Record original mutation'); }
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
    },
    async prepareReload() {
      if (blocked()) throw new Error('DYNAMIC_PREPARATION_BLOCKED');
      return { root: rootUsed ? { note: note() } : null, panel: { note: panelNote() } };
    }
  };
}
"#;

struct InstalledUi {
    package: Value,
    instance: Value,
    source: Value,
}

async fn install_dynamic_ui(client: &Client) -> InstalledUi {
    let initial = client
        .query("management", "readUi", json!({}))
        .await
        .unwrap();
    let installed = manage(
        client,
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
                            "open":{"kind":"command","trigger":"dynamic-panel","title":{"fallback":"Open dynamic panel","translations":{}}},
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
        client,
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
    InstalledUi {
        package: installed["package"].clone(),
        instance,
        source: inserted,
    }
}

async fn record_original_mutation(view: &mut AppView, client: &Client) -> (Uuid, Value) {
    support::click_button(view, "Record original mutation").await;
    wait_view_state(view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label.starts_with("UI_OPERATION:"))
    })
    .await;
    let operation_id = Uuid::parse_str(
        view.accessibility_snapshot()
            .iter()
            .find_map(|node| node.label.strip_prefix("UI_OPERATION:"))
            .unwrap(),
    )
    .unwrap();
    let original_operation = client.operation(operation_id).await.unwrap();
    assert!(
        matches!(&original_operation.receipt, Some(Receipt::Recorded {
        outcome: OperationOutcome::Returned { value }, ..
    }) if value["kind"] == "committed")
    );
    let original_operation = serde_json::to_value(original_operation).unwrap();
    (operation_id, original_operation)
}

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

async fn select_composer(client: &Client, path: &str, id: &str) {
    let catalog = client
        .query("management", "readUi", json!({}))
        .await
        .unwrap();
    let conversations = catalog["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == json!(["conversations-ui"]))
        .unwrap();
    manage(
        client,
        "configure",
        json!({
            "expectedRevision":catalog["source"]["revision"],
            "instance":conversations["instance"],
            "changes":[
                {"path":["composer","path","0"],"value":{"kind":"text","text":path}},
                {"path":["composer","id"],"value":{"kind":"text","text":id}}
            ]
        }),
    )
    .await;
}

async fn wait_active_calls(view: &mut AppView, fixture: &Fixture, expected: usize) {
    loop {
        view.poll().unwrap();
        support::tick(view);
        let status = maka_host_runtime::application::host::Client::status(&fixture.address, None)
            .await
            .unwrap();
        if status.active_calls == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
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

async fn prepare_ui_reload(
    view: &mut AppView,
    requests: &mut tokio::sync::mpsc::UnboundedReceiver<maka_workbench::reload::Request>,
) {
    let maka_workbench::reload::Request::Pause(ready) = reload_request(view, requests).await else {
        panic!("UI replacement must pause native input before saving instance state");
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
}

async fn reload_ui(
    view: &mut AppView,
    bindings: &maka_workbench::bindings::Bindings,
    requests: &mut tokio::sync::mpsc::UnboundedReceiver<maka_workbench::reload::Request>,
    session: &str,
) {
    prepare_ui_reload(view, requests).await;
    assert!(matches!(
        reload_request(view, requests).await,
        maka_workbench::reload::Request::Reload
    ));
    support::load_application(view, bindings, Some(session.into()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn standalone_composer_replacement_preserves_the_original_draft_upload_and_send() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use maka_app_client::{DraftAttachment, DraftEdit};
    use maka_ui_support::file::read_selected;

    tokio::time::timeout(Duration::from_secs(90), async {
        let (manifest, module) = tokio::task::spawn_blocking(|| {
            let example = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../skills/maka-plugin-authoring/assets/composer-ui");
            let declaration = std::process::Command::new("node")
                .args([
                    "--input-type=module",
                    "-e",
                    "import {pathToFileURL} from 'node:url'; const {default:manifest}=await import(pathToFileURL(process.argv[1])); process.stdout.write(JSON.stringify(manifest));",
                ])
                .arg(example.join("package.ts"))
                .output()
                .unwrap();
            assert!(declaration.status.success(), "{}", String::from_utf8_lossy(&declaration.stderr));
            let manifest = String::from_utf8(declaration.stdout).unwrap();
            let source = std::fs::read_to_string(example.join("index.tsx")).unwrap();
            let module = nsh_bundler::compile_module(
                "composer-ui.tsx",
                &source,
                &[nsh_base::registry().into(), maka_workbench::bindings::ui_set_description()],
            ).unwrap();
            (manifest, module)
        }).await.unwrap();
        let mut fixture = Fixture::configured(support::Options { images: true, ..Default::default() }).await;
        let client = fixture.client().await;
        const DRAFT: &str = "ORIGINAL_COMPOSER_DRAFT";
        const EDITED: &str = "ORIGINAL_COMPOSER_DRAFT_SAMPLE_EDIT";
        const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";
        let bytes = STANDARD.decode(PNG).unwrap();
        let path = fixture.directory.path().join("composer original.png");
        std::fs::write(&path, &bytes).unwrap();
        let upload = client.upload_attachment(
            Uuid::new_v4(), &fixture.session, EDITOR,
            read_selected(&path).unwrap(),
        ).await.unwrap();
        upload.prepare().await.unwrap();
        upload.confirm().await.unwrap();
        let original = client.operation_for_upload(&fixture.session, EDITOR, upload.id()).await.unwrap();
        let Some(Receipt::Recorded { outcome: OperationOutcome::Returned { value }, .. }) = &original.receipt else {
            panic!("the original upload has no recorded Host receipt: {original:?}");
        };
        assert_eq!(value["attachment"]["sessionId"], fixture.session);
        let attachment = DraftAttachment {
            id: value["attachment"]["id"].as_str().unwrap().into(),
            name: value["attachment"]["name"].as_str().unwrap().into(),
            mime_type: value["attachment"]["mimeType"].as_str().unwrap().into(),
            bytes: value["attachment"]["bytes"].as_u64().unwrap(),
        };
        let draft = client.save_draft("agent", &fixture.session, EDITOR, None, DraftEdit {
            text: DRAFT.into(), attachments: vec![attachment.clone()], settled_uploads: vec![upload.id()],
        }).await.unwrap();
        let original = serde_json::to_value(original).unwrap();
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.resize(120, 40);
        let reload = bindings.reload();
        let mut requests = reload.take_requests();
        wait_view_state(&mut view, |view, screen| {
            let nodes = view.accessibility_snapshot();
            screen.contains(DRAFT)
                && nodes.iter().any(|node| node.label == "Open attachment composer original.png" && !node.state.disabled)
                && nodes.iter().any(|node| node.label == "Remove attachment composer original.png" && !node.state.disabled)
        }).await;
        support::click_button(&mut view, "Choose model and effort").await;
        wait_view(&mut view, |screen| screen.contains("Search models…") && !screen.contains("Loading…")).await;
        support::click_button(&mut view, "Use fixture-model · NSH fixture").await;
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model") && model_menu_closed(view)).await;

        let catalog = client.query("management", "readUi", json!({})).await.unwrap();
        let installed = manage(&client, "installSource", json!({
            "expectedRevision":catalog["source"]["revision"],
            "files":{"maka.extension.json":manifest,"index.js":module}
        })).await;
        manage(&client, "editComposition", json!({
            "expectedRevision":installed["source"]["revision"],
            "edits":[{"kind":"insert","name":"example-composer-ui","package":installed["package"],"usePackage":"ui","settings":[],"bindings":{}}]
        })).await;
        select_composer(&client, "example-composer-ui", "composer").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains(DRAFT) && screen.contains("composer original.png")
                && view.accessibility_snapshot().iter().any(|node| node.label == "Attach")
                && !view.accessibility_snapshot().iter().any(|node| node.label == "Conversation composer")
        }).await;
        let restored = client.load_draft("agent", &fixture.session, EDITOR).await.unwrap().unwrap();
        assert_eq!(restored.text, draft.text);
        assert_eq!(restored.attachments, draft.attachments);
        assert_eq!(serde_json::to_value(client.operation_for_upload(&fixture.session, EDITOR, upload.id()).await.unwrap()).unwrap(), original);
        tab_to_label(&mut view, "Message composer").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        view.handle_event(Event::Paste("_SAMPLE_EDIT".into()));
        support::wait_draft(&client, &fixture.session, EDITED).await;
        let edited = client.load_draft("agent", &fixture.session, EDITOR).await.unwrap().unwrap();
        assert_eq!(edited.attachments, vec![attachment]);
        support::click_button(&mut view, "Send message").await;
        let mut request = fixture.next_request().await;
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let history = client.query("agent", "history", json!({
            "sessionId":fixture.session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"
        })).await.unwrap();
        let users: Vec<_> = history["chunks"].as_array().unwrap().iter()
            .filter(|chunk| chunk["role"] == "user").collect();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["text"], EDITED);
        assert_eq!(users[0]["attachments"], json!([{
            "name":"composer original.png","mimeType":"image/png","bytes":bytes.len(),"kind":"image"
        }]));
        let parts: Vec<_> = request.body["messages"].as_array().unwrap().iter()
            .filter(|message| message["role"] == "user")
            .filter_map(|message| message["content"].as_array()).flatten().collect();
        let texts: Vec<_> = parts.iter().filter(|part| part["type"] == "text")
            .map(|part| part["text"].as_str().unwrap()).collect();
        assert_eq!(texts.len(), 1);
        let (sent_text, _) = texts[0].split_once("\n\n<attachment>\n")
            .expect("the provider input must retain the attachment reference after the original text");
        assert_eq!(sent_text, EDITED);
        let images: Vec<_> = parts.iter().filter(|part| part["type"] == "image_url").collect();
        assert_eq!(images.len(), 1);
        let image = images[0]["image_url"]["url"].as_str().unwrap();
        assert_eq!(STANDARD.decode(image.strip_prefix("data:image/png;base64,").unwrap()).unwrap(), bytes);
        assert!(!request.body.to_string().contains(path.to_str().unwrap()));
        request.delta("STANDALONE_COMPOSER_ACCEPTED").await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        wait_view(&mut view, |screen| screen.contains("STANDALONE_COMPOSER_ACCEPTED")).await;
        support::wait_draft(&client, &fixture.session, "").await;
        assert!(client.load_draft("agent", &fixture.session, EDITOR).await.unwrap().unwrap().attachments.is_empty());
        select_composer(&client, "composer-ui", "composer").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("STANDALONE_COMPOSER_ACCEPTED")
                && view.accessibility_snapshot().iter().any(|node| node.label == "Conversation composer")
        }).await;
        assert_eq!(serde_json::to_value(client.operation_for_upload(&fixture.session, EDITOR, upload.id()).await.unwrap()).unwrap(), original);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("standalone composer replacement lost the resident draft, upload owner, or original send");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rebound_application_uses_its_agent_for_drafts_files_uploads_and_sends() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::configured(support::Options { images: true, ..Default::default() }).await;
        let client = fixture.client().await;
        client.save_draft("agent", &fixture.session, EDITOR, None, "GATEWAY_DRAFT".into()).await.unwrap();
        std::fs::write(fixture.directory.path().join("workspace/gateway-only.txt"), "original gateway file").unwrap();
        let workspace = fixture.directory.path().join("bound-workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("bound-only.txt"), "bound Agent file").unwrap();
        const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";
        let image = fixture.directory.path().join("bound-upload.png");
        let bytes = STANDARD.decode(PNG).unwrap();
        std::fs::write(&image, &bytes).unwrap();
        let source = r#"
import { Image, Text, View, signal } from 'nsh';
import { Button } from 'nsh/base';
import { AttachmentPicker } from 'maka/host';
import { Buffer } from 'buffer';
export function activate(context) {
  const application = context.application;
  const scope = signal(null);
  const summary = signal('BOUND_LOADING');
  const history = signal('');
  const upload = signal('');
  const sent = signal('');
  const image = signal(null);
  const loaded = signal(false);
  const failure = signal('');
  const report = error => failure.set(String(error));
  const readHistory = async () => {
    const sessionId = scope().sessionId;
    const observed = await application.query('agent', 'observe', { sessionId });
    const page = await application.query('agent', 'history', {
      sessionId, through: observed.through, position: { kind: 'tail' }, view: 'conversation'
    });
    history.set('BOUND_HISTORY:' + page.chunks.map(chunk => chunk.text ?? '').join('|'));
  };
  const start = async () => {
    const list = await application.query('agent', 'list', { filter: 'all', position: { kind: 'start' } });
    let session = list.sessions[0];
    if (!session) {
      const roots = await application.query('agent', 'directories', { kind: 'roots' });
      const created = await application.control('create', {
        title: 'BOUND_APPLICATION_SESSION', labels: [],
        workspace: { kind: 'directory', selection: roots.roots[0].selection }
      });
      session = created.reply.receipt.outcome.value.session;
    }
    const client = application.session(session.id);
    scope.set(client);
    let draft = await client.loadDraft();
    if (!draft.text) draft = await client.saveDraft(draft.revision, {
      text: 'BOUND_APPLICATION_DRAFT', attachments: [], settledUploads: []
    });
    const files = await application.query('agent', 'listFiles', { sessionId: session.id, path: null, after: null });
    summary.set('BOUND_TITLE:' + session.title + '\nBOUND_SESSION:' + session.id + '\nBOUND_DRAFT:' + draft.text +
      '\nBOUND_FILES:' + files.entries.map(file => application.pathLabel(file.path)).join('|'));
    await readHistory();
  };
  const uploaded = async status => {
    if (status.kind !== 'complete') return;
    const client = scope();
    const original = await client.findUpload(status.operationId);
    const attachment = original.receipt.outcome.value.attachment;
    const draft = await client.loadDraft();
    await client.saveDraft(draft.revision, {
      text: draft.text, attachments: [{ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, bytes: attachment.bytes }],
      settledUploads: [original.id]
    });
    upload.set('BOUND_UPLOAD:' + original.id);
    const selector = Buffer.from(JSON.stringify({ sessionId: client.sessionId, source: { kind: 'uploaded', id: attachment.id }, offset: 0 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    image.set(application.assetUri('asset:/attachment-image/' + selector));
  };
  const send = async () => {
    const client = scope();
    const draft = await client.loadDraft();
    const id = await client.reserveSend(draft.revision, {
      model: context.configuration.selection, thinkingLevel: null
    });
    const operation = await client.confirmSend(id);
    sent.set('BOUND_SEND:' + operation.operationId);
  };
  void start().catch(report);
  return { exports: { root: { kind: 'root', render() {
    return <View style={{flex:1,padding:8,gap:8}}>
      <Text>{summary()}</Text><Text>{history()}</Text><Text>{upload()}</Text><Text>{sent()}</Text><Text>{failure()}</Text>
      <If when={scope()}>
        <AttachmentPicker client={scope()} visible pathLabel="Bound attachment path" pathPlaceholder="Absolute path…"
          uploadLabel="Upload bound file" uploadingLabel="Uploading…" onStatus={status => { void uploaded(status).catch(report); }} />
      </If>
      <If when={image()}>
        <Image src={image()} style={{width:32,height:32}} onLoad={() => loaded.set(true)} onError={event => report(event.message)} />
      </If>
      <Text>{loaded() ? 'BOUND_IMAGE_READY' : ''}</Text>
      <Button accessibilityLabel="Send bound draft" disabled={!loaded() || !!sent()} onPress={() => { void send().catch(report); }}><Text>Send bound draft</Text></Button>
      <Button accessibilityLabel="Read bound history" disabled={!scope()} onPress={() => { void readHistory().catch(report); }}><Text>Read bound history</Text></Button>
    </View>;
  } } }, async prepareReload() {
    const client = scope();
    if (client) {
      const draft = await client.loadDraft();
      await client.saveDraft(draft.revision, {
        text: draft.text, attachments: draft.attachments, settledUploads: []
      });
    }
    return null;
  } };
}
"#;
        let module = tokio::task::spawn_blocking(move || nsh_bundler::compile_module("bound-application.tsx", source,
            &[nsh_base::registry().into(), maka_workbench::bindings::ui_set_description()]).unwrap()).await.unwrap();
        let metadata = client.query("management", "read", json!({})).await.unwrap();
        let installed = manage(&client, "installSource", json!({
            "expectedRevision":metadata["source"]["reference"]["revision"],
            "files":{
                "maka.extension.json":json!({
                    "schemaVersion":1,"id":"test.bound.application",
                    "application":{"ui":{
                        "module":"ui.js","configuration":{"type":"object","properties":{"selection":{"type":"object"}},"required":["selection"],"additionalProperties":false},
                        "imports":{"agent":{"contract":maka_agent_api::contract(),"cardinality":{"kind":"one"}}},
                        "contributions":{"root":{"kind":"root"}}
                    }}
                }).to_string(),
                "ui.js":module
            }
        })).await;
        let metadata = client.query("management", "read", json!({})).await.unwrap();
        let mut input = metadata["source"]["input"].clone();
        let mut agent = input["instances"]["agent"].clone();
        let agent_key = Uuid::new_v4();
        agent["key"] = json!(agent_key);
        agent["configuration"]["values"]["workspaceRoots"] = json!([{"label":"Bound workspace","path":workspace}]);
        input["instances"]["bound-agent"] = agent;
        let ui_key = Uuid::new_v4();
        input["instances"]["bound-probe"] = json!({
            "key":ui_key,"package":{"source":"pinned","package":installed["package"]},"usePackage":"ui",
            "configuration":{"values":{"selection":fixture.selection}},
            "bindings":{"agent":[{"kind":"instance","path":["agent"],"export":"agent"}]}
        });
        input["ui"] = json!({"path":["bound-probe"],"id":"root"});
        manage(&client, "replaceSource", json!({
            "expectedRevision":metadata["source"]["reference"]["revision"],
            "document":{"input":input,"remoteExports":metadata["source"]["remoteExports"],"packages":metadata["packages"]}
        })).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        let reload = bindings.reload();
        let mut requests = reload.take_requests();
        wait_view(&mut view, |screen| screen.contains("BOUND_TITLE:NSH real Agent") && screen.contains("BOUND_DRAFT:GATEWAY_DRAFT") && screen.contains("gateway-only.txt")).await;
        let metadata = client.query("management", "read", json!({})).await.unwrap();
        let mut input = metadata["source"]["input"].clone();
        input["instances"]["bound-probe"]["bindings"]["agent"] = json!([{"kind":"instance","path":["bound-agent"],"export":"agent"}]);
        manage(&client, "replaceSource", json!({
            "expectedRevision":metadata["source"]["reference"]["revision"],
            "document":{"input":input,"remoteExports":metadata["source"]["remoteExports"],"packages":metadata["packages"]}
        })).await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view(&mut view, |screen| screen.contains("BOUND_TITLE:BOUND_APPLICATION_SESSION") && screen.contains("BOUND_DRAFT:BOUND_APPLICATION_DRAFT") && screen.contains("bound-only.txt") && !screen.contains("gateway-only.txt")).await;
        let catalog = client.query("management", "readUi", json!({})).await.unwrap();
        let (bound, _) = client.bind_ui(serde_json::from_value(catalog["source"].clone()).unwrap(), maka_plugin_core::composition::InstanceId(vec![ui_key])).await.unwrap();
        let sessions = bound.query("agent", "list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
        let session = sessions["sessions"][0]["id"].as_str().unwrap().to_owned();
        assert_ne!(session, fixture.session);
        let gateway = client.query("agent", "list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(gateway["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(gateway["sessions"][0]["id"], fixture.session);
        tab_to_label(&mut view, "Bound attachment path").await;
        view.handle_event(Event::Paste(image.to_str().unwrap().into()));
        support::click_button(&mut view, "Upload bound file").await;
        wait_view(&mut view, |screen| screen.contains("BOUND_IMAGE_READY")).await;
        let upload = view.accessibility_snapshot().iter().find_map(|node| node.label.strip_prefix("BOUND_UPLOAD:").map(str::to_owned)).unwrap();
        let upload_id = Uuid::parse_str(&upload).unwrap();
        let original_upload = bound.operation_for_upload(&session, EDITOR, upload_id).await.unwrap();
        assert_eq!(original_upload.upload.as_ref().unwrap().key.namespace, maka_plugin_core::composition::InstanceId(vec![agent_key]));
        assert_eq!(original_upload.reference.as_ref().unwrap().namespace, maka_plugin_core::composition::InstanceId(vec![agent_key]));
        assert!(client.operation_for_upload(&session, EDITOR, upload_id).await.is_err());
        let draft = bound.load_draft("agent", &session, EDITOR).await.unwrap().unwrap();
        assert_eq!(draft.text, "BOUND_APPLICATION_DRAFT");
        assert_eq!(draft.attachments.len(), 1);
        support::click_button(&mut view, "Send bound draft").await;
        let mut request = fixture.next_request().await;
        assert!(request.body.to_string().contains("BOUND_APPLICATION_DRAFT"));
        assert!(request.body.to_string().contains(PNG));
        request.delta("BOUND_APPLICATION_RESPONSE").await;
        request.finish().await;
        fixture.idle(&bound, &session).await;
        support::click_button(&mut view, "Read bound history").await;
        wait_view(&mut view, |screen| screen.contains("BOUND_APPLICATION_RESPONSE")).await;
        let send = view.accessibility_snapshot().iter().find_map(|node| node.label.strip_prefix("BOUND_SEND:").map(str::to_owned)).unwrap();
        let operation = bound.operation(Uuid::parse_str(&send).unwrap()).await.unwrap();
        assert_eq!(operation.draft.as_ref().unwrap().key.namespace, maka_plugin_core::composition::InstanceId(vec![agent_key]));
        assert_eq!(operation.reference.as_ref().unwrap().namespace, maka_plugin_core::composition::InstanceId(vec![agent_key]));
        let gateway_draft = client.load_draft("agent", &fixture.session, EDITOR).await.unwrap().unwrap();
        assert_eq!(gateway_draft.text, "GATEWAY_DRAFT");
        assert!(gateway_draft.attachments.is_empty());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        drop(view);
        bound.close().await.unwrap();
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("the bound application façade escaped its declared Agent during rebind");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installed_ui_panel_keeps_native_edits_and_host_receipts_through_configuration() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::configured(support::Options { plugins: true, ..Default::default() }).await;
        let client = fixture.client().await;
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        let reload = bindings.reload();
        let mut requests = reload.take_requests();
        wait_editable_composer(&mut view).await;
        tab_to_label(&mut view, "Message composer").await;
        view.handle_event(Event::Paste("UNRELATED_PLUGIN_RETAINS_EDIT".into()));
        wait_view_state(&mut view, |view, _| {
            view.surface().input_context().is_some_and(|input| input.text.as_deref() == Some("UNRELATED_PLUGIN_RETAINS_EDIT"))
        }).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        for _ in 0..3 {
            view.handle_event(Event::Key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)));
        }
        for _ in 0..5 {
            view.handle_event(Event::Key(KeyEvent::new(KeyCode::Right, KeyModifiers::SHIFT)));
        }
        wait_view_state(&mut view, |view, _| {
            view.surface().input_context().is_some_and(|input| input.selection == (3..8))
        }).await;
        let installed = install_dynamic_ui(&client).await;
        shortcut(&mut view, 'p');
        wait_focused_input(&mut view, "Search commands").await;
        view.handle_event(Event::Paste("Open dynamic panel".into()));
        wait_view_state(&mut view, |view, _| {
            selected_command(&view.accessibility_snapshot(), "Open dynamic panel").is_some()
        }).await;
        support::click_button(&mut view, "Close commands").await;
        wait_focused_input(&mut view, "Message composer").await;
        let retained = view.surface().input_context().unwrap();
        assert_eq!(retained.text.as_deref(), Some("UNRELATED_PLUGIN_RETAINS_EDIT"));
        assert_eq!(retained.selection, 3..8);
        shortcut(&mut view, 'z');
        wait_view_state(&mut view, |view, _| {
            view.surface().input_context().is_some_and(|input| input.text.as_deref() == Some(""))
        }).await;
        support::wait_draft(&client, &fixture.session, "").await;
        open_panel(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PANEL_INITIAL")).await;
        support::click_button(&mut view, "Read actual session").await;
        wait_view(&mut view, |screen| screen.contains("HOST_TITLE:NSH real Agent")).await;
        evidence("ui-plugin-real-host-panel", &view.snapshot());
        let (operation_id, original_operation) = record_original_mutation(&mut view, &client).await;

        support::click_button(&mut view, "Close panel").await;
        shortcut(&mut view, 'p');
        select_palette(
            &mut view,
            "Search commands…",
            "Connections & models",
            "Connections & models",
        )
        .await;
        support::click_button(&mut view, "Settings section Dynamic preferences").await;
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_SETTINGS_READY")).await;
        support::click_button(&mut view, "Close settings").await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        let command = "/dynamic-panel";
        view.handle_event(Event::Paste(command.into()));
        support::wait_enabled_button(&mut view, command).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PANEL_INITIAL")).await;
        support::wait_draft(&client, &fixture.session, "").await;
        let instance = installed.instance.clone();
        let ui_instance = serde_json::from_value(instance.clone()).unwrap();
        assert_eq!(serde_json::to_value(client.operation_for_ui(&ui_instance, operation_id).await.unwrap()).unwrap(), original_operation);
        tab_to_label(&mut view, "Dynamic private editor").await;
        view.handle_event(Event::Paste("PRIVATE_PANEL_EDIT".into()));
        wait_view(&mut view, |screen| screen.contains("PANEL_PRIVATE:PRIVATE_PANEL_EDIT")).await;
        support::click_button(&mut view, "Block UI replacement").await;
        manage(
            &client,
            "configure",
            json!({
                "expectedRevision": installed.source["revision"],
                "instance": instance,
                "changes":[{"path":["caption"],"value":{"kind":"text","text":"DYNAMIC_CONFIG_UPDATED"}}]
            }),
        )
        .await;
        prepare_ui_reload(&mut view, &mut requests).await;
        assert!(matches!(
            reload_request(&mut view, &mut requests).await,
            maka_workbench::reload::Request::Resume
        ));
        view.surface_mut().set_input_paused(false);
        wait_view(&mut view, |screen| {
            screen.contains("DYNAMIC_PREPARATION_BLOCKED")
                && screen.contains("DYNAMIC_PANEL_INITIAL")
                && screen.contains("PANEL_PRIVATE:PRIVATE_PANEL_EDIT")
                && !screen.contains("DYNAMIC_CONFIG_UPDATED")
        }).await;
        tab_to_label(&mut view, "Dynamic private editor").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        view.handle_event(Event::Paste("_AFTER_FAILURE".into()));
        wait_view(&mut view, |screen| screen.contains("PANEL_PRIVATE:PRIVATE_PANEL_EDIT_AFTER_FAILURE")).await;
        support::click_button(&mut view, "Allow UI replacement").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view(&mut view, |screen| {
            screen.contains("DYNAMIC_CONFIG_UPDATED")
                && screen.contains("PANEL_PRIVATE:PRIVATE_PANEL_EDIT_AFTER_FAILURE")
                && !screen.contains("DYNAMIC_PANEL_INITIAL")
        })
        .await;
        assert_eq!(serde_json::to_value(client.operation_for_ui(&ui_instance, operation_id).await.unwrap()).unwrap(), original_operation);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("installed panel configuration lost native edits or original Host calls");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn custom_ui_root_restores_private_state_and_closes_replaced_subscriptions() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::configured(support::Options { plugins: true, ..Default::default() }).await;
        let client = fixture.client().await;
        let installed = install_dynamic_ui(&client).await;
        let instance = installed.instance.clone();
        let ui_instance = serde_json::from_value(instance.clone()).unwrap();
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        let reload = bindings.reload();
        let mut requests = reload.take_requests();
        wait_editable_composer(&mut view).await;
        open_panel(&mut view).await;
        let (operation_id, original_operation) = record_original_mutation(&mut view, &client).await;
        support::click_button(&mut view, "Close panel").await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        view.handle_event(Event::Paste("DYNAMIC_PLUGIN_UNSENT_DRAFT".into()));
        let custom = select_root(&client, "dynamic-ui", "root").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("CUSTOM_ROOT:DYNAMIC_PANEL_INITIAL")
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
        // The idle custom root has only the shared catalog subscription.
        wait_active_calls(&mut view, &fixture, 1).await;
        let calls_before_watch = maka_host_runtime::application::host::Client::status(&fixture.address, None).await.unwrap().active_calls;
        support::click_button(&mut view, "Watch original session").await;
        wait_view(&mut view, |screen| screen.contains("ROOT_WATCH_READY")).await;
        wait_active_calls(&mut view, &fixture, calls_before_watch + 1).await;
        let loaded = fixture.store.load_application(client.source().deployment).await.unwrap().unwrap();
        let old_package = loaded.packages().iter().find(|package| serde_json::to_value(package.application_ref()).unwrap() == installed.package).unwrap();
        let manifest = String::from_utf8(old_package.file("maka.extension.json").unwrap().to_vec()).unwrap();
        let metadata = client.query("management", "read", json!({})).await.unwrap();
        let upgraded = manage(&client, "installSource", json!({
            "expectedRevision":metadata["source"]["reference"]["revision"],
            "files":{
                "maka.extension.json":manifest,
                "ui.js":MODULE.replace("ROOT_PRIVATE:", "UPDATED_ROOT_PRIVATE:")
            }
        })).await;
        assert_eq!(upgraded["package"]["id"], installed.package["id"]);
        assert_ne!(upgraded["package"]["revision"], installed.package["revision"]);
        let metadata = client.query("management", "read", json!({})).await.unwrap();
        let mut input = metadata["source"]["input"].clone();
        input["instances"]["dynamic-ui"]["package"]["package"] = upgraded["package"].clone();
        manage(&client, "replaceSource", json!({
            "expectedRevision":metadata["source"]["reference"]["revision"],
            "document":{"input":input,"remoteExports":metadata["source"]["remoteExports"],"packages":metadata["packages"]}
        })).await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("UPDATED_ROOT_PRIVATE:PRIVATE_ROOT_EDIT")
                && screen.contains("ROOT_RESTORED:PRIVATE_ROOT_EDIT")
                && !view.accessibility_snapshot().iter().any(|node| node.label == "ROOT_PRIVATE:PRIVATE_ROOT_EDIT")
        }).await;
        wait_active_calls(&mut view, &fixture, calls_before_watch).await;
        let catalog = client.query("management", "readUi", json!({})).await.unwrap();
        let updated = catalog["instances"].as_array().unwrap().iter().find(|item| item["path"] == json!(["dynamic-ui"])).unwrap();
        assert_eq!(updated["instance"], instance);
        assert_eq!(updated["package"], upgraded["package"]);
        assert_eq!(serde_json::to_value(client.operation_for_ui(&ui_instance, operation_id).await.unwrap()).unwrap(), original_operation);
        select_root(&client, "dynamic-ui", "alternate").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view(&mut view, |screen| {
            screen.contains("OTHER_ROOT_RESTORED:none")
                && !screen.contains("PRIVATE_ROOT_EDIT")
                && !screen.contains("CUSTOM_ROOT:")
        }).await;
        select_root(&client, "workbench-ui", "root").await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_editable_composer(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PLUGIN_UNSENT_DRAFT")).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("custom root replacement lost state or retained its original subscription");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabled_and_removed_ui_preserve_drafts_and_original_host_receipts() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::configured(support::Options { plugins: true, ..Default::default() }).await;
        let client = fixture.client().await;
        let installed = install_dynamic_ui(&client).await;
        let instance = installed.instance.clone();
        let ui_instance = serde_json::from_value(instance.clone()).unwrap();
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        let reload = bindings.reload();
        let mut requests = reload.take_requests();
        wait_editable_composer(&mut view).await;
        open_panel(&mut view).await;
        let (operation_id, original_operation) = record_original_mutation(&mut view, &client).await;
        support::click_button(&mut view, "Close panel").await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        view.handle_event(Event::Paste("DYNAMIC_PLUGIN_UNSENT_DRAFT".into()));
        let disabled = manage(
            &client,
            "setEnabled",
            json!({
                "expectedRevision":installed.source["revision"],
                "instance":instance,"enabled":false
            }),
        )
        .await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        let restored = reload.restored();
        let workbench_state = restored["instances"].as_array().unwrap().iter()
            .find(|item| item["packageId"] == "maka.workbench").unwrap();
        assert_eq!(workbench_state["state"]["sessionId"], fixture.session);
        support::wait_draft(&client, &fixture.session, "DYNAMIC_PLUGIN_UNSENT_DRAFT").await;
        let disabled_catalog = client
            .query("management", "readUi", json!({"source": disabled}))
            .await
            .unwrap();
        assert!(!disabled_catalog["instances"].as_array().unwrap().iter().any(|item| item["path"] == json!(["dynamic-ui"])));
        wait_editable_composer(&mut view).await;
        shortcut(&mut view, 'p');
        wait_focused_input(&mut view, "Search commands").await;
        view.handle_event(Event::Paste("Open dynamic panel".into()));
        wait_view(&mut view, |screen| screen.contains("No matches.")).await;
        support::click_button(&mut view, "Close commands").await;
        manage(&client, "setEnabled", json!({"expectedRevision":disabled["revision"],"instance":instance,"enabled":true})).await;
        open_panel(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("DYNAMIC_PANEL_INITIAL")).await;
        let metadata = client.query("management", "read", json!({})).await.unwrap();
        let mut input = metadata["source"]["input"].clone();
        input["instances"].as_object_mut().unwrap().remove("dynamic-ui").unwrap();
        let packages: Vec<_> = metadata["packages"].as_array().unwrap().iter().filter(|package| package["id"] != installed.package["id"]).cloned().collect();
        let removed = manage(&client, "replaceSource", json!({
            "expectedRevision":metadata["source"]["reference"]["revision"],
            "document":{"input":input,"remoteExports":metadata["source"]["remoteExports"],"packages":packages}
        })).await;
        reload_ui(&mut view, &bindings, &mut requests, &fixture.session).await;
        wait_view_state(&mut view, |view, screen| screen.contains("DYNAMIC_PLUGIN_UNSENT_DRAFT") && !screen.contains("DYNAMIC_PANEL_INITIAL") && !view.accessibility_snapshot().iter().any(|node| node.label == "Close panel")).await;
        let current = client.query("management", "read", json!({})).await.unwrap();
        assert_eq!(current["source"]["reference"], removed);
        assert!(current["source"]["input"]["instances"].get("dynamic-ui").is_none());
        assert!(!current["packages"].as_array().unwrap().iter().any(|package| package["id"] == installed.package["id"]));
        assert_eq!(serde_json::to_value(client.operation_for_ui(&ui_instance, operation_id).await.unwrap()).unwrap(), original_operation);
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(observed["session"]["title"], "UI original receipt");
        assert_eq!(observed["session"]["revision"], original_operation["receipt"]["outcome"]["value"]["session"]["revision"]);
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
    .expect("UI disable, re-enable or removal lost the original draft or receipt");
}
