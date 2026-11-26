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

use futures_util::future::BoxFuture;
use maka_agent_facts::model::prompt::Prompt;
use maka_agent_ports::model::{self, Context, Error, Lifetime, ProviderAdapter, Request, Session};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// ChatGPT's subscription profile composes the ordinary Responses implementation.
#[derive(Default)]
pub(super) struct Adapter(super::responses::Adapter);

impl ProviderAdapter for Adapter {
    fn recovery_contract(
        &self,
        kind: &model::ProviderKind,
        tools: &[Arc<maka_agent_facts::tools::ToolDefinition>],
    ) -> Option<model::RecoveryContract> {
        self.0.recovery_contract(kind, tools)
    }
    fn continuation_cursor(
        &self,
        contract: &model::RecoveryContract,
        part: &maka_agent_facts::model::ModelPart,
    ) -> Option<Value> {
        self.0.continuation_cursor(contract, part)
    }

    fn supports_item_acceptance(&self) -> bool {
        self.0.supports_item_acceptance()
    }
    fn enforces_idle_timeout(&self) -> bool {
        self.0.enforces_idle_timeout()
    }

    fn open(
        &self,
        lifetime: Lifetime,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        Box::pin(async move {
            let inner = self.0.open(lifetime, cancellation).await?;
            Ok(Arc::new(Subscription(inner)) as Arc<dyn Session>)
        })
    }
}

struct Subscription(Arc<dyn Session>);
impl Session for Subscription {
    fn fallback_availability(
        &self,
    ) -> maka_agent_facts::model::retry_transport::FallbackAvailability {
        self.0.fallback_availability()
    }
    fn retry_transport_phase(&self) -> model::RetryTransportPhase {
        self.0.retry_transport_phase()
    }

    fn restore_retry_transport_phase(
        &self,
        phase: model::RetryTransportPhase,
    ) -> Result<(), Error> {
        self.0.restore_retry_transport_phase(phase)
    }

    fn try_switch_fallback_transport(&self) -> bool {
        self.0.try_switch_fallback_transport()
    }

    fn stream(
        &self,
        mut request: Request,
        context: Context,
    ) -> BoxFuture<'static, Result<(), Error>> {
        let inner = self.0.clone();
        Box::pin(async move {
            prepare(&mut request).await?;
            inner.stream(request, context).await
        })
    }
    fn needs_confirmation(&self) -> bool {
        self.0.needs_confirmation()
    }
    fn confirm<'a>(
        &'a self,
        prompt: &'a Prompt,
        settled_tool_call_ids: &'a [&'a str],
        response_id: Option<&'a str>,
    ) -> BoxFuture<'a, bool> {
        self.0.confirm(prompt, settled_tool_call_ids, response_id)
    }
}

pub(super) async fn prepare(request: &mut Request) -> Result<(), Error> {
    if !matches!(request.provider.kind, model::ProviderKind::OpenaiResponses) {
        return Err(Error::Adapter(
            "subscription requires the Responses protocol".into(),
        ));
    }
    // The subscription endpoint rejects max_output_tokens. Host-side reply
    // budgets still reserve context; only this provider's wire request omits it.
    request.max_output_tokens = None;
    // Reusable instructions stay in the leading developer input message so
    // prompt caching applies and GPT-6.2+ does not re-bill top-level instructions.
    if request.provider_options.is_null() {
        request.provider_options = json!({});
    }
    let options = request
        .provider_options
        .as_object_mut()
        .ok_or_else(|| Error::Adapter("provider options must be an object".into()))?;
    let options = options.entry("openai").or_insert_with(|| json!({}));
    let options = options
        .as_object_mut()
        .ok_or_else(|| Error::Adapter("OpenAI options must be an object".into()))?;
    options.insert("store".into(), Value::Bool(false));
    if !options.get("textVerbosity").is_some_and(Value::is_string) {
        options.insert("textVerbosity".into(), json!("medium"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::language::Language;
    use maka_agent_facts::model::prompt::Message;
    use maka_agent_facts::model::request::{Credentials, Provider, ToolChoiceMode};

    fn sample_request(provider_options: Value) -> Request {
        Request {
            operation: Default::default(),
            language: Language::EN,
            provider: Provider {
                kind: model::ProviderKind::OpenaiResponses,
                model: "gpt-6.2-sol".into(),
                base_url: "https://chatgpt.com/backend-api/codex".into(),
                auth: Credentials::RequestHeaders(Default::default()),
                headers: Default::default(),
                body_overlay: None,
            },
            prompt: Prompt::from_messages(vec![
                Message::System {
                    content: "Reusable system instructions.".into(),
                    provider_options: None,
                },
                Message::User {
                    content: vec![],
                    provider_options: None,
                },
            ]),
            tools: Vec::new(),
            tool_choice: ToolChoiceMode::Auto,
            provider_options,
            max_output_tokens: Some(4096),
        }
    }

    #[tokio::test]
    async fn prepare_leaves_reusable_system_prompt_in_input_without_top_level_instructions() {
        let mut request = sample_request(Value::Null);
        prepare(&mut request).await.unwrap();
        assert_eq!(request.max_output_tokens, None);
        assert_eq!(request.provider_options["openai"]["store"], json!(false));
        assert_eq!(
            request.provider_options["openai"]["textVerbosity"],
            json!("medium")
        );
        assert!(
            request.provider_options["openai"]
                .get("instructions")
                .is_none()
        );
        let body = crate::adapters::responses::body::RequestBody::new(&request, None, 0).unwrap();
        let bytes = futures_util::TryStreamExt::try_collect::<Vec<_>>(body.chunks())
            .await
            .unwrap()
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let wire: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(wire.get("instructions").is_none());
        assert_eq!(wire["input"][0]["role"], json!("developer"));
        assert_eq!(
            wire["input"][0]["content"],
            json!("Reusable system instructions.")
        );

        let mut explicit = sample_request(json!({"openai":{"instructions":"Turn override."}}));
        prepare(&mut explicit).await.unwrap();
        assert_eq!(
            explicit.provider_options["openai"]["instructions"],
            json!("Turn override.")
        );
    }
}
