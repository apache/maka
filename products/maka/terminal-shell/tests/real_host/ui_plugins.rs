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
