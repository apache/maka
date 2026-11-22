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

use maka_agent_ports::provider::{Context, Error};
use maka_capabilities::http;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;

pub(crate) fn bearer(key: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("authorization".into(), format!("Bearer {key}"))])
}

pub(crate) async fn get_json<T: DeserializeOwned>(
    context: &Context,
    url: String,
    headers: BTreeMap<String, String>,
) -> Result<T, Error> {
    request_json(
        context,
        http::Request {
            url,
            method: maka_plugin_core::http::Method::Get,
            headers: headers.into_iter().collect(),
            body: Default::default(),
        },
    )
    .await
}

pub(crate) async fn request_json<T: DeserializeOwned>(
    context: &Context,
    mut request: http::Request,
) -> Result<T, Error> {
    const MAX_BYTES: usize = 1024 * 1024;
    request
        .headers
        .retain(|(name, _)| !name.eq_ignore_ascii_case("accept"));
    request
        .headers
        .push(("accept".into(), "application/json".into()));
    let response = context
        .transport
        .request(request, context.cancellation.clone())
        .await
        .map_err(|_| Error::Transport("usage request failed".into()))?;
    let result = async {
        match response.head.status {
            200..=299 => {}
            401 => return Err(Error::AuthenticationRequired),
            status => return Err(Error::Http(status)),
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .body
            .next()
            .await
            .map_err(|_| Error::Transport("usage response read failed".into()))?
        {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err(Error::Invalid("usage response is too large".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("invalid usage response".into()))
    }
    .await;
    response.body.cancel();
    response
        .body
        .close()
        .await
        .map_err(|_| Error::Transport("usage request cleanup failed".into()))?;
    result
}
