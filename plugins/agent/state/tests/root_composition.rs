/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

mod support;

use maka_agent_facts::{
    durable::*,
    history_snapshot::SnapshotId,
    model::{ModelPart, TextKind},
};
use maka_agent_state::{
    ContentBlob,
    session_history::{SessionHistory, snapshot::CaptureRequest},
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn captured_source_reads_admitted_canonical_bytes_at_its_frozen_cut() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let run = support::admit(&state, "session", "turn", "covered question").await;
    let history = SessionHistory::new(
        root.data_writer().unwrap(),
        support::owner(),
        "session".into(),
    );
    let (step, request, contents) = support::request(vec![]);
    let attempt = ModelAttemptId::new();
    support::append(
        &state,
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
                upstream: json!({"accepted":true}),
            },
        ],
        contents,
    )
    .await;
    let before = history.capture().await.unwrap();
    let original = ModelPart::Text {
        text_kind: TextKind::Text,
        text: "accepted 中\0suffix".into(),
        provider_options: None,
    };
    support::append(
        &state,
        run,
        vec![Fact::ModelObserved {
            attempt,
            index: 0,
            part: original.clone(),
            continuation: None,
        }],
        vec![],
    )
    .await;
    let cut = history.capture().await.unwrap();
    let request = CaptureRequest {
        id: SnapshotId::new(),
        cut: cut.clone(),
    };
    let source = history
        .capture_snapshot(request.clone(), CancellationToken::new())
        .await
        .unwrap();
    support::append(
        &state,
        run,
        vec![Fact::ModelObserved {
            attempt,
            index: 1,
            part: ModelPart::Text {
                text_kind: TextKind::Text,
                text: "later accepted body".into(),
                provider_options: None,
            },
            continuation: None,
        }],
        vec![],
    )
    .await;

    let page = source.page(before.through_sequence, 64).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(page.next.is_none());
    let record = &page.items[0];
    assert_eq!(record.sequence, cut.through_sequence);
    assert_eq!(record.recorded.run, run);
    assert!(
        matches!(&record.recorded.fact, Fact::ModelObserved { attempt: actual, index: 0, part, .. } if *actual == attempt && part == &original)
    );
    let body = ContentBlob::json(&record.recorded).unwrap();
    let restored: RecordedFact =
        serde_json::from_slice(&source.chunk(body.reference(), 0, u32::MAX).await.unwrap())
            .unwrap();
    assert_eq!(restored, record.recorded);
    let streamed: RecordedFact = source
        .with_payload(body.reference(), |reader| {
            Ok(serde_json::from_reader(reader)?)
        })
        .await
        .unwrap();
    assert_eq!(streamed, restored);
    let later_cut = history.capture().await.unwrap();
    assert!(
        source
            .item(later_cut.through_sequence)
            .await
            .unwrap()
            .is_none()
    );
    assert!(source.chunk(body.reference(), u64::MAX, 1).await.is_err());
    let foreign = SessionHistory::new(
        root.data_writer().unwrap(),
        support::owner(),
        "foreign".into(),
    );
    assert!(
        foreign
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut
                },
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    root.close().await.unwrap();

    let root = support::open(directory.path(), true).await;
    let history = SessionHistory::new(
        root.data_writer().unwrap(),
        support::owner(),
        "session".into(),
    );
    let (recovered_request, recovered) = history
        .captured_snapshot(request.id, CancellationToken::new())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered_request, request);
    assert_eq!(
        recovered
            .page(before.through_sequence, 64)
            .await
            .unwrap()
            .items,
        page.items
    );
    assert_eq!(
        recovered
            .chunk(body.reference(), 0, u32::MAX)
            .await
            .unwrap(),
        serde_json::to_vec(&restored).unwrap()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn captured_artifact_sources_recheck_original_namespace_and_inventory() {
    use maka_agent_facts::{
        artifact::{Artifact, ArtifactKind, ArtifactSource, PublishedArtifact, content_digest},
        history_snapshot::{
            Entry, HistoricalRole, ImportedArtifactScope, ImportedMessage, ImportedPart,
            ImportedTurnOrdinal,
        },
        import::Source,
    };
    use maka_agent_state::session_history::snapshot::ImportedCaptureRequest;
    use support::imported::Tape;

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let history = SessionHistory::new(
        root.data_writer().unwrap(),
        support::owner(),
        "session".into(),
    );
    let mut tape = Tape::new();
    let payload = tape.push_blob(b"abc");
    let artifact = Artifact {
        id: "protected".into(),
        session_id: "session".into(),
        turn_id: "turn".into(),
        created_at: 1,
        name: "proof.bin".into(),
        kind: ArtifactKind::File,
        size_bytes: 3,
        mime_type: Some("application/octet-stream".into()),
        source: ArtifactSource::ToolResultProjection,
        summary: None,
    };
    let published = PublishedArtifact {
        artifact: artifact.clone(),
        payload: payload.clone(),
    };
    tape.push_entry(&Entry::Artifact {
        owner: support::owner(),
        session: "session".into(),
        run: None,
        through_sequence: None,
        record: published.clone(),
    });
    let original = tape.push_json(&json!({"id":"message","body":"Hello"}));
    let part = tape.push_json(&ImportedPart::Input {
        content: "Hello".into(),
    });
    let message = tape.push_json(&ImportedMessage {
        turn_ordinal: ImportedTurnOrdinal(0),
        original_ordinal: 0,
        media: vec![artifact.id.clone()],
        source_message_id: Some("message".into()),
        source_turn_id: Some("turn".into()),
        timestamp: Some(1),
        role: HistoricalRole::User,
        artifact_scope: ImportedArtifactScope {
            owner: support::owner(),
            session: "session".into(),
        },
        parts: vec![part],
        provider_metadata: None,
        original: original.clone(),
    });
    tape.push_entry(&Entry::Imported {
        ordinal: 0,
        message,
    });
    let fingerprint =
        tape.original_source(vec![original], content_digest(b"original media source"));
    let request = ImportedCaptureRequest {
        id: SnapshotId::new(),
        source: Source {
            adapter: "test".into(),
            session_id: "foreign-original".into(),
        },
        fingerprint,
    };
    let source = tape
        .capture(&history, request.clone(), CancellationToken::new())
        .await;
    let metadata = source
        .artifact(support::owner(), "session".into(), None, "protected".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(metadata, published);
    assert_eq!(metadata.artifact.id, "protected");
    assert_eq!(metadata.artifact.session_id, "session");
    assert_eq!(metadata.artifact.size_bytes, 3);
    assert_eq!(source.chunk(&payload, 0, 3).await.unwrap(), b"abc");
    assert!(source.chunk(&payload, u64::MAX, 1).await.is_err());
    let restored = source
        .with_artifact(
            support::owner(),
            "session".into(),
            None,
            "protected".into(),
            |metadata, reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                Ok((metadata.clone(), bytes))
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored, (artifact, b"abc".to_vec()));
    assert!(
        source
            .artifact(support::owner(), "foreign".into(), None, "protected".into())
            .await
            .unwrap()
            .is_none()
    );
    let foreign = SessionHistory::new(
        root.data_writer().unwrap(),
        support::owner(),
        "foreign".into(),
    );
    assert!(
        foreign
            .captured_imported(request.id, CancellationToken::new())
            .await
            .is_err()
    );
    let empty = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::new(),
                cut: history.capture().await.unwrap(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        empty
            .with_payload(&payload, |reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .is_err()
    );
    root.close().await.unwrap();

    let root = support::open(directory.path(), true).await;
    let history = SessionHistory::new(
        root.data_writer().unwrap(),
        support::owner(),
        "session".into(),
    );
    let (actual, source) = history
        .captured_imported(request.id, CancellationToken::new())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actual, request);
    assert_eq!(
        source
            .artifact(support::owner(), "session".into(), None, "protected".into())
            .await
            .unwrap(),
        Some(published)
    );
    assert_eq!(source.chunk(&payload, 0, 3).await.unwrap(), b"abc");
    root.close().await.unwrap();
}

use maka_event_log::{
    StoreError,
    applications::operations::{Dispatch, DispatchClaim, OperationRequest},
    root_store::{OperationStore, RootStore},
    sessions::PluginSession,
};
use maka_plugin_core::{
    composition::{Input, InstanceId},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{OperationCleanup, OperationOutcome, OperationResult},
    scope::Scope,
    storage::Namespace,
};
use std::collections::BTreeMap;
use uuid::Uuid;

async fn dispatch(root: &RootStore, target: &str) -> (OperationStore, DispatchClaim) {
    let request = OperationRequest {
        source: root
            .commit_application(
                Uuid::new_v4(),
                0,
                Input {
                    base: None,
                    ui: None,
                    instances: BTreeMap::new(),
                },
                vec![],
                vec![],
            )
            .await
            .unwrap(),
        namespace: InstanceId(vec![Uuid::new_v4()]),
        consumer: InstanceId(vec![Uuid::new_v4()]),
        export: "service".into(),
        method: "change".into(),
        contract: Contract {
            name: "changes".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "change".into(),
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
        input: json!({"target": target}),
        capture: None,
        origin: json!({"kind": "composition_test"}),
    };
    let operation = root.operation(&request.reference().unwrap()).unwrap();
    let Dispatch::New(claim) = operation.dispatch_operation(request).await.unwrap() else {
        panic!("original request must obtain one real claim");
    };
    operation.start_operation(&claim).unwrap();
    (operation, claim)
}

fn origin(target: &str, claim: &DispatchClaim, authority: Option<&str>) -> PluginSession {
    PluginSession {
        session_id: target.into(),
        creator: Namespace::new("test", Scope::Profile).unwrap(),
        fingerprint: claim.reference().fingerprint.clone(),
        managed: false,
        authority_session_id: authority.map(Into::into),
    }
}

fn historical_spec(
    session: &str,
    source: &maka_agent_state::session_history::snapshot::Snapshot,
    run: Option<RunId>,
) -> (RunSpec, Vec<ContentBlob>) {
    let (mut spec, mut contents) = support::spec(session, "history-source", "");
    let old_input = spec.input.clone();
    contents.retain(|blob| blob.reference() != &old_input);
    let input = ContentBlob::json(&maka_agent_facts::input::RunInput::HistorySource {
        source: source.reference().clone(),
    })
    .unwrap();
    spec.input = input.reference().clone();
    contents.push(input);
    spec.origin = match run {
        Some(source_run) => RunOrigin::Forked {
            source_run,
            source: source.reference().clone(),
        },
        None => RunOrigin::Imported {
            source: source.reference().clone(),
        },
    };
    spec.backend = BackendSpec::Historical {};
    spec.trigger = Trigger::HistorySource;
    (spec, contents)
}

#[tokio::test]
async fn actual_fork_and_empty_branch_share_metadata_lineage_and_original_returned() {
    use maka_agent_facts::session::{BranchOrigin, ForkPosition, Lineage};
    use maka_agent_state::{
        session_catalog::{ControlCommand, ControlEdit, SessionCatalog},
        session_history::snapshot::ForkSnapshotSource,
    };
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "s-source").await;
    let state = support::state(&root);
    let source_run = support::admit(&state, "s-source", "turn", "original question").await;
    support::complete(&state, source_run).await;
    let data = root.data_writer().unwrap();
    let history = SessionHistory::new(data.clone(), support::owner(), "s-source".into());
    let catalog = SessionCatalog::new(data.clone(), support::owner(), "s-".into()).unwrap();
    let binding = root
        .attach_workspace("owner", &json!({"path":"/fixture"}))
        .await
        .unwrap();
    let configuration = json!({"workspace":binding,"boundary_revision":0});
    let source_session = root.session("s-source").await.unwrap();
    for (target, position) in [
        ("s-branch", ForkPosition::End),
        ("s-empty", ForkPosition::Start),
    ] {
        let frozen = history
            .capture_fork_snapshot(
                SnapshotId::new(),
                position.clone(),
                source_session.revision_guard(&data, 1).unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let lineage = Lineage::Branch {
            origin: BranchOrigin {
                parent_session_id: "s-source".into(),
                position,
            },
        };
        let control = catalog.control_statement(
            target.into(),
            ControlCommand {
                id: FactId::new(),
                at: UnixMillis(2),
                expected_revision: 0,
                edit: ControlEdit::EstablishLineage {
                    lineage: lineage.clone(),
                    source: frozen.guard_cut().clone(),
                },
            },
        );
        let (operation, claim) = dispatch(&root, target).await;
        let creation = origin(target, &claim, Some("s-source"));
        let (planned, (metadata, change)) = match frozen.source() {
            ForkSnapshotSource::Empty => {
                let planned = catalog
                    .planned_empty(target)
                    .unwrap()
                    .with_control(&control)
                    .unwrap();
                let guarded = frozen
                    .guard(
                        &history,
                        source_session.revision_guard(&data, 1).unwrap(),
                        control,
                    )
                    .unwrap();
                (
                    planned,
                    root.prepare_plugin_session(&creation, &configuration, 2, &data, guarded)
                        .await
                        .unwrap(),
                )
            }
            ForkSnapshotSource::Canonical { run } => {
                assert_eq!(run, source_run);
                let target_history =
                    SessionHistory::new(data.clone(), support::owner(), target.into());
                let (mut spec, contents) = historical_spec(target, frozen.snapshot(), Some(run));
                spec.permission_basis.binding = maka_sandbox::workspace::BindingStamp {
                    id: binding.id,
                    permission_epoch: 0,
                };
                let adoption = frozen
                    .snapshot()
                    .adopt(
                        &target_history,
                        claim.reference().operation,
                        spec,
                        UnixMillis(2),
                        contents,
                    )
                    .unwrap();
                let planned = catalog
                    .planned_adoption(&adoption)
                    .await
                    .unwrap()
                    .with_control(&control)
                    .unwrap();
                let guarded = frozen
                    .guard(
                        &history,
                        source_session.revision_guard(&data, 1).unwrap(),
                        control.with(adoption, &data).unwrap(),
                    )
                    .unwrap();
                (
                    planned,
                    root.prepare_plugin_session(&creation, &configuration, 2, &data, guarded)
                        .await
                        .unwrap(),
                )
            }
            ForkSnapshotSource::Imported => panic!("this real source was admitted locally"),
        };
        let expected = planned.record(metadata.clone()).unwrap();
        assert_eq!(expected.control_revision, 1);
        assert_eq!(expected.lineage, Some(lineage.clone()));
        assert!(!root.session_is_available(target).await.unwrap());
        let returned = OperationResult::Success {
            value: json!({"metadata":metadata,"lineage":lineage,"controlRevision":expected.control_revision}),
        };
        let observation = change.commit(&claim, returned.clone()).await.unwrap();
        assert_eq!(
            observation.outcome,
            OperationOutcome::Returned { result: returned }
        );
        let published = catalog.record(target).await.unwrap().unwrap();
        assert_eq!(published.metadata, expected.metadata);
        assert_eq!(published.lineage, expected.lineage);
        assert_eq!(published.control_revision, 1);
        assert!(!published.status.working);
        assert!(!published.status.unknown_effects);
        if target == "s-empty" {
            assert!(published.status.latest.is_none());
            assert!(published.last_message.is_none());
            assert_eq!(
                SessionHistory::new(data.clone(), support::owner(), target.into())
                    .capture()
                    .await
                    .unwrap()
                    .through_sequence,
                0
            );
        } else {
            assert_eq!(published.status.latest.as_ref().unwrap().run, source_run);
            let marker = RunId::try_from(claim.reference().operation).unwrap();
            assert!(state.claim(marker).await.is_err());
            let target_history = SessionHistory::new(data.clone(), support::owner(), target.into());
            let adopted = target_history
                .snapshot(&target_history.capture().await.unwrap(), marker)
                .await
                .unwrap();
            assert_eq!(
                adopted.run_source(source_run).await.unwrap().run,
                source_run
            );
        }
        operation
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .unwrap();
    }
    let unknown = support::admit(
        &state,
        "s-source",
        "unknown-turn",
        "uncertain original provider",
    )
    .await;
    let step = StepId::new();
    let evidence = ContentBlob::json(&json!({"fixture":"original summary request"})).unwrap();
    let reference = evidence.reference().clone();
    let request = ContentBlob::json(&RequestSpec {
        schema_version: SCHEMA_VERSION,
        step,
        summary_repair_of: None,
        compaction_recovery: None,
        composition: maka_agent_facts::composition::RequestComposition {
            system_prompt: None,
            dynamic_context: vec![],
            tool_catalog_digest: maka_agent_facts::artifact::content_digest(b"[]"),
            tools: vec![],
            provider_options: None,
            max_output_tokens: None,
            sources: vec![],
        },
        source_capture: reference.clone(),
        source_digest: reference.digest.clone(),
        effective_source_digest: reference.digest.clone(),
        provenance: reference.clone(),
        projection: None,
        adjudications: vec![],
        steering: vec![],
        request: reference.clone(),
        protocol: "fixture".into(),
        protocol_version: 1,
        recovery_contract: reference,
        request_contents: vec![],
        accounting: maka_agent_facts::accounting::ModelEvidence {
            binding: maka_agent_facts::execution::ModelBinding {
                connection_id: "fixture".into(),
                connection_slug: "fixture".into(),
                model: "fixture".into(),
            },
            model_id: "fixture".into(),
            purpose: maka_agent_facts::context::ModelPurpose::Summary,
            quote: None,
        },
    })
    .unwrap();
    let contents = vec![evidence, request.clone()];
    let attempt = ModelAttemptId::new();
    let private_call = ModelPart::ToolCall {
        call: maka_agent_facts::model::ModelToolCall {
            id: "unknown-provider-call".into(),
            name: "search".into(),
            input: json!({"query":"original provider effect"}).into(),
            provider_options: None,
            provider_executed: true,
        },
    };
    let protocol = maka_agent_facts::context::ModelClosureProtocol {
        finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
        provider_options: None,
        response_id: None,
        model: None,
        timestamp: None,
        compaction: None,
        summary: Some(maka_agent_facts::context::SummaryResult::from_parts(
            maka_agent_facts::model::ModelFinishReason::ToolCalls,
            [&private_call],
        )),
    };
    support::append(
        &state,
        unknown,
        vec![
            Fact::StepPrepared {
                step,
                request: request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: json!({"accepted":true}),
            },
            Fact::ModelClosed {
                attempt,
                outcome: maka_agent_facts::accounting::Outcome::Unknown,
                diagnostic: None,
                usage: Default::default(),
                protocol: serde_json::to_value(&protocol).unwrap(),
            },
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: OperationCleanup::Confirmed,
            },
            Fact::Blocked {
                blocker: BlockerId::new(),
                reason: BlockerKind::ProviderEffectUnknown {
                    attempt,
                    call: "unknown-provider-call".into(),
                },
            },
            Fact::RunTerminated {
                terminal: Terminal::Cancelled,
                diagnostic: None,
            },
        ],
        contents,
    )
    .await;
    assert!(
        catalog
            .record("s-source")
            .await
            .unwrap()
            .unwrap()
            .status
            .unknown_effects
    );
    match history
        .capture_fork_snapshot(
            SnapshotId::new(),
            ForkPosition::End,
            source_session.revision_guard(&data, 1).unwrap(),
            CancellationToken::new(),
        )
        .await
    {
        Err(StoreError::InvalidTransition(reason))
            if reason == "fork source has unresolved original effects or cleanup" => {}
        Err(error) => panic!("fork rejected for the wrong original cause: {error:?}"),
        Ok(snapshot) => panic!(
            "fork unexpectedly published snapshot {} despite its unresolved original provider effect",
            snapshot.snapshot().id()
        ),
    }
    let family = root.preview_session_removal("s-source").await.unwrap();
    assert_eq!(family.remove, ["s-source"]);
    assert_eq!(family.archive, ["s-branch", "s-empty"]);
    let unknown_facts = state.history(unknown, 0, 128).await.unwrap();
    root.close().await.unwrap();
    let root = support::open(directory.path(), true).await;
    assert_eq!(
        support::state(&root)
            .history(unknown, 0, 128)
            .await
            .unwrap(),
        unknown_facts
    );
    assert!(
        SessionCatalog::new(root.data_writer().unwrap(), support::owner(), "s-".into())
            .unwrap()
            .record("s-source")
            .await
            .unwrap()
            .unwrap()
            .status
            .unknown_effects
    );
    for target in ["s-branch", "s-empty"] {
        assert!(root.session_is_available(target).await.unwrap());
    }
    root.close().await.unwrap();
}

async fn imported_history(
    root: &RootStore,
    session: &str,
) -> maka_agent_state::session_history::snapshot::Snapshot {
    use maka_agent_facts::{
        artifact::content_digest,
        history_snapshot::{
            Entry, HistoricalRole, ImportedArtifactScope, ImportedMessage, ImportedPart,
            ImportedTurnOrdinal,
        },
        import::Source,
    };
    use maka_agent_state::session_history::snapshot::ImportedCaptureRequest;
    let mut tape = support::imported::Tape::new();
    let original = tape.push_json(&json!({"id":"message","text":"Hello"}));
    let part = tape.push_json(&ImportedPart::Input {
        content: "Hello".into(),
    });
    let message = tape.push_json(&ImportedMessage {
        turn_ordinal: ImportedTurnOrdinal(0),
        original_ordinal: 0,
        media: vec![],
        source_message_id: Some("message".into()),
        source_turn_id: Some("turn".into()),
        timestamp: None,
        role: HistoricalRole::User,
        artifact_scope: ImportedArtifactScope {
            owner: support::owner(),
            session: session.into(),
        },
        parts: vec![part],
        provider_metadata: None,
        original: original.clone(),
    });
    tape.push_entry(&Entry::Imported {
        ordinal: 0,
        message,
    });
    let fingerprint =
        tape.original_source(vec![original], content_digest(b"original imported session"));
    tape.capture(
        &SessionHistory::new(
            root.data_writer().unwrap(),
            support::owner(),
            session.into(),
        ),
        ImportedCaptureRequest {
            id: SnapshotId::new(),
            source: Source {
                adapter: "test".into(),
                session_id: "foreign".into(),
            },
            fingerprint,
        },
        CancellationToken::new(),
    )
    .await
}

#[tokio::test]
async fn actual_fork_and_import_missing_binding_reject_without_metadata_or_returned_and_reopen() {
    use maka_agent_facts::session::ForkPosition;
    use maka_event_log::root_store::CreationRejection;
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "s-source").await;
    let state = support::state(&root);
    let run = support::admit(&state, "s-source", "turn", "original").await;
    support::complete(&state, run).await;
    let data = root.data_writer().unwrap();
    let history = SessionHistory::new(data.clone(), support::owner(), "s-source".into());
    let source_session = root.session("s-source").await.unwrap();
    assert!(matches!(
        history
            .capture_fork_snapshot(
                SnapshotId::new(),
                ForkPosition::End,
                source_session.revision_guard(&data, 2).unwrap(),
                CancellationToken::new()
            )
            .await,
        Err(StoreError::SessionRevisionConflict {
            expected: 2,
            actual: 1
        })
    ));
    let frozen = history
        .capture_fork_snapshot(
            SnapshotId::new(),
            ForkPosition::End,
            source_session.revision_guard(&data, 1).unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let missing = maka_sandbox::workspace::BindingRef {
        id: Uuid::new_v4(),
        permission_epoch_at_attach: 0,
        metadata_epoch_at_attach: 0,
    };
    let configuration = json!({"workspace":missing,"boundary_revision":0});
    for (target, forked) in [("s-fork", true), ("s-import", false)] {
        let (operation, claim) = dispatch(&root, target).await;
        let creation = origin(target, &claim, forked.then_some("s-source"));
        let imported;
        let source = if forked {
            frozen.snapshot()
        } else {
            imported = imported_history(&root, target).await;
            &imported
        };
        let (mut spec, contents) = historical_spec(target, source, forked.then_some(run));
        spec.permission_basis.binding = maka_sandbox::workspace::BindingStamp {
            id: missing.id,
            permission_epoch: 0,
        };
        let target_history = SessionHistory::new(data.clone(), support::owner(), target.into());
        let adoption = source
            .adopt(
                &target_history,
                claim.reference().operation,
                spec,
                UnixMillis(2),
                contents,
            )
            .unwrap();
        let result = if forked {
            let statement = frozen
                .guard(
                    &history,
                    source_session.revision_guard(&data, 1).unwrap(),
                    adoption,
                )
                .unwrap();
            root.prepare_plugin_session(&creation, &configuration, 2, &data, statement)
                .await
        } else {
            root.prepare_plugin_session(&creation, &configuration, 2, &data, adoption)
                .await
        };
        assert!(matches!(
            result,
            Err(StoreError::SessionCreationRejected(
                CreationRejection::MissingWorkspaceBinding
            ))
        ));
        assert!(
            root.get_session::<serde_json::Value>(target)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!root.session_is_available(target).await.unwrap());
        assert_eq!(target_history.capture().await.unwrap().through_sequence, 0);
        assert_eq!(
            operation
                .operation_observation()
                .await
                .unwrap()
                .unwrap()
                .outcome,
            OperationOutcome::Unresolved
        );
        operation
            .record_operation_outcome(
                &claim,
                OperationOutcome::Returned {
                    result: OperationResult::Failure {
                        diagnostic: "workspace binding does not exist".into(),
                    },
                },
            )
            .await
            .unwrap();
        operation
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .unwrap();
    }
    root.close().await.unwrap();
    let root = support::open(directory.path(), true).await;
    for target in ["s-fork", "s-import"] {
        assert!(matches!(
            root.session(target).await,
            Err(StoreError::SessionNotFound)
        ));
        assert!(
            root.get_session::<serde_json::Value>(target)
                .await
                .unwrap()
                .is_none()
        );
    }
    assert!(root.session("s-source").await.is_ok());
    root.close().await.unwrap();
}

struct PublishedMetadata(String);
impl maka_event_log::connection::Query for PublishedMetadata {
    type Output = bool;
    fn execute(self, db: &rusqlite::Connection) -> Result<bool, StoreError> {
        Ok(db.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)",
            [self.0],
            |row| row.get(0),
        )?)
    }
}

