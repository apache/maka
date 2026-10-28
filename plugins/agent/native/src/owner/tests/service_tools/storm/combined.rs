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

//! One fixed integration workload, through the original in-process and local callers.
use super::*;
use crate::owner::tests::scale::{compaction, image_upload};
use image_upload::Picture;
use maka_agent_facts::{
    attachment::StorageRef,
    context::CheckpointMode,
    event::{InvocationInput, StoredEvent},
    input::MessageInput,
};
use maka_host_runtime::{
    application::{
        host::{Client as HostClient, Configuration, Host},
        transport::{Grant as EndpointGrant, HostEndpoint, Reply},
    },
    ipc::LocalListener,
};
use maka_plugin_core::operation::OperationReply;

const CASE: Case = Case {
    calls: 128,
    bytes: 65_536,
    javascript: false,
    query: true,
    model_usage: false,
};

fn large_message() -> String {
    let mut bytes: Vec<u8> = (0..600 * 1024).map(|i| b'a' + (i % 26) as u8).collect();
    for (at, marker) in [
        (0, &b"K69_HEAD"[..]),
        (300 * 1024, &b"K69_MIDDLE"[..]),
        (600 * 1024 - 8, &b"K69_TAIL"[..]),
    ] {
        bytes[at..at + marker.len()].copy_from_slice(marker);
    }
    String::from_utf8(bytes).unwrap()
}

enum Caller<'a> {
    InProcess(&'a Fixture),
    Local(&'a HostClient),
}
impl Caller<'_> {
    async fn query(&self, endpoint: &str, method: &str, input: Value) -> Value {
        match self {
            Self::InProcess(f) => {
                let client = f.app.client();
                let binding = client
                    .bind(
                        client.activation(&id(2)).unwrap(),
                        if endpoint == "agent" {
                            EXPORT
                        } else {
                            "receipts"
                        }
                        .into(),
                    )
                    .await
                    .unwrap()
                    .remove(0);
                let completion = client
                    .start(
                        binding,
                        method.into(),
                        input,
                        scope(&f.issuer, true),
                        Attachments::new().into(),
                    )
                    .await
                    .unwrap()
                    .completion()
                    .await;
                completion.cleanup.unwrap();
                completion.result.unwrap()
            }
            Self::Local(client) => {
                let mut call = client
                    .call(endpoint, method.into(), input, Attachments::new())
                    .await
                    .unwrap();
                call.start().await.unwrap();
                let Reply::Finished { result, cleanup } = call.receive().await.unwrap() else {
                    panic!("original query terminal reply required")
                };
                let value = result.unwrap();
                cleanup.unwrap();
                call.close().await.unwrap();
                assert!(call.cleanup_confirmed());
                value
            }
        }
    }

    async fn mutate(&self, method: &str, input: Value, resources: Attachments) -> OperationReply {
        let reply = match self {
            Self::InProcess(f) => {
                let client = f.app.client();
                let prepared = client
                    .prepare_mutation(
                        f.binding(2).await,
                        method.into(),
                        input,
                        scope(&f.issuer, true),
                        Uuid::new_v4(),
                        resources.into(),
                    )
                    .await
                    .unwrap();
                let reference = prepared.reference().clone();
                let completion = client
                    .mutate_owned(prepared)
                    .await
                    .unwrap()
                    .completion()
                    .await;
                completion.cleanup.unwrap();
                assert_eq!(completion.reply.reference, reference);
                completion.reply
            }
            Self::Local(client) => {
                let mut call = client
                    .call("agent", method.into(), input, resources)
                    .await
                    .unwrap();
                call.start().await.unwrap();
                assert!(matches!(
                    call.receive().await.unwrap(),
                    Reply::Prepared { .. }
                ));
                let reference = call.reference().unwrap().clone();
                let Reply::Mutation { reply, cleanup } = call.confirm().await.unwrap() else {
                    panic!("original mutation terminal reply required")
                };
                cleanup.unwrap();
                assert_eq!(reply.reference, reference);
                call.close().await.unwrap();
                assert!(call.cleanup_confirmed());
                *reply
            }
        };
        returned(&reply);
        self.recover(&reply).await;
        reply
    }

    async fn recover(&self, original: &OperationReply) {
        match self {
            Self::InProcess(f) => {
                let client = f.app.client();
                let observed = client
                    .recover(
                        client.activation(&id(2)).unwrap(),
                        original.reference.clone(),
                        scope(&f.issuer, true),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(observed.reference, original.reference);
                let Receipt::Recorded { outcome, cleanup } = &original.receipt else {
                    unreachable!()
                };
                assert_eq!(&observed.outcome, outcome);
                assert_eq!(&observed.cleanup, cleanup);
            }
            Self::Local(_) => {
                let observed: OperationReply = serde_json::from_value(
                    self.query(
                        "receipts",
                        "read",
                        serde_json::to_value(&original.reference).unwrap(),
                    )
                    .await,
                )
                .unwrap();
                assert_eq!(&observed, original);
            }
        }
    }
}

fn returned(reply: &OperationReply) -> &Value {
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        cleanup: OperationCleanup::Confirmed,
    } = &reply.receipt
    else {
        panic!("original Returned/Confirmed receipt required: {reply:?}")
    };
    value
}

struct LocalOwner {
    client: Option<HostClient>,
    host: Arc<Host>,
    owner: Option<Arc<Owner>>,
    capture: Arc<StdMutex<Option<Arc<Owner>>>>,
    server: Option<tokio::task::JoinHandle<Result<(), String>>>,
}

fn providers(setup: &Setup, capture: Arc<StdMutex<Option<Arc<Owner>>>>) -> NativeRegistry {
    let mut native = NativeRegistry::default();
    maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
    setup.provide(&mut native);
    native
        .insert(
            IMPLEMENTATION.into(),
            Arc::new(move |context, configuration| {
                let capture = capture.clone();
                Box::pin(async move {
                    let owner = Owner::open(
                        context,
                        configuration,
                        crate::owner::tests::bundled_catalog(),
                    )
                    .await
                    .unwrap();
                    *capture.lock().unwrap() = Some(owner.clone());
                    let service = Arc::new(Agent(owner));
                    NativeActivation {
                        owner: service.clone(),
                        exports: Ok(BTreeMap::from([(
                            EXPORT.into(),
                            maka_plugin_core::runtime::Published {
                                contract: contract(),
                                value: service as Arc<dyn maka_host_runtime::application::Handler>,
                            },
                        )])),
                    }
                })
            }),
        )
        .unwrap();
    native
}

async fn local_owner(
    current: &mut Option<LocalOwner>,
    f: &Fixture,
    setup: &Setup,
    deployment: Uuid,
) {
    assert!(current.is_none());
    // The original Application has already acknowledged shutdown. Reuse its held
    // RootStore, never create a second active Application or a second writer.
    let capture = Arc::new(StdMutex::new(None));
    let selections = BTreeMap::from([
        (
            "agent".into(),
            HostEndpoint {
                consumer: id(2),
                import: EXPORT.into(),
                grant: EndpointGrant {
                    methods: [
                        "directories",
                        "create",
                        "uploadAttachment",
                        "send",
                        "observe",
                        "execution",
                        "history",
                        "source",
                        "stop",
                    ]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                    recovery: false,
                },
            },
        ),
        (
            "receipts".into(),
            HostEndpoint {
                consumer: id(2),
                import: "receipts".into(),
                grant: EndpointGrant {
                    methods: ["read".into()].into(),
                    recovery: true,
                },
            },
        ),
    ]);
    let host = Host::open(
        f.store.clone(),
        deployment,
        providers(setup, capture.clone()),
        Some(maka_host_js::factory(Default::default())),
        Configuration::PublicHost {
            endpoints: selections,
            native: setup.native_grants(),
            product_methods: Default::default(),
        },
    )
    .await
    .unwrap();
    // Publish ownership before listener binding, spawning or connection can
    // fail/cancel. Outer cleanup retains even a partially initialized Host.
    *current = Some(LocalOwner {
        client: None,
        host,
        owner: None,
        capture,
        server: None,
    });
    let local = current.as_mut().unwrap();
    local.owner = local.capture.lock().unwrap().take();
    assert!(local.owner.is_some());
    #[cfg(unix)]
    let endpoint = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(f._dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        f._dir.path().join("combined.sock")
    };
    #[cfg(windows)]
    let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\maka-combined-{}", Uuid::new_v4()));
    let listener = LocalListener::bind(&endpoint).unwrap();
    local.server = Some(tokio::spawn({
        let host = local.host.clone();
        async move { host.serve_local(listener, CancellationToken::new()).await }
    }));
    local.client = Some(
        HostClient::connect(&endpoint, Some(local.host.epoch()))
            .await
            .unwrap(),
    );
}

