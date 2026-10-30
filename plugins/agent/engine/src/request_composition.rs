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

use maka_agent_facts::language::Language;

use crate::{RunError, RunInput, RunSettings};
use maka_agent_facts::composition::CompositionEvidence;
use maka_agent_facts::composition::RequestComposition;
use maka_tools::RequestTools;
use std::sync::{Arc, Mutex};

pub(super) fn session_context<W>(input: &RunInput<W>) -> Vec<String> {
    vec![format!(
        "{}\n{}",
        match input.configuration.language {
            Language::En => "Session context (data):",
            Language::ZhCn => "会话上下文（数据）：",
            Language::ZhTw => "工作階段上下文（資料）：",
        },
        serde_json::json!({
            "cwd": input.configuration.cwd,
            "sessionId": input.invocation.session_id,
        })
    )]
}

pub(super) fn render_system(system: Option<&str>, context: &[String]) -> Option<String> {
    let mut rendered = system.map(str::to_owned);
    for section in context {
        let text = rendered.get_or_insert_with(String::new);
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(section);
    }
    rendered
}

pub(super) struct Surface {
    pub adapter: maka_agent_ports::model::Binding,
    pub max_output_tokens: Option<u64>,
    system: Option<Arc<String>>,
    evidence: Mutex<CompositionEvidence>,
}

impl Surface {
    pub fn evidence(&self) -> CompositionEvidence {
        self.evidence
            .lock()
            .expect("composition evidence lock poisoned")
            .clone()
    }

    pub fn committed(&self, event_id: String) {
        self.evidence
            .lock()
            .expect("composition evidence lock poisoned")
            .committed(event_id);
    }

    pub fn system(&self) -> Option<Arc<String>> {
        self.system.clone()
    }

    pub fn capture(
        tools: &RequestTools<'_>,
        models: &maka_model::ModelExecutor,
        input: &RunSettings,
        source: &maka_event_log::context::ContextView,
        prior_unknown_notice: Option<&str>,
    ) -> Result<Self, RunError> {
        let mut system = input
            .configuration
            .system_prompt
            .as_ref()
            .map(|prompt| prompt.text.clone());
        let mut sources = input
            .configuration
            .system_prompt
            .as_ref()
            .map(|prompt| prompt.sources.clone())
            .unwrap_or_default();
        if let Some(notice) = prior_unknown_notice {
            let system = system.get_or_insert_with(String::new);
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(notice);
        }
        let adapter = models.binding(&input.provider)?;
        sources.push(adapter.source().clone());
        if let Some(source) = &input.model_revision {
            sources.push(source.clone());
        }
        let max_output_tokens = crate::auto_context::output_limit(input, source)?;
        let dynamic_context = session_context(input);
        let rendered = render_system(system.as_deref(), &dynamic_context);
        let evidence = RequestComposition {
            system_prompt: system,
            dynamic_context,
            tool_catalog_digest: tools.catalog_digest().into(),
            tools: tools.definitions(),
            provider_options: Some(input.provider_options.clone()),
            max_output_tokens,
            sources: sources.clone(),
        }
        .freeze()
        .map_err(|error| RunError::Internal(error.into()))?;
        Ok(Self {
            adapter,
            max_output_tokens,
            system: rendered.map(Arc::new),
            evidence: Mutex::new(Arc::new(evidence).into()),
        })
    }

    pub(super) fn rehydrate(
        adapter: maka_agent_ports::model::Binding,
        composition: &RequestComposition,
        event_id: String,
        digest: String,
    ) -> Self {
        Self {
            adapter,
            max_output_tokens: composition.max_output_tokens,
            system: render_system(
                composition.system_prompt.as_deref(),
                &composition.dynamic_context,
            )
            .map(Arc::new),
            evidence: Mutex::new(CompositionEvidence::Committed { event_id, digest }),
        }
    }

