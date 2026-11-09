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
use maka_agent_facts::durable::{AcceptedResult, ContentRef, Fact, UnixMillis};
use maka_agent_facts::import::Content;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;
use maka_event_log::sessions::PluginSession;
use maka_plugin_core::scope::Scope as StorageScope;
use maka_plugin_core::storage::Namespace;
use sha2::{Digest, Sha256};

// Only writes fixture source bytes. All decoding and closure checks use State.
struct ImportTape(std::fs::File);
impl ImportTape {
    fn payload(&mut self, value: &impl serde::Serialize) -> ContentRef {
        use std::io::Write;
        let bytes = serde_json::to_vec(value).unwrap();
        let digest = Sha256::digest(&bytes);
        self.0.write_all(&[0]).unwrap();
        self.0.write_all(&digest).unwrap();
        self.0
            .write_all(&(bytes.len() as u64).to_be_bytes())
            .unwrap();
        self.0.write_all(&bytes).unwrap();
        ContentRef {
            digest: format!("sha256:{}", hex::encode(digest)),
            bytes: bytes.len() as u64,
        }
    }
    fn entry(&mut self, entry: &maka_agent_facts::history_snapshot::Entry) {
        use std::io::Write;
        let bytes = serde_json::to_vec(entry).unwrap();
        self.0.write_all(&[1]).unwrap();
        self.0
            .write_all(&(bytes.len() as u64).to_be_bytes())
            .unwrap();
        self.0.write_all(&bytes).unwrap();
    }
}
async fn import_records(
    f: &Fixture,
    seed: &str,
    plugin: PluginSession,
    source: Source,
    records: Vec<Record>,
) {
    use maka_agent_facts::{
        history_snapshot::*,
        model::{ModelPart, ModelToolCall, TextKind, ToolInput},
    };
    use maka_agent_state::session_history::snapshot::{IMPORT_TAPE_MAGIC, ImportedCaptureRequest};
    let stored = f
        .store
        .get_session::<StoredSessionConfiguration>(seed)
        .await
        .unwrap()
        .unwrap()
        .configuration;
    let configuration = f.owner.session(seed).await.unwrap().configuration;
    let target = plugin.session_id.clone();
    let owner = f.owner.run_owner();
    let tape_owner = owner.clone();
    let tape_target = target.clone();
    let tape_source = source.clone();
    let (file, fingerprint) = f
        .session(seed)
        .await
        .with_resource_io(move || {
            use std::io::{Seek, Write};
            let mut tape = ImportTape(maka_event_log::root_store::create_request_file()?);
            tape.0.write_all(IMPORT_TAPE_MAGIC)?;
            let mut originals = Vec::new();
            let mut turns = BTreeMap::new();
            for (ordinal, record) in records.iter().enumerate() {
                record.validate().unwrap();
                let original = tape.payload(record);
                originals.push(original.clone());
                let mut parts = Vec::new();
                let role = match &record.content {
                    Content::User { text } => {
                        parts.push(ImportedPart::Input {
                            content: text.clone().into(),
                        });
                        HistoricalRole::User
                    }
                    Content::Assistant { text, thinking, .. } => {
                        if let Some(thinking) = thinking {
                            parts.push(ImportedPart::Model {
                                part: ModelPart::Text {
                                    text_kind: TextKind::Thinking,
                                    text: thinking.clone().into(),
                                    provider_options: None,
                                },
                            });
                        }
                        parts.push(ImportedPart::Model {
                            part: ModelPart::Text {
                                text_kind: TextKind::Text,
                                text: text.clone().into(),
                                provider_options: None,
                            },
                        });
                        HistoricalRole::Assistant
                    }
                    Content::ToolCall {
                        call_id,
                        name,
                        input,
                    } => {
                        parts.push(ImportedPart::Model {
                            part: ModelPart::ToolCall {
                                call: ModelToolCall {
                                    id: call_id.clone(),
                                    name: name.clone(),
                                    input: ToolInput::Json(
                                        input
                                            .clone()
                                            .expect("original Recall source tool arguments"),
                                    ),
                                    provider_options: None,
                                    provider_executed: false,
                                },
                            },
                        });
                        HistoricalRole::Assistant
                    }
                    other => panic!("not part of the original Recall fixture: {other:?}"),
                };
                let parts = parts.iter().map(|part| tape.payload(part)).collect();
                let next = turns.len() as u64;
                let turn = *turns.entry(record.source_turn_id.clone()).or_insert(next);
                let message = tape.payload(&ImportedMessage {
                    turn_ordinal: ImportedTurnOrdinal(turn),
                    original_ordinal: ordinal as u64,
                    media: vec![],
                    source_message_id: Some(record.source_message_id.clone()),
                    source_turn_id: Some(record.source_turn_id.clone()),
                    timestamp: record.timestamp,
                    role,
                    artifact_scope: ImportedArtifactScope {
                        owner: tape_owner.clone(),
                        session: tape_target.clone(),
                    },
                    parts,
                    provider_metadata: None,
                    original,
                });
                tape.entry(&Entry::Imported {
                    ordinal: ordinal as u64,
                    message,
                });
            }
            let mut previous = None;
            for page in originals.chunks(PAGE_ENTRIES) {
                previous = Some(tape.payload(&OriginalRecordsPage {
                    previous,
                    records: page.to_vec(),
                }));
            }
            let fingerprint = tape.payload(&OriginalSource {
                version: 1,
                fingerprint: serde_json::to_string(&tape_source).unwrap(),
                records: previous,
            });
            tape.0.flush()?;
            tape.0.sync_all()?;
            tape.0.rewind()?;
            Ok((tape.0, fingerprint))
        })
        .await
        .unwrap();
    let scope = scope(&f.issuer, true);
    let history = f
        .owner
        .durable
        .session_history(owner.clone(), target.clone());
    let snapshot_id = SnapshotId::new();
    let snapshot = history
        .capture_imported(
            ImportedCaptureRequest {
                id: snapshot_id,
                source: source.clone(),
                fingerprint: fingerprint.clone(),
            },
            file,
            scope.cancellation.child_token(),
        )
        .await
        .unwrap();
    // Trusted Root metadata composition, not a pretend call to Native SessionImport.
    use maka_event_log::applications::operations::{Dispatch, OperationRequest};
    use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
    let request = OperationRequest {
        source: f.app.source().unwrap().clone(),
        namespace: owner.namespace.clone(),
        consumer: id(2),
        export: "RecallFixture".into(),
        method: "import".into(),
        contract: Contract {
            name: "recall.fixture.metadata".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "import".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: json!({}).into(),
                        output: json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        },
        operation: Uuid::new_v4(),
        input: json!({"sessionId":target,"source":source,"fingerprint":fingerprint,"configuration":stored}),
        capture: None,
        origin: json!({"kind":"recall_fixture_metadata_import"}),
    };
    let reference = request.reference().unwrap();
    let operation = f.store.operation(&reference).unwrap();
    let Dispatch::New(claim) = operation.dispatch_operation(request).await.unwrap() else {
        panic!("original fixture metadata claim")
    };
    operation.start_operation(&claim).unwrap();
    let (spec, contents) = f
        .owner
        .history_source_spec(&target, &configuration, &snapshot, &reference, &scope)
        .await
        .unwrap();
    let adoption = snapshot
        .adopt(&history, reference.operation, spec, UnixMillis(1), contents)
        .unwrap();
    let (_, change) = f
        .store
        .prepare_plugin_session(
            &plugin,
            &stored,
            1,
            &f.store.data_writer().unwrap(),
            adoption,
        )
        .await
        .unwrap();
    change
        .commit(
            &claim,
            OperationResult::Success {
                value: json!({"sessionId":target}),
            },
        )
        .await
        .unwrap();
    operation
        .record_operation_cleanup(
            &claim,
            maka_plugin_core::operation::OperationCleanup::Confirmed,
        )
        .await
        .unwrap();
    scope.resources.finish().await.unwrap();
}

