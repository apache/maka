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

//! Counts the same replayable JSON body that the built-in adapters send.
use crate::{EncodedRequestBytes, ModelError, ModelRequest, ProviderKind};
use futures_util::StreamExt;
use maka_agent_facts::model::request::{Credentials, Provider, Request};
use maka_capabilities::http;

pub(crate) async fn encoded_request_bytes(
    request: &ModelRequest,
) -> Result<EncodedRequestBytes, ModelError> {
    if !matches!(
        request.provider.adapter_name(),
        "chat-completions" | "responses" | "anthropic-messages"
    ) && request.provider.adapter_name() != maka_providers::codex::ADAPTER
    {
        return Err(ModelError::Adapter(
            "request byte counting is unavailable for the selected adapter".into(),
        ));
    }
    // Authentication does not enter the body. Counting can run before resolving
    // a bound credential, and must not activate its owner.
    let mut input = Request {
        language: request.language,
        provider: Provider {
            kind: request.provider.kind.clone(),
            model: request.provider.model.clone(),
            base_url: request.provider.base_url.clone(),
            auth: Credentials::RequestHeaders(Default::default()),
            headers: request.provider.headers.clone(),
            body_overlay: request.provider.body_overlay.clone(),
        },
        prompt: crate::reasoning::normalize(request.prompt.clone(), &request.provider.kind)?,
        tools: request.tools.clone(),
        provider_options: request.provider_options.clone(),
        max_output_tokens: request.max_output_tokens,
    };
    if request.provider.adapter_name() == maka_providers::codex::ADAPTER {
        super::codex::prepare(&mut input).await?;
    }
    let plaintext = match input.provider.kind {
        ProviderKind::OpenResponses(contract) => Some(contract),
        _ => None,
    };
    let mut websocket = None;
    let body = if matches!(
        input.provider.kind,
        ProviderKind::OpenaiResponses | ProviderKind::OpenResponses(_)
    ) {
        let body = super::responses::body::RequestBody::new(&input, plaintext, 0)
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        let mut chunks = body.clone().websocket();
        let mut bytes = 0_u64;
        while let Some(chunk) = chunks.next().await {
            bytes = checked_add(bytes, chunk?.len())?;
        }
        websocket = Some(bytes);
        http::RequestBody::stream(body.chunks())
    } else {
        let prepared = super::request::prepare(input).await?;
        if let Some((source, options, language)) = prepared.chat {
            super::body::chat(prepared.body, source, options, language)
        } else {
            let (wire, context) = prepared
                .anthropic_source
                .expect("prepared Anthropic source");
            super::anthropic::body(prepared.body, wire, context)?
        }
    };
    let mut chunks = body.into_stream();
    let mut bytes = 0_u64;
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|error| match error {
            http::Error::Denied => ModelError::Cancelled,
            http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
            error => ModelError::Adapter(error.to_string()),
        })?;
        bytes = checked_add(bytes, chunk.len())?;
    }
    Ok(EncodedRequestBytes {
        http: bytes,
        websocket,
    })
}

fn checked_add(bytes: u64, chunk: usize) -> Result<u64, ModelError> {
    bytes
        .checked_add(chunk as u64)
        .ok_or_else(|| ModelError::Adapter("encoded request byte count overflow".into()))
}