async fn close_local(current: &mut Option<LocalOwner>) -> Result<(), String> {
    let Some(local) = current.as_mut() else {
        return Ok(());
    };
    let client = match local.client.as_mut() {
        Some(client) => client.close().await,
        None => Ok(()),
    };
    if client.is_ok() {
        local.client.take();
    }
    let host = local.host.shutdown().await;
    let server = match local.server.as_mut() {
        Some(server) => {
            // Poll the retained handle by reference. Cancellation leaves it in
            // current so outer cleanup can join it, rather than detach it.
            let result = server.await.map_err(|e| e.to_string()).and_then(|r| r);
            local.server.take();
            result
        }
        None => Ok(()),
    };
    client?;
    host?;
    server?;
    assert!(local.host.status().closed);
    if let Some(owner) = &local.owner {
        assert!(owner.workers.is_empty());
        assert!(owner.runs.lock().await.controls.is_empty());
    }
    // No awaited operation follows the removal of this settled owner.
    current.take();
    Ok(())
}

async fn quiescent(owner: &Owner) {
    assert!(owner.workers.close());
    owner.workers.wait().await;
    assert!(owner.workers.reopen());
    assert!(owner.workers.is_empty());
    assert!(owner.runs.lock().await.controls.is_empty());
}

async fn events(root: &RootStore, session: &str, after: u64) -> Vec<StoredEvent> {
    let store = root.session(session).await.unwrap();
    let through = *store.subscribe_commits().unwrap().borrow();
    let mut cursor = after;
    let mut result = Vec::new();
    loop {
        let page = store
            .session_events(session, cursor, through, 512, usize::MAX)
            .await
            .unwrap();
        result.extend(page.events);
        match page.next_after {
            Some(next) => {
                assert!(next > cursor);
                cursor = next;
            }
            None => return result,
        }
    }
}

async fn upload(
    f: &Fixture,
    caller: &Caller<'_>,
    session: &str,
    picture: &mut Picture,
) -> OperationReply {
    let snapshot = maka_ui_support::file::read_selected(
        &f._dir.path().join(&picture.name),
        &maka_ui_support::budget::NativeBudget::default(),
    )
    .unwrap();
    let resources = BTreeMap::from([(
        "file".into(),
        snapshot as Arc<dyn maka_capabilities::call::ReadResource>,
    )]);
    let reply = caller
        .mutate(
            "uploadAttachment",
            json!({"sessionId":session,"name":picture.name,
        "bytes":picture.bytes,"digest":picture.digest}),
            resources,
        )
        .await;
    picture.operation = reply.reference.operation;
    picture.reference = serde_json::to_value(&reply.reference).unwrap();
    let value = returned(&reply);
    assert_eq!(value["kind"], "uploaded");
    picture.descriptor = value["attachment"].clone();
    assert_eq!(picture.descriptor["sessionId"], session);
    assert_eq!(picture.descriptor["name"], picture.name);
    assert_eq!(picture.descriptor["mimeType"], "image/png");
    assert_eq!(picture.descriptor["bytes"], picture.bytes);
    image_upload::artifact(f, session, picture).await;
    reply
}

fn check_images(body: &Value, pictures: &[Picture], directory: &std::path::Path) {
    let urls: Vec<_> = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "image_url")
        .map(|part| part["image_url"]["url"].as_str().unwrap())
        .collect();
    assert_eq!(urls.len(), pictures.len());
    assert!(
        urls.iter()
            .all(|url| url.starts_with("data:image/png;base64,"))
    );
    let actual = images::model_images(body);
    assert_eq!(actual.len(), pictures.len());
    for (actual, picture) in actual.iter().zip(pictures) {
        let expected = std::fs::read(directory.join(&picture.name)).unwrap();
        assert_eq!(actual, &expected);
        assert_eq!(
            maka_agent_facts::artifact::content_digest(actual),
            picture.digest
        );
    }
}

