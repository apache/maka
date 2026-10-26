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

use base64::Engine;
use futures_util::future::BoxFuture;
use maka_agent_facts::model::prompt::Prompt;
use maka_agent_ports::model;
use maka_agent_ports::model::Context;
use maka_agent_ports::model::Error;
use maka_agent_ports::model::Lifetime;
use maka_agent_ports::model::ProviderAdapter;
use maka_agent_ports::model::Request;
use maka_agent_ports::model::Session;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;
mod inventory;
mod login;
mod provider;
pub use inventory::decode_model_inventory;
use provider::configuration;

pub const ID: &str = "maka.codex";
pub const ADAPTER: &str = "codex-responses";

/// ChatGPT's subscription profile composes the ordinary Responses implementation.
#[derive(Default)]
pub struct Codex(maka_responses::Adapter);

impl ProviderAdapter for Codex {
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

/// Invocation-only credentials, never provider metadata or a composition source.
pub fn request_headers(
    access_token: &str,
    session_id: &str,
) -> Result<BTreeMap<String, String>, Error> {
    if session_id.is_empty() || session_id.chars().any(char::is_control) {
        return Err(Error::Adapter(
            "invalid subscription session identity".into(),
        ));
    }
    let mut headers = BTreeMap::from([
        ("authorization".into(), format!("Bearer {access_token}")),
        ("openai-beta".into(), "responses=experimental".into()),
        ("originator".into(), "codex_cli_rs".into()),
        ("user-agent".into(), "codex_cli_rs/0.0.0 (Maka)".into()),
        ("session_id".into(), session_id.into()),
        ("x-client-request-id".into(), session_id.into()),
    ]);
    if let Some(account) = account_id(access_token) {
        headers.insert("chatgpt-account-id".into(), account);
    }
    Ok(headers)
}

async fn prepare(request: &mut Request) -> Result<(), Error> {
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

fn account_id(token: &str) -> Option<String> {
    let mut parts = token.split('.');
    parts.next()?;
    let payload = parts.next()?;
    parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    for value in [
        &claims["chatgpt_account_id"],
        &claims["https://api.openai.com/auth"]["chatgpt_account_id"],
    ] {
        if let Some(id) = value.as_str().filter(|v| !v.is_empty()) {
            return Some(id.into());
        }
    }
    claims["organizations"].as_array()?.iter().find_map(|v| {
        v["id"]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    })
}
