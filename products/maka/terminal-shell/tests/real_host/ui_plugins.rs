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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_custom_root_reloads_its_private_state_without_an_agent_in_its_source_or_parent_catalogue()
 {
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
import { Button } from 'nsh/base';
export function activate(context) {
  const restored = context.restored?.note ?? 'EMPTY';
  const note = signal(restored);
  return { prepareReload: () => ({ note: note() }), exports: {
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
      Text({ children: rejected ? 'VIEW_CONTRACT_REJECTED' : 'VIEW_CONTRACT_UNCHECKED' }),
      Text({ get children() { return 'VERSION_A private:' + note() + ' restored:' + restored; } }),
      Button({ accessibilityLabel: 'Edit private plugin state', style: { height: 32, flexShrink: 0 },
        onPress: () => note.set('PRIVATE_PLUGIN_STATE'),
        children: Text({ children: 'Edit private plugin state' }) })
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
        store.clone(),
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
    let mut options = AppOptions::default();
    options.data_dir = Some(directory.path().join("nsh"));
    let mut view = AppView::new(options);
    view.resize(100, 24);
    support::load_application(&mut view, &bindings, None);
    wait_view(&mut view, |screen| {
        screen.contains("CUSTOM_ROOT_WITHOUT_AGENT_READY")
            && screen.contains("EMBEDDED_SELECTED:SHARED_RUNTIME")
            && screen.contains("VIEW_CONTRACT_REJECTED")
            && screen.contains("Edit private plugin state")
    })
    .await;
    assert!(
        !view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.label == "Message composer")
    );
    let mut requests = bindings.reload().take_requests();
    support::click_button(&mut view, "Edit private plugin state").await;
    wait_view(&mut view, |screen| {
        screen.contains("VERSION_A private:PRIVATE_PLUGIN_STATE restored:EMPTY")
    })
    .await;
    let loaded = store.load_application(deployment).await.unwrap().unwrap();
    let mut input = loaded.source().input.clone();
    let previous = loaded
        .packages()
        .iter()
        .find(|package| package.manifest().id == "test.nsh.no-agent-root")
        .unwrap();
    let mut files = previous.files().clone();
    let next_module = String::from_utf8(files["ui.js"].clone())
        .unwrap()
        .replace("VERSION_A", "VERSION_B");
    files.insert("ui.js".into(), next_module.into_bytes());
    let replacement = Package::new(files).unwrap();
    input.instances.get_mut("ui").unwrap().package = replacement.application_ref().into();
    let mut packages: Vec<_> = loaded
        .packages()
        .iter()
        .filter(|package| package.manifest().id != "test.nsh.no-agent-root")
        .cloned()
        .collect();
    packages.push(replacement);
    store
        .commit_application(
            deployment,
            loaded.source().reference.revision,
            input,
            loaded.source().remote_exports.clone(),
            packages,
        )
        .await
        .unwrap();
    let mut paused = false;
    loop {
        support::tick(&mut view);
        assert!(view.last_error().is_none(), "{:?}", view.last_error());
        match requests.try_recv() {
            Ok(maka_workbench::reload::Request::Pause(ready)) => {
                assert!(!paused, "one update must pause the original UI once");
                paused = true;
                ready.send(Ok(())).unwrap();
            }
            Ok(maka_workbench::reload::Request::Reload) => {
                assert!(paused, "snapshots must be captured after pausing input");
                break;
            }
            Ok(maka_workbench::reload::Request::Resume) => {
                panic!("updated package was not reloaded")
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Err(error) => panic!("UI reload request channel ended: {error}"),
        }
    }
    drop(view);
    let mut options = AppOptions::default();
    options.data_dir = Some(directory.path().join("nsh"));
    let mut view = AppView::new(options);
    view.resize(100, 24);
    support::load_application(&mut view, &bindings, None);
    wait_view(&mut view, |screen| {
        screen.contains("VERSION_B private:PRIVATE_PLUGIN_STATE restored:PRIVATE_PLUGIN_STATE")
            && screen.contains("CUSTOM_ROOT_WITHOUT_AGENT_READY")
    })
    .await;
    drop(view);
    bindings.close().await.unwrap();
    host.shutdown().await.unwrap();
    server.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overlay_embedded_view_omits_loading_placeholder_without_clipping_error_recovery() {
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
        (
            "maka.extension.json".into(),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "id": "test.nsh.overlay-host-root",
                "application": {
                    "ui": {
                        "module": "ui.js",
                        "configuration": { "type": "object", "properties": {}, "additionalProperties": false },
                        "imports": {},
                        "contributions": { "root": { "kind": "root" } }
                    }
                }
            }))
            .unwrap(),
        ),
        (
            "ui.js".into(),
            br#"
import { Text, View, signal } from 'nsh';
import { Button } from 'nsh/base';
export function activate(context) {
  const opened = signal(false);
  const suspended = signal(false);
  globalThis.__markOverlayLoading = () => suspended.set(true);
  return {
    exports: {
      root: {
        kind: 'root',
        render() {
          return View({
            style: { flex: 1 },
            get children() {
              return [
                View({
                  style: { flex: 1 },
                  get children() {
                    return [
                      Text({
                        get children() {
                          return suspended()
                            ? 'MAIN_WORKBENCH_READY OVERLAY_LOADING_SUSPENDED'
                            : 'MAIN_WORKBENCH_READY WAITING_FOR_OVERLAY_IMPORT';
                        },
                      }),
                      Button({
                        accessibilityLabel: 'Release overlay load',
                        style: { height: 32, flexShrink: 0 },
                        onPress: () => globalThis.__releaseOverlay?.(),
                        children: Text({ children: 'Release overlay load' }),
                      }),
                      Button({
                        accessibilityLabel: 'Open overlay',
                        style: { height: 32, flexShrink: 0 },
                        onPress: () => opened.set(true),
                        children: Text({ children: 'Open overlay' }),
                      }),
                      Button({
                        accessibilityLabel: 'Bottom anchor',
                        style: { marginTop: 'auto', height: 32, flexShrink: 0 },
                        onPress: () => {},
                        children: Text({ children: 'Bottom anchor' }),
                      }),
                    ];
                  },
                }),
                context.runtime.renderView(
                  { path: ['overlay'], id: 'dialogHost' },
                  { id: 'test.overlay' },
                  { opened },
                  { loading: false },
                ),
              ];
            },
          });
        },
      },
    },
  };
}
"#
            .to_vec(),
        ),
    ]))
    .unwrap();
    let overlay = Package::new(BTreeMap::from([
        (
            "maka.extension.json".into(),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "id": "test.nsh.overlay-provider",
                "application": {
                    "ui": {
                        "module": "overlay.js",
                        "configuration": { "type": "object", "properties": {}, "additionalProperties": false },
                        "imports": {},
                        "contributions": {
                            "dialogHost": { "kind": "view", "contract": "test.overlay" }
                        }
                    }
                }
            }))
            .unwrap(),
        ),
        (
            "overlay.js".into(),
            br#"
import { Text } from 'nsh';
globalThis.__markOverlayLoading?.();
await new Promise((resolve) => {
  globalThis.__releaseOverlay = resolve;
});
let attempts = 0;
export function activate() {
  attempts += 1;
  if (attempts === 1) {
    throw new Error('OVERLAY_ACTIVATION_FAILED');
  }
  return {
    exports: {
      dialogHost: {
        kind: 'view',
        contract: 'test.overlay',
        render(props) {
          return () => (props.input.opened() ? Text({ children: 'OVERLAY_OPENED' }) : null);
        },
      },
    },
  };
}
"#
            .to_vec(),
        ),
    ]))
    .unwrap();
    let node = |package: &Package, key: u128, use_package: &str, bindings: Value| {
        json!({
            "key": Uuid::from_u128(key),
            "package": { "source": "pinned", "package": package.application_ref() },
            "usePackage": use_package,
            "configuration": { "values": {} },
            "bindings": bindings
        })
    };
    let deployment = Uuid::new_v4();
    store
        .commit_application(
            deployment,
            0,
            serde_json::from_value(json!({
                "ui": { "path": ["ui"], "id": "root" },
                "instances": {
                    "management": node(&manager, 1, "host", json!({})),
                    "receipts": node(&receipts, 2, "host", json!({})),
                    "gateway": node(&gateway, 3, "host", json!({
                        "management": [{ "kind": "instance", "path": ["management"], "export": "Management" }],
                        "receipts": [{ "kind": "instance", "path": ["receipts"], "export": "Receipts" }]
                    })),
                    "ui": node(&root, 4, "ui", json!({})),
                    "overlay": node(&overlay, 5, "ui", json!({}))
                }
            }))
            .unwrap(),
            vec![],
            vec![manager, receipts, gateway, root, overlay],
        )
        .await
        .unwrap();
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
    let address = support::socket(directory.path(), "overlay-host");
    let listener = LocalListener::bind(&address).unwrap();
    let server = tokio::spawn({
        let host = host.clone();
        async move { host.serve_local(listener, CancellationToken::new()).await }
    });
    let parent = HostClient::connect(&address, None).await.unwrap();
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
    let mut options = AppOptions::default();
    options.data_dir = Some(directory.path().join("nsh"));
    let mut view = AppView::new(options);
    view.resize(100, 24);
    support::load_application(&mut view, &bindings, None);
    let loading_screen = wait_view(&mut view, |screen| {
        screen.contains("MAIN_WORKBENCH_READY OVERLAY_LOADING_SUSPENDED")
            && screen.contains("Bottom anchor")
    })
    .await;
    assert!(
        !loading_screen.contains("Loading"),
        "loading=false must suppress the loading placeholder:\n{loading_screen}"
    );
    let viewport_bottom = view.viewport().height.0;
    let anchor = view
        .accessibility_snapshot()
        .into_iter()
        .find(|node| node.label == "Bottom anchor")
        .expect("Bottom anchor in accessibility tree");
    assert_eq!(
        anchor.frame.origin.y.0 + anchor.frame.size.height.0,
        viewport_bottom,
        "main pane must keep the full viewport height while overlay view is loading: {:?}",
        anchor.frame
    );

    // Release the overlay load: first activation fails, and both the error text
    // and Retry button must remain unclipped and interactive.
    support::click_button(&mut view, "Release overlay load").await;
    wait_view(&mut view, |screen| {
        screen.contains("This action could not be completed.") && screen.contains("Retry")
    })
    .await;
    support::click_button(&mut view, "Retry").await;
    wait_view(&mut view, |screen| {
        !screen.contains("This action could not be completed.") && !screen.contains("Retry")
    })
    .await;
    let anchor_after_retry = view
        .accessibility_snapshot()
        .into_iter()
        .find(|node| node.label == "Bottom anchor")
        .expect("Bottom anchor after retry");
    assert_eq!(
        anchor_after_retry.frame.origin.y.0 + anchor_after_retry.frame.size.height.0,
        viewport_bottom,
        "recovered closed overlay view must take zero height: {:?}",
        anchor_after_retry.frame
    );
    support::click_button(&mut view, "Open overlay").await;
    wait_view(&mut view, |screen| screen.contains("OVERLAY_OPENED")).await;

    drop(view);
    bindings.close().await.unwrap();
    host.shutdown().await.unwrap();
    server.await.unwrap().unwrap();
}
