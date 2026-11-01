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
use maka_agent_facts::{
    event::{EventWrite, Invocation, InvocationInput, RuntimeEvent},
    execution::*,
    language::Language,
};
use maka_tools::{CodeExecutor, RunTools, ToolCatalog};
use serde_json::json;
use std::time::Duration;

#[derive(serde::Serialize)]
pub(crate) struct FixtureNativeBasis {
    pub accepted: &'static str,
    #[serde(skip)]
    pub materializations: Arc<std::sync::atomic::AtomicUsize>,
}
impl crate::NativeActivationBasis for FixtureNativeBasis {
    fn checkpoint_value(&self) -> serde_json::Result<serde_json::Value> {
        self.materializations
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        serde_json::to_value(self)
    }
}

pub(crate) fn settings(invocation: Invocation) -> RunSettings {
    RunSettings {
        model_source: None,
        model_revision: None,
        provider_id: "fixture".into(),
        invocation,
        context: None,
        work: (),
        request_fingerprint: None,
        provider: maka_model::ProviderConfig {
            image_input: None,
            adapter: None,
            capabilities: Default::default(),
            network: Default::default(),
            kind: maka_model::ProviderKind::OpenaiChatCompletions,
            model: "fixture".into(),
            base_url: "http://unused.invalid/v1".into(),
            auth: maka_model::ProviderAuth::ApiKey("fixture".into()),
            headers: Default::default(),
            body_overlay: None,
        },
        provider_options: serde_json::json!({}),
        native_activation_basis: None,
        main_output_limit: None,
        supports_vision: false,
        configuration: InvocationConfiguration {
            language: maka_agent_facts::language::Language::En,
            compaction_prompt: None,
            editing_tools: None,
            tool_discovery: false,
            tool_composition: None,
            system_prompt: None,
            cwd: ".".into(),
            workspace_identity: None,
            workspace_binding: None,
            workspace_origin: WorkspaceOrigin::Selected,
            sandbox_mode: SandboxMode::DangerFullAccess,
            approval_policy: ApprovalPolicy::OnRequest,
            boundary_revision: 0,
            collaboration_mode: CollaborationMode::Agent,
            orchestration_mode: BehaviorId::default(),
            tool_mode: ToolMode::Direct,
            code_language: Default::default(),
            model: None,
            thinking_level: None,
        },
    }
}

struct NoSend(Arc<std::sync::atomic::AtomicUsize>);
impl maka_agent_ports::model::ProviderAdapter for NoSend {
    fn open(
        &self,
        _: maka_agent_ports::model::Lifetime,
        _: CancellationToken,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<Arc<dyn maka_agent_ports::model::Session>, maka_agent_ports::model::Error>,
    > {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { panic!("frozen preparation must not open a provider session") })
    }
}

#[tokio::test]
async fn released_request_rehydrates_its_original_input_after_new_publication() {
    released_request_rehydration(false).await;
    released_request_rehydration(true).await;
}

