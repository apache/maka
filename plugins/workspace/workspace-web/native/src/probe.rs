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
use maka_agent_authority::computer::NativeCallContext;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::{call, http};
use maka_host_runtime::application::Context;
use maka_plugin_core::http::Method;
use maka_web_api::probe::{Endpoint, Input, Readiness};
use std::{sync::Arc, time::Instant};

/// One local Web probe on behalf of the already bound process health call.
pub struct ProcessProbe {
    pub(crate) target: String,
    pub(crate) native: Arc<NativeCallContext>,
}
impl ProcessProbe {
    pub fn new(context: &Context, target: &str) -> Result<Self, ToolError> {
        let native = context
            .native_context::<NativeCallContext>()
            .ok_or_else(|| {
                ToolError::Failed("Health check requires its original native call".into())
            })?;
        let original = native.access().permission_request_original()?;
        let Some(original) = original else {
            return Err(ToolError::Failed(
                "Health check has no bound process call".into(),
            ));
        };
        if context.operation_scope().map(|scope| scope.reference()) != Some(original)
            || original.contract.name != "maka.workspace.Processes"
            || original.method != "health"
        {
            return Err(ToolError::Failed(
                "Health check belongs to another operation".into(),
            ));
        }
        Ok(Self {
            target: target.to_owned(),
            native,
        })
    }
}

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
            let status = request(&client, &scope, &target, Method::Head).await?;
            if matches!(status, 405 | 501) {
                request(&client, &scope, &target, Method::Get).await
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
    method: Method,
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