#[tokio::test]
async fn complete_import_holds_destination_binding_against_relocation() {
    use maka_event_log::projects::ProjectRegistration;
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let registration = |path: &str| ProjectRegistration {
        identity: format!("folder:{path}"),
        path: path.into(),
        name: "Project".into(),
        is_worktree: false,
    };
    let old = directory.path().join("old");
    let new = directory.path().join("new");
    let mut workspaces = Vec::new();
    for path in [&old, &new] {
        std::fs::create_dir(path).unwrap();
        workspaces.push(
            root.workspace(
                cap_std::fs::Dir::open_ambient_dir(path, cap_std::ambient_authority()).unwrap(),
            )
            .await
            .unwrap(),
        );
    }
    let fence = root.fence_workspaces(&workspaces).await.unwrap();
    let old = old.to_str().unwrap();
    let new = new.to_str().unwrap();
    let project = root
        .register_project(registration(old), true, 1)
        .await
        .unwrap();
    let binding = root
        .attach_workspace("owner", &json!({"projectId":project.id,"path":old}))
        .await
        .unwrap();
    let target = "pinned-target";
    let source = imported_history(&root, target).await;
    let data = root.data_writer().unwrap();
    let target_history = SessionHistory::new(data.clone(), support::owner(), target.into());
    let (operation, claim) = dispatch(&root, target).await;
    let creation = origin(target, &claim, None);
    let (mut spec, contents) = historical_spec(target, &source, None);
    spec.permission_basis.binding = maka_sandbox::workspace::BindingStamp {
        id: binding.id,
        permission_epoch: 0,
    };
    let adoption = source
        .adopt(
            &target_history,
            claim.reference().operation,
            spec,
            UnixMillis(2),
            contents,
        )
        .unwrap();
    let (metadata, change) = root
        .prepare_plugin_session(
            &creation,
            &json!({"workspace":binding,"boundary_revision":0}),
            2,
            &data,
            adoption,
        )
        .await
        .unwrap();
    assert!(!root.session_is_available(target).await.unwrap());
    let selected = json!({"projectId":project.id,"path":new});
    assert!(matches!(
        root.relink_project(
            &project.id,
            "owner",
            &fence,
            registration(new),
            3,
            selected.clone()
        )
        .await,
        Err(StoreError::SessionBusy)
    ));
    let returned = OperationResult::Success {
        value: serde_json::to_value(&metadata).unwrap(),
    };
    assert_eq!(
        change
            .commit(&claim, returned.clone())
            .await
            .unwrap()
            .outcome,
        OperationOutcome::Returned { result: returned }
    );
    assert!(
        data.query_barrier(PublishedMetadata(target.into()))
            .await
            .unwrap()
    );
    root.relink_project(&project.id, "owner", &fence, registration(new), 3, selected)
        .await
        .unwrap();
    assert_eq!(
        root.workspace_binding::<serde_json::Value>(binding.id)
            .await
            .unwrap()
            .unwrap()
            .permission_epoch,
        1
    );
    let marker = RunId::try_from(claim.reference().operation).unwrap();
    let adopted = target_history
        .snapshot(&target_history.capture().await.unwrap(), marker)
        .await
        .unwrap();
    let original = adopted.imported(None, 64).await.unwrap();
    assert_eq!(original.items.len(), 1);
    assert_eq!(
        original.items[0].1.source_message_id.as_deref(),
        Some("message")
    );
    operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    drop(claim);
    drop(fence);
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn artifact_retirement_pages_owned_references_and_preserves_other_owners_with_atomic_rejection()
 {
    use maka_agent_facts::artifact::{
        Artifact, ArtifactKind, ArtifactSource, content_digest, upload_artifact_id,
    };
    use maka_agent_state::{
        SessionQuiescenceGuard,
        artifacts::{ArtifactStore, SessionScope, Upload},
    };
    use maka_event_log::{
        connection::Query,
        content,
        writeback::{Prepared, Statement},
    };
    use rusqlite::{Connection, params};
    use std::sync::Arc;

    struct RetireArtifacts {
        root: Arc<RootStore>,
        artifacts: ArtifactStore,
        guard: SessionQuiescenceGuard,
        reject_after: Option<ContentRef>,
    }
    impl Statement for RetireArtifacts {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            let prepared =
                self.artifacts
                    .retire_session_in_transaction(c, &self.guard, &self.root)?;
            if let Some(reference) = self.reject_after {
                if !prepared.changed || content::read(c, &reference.digest)?.is_some() {
                    return Err(StoreError::InvalidTransition(
                        "retirement did not release the expected candidate".into(),
                    ));
                }
                return Err(StoreError::InvalidTransition(
                    "fixture rejected after actual artifact retirement".into(),
                ));
            }
            Ok(prepared)
        }
        fn committed(_: ()) {}
        fn isolated_rejection(error: &StoreError) -> bool {
            matches!(error, StoreError::InvalidTransition(_))
        }
    }

    struct RetirementPlan(ContentRef);
    impl Query for RetirementPlan {
        type Output = (Vec<String>, std::collections::BTreeSet<String>);
        fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
            let id: i64 = c.query_row(
                "SELECT id FROM contents WHERE content_sha256=?",
                [self.0.digest],
                |row| row.get(0),
            )?;
            let relations = c
                .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view')")?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<_, _>>()?;
            // Explain the full DELETE used by artifacts::session::release_candidates,
            // including the reference view and SQLite's foreign-key checks.
            let plan = c.prepare(
                "EXPLAIN QUERY PLAN DELETE FROM contents WHERE id=? AND NOT EXISTS(SELECT 1 FROM content_references r WHERE r.content_id=contents.id)",
            )?.query_map([id], |row| row.get::<_, String>(3))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((plan, relations))
        }
    }

    struct ReadArtifacts {
        scope: SessionScope,
        probes: Vec<ContentRef>,
    }
    impl Query for ReadArtifacts {
        type Output = (Vec<ContentRef>, i64, Vec<Option<Vec<u8>>>);
        fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
            let owner = serde_json::to_string(&self.scope.owner)?;
            let bodies = c.prepare_cached(
                "SELECT b.content_sha256,length(b.payload) FROM agent_session_artifact_registrations r JOIN contents b ON b.id=r.body_content_id WHERE r.session=? AND r.owner=? ORDER BY r.artifact"
            )?.query_map(params![&self.scope.session, &owner], |row| Ok(ContentRef {
                digest: row.get(0)?, bytes: u64::try_from(row.get::<_, i64>(1)?).map_err(|error| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Integer, Box::new(error)))?,
            }))?.collect::<Result<Vec<_>, _>>()?;
            let projected = c.query_row(
                "SELECT count(*) FROM agent_artifacts WHERE session=? AND owner=?",
                params![&self.scope.session, &owner],
                |row| row.get(0),
            )?;
            let bytes = self
                .probes
                .into_iter()
                .map(|reference| content::read(c, &reference.digest))
                .collect::<Result<Vec<_>, _>>()?;
            Ok((bodies, projected, bytes))
        }
    }

    async fn upload(
        artifacts: &ArtifactStore,
        scope: &SessionScope,
        logical_id: &str,
        bytes: Vec<u8>,
    ) -> maka_agent_facts::artifact::PublishedArtifact {
        let artifact = Artifact {
            id: upload_artifact_id(&scope.session, logical_id),
            session_id: scope.session.clone(),
            turn_id: "retirement".into(),
            created_at: 1,
            name: "probe.bin".into(),
            kind: ArtifactKind::File,
            size_bytes: bytes.len() as u64,
            mime_type: Some("application/octet-stream".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(content_digest(&bytes)),
        };
        artifacts
            .upload(Upload::new(
                scope.clone(),
                format!("upload-{logical_id}"),
                logical_id.into(),
                artifact,
                bytes,
            ))
            .await
            .unwrap()
    }

    let directory = tempfile::tempdir().unwrap();
    let foreign_directory = tempfile::tempdir().unwrap();
    let root = Arc::new(support::open(directory.path(), false).await);
    let foreign_root = Arc::new(support::open(foreign_directory.path(), false).await);
    support::create(&root, "retire").await;
    support::create(&root, "survivor").await;
    support::create(&foreign_root, "retire").await;
    let state = support::state(&root);
    let foreign_state = support::state(&foreign_root);
    let artifacts = state.artifacts();
    let foreign_artifacts = foreign_state.artifacts();
    let scope = SessionScope {
        owner: support::owner(),
        session: "retire".into(),
    };
    let survivor_scope = SessionScope {
        owner: support::owner(),
        session: "survivor".into(),
    };
    let foreign_owner_scope = SessionScope {
        owner: RunOwner {
            deployment: scope.owner.deployment,
            namespace: InstanceId(vec![Uuid::from_u128(99)]),
        },
        session: scope.session.clone(),
    };
    let session = root.session("retire").await.unwrap();
    let (work, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let custody = work.store().work_custody().unwrap();
    let writer = root
        .data_writer_for_work(custody.as_ref(), "retire")
        .unwrap();
    let foreign_session = foreign_root.session("retire").await.unwrap();
    let (foreign_work, foreign_effects) = foreign_session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let foreign_custody = foreign_work.store().work_custody().unwrap();
    let foreign_writer = foreign_root
        .data_writer_for_work(foreign_custody.as_ref(), "retire")
        .unwrap();
    let guard = state
        .quiescence_guard(scope.owner.clone(), scope.session.clone())
        .unwrap();
    let foreign_guard = foreign_state
        .quiescence_guard(scope.owner.clone(), scope.session.clone())
        .unwrap();
    assert!(guard.observe().await.unwrap().is_quiescent());
    assert!(foreign_guard.observe().await.unwrap().is_quiescent());

    let mut owned = Vec::new();
    for index in 0..129 {
        let bytes = format!("unique retirement payload {index:03}").into_bytes();
        let record = upload(
            &artifacts,
            &scope,
            &format!("owned-{index:03}"),
            bytes.clone(),
        )
        .await;
        owned.push((record, bytes));
    }
    // Share the first sorted candidate: the 129th row must retain a unique payload.
    owned.sort_by(|a, b| a.0.artifact.id.cmp(&b.0.artifact.id));
    let shared = upload(&artifacts, &survivor_scope, "shared", owned[0].1.clone()).await;
    assert_eq!(shared.payload, owned[0].0.payload);
    let other_owner_bytes = b"only the other owner's artifact".to_vec();
    let other_owner = upload(
        &artifacts,
        &foreign_owner_scope,
        "foreign-owner",
        other_owner_bytes.clone(),
    )
    .await;
    let own_payloads: Vec<_> = owned
        .iter()
        .map(|(record, _)| record.payload.clone())
        .collect();
    let (retirement_plan, relations) = writer
        .query(RetirementPlan(own_payloads[0].clone()))
        .await
        .unwrap();
    for index in [
        "agent_run_spec_content_refs",
        "agent_request_content_refs",
        "agent_answer_content_refs",
        "agent_fact_body_refs",
        "agent_queue_body_refs",
        "agent_artifact_registration_body_refs",
        "agent_artifact_registration_provenance_refs",
        "agent_artifact_content_refs",
        "agent_standalone_cell_body_refs",
        "agent_usage_aux_spec_content_refs",
        "agent_usage_aux_body_refs",
        "agent_session_value_content_refs",
        "agent_cell_notification_content_refs",
        "agent_snapshot_run_content_refs",
        "agent_history_content_reference_lookup",
        "agent_external_steering_content_refs",
        "agent_snapshot_import_manifest_refs",
    ] {
        assert!(
            retirement_plan
                .iter()
                .any(|detail| detail.starts_with("SEARCH ") && detail.contains(index)),
            "material retirement did not use {index}: {retirement_plan:#?}",
        );
    }
    // The reference view's joins name physical tables a/c; r and subqueries
    // iterate transient union results, not persistent reference tables.
    assert!(
        retirement_plan.iter().all(|detail| {
            let Some(scan) = detail.strip_prefix("SCAN ") else {
                return true;
            };
            let object = scan.split_whitespace().next().unwrap_or_default();
            !relations.contains(object) && !matches!(object, "a" | "c")
        }),
        "material retirement scanned a persistent relation: {retirement_plan:#?}"
    );
    let before = writer
        .query(ReadArtifacts {
            scope: scope.clone(),
            probes: own_payloads.clone(),
        })
        .await
        .unwrap();
    assert_eq!(before.0.len(), 129);
    assert_eq!(before.1, 129);
    for ((_, bytes), observed) in owned.iter().zip(&before.2) {
        assert_eq!(observed.as_ref(), Some(bytes));
    }
    let own_bodies = before.0.clone();
    let other_session_before = writer
        .query(ReadArtifacts {
            scope: survivor_scope.clone(),
            probes: vec![shared.payload.clone()],
        })
        .await
        .unwrap();
    let other_owner_before = writer
        .query(ReadArtifacts {
            scope: foreign_owner_scope.clone(),
            probes: vec![other_owner.payload.clone()],
        })
        .await
        .unwrap();

    let foreign_baseline = upload(
        &foreign_artifacts,
        &scope,
        "foreign-baseline",
        b"foreign Root correct retirement baseline".to_vec(),
    )
    .await;
    foreign_writer
        .write(RetireArtifacts {
            root: foreign_root.clone(),
            artifacts: foreign_artifacts.clone(),
            guard: foreign_guard.clone(),
            reject_after: None,
        })
        .await
        .unwrap();
    assert!(
        foreign_artifacts
            .get(scope.clone(), foreign_baseline.artifact.id)
            .await
            .unwrap()
            .is_none()
    );
    let foreign_empty = foreign_writer
        .query(ReadArtifacts {
            scope: scope.clone(),
            probes: vec![foreign_baseline.payload],
        })
        .await
        .unwrap();
    assert!(foreign_empty.0.is_empty());
    assert_eq!(foreign_empty.1, 0);
    assert_eq!(foreign_empty.2, vec![None]);
    let foreign_control_bytes = b"foreign Root must remain untouched".to_vec();
    let foreign_control = upload(
        &foreign_artifacts,
        &scope,
        "foreign-control",
        foreign_control_bytes.clone(),
    )
    .await;

    writer
        .write(RetireArtifacts {
            root: root.clone(),
            artifacts: artifacts.clone(),
            guard: guard.clone(),
            reject_after: None,
        })
        .await
        .unwrap();
    for (record, _) in &owned {
        assert!(
            artifacts
                .get(scope.clone(), record.artifact.id.clone())
                .await
                .unwrap()
                .is_none()
        );
    }
    let mut released_probes = own_payloads.clone();
    released_probes.extend(own_bodies);
    let after = writer
        .query(ReadArtifacts {
            scope: scope.clone(),
            probes: released_probes,
        })
        .await
        .unwrap();
    assert!(after.0.is_empty());
    assert_eq!(after.1, 0);
    assert_eq!(after.2[0].as_ref(), Some(&owned[0].1));
    assert!(after.2[1..].iter().all(Option::is_none));
    assert_eq!(
        artifacts
            .get(survivor_scope.clone(), shared.artifact.id.clone())
            .await
            .unwrap(),
        Some(shared.clone())
    );
    assert_eq!(
        artifacts
            .get(foreign_owner_scope.clone(), other_owner.artifact.id.clone())
            .await
            .unwrap(),
        Some(other_owner.clone())
    );
    assert_eq!(
        writer
            .query(ReadArtifacts {
                scope: survivor_scope.clone(),
                probes: vec![shared.payload.clone()]
            })
            .await
            .unwrap(),
        other_session_before
    );
    assert_eq!(
        writer
            .query(ReadArtifacts {
                scope: foreign_owner_scope.clone(),
                probes: vec![other_owner.payload.clone()]
            })
            .await
            .unwrap(),
        other_owner_before
    );

    for (selected_root, selected_artifacts, selected_guard, selected_writer, reason) in [
        (
            root.clone(),
            foreign_artifacts.clone(),
            guard.clone(),
            writer.clone(),
            "artifact retirement belongs to another Root owner",
        ),
        (
            root.clone(),
            artifacts.clone(),
            foreign_guard.clone(),
            writer.clone(),
            "artifact retirement belongs to another Root owner",
        ),
        (
            foreign_root.clone(),
            artifacts.clone(),
            guard.clone(),
            writer.clone(),
            "foreign Root data writer",
        ),
        (
            root.clone(),
            artifacts.clone(),
            guard.clone(),
            foreign_writer.clone(),
            "foreign physical Root writer",
        ),
    ] {
        let rejected = selected_writer
            .write(RetireArtifacts {
                root: selected_root,
                artifacts: selected_artifacts,
                guard: selected_guard,
                reject_after: None,
            })
            .await;
        assert!(matches!(rejected, Err(StoreError::InvalidTransition(actual)) if actual == reason));
    }
    assert_eq!(
        foreign_artifacts
            .get(scope.clone(), foreign_control.artifact.id.clone())
            .await
            .unwrap(),
        Some(foreign_control.clone())
    );
    assert_eq!(
        foreign_writer
            .query(ReadArtifacts {
                scope: scope.clone(),
                probes: vec![foreign_control.payload]
            })
            .await
            .unwrap()
            .2,
        vec![Some(foreign_control_bytes)]
    );
    assert_eq!(
        writer
            .query(ReadArtifacts {
                scope: survivor_scope.clone(),
                probes: vec![shared.payload.clone()]
            })
            .await
            .unwrap(),
        other_session_before
    );
    assert_eq!(
        writer
            .query(ReadArtifacts {
                scope: foreign_owner_scope.clone(),
                probes: vec![other_owner.payload.clone()]
            })
            .await
            .unwrap(),
        other_owner_before
    );

    let rollback_bytes = b"retirement and candidate release must roll back together".to_vec();
    let rollback = upload(&artifacts, &scope, "rollback", rollback_bytes.clone()).await;
    let rollback_before = writer
        .query(ReadArtifacts {
            scope: scope.clone(),
            probes: vec![rollback.payload.clone()],
        })
        .await
        .unwrap();
    assert_eq!(rollback_before.0.len(), 1);
    assert_eq!(rollback_before.1, 1);
    assert_eq!(rollback_before.2, vec![Some(rollback_bytes.clone())]);
    let mut rollback_probes = vec![rollback.payload.clone()];
    rollback_probes.extend(rollback_before.0.clone());
    let rollback_content_before = writer
        .query(ReadArtifacts {
            scope: scope.clone(),
            probes: rollback_probes.clone(),
        })
        .await
        .unwrap();
    let rejected = writer
        .write(RetireArtifacts {
            root: root.clone(),
            artifacts: artifacts.clone(),
            guard,
            reject_after: Some(rollback.payload.clone()),
        })
        .await;
    assert!(
        matches!(rejected, Err(StoreError::InvalidTransition(reason)) if reason == "fixture rejected after actual artifact retirement")
    );
    assert_eq!(
        artifacts
            .get(scope.clone(), rollback.artifact.id.clone())
            .await
            .unwrap(),
        Some(rollback.clone())
    );
    assert_eq!(
        writer
            .query(ReadArtifacts {
                scope,
                probes: rollback_probes
            })
            .await
            .unwrap(),
        rollback_content_before
    );
    assert_eq!(
        writer
            .query(ReadArtifacts {
                scope: survivor_scope,
                probes: vec![shared.payload]
            })
            .await
            .unwrap(),
        other_session_before
    );
    assert_eq!(
        writer
            .query(ReadArtifacts {
                scope: foreign_owner_scope,
                probes: vec![other_owner.payload]
            })
            .await
            .unwrap(),
        other_owner_before
    );

    effects.settle().await.unwrap();
    foreign_effects.settle().await.unwrap();
    work.finish();
    foreign_work.finish();
    drop(custody);
    drop(foreign_custody);
    drop(writer);
    drop(foreign_writer);
    root.shutdown().await.unwrap();
    foreign_root.shutdown().await.unwrap();
}

#[tokio::test]
async fn ordinary_completion_requires_original_tool_cleanup_but_failure_preserves_pending_custody()
{
    use maka_agent_facts::{
        accounting::Outcome,
        model::{ModelToolCall, ToolInput},
        tools::ToolSemantics,
    };
    use maka_agent_state::{Change, Head, SessionObligation, SessionQuiescence};
    use maka_plugin_core::operation::{OperationReply, Receipt};

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let state = support::state(&root);
    for terminal in [Terminal::Completed, Terminal::Failed, Terminal::Cancelled] {
        let session = match terminal {
            Terminal::Completed => "tool-completed",
            Terminal::Failed => "tool-failed",
            Terminal::Cancelled => "tool-cancelled",
        };
        support::create(&root, session).await;
        let run = support::admit(
            &state,
            session,
            "original-turn",
            "change the original target",
        )
        .await;

        let driver = state.claim(run).await.unwrap();
        let view = state.frontier(run).await.unwrap();
        let (step, request, mut contents) = support::request(vec![]);
        let input = ContentBlob::json(&json!({"target":session})).unwrap();
        contents.push(input.clone());
        let attempt = ModelAttemptId::new();
        let tool = ToolKey {
            attempt,
            call: "original-change".into(),
        };
        let changes: Vec<_> = vec![
            Fact::StepPrepared {
                step,
                request: request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: json!({"original":true}),
            },
            Fact::ModelObserved {
                attempt,
                index: 0,
                part: ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: tool.call.clone(),
                        name: "change".into(),
                        input: ToolInput::Json(json!({"target":session})),
                        provider_executed: false,
                        provider_options: None,
                    },
                },
                continuation: None,
            },
            Fact::ModelClosed {
                attempt,
                outcome: Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: json!({}),
            },
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: OperationCleanup::Confirmed,
            },
            Fact::ToolDecided {
                tool: tool.clone(),
                decision: ToolDecision::Approved {
                    input: input.reference().clone(),
                    resources: vec![],
                    approval: None,
                    display: ToolDisplay::default(),
                    semantics: ToolSemantics::Parallel,
                },
            },
            Fact::ToolAdmitted { tool: tool.clone() },
        ]
        .into_iter()
        .map(|fact| Change::new(fact, UnixMillis(2)))
        .collect();
        state
            .append(&driver, (&view).into(), changes, contents)
            .await
            .unwrap();

        let (operation, original_claim) = dispatch(&root, session).await;
        let reference = original_claim.reference().clone();
        let value = json!({"changed":session,"originalOperation":reference.operation});
        let outcome = OperationOutcome::Returned {
            result: OperationResult::Success {
                value: value.clone(),
            },
        };
        let recorded = operation
            .record_operation_outcome(&original_claim, outcome.clone())
            .await
            .unwrap();
        let returned = operation.operation_observation().await.unwrap().unwrap();
        assert_eq!(returned, recorded);
        assert_eq!(returned.reference, reference);
        assert_eq!(returned.outcome, outcome);
        assert_eq!(returned.cleanup, OperationCleanup::Unconfirmed);
        let returned_bytes = serde_json::to_vec(&returned).unwrap();
        let outcome_bytes = serde_json::to_vec(&returned.outcome).unwrap();
        let reply = OperationReply {
            reference: returned.reference.clone(),
            receipt: Receipt::Recorded {
                outcome: returned.outcome.clone(),
                cleanup: returned.cleanup.clone(),
            },
        };

        let result = ContentBlob::json(&value).unwrap();
        let accepted = Change::new(
            Fact::ToolResultAccepted {
                tool: tool.clone(),
                result: result.reference().clone(),
                outcome: AcceptedResult::Succeeded,
            },
            UnixMillis(2),
        );
        let admitted = state.frontier(run).await.unwrap();
        state
            .append(
                &driver,
                (&admitted).into(),
                vec![
                    Change::new(
                        Fact::ToolOriginalBound {
                            tool: tool.clone(),
                            reference: reference.clone(),
                        },
                        UnixMillis(2),
                    ),
                    Change::new(
                        Fact::OperationObserved {
                            tool: tool.clone(),
                            reply: reply.clone(),
                        },
                        UnixMillis(2),
                    ),
                    accepted.clone(),
                ],
                vec![result.clone()],
            )
            .await
            .unwrap();
        let before = state.frontier(run).await.unwrap();
        assert!(!before.finish_requested());
        assert!(before.cells.is_empty());
        assert!(before.attempts[&attempt].closed.is_some());
        assert_eq!(
            before.attempts[&attempt].cleanup,
            OperationCleanup::Confirmed
        );
        assert_eq!(before.tools.len(), 1);
        let original_tool = before.tools.values().next().unwrap();
        assert_eq!(original_tool.key, tool);
        assert_eq!(original_tool.original.as_ref(), Some(&reference));
        assert_eq!(original_tool.receipt.as_ref(), Some(&reply.receipt));
        assert!(matches!(original_tool.accepted.as_ref(), Some(acceptance)
            if acceptance.outcome == AcceptedResult::Succeeded && acceptance.result == *result.reference()));
        let accepted_fact = state.fact(run, accepted.id).await.unwrap().unwrap();
        let terminal_change = Change::new(
            Fact::RunTerminated {
                terminal: terminal.clone(),
                diagnostic: None,
            },
            UnixMillis(3),
        );
        let rejected_history = state.history(run, 0, 128).await.unwrap();
        let mut original_terminal = None;
        if terminal == Terminal::Completed {
            let rejected = state
                .append(
                    &driver,
                    (&before).into(),
                    vec![terminal_change.clone()],
                    vec![],
                )
                .await;
            assert!(
                matches!(rejected, Err(StoreError::InvalidTransition(reason))
                if reason == "successful completion requires actual original tool cleanup acknowledgements")
            );
            assert_eq!(
                Head::from(&state.frontier(run).await.unwrap()),
                Head::from(&before)
            );
            assert_eq!(state.history(run, 0, 128).await.unwrap(), rejected_history);
            assert!(state.fact(run, terminal_change.id).await.unwrap().is_none());
        } else {
            state
                .append(
                    &driver,
                    (&before).into(),
                    vec![terminal_change.clone()],
                    vec![],
                )
                .await
                .unwrap();
            original_terminal = state.fact(run, terminal_change.id).await.unwrap();
            assert!(original_terminal.is_some());
            assert_eq!(
                state.frontier(run).await.unwrap().terminal,
                Some(terminal.clone())
            );
            assert_eq!(
                state
                    .session_quiescence(support::owner(), session.into())
                    .await
                    .unwrap(),
                SessionQuiescence::Busy(SessionObligation::Tool)
            );
        }
        let unchanged = operation.operation_observation().await.unwrap().unwrap();
        assert_eq!(unchanged, returned);
        assert_eq!(serde_json::to_vec(&unchanged).unwrap(), returned_bytes);
        assert_eq!(
            state.fact(run, accepted.id).await.unwrap(),
            Some(accepted_fact.clone())
        );

        let cleanup = operation
            .record_operation_cleanup(&original_claim, OperationCleanup::Confirmed)
            .await
            .unwrap();
        let observed = operation.operation_observation().await.unwrap().unwrap();
        assert_eq!(observed, cleanup);
        assert_eq!(observed.reference, reference);
        assert_eq!(observed.outcome, returned.outcome);
        assert_eq!(
            serde_json::to_vec(&observed.outcome).unwrap(),
            outcome_bytes
        );
        assert_eq!(observed.cleanup, OperationCleanup::Confirmed);
        let cleaned_reply = OperationReply {
            reference: observed.reference,
            receipt: Receipt::Recorded {
                outcome: observed.outcome,
                cleanup: observed.cleanup,
            },
        };
        state
            .observe(
                run,
                vec![Change::new(
                    Fact::OperationObserved {
                        tool: tool.clone(),
                        reply: cleaned_reply.clone(),
                    },
                    UnixMillis(4),
                )],
                vec![],
            )
            .await
            .unwrap();
        if terminal == Terminal::Completed {
            let fresh = state.frontier(run).await.unwrap();
            state
                .append(
                    &driver,
                    (&fresh).into(),
                    vec![terminal_change.clone()],
                    vec![],
                )
                .await
                .unwrap();
        } else {
            assert_eq!(
                state.fact(run, terminal_change.id).await.unwrap(),
                original_terminal
            );
        }
        let terminal_fact = state.fact(run, terminal_change.id).await.unwrap().unwrap();
        assert_eq!(terminal_fact.id, terminal_change.id);
        assert_eq!(terminal_fact.at, terminal_change.at);
        assert_eq!(terminal_fact.fact, terminal_change.fact);
        assert_eq!(state.frontier(run).await.unwrap().terminal, Some(terminal));
        assert_eq!(
            state.fact(run, accepted.id).await.unwrap(),
            Some(accepted_fact)
        );
        assert_eq!(
            state
                .content(run, result.reference().clone())
                .await
                .unwrap(),
            serde_json::to_vec(&value).unwrap()
        );
        let facts = state.history(run, 0, 128).await.unwrap();
        let replies: Vec<_> = facts
            .iter()
            .filter_map(|recorded| match &recorded.fact {
                Fact::OperationObserved {
                    tool: actual,
                    reply,
                } if actual == &tool => Some(reply.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(replies, vec![reply, cleaned_reply]);
        assert!(
            state
                .session_quiescence(support::owner(), session.into())
                .await
                .unwrap()
                .is_quiescent()
        );
    }
    root.close().await.unwrap();
}

#[tokio::test]
async fn canonical_input_and_attachment_bytes_survive_source_retirement_in_branch_and_nested_branch()
 {
    use maka_agent_facts::{
        artifact::{
            Artifact, ArtifactKind, ArtifactSource, PublishedArtifact, content_digest,
            upload_artifact_id,
        },
        attachment::{AttachmentKind, AttachmentRef, StorageRef},
        input::{DeliveredMessage, MessageInput, RunInput},
        message::{MessageDisposition, Placement, RootSourceMessage},
        session::{BranchOrigin, ForkPosition, Lineage},
    };
    use maka_agent_state::{
        Admission, SessionQuiescenceGuard,
        artifacts::{ArtifactStore, SessionScope, Upload},
        session_catalog::{ControlCommand, ControlEdit, SessionCatalog},
        session_history::{
            snapshot::Snapshot,
            source_tree::{HistoryDataSource, SourceTree},
        },
    };
    use maka_event_log::{
        sessions::SessionRetirement,
        writeback::{Prepared, Statement},
    };
    use rusqlite::Connection;
    use std::sync::Arc;

    struct RetireInputArtifacts {
        root: Arc<RootStore>,
        artifacts: ArtifactStore,
        guard: SessionQuiescenceGuard,
    }
    impl Statement for RetireInputArtifacts {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            self.artifacts
                .retire_session_in_transaction(c, &self.guard, &self.root)
        }
        fn committed(_: ()) {}
        fn isolated_rejection(error: &StoreError) -> bool {
            matches!(error, StoreError::InvalidTransition(_))
        }
    }
    async fn read_original(
        snapshot: &Snapshot,
        target: &str,
        run: RunId,
        input: &ContentRef,
        input_bytes: &[u8],
        artifact: &PublishedArtifact,
        payload: &[u8],
    ) -> (Vec<RunId>, SnapshotId) {
        let tree = SourceTree::snapshot(snapshot).await.unwrap();
        let (path, section) = tree.sources().next().unwrap();
        let HistoryDataSource::Snapshot(section) = section else {
            panic!("actual snapshot leaf required")
        };
        let path = path.to_vec();
        let leaf_id = section.id();
        let selected = tree.source_for_path(&path, Some(leaf_id)).await.unwrap();
        let HistoryDataSource::Snapshot(leaf) = selected else {
            panic!("qualified snapshot leaf required")
        };
        assert_eq!(leaf.reference(), section.reference());
        let original = leaf.run_source(run).await.unwrap();
        assert_eq!(original.spec.session_id, "s-source");
        assert_eq!(&original.spec.input, input);
        let bytes = leaf
            .with_content(run, input, |reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .unwrap();
        assert_eq!(bytes, input_bytes);
        let decoded: RunInput = serde_json::from_slice(&bytes).unwrap();
        let RunInput::Message {
            content,
            source_messages,
            ..
        } = decoded
        else {
            panic!("original message input required")
        };
        assert_eq!(content.attachments.as_ref().unwrap().len(), 1);
        assert_eq!(content, source_messages[0].unprepared_content);
        assert_eq!(
            source_messages[0].message.submitted_content_digest,
            content.content_digest().unwrap()
        );
        assert_eq!(
            leaf.artifact(
                support::owner(),
                "s-source".into(),
                Some(run),
                artifact.artifact.id.clone()
            )
            .await
            .unwrap(),
            Some(artifact.clone())
        );
        assert!(
            leaf.artifact(
                support::owner(),
                target.into(),
                Some(run),
                artifact.artifact.id.clone()
            )
            .await
            .unwrap()
            .is_none()
        );
        let mut offset = 0;
        let mut pages = 0;
        while offset < payload.len() {
            let bytes = leaf
                .chunk(&artifact.payload, offset as u64, 64 * 1024)
                .await
                .unwrap();
            let end = (offset + 64 * 1024).min(payload.len());
            assert_eq!(bytes, payload[offset..end]);
            offset = end;
            pages += 1;
        }
        assert_eq!(pages, 4);
        (path, leaf_id)
    }

    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(support::open(directory.path(), false).await);
    let binding = root
        .attach_workspace("owner", &json!({"path":"/fixture"}))
        .await
        .unwrap();
    let configuration = json!({"workspace":binding,"boundary_revision":0});
    root.create_session("s-source", "create-source", &configuration, 1)
        .await
        .unwrap();
    let state = support::state(&root);
    let data = root.data_writer().unwrap();
    let artifacts = state.artifacts();
    let scope = SessionScope {
        owner: support::owner(),
        session: "s-source".into(),
    };
    let payload: Vec<u8> = (0..3 * 64 * 1024 + 17)
        .map(|index| (index % 251) as u8)
        .collect();
    let record = Artifact {
        id: upload_artifact_id("s-source", "input-file"),
        session_id: "s-source".into(),
        turn_id: "source-turn".into(),
        created_at: 1,
        name: "original.bin".into(),
        kind: ArtifactKind::File,
        size_bytes: payload.len() as u64,
        mime_type: Some("application/octet-stream".into()),
        source: ArtifactSource::UserUpload,
        summary: Some(content_digest(&payload)),
    };
    let published = artifacts
        .upload(Upload::new(
            scope.clone(),
            "upload-input".into(),
            "input-file".into(),
            record,
            payload.clone(),
        ))
        .await
        .unwrap();
    let mut content = MessageInput::from("original input 中\0tail");
    content.attachments = Some(vec![AttachmentRef {
        kind: AttachmentKind::Other,
        name: published.artifact.name.clone(),
        mime_type: "application/octet-stream".into(),
        bytes: payload.len() as u64,
        storage_ref: StorageRef::SessionFile {
            session_id: "s-source".into(),
            relative_path: published.artifact.id.clone(),
        },
    }]);
    let source = RootSourceMessage {
        message: DeliveredMessage {
            message_id: "source-message".into(),
            content: content.clone(),
            origin: None,
            submitted_content_digest: content.content_digest().unwrap(),
        },
        unprepared_content: content.clone(),
        submitted_placement: Placement::CurrentTurn,
        disposition: MessageDisposition::TurnStarted,
        submitted_intent: None,
    };
    let original_input = RunInput::Message {
        content,
        request_fingerprint: None,
        source_messages: vec![source],
    };
    let input = ContentBlob::json(&original_input).unwrap();
    let input_bytes = serde_json::to_vec(&original_input).unwrap();
    let (mut spec, mut contents) = support::spec("s-source", "source-turn", "");
    let old_input = spec.input.clone();
    contents.retain(|blob| blob.reference() != &old_input);
    spec.input = input.reference().clone();
    spec.permission_basis.binding.id = binding.id;
    spec.trigger = Trigger::Message {
        message_id: "source-message".into(),
    };
    contents.push(input.clone());
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let source_run = admission.run();
    state.admit(admission).await.unwrap();
    support::complete(&state, source_run).await;
    let source_facts = state.history(source_run, 0, 32).await.unwrap();
    let catalog = SessionCatalog::new(data.clone(), support::owner(), "s-".into()).unwrap();
    let mut saved = Vec::new();
    for (parent, target) in [("s-source", "s-branch"), ("s-branch", "s-nested")] {
        let history = SessionHistory::new(data.clone(), support::owner(), parent.into());
        let parent_record = root
            .get_session::<serde_json::Value>(parent)
            .await
            .unwrap()
            .unwrap();
        let selected = root.session(parent).await.unwrap();
        let frozen = history
            .capture_fork_snapshot(
                SnapshotId::new(),
                ForkPosition::End,
                selected
                    .revision_guard(&data, parent_record.revision)
                    .unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let lineage = Lineage::Branch {
            origin: BranchOrigin {
                parent_session_id: parent.into(),
                position: ForkPosition::End,
            },
        };
        let control = catalog.control_statement(
            target.into(),
            ControlCommand {
                id: FactId::new(),
                at: UnixMillis(2),
                expected_revision: 0,
                edit: ControlEdit::EstablishLineage {
                    lineage: lineage.clone(),
                    source: frozen.guard_cut().clone(),
                },
            },
        );
        let (operation, claim) = dispatch(&root, target).await;
        let reference = claim.reference().clone();
        let from_run = match frozen.source() {
            maka_agent_state::session_history::snapshot::ForkSnapshotSource::Canonical { run } => {
                Some(run)
            }
            maka_agent_state::session_history::snapshot::ForkSnapshotSource::Imported => None,
            _ => panic!("nonempty actual parent required"),
        };
        let target_history = SessionHistory::new(data.clone(), support::owner(), target.into());
        let (mut spec, contents) = historical_spec(target, frozen.snapshot(), from_run);
        spec.permission_basis.binding.id = binding.id;
        let adoption = frozen
            .snapshot()
            .adopt(
                &target_history,
                reference.operation,
                spec.clone(),
                UnixMillis(2),
                contents.clone(),
            )
            .unwrap();
        let original_adoption = serde_json::to_value(adoption.adoption().unwrap()).unwrap();
        let planned = catalog
            .planned_adoption(&adoption)
            .await
            .unwrap()
            .with_control(&control)
            .unwrap();
        let guarded = frozen
            .guard(
                &history,
                selected
                    .revision_guard(&data, parent_record.revision)
                    .unwrap(),
                control.with(adoption, &data).unwrap(),
            )
            .unwrap();
        let (metadata, change) = root
            .prepare_plugin_session(
                &origin(target, &claim, Some(parent)),
                &configuration,
                2,
                &data,
                guarded,
            )
            .await
            .unwrap();
        let expected = planned.record(metadata.clone()).unwrap();
        let returned = OperationResult::Success {
            value: json!({"metadata":metadata,"lineage":lineage,"controlRevision":1}),
        };
        let observed = change.commit(&claim, returned.clone()).await.unwrap();
        assert_eq!(
            observed.outcome,
            OperationOutcome::Returned { result: returned }
        );
        assert_eq!(
            catalog.record(target).await.unwrap().unwrap().lineage,
            expected.lineage
        );
        let marker = RunId::try_from(reference.operation).unwrap();
        assert!(state.claim(marker).await.is_err());
        let cut = target_history.capture().await.unwrap();
        let adopted = target_history.snapshot(&cut, marker).await.unwrap();
        let address = read_original(
            &adopted,
            target,
            source_run,
            input.reference(),
            &input_bytes,
            &published,
            &payload,
        )
        .await;
        let marker_facts = state.history(marker, 0, 32).await.unwrap();
        assert_eq!(target_history.rebuild().await.unwrap(), cut);
        assert_eq!(state.history(marker, 0, 32).await.unwrap(), marker_facts);
        assert_eq!(target_history.capture().await.unwrap(), cut);
        let observed = operation
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .unwrap();
        saved.push((
            target,
            marker,
            cut,
            adopted.id(),
            adopted.reference().clone(),
            address,
            reference,
            observed,
            spec,
            contents,
            original_adoption,
        ));
    }
    let (_, _, _, _, _, branch_address, ..) = &saved[0];
    let (_, _, _, _, _, nested_address, ..) = &saved[1];
    assert!(nested_address.0.len() > branch_address.0.len());
    let selected = root.session("s-source").await.unwrap();
    let (work, effects) = selected
        .work_scope(Some(maka_sandbox::workspace::PermissionBasis {
            binding: maka_sandbox::workspace::BindingStamp {
                id: binding.id,
                permission_epoch: binding.permission_epoch_at_attach,
            },
            boundary_revision: binding
                .boundary_revision(
                    0,
                    maka_sandbox::workspace::BindingStamp {
                        id: binding.id,
                        permission_epoch: binding.permission_epoch_at_attach,
                    },
                )
                .unwrap(),
        }))
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let custody = work.store().work_custody().unwrap();
    let writer = root
        .data_writer_for_work(custody.as_ref(), "s-source")
        .unwrap();
    let (operation, claim) = dispatch(&root, "s-source").await;
    let removal_ref = claim.reference().clone();
    let (retirement, change) = root
        .prepare_session_removal(
            "s-source",
            1,
            &writer,
            RetireInputArtifacts {
                root: root.clone(),
                artifacts: artifacts.clone(),
                guard: state
                    .quiescence_guard(support::owner(), "s-source".into())
                    .unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(retirement, SessionRetirement::Removing);
    let removed = change
        .commit(
            &claim,
            OperationResult::Success {
                value: json!({"removed":"s-source"}),
            },
        )
        .await
        .unwrap();
    assert!(matches!(removed.outcome, OperationOutcome::Returned { .. }));
    assert!(
        root.get_session::<serde_json::Value>("s-source")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        artifacts
            .get(scope.clone(), published.artifact.id.clone())
            .await
            .unwrap()
            .is_none()
    );
    let removal_observation = operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    effects.settle().await.unwrap();
    work.finish();
    drop(writer);
    drop(custody);
    assert_eq!(
        root.finish_session_retirement("s-source").await.unwrap(),
        SessionRetirement::Removed
    );
    assert_eq!(
        state.history(source_run, 0, 32).await.unwrap(),
        source_facts
    );
    for (target, marker, cut, _, _, address, _, _, _, _, _) in &saved {
        let history = SessionHistory::new(data.clone(), support::owner(), (*target).into());
        let marker_facts = state.history(*marker, 0, 32).await.unwrap();
        assert_eq!(history.rebuild().await.unwrap(), *cut);
        assert_eq!(history.capture().await.unwrap(), *cut);
        let adopted = history.snapshot(cut, *marker).await.unwrap();
        assert_eq!(
            read_original(
                &adopted,
                target,
                source_run,
                input.reference(),
                &input_bytes,
                &published,
                &payload
            )
            .await,
            *address
        );
        let captured = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: cut.clone(),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let captured_address = read_original(
            &captured,
            target,
            source_run,
            input.reference(),
            &input_bytes,
            &published,
            &payload,
        )
        .await;
        assert_eq!(captured_address.1, address.1);
        assert_eq!(state.history(*marker, 0, 32).await.unwrap(), marker_facts);
        assert_eq!(history.capture().await.unwrap(), *cut);
    }
    root.shutdown().await.unwrap();
    drop(root);

    let root = support::open(directory.path(), true).await;
    let state = support::state(&root);
    let data = root.data_writer().unwrap();
    let catalog = SessionCatalog::new(data.clone(), support::owner(), "s-".into()).unwrap();
    assert!(
        root.get_session::<serde_json::Value>("s-source")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        state
            .artifacts()
            .get(scope, published.artifact.id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        root.operation(&removal_ref)
            .unwrap()
            .operation_observation()
            .await
            .unwrap(),
        Some(removal_observation)
    );
    for (
        target,
        marker,
        cut,
        id,
        manifest,
        address,
        reference,
        observed,
        spec,
        contents,
        adoption,
    ) in saved
    {
        assert!(catalog.record(target).await.unwrap().is_some());
        let history = SessionHistory::new(data.clone(), support::owner(), target.into());
        assert_eq!(history.capture().await.unwrap(), cut);
        let snapshot = history.snapshot(&cut, marker).await.unwrap();
        assert_eq!(snapshot.id(), id);
        assert_eq!(snapshot.reference(), &manifest);
        assert_eq!(
            read_original(
                &snapshot,
                target,
                source_run,
                input.reference(),
                &input_bytes,
                &published,
                &payload
            )
            .await,
            address
        );
        assert_eq!(
            root.operation(&reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap(),
            Some(observed)
        );
        let facts = state.history(marker, 0, 32).await.unwrap();
        assert_eq!(history.rebuild().await.unwrap(), cut);
        let captured = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: cut.clone(),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let captured_address = read_original(
            &captured,
            target,
            source_run,
            input.reference(),
            &input_bytes,
            &published,
            &payload,
        )
        .await;
        assert_eq!(captured_address.1, address.1);
        assert_eq!(state.history(marker, 0, 32).await.unwrap(), facts);
        assert_eq!(history.capture().await.unwrap(), cut);
        let repeated = data
            .write(
                snapshot
                    .adopt(&history, reference.operation, spec, UnixMillis(2), contents)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(repeated).unwrap(), adoption);
        assert_eq!(state.history(marker, 0, 32).await.unwrap(), facts);
        assert_eq!(history.capture().await.unwrap(), cut);
        assert!(state.claim(marker).await.is_err());
    }
    root.close().await.unwrap();
}

#[tokio::test]
async fn actual_fork_sql_failure_rolls_back_metadata_adoption_control_and_original_return() {
    use maka_agent_facts::session::{BranchOrigin, ForkPosition, Lineage};
    use maka_agent_state::session_catalog::{ControlCommand, ControlEdit, SessionCatalog};
    use maka_event_log::{
        connection::Query,
        writeback::{Notification, Prepared, Statement},
    };
    use rusqlite::Connection;

    struct PrefixFault {
        target: String,
        marker: RunId,
        enabled: bool,
    }
    impl Statement for PrefixFault {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            c.execute_batch("DROP TRIGGER IF EXISTS fixture_fork_control_failure;")?;
            if self.enabled {
                let target = self.target.replace('\'', "''");
                c.execute_batch(&format!("CREATE TRIGGER fixture_fork_control_failure BEFORE INSERT ON agent_catalog_events
                    WHEN NEW.session='{target}' BEGIN
                    SELECT CASE WHEN
                      EXISTS(SELECT 1 FROM session_control WHERE id='{target}')
                      AND EXISTS(SELECT 1 FROM session_creations WHERE session_id='{target}' AND ready=1 AND visible=1)
                      AND (SELECT count(*) FROM agent_history_snapshot_adoptions WHERE run='{marker}')=1
                      AND (SELECT count(*) FROM agent_facts WHERE run='{marker}')=2
                      AND EXISTS(SELECT 1 FROM agent_session_history WHERE session='{target}' AND run='{marker}')
                    THEN RAISE(ABORT,'actual fork prefix executed before control failure')
                    ELSE RAISE(ABORT,'fork fixture did not reach the actual prefix') END; END;", marker=self.marker))?;
            }
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    struct ForkRows {
        target: String,
        marker: RunId,
    }
    impl Query for ForkRows {
        type Output = Vec<i64>;
        fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
            let mut rows = Vec::new();
            for sql in [
                "SELECT count(*) FROM session_control WHERE id=?1",
                "SELECT count(*) FROM session_creations WHERE session_id=?1",
                "SELECT count(*) FROM agent_run_specs WHERE session=?1",
                "SELECT count(*) FROM agent_catalog_events WHERE session=?1",
                "SELECT count(*) FROM agent_session_history WHERE session=?1",
            ] {
                rows.push(c.query_row(sql, [&self.target], |row| row.get(0))?);
            }
            rows.push(c.query_row(
                "SELECT count(*) FROM agent_history_snapshot_adoptions WHERE run=?",
                [self.marker.to_string()],
                |row| row.get(0),
            )?);
            rows.push(c.query_row(
                "SELECT count(*) FROM agent_facts WHERE run=?",
                [self.marker.to_string()],
                |row| row.get(0),
            )?);
            rows.push(c.query_row(
                "SELECT count(*) FROM agent_catalog_controls WHERE session=?",
                [&self.target],
                |row| row.get(0),
            )?);
            Ok(rows)
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "s-source").await;
    let state = support::state(&root);
    let source_run =
        support::admit(&state, "s-source", "source-turn", "original source bytes").await;
    support::complete(&state, source_run).await;
    let source_facts = state.history(source_run, 0, 32).await.unwrap();
    let source_input = state.frontier(source_run).await.unwrap().spec.input;
    let source_bytes = state
        .content(source_run, source_input.clone())
        .await
        .unwrap();
    let data = root.data_writer().unwrap();
    let history = SessionHistory::new(data.clone(), support::owner(), "s-source".into());
    let source_cut = history.capture().await.unwrap();
    let source_session = root.session("s-source").await.unwrap();
    let frozen = history
        .capture_fork_snapshot(
            SnapshotId::new(),
            ForkPosition::End,
            source_session.revision_guard(&data, 1).unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let frozen_manifest = frozen.snapshot().manifest().await.unwrap();
    let frozen_reference = frozen.snapshot().reference().clone();
    let catalog = SessionCatalog::new(data.clone(), support::owner(), "s-".into()).unwrap();
    let binding = root
        .attach_workspace("owner", &json!({"path":"/fixture"}))
        .await
        .unwrap();
    let configuration = json!({"workspace":binding,"boundary_revision":0});
    let mut saved = Vec::new();
    for (target, retry_live) in [("s-live-fault", true), ("s-cold-fault", false)] {
        let request = OperationRequest {
            source: root
                .commit_application(
                    Uuid::new_v4(),
                    0,
                    Input {
                        base: None,
                        ui: None,
                        instances: BTreeMap::new(),
                    },
                    vec![],
                    vec![],
                )
                .await
                .unwrap(),
            namespace: InstanceId(vec![Uuid::new_v4()]),
            consumer: InstanceId(vec![Uuid::new_v4()]),
            export: "service".into(),
            method: "change".into(),
            contract: Contract {
                name: "changes".into(),
                version: 1,
                transport: Transport::Local,
                interface: Interface::Service {
                    methods: BTreeMap::from([(
                        "change".into(),
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
            input: json!({"target":target}),
            capture: None,
            origin: json!({"kind":"composition_test"}),
        };
        let reference = request.reference().unwrap();
        let operation = root.operation(&reference).unwrap();
        let Dispatch::New(claim) = operation.dispatch_operation(request.clone()).await.unwrap()
        else {
            panic!("one original dispatch required")
        };
        operation.start_operation(&claim).unwrap();
        let marker = RunId::try_from(reference.operation).unwrap();
        let creation = origin(target, &claim, Some("s-source"));
        let target_history = SessionHistory::new(data.clone(), support::owner(), target.into());
        let lineage = Lineage::Branch {
            origin: BranchOrigin {
                parent_session_id: "s-source".into(),
                position: ForkPosition::End,
            },
        };
        let command = ControlCommand {
            id: FactId::new(),
            at: UnixMillis(2),
            expected_revision: 0,
            edit: ControlEdit::EstablishLineage {
                lineage: lineage.clone(),
                source: frozen.guard_cut().clone(),
            },
        };
        let (mut spec, contents) = historical_spec(target, frozen.snapshot(), Some(source_run));
        spec.permission_basis.binding.id = binding.id;
        let original = frozen
            .snapshot()
            .adopt(
                &target_history,
                reference.operation,
                spec.clone(),
                UnixMillis(2),
                contents.clone(),
            )
            .unwrap()
            .adoption()
            .unwrap();
        data.write(PrefixFault {
            target: target.into(),
            marker,
            enabled: true,
        })
        .await
        .unwrap();
        let control = catalog.control_statement(target.into(), command.clone());
        let adoption = frozen
            .snapshot()
            .adopt(
                &target_history,
                reference.operation,
                spec.clone(),
                UnixMillis(2),
                contents.clone(),
            )
            .unwrap();
        let guarded = frozen
            .guard(
                &history,
                source_session.revision_guard(&data, 1).unwrap(),
                control.with(adoption, &data).unwrap(),
            )
            .unwrap();
        let (metadata, change) = root
            .prepare_plugin_session(&creation, &configuration, 2, &data, guarded)
            .await
            .unwrap();
        let returned = OperationResult::Success {
            value: json!({"metadata":metadata,"lineage":lineage,"controlRevision":1}),
        };
        let error = change.commit(&claim, returned.clone()).await.unwrap_err();
        assert!(
            matches!(error.underlying(), StoreError::Sqlite(rusqlite::Error::SqliteFailure(code, Some(message)))
            if code.extended_code == 1811 && message == "actual fork prefix executed before control failure")
        );
        assert_eq!(
            data.query(ForkRows {
                target: target.into(),
                marker
            })
            .await
            .unwrap(),
            vec![0; 8]
        );
        assert!(
            root.get_session::<serde_json::Value>(target)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!root.session_is_available(target).await.unwrap());
        assert!(catalog.record(target).await.unwrap().is_none());
        assert!(state.find_run(marker).await.unwrap().is_none());
        assert_eq!(target_history.capture().await.unwrap().through_sequence, 0);
        let unresolved = operation.operation_observation().await.unwrap().unwrap();
        assert_eq!(unresolved.reference, reference);
        assert_eq!(unresolved.outcome, OperationOutcome::Unresolved);
        assert_eq!(unresolved.cleanup, OperationCleanup::Unconfirmed);
        assert_eq!(
            state.history(source_run, 0, 32).await.unwrap(),
            source_facts
        );
        assert_eq!(
            state
                .content(source_run, source_input.clone())
                .await
                .unwrap(),
            source_bytes
        );
        assert_eq!(history.capture().await.unwrap(), source_cut);
        if retry_live {
            data.write(PrefixFault {
                target: target.into(),
                marker,
                enabled: false,
            })
            .await
            .unwrap();
            let control = catalog.control_statement(target.into(), command);
            let adoption = frozen
                .snapshot()
                .adopt(
                    &target_history,
                    reference.operation,
                    spec.clone(),
                    UnixMillis(2),
                    contents.clone(),
                )
                .unwrap();
            let guarded = frozen
                .guard(
                    &history,
                    source_session.revision_guard(&data, 1).unwrap(),
                    control.with(adoption, &data).unwrap(),
                )
                .unwrap();
            let (retried_metadata, retried) = root
                .prepare_plugin_session(&creation, &configuration, 2, &data, guarded)
                .await
                .unwrap();
            assert_eq!(retried_metadata, metadata);
            assert_eq!(
                retried
                    .commit(&claim, returned.clone())
                    .await
                    .unwrap()
                    .outcome,
                OperationOutcome::Returned { result: returned }
            );
            assert_eq!(
                catalog
                    .record(target)
                    .await
                    .unwrap()
                    .unwrap()
                    .control_revision,
                1
            );
            assert_eq!(state.history(marker, 0, 32).await.unwrap().len(), 2);
        }
        let observed = operation
            .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
            .await
            .unwrap();
        let cut = target_history.capture().await.unwrap();
        let facts = state.history(marker, 0, 32).await.unwrap();
        saved.push((
            target,
            retry_live,
            request,
            reference,
            observed,
            marker,
            cut,
            facts,
            spec,
            contents,
            serde_json::to_value(original).unwrap(),
        ));
    }
    root.close().await.unwrap();

    let root = support::open(directory.path(), true).await;
    let state = support::state(&root);
    let data = root.data_writer().unwrap();
    let catalog = SessionCatalog::new(data.clone(), support::owner(), "s-".into()).unwrap();
    for (
        target,
        retried,
        request,
        reference,
        observed,
        marker,
        cut,
        facts,
        spec,
        contents,
        original,
    ) in saved
    {
        let operation = root.operation(&reference).unwrap();
        assert_eq!(
            operation.operation_observation().await.unwrap(),
            Some(observed.clone())
        );
        let Dispatch::Existing(existing) = operation.dispatch_operation(request).await.unwrap()
        else {
            panic!("cold observation must not create a new claim")
        };
        assert_eq!(existing, observed);
        let target_history = SessionHistory::new(data.clone(), support::owner(), target.into());
        assert_eq!(target_history.capture().await.unwrap(), cut);
        assert_eq!(state.history(marker, 0, 32).await.unwrap(), facts);
        if retried {
            assert!(matches!(
                existing.outcome,
                OperationOutcome::Returned { .. }
            ));
            assert_eq!(
                catalog
                    .record(target)
                    .await
                    .unwrap()
                    .unwrap()
                    .control_revision,
                1
            );
            let snapshot = target_history.snapshot(&cut, marker).await.unwrap();
            assert_eq!(snapshot.reference(), &frozen_reference);
            assert_eq!(snapshot.manifest().await.unwrap(), frozen_manifest);
            let repeated = data
                .write(
                    snapshot
                        .adopt(
                            &target_history,
                            reference.operation,
                            spec,
                            UnixMillis(2),
                            contents,
                        )
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(serde_json::to_value(repeated).unwrap(), original);
            assert_eq!(target_history.capture().await.unwrap(), cut);
            assert_eq!(state.history(marker, 0, 32).await.unwrap(), facts);
        } else {
            assert_eq!(existing.outcome, OperationOutcome::Unresolved);
            assert_eq!(existing.cleanup, OperationCleanup::Confirmed);
            assert_eq!(
                data.query(ForkRows {
                    target: target.into(),
                    marker
                })
                .await
                .unwrap(),
                vec![0; 8]
            );
            assert!(
                root.get_session::<serde_json::Value>(target)
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(!root.session_is_available(target).await.unwrap());
            assert!(catalog.record(target).await.unwrap().is_none());
            assert!(state.find_run(marker).await.unwrap().is_none());
            assert_eq!(cut.through_sequence, 0);
        }
    }
    assert_eq!(
        state.history(source_run, 0, 32).await.unwrap(),
        source_facts
    );
    assert_eq!(
        state.content(source_run, source_input).await.unwrap(),
        source_bytes
    );
    root.close().await.unwrap();
}