async fn released_request_rehydration(with_image: bool) {
    let (_directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    let mut content: maka_agent_facts::input::MessageInput = "original input".into();
    if with_image {
        use image::ImageEncoder;
        use maka_agent_facts::artifact::{Artifact, ArtifactKind, ArtifactSource};
        let pixels = image::RgbImage::from_fn(512, 256, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 17])
        });
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(pixels.as_raw(), 512, 256, image::ExtendedColorType::Rgb8)
            .unwrap();
        let size = bytes.len();
        store
            .commit_artifact(
                Artifact {
                    id: "original-image".into(),
                    session_id: "session".into(),
                    turn_id: "upload".into(),
                    created_at: 1,
                    name: "original.png".into(),
                    kind: ArtifactKind::Image,
                    size_bytes: size as u64,
                    mime_type: Some("image/png".into()),
                    source: ArtifactSource::UserUpload,
                    summary: Some(maka_agent_facts::artifact::content_digest(&bytes)),
                },
                bytes,
            )
            .await
            .unwrap();
        content = serde_json::from_value(json!({"text":"original input", "attachments":[{"kind":"image","name":"original.png","mimeType":"image/png","bytes":size,"ref":{"kind":"session_file","sessionId":"session","relativePath":"original-image"}}]})).unwrap();
    }
    let sends = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let binding = maka_agent_ports::model::Binding::new(
        Arc::new(NoSend(sends.clone())),
        maka_agent_facts::composition::SourceRevision {
            kind: SourceKind::ModelAdapter,
            name: "fixture".into(),
            package_id: "fixture".into(),
            entry_id: "fixture".into(),
            activation: "fixture".into(),
            revision: "1".into(),
        },
    );
    let engine = crate::Engine::new(
        maka_model::ModelExecutor::new(Duration::from_secs(30))
            .unwrap()
            .with_adapters(std::collections::BTreeMap::from([(
                "fixture".into(),
                binding,
            )])),
        CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
    )
    .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let mut input = settings(invocation.clone());
    input.provider.adapter = Some("fixture".into());
    if with_image {
        input.supports_vision = true;
        input.provider.image_input = Some(maka_agent_facts::configuration::ImageInput {
            max_width: Some(128),
            max_height: Some(128),
            ..Default::default()
        });
    }
    let execution = store.execution_scope(None).await.unwrap().accept();
    let inner = RunContext::new(engine.0.clone(), execution.store().clone(), &invocation).unwrap();
    inner
        .log
        .append(
            &EventWrite::plain(RuntimeEvent::new(
                invocation.clone(),
                Fact::InvocationOpened {
                    configuration: Some(Box::new(input.configuration.clone())),
                    input: InvocationInput::Message {
                        source_messages: vec![],
                        content,
                        request_fingerprint: None,
                    },
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
    let tools = RunTools::new(
        Language::En,
        inner.log.clone(),
        invocation.clone(),
        ToolCatalog::default(),
        ToolMode::Direct,
        CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
        engine.0.loaded("session"),
    );
    let cancellation = CancellationToken::new();
    let original_tools = tools.capture(".", cancellation.clone()).await.unwrap();
    let view = Arc::new(
        inner
            .log
            .read_model_view("session", Some("invocation"))
            .await
            .unwrap(),
    );
    let capture = model_attempt::RequestSource::from(view.as_ref());
    let surface = crate::request_composition::Surface::capture(
        &original_tools,
        &inner.shared.model,
        &input,
        &view,
        None,
    )
    .unwrap();
    let mut prompt = model_attempt::prompt(
        &inner,
        &input,
        &view,
        &cancellation,
        None,
        "invocation",
        false,
        surface.system(),
        ModelPurpose::Main,
    )
    .await
    .unwrap();
    drop(view);
    let definitions = original_tools.definitions();
    model_attempt::prepare_wire(
        &input,
        &mut prompt,
        &definitions,
        surface.max_output_tokens,
        &cancellation,
    )
    .await
    .unwrap();
    let prepared = model_attempt::prepare_request(
        &input,
        prompt.clone(),
        definitions,
        surface.max_output_tokens,
        ModelPurpose::Main,
    )
    .unwrap();
    let expected = prepared.input_digest.clone();
    let event = RuntimeEvent::new(
        invocation.clone(),
        Fact::ModelRequested {
            source_capture: capture.capture,
            item_acceptance: surface.adapter.supports_item_acceptance(),
            effective_source_digest: Some(capture.effective_digest),
            purpose: ModelPurpose::Main,
            context: None,
            context_breakdown: Some(prepared.context_breakdown),
            checkpoint_event_id: capture.checkpoint,
            step_id: "original-step".into(),
            model_id: input.provider.model.clone(),
            source_scope: capture.evidence.scope,
            source_high_water: capture.evidence.high_water,
            source_digest: capture.evidence.digest,
            input_digest: prepared.input_digest,
            route_identity: prepared.route_identity,
        },
    );
    let original = event.id.clone();
    inner
        .log
        .append(
            &EventWrite::plain(event)
                .unwrap()
                .with_composition(surface.evidence())
                .unwrap(),
        )
        .await
        .unwrap();
    let replay = FrozenReplay::new(&inner, &input, original.clone(), surface.adapter.clone());
    let output_limit = surface.max_output_tokens;
    drop(prepared.request);
    drop(original_tools);
    drop(surface);
    prompt.close().await.unwrap();
    drop(prompt);
    // A different Session advances the physical publication watermark without
    // being a member of the selected request history.
    let other = crate::test_support::session(&root, "other").await;
    other
        .append(
            &EventWrite::plain(RuntimeEvent::new(
                Invocation {
                    session_id: "other".into(),
                    turn_id: "other".into(),
                    run_id: "other".into(),
                    invocation_id: "other".into(),
                },
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        source_messages: vec![],
                        content: "future publication".into(),
                        request_fingerprint: None,
                    },
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
    let mut fresh = input.clone();
    fresh.configuration.system_prompt = Some(SystemPrompt {
        text: "future system must not enter frozen input".into(),
        policy_revision: 1,
        sources: vec![],
    });
    fresh.provider_options = json!({"temperature": 0.75});
    let replayed = replay.prepared(&cancellation).await.unwrap();
    let replayed_request = model_attempt::prepare_request(
        &input,
        replayed.clone(),
        vec![],
        output_limit,
        ModelPurpose::Main,
    )
    .unwrap();
    assert_eq!(replayed_request.input_digest, expected);
    drop(replayed_request);
    replayed.close().await.unwrap();
    drop(replayed);
    let stopped = CancellationToken::new();
    stopped.cancel();
    assert!(matches!(
        replay.prepared(&stopped).await,
        Err(RunError::Cancelled)
    ));
    let rebuilt = rehydrate_frozen_request(&inner, &original, &fresh, &tools, &cancellation)
        .await
        .unwrap();
    let rebuilt_request = model_attempt::prepare_request(
        &rebuilt.input,
        rebuilt.prompt.clone(),
        rebuilt.tools.definitions(),
        rebuilt.surface.max_output_tokens,
        ModelPurpose::Main,
    )
    .unwrap();
    assert_eq!(rebuilt_request.input_digest, expected);
    assert_eq!(rebuilt.source.capture, capture.capture);
    assert_eq!(rebuilt.input.provider_options, json!({}));
    drop(rebuilt_request);
    rebuilt.prompt.close().await.unwrap();
    let mut changed_route = fresh.clone();
    changed_route.provider.base_url = "https://changed.invalid/v1".into();
    assert!(matches!(
        rehydrate_frozen_request(&inner, &original, &changed_route, &tools, &cancellation).await,
        Err(RunError::ReconciliationRequired(_))
    ));
    if with_image {
        let mut changed_image = fresh.clone();
        changed_image
            .provider
            .image_input
            .as_mut()
            .unwrap()
            .max_width = Some(64);
        assert!(matches!(
            rehydrate_frozen_request(&inner, &original, &changed_image, &tools, &cancellation)
                .await,
            Err(RunError::ReconciliationRequired(_))
        ));
    }
    assert_eq!(sends.load(std::sync::atomic::Ordering::SeqCst), 0);
    tools.shutdown().await.unwrap();
    engine.drain().await;
    execution.finish();
}

struct NeverExecuted;
impl maka_agent_facts::tools::ToolPreparer for NeverExecuted {
    fn names(&self) -> Vec<String> {
        vec!["alpha".into(), "beta".into()]
    }
    fn prepare(
        &self,
        _: String,
        _: serde_json::Value,
        _: maka_agent_facts::tools::ToolCallContext,
        _: CancellationToken,
    ) -> maka_agent_facts::tools::PreparationFuture {
        panic!("rehydration must not prepare or execute tool effects")
    }
}

struct Permission(std::sync::atomic::AtomicBool);
impl maka_tools::request::RequestBinding for Permission {
    fn bind(&self, _: maka_tools::request::BindingRequest) -> maka_tools::request::BindingFuture {
        let allowed = self.0.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if !allowed {
                return Err(maka_agent_facts::tools::ToolError::Failed(
                    "permission denied".into(),
                ));
            }
            Ok(["alpha", "beta"]
                .into_iter()
                .map(|name| {
                    (
                        name.into(),
                        maka_tools::request::BoundTool::Prepared(Arc::new(NeverExecuted)
                            as Arc<dyn maka_agent_facts::tools::ToolPreparer>),
                    )
                })
                .collect())
        })
    }
}

#[tokio::test]
async fn frozen_tools_ignore_later_loaded_names_and_require_current_permission_and_schema() {
    use maka_agent_facts::{
        composition::RequestComposition,
        tools::{ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics},
    };
    use std::{
        collections::BTreeSet,
        sync::atomic::{AtomicBool, Ordering},
    };
    let (_directory, root) = crate::test_support::root().await;
    let store = Arc::new(crate::test_support::session(&root, "session").await);
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    for mode in [ToolMode::Direct, ToolMode::CodeMode] {
        let permission = Arc::new(Permission(AtomicBool::new(true)));
        let catalog =
            ToolCatalog::new(["alpha", "beta"].into_iter().map(|name| ToolRegistration {
                definition: ToolDefinition {
                    name: name.into(),
                    description: format!("description for {name}"),
                    input_schema: json!({"type":"object"}),
                    output_schema: None,
                    provider: None,
                    freeform: None,
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Prepared(Arc::new(NeverExecuted)),
            }))
            .unwrap()
            .with_discovery()
            .with_request_binding(
                BTreeSet::from(["alpha".into(), "beta".into()]),
                permission.clone(),
            )
            .unwrap();
        let digest = catalog.digest();
        let run = RunTools::new(
            Language::En,
            store.clone(),
            invocation.clone(),
            catalog,
            mode,
            CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
            maka_tools::availability::LoadedTools::temporary().unwrap(),
        );
        run.restore(&maka_agent_facts::handoff::HandoffTools {
            catalog_digest: digest,
            loaded: BTreeSet::from(["alpha".into()]),
        })
        .unwrap();
        let original = run.capture(".", CancellationToken::new()).await.unwrap();
        let mut composition = RequestComposition {
            system_prompt: None,
            dynamic_context: vec![],
            tool_catalog_digest: original.catalog_digest().into(),
            tools: original.definitions(),
            provider_options: Some(json!({})),
            max_output_tokens: None,
            sources: vec![],
        };
        drop(original);
        let mut loaded = run.checkpoint().unwrap();
        loaded.loaded = BTreeSet::from(["beta".into()]);
        run.restore(&loaded).unwrap();
        let current = run.capture(".", CancellationToken::new()).await.unwrap();
        assert_ne!(
            current.definitions(),
            composition.tools,
            "fixture must change the advertised loaded selection"
        );
        drop(current);
        let restored = run
            .capture_frozen(".", &composition, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(restored.definitions(), composition.tools);
        drop(restored);
        let original_schema = composition.tools[0].input_schema.clone();
        Arc::make_mut(&mut composition.tools[0]).input_schema = json!({"type":"string"});
        assert!(
            run.capture_frozen(".", &composition, CancellationToken::new())
                .await
                .is_err()
        );
        Arc::make_mut(&mut composition.tools[0]).input_schema = original_schema;
        let original_digest = composition.tool_catalog_digest.clone();
        composition.tool_catalog_digest = "changed catalog".into();
        assert!(
            run.capture_frozen(".", &composition, CancellationToken::new())
                .await
                .is_err()
        );
        composition.tool_catalog_digest = original_digest;
        permission.0.store(false, Ordering::SeqCst);
        assert!(
            run.capture_frozen(".", &composition, CancellationToken::new())
                .await
                .is_err()
        );
        run.shutdown().await.unwrap();
    }
}

struct LongThrottle {
    sends: Arc<std::sync::atomic::AtomicUsize>,
    deadline: u64,
}
impl maka_agent_ports::model::ProviderAdapter for LongThrottle {
    fn open(
        &self,
        _: maka_agent_ports::model::Lifetime,
        _: CancellationToken,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<Arc<dyn maka_agent_ports::model::Session>, maka_agent_ports::model::Error>,
    > {
        let session: Arc<dyn maka_agent_ports::model::Session> = Arc::new(Self {
            sends: self.sends.clone(),
            deadline: self.deadline,
        });
        Box::pin(async move { Ok(session) })
    }
}
impl maka_agent_ports::model::Session for LongThrottle {
    fn stream(
        &self,
        _: maka_agent_ports::model::Request,
        _: maka_agent_ports::model::Context,
    ) -> futures_util::future::BoxFuture<'static, Result<(), maka_agent_ports::model::Error>> {
        self.sends.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let deadline = self.deadline;
        Box::pin(async move {
            Err(maka_model::ModelError::Provider(
                maka_model::ProviderFailure::new(
                    maka_model::ProviderFailureReason::RateLimit,
                    "five-hour throttle",
                    true,
                    Some(deadline),
                ),
            ))
        })
    }
}

#[tokio::test]
async fn long_provider_deadline_releases_physical_activation_and_early_resume_never_sends() {
    use maka_agent_facts::native_approval::ActivationSuspension;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    let sends = Arc::new(AtomicUsize::new(0));
    let deadline = maka_model::ProviderFailure::now_unix_ms()
        .checked_add(5 * 60 * 60 * 1000)
        .unwrap();
    let binding = maka_agent_ports::model::Binding::new(
        Arc::new(LongThrottle {
            sends: sends.clone(),
            deadline,
        }),
        maka_agent_facts::composition::SourceRevision {
            kind: SourceKind::ModelAdapter,
            name: "fixture".into(),
            package_id: "fixture".into(),
            entry_id: "fixture".into(),
            activation: "activation".into(),
            revision: "1".into(),
        },
    );
    let engine = crate::Engine::new(
        maka_model::ModelExecutor::new(Duration::from_secs(30))
            .unwrap()
            .with_adapters(std::collections::BTreeMap::from([(
                "fixture".into(),
                binding,
            )])),
        CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
    )
    .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let mut original = settings(invocation.clone());
    original.configuration.cwd = directory
        .path()
        .to_str()
        .expect("UTF-8 test directory")
        .to_owned();
    original.provider.adapter = Some("fixture".into());
    let materializations = Arc::new(AtomicUsize::new(0));
    original.native_activation_basis = Some(Arc::new(FixtureNativeBasis {
        accepted: "fixture",
        materializations: materializations.clone(),
    }));
    let crate::RunInput {
        model_source,
        model_revision,
        provider_id,
        invocation,
        context,
        work: (),
        request_fingerprint,
        provider,
        provider_options,
        native_activation_basis,
        main_output_limit,
        supports_vision,
        configuration,
    } = original;
    let input = crate::RunInput {
        model_source,
        model_revision,
        provider_id,
        invocation,
        context,
        request_fingerprint,
        provider,
        provider_options,
        native_activation_basis,
        main_output_limit,
        supports_vision,
        configuration,
        work: crate::RunWork::Message {
            message: "original question".into(),
            source_messages: vec![],
            tools: ToolCatalog::default(),
        },
    };
    let running = engine
        .start(store.clone(), input, CancellationToken::new())
        .await
        .unwrap();
    let completion = running.completion().await;
    assert!(
        completion.cleanup.is_ok(),
        "park requires confirmed physical cleanup"
    );
    let crate::ActivationExit::Parked(receipt) = completion.result.unwrap() else {
        panic!("long no-progress throttle must park")
    };
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    let checkpoint = store
        .activation_checkpoint("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        materializations.load(Ordering::SeqCst),
        1,
        "only the actual durable proposal materializes its Native evidence"
    );
    assert_eq!(checkpoint.receipt, receipt);
    let ActivationSuspension::ModelRetry { plan } = &checkpoint.checkpoint.suspension else {
        panic!("must retain typed retry reason")
    };
    assert_eq!(plan.not_before_unix_ms, deadline);
    assert_eq!(plan.failures, 1);
    let scope = store.execution_scope(None).await.unwrap();
    drop(scope);
    let resumed = engine
        .start_retry_resume(
            store.clone(),
            crate::RetryResumeInput {
                checkpoint: checkpoint.clone(),
                permission_basis: None,
                continuation: Box::pin(async {
                    panic!("future retry must not prepare provider or capabilities")
                }),
                owner_shutdown: CancellationToken::new(),
                host_epoch: "fresh-host".into(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let early = resumed.completion().await;
    assert!(early.cleanup.is_ok());
    assert!(matches!(early.result, Ok(crate::ActivationExit::Parked(_))));
    let unchanged = store
        .activation_checkpoint("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.checkpoint, checkpoint.checkpoint);
    assert_eq!(unchanged.receipt, checkpoint.receipt);
    assert_eq!(
        materializations.load(Ordering::SeqCst),
        1,
        "early resume retains the original immutable proposal"
    );
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    engine.drain().await;
}