fn text_parts(message: &Value) -> String {
    if let Some(text) = message["content"].as_str() {
        return text.into();
    }
    message["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|part| part["type"] == "text")
        .map(|part| part["text"].as_str().unwrap())
        .collect()
}

fn provider_text(message: &str, pictures: &[Picture]) -> String {
    // Provider reference labels are distinct from canonical MessageInput text
    // and the public history's arrow annotations. Keep this literal expected
    // representation independent of the production reference renderer.
    let mut expected = message.to_owned();
    for (index, picture) in pictures.iter().enumerate() {
        expected.push_str(if index == 0 { "\n\n" } else { "\n" });
        let resource = format!(
            "maka://runtime/attachments/{}",
            picture.descriptor["id"].as_str().unwrap()
        );
        expected.push_str(&format!(
            "<attachment>\nRead argument: {}\nMarkdown image source: {}\nSession resource; the Read path above differs from the display name.\nname: {}\nmime_type: {}\n</attachment>",
            json!({"path":resource}),
            json!(resource),
            json!(picture.name),
            json!("image/png"),
        ));
    }
    expected
}

fn retain_body(directory: &std::path::Path, ordinal: usize, body: &Value) {
    // This is the complete parsed logical JSON body, not original wire/header
    // bytes. A failed fixture retains its directory and all received ordinals.
    let bytes = serde_json::to_vec(body).unwrap();
    let path = directory.join(format!("combined-http-body-{ordinal}.json"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    std::io::Write::write_all(&mut file, &bytes).unwrap();
    drop(file);
    println!(
        "MAKA_K17_HTTP_BODY {}",
        json!({"request_ordinal":ordinal,"representation":"parsed_http_json",
            "path":path.display().to_string(),"bytes":bytes.len(),
            "digest":maka_agent_facts::artifact::content_digest(&bytes)})
    );
}

#[derive(Debug, PartialEq)]
struct RowIdentity {
    position: (u64, u64),
    message_id: String,
    turn_id: String,
    role: String,
}

#[derive(Debug, PartialEq)]
struct Snapshot {
    tail: i64,
    canonical: Vec<Vec<rusqlite::types::Value>>,
    directory: Vec<Vec<rusqlite::types::Value>>,
    public_identities: Vec<RowIdentity>,
    payloads: Vec<Vec<rusqlite::types::Value>>,
}

fn snapshot(f: &Fixture, session: &str) -> Snapshot {
    // These are quiescent read-only observations of actual stored columns/raw
    // JSON, independent of both the projector and its optional body cache.
    let db = rusqlite::Connection::open_with_flags(
        f.session_database(session),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    db.execute_batch("BEGIN").unwrap();
    let read = |sql: &str| {
        let mut statement = db.prepare(sql).unwrap();
        let columns = statement.column_count();
        statement
            .query_map([session], |row| {
                (0..columns)
                    .map(|column| row.get(column))
                    .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let result = Snapshot {
        tail: db
            .query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM runtime_events WHERE event_session=?1",
                [session],
                |row| row.get(0),
            )
            .unwrap(),
        canonical: read("SELECT * FROM runtime_events WHERE event_session=?1 ORDER BY sequence"),
        directory: read(
            "SELECT * FROM transcript_directory WHERE session_id=?1 ORDER BY source_sequence,item_index",
        ),
        public_identities: {
            // Identity only: don't regenerate bodies or assume ModelCompleted
            // owns streamed ModelObserved items. Successful activity/turn-state
            // metadata has no public body; failed/interrupted rows must not hide.
            let mut statement = db.prepare("SELECT source_sequence,item_index,message_id,turn_id,role FROM transcript_directory WHERE session_id=?1 AND (role IN ('user','assistant','tool_call','tool_result','context_compacted','model_interruption') OR (role='turn_state' AND state_status='failed')) ORDER BY source_sequence,item_index").unwrap();
            statement
                .query_map([session], |row| {
                    let role: String = row.get(4)?;
                    Ok(RowIdentity {
                        position: (row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64),
                        message_id: row.get(2)?,
                        turn_id: row.get(3)?,
                        role: match role.as_str() {
                            "context_compacted" => "compaction".into(),
                            "model_interruption" | "turn_state" => "failure".into(),
                            _ => role,
                        },
                    })
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        },
        payloads: read(
            "SELECT p.* FROM tool_result_payloads p JOIN runtime_events e ON e.event_id=p.event_id WHERE e.event_session=?1 ORDER BY p.event_id",
        ),
    };
    let failures: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM transcript_failures WHERE session_id=?1",
            [session],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(failures, 0);
    db.execute_batch("COMMIT").unwrap();
    result
}

fn annotated_body(message: &str, pictures: &[Picture]) -> String {
    let mut body = message.to_owned();
    for picture in pictures {
        assert!((1024..1_048_576).contains(&picture.bytes));
        body.push_str(&format!(
            "\n↳ {} · {:.1} KiB",
            picture.name,
            picture.bytes as f64 / 1024.0
        ));
    }
    body
}

async fn public_history(
    caller: &Caller<'_>,
    session: &str,
    through: u64,
    message: &str,
    pictures: &[Picture],
    tools: &BTreeMap<String, usize>,
    identities: &[RowIdentity],
) -> Value {
    let mut input = json!({"sessionId":session,"through":through,
        "position":{"kind":"start"},"view":"text"});
    let mut cursors = BTreeSet::new();
    let mut rows: Vec<Value> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut users = Vec::new();
    let mut assistants = Vec::new();
    let mut calls = BTreeSet::new();
    let mut results = BTreeSet::new();
    let mut compacted = 0;
    loop {
        let page = caller.query("agent", "history", input.clone()).await;
        assert_eq!(page["kind"], "ready");
        assert_eq!(page["through"], through);
        for chunk in page["chunks"].as_array().unwrap() {
            assert_eq!(chunk["field"], "body");
            let key = serde_json::to_string(&chunk["position"]).unwrap();
            if rows
                .last()
                .is_none_or(|row| row["position"] != chunk["position"])
            {
                let position = (
                    chunk["position"]["sourceSequence"].as_u64().unwrap(),
                    chunk["position"]["itemIndex"].as_u64().unwrap(),
                );
                if let Some(previous) = rows.last() {
                    let previous_position = (
                        previous["position"]["sourceSequence"].as_u64().unwrap(),
                        previous["position"]["itemIndex"].as_u64().unwrap(),
                    );
                    assert!(
                        position > previous_position,
                        "public rows must ascend strictly"
                    );
                }
                assert!(seen.insert(key), "a completed public row must not reappear");
                assert_eq!(chunk["offset"], 0);
                let mut row = chunk.clone();
                row["text"] = json!("");
                rows.push(row);
            }
            let row = rows.last_mut().unwrap();
            assert_eq!(row["messageId"], chunk["messageId"]);
            assert_eq!(row["turnId"], chunk["turnId"]);
            assert_eq!(row["role"], chunk["role"]);
            assert_eq!(row["totalBytes"], chunk["totalBytes"]);
            let mut text = row["text"].as_str().unwrap().to_owned();
            assert_eq!(chunk["offset"], text.len());
            text.push_str(chunk["text"].as_str().unwrap());
            assert!(text.len() as u64 <= row["totalBytes"].as_u64().unwrap());
            row["text"] = json!(text);
        }
        if page["after"].is_null() {
            break;
        }
        assert!(
            cursors.insert(serde_json::to_string(&page["after"]).unwrap()),
            "public cursor must advance"
        );
        input["position"] = json!({"kind":"after","cursor":page["after"]});
    }
    // Text traversal carries full tool-result bodies, but intentionally omits
    // empty compaction boundaries. Prove its exact identity set before using
    // the public exact-row interface to reveal that one recorded boundary.
    let compactions = identities
        .iter()
        .enumerate()
        .filter(|(_, identity)| identity.role == "compaction")
        .collect::<Vec<_>>();
    assert_eq!(compactions.len(), 1);
    let (compaction_ordinal, compaction_identity) = compactions[0];
    let text_identities = identities
        .iter()
        .filter(|identity| identity.role != "compaction")
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), text_identities.len());
    for (row, expected) in rows.iter().zip(text_identities) {
        assert_eq!(
            (
                row["position"]["sourceSequence"].as_u64().unwrap(),
                row["position"]["itemIndex"].as_u64().unwrap()
            ),
            expected.position
        );
        assert_eq!(row["messageId"], expected.message_id);
        assert_eq!(row["turnId"], expected.turn_id);
        assert_eq!(row["role"], expected.role);
    }
    let text_traversal_rows = rows.len();
    let page = caller
        .query(
            "agent",
            "history",
            json!({"sessionId":session,"through":through,"view":"text",
                "position":{"kind":"row","field":"body","position":{
                    "sourceSequence":compaction_identity.position.0,
                    "itemIndex":compaction_identity.position.1}}}),
        )
        .await;
    assert_eq!(page["kind"], "ready");
    assert_eq!(page["through"], through);
    // Exact-row windows may also carry following rows. Only the first chunk
    // is the requested boundary; later chunks do not supplement traversal.
    let boundary = page["chunks"].as_array().unwrap().first().unwrap();
    assert_eq!(
        (
            boundary["position"]["sourceSequence"].as_u64().unwrap(),
            boundary["position"]["itemIndex"].as_u64().unwrap()
        ),
        compaction_identity.position
    );
    assert_eq!(boundary["messageId"], compaction_identity.message_id);
    assert_eq!(boundary["turnId"], compaction_identity.turn_id);
    assert_eq!(boundary["role"], compaction_identity.role);
    assert_eq!(boundary["field"], "body");
    assert_eq!(boundary["offset"], 0);
    assert_eq!(boundary["totalBytes"], 0);
    assert_eq!(boundary["text"], "");
    assert!(boundary["compaction"]["durationMs"].as_u64().is_some());
    rows.insert(compaction_ordinal, boundary.clone());
    assert_eq!(
        rows.len(),
        identities.len(),
        "consume the complete stored public identity table"
    );
    for (row, expected) in rows.iter().zip(identities) {
        assert_eq!(
            (
                row["position"]["sourceSequence"].as_u64().unwrap(),
                row["position"]["itemIndex"].as_u64().unwrap()
            ),
            expected.position
        );
        assert_eq!(row["messageId"], expected.message_id);
        assert_eq!(row["turnId"], expected.turn_id);
        assert_eq!(row["role"], expected.role);
        let text = row["text"].as_str().unwrap();
        assert_eq!(text.len() as u64, row["totalBytes"].as_u64().unwrap());
        match row["role"].as_str().unwrap() {
            "user" => users.push(row.clone()),
            "assistant" => assistants.push(text.to_owned()),
            "tool_call" => {
                let metadata = &row["tool"];
                let id = metadata["toolUseId"].as_str().unwrap();
                assert!(tools.contains_key(id));
                assert!(calls.insert(id));
                assert_eq!(metadata["call"]["position"], row["position"]);
                assert_eq!(metadata["call"]["name"], "Counter");
                assert_eq!(metadata["call"]["pending"], false);
                assert_eq!(metadata["call"]["dispatched"], true);
                assert!(!metadata["result"].is_null());
                assert_eq!(text, "");
            }
            "tool_result" => {
                let id = row["tool"]["toolUseId"].as_str().unwrap();
                assert!(results.insert(id));
                assert_eq!(text, payload(tools[id], CASE.bytes));
            }
            "compaction" => {
                compacted += 1;
                assert_eq!(text, "");
            }
            other => panic!("unexpected public role {other}"),
        }
    }
    assert_eq!(users.len(), 3);
    for (index, user) in users[..2].iter().enumerate() {
        assert_eq!(user["text"], compaction::user_prompt(index, 2, 65_536));
    }
    let body = annotated_body(message, pictures);
    assert_eq!(users[2]["text"], body);
    let descriptors = users[2]["attachments"].as_array().unwrap();
    assert_eq!(descriptors.len(), pictures.len());
    for (descriptor, picture) in descriptors.iter().zip(pictures) {
        assert_eq!(descriptor["name"], picture.name);
        assert_eq!(descriptor["mimeType"], "image/png");
        assert_eq!(descriptor["bytes"], picture.bytes);
        assert!(descriptor.get("ref").is_none());
    }
    assert_eq!(
        assistants,
        vec![
            compaction::main_answer(0, 2),
            compaction::main_answer(1, 2),
            FINAL.into()
        ]
    );
    assert_eq!(calls.len(), CASE.calls);
    assert_eq!(results.len(), CASE.calls);
    assert_eq!(compacted, 1);
    assert_eq!(rows.len(), 3 + 3 + CASE.calls * 2 + 1);

    let mut source = String::new();
    loop {
        let page = caller
            .query(
                "agent",
                "source",
                json!({"sessionId":session,"through":through,
            "source":{"kind":"row","position":users[2]["position"]},"field":"body",
            "position":{"kind":"after","offset":source.len()}}),
            )
            .await;
        let fragment = &page["source"];
        assert_eq!(fragment["offset"], source.len());
        assert_eq!(fragment["totalBytes"], body.len());
        let text = fragment["text"].as_str().unwrap();
        assert!(!text.is_empty());
        source.push_str(text);
        assert!(source.len() <= body.len());
        if source.len() == body.len() {
            break;
        }
    }
    assert_eq!(source, body);
    json!({"through":through,"rows":rows,"source":source,
        "representation":"text_traversal_with_exact_compaction",
        "text_traversal_rows":text_traversal_rows})
}

async fn verify_all_facts(
    f: &Fixture,
    session: &str,
    invocations: &[String],
    message: &str,
    pictures: &[Picture],
) -> (BTreeMap<String, usize>, Value) {
    let facts = events(&f.store, session, 0).await;
    let mut openings = Vec::new();
    let mut prompt_digests = Vec::new();
    let mut payload_digests = BTreeMap::new();
    let mut requests = BTreeMap::new();
    let mut completed = BTreeSet::new();
    let mut checkpoint = None;
    let mut combined_opening = None;
    let mut tools = BTreeMap::new();
    for stored in &facts {
        assert!(invocations.contains(&stored.event.invocation.invocation_id));
        match &stored.event.fact {
            Fact::InvocationOpened { input, .. } => {
                let index = openings.len();
                assert_eq!(stored.event.invocation.invocation_id, invocations[index]);
                let InvocationInput::Message { content, .. } = input else {
                    panic!("message input")
                };
                prompt_digests.push(maka_agent_facts::artifact::content_digest(
                    content.text.as_bytes(),
                ));
                if index < 2 {
                    assert_eq!(content.text, compaction::user_prompt(index, 2, 65_536));
                    assert!(content.attachments.as_ref().is_none_or(Vec::is_empty));
                } else {
                    assert_eq!(content.text, message);
                    let mut expected = MessageInput::from(large_message());
                    expected.attachments = Some(
                        pictures
                            .iter()
                            .map(|picture| maka_agent_facts::attachment::AttachmentRef {
                                kind: maka_agent_facts::attachment::AttachmentKind::Image,
                                name: picture.name.clone(),
                                mime_type: "image/png".into(),
                                bytes: picture.bytes as u64,
                                storage_ref: StorageRef::SessionFile {
                                    session_id: session.into(),
                                    relative_path: picture.descriptor["id"]
                                        .as_str()
                                        .unwrap()
                                        .into(),
                                },
                            })
                            .collect(),
                    );
                    assert_eq!(
                        content.content_digest().unwrap(),
                        expected.content_digest().unwrap()
                    );
                    let attachments = content.attachments.as_ref().unwrap();
                    assert_eq!(attachments.len(), pictures.len());
                    for (attachment, picture) in attachments.iter().zip(pictures) {
                        assert_eq!(attachment.name, picture.name);
                        assert_eq!(attachment.bytes, picture.bytes as u64);
                        assert_eq!(attachment.mime_type, "image/png");
                        assert_eq!(
                            attachment.storage_ref,
                            StorageRef::SessionFile {
                                session_id: session.into(),
                                relative_path: picture.descriptor["id"].as_str().unwrap().into(),
                            }
                        );
                    }
                    combined_opening = Some(stored.event.id.clone());
                }
                openings.push(stored.event.id.clone());
            }
            Fact::ModelRequested {
                step_id,
                purpose,
                checkpoint_event_id,
                ..
            } => {
                assert!(
                    requests
                        .insert(
                            step_id.clone(),
                            (*purpose, stored.event.invocation.invocation_id.clone())
                        )
                        .is_none()
                );
                if let Some(checkpoint) = &checkpoint {
                    assert_eq!(purpose, &ModelPurpose::Main);
                    assert_eq!(checkpoint_event_id.as_ref(), Some(checkpoint));
                }
            }
            Fact::ModelCompleted { step_id, output } => {
                let (purpose, invocation) = &requests[step_id];
                if invocation != &invocations[2] {
                    assert_eq!(purpose, &ModelPurpose::Main);
                    let index = invocations.iter().position(|id| id == invocation).unwrap();
                    assert_eq!(model_text(output), compaction::main_answer(index, 2));
                    assert_eq!(output.finish_reason, ModelFinishReason::Stop);
                }
            }
            Fact::ContextCheckpointRecorded { checkpoint: value } => {
                assert_eq!(stored.event.invocation.invocation_id, invocations[2]);
                assert_eq!(
                    value.mode,
                    CheckpointMode::MidTurn {
                        anchor_event_id: combined_opening.clone().unwrap()
                    }
                );
                assert!(value.covered_through < stored.sequence);
                assert!(checkpoint.replace(stored.event.id.clone()).is_none());
            }
            Fact::ToolDispatched {
                operation_id,
                call,
                input,
                ..
            } => {
                assert_eq!(stored.event.invocation.invocation_id, invocations[2]);
                let index = (0..CASE.calls)
                    .find(|index| call.tool_call_id == call_id(*index))
                    .unwrap();
                assert_eq!(input, &json!({"amount":1,"note":payload(index,CASE.bytes)}));
                assert!(
                    payload_digests
                        .insert(
                            index,
                            maka_agent_facts::artifact::content_digest(
                                input["note"].as_str().unwrap().as_bytes()
                            )
                        )
                        .is_none()
                );
                assert!(
                    tools
                        .insert(
                            maka_agent_facts::tool_call::tool_use_id(&invocations[2], operation_id),
                            index
                        )
                        .is_none()
                );
            }
            Fact::InvocationEnded { outcome } => {
                assert!(matches!(outcome, InvocationOutcome::Completed));
                assert!(completed.insert(stored.event.invocation.invocation_id.clone()));
            }
            Fact::ModelInterrupted { .. } | Fact::ToolRejected { .. } => {
                panic!("unexpected interrupted/rejected work")
            }
            _ => {}
        }
    }
    assert_eq!(openings.len(), 3);
    assert_eq!(completed.len(), 3);
    assert_eq!(requests.len(), 5);
    assert_eq!(
        requests
            .values()
            .filter(|(purpose, _)| *purpose == ModelPurpose::Main)
            .count(),
        4
    );
    assert_eq!(
        requests
            .values()
            .filter(|(purpose, _)| *purpose == ModelPurpose::Summary)
            .count(),
        1
    );
    assert!(checkpoint.is_some());
    assert_eq!(tools.len(), CASE.calls);
    let inputs = json!({"earlier_prompt_digests":prompt_digests[..2],
        "message_digest":prompt_digests[2],
        "ordered_tool_payload_digests":payload_digests.into_values().collect::<Vec<_>>()});
    (tools, inputs)
}

struct Proof {
    session: String,
    through: u64,
    invocations: Vec<String>,
    pictures: Vec<Picture>,
    receipts: Vec<OperationReply>,
    tools: BTreeMap<String, usize>,
    input_digests: Value,
    public: Value,
    stored: Snapshot,
    work: Value,
}

async fn exercise(
    f: &Fixture,
    caller: &Caller<'_>,
    owner: &Owner,
    counter: &Counter,
    listener: TcpListener,
    server: &mut Option<tokio::task::JoinHandle<Value>>,
) -> Proof {
    let mut receipts = Vec::new();
    let roots = caller
        .query("agent", "directories", json!({"kind":"roots"}))
        .await;
    let created = caller
        .mutate(
            "create",
            json!({"title":"K17 original combined payloads","labels":[],
        "workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}}),
            Attachments::new(),
        )
        .await;
    let session = returned(&created)["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    receipts.push(created);
    let mut invocations = Vec::new();
    for index in 0..2 {
        let before = f.through(&session).await;
        let text = compaction::user_prompt(index, 2, 65_536);
        assert_eq!(text.len(), 65_536);
        let sent = caller
            .mutate(
                "send",
                json!({"sessionId":session,"message":text,"model":f.selection().await}),
                Attachments::new(),
            )
            .await;
        assert_eq!(returned(&sent)["kind"], "started");
        let invocation = returned(&sent)["invocationId"].as_str().unwrap().to_owned();
        let (mut socket, _) = listener.accept().await.unwrap();
        let body = request(&mut socket).await;
        retain_body(f._dir.path(), index + 1, &body);
        assert_eq!(body["model"], "fixture-model");
        assert!(has_tool(&body, "Counter"));
        assert!(images::model_images(&body).is_empty());
        assert!(
            body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["role"] == "user" && text_parts(entry) == text)
        );
        let facts = events(&f.store, &session, before).await;
        let requests: Vec<_> = facts
            .iter()
            .filter_map(|stored| match &stored.event.fact {
                Fact::ModelRequested { purpose, .. } => {
                    Some((purpose, &stored.event.invocation.invocation_id))
                }
                _ => None,
            })
            .collect();
        assert_eq!(requests, vec![(&ModelPurpose::Main, &invocation)]);
        response_with_text(&mut socket, &compaction::main_answer(index, 2)).await;
        drop(socket);
        quiescent(owner).await;
        assert_eq!(
            caller
                .query(
                    "agent",
                    "execution",
                    json!({"sessionId":session,"invocationId":invocation})
                )
                .await["execution"]["state"],
            "completed"
        );
        invocations.push(invocation);
        receipts.push(sent);
    }

    let mut pictures = Vec::new();
    for index in 0..2 {
        let mut picture =
            image_upload::generate(&f._dir.path().join(format!("image-{index}.png")), 64, index);
        receipts.push(upload(f, caller, &session, &mut picture).await);
        pictures.push(picture);
    }
    let before = f.through(&session).await;
    let message = large_message();
    assert_eq!(message.len(), 614_400);
    *server = Some(tokio::spawn({
        let store = f.session(&session).await;
        let session = session.clone();
        let pictures = pictures.clone();
        let message = message.clone();
        let directory = f._dir.path().to_owned();
        async move {
            serve_combined(
                listener, store, session, before, message, pictures, directory,
            )
            .await
        }
    }));
    let sent = caller.mutate("send", json!({"sessionId":session,"message":message,
        "attachments":pictures.iter().map(|picture| picture.descriptor["id"].clone()).collect::<Vec<_>>(),
        "model":f.selection().await}), Attachments::new()).await;
    assert_eq!(returned(&sent)["kind"], "started");
    invocations.push(returned(&sent)["invocationId"].as_str().unwrap().to_owned());
    receipts.push(sent);
    let served = server.as_mut().unwrap().await;
    server.take();
    let served = served.unwrap();
    quiescent(owner).await;
    assert_eq!(served["status"], "completed");
    assert_eq!(served["http_requests"], 3);
    assert_eq!(served["main_requests"], 2);
    assert_eq!(served["summary_requests"], 1);
    assert_eq!(served["confirmed_results"], CASE.calls);
    assert_eq!(served["adopted_checkpoints"], 1);
    assert_eq!(counter.entered.available_permits(), CASE.calls);
    assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
    let work = verify_combined_facts(f, &session, &invocations[2], before, &served).await;
    let (tools, input_digests) =
        verify_all_facts(f, &session, &invocations, &message, &pictures).await;
    let through = f.through(&session).await;
    let stored = snapshot(f, &session);
    let public = public_history(
        caller,
        &session,
        through,
        &message,
        &pictures,
        &tools,
        &stored.public_identities,
    )
    .await;
    for picture in &pictures {
        image_upload::artifact(f, &session, picture).await;
    }
    for receipt in &receipts {
        caller.recover(receipt).await;
    }
    assert!(
        f.session(&session)
            .await
            .pending_messages(&session)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        f.session(&session)
            .await
            .pending_interactions(&session)
            .await
            .unwrap()
            .is_empty()
    );
    let observed: contract::Observation = serde_json::from_value(
        caller
            .query("agent", "observe", json!({"sessionId":session}))
            .await,
    )
    .unwrap();
    assert!(matches!(
        observed.session.activity,
        contract::SessionActivity::Idle
    ));
    assert!(observed.compacting.is_none());
    quiescent(owner).await;
    assert_eq!(snapshot(f, &session), stored);
    assert!(stored.tail as u64 <= through);
    Proof {
        session,
        through,
        invocations,
        pictures,
        receipts,
        tools,
        input_digests,
        public,
        stored,
        work,
    }
}

async fn reopened_application(f: &mut Fixture, setup: &Setup, deployment: Uuid) {
    let capture = Arc::new(StdMutex::new(None));
    let policy = setup.policy();
    f.issuer = policy.issuer();
    f.app = Application::start_from_store(
        f.store.clone(),
        deployment,
        providers(setup, capture.clone()),
        f.issuer.clone(),
        Arc::new(Grant(f.issuer.clone(), Some(policy))),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    f.app.ready().await.unwrap();
    f.owner = capture.lock().unwrap().take().unwrap();
}

async fn run(local: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let counter = Counter::new(Behavior::Echo);
    let mut setup = Setup::native(counter.clone(), true);
    setup.echo = true;
    setup.query = true;
    // Setup is reconstructed only to give the existing Fixture its owned input.
    let mut initial = Setup::native(counter.clone(), true);
    initial.echo = true;
    initial.query = true;
    let mut f = Fixture::with_services(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(initial),
    )
    .await;
    let deployment = f.app.source().unwrap().deployment;
    let mut current: Option<LocalOwner> = None;
    let mut provider = None;
    let checked = tokio::time::timeout(Duration::from_secs(600), AssertUnwindSafe(async {
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                context_window:Some(1_000_000), input_limit:Some(900_000), vision:Some(true), ..Default::default()
            })]));
        }).await;
        if local {
            f.app.shutdown().await.unwrap();
            assert!(f.owner.workers.is_empty());
            assert!(f.owner.runs.lock().await.controls.is_empty());
            local_owner(&mut current, &f, &setup, deployment).await;
        }
        let proof = {
            let caller = match &current {
                Some(current) => Caller::Local(current.client.as_ref().unwrap()),
                None => Caller::InProcess(&f),
            };
            let owner = current.as_ref().map_or(f.owner.as_ref(), |current| current.owner.as_ref().unwrap().as_ref());
            exercise(&f, &caller, owner, &counter, listener, &mut provider).await
        };
        if local { close_local(&mut current).await.unwrap(); }
        else { f.app.shutdown().await.unwrap(); }
        let root_owner = f.store.owned_root().unwrap();
        f.store.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        f.store = Arc::new(RootStore::open(root_owner.clone()).await.unwrap());
        f.config = Arc::new(ConfigurationStore::for_root(root_owner).await.unwrap());
        if local { local_owner(&mut current, &f, &setup, deployment).await; }
        else { reopened_application(&mut f, &setup, deployment).await; }
        {
            let caller = match &current {
                Some(current) => Caller::Local(current.client.as_ref().unwrap()),
                None => Caller::InProcess(&f),
            };
            let owner = current.as_ref().map_or(f.owner.as_ref(), |current| current.owner.as_ref().unwrap().as_ref());
            let public = public_history(&caller, &proof.session, proof.through, &large_message(), &proof.pictures, &proof.tools, &proof.stored.public_identities).await;
            assert_eq!(public, proof.public);
            for picture in &proof.pictures { image_upload::artifact(&f, &proof.session, picture).await; }
            for receipt in &proof.receipts { caller.recover(receipt).await; }
            let (tools, inputs) = verify_all_facts(&f, &proof.session, &proof.invocations, &large_message(), &proof.pictures).await;
            assert_eq!(tools, proof.tools);
            assert_eq!(inputs, proof.input_digests);
            quiescent(owner).await;
            assert!(f.session(&proof.session).await.pending_messages(&proof.session).await.unwrap().is_empty());
            assert!(f.session(&proof.session).await.pending_interactions(&proof.session).await.unwrap().is_empty());
            // Read the ACTUAL current tail, not merely the saved fence. Normal
            // model attempts commit ModelRequested before opening provider HTTP.
            // Root/application receipt facts have an independent control frontier.
            let actual_session_fence = f.through(&proof.session).await;
            assert!(actual_session_fence >= proof.through);
            assert_eq!(snapshot(&f, &proof.session), proof.stored, "reopen must preserve all current Session columns/raw bytes and tail");
            assert_eq!(counter.entered.available_permits(), CASE.calls);
            assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
            assert!(owner.workers.is_empty());
            assert!(owner.runs.lock().await.controls.is_empty());
            json!({"boundary":if local {"local_ipc"} else {"in_process"},
                "earlier_rounds":2,"earlier_prompt_bytes":65536,"message_bytes":614400,
                "images":proof.pictures.iter().map(|p|json!({"bytes":p.bytes,"digest":p.digest})).collect::<Vec<_>>(),
                "http_requests":5,"main_requests":4,"summary_requests":1,"completed_invocations":3,
                "input_digests":proof.input_digests,
                "tool_work":proof.work,"saved_fence":proof.through,"actual_session_fence":actual_session_fence,
                "session_tail":proof.stored.tail,"public_rows":proof.public["rows"].as_array().unwrap().len(),
                "reopened_current_session_equal":true,"errors":0})
        }
    }).catch_unwind()).await;

    // Every failure follows the original owners' cleanup before its panic is
    // resumed. Aborting a responder is a retained failed case, never success.
    let unfinished_provider = provider.is_some();
    if let Some(provider) = provider {
        provider.abort();
        let _ = provider.await;
    }
    let local_cleanup = close_local(&mut current).await;
    let app_cleanup = f.app.shutdown().await;
    let store_cleanup = f.store.shutdown().await;
    let config_cleanup = f.config.shutdown().await;
    let success = matches!(&checked, Ok(Ok(_)))
        && !unfinished_provider
        && local_cleanup.is_ok()
        && app_cleanup.is_ok()
        && store_cleanup.is_ok()
        && config_cleanup.is_ok();
    drop(current);
    let Fixture {
        services,
        _dir,
        namespaces,
        root,
        workspace,
        store,
        config,
        app,
        issuer,
        owner,
    } = f;
    drop((services, workspace, store, config, app, issuer, owner));
    if !success {
        eprintln!(
            "K17 combined retained failed Root: {}",
            _dir.keep().display()
        );
    } else {
        // Keep the TempDir alive until the original lease has been reacquired.
        match RootOwner::open(&root, &namespaces) {
            Ok(owner) => {
                drop(owner);
                drop(_dir);
            }
            Err(error) => {
                let retained = _dir.keep();
                panic!(
                    "original Root lease reacquisition failed: {error:?}; retained {}",
                    retained.display()
                );
            }
        }
    }
    local_cleanup.unwrap();
    app_cleanup.unwrap();
    store_cleanup.unwrap();
    config_cleanup.unwrap();
    assert!(!unfinished_provider, "provider did not join successfully");
    match checked {
        Ok(Ok(mut result)) => {
            result["root_reacquired"] = json!(true);
            println!("MAKA_K17_COMBINED {result}");
        }
        Ok(Err(panic)) => std::panic::resume_unwind(panic),
        Err(error) => panic!("combined integration deadline: {error}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "finite original payload/automatic-summary integration, one boundary per process"]
async fn original_payloads_survive_automatic_summary_and_reopen() {
    run(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "finite original payload/local-IPC/automatic-summary integration, one boundary per process"]
async fn original_payloads_survive_local_ipc_summary_and_reopen() {
    run(true).await;
}

async fn serve_combined(
    listener: TcpListener,
    store: maka_event_log::root_store::SessionStore,
    session: String,
    initial_after: u64,
    message: String,
    pictures: Vec<Picture>,
    directory: std::path::PathBuf,
) -> Value {
    let case = CASE;
    let progress = Arc::new(StdMutex::new(
        json!({"http_requests":0,"normalized_request_json_bytes":0,
        "response_wire_bytes":0,"confirmed_results":0}),
    ));
    let mut after = initial_after;
    let mut invocation = None;
    let mut mains = 0;
    let mut issued = 0;
    let mut request_bytes = 0;
    let mut response_bytes = 0;
    let mut archives = BTreeMap::new();
    let mut budgets = Vec::new();
    let mut latencies = Vec::new();
    let mut emitted_at = None;
    let mut confirmed = BTreeSet::new();
    let mut summaries: Vec<SummaryProof> = Vec::new();
    let mut opening = None;
    let mut ordinal = 3;
    let expected_provider_text = provider_text(&message, &pictures);
    loop {
        let (mut socket, _) = listener.accept().await.unwrap();
        let body = request(&mut socket).await; // Original auth/EOF/content-length checks.
        retain_body(&directory, ordinal, &body);
        ordinal += 1;
        assert_eq!(body["model"], "fixture-model");
        request_bytes += serde_json::to_vec(&body).unwrap().len();
        {
            let mut progress = progress.lock().unwrap();
            progress["http_requests"] = json!(progress["http_requests"].as_u64().unwrap() + 1);
            progress["normalized_request_json_bytes"] = json!(request_bytes);
        }
        let through = *store.subscribe_commits().unwrap().borrow();
        let mut requested = None;
        loop {
            let page = store
                .session_events(&session, after, through, 512, usize::MAX)
                .await
                .unwrap();
            for stored in page.events {
                if let Some(invocation) = &invocation {
                    assert_eq!(&stored.event.invocation.invocation_id, invocation);
                }
                match stored.event.fact {
                    Fact::InvocationOpened {
                        input,
                        configuration,
                    } => {
                        assert_eq!(
                            configuration.as_ref().unwrap().language,
                            maka_agent_facts::language::Language::En,
                            "the expected provider attachment labels require frozen English"
                        );
                        assert!(
                            invocation
                                .replace(stored.event.invocation.invocation_id)
                                .is_none()
                        );
                        let InvocationInput::Message { content, .. } = input else {
                            panic!("message invocation")
                        };
                        assert_eq!(content.text, message);
                        let attachments = content.attachments.as_ref().unwrap();
                        assert_eq!(attachments.len(), pictures.len());
                        for (attachment, picture) in attachments.iter().zip(&pictures) {
                            assert_eq!(attachment.name, picture.name);
                            assert_eq!(attachment.bytes, picture.bytes as u64);
                            assert_eq!(attachment.mime_type, "image/png");
                            assert_eq!(
                                attachment.storage_ref,
                                StorageRef::SessionFile {
                                    session_id: session.clone(),
                                    relative_path: picture.descriptor["id"]
                                        .as_str()
                                        .unwrap()
                                        .into(),
                                }
                            );
                        }
                        assert!(opening.replace(stored.event.id).is_none());
                    }
                    Fact::ModelRequested {
                        purpose,
                        step_id,
                        source_high_water,
                        checkpoint_event_id,
                        context,
                        context_breakdown,
                        ..
                    } => {
                        assert!(
                            requested
                                .replace(RequestProof {
                                    step_id: step_id.clone(),
                                    purpose,
                                    source_through: source_high_water,
                                    checkpoint_id: checkpoint_event_id.clone(),
                                })
                                .is_none(),
                            "serial HTTP must have one fresh canonical request"
                        );
                        budgets.push(json!({"purpose":purpose,"step_id":step_id,"source_through":source_high_water,
                            "checkpoint_event_id":checkpoint_event_id,"context":context,"context_breakdown":context_breakdown,
                            "http_max_tokens":body.get("max_tokens"),"http_max_completion_tokens":body.get("max_completion_tokens")}));
                    }
                    Fact::ModelCompleted { step_id, output } => {
                        if let Some(summary) = summaries
                            .iter_mut()
                            .find(|summary| summary.step_id == step_id)
                        {
                            assert!(!summary.completion_seen);
                            summary_output(&output, &summary.text);
                            summary.completion_seen = true;
                        }
                    }
                    Fact::ContextCheckpointRecorded { checkpoint } => {
                        let summary = summaries
                            .last_mut()
                            .expect("checkpoint follows a served Summary");
                        assert!(summary.completion_seen);
                        assert!(summary.checkpoint_id.is_none());
                        assert_eq!(checkpoint.summary_step_id, summary.step_id);
                        assert_eq!(checkpoint.summary.text, summary.text);
                        assert_eq!(checkpoint.covered_through, summary.source_through);
                        assert!(checkpoint.covered_through < stored.sequence);
                        assert_eq!(
                            checkpoint.previous_checkpoint_id,
                            summary.previous_checkpoint_id
                        );
                        assert_eq!(
                            checkpoint.mode,
                            maka_agent_facts::context::CheckpointMode::MidTurn {
                                anchor_event_id: opening.as_ref().unwrap().clone(),
                            }
                        );
                        summary.checkpoint_id = Some(stored.event.id);
                    }
                    Fact::ToolResultArchived { placeholder } => {
                        let DurableToolProjection::Json { mut value } =
                            placeholder.to_canonical_projection().unwrap()
                        else {
                            panic!("archive projection")
                        };
                        value["readInstructions"] = "Use page.next only with a selected Session tool-result reader; without one, the remainder is unavailable.".into();
                        archives
                            .insert(placeholder.identity.tool_call_id, (stored.sequence, value));
                    }
                    _ => {}
                }
            }
            if let Some(next) = page.next_after {
                assert!(next > after);
                after = next;
            } else {
                after = through;
                break;
            }
        }
        let requested = requested.expect("HTTP request has original canonical role");
        {
            let mut progress = progress.lock().unwrap();
            progress["last_canonical_purpose"] = json!(requested.purpose);
            progress["last_step_id"] = json!(requested.step_id);
            progress["source_through"] = json!(requested.source_through);
        }
        let messages = body["messages"].as_array().unwrap();
        if requested.purpose == ModelPurpose::Main {
            check_images(&body, &pictures, &directory);
            let anchored: Vec<_> = messages
                .iter()
                .filter(|entry| {
                    entry["content"]
                        .as_array()
                        .is_some_and(|parts| parts.iter().any(|part| part["type"] == "image_url"))
                })
                .collect();
            assert_eq!(anchored.len(), 1, "one image-bearing user anchor");
            assert_eq!(anchored[0]["role"], "user");
            assert_eq!(text_parts(anchored[0]), expected_provider_text);
        }
        assert!(has_tool(&body, "Counter"));
        let before_confirmed = confirmed.len();
        for message in messages {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = (0..issued)
                        .find(|index| call["id"] == call_id(*index))
                        .expect("only already issued tool calls can reach the provider");
                    assert_eq!(call["function"]["name"], "Counter");
                    let input: Value =
                        serde_json::from_str(call["function"]["arguments"].as_str().unwrap())
                            .unwrap();
                    assert_eq!(input, json!({"amount":1,"note":payload(index,case.bytes)}));
                }
            }
            if message["role"] != "tool" {
                continue;
            }
            let index = (0..issued)
                .find(|index| message["tool_call_id"] == call_id(*index))
                .expect("only already issued results can reach the provider");
            let actual: Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
            let expected = archives
                .get(&call_id(index))
                .filter(|(sequence, _)| *sequence <= requested.source_through)
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| case.business(index));
            assert_eq!(
                actual,
                expected,
                "actual model projection for {}",
                call_id(index)
            );
            assert!(actual.get("receipt").is_none() && actual.get("stateDomain").is_none());
            confirmed.insert(index); // Previously confirmed results may remain in the next prompt.
        }
        assert_eq!(
            confirmed.len(),
            issued,
            "every issued result reached Main or Summary"
        );
        if confirmed.len() > before_confirmed {
            let at = emitted_at.take().expect("one outstanding issued batch");
            latencies.push(Instant::now().duration_since(at).as_secs_f64() * 1000.0);
        }
        {
            let mut progress = progress.lock().unwrap();
            progress["confirmed_results"] = json!(confirmed.len());
            progress["issued_calls"] = json!(issued);
        }
        if let Some(summary) = summaries.last() {
            assert!(summary.completion_seen);
            assert!(summary.checkpoint_id.is_some());
            assert_eq!(requested.checkpoint_id, summary.checkpoint_id);
            assert!(messages.iter().any(|message| {
                message["role"] == "user"
                    && message["content"]
                        .as_str()
                        .is_some_and(|text| text.ends_with(&format!("\n\n{}", summary.text)))
            }));
            // Both Main and later Summary inherit covered work only through the checkpoint.
            for message in messages {
                if message["role"] == "tool" {
                    assert!(
                        !(0..summary.confirmed)
                            .any(|index| message["tool_call_id"] == call_id(index))
                    );
                }
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    assert!(calls.iter().all(|call| {
                        !(0..summary.confirmed).any(|index| call["id"] == call_id(index))
                    }));
                }
            }
        } else {
            assert!(requested.checkpoint_id.is_none());
        }
        if requested.purpose == ModelPurpose::Summary {
            assert!(
                confirmed.len() > before_confirmed,
                "Summary must verify newly issued work"
            );
            assert!(summaries.is_empty(), "one fixed automatic summary");
            let text = format!(
                "K43_SUMMARY_{}: {issued} original service results confirmed.",
                summaries.len() + 1
            );
            // Summary is real text-only SSE, with no invented provider usage.
            response_bytes += reply(&mut socket, case, 0..0, Some(&text), &progress).await;
            summaries.push(SummaryProof {
                step_id: requested.step_id,
                source_through: requested.source_through,
                previous_checkpoint_id: requested.checkpoint_id,
                text,
                confirmed: confirmed.len(),
                checkpoint_id: None,
                completion_seen: false,
                adopted: false,
            });
            progress.lock().unwrap()["summary_requests"] = json!(summaries.len());
            continue;
        }
        assert_eq!(requested.purpose, ModelPurpose::Main);
        if let Some(summary) = summaries.last_mut() {
            summary.adopted = true;
            progress.lock().unwrap()["adopted_checkpoints"] =
                json!(summaries.iter().filter(|summary| summary.adopted).count());
        }
        mains += 1;
        let finished = issued == case.calls;
        let indices = if finished {
            0..0
        } else {
            assert_eq!(issued, 0, "query emits its original batch only once");
            0..case.calls
        };
        issued = indices.end.max(issued);
        {
            let mut progress = progress.lock().unwrap();
            progress["issued_calls"] = json!(issued);
            progress["main_requests"] = json!(mains);
        }
        if !finished {
            emitted_at = Some(Instant::now());
        }
        response_bytes += reply(
            &mut socket,
            case,
            indices,
            finished.then_some(FINAL),
            &progress,
        )
        .await;
        if finished {
            assert!(
                summaries
                    .iter()
                    .all(|summary| summary.completion_seen && summary.adopted)
            );
            return json!({"status":"completed","main_requests":mains,"summary_requests":summaries.len(),
                "http_requests":mains+summaries.len(),"normalized_request_json_bytes":request_bytes,"response_wire_bytes":response_bytes,
                "confirmed_results":confirmed.len(),"step_confirmation_ms":latencies,"requests":budgets,
                "archived_projections":archives.len(),"summaries":summaries,
                "adopted_checkpoints":summaries.len()});
        }
    }
}

async fn verify_combined_facts(
    fixture: &Fixture,
    session: &str,
    invocation: &str,
    initial_after: u64,
    served: &Value,
) -> Value {
    let through = fixture.through(session).await;
    let case = CASE;
    let mut after = initial_after;
    let mut dispatched = BTreeMap::new();
    let mut settled = BTreeSet::new();
    let mut raw_bytes = 0;
    let mut projected_bytes = 0;
    let mut final_completions = 0;
    let mut completed = 0;
    let mut maintenance = 0;
    let mut purposes = BTreeMap::new();
    let mut summary_completions = 0;
    let mut main_completions = 0;
    let mut checkpoints = 0;
    loop {
        let page = fixture
            .session(session)
            .await
            .session_events(session, after, through, 512, usize::MAX)
            .await
            .unwrap();
        for stored in page.events {
            assert_eq!(stored.event.invocation.invocation_id, invocation);
            match &stored.event.fact {
                Fact::ToolDispatched {
                    operation_id,
                    call,
                    name,
                    input,
                    ..
                } => {
                    assert_eq!(name, "Counter");
                    let index = (0..case.calls)
                        .find(|index| call.tool_call_id == call_id(*index))
                        .expect("unique real call id");
                    assert_eq!(input, &json!({"amount":1,"note":payload(index,case.bytes)}));
                    assert!(dispatched.insert(operation_id.clone(), index).is_none());
                }
                Fact::ToolSettled {
                    operation_id,
                    outcome,
                } => {
                    let index = dispatched[operation_id];
                    assert!(settled.insert(index));
                    let ToolOutcome::Succeeded { .. } = outcome else {
                        panic!("unexpected tool settlement: {outcome:?}")
                    };
                    assert_eq!(
                        outcome_projection(outcome).as_ref(),
                        &DurableToolProjection::Json {
                            value: case.business(index)
                        }
                    );
                    projected_bytes += serde_json::to_vec(&case.business(index)).unwrap().len();
                    let raw = fixture
                        .session(session)
                        .await
                        .resolve_tool_result(session, &stored.event.id)
                        .await
                        .unwrap();
                    raw_bytes += serde_json::to_vec(&raw).unwrap().len();
                    match raw {
                        ToolOutput::Json(value) => {
                            assert_eq!(value, case.business(index))
                        }
                        other => panic!("wrong original service result: {other:?}"),
                    }
                }
                Fact::ModelRequested {
                    purpose, step_id, ..
                } => {
                    assert!(purposes.insert(step_id.clone(), *purpose).is_none());
                }
                Fact::ModelCompleted { step_id, output } => match purposes[step_id] {
                    ModelPurpose::Main => {
                        main_completions += 1;
                        let text = model_text(output);
                        if !text.is_empty() {
                            assert_eq!(text, FINAL);
                            assert_eq!(output.finish_reason, ModelFinishReason::Stop);
                            final_completions += 1;
                        }
                    }
                    ModelPurpose::Summary => {
                        let proof = served["summaries"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|proof| proof["step_id"] == *step_id)
                            .unwrap();
                        summary_output(output, proof["text"].as_str().unwrap());
                        summary_completions += 1;
                    }
                },
                Fact::ToolResultArchived { .. } => maintenance += 1,
                Fact::ContextCheckpointRecorded { checkpoint } => {
                    let proof = served["summaries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|proof| proof["step_id"] == checkpoint.summary_step_id)
                        .unwrap();
                    assert_eq!(proof["checkpoint_id"], stored.event.id);
                    assert_eq!(proof["source_through"], checkpoint.covered_through);
                    assert_eq!(proof["text"], checkpoint.summary.text);
                    assert_eq!(proof["adopted"], true);
                    checkpoints += 1;
                    maintenance += 1;
                }
                Fact::InvocationEnded { outcome } => {
                    assert!(matches!(outcome, InvocationOutcome::Completed));
                    completed += 1;
                }
                _ => {}
            }
        }
        if let Some(next) = page.next_after {
            assert!(next > after);
            after = next;
        } else {
            break;
        }
    }
    assert_eq!(dispatched.len(), case.calls);
    assert_eq!(settled.len(), case.calls);
    assert_eq!(completed, 1);
    assert_eq!(final_completions, 1);
    let main_requests = purposes
        .values()
        .filter(|purpose| **purpose == ModelPurpose::Main)
        .count();
    let summary_requests = purposes.len() - main_requests;
    assert_eq!(main_requests, 2);
    assert_eq!(main_completions, main_requests);
    assert_eq!(summary_completions, summary_requests);
    assert_eq!(checkpoints, summary_requests);
    assert_eq!(
        summary_requests,
        served["summary_requests"].as_u64().unwrap() as usize
    );
    assert_eq!(
        summary_requests,
        served["adopted_checkpoints"].as_u64().unwrap() as usize
    );
    assert_eq!(summary_requests, 1);
    assert_eq!(served["http_requests"], 3);
    json!({"tool_dispatches":dispatched.len(),"tool_settlements":settled.len(),
        "raw_result_json_bytes":raw_bytes,"business_result_json_bytes":projected_bytes,
        "original_payload_bytes":case.calls*case.bytes,"maintenance_facts":maintenance,
        "main_requests":main_requests,"summary_requests":summary_requests,"checkpoints":checkpoints})
}
