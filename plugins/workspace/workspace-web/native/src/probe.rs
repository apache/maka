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

//! HEAD, one GET fallback, and no body reads or redirects.
use maka_agent_facts::tools::ToolError;
use maka_capabilities::{call, http};
use maka_web_api::probe::{Endpoint, Input, Readiness};
use std::{sync::Arc, time::Instant};

pub async fn probe(
    client: Arc<dyn http::Client>,
    parent: &call::Scope,
    input: Input,
) -> Result<Endpoint, ToolError> {
    let target = input.target().map_err(ToolError::Failed)?;
    let owned = call::Owned::new(parent.child()?);
    let scope = owned.scope();
    let started = Instant::now();
    let result = tokio::select! {
        biased;
        _ = scope.cancellation.cancelled() => Err(http::Error::Failed("cancelled".into())),
        result = async {
            let status = request(&client, &scope, &target, http::Method::Head).await?;
            if matches!(status, 405 | 501) {
                request(&client, &scope, &target, http::Method::Get).await
            } else {
                Ok(status)
            }
        } => result,
    };
    owned.finish().await?;
    if parent.cancellation.is_cancelled() {
        return Err(ToolError::Failed(
            "Background health check cancelled".into(),
        ));
    }
    match result {
        Ok(status) => Ok(Endpoint::Checked {
            target,
            http_status: status,
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            health: if (200..300).contains(&status) {
                Readiness::Healthy
            } else if status < 400 {
                Readiness::Unknown
            } else {
                Readiness::Unhealthy
            },
        }),
        Err(http::Error::CleanupUnconfirmed) => Err(ToolError::CleanupUnconfirmed(
            "Health probe cleanup is unconfirmed".into(),
        )),
        Err(http::Error::Denied) => Ok(Endpoint::Unknown {
            target,
            error: "Endpoint access was not authorized".into(),
        }),
        Err(_) => Ok(Endpoint::Unknown {
            target,
            error: "Endpoint probe failed or timed out".into(),
        }),
    }
}
async fn request(
    client: &Arc<dyn http::Client>,
    scope: &call::Scope,
    target: &str,
    method: http::Method,
) -> Result<u16, http::Error> {
    let response = client
        .request(
            scope.clone(),
            http::Request {
                url: target.into(),
                method,
                headers: vec![],
                body: Default::default(),
            },
        )
        .await?;
    let status = response.head.status;
    response.body.cancel();
    response.body.close().await?;
    Ok(status)
}
