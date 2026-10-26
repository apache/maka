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

use super::{ApiProvider, Configuration, Selection, route};
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_ports::model::Credentials;
use maka_agent_ports::model::ProviderKind;
use maka_agent_ports::provider::Context;
use maka_agent_ports::provider::Discovery;
use maka_agent_ports::provider::Error;
use maka_agent_ports::provider::Verification;
use maka_capabilities::http;
use serde_json::json;
use std::collections::BTreeMap;

pub(super) async fn discover(
    provider: &ApiProvider,
    request: Discovery,
    context: Context,
) -> Result<Vec<ModelInfo>, Error> {
    super::discovery::discover(provider, request, context).await
}

pub(super) async fn verify(
    provider: &ApiProvider,
    request: Verification,
    context: Context,
) -> Result<(), Error> {
    let configuration = Configuration::read(&request.connection)?;
    let route = route::resolve(
        &Selection {
            provider: provider.id,
            connection: &request.connection,
            base_url: &configuration.base_url,
            model: &request.model,
            overrides: request.overrides.as_ref(),
        },
        provider.facts,
    )?;
    route.check_probe()?;
    let kind = match route.kind {
        ProviderKind::Anthropic => HeaderAuth::Anthropic,
        _ => HeaderAuth::Bearer,
    };
    let credentials =
        super::authentication::authorize(provider.facts.auth_kind, request.credential)?;
    let headers = headers(kind, credentials, request.request_headers)?;
    let base = route.base_url.trim_end_matches('/');
    let (path, mut body) = match route.kind {
        ProviderKind::OpenaiResponses | ProviderKind::OpenResponses(_) => (
            "responses",
            json!({"model":request.model.id, "store":false, "max_output_tokens":16,
                "input":[{"role":"user","content":"Hi"}]}),
        ),
        ProviderKind::Anthropic => (
            "messages",
            json!({"model":request.model.id,"max_tokens":16,"messages":[{"role":"user","content":"Hi"}]}),
        ),
        _ => (
            "chat/completions",
            json!({"model":request.model.id,"max_tokens":16,"messages":[{"role":"user","content":"Hi"}]}),
        ),
    };
    if let Some(overlay) = request.request_body_overlay {
        let overlay = overlay
            .as_object()
            .ok_or_else(|| Error::Invalid("invalid request overlay".into()))?;
        let target = body.as_object_mut().expect("verification body");
        if overlay.keys().any(|key| target.contains_key(key)) {
            return Err(Error::Invalid(
                "request overlay conflicts with verification".into(),
            ));
        }
        target.extend(overlay.clone());
    }
    // Verification proves HTTP acceptance, not a full agent inference.
    send(
        &context,
        http::Request {
            url: format!("{base}/{path}"),
            method: http::Method::Post,
            headers: headers.into_iter().collect(),
            body: serde_json::to_vec(&body)
                .map_err(|_| Error::Invalid("invalid verification body".into()))?
                .into(),
        },
        ResponseBody::Discard,
    )
    .await?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum HeaderAuth {
    Bearer,
    Anthropic,
}

pub(super) fn headers(
    kind: HeaderAuth,
    credentials: Credentials,
    custom: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, Error> {
    let mut headers = BTreeMap::from([("content-type".into(), "application/json".into())]);
    if kind == HeaderAuth::Anthropic {
        headers.insert("anthropic-version".into(), "2023-06-01".into());
    }
    let authenticated = match credentials {
        Credentials::ApiKey(key) if kind == HeaderAuth::Anthropic => {
            BTreeMap::from([("x-api-key".into(), key)])
        }
        Credentials::ApiKey(key) if !key.is_empty() => {
            BTreeMap::from([("authorization".into(), format!("Bearer {key}"))])
        }
        Credentials::ApiKey(_) => BTreeMap::new(),
        Credentials::RequestHeaders(headers) => headers,
    };
    for (name, value) in authenticated.into_iter().chain(custom) {
        let name = name.to_ascii_lowercase();
        if headers
            .get(&name)
            .is_some_and(|existing| existing != &value)
        {
            return Err(Error::Invalid(
                "request headers conflict with provider authentication".into(),
            ));
        }
        headers.insert(name, value);
    }
    Ok(headers)
}

pub(super) enum ResponseBody {
    Inventory,
    Discard,
}

pub(super) async fn send(
    context: &Context,
    request: http::Request,
    body: ResponseBody,
) -> Result<Vec<u8>, Error> {
    if context.cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let response = context
        .transport
        .request(request, context.cancellation.clone())
        .await
        .map_err(|_| {
            if context.cancellation.is_cancelled() {
                Error::Cancelled
            } else {
                Error::Transport("provider request failed".into())
            }
        })?;
    let result = async {
        if !(200..300).contains(&response.head.status) {
            return Err(Error::Http(response.head.status));
        }
        if matches!(body, ResponseBody::Discard) {
            return Ok(Vec::new());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .body
            .next()
            .await
            .map_err(|_| Error::Transport("provider response read failed".into()))?
        {
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    let result = tokio::select! {
        biased;
        _ = context.cancellation.cancelled() => Err(Error::Cancelled),
        result = result => result,
    };
    response.body.cancel();
    response
        .body
        .close()
        .await
        .map_err(|_| Error::Transport("provider cleanup failed".into()))?;
    result
}
