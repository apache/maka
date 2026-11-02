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
use maka_agent_ports::provider::Error;
use serde_json::Value;
use std::collections::BTreeMap;
mod inventory;
mod login;
mod provider;
pub use inventory::decode_model_inventory;
use provider::configuration;

pub const ID: &str = "maka.codex";
pub const ADAPTER: &str = "codex-responses";

/// ChatGPT subscription definition, authentication, and account model policy.
#[derive(Clone)]
pub struct Codex {
    snapshot: std::sync::Arc<crate::catalog::Snapshot>,
}
impl Codex {
    pub fn new(snapshot: std::sync::Arc<crate::catalog::Snapshot>) -> Self {
        Self { snapshot }
    }
}

/// Invocation-only credentials, never provider metadata or a composition source.
pub fn request_headers(
    access_token: &str,
    session_id: &str,
) -> Result<BTreeMap<String, String>, Error> {
    if session_id.is_empty() || session_id.chars().any(char::is_control) {
        return Err(Error::Invalid(
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
