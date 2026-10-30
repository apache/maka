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
    // Resolve against full canonical input before the Responses lane removes a
    // confirmed prefix. A tool-only continuation must retain its instructions.
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
    if !options
        .get("instructions")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.trim().is_empty())
    {
        let instructions = if let Some(instructions) = request.prompt.instructions() {
            instructions.to_owned()
        } else if let Some(messages) = request.prompt.memory_messages() {
            messages
                .iter()
                .find_map(|message| match message {
                    model::Message::System { content, .. } if !content.trim().is_empty() => {
                        Some(content.clone())
                    }
                    _ => None,
                })
                .unwrap_or_default()
        } else {
            return Err(Error::Adapter(
                "captured subscription prompt is missing its system instruction metadata".into(),
            ));
        };
        options.insert("instructions".into(), Value::String(instructions));
    }
    options.insert("store".into(), Value::Bool(false));
    if !options.get("textVerbosity").is_some_and(Value::is_string) {
        options.insert("textVerbosity".into(), json!("medium"));
    }
    Ok(())
}
