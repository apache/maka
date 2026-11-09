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

use crate::support;
use maka_agent_facts::{durable::*, history_snapshot::SnapshotId, session::ForkPosition};
use maka_agent_state::{Change, ContentBlob, session_history::snapshot::CaptureRequest};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn frozen_semantic_parts_keep_original_identity_while_private_evidence_has_no_tool_authority()
{
    use maka_agent_facts::{
        context::ModelPurpose,
        history_snapshot::Origin,
        model::{
            ModelPart, TextKind,
            assembly::AttemptBinding,
            recorded::{
                CompletionPart, ModelPartRecord, ModelPartial, PrivateModelPartial, ToolInputPhase,
                ToolInputView,
            },
        },
    };
    use maka_agent_state::session_history::{
        navigation::SourceFind,
        source_tree::{SourceItem, SourceTree},
    };
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let store = support::state(&root);
    let run = support::admit(&store, "session", "partial-turn", "original input").await;
    let history = store.session_history(support::owner(), "session".into());
    let ordinary_bytes =
        format!("{{\"ordinary\":\"{}\"}}\n \t ", "x".repeat(256 * 1024)).into_bytes();
    let ordinary = ContentBlob::new(ordinary_bytes.clone());
    let (step, request, mut contents) =
        support::request_with_contents(vec![], vec![ordinary.reference().clone()]);
    contents.push(ordinary.clone());
    let request_ref = request.reference().clone();
    let attempt = ModelAttemptId::new();
    support::append(
        &store,
        run,
        vec![
            Fact::StepPrepared {
                step,
                request: request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: serde_json::json!({"fixture":"admitted"}),
            },
        ],
        contents,
    )
    .await;
    let before = history.capture().await.unwrap();
    let started = std::time::UNIX_EPOCH + std::time::Duration::from_millis(41);
    let partial = PrivateModelPartial {
        binding: AttemptBinding {
            execution: ExecutionIdentity {
                session_id: "session".into(),
                turn_id: "partial-turn".into(),
                run_id: run,
            },
            step_id: step,
            attempt_id: attempt,
            purpose: ModelPurpose::Main,
        },
        revision: 1,
        depends_on: before.through_sequence,
        partial: ModelPartial {
            parts: vec![CompletionPart::Own(ModelPartRecord {
                ordinal: 0,
                message_id: "original-preview-id".into(),
                started_at: started,
                provider_part_id: None,
                part: std::sync::Arc::new(ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: "private-only-preview🙂\0".into(),
                    provider_options: None,
                }),
            })],
            tool_inputs: vec![ToolInputView {
                id: "unaccepted-call".into(),
                message_id: "original-tool-preview-id".into(),
                started_at: started,
                name: "Read".into(),
                provider_executed: false,
                text: "{\"unfinished\":".into(),
                phase: ToolInputPhase::Open,
            }],
            response_id: Some("original-response".into()),
            model: Some("original-reported-model".into()),
            timestamp: None,
        },
    };
    let mut partial_bytes = serde_json::to_vec(&partial).unwrap();
    partial_bytes.extend_from_slice(&vec![b' '; 64 * 1024]);
    let partial_body = ContentBlob::new(partial_bytes);
    support::append(
        &store,
        run,
        vec![Fact::ModelPrivatePartialCaptured {
            attempt,
            partial: partial_body.reference().clone(),
        }],
        vec![partial_body.clone()],
    )
    .await;
    let private_cut = history.capture().await.unwrap();
    let private_tree = SourceTree::live(&history, &private_cut).await.unwrap();
    assert_eq!(
        private_tree
            .positions(None, false, true, 128)
            .await
            .unwrap()
            .len(),
        1,
        "private Own/tool input does not create a semantic model row"
    );
    assert!(
        private_tree
            .find_page(
                SourceFind {
                    after: None,
                    query: "private-only-preview".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: true
                },
                CancellationToken::new()
            )
            .await
            .unwrap()
            .matches
            .is_empty()
    );
    assert!(
        history
            .with_content(&before, run, partial_body.reference(), |_| Ok(()))
            .await
            .is_err()
    );
    let diagnostic: PrivateModelPartial = history
        .with_content(&private_cut, run, partial_body.reference(), |reader| {
            Ok(serde_json::from_reader(reader)?)
        })
        .await
        .unwrap();
    assert_eq!(
        diagnostic, partial,
        "authorized evidence preserves original own ids, body, time and tool-input bytes"
    );
    let prior = store.frontier(run).await.unwrap();
    let input = ContentBlob::json(&serde_json::json!({"path":"not-executable"})).unwrap();
    let claim = store.claim(run).await.unwrap();
    let error = store
        .append(
            &claim,
            (&prior).into(),
            vec![Change::new(
                Fact::ToolDecided {
                    tool: ToolKey {
                        attempt,
                        call: "unaccepted-call".into(),
                    },
                    decision: ToolDecision::Approved {
                        input: input.reference().clone(),
                        resources: vec![],
                        approval: None,
                        display: ToolDisplay::default(),
                        semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                    },
                },
                UnixMillis(7),
            )],
            vec![input],
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error.underlying(),maka_event_log::StoreError::InvalidTransition(reason) if reason=="unknown hard tool obligation")
    );
    assert_eq!(history.capture().await.unwrap(), private_cut);
    assert!(store.frontier(run).await.unwrap().tools.is_empty());
    let text = format!("accepted中😀\0{}suffix-needle", "🦀".repeat(10_000));
    support::append(
        &store,
        run,
        vec![Fact::ModelObserved {
            attempt,
            index: 0,
            part: ModelPart::Text {
                text_kind: TextKind::Text,
                text: text.clone().into(),
                provider_options: None,
            },
            continuation: None,
        }],
        vec![],
    )
    .await;
    let accepted_cut = history.capture().await.unwrap();
    let frozen = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                cut: accepted_cut.clone(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let tree = SourceTree::snapshot(&frozen).await.unwrap();
    let rows = tree.positions(None, false, false, 128).await.unwrap();
    assert_eq!(rows.len(), 2);
    let SourceItem::Canonical(original) = tree.item(&rows[1].address).await.unwrap() else {
        panic!("actual canonical semantic source");
    };
    assert!(
        matches!(&original.recorded.fact,Fact::ModelObserved {attempt:actual,index:0,part:ModelPart::Text {text:body,..},..} if *actual==attempt && body.to_string()==text)
    );
    assert_eq!(original.scope.step, Some(step));
    assert_eq!(original.scope.attempt, Some(attempt));
    assert!(
        frozen.view_at(run).await.unwrap().attempts[&attempt]
            .closed
            .is_none(),
        "the frozen semantic part exists before model closure"
    );
    let saved = frozen
        .with_payload(partial_body.reference(), |reader| {
            Ok(serde_json::from_reader::<_, PrivateModelPartial>(reader)?)
        })
        .await
        .unwrap();
    assert_eq!(saved, partial);
    support::append(
        &store,
        run,
        vec![
            Fact::ModelObserved {
                attempt,
                index: 1,
                part: ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: "later semantic source".into(),
                    provider_options: None,
                },
                continuation: None,
            },
            Fact::ModelClosed {
                attempt,
                outcome: maka_agent_facts::accounting::Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: serde_json::json!({}),
            },
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
            },
        ],
        vec![],
    )
    .await;
    support::complete(&store, run).await;
    let SourceItem::Canonical(later) = tree.item(&rows[1].address).await.unwrap() else {
        panic!("same frozen canonical source");
    };
    assert_eq!(later, original);
    let snapshot_id = frozen.id();
    root.close().await.unwrap();
    let root = support::open(directory.path(), true).await;
    let history = support::state(&root).session_history(support::owner(), "session".into());
    let (request, restored) = history
        .captured_snapshot(snapshot_id, CancellationToken::new())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(request.cut, accepted_cut);
    assert_eq!(
        restored.manifest().await.unwrap().origin,
        Origin::Canonical {
            cut: accepted_cut.clone()
        }
    );
    let restored_tree = SourceTree::snapshot(&restored).await.unwrap();
    let SourceItem::Canonical(reopened) = restored_tree.item(&rows[1].address).await.unwrap()
    else {
        panic!("same original canonical source");
    };
    assert_eq!(reopened, original);
    use maka_event_log::{
        StoreError,
        connection::Query,
        writeback::{Notification, Prepared, Statement},
    };
    use rusqlite::{Connection, OptionalExtension, params};
    use std::io::Read;
    struct EditPayload {
        run: RunId,
        reference: ContentRef,
        restore: Option<Vec<u8>>,
    }
    impl Statement for EditPayload {
        type Value = Vec<u8>;
        type Output = Vec<u8>;
        fn execute(self, c: &Connection) -> Result<Prepared<Vec<u8>>, StoreError> {
            let bytes =
                i64::try_from(self.reference.bytes).expect("fixture content size fits SQLite i64");
            let (id,original):(i64,Vec<u8>)=c.query_row("SELECT b.id,b.payload FROM agent_content_pins p JOIN contents b ON b.id=p.content_id WHERE p.run=? AND b.content_sha256=? AND length(b.payload)=?",params![self.run.to_string(),self.reference.digest,bytes],|row|Ok((row.get(0)?,row.get(1)?)))?;
            let changed = if let Some(restored) = self.restore {
                restored
            } else {
                let mut bytes = original.clone();
                if bytes.last().is_some_and(u8::is_ascii_whitespace) {
                    let last = bytes.last_mut().unwrap();
                    *last = if *last == b' ' { b'\t' } else { b' ' };
                } else {
                    let needle = b"fixture";
                    let at = bytes
                        .windows(needle.len())
                        .position(|part| part == needle)
                        .expect("original request's actual typed metadata");
                    bytes[at] = b'X';
                }
                assert_eq!(bytes.len(), original.len());
                assert_ne!(bytes, original);
                serde_json::from_slice::<serde_json::Value>(&bytes)?;
                bytes
            };
            let trigger:Option<String>=c.query_row("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='content_immutable'",[],|row|row.get(0)).optional()?;
            if trigger.is_some() {
                c.execute_batch("DROP TRIGGER content_immutable")?;
            }
            assert_eq!(
                c.execute(
                    "UPDATE contents SET payload=? WHERE id=?",
                    params![changed, id]
                )?,
                1
            );
            if let Some(trigger) = trigger {
                c.execute_batch(&trigger)?;
            }
            Ok(Prepared {
                value: original,
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(value: Vec<u8>) -> Vec<u8> {
            value
        }
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    struct RawPayload {
        reference: ContentRef,
        snapshot: SnapshotId,
    }
    impl Query for RawPayload {
        type Output = (Vec<u8>, bool);
        fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
            let size =
                i64::try_from(self.reference.bytes).expect("fixture content size fits SQLite i64");
            let bytes = c.query_row(
                "SELECT payload FROM contents WHERE content_sha256=? AND length(payload)=?",
                params![self.reference.digest, size],
                |row| row.get(0),
            )?;
            let published=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshots WHERE snapshot=?1) OR EXISTS(SELECT 1 FROM agent_history_snapshot_entries WHERE snapshot=?1) OR EXISTS(SELECT 1 FROM agent_history_snapshot_pins WHERE snapshot=?1)",[self.snapshot.to_string()],|row|row.get(0))?;
            Ok((bytes, published))
        }
    }
    fn digest_error(error: StoreError) {
        let diagnostic = error.to_string();
        let digest = ["hash", "digest", "corrupt"]
            .iter()
            .any(|word| diagnostic.contains(word));
        assert!(
            digest
                && match error.underlying() {
                    StoreError::InvalidTransition(_) => true,
                    StoreError::Io(error) => error.kind() == std::io::ErrorKind::InvalidData,
                    StoreError::Json(error) => error.is_io(),
                    _ => false,
                },
            "must fail the original digest, not malformed JSON or missing scope/id: {error}"
        );
    }
    let store = support::state(&root);
    let data = root.data_writer().unwrap();
    let template: RequestSpec = history
        .with_content(&accepted_cut, run, &request_ref, |reader| {
            Ok(serde_json::from_reader(reader)?)
        })
        .await
        .unwrap();
    let source_run = support::admit(
        &store,
        "session",
        "source-failure-metadata",
        "original failed Main source",
    )
    .await;
    let (source_step, discarded_request, mut source_contents) = support::request(vec![]);
    let source_attempt = ModelAttemptId::new();
    source_contents.retain(|body| body.reference() != discarded_request.reference());
    let mut typed_request = template;
    typed_request.step = source_step;
    typed_request.request_contents.clear();
    let mut request_bytes = serde_json::to_vec(&typed_request).unwrap();
    request_bytes.extend_from_slice(&vec![b' '; 64 * 1024]);
    let source_request = ContentBlob::new(request_bytes);
    source_contents.push(source_request.clone());
    support::append(
        &store,
        source_run,
        vec![
            Fact::StepPrepared {
                step: source_step,
                request: source_request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared {
                attempt: source_attempt,
                step: source_step,
            },
            Fact::ModelAttemptAdmitted {
                attempt: source_attempt,
                upstream: serde_json::json!({"fixture":"original admitted source"}),
            },
        ],
        source_contents,
    )
    .await;
    let failure = maka_agent_facts::context::ModelFailureProtocol {
        failure: maka_agent_facts::model::error::ModelError::Adapter(
            "original adapter error".into(),
        ),
        transport: None,
    };
    let mut failure_bytes = serde_json::to_vec(&failure).unwrap();
    failure_bytes.extend_from_slice(&vec![b' '; 64 * 1024]);
    let failure_body = ContentBlob::new(failure_bytes);
    support::append(
        &store,
        source_run,
        vec![Fact::ModelSourceFailureCaptured {
            attempt: source_attempt,
            failure: failure_body.reference().clone(),
        }],
        vec![failure_body.clone()],
    )
    .await;
    let metadata_cut = history.capture().await.unwrap();
    let metadata_snapshot = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                cut: metadata_cut.clone(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let healthy_prefix = history.page(&before, 0, 128).await.unwrap();
    let metadata_tree = SourceTree::live(&history, &metadata_cut).await.unwrap();
    let metadata_source = metadata_tree.source_for_path(&[], None).await.unwrap();
    assert_eq!(
        metadata_source
            .request(source_run, source_step)
            .await
            .unwrap(),
        typed_request
    );
    let original_request: RequestSpec = history
        .with_content(&metadata_cut, run, &request_ref, |reader| {
            Ok(serde_json::from_reader(reader)?)
        })
        .await
        .unwrap();
    assert_eq!(original_request.step, step);
    assert!(
        original_request
            .request_contents
            .contains(ordinary.reference())
    );
    for (owner_run, reference, metadata) in [
        (run, partial_body.reference().clone(), true),
        (run, ordinary.reference().clone(), false),
        (source_run, source_request.reference().clone(), true),
        (source_run, failure_body.reference().clone(), true),
    ] {
        let baseline: Vec<u8> = history
            .with_content(&metadata_cut, owner_run, &reference, |reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .unwrap();
        let snapshot_bytes: Vec<u8> = metadata_snapshot
            .with_payload(&reference, |reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .unwrap();
        assert_eq!(snapshot_bytes, baseline);
        let original = data
            .write(EditPayload {
                run: owner_run,
                reference: reference.clone(),
                restore: None,
            })
            .await
            .unwrap();
        assert_eq!(original, baseline);
        history
            .with_content(&metadata_cut, owner_run, &reference, |_| Ok(()))
            .await
            .unwrap();
        metadata_snapshot
            .with_payload(&reference, |_| Ok(()))
            .await
            .unwrap();
        let prefix_live = history
            .with_content(&metadata_cut, owner_run, &reference, |reader| {
                assert_eq!(reader.read(&mut [])?, 0);
                let mut bytes = Vec::new();
                reader.take(17).read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .unwrap();
        assert_eq!(prefix_live, baseline[..17]);
        let prefix_frozen = metadata_snapshot
            .with_payload(&reference, |reader| {
                assert_eq!(reader.read(&mut [])?, 0);
                let mut bytes = Vec::new();
                reader.take(17).read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .unwrap();
        assert_eq!(prefix_frozen, baseline[..17]);
        digest_error(
            history
                .with_content(&metadata_cut, owner_run, &reference, |reader| {
                    assert_eq!(reader.read(&mut [])?, 0);
                    let mut bytes = Vec::new();
                    reader.read_to_end(&mut bytes)?;
                    Ok(bytes)
                })
                .await
                .unwrap_err(),
        );
        digest_error(
            metadata_snapshot
                .with_payload(&reference, |reader| {
                    assert_eq!(reader.read(&mut [])?, 0);
                    let mut bytes = Vec::new();
                    reader.read_to_end(&mut bytes)?;
                    Ok(bytes)
                })
                .await
                .unwrap_err(),
        );
        digest_error(
            history
                .with_content(&metadata_cut, owner_run, &reference, |reader| {
                    Ok(serde_json::from_reader::<_, serde_json::Value>(reader)?)
                })
                .await
                .unwrap_err(),
        );
        if reference == *source_request.reference() {
            digest_error(
                metadata_source
                    .request(source_run, source_step)
                    .await
                    .unwrap_err(),
            );
            digest_error(history.rebuild().await.unwrap_err());
        }
        let failed_id = SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap();
        if metadata {
            let Err(error) = history
                .capture_snapshot(
                    CaptureRequest {
                        id: failed_id,
                        cut: metadata_cut.clone(),
                    },
                    CancellationToken::new(),
                )
                .await
            else {
                panic!("metadata Complete must reject inside the original capture Statement");
            };
            digest_error(error);
        }
        let (damaged, published) = data
            .query(RawPayload {
                reference: reference.clone(),
                snapshot: failed_id,
            })
            .await
            .unwrap();
        assert!(!published);
        assert_ne!(damaged, baseline);
        assert_eq!(damaged.len(), baseline.len());
        assert_eq!(
            history.page(&before, 0, 128).await.unwrap(),
            healthy_prefix,
            "unexpanded healthy prefix must not be cut off by a later metadata/payload digest failure"
        );
        // Only the explicit fixture fault injector restores bytes, never a read/capture/repair path.
        let prior = data
            .write(EditPayload {
                run: owner_run,
                reference: reference.clone(),
                restore: Some(baseline.clone()),
            })
            .await
            .unwrap();
        assert_eq!(prior, damaged);
        let restored: Vec<u8> = metadata_snapshot
            .with_payload(&reference, |reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .unwrap();
        assert_eq!(restored, baseline);
    }
    root.close().await.unwrap();
}

#[tokio::test]
async fn immutable_tool_evidence_never_accepts_an_unobserved_result_or_becomes_replay_authority() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let store = support::state(&root);
    let (run, tool) = support::admitted_tool(&store).await;
    let history = store.session_history(support::owner(), "session".into());
    let before = history.capture().await.unwrap();
    let body = ContentBlob::json(&maka_agent_facts::artifact::ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![],
        body: maka_agent_facts::tool_output::ReturnedToolResult {
            output: maka_agent_facts::tool_output::ToolOutput::Json(serde_json::json!(
                "not observed"
            )),
            projection: maka_agent_facts::tool_output::DurableToolProjection::Text {
                text: "not observed".into(),
            },
            is_error: false,
            loaded_tools: Default::default(),
        },
    })
    .unwrap();
    let driver = store.claim(run).await.unwrap();
    let view = store.frontier(run).await.unwrap();
    assert!(
        store
            .append(
                &driver,
                (&view).into(),
                vec![Change::new(
                    Fact::ToolResultAccepted {
                        tool: tool.clone(),
                        result: body.reference().clone(),
                        outcome: AcceptedResult::Succeeded,
                    },
                    UnixMillis(3)
                )],
                vec![body]
            )
            .await
            .is_err()
    );
    assert_eq!(history.capture().await.unwrap(), before);
    assert!(history.fork_cut(ForkPosition::End).await.is_err());
    let snapshot = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                cut: before.clone(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let facts = snapshot.page(0, 256).await.unwrap().items;
    assert!(facts.iter().any(
        |item| matches!(&item.recorded.fact,Fact::ToolAdmitted{tool:actual} if actual==&tool)
    ));
    assert!(
        !facts
            .iter()
            .any(|item| matches!(item.recorded.fact, Fact::ToolResultAccepted { .. }))
    );
    let view = snapshot.view_at(run).await.unwrap();
    assert_eq!(view.tools.len(), 1);
    assert!(view.tools.values().next().unwrap().accepted.is_none());
    root.close().await.unwrap();
}
