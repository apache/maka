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

use super::{Lane, transport::Shared};
use futures_util::future::BoxFuture;
use maka_agent_facts::model::prompt_source::Prompt;
use maka_agent_ports::model::Context;
use maka_agent_ports::model::Error;
use maka_agent_ports::model::Lifetime;
use maka_agent_ports::model::ProviderAdapter;
use maka_agent_ports::model::Request;
use maka_agent_ports::model::{RetryTransportPhase, Session};
use std::sync::Arc;

/// Responses execution; all network capabilities come from Host.
#[derive(Default)]
pub struct Adapter {
    transport: Arc<Shared>,
}
impl ProviderAdapter for Adapter {
    fn supports_item_acceptance(&self) -> bool {
        true
    }
    fn enforces_idle_timeout(&self) -> bool {
        true
    }

    fn open(
        &self,
        lifetime: Lifetime,
        _: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        let session = ResponsesSession {
            transport: self.transport.clone(),
            lane: matches!(lifetime, Lifetime::Conversation).then(Lane::default),
        };
        Box::pin(async { Ok(Arc::new(session) as Arc<dyn Session>) })
    }
}
struct ResponsesSession {
    transport: Arc<Shared>,
    lane: Option<Lane>,
}
impl Session for ResponsesSession {
    fn retry_transport_phase(&self) -> RetryTransportPhase {
        self.lane
            .as_ref()
            .map_or(RetryTransportPhase::Primary, |lane| {
                lane.transport.retry_transport_phase()
            })
    }

    fn restore_retry_transport_phase(&self, phase: RetryTransportPhase) -> Result<(), Error> {
        match &self.lane {
            Some(lane) => lane
                .transport
                .restore_retry_transport_phase(phase)
                .map_err(|cause| Error::Adapter(cause.to_string())),
            None if phase == RetryTransportPhase::Primary => Ok(()),
            None => Err(Error::Adapter(
                "request session cannot restore fallback transport".into(),
            )),
        }
    }

    fn try_switch_fallback_transport(&self) -> bool {
        self.lane.as_ref().is_some_and(|lane| {
            lane.transport
                .try_switch_fallback_transport(&self.transport)
        })
    }

    fn stream(&self, request: Request, context: Context) -> BoxFuture<'static, Result<(), Error>> {
        Box::pin(super::stream(
            request,
            context,
            self.lane.clone(),
            self.transport.clone(),
        ))
    }
    fn needs_confirmation(&self) -> bool {
        self.lane.as_ref().is_some_and(Lane::needs_confirmation)
    }
    fn confirm<'a>(
        &'a self,
        prompt: &'a Prompt,
        settled_tool_call_ids: &'a [&'a str],
        response_id: Option<&'a str>,
    ) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            match &self.lane {
                Some(lane) => {
                    lane.confirm(prompt, settled_tool_call_ids, response_id)
                        .await
                }
                None => false,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Conversation;
    use maka_agent_facts::composition::{SourceKind, SourceRevision};
    use maka_agent_facts::language::Language;
    use maka_agent_facts::model::error::{ProviderFailure, ProviderFailureReason};
    use maka_agent_facts::model::prompt::{Message, Prompt};
    use maka_agent_ports::model::{
        Binding, Connect, Credentials, Emission, Events, Provider, ProviderKind, Socket, Transport,
    };
    use maka_capabilities::http;
    use std::{
        collections::BTreeMap,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };
    use tokio_util::sync::CancellationToken;

    #[derive(Default)]
    struct Network {
        connects: AtomicUsize,
        sends: AtomicUsize,
    }
    impl Transport for Network {
        fn identity(&self) -> u64 {
            1
        }
        fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>> {
            self.connects.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err(Error::Adapter("WebSocket unavailable".into())) })
        }
        fn request(
            &self,
            _: http::Request,
            _: CancellationToken,
        ) -> BoxFuture<'_, Result<http::Response, Error>> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Err(Error::Provider(ProviderFailure::new(
                    ProviderFailureReason::RateLimit,
                    "retry later",
                    true,
                    None,
                )))
            })
        }
    }
    struct NoEvents;
    impl Events for NoEvents {
        fn emit(&self, _: Emission) -> BoxFuture<'_, Result<(), Error>> {
            Box::pin(async { panic!("fixture emits no output") })
        }
    }
    fn request() -> Request {
        Request {
            language: Language::En,
            provider: Provider {
                kind: ProviderKind::OpenaiResponses,
                model: "fixture".into(),
                base_url: "https://fixture.invalid/v1".into(),
                auth: Credentials::ApiKey("fixture-key".into()),
                headers: BTreeMap::new(),
                body_overlay: None,
            },
            prompt: Prompt::from_messages(vec![Message::user("frozen input")]),
            tools: vec![],
            provider_options: serde_json::json!({"openai":{"store":false}}),
            max_output_tokens: None,
        }
    }
    fn binding() -> Binding {
        Binding::new(
            Arc::new(Adapter::default()),
            SourceRevision {
                kind: SourceKind::ModelAdapter,
                name: "responses".into(),
                package_id: "fixture".into(),
                entry_id: "responses".into(),
                activation: "fresh".into(),
                revision: "1".into(),
            },
        )
    }
    async fn attempt(conversation: &Conversation, binding: &Binding, network: Arc<Network>) {
        let session = conversation
            .session(binding, CancellationToken::new())
            .await
            .unwrap();
        let result = session
            .stream(
                request(),
                Context {
                    transport: network,
                    events: Arc::new(NoEvents),
                    cancellation: CancellationToken::new(),
                    idle_timeout: Duration::from_secs(60),
                    source: None,
                },
            )
            .await;
        assert!(matches!(result, Err(Error::Provider(_))));
    }

    #[tokio::test(start_paused = true)]
    async fn automatic_fallback_survives_fresh_conversation_and_adapter() {
        let network = Arc::new(Network::default());
        let conversation = Conversation::default();
        attempt(&conversation, &binding(), network.clone()).await;
        assert_eq!(network.connects.load(Ordering::SeqCst), 6);
        let phase = conversation.retry_transport_phase();
        assert_eq!(phase, RetryTransportPhase::Fallback);
        drop(conversation);

        let restored = Conversation::with_retry_transport_phase(phase);
        attempt(&restored, &binding(), network.clone()).await;
        assert_eq!(
            network.connects.load(Ordering::SeqCst),
            6,
            "restored fallback must not reopen primary"
        );
        assert_eq!(network.sends.load(Ordering::SeqCst), 2);
        assert!(
            !restored.try_switch_fallback_transport(),
            "consumed fallback cannot replenish retry budget"
        );

        attempt(&restored, &binding(), network.clone()).await;
        assert_eq!(
            network.connects.load(Ordering::SeqCst),
            6,
            "binding replacement must preserve fallback"
        );
        assert_eq!(network.sends.load(Ordering::SeqCst), 3);
    }
}