struct MaterialCopy {
    owner: maka_agent_facts::durable::RunOwner,
    target: String,
    operation: String,
    source: String,
    artifact: String,
}
impl maka_event_log::connection::Query for MaterialCopy {
    type Output = String;
    fn execute(self, c: &rusqlite::Connection) -> Result<String, maka_event_log::StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        let mut query=c.prepare("SELECT r.artifact FROM agent_session_artifact_registrations r JOIN contents b ON b.id=r.body_content_id
            WHERE r.owner=?1 AND r.session=?2 AND json_extract(CAST(b.payload AS TEXT),'$.owner')=json(?1)
              AND json_extract(CAST(b.payload AS TEXT),'$.operation')=?3
              AND json_extract(CAST(b.payload AS TEXT),'$.origin.kind')='copy'
              AND json_extract(CAST(b.payload AS TEXT),'$.origin.source.kind')='session'
              AND json_extract(CAST(b.payload AS TEXT),'$.origin.source.scope.owner')=json(?1)
              AND json_extract(CAST(b.payload AS TEXT),'$.origin.source.scope.session')=?4
              AND json_extract(CAST(b.payload AS TEXT),'$.origin.source.id')=?5")?;
        let records = query
            .query_map(
                rusqlite::params![
                    owner,
                    self.target,
                    self.operation,
                    self.source,
                    self.artifact
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let [artifact]: [String; 1] = records.try_into().map_err(|records: Vec<String>| {
            maka_event_log::StoreError::InvalidTransition(format!(
                "original accepted RecallMaterial must have exactly one owned copy, found {}",
                records.len()
            ))
        })?;
        Ok(artifact)
    }
}

async fn imported(f: &Fixture, title: &str, prefix: &str, answer: &str) -> String {
    let seed = f.create(title).await;
    let session = format!("{prefix}{}", Uuid::new_v4().simple());
    let plugin = PluginSession {
        session_id: session.clone(),
        creator: Namespace::new("recall.fixture", StorageScope::Profile).unwrap(),
        fingerprint: session.clone(),
        managed: false,
        authority_session_id: None,
    };

    import_records(
        f,
        &seed,
        plugin,
        Source {
            adapter: "fixture".into(),
            session_id: "original".into(),
        },
        vec![
            Record {
                source_message_id: "question".into(),
                source_turn_id: "one".into(),
                timestamp: Some(1000),
                content: Content::User {
                    text: "Earlier cafe\u{301} 中😀 question".into(),
                },
            },
            Record {
                source_message_id: "answer".into(),
                source_turn_id: "one".into(),
                timestamp: Some(2000),
                content: Content::Assistant {
                    text: answer.into(),
                    thinking: None,
                    model: None,
                },
            },
            Record {
                source_message_id: "next".into(),
                source_turn_id: "two".into(),
                timestamp: Some(3000),
                content: Content::User {
                    text: "A later exchange".into(),
                },
            },
        ],
    )
    .await;
    session
}
#[tokio::test]
async fn recall_native_queries_keep_unicode_dates_titles_namespace_and_exact_history_anchor() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = imported(&f, "A café conversation", &f.owner.prefix, "The original café answer").await;
        let foreign = imported(&f, "Foreign conversation", "other_", "The original café answer").await;
        let found = f.recall(json!({"terms":["CAFÉ"],"since":1000,"until":2000})).await.unwrap();
        assert_eq!(found["complete"], true, "{found}");
        assert_eq!(found["titles"], json!([]));
        let passages = found["passages"].as_array().unwrap();
        assert_eq!(passages.len(), 1, "{found}");
        let hit = &passages[0];
        assert_eq!(hit["session"]["id"], session);
        let through = f.query("observe", json!({"sessionId":session})).await.unwrap()["through"].clone();
        let page = f.query("history", json!({"sessionId":session,"through":through,"position":{"kind":"row","position":hit["anchorPosition"],"field":"body"}})).await.unwrap();
        assert_eq!(page["chunks"][0]["messageId"], hit["anchorMessageId"]);
        let original = page["chunks"][0]["text"].as_str().unwrap();
        assert!(original.contains("café") || original.contains("cafe\u{301}"));
        let title = f.recall(json!({"terms":["conversation"],"session_id":session})).await.unwrap();
        assert_eq!(title["titles"][0]["id"], session);
        assert_eq!(f.recall(json!({"terms":["café"],"since":4000})).await.unwrap()["passages"], json!([]));
        assert!(f.recall(json!({"terms":["café"],"session_id":foreign})).await.is_err());
        assert!(f.app.client().subscribe(f.binding(2).await, "recall".into(), json!({"terms":["café"]}), scope(&f.issuer,false), Attachments::new().into()).await.is_err());
        assert!(f.recall(json!({"terms":[],"since":2000,"until":1000})).await.is_err());
        let long = format!("needle cafe\u{301} {}\n😀终点", "字".repeat(6000));
        let mut long_session = String::new();
        for index in 0..17 {
            let answer = if index == 16 { long.as_str() } else { "needle short answer" };
            let id = imported(&f, &format!("needle title {index}"), &f.owner.prefix, answer).await;
            if index == 16 { long_session = id; }
        }
        let found = f.recall(json!({"terms":["needle"]})).await.unwrap();
        assert_eq!(found["complete"], true, "{found}");
        assert_eq!(found["titles"].as_array().unwrap().len(), 34, "both seed and imported titles remain searchable across catalog pages");
        let passages = found["passages"].as_array().unwrap();
        assert_eq!(passages.len(), 17, "title matches must not consume an implicit passage budget");
        let hit = passages.iter().find(|hit| hit["session"]["id"] == long_session).unwrap();
        let preview = hit["excerpt"].as_str().unwrap();
        assert!(preview.contains("needle"));
        assert!(preview.chars().count() < long.chars().count(), "search returns a preview while history retains the complete source");
        let through = f.query("observe", json!({"sessionId":long_session})).await.unwrap()["through"].clone();
        let page = f.query("history", json!({"sessionId":long_session,"through":through,"position":{"kind":"row","position":hit["anchorPosition"],"field":"body"}})).await.unwrap();
        assert_eq!(page["chunks"][0]["messageId"], hit["anchorMessageId"]);
        assert_eq!(page["chunks"][0]["totalBytes"], long.len());
        let ending = f.recall(json!({"terms":["终点"],"session_id":long_session})).await.unwrap();
        let endings = ending["passages"].as_array().unwrap();
        assert_eq!(endings.len(), 1);
        let ending = &endings[0];
        assert_eq!(ending["session"]["id"], long_session);
        let preview = ending["excerpt"].as_str().unwrap();
        assert!(preview.contains("😀终点"));
        let highlights = ending["highlights"].as_array().unwrap();
        assert_eq!(highlights.len(), 1);
        let start = usize::try_from(highlights[0]["start"].as_u64().unwrap()).unwrap();
        let end = usize::try_from(highlights[0]["end"].as_u64().unwrap()).unwrap();
        let utf16: Vec<_> = preview.encode_utf16().collect();
        assert_eq!(String::from_utf16(&utf16[start..end]).unwrap(), "终点");
        let limited = f.recall(json!({"terms":["needle"],"since":0,"limit":3})).await.unwrap();
        assert_eq!(limited["titles"], json!([]));
        assert_eq!(limited["passages"].as_array().unwrap().len(), 3);
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}
pub(super) async fn tool(socket: &mut TcpStream, name: &str, input: Value) {
    let delta = json!({"id":"recall-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("call-{}",Uuid::new_v4()),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]});
    let end = json!({"id":"recall-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
    let body = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
#[tokio::test]
async fn recall_native_model_tools_expand_exclude_active_turn_and_retain_material_copy_after_source_retirement()
 {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,None,|settings| settings.recall=true).await;
        images::enable_vision(&f).await;
        let complete_answer = format!("The original café answer\n{}\n完整末尾 中😀", "字".repeat(6000));
        let source = imported(&f, "Earlier conversation", &f.owner.prefix, &complete_answer).await;
        let found = f.recall(json!({"terms":["café"],"session_id":source})).await.unwrap();
        let anchor = found["passages"][0]["anchorMessageId"].clone();
        let bytes = "historical attachment contents\nsecond line\ncafe\u{301} 中😀".as_bytes();
        let uploaded = attachments::upload(&f,&source,"notes.txt",bytes,Uuid::new_v4()).await.unwrap();
        let artifact = uploaded["attachment"]["id"].as_str().unwrap().to_owned();
        use base64::Engine as _;
        let image_bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==").unwrap();
        let image = attachments::upload(&f,&source,"image.png",&image_bytes,Uuid::new_v4()).await.unwrap()["attachment"]["id"].as_str().unwrap().to_owned();
        let target = f.create("Current conversation").await;
        let started = f.mutation(2,"send",json!({"sessionId":target,"message":"café current turn must be excluded","backend":model_backend(&f.selection().await)}),Uuid::new_v4()).await.unwrap();
        assert_eq!(started["kind"],"queued");
        let original_run=f.delivered_run(&started).await;
        for (name,input,previous,complete_context) in [
            ("Recall",json!({"terms":["café","second","third","fourth","fifth","sixth","seventh","eighth","ninth"],"limit":26}), None, false),
            ("RecallMore",json!({"session_id":source,"anchor_message_id":anchor,"before":9,"after":9}), Some("original café answer"), true),
            ("RecallMaterial",json!({"session_id":source,"artifact_id":artifact}), Some("A later exchange"), true),
            ("RecallMaterial",json!({"session_id":source,"artifact_id":image}), Some("historical attachment contents"), false),
        ] {
            let (mut socket,_) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            assert!(sent["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == name));
            if let Some(expected) = previous {
                let result = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap()["content"].as_str().unwrap();
                assert!(result.contains(expected),"{result}");
                if complete_context {
                    assert!(result.contains(&complete_answer), "Recall and RecallMore must preserve the entire source message, including its Unicode tail");
                }
                assert!(!result.contains("current turn must be excluded"));
            }
            tool(&mut socket,name,input).await;
        }
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("data:image/png;base64,"),"{sent}");
        response(&mut socket).await;
        f.drained().await;
        let facts = service_tools::facts(&f,&target).await;
        let view=f.owner.durable.frontier(original_run).await.unwrap();
        let keys:Vec<_>=view.tools.values().filter(|tool|matches!(tool.call.name.as_str(),"Recall"|"RecallMore"|"RecallMaterial")).map(|tool|tool.key.clone()).collect();
        assert_eq!(keys.len(),4);
        assert_eq!(facts.iter().filter(|fact|matches!(fact,Fact::ToolResultAccepted {tool,outcome:AcceptedResult::Succeeded,..} if keys.contains(tool))).count(),4,"{facts:?}");
        let text_material:Vec<_>=view.tools.values().filter(|tool|tool.call.name=="RecallMaterial"
            && tool.call.input.as_json()==Some(&json!({"session_id":source,"artifact_id":artifact}))
            && tool.admitted && tool.accepted.is_some()).collect();
        assert_eq!(text_material.len(),1,"original accepted text-material call");
        let key=&text_material[0].key;
        assert!(facts.iter().any(|fact|matches!(fact,Fact::ToolResultAccepted {tool,outcome:AcceptedResult::Succeeded,..} if tool==key)));
        let data=f.store.data_writer().unwrap();
        f.owner.durable.validate_root(&data).unwrap();
        let copy_id=data.query(MaterialCopy {owner:view.spec.owner.clone(),target:target.clone(),operation:format!("{}:{}",key.attempt,key.call),source:source.clone(),artifact:artifact.clone()}).await.unwrap();
        let image_material=view.tools.values().find(|tool|tool.call.name=="RecallMaterial"
            && tool.call.input.as_json()==Some(&json!({"session_id":source,"artifact_id":image}))
            && tool.admitted && tool.accepted.is_some()).expect("original accepted image material call");
        let image_copy_id=data.query(MaterialCopy {owner:view.spec.owner.clone(),target:target.clone(),
            operation:format!("{}:{}",image_material.key.attempt,image_material.key.call),source:source.clone(),artifact:image.clone()}).await.unwrap();
        let copied_image=f.owner.durable.artifacts().get(maka_agent_state::artifacts::SessionScope{
            owner:f.owner.run_owner(),session:target.clone()},image_copy_id.clone()).await.unwrap().unwrap();
        assert_eq!(copied_image.payload.digest,maka_agent_facts::artifact::content_digest(&image_bytes));
        assert_eq!(copied_image.artifact.mime_type.as_deref(),Some("image/png"));
        let image_read=json!({"sessionId":target,"source":{"kind":"uploaded","id":image_copy_id},"offset":0});
        let before_image=f.query("attachmentImage",image_read.clone()).await.unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(before_image["data"].as_str().unwrap()).unwrap(),image_bytes);

        // Context checkpoints replace active model input, not original Recall material.
        let compacted = f.mutation(2,"compact",json!({"sessionId":target,"model":f.selection().await}),Uuid::new_v4()).await.unwrap();
        assert_eq!(compacted["kind"],"started");
        let (mut socket,_) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response_with_text(&mut socket,"A short overview without the original tool result.").await;
        f.drained().await;
        let mut baselines=0;
        for item in f.history_items(&target).await {
            if let Fact::ContextCompacted {baseline}=&item.recorded.fact {
                let baseline:maka_agent_facts::context::CompactedContext=serde_json::from_slice(&f.history(&target).content(item.recorded.run,baseline).await.unwrap()).unwrap();
                baseline.validate().unwrap();
                baselines+=1;
            }
        }
        assert!(baselines>0,"original typed baseline must be readable");
        let mut history_input = json!({"sessionId":target,"position":{"kind":"start"}});
        let mut historical_tools = String::new();
        loop {
            let page = f.query("history",history_input.clone()).await.unwrap();
            history_input["through"] = page["through"].clone();
            assert_eq!(page["kind"], "ready");
            for chunk in page["chunks"].as_array().unwrap() {
                if matches!(chunk["role"].as_str(),Some("tool_call" | "tool_result")) {
                    historical_tools.push_str(chunk["text"].as_str().unwrap());
                }
            }
            if page["after"].is_null() { break; }
            history_input["position"] = json!({"kind":"after","cursor":page["after"]});
        }
        assert!(historical_tools.contains("historical attachment contents"),"{historical_tools}");
        use maka_agent_state::artifacts::SessionScope;
        let artifacts=f.owner.durable.artifacts();
        let source_scope=SessionScope {owner:f.owner.run_owner(),session:source.clone()};
        let target_scope=SessionScope {owner:f.owner.run_owner(),session:target.clone()};
        let original=artifacts.get(source_scope.clone(),artifact.clone()).await.unwrap().unwrap();
        let copied=artifacts.get(target_scope.clone(),copy_id.clone()).await.unwrap().unwrap();
        assert_ne!(copied.artifact.id,artifact);
        assert_eq!(copied.artifact.name,"notes.txt");
        assert_eq!(copied.artifact.session_id,target);
        assert_eq!(copied.artifact.kind,original.artifact.kind);
        assert_eq!(copied.artifact.mime_type,original.artifact.mime_type);
        assert_eq!(copied.artifact.source,original.artifact.source);
        assert_eq!(copied.payload,original.payload);
        assert_eq!(copied.payload.digest,format!("sha256:{}",hex::encode(Sha256::digest(bytes))));
        // Retire the source only after every original history and material read.
        let revision=f.store.get_session::<StoredSessionConfiguration>(&source).await.unwrap().unwrap().revision;
        let removed=f.mutation(2,"changeSession",json!({"sessionId":source,"expectedRevision":revision,"action":"remove"}),Uuid::new_v4()).await.unwrap();
        assert_eq!(removed["kind"],"removed");
        f.drained().await;
        assert!(f.store.get_session::<StoredSessionConfiguration>(&source).await.unwrap().is_none());
        assert!(artifacts.get(source_scope,artifact.clone()).await.unwrap().is_none());
        let chunk=artifacts.chunk(target_scope,copy_id,0,1024).await.unwrap().unwrap();
        assert_eq!(chunk.record,copied);
        assert_eq!(chunk.total_bytes,bytes.len() as u64);
        assert_eq!(chunk.bytes,bytes);
        assert_eq!(format!("sha256:{}",hex::encode(Sha256::digest(&chunk.bytes))),copied.payload.digest);
        let after_image=f.query("attachmentImage",image_read.clone()).await.unwrap();
        assert_eq!(after_image,before_image,"source removal must not invalidate the independently owned copied image cap");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(after_image["data"].as_str().unwrap()).unwrap(),image_bytes);
        assert_eq!(after_image["digest"],copied_image.payload.digest);
        assert_eq!(after_image["mimeType"],"image/png");
        let mut wrong=image_read;wrong["sessionId"]=json!(source);
        assert!(f.query("attachmentImage",wrong).await.is_err(),"copied image identity never restores removed source authority");
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn recall_model_tool_ranks_multi_term_tool_calls_and_unlocks_mid_turn_compacted_prefix() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| settings.recall = true,
        )
        .await;
        let seed = f.create("Seed configuration").await;
        let source = format!("{}{}", f.owner.prefix, Uuid::new_v4().simple());
        import_records(&f,&seed,PluginSession {
            session_id:source.clone(),creator:Namespace::new("recall.fixture",StorageScope::Profile).unwrap(),fingerprint:source.clone(),managed:false,authority_session_id:None,
        },Source {adapter:"fixture".into(),session_id:"multi-term-source".into()},
vec![
                    Record {
                        source_message_id: "u1".into(),
                        source_turn_id: "one".into(),
                        timestamp: Some(1000),
                        content: Content::User {
                            text: "Run the gateway test suite".into(),
                        },
                    },
                    Record {
                        source_message_id: "tc1".into(),
                        source_turn_id: "one".into(),
                        timestamp: Some(1500),
                        content: Content::ToolCall {
                            call_id: "call-bash-1".into(),
                            name: "Bash".into(),
                            input: Some(json!({"command": "cargo test -p alpha-gateway"})),
                        },
                    },
                    Record {
                        source_message_id: "u2".into(),
                        source_turn_id: "two".into(),
                        timestamp: Some(2000),
                        content: Content::User {
                            text: "Fix alpha-gateway retry-budget timeout".into(),
                        },
                    },
                    Record {
                        source_message_id: "a2".into(),
                        source_turn_id: "two".into(),
                        timestamp: Some(2100),
                        content: Content::Assistant {
                            text: "Neighbor reply in turn two".into(),
                            thinking: None,
                            model: None,
                        },
                    },
                ],).await;

        let target = f.create("Active mid-turn session").await;
        let started = f
            .mutation(
                2,
                "send",
                json!({
                    "sessionId": target,
                    "message": "alpha-gateway retry-budget midturn-early-needle",
                    "backend": model_backend(&f.selection().await),
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(started["kind"], "queued");

        // Step 1: Recall with before=0, after=0 while the turn is uncompacted.
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let recall_tool = sent["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "Recall")
            .unwrap();
        assert!(recall_tool["function"]["parameters"]["properties"]["before"].is_object());
        assert!(recall_tool["function"]["parameters"]["properties"]["after"].is_object());
        tool(
            &mut socket,
            "Recall",
            json!({"terms": ["alpha-gateway", "retry-budget"], "before": 0, "after": 0}),
        )
        .await;

        // Step 2: Inspect first Recall result, then trigger reactive MidTurn compaction via context overflow.
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let first_result = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(
            !first_result.contains("midturn-early-needle"),
            "uncompacted active turn must be excluded: {first_result}"
        );
        assert!(
            first_result.contains("Ranked anchors (2):"),
            "multi-hit Recall output must prepend ranked anchor directory: {first_result}"
        );
        let multi_term_pos = first_result
            .find("Fix alpha-gateway retry-budget timeout")
            .unwrap();
        let single_term_tool_pos = first_result
            .find("Bash\ncommand: cargo test -p alpha-gateway")
            .unwrap();
        assert!(
            multi_term_pos < single_term_tool_pos,
            "2-term match must outrank 1-term ToolCall match: {first_result}"
        );
        assert!(
            !first_result.contains("Neighbor reply in turn two"),
            "before=0, after=0 must omit neighbor message bodies: {first_result}"
        );
        assert!(
            first_result.contains("More before: true; more after: true"),
            "before=0, after=0 must still report accurate neighbor availability: {first_result}"
        );
        let overflow = json!({
            "error": {
                "message": "request exceeds context",
                "type": "invalid_request_error",
                "code": "context_length_exceeded"
            }
        })
        .to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{overflow}",
                    overflow.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        // Step 3: Serve automatic MidTurn summary generation.
        let (mut summary_socket, _) = listener.accept().await.unwrap();
        let summary_req = request(&mut summary_socket).await;
        assert_eq!(summary_req["tool_choice"], "auto");
        response_with_text(
            &mut summary_socket,
            "Compacted mid-turn handoff without original token.",
        )
        .await;

        // Step 4: Resumed active turn after MidTurn checkpoint can now Recall its compacted prefix,
        // while excluding post-checkpoint live messages in the same turn.
        let (mut socket, _) = listener.accept().await.unwrap();
        let resumed = request(&mut socket).await;
        let resumed_messages = resumed["messages"].to_string();
        assert!(!resumed_messages.contains("midturn-early-needle"));
        assert!(resumed_messages.contains("Compacted mid-turn handoff without original token."));
        tool(
            &mut socket,
            "Recall",
            json!({
                "terms": ["midturn-early-needle", "post-checkpoint-live-arg"],
                "session_id": target,
                "before": 0,
                "after": 0
            }),
        )
        .await;

        // Step 5: Verify compacted prefix was found and live post-checkpoint ToolCall was excluded,
        // then expand via RecallMore and verify expansion stops at covered_through.
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let second_result = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(
            second_result.contains("midturn-early-needle"),
            "compacted MidTurn prefix must be searchable in Recall: {second_result}"
        );
        assert!(
            !second_result.contains("post-checkpoint-live-arg"),
            "uncompacted live tail after MidTurn checkpoint must remain excluded: {second_result}"
        );
        let anchor_id = second_result
            .lines()
            .find_map(|line| line.strip_prefix("Anchor: "))
            .unwrap()
            .trim()
            .to_owned();
        tool(
            &mut socket,
            "RecallMore",
            json!({
                "session_id": target,
                "anchor_message_id": anchor_id,
                "before": 0,
                "after": 10
            }),
        )
        .await;

        // Step 6: Verify RecallMore expands compacted MidTurn neighbors up to covered_through only.
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let expanded = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(expanded.contains("midturn-early-needle"), "{expanded}");
        assert!(
            expanded.contains("Recall\nterms: alpha-gateway\nterms: retry-budget\nbefore: 0\nafter: 0"),
            "{expanded}"
        );
        assert!(
            expanded.contains("Fix alpha-gateway retry-budget timeout"),
            "{expanded}"
        );
        assert!(
            !expanded.contains("post-checkpoint-live-arg"),
            "RecallMore must not cross covered_through into the live turn tail: {expanded}"
        );
        assert!(
            expanded.contains("More before: false; more after: false"),
            "{expanded}"
        );
        response(&mut socket).await;
        f.drained().await;

        let history=f.history(&target);
        let mut midturn=false;
        for item in f.history_items(&target).await {
            if let Fact::ContextCompacted {baseline}=&item.recorded.fact {
                let baseline:maka_agent_facts::context::CompactedContext=serde_json::from_slice(&history.content(item.recorded.run,baseline).await.unwrap()).unwrap();
                baseline.validate().unwrap();
                if matches!(baseline.checkpoint.mode,maka_agent_facts::context::CheckpointMode::MidTurn { .. }) {midturn=true;}
            }
        }
        assert!(midturn,"original typed MidTurn baseline must be retained");
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn recall_and_catalog_isolate_unreadable_historical_sessions_and_sources() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| settings.recall = true,
        )
        .await;
        let healthy = imported(
            &f,
            "Healthy needle conversation",
            &f.owner.prefix,
            "Healthy needle answer",
        )
        .await;
        let legacy_config = imported(
            &f,
            "Legacy needle config",
            &f.owner.prefix,
            "Legacy needle body",
        )
        .await;
        let corrupt_source = imported(
            &f,
            "Corrupt needle events",
            &f.owner.prefix,
            "Corrupt needle event body",
        )
        .await;

        // Pre-index legacy_config so recall_messages has hits whose session metadata is unreadable,
        // exercising both catalog/title isolation and hit-metadata isolation.
        assert_eq!(
            f.recall(json!({"terms":["needle"],"session_id":legacy_config}))
                .await
                .unwrap()["passages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        {
            let db = rusqlite::Connection::open(f.session_database(&legacy_config)).unwrap();
            db.execute(
                "UPDATE session_control SET configuration=json_set(configuration,'$.workspace',json('{\"kind\":\"inline_legacy\"}')) WHERE id=?1",
                [&legacy_config],
            )
            .unwrap();
        }
        {
            let db = rusqlite::Connection::open(f.session_database(&corrupt_source)).unwrap();
            let changed=db.execute(
                "UPDATE contents SET payload=CAST(json_set(CAST(payload AS TEXT),'$.version',999) AS BLOB)
                 WHERE id=(SELECT manifest_content_id FROM agent_history_snapshots WHERE session=?1 AND owner=?2)",
                rusqlite::params![corrupt_source,serde_json::to_string(&f.owner.run_owner()).unwrap()],
            ).unwrap();
            assert_eq!(changed,1,"fault must touch the corrupt Session's actual immutable source manifest only");
        }

        let found = f.recall(json!({"terms":["needle"]})).await.unwrap();
        assert_eq!(found["complete"], false, "{found}");
        let title_ids: Vec<_> = found["titles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert!(title_ids.contains(&healthy.as_str()), "{found}");
        assert!(title_ids.contains(&corrupt_source.as_str()), "{found}");
        assert!(!title_ids.contains(&legacy_config.as_str()), "{found}");
        let passage_ids: Vec<_> = found["passages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["session"]["id"].as_str().unwrap())
            .collect();
        assert_eq!(passage_ids, vec![healthy.as_str()], "{found}");
        let gaps: Vec<_> = found["gaps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|gap| gap.as_str().unwrap())
            .collect();
        assert!(
            gaps.iter().any(|gap| gap.contains(&legacy_config)),
            "{gaps:?}"
        );
        assert!(
            gaps.iter().any(|gap| gap.contains(&corrupt_source)),
            "{gaps:?}"
        );

        let scoped_healthy = f
            .recall(json!({"terms":["needle"],"session_id":healthy}))
            .await
            .unwrap();
        assert_eq!(scoped_healthy["complete"], true, "{scoped_healthy}");
        assert_eq!(scoped_healthy["gaps"], json!([]), "{scoped_healthy}");
        assert!(
            f.recall(json!({"terms":["needle"],"session_id":legacy_config}))
                .await
                .is_err()
        );

        let listed = f
            .query(
                "list",
                json!({
                    "filter": "all",
                    "rootsOnly": false,
                    "scope": {"kind": "all"},
                    "position": {"kind": "start"}
                }),
            )
            .await
            .unwrap();
        let listed_ids: Vec<_> = listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert!(listed_ids.contains(&healthy.as_str()), "{listed}");
        assert!(!listed_ids.contains(&legacy_config.as_str()), "{listed}");

        let caller = f.create("Caller conversation").await;
        let started = f
            .mutation(
                2,
                "send",
                json!({
                    "sessionId": caller,
                    "message": "Search earlier needle notes",
                    "backend": model_backend(&f.selection().await)
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(started["kind"], "queued");
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = request(&mut socket).await;
        tool(&mut socket, "Recall", json!({"terms": ["needle"]})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let tool_output = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        assert!(tool_output.contains("Healthy needle answer"), "{tool_output}");
        assert!(tool_output.contains(&corrupt_source), "{tool_output}");
        response(&mut socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
