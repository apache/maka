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

use maka_client::Client;
use maka_plugins::terminal_ui::view::{self, Control, Node, Reply, Request, Target};
use maka_protocol::plugin::{Query, QueryResult, RemoteBinding, RemoteRequest, RemoteResult, View};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Discovery and mutation use the same real client/connection as candidate reads.
pub(super) async fn exercise(client: &Client, session: &str) {
    let directory = client
        .plugin_query(Query {
            view: View::TerminalViews,
            root_id: Some(maka_plugins::composition::Scope::Profile),
            cursor: None,
            limit: None,
        })
        .await
        .unwrap();
    let QueryResult::TerminalViews(directory) = directory else {
        panic!("terminal directory");
    };
    let view = directory
        .items
        .into_iter()
        .find(|view| view.package_id == "maka.skills")
        .unwrap();
    assert_eq!(view.descriptor.title.resolve("zh-CN"), "技能");
    let binding = RemoteBinding::Package {
        package_id: view.package_id,
        method: view.method,
        session_id: Some(session.into()),
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap()
    else {
        panic!("document");
    };
    let call = |input: Request| RemoteRequest::Call {
        binding: binding.clone(),
        target: view.target.clone(),
        document,
        input: serde_json::to_value(input).unwrap(),
    };
    let decode = |result| {
        let RemoteResult::Value { value } = result else {
            panic!("value");
        };
        assert!(serde_json::to_vec(&value).unwrap().len() <= 64 * 1024);
        let reply: Reply = serde_json::from_value(value).unwrap();
        reply.validate().unwrap();
        reply
    };
    // Traverse both the terminal's small windows and the domain catalog cursor.
    let mut route = Value::Null;
    let mut references = BTreeSet::new();
    let mut chosen = None;
    loop {
        let Reply::View { view } = decode(client.plugin_remote(call(read(&route))).await.unwrap())
        else {
            panic!("list");
        };
        let rows = links(&view.root);
        assert!(rows.len() <= 9);
        for (key, title, target) in &rows {
            if key == "next" {
                continue;
            }
            assert!(references.insert(key.clone()), "repeated row");
            if title == "Review 128" {
                chosen = Some(target.clone());
            }
        }
        let Some((_, _, next)) = rows.into_iter().find(|(key, ..)| key == "next") else {
            break;
        };
        assert!(references.len() < 512, "bounded fixture must terminate");
        route = next;
    }
    assert!(references.len() >= 129);
    let route = chosen.unwrap();
    let Reply::View { view: page } =
        decode(client.plugin_remote(call(read(&route))).await.unwrap())
    else {
        panic!("detail");
    };
    assert_eq!(page.fields.len(), 2);
    let fields = BTreeMap::from([
        ("enabled".into(), json!(false)),
        ("pinned".into(), json!(true)),
    ]);
    let input = page
        .submission(route.clone(), "save", fields.clone(), "en".into())
        .unwrap();
    assert!(matches!(
        decode(client.plugin_remote(call(input.clone())).await.unwrap()),
        Reply::Applied { .. }
    ));
    // A second writer must not partially apply either field from the old form.
    assert!(matches!(
        decode(
            client
                .plugin_remote(call(
                    page.submission(
                        route.clone(),
                        "save",
                        BTreeMap::from([
                            ("enabled".into(), json!(true)),
                            ("pinned".into(), json!(false))
                        ]),
                        "en".into()
                    )
                    .unwrap()
                ))
                .await
                .unwrap()
        ),
        Reply::Conflict
    ));
    let Reply::View { view: fresh } =
        decode(client.plugin_remote(call(read(&route))).await.unwrap())
    else {
        panic!("fresh detail");
    };
    assert_ne!(fresh.revision, page.revision);
    assert_eq!(values(&fresh), fields);
    // Unknown or extra fields are rejected at the plugin boundary too.
    let mut forged = input;
    if let Request::Submit {
        revision, fields, ..
    } = &mut forged
    {
        *revision = fresh.revision.clone();
        fields.insert("execute".into(), json!(true));
    }
    assert!(client.plugin_remote(call(forged)).await.is_err());
    assert!(matches!(
        decode(
            client
                .plugin_remote(call(
                    fresh
                        .submission(
                            route,
                            "save",
                            BTreeMap::from([
                                ("enabled".into(), json!(true)),
                                ("pinned".into(), json!(false))
                            ]),
                            "en".into()
                        )
                        .unwrap()
                ))
                .await
                .unwrap()
        ),
        Reply::Applied { .. }
    ));
    client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
}
fn read(route: &Value) -> Request {
    Request::Read {
        route: route.clone(),
        locale: "en".into(),
    }
}
/// Every row that reads another route: its key, title and route.
fn links(node: &Node) -> Vec<(String, String, Value)> {
    match node {
        Node::Item {
            key,
            title,
            target: Target::Route { route },
            ..
        } => vec![(key.clone(), title.clone(), route.clone())],
        _ => node.children().into_iter().flat_map(links).collect(),
    }
}
fn values(page: &view::View) -> BTreeMap<String, Value> {
    page.fields
        .iter()
        .map(|field| {
            let Control::Toggle { value } = field.control else {
                panic!("toggle");
            };
            (field.id.clone(), json!(value))
        })
        .collect()
}
