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

use maka_agent_facts::{
    event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent, ToolOutcome,
    },
    history::semantic::{SemanticKind, SemanticRow},
    model::prompt_source::source::{Allocate, ByteSource, ChargedBuffer, SourceBudget},
    tool_output::{DurableToolProjection, ToolOutput},
};
use maka_event_log::{
    EventLog, RootStore,
    bundle::StagedBundle,
    context::semantic::{PayloadEncoding, SemanticSelection},
    root::{RootNamespaces, RootOwner},
};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::{collections::BTreeMap, sync::Arc};

struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum.max(7)], ())) })
    }
}
async fn read(source: Arc<dyn ByteSource>) -> Vec<u8> {
    let mut cursor = source.open(Arc::new(Budget));
    let mut bytes = Vec::new();
    loop {
        let result = cursor
            .read_chunk(ChargedBuffer::new(vec![0; 7], ()))
            .await
            .unwrap();
        bytes.extend_from_slice(&result.buffer.as_ref()[..result.bytes_read]);
        if result.eof {
            return bytes;
        }
    }
}
#[derive(Deserialize)]
struct StoredPayload<'a> {
    #[serde(rename = "Tool", borrow)]
    tool: StoredProjection<'a>,
}
#[derive(Deserialize)]
struct StoredProjection<'a> {
    #[serde(borrow)]
    value: &'a RawValue,
}

#[tokio::test]
async fn raw_bundle_projection_preserves_event_bytes_and_exposes_normalized_model_json() {
    let raw_projections = [
        r#"{ "kind" : "json", "value" : { "text" : "\u4e2d\/", "n":1e2 } }"#,
        r#"{"kind":"json","value":{"duplicate":0,"text":"hello","duplicate":2}}"#,
        r#"{"value":{"\u006b":"\u0061","array":[ 1.00e+2, true, null ]},"kind":"json"}"#,
    ];
    for (index, raw_projection) in raw_projections.into_iter().enumerate() {
        let projection: DurableToolProjection = serde_json::from_str(raw_projection).unwrap();
        let DurableToolProjection::Json { value } = projection else {
            unreachable!()
        };
        let normalized_value = value.to_string();
        let source_directory = tempfile::tempdir().unwrap();
        let source = EventLog::open(&source_directory.path().join("source.sqlite"))
            .await
            .unwrap();
        source
            .create_session("source", "source", &json!({}), 1)
            .await
            .unwrap();
        let invocation = Invocation {
            session_id: "source".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        source
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::InvocationOpened {
                        input: InvocationInput::Message {
                            content: "question".into(),
                            request_fingerprint: None,
                            source_messages: Vec::new(),
                        },
                        configuration: None,
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        let (result, _) =
            super::fixtures::output(&source, &invocation, "step", ToolOutput::Json(value).into())
                .await;
        let result_id = result.event().id.clone();
        source
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        let inventory = source.preview_bundle("source").await.unwrap();
        let (bytes, _) = source
            .export_bundle("source", &inventory.subtree_digest, Vec::new())
            .await
            .unwrap();
        source.close().await.unwrap();
        let mut original_raw = None;
        let bytes = super::frames::rewrite_records(&bytes, |record| {
            if record["kind"] == "event" {
                let raw = record["json"].as_str().unwrap();
                let event: RuntimeEvent = serde_json::from_str(raw).unwrap();
                if event.id == result_id {
                    let Fact::ToolSettled {
                        outcome:
                            ToolOutcome::Succeeded {
                                model_projection, ..
                            },
                        ..
                    } = &event.fact
                    else {
                        unreachable!()
                    };
                    let encoded = serde_json::to_string(model_projection).unwrap();
                    let rewritten = raw.replacen(&encoded, raw_projection, 1);
                    assert_ne!(rewritten, raw);
                    assert_eq!(
                        serde_json::from_str::<RuntimeEvent>(&rewritten).unwrap(),
                        event
                    );
                    original_raw = Some(rewritten.clone());
                    record["json"] = Value::String(rewritten);
                }
            }
            true
        });
        let original_raw = original_raw.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let owner = RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("ownership"),
                control: directory.path().join("control"),
            },
        )
        .unwrap();
        let root = RootStore::open(Arc::new(owner)).await.unwrap();
        root.import_bundle(
            StagedBundle::read(bytes.as_slice()).await.unwrap(),
            &maka_agent_facts::artifact::content_digest(format!("binding-{index}").as_bytes()),
            BTreeMap::from([("source".to_owned(), json!({}))]),
        )
        .await
        .unwrap();
        let session = root.session("source").await.unwrap();
        let scope = session.execution_scope(None).await.unwrap();
        let running = scope.store();
        let parent = scope.accept();
        let through = running.committed_sequence().await.unwrap();
        let captured = running
            .capture_source(SemanticSelection {
                session: "source".into(),
                lineage: None,
                after: 0,
                through,
                before: u64::MAX,
                captured_through: through,
                replay: None,
                prior_unknown: false,
            })
            .await
            .unwrap();
        let mut cursor = None;
        let mut model_json = None;
        loop {
            let mut page = captured
                .metadata_page(cursor, ChargedBuffer::new(vec![0; 4096], ()))
                .await
                .unwrap();
            for index in 0..page.len() {
                let row = page.row(index).unwrap();
                let metadata: SemanticRow = serde_json::from_slice(
                    &read(
                        captured
                            .byte_source(&captured.metadata_source(&row).unwrap())
                            .unwrap(),
                    )
                    .await,
                )
                .unwrap();
                if matches!(metadata.kind, SemanticKind::ToolResult { .. }) {
                    let payload = captured.describe_payload(&row).unwrap().unwrap();
                    let bytes = read(captured.byte_source(&payload).unwrap()).await;
                    model_json = Some(match payload.encoding() {
                        PayloadEncoding::Payload => {
                            let stored: StoredPayload<'_> = serde_json::from_slice(&bytes).unwrap();
                            stored.tool.value.get().to_owned()
                        }
                        PayloadEncoding::CanonicalProjection => {
                            let stored: StoredProjection<'_> =
                                serde_json::from_slice(&bytes).unwrap();
                            stored.value.get().to_owned()
                        }
                        other => panic!("unexpected tool projection source: {other:?}"),
                    });
                }
            }
            cursor = page.next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(model_json.as_deref(), Some(normalized_value.as_str()));
        drop(captured);
        parent.finish();
        let inventory = root.preview_bundle("source").await.unwrap();
        let (reexported, summary) = root
            .export_bundle("source", &inventory.subtree_digest, Vec::new())
            .await
            .unwrap();
        let records = super::frames::records(&reexported, &summary.digest);
        let preserved = records
            .iter()
            .find(|record| {
                record["kind"] == "event"
                    && serde_json::from_str::<RuntimeEvent>(record["json"].as_str().unwrap())
                        .unwrap()
                        .id
                        == result_id
            })
            .unwrap();
        assert_eq!(preserved["json"].as_str(), Some(original_raw.as_str()));
        root.close().await.unwrap();
    }
}