    pub fn summary(
        adapter: maka_agent_ports::model::Binding,
        mut composition: RequestComposition,
        output_budget: u64,
    ) -> Result<Self, RunError> {
        composition.max_output_tokens = Some(output_budget);
        Ok(Self {
            adapter,
            max_output_tokens: Some(output_budget),
            system: render_system(
                composition.system_prompt.as_deref(),
                &composition.dynamic_context,
            )
            .map(Arc::new),
            evidence: Mutex::new(CompositionEvidence::Inline(Arc::new(
                composition
                    .freeze()
                    .map_err(|error| RunError::Internal(error.into()))?,
            ))),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
    use maka_agent_ports::model::{Context, Error, Lifetime, ProviderAdapter, Request, Session};
    use tokio::sync::Semaphore;
    use tokio_util::sync::CancellationToken;

    struct Stalled(Arc<Semaphore>);
    impl ProviderAdapter for Stalled {
        fn open(
            &self,
            _: Lifetime,
            _: CancellationToken,
        ) -> futures_util::future::BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
            let session: Arc<dyn Session> = Arc::new(Self(self.0.clone()));
            Box::pin(async move { Ok(session) })
        }
    }
    impl Session for Stalled {
        fn stream(
            &self,
            _: Request,
            context: Context,
        ) -> futures_util::future::BoxFuture<'static, Result<(), Error>> {
            let entered = self.0.clone();
            Box::pin(async move {
                entered.add_permits(1);
                context.cancellation.cancelled().await;
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn committed_attempt_releases_composition_while_stream_is_open() {
        use crate::model_attempt::{Attempt, RequestSource};
        use maka_agent_facts::context::ModelPurpose;
        use maka_agent_facts::execution::*;
        let (_directory, root) = crate::test_support::root().await;
        let store = crate::test_support::session(&root, "session").await;
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        let engine = crate::Engine::new(
            maka_model::ModelExecutor::new(std::time::Duration::from_secs(30)).unwrap(),
            maka_tools::CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
        )
        .unwrap();
        let execution = store.execution_scope(None).await.unwrap().accept();
        let inner =
            crate::RunContext::new(engine.0.clone(), execution.store().clone(), &invocation)
                .unwrap();
        inner
            .log
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::ContextCompact {
                            request_fingerprint: "fixture-summary".into(),
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        let input = RunSettings {
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
        };
        let entered = Arc::new(Semaphore::new(0));
        let binding = maka_agent_ports::model::Binding::new(
            Arc::new(Stalled(entered.clone())),
            maka_agent_facts::composition::SourceRevision {
                kind: maka_agent_facts::composition::SourceKind::ModelAdapter,
                name: "fixture".into(),
                package_id: "fixture".into(),
                entry_id: "fixture".into(),
                activation: "fixture".into(),
                revision: "1".into(),
            },
        );
        let surface = Arc::new(
            Surface::summary(
                binding,
                RequestComposition {
                    system_prompt: Some("frozen system".into()),
                    dynamic_context: vec![],
                    tool_catalog_digest: maka_agent_facts::artifact::content_digest(b"[]"),
                    tools: vec![],
                    provider_options: Some(serde_json::json!({})),
                    max_output_tokens: None,
                    sources: vec![],
                },
                4096,
            )
            .unwrap(),
        );
        let body = match surface.evidence() {
            CompositionEvidence::Inline(body) => Arc::downgrade(&body),
            CompositionEvidence::Committed { .. } => panic!("new surface is inline"),
        };
        let context = Arc::new(
            inner
                .log
                .prepare_compaction_view(
                    "session",
                    Some("invocation"),
                    &maka_agent_facts::context::CheckpointMode::Standalone,
                )
                .await
                .unwrap(),
        );
        let cancellation = CancellationToken::new();
        let prompt = crate::model_attempt::prompt(
            &inner,
            &input,
            &context,
            &cancellation,
            None,
            "invocation",
            false,
            surface.system(),
            ModelPurpose::Summary,
        )
        .await
        .unwrap();
        let arena = prompt
            .arena()
            .cloned()
            .expect("prepared summary owns source backing");
        let source = RequestSource::from(context.as_ref());
        drop(context);
        let mut progressed = false;
        let mut retry = None;
        let mut confirmed_failure = None;
        let attempt = crate::model_attempt::execute_once(
            &inner,
            &input,
            &source,
            prompt,
            vec![],
            Attempt::Summary {
                surface: surface.clone(),
            },
            &cancellation,
            &mut progressed,
            &mut retry,
            &mut confirmed_failure,
            None,
        );
        tokio::pin!(attempt);
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            tokio::select! {
                result = &mut attempt => panic!("stream must remain open: {}", result.is_ok()),
                permit = entered.acquire() => permit.unwrap().forget(),
            }
            assert!(
                body.upgrade().is_none(),
                "no append envelope or active attempt retains the committed body"
            );
            let CompositionEvidence::Committed { event_id, .. } = surface.evidence() else {
                panic!("successful append must retire inline evidence");
            };
            let stored = inner
                .log
                .request_composition("session", &event_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(stored.system_prompt.as_deref(), Some("frozen system"));
            assert_eq!(stored.max_output_tokens, Some(4096));
            assert!(futures_util::poll!(&mut attempt).is_pending());
            cancellation.cancel();
            assert!(matches!(
                attempt.await,
                Err(RunError::Cancelled | RunError::Model(maka_model::ModelError::Cancelled))
            ));
        })
        .await
        .expect("committed body must retire before stream cancellation");
        arena.close().await.unwrap();
        engine.drain().await;
        execution.finish();
    }
}
