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

use super::*;
use crate::preview::{
    Capture, CaptureFuture, CapturedImage, PreviewAuthority, PreviewKind, PreviewRegistry,
    PreviewSubject,
};
use std::sync::Arc;

impl Browsers {
    pub(crate) fn retire_browser_preview(&self, browser: &str, registry: &PreviewRegistry) {
        for (handle, tab) in &self.targets {
            if tab.provider.id() == browser {
                registry.remove(self.epoch, handle);
            }
        }
    }
    pub(crate) fn publish_preview(
        &self,
        handle: &str,
        registry: &PreviewRegistry,
        invocation: &crate::InvocationContext<'_>,
    ) {
        let Some(tab) = self.targets.get(handle) else {
            registry.remove(self.epoch, handle);
            return;
        };
        let (Some(connection), Some(proof)) = (&tab.connection, &tab.origin_proof) else {
            registry.remove(self.epoch, handle);
            return;
        };
        registry.register(
            self.epoch,
            handle.to_owned(),
            PreviewKind::Tab,
            tab.info.url.clone(),
            Arc::new(BrowserCapture {
                socket: connection.socket().clone(),
                provider: tab.provider.clone(),
                document: tab.document(),
                proof: proof.clone(),
                execution: invocation.execution_correlation().clone(),
            }),
        );
    }
}
#[derive(Clone)]
struct BrowserCapture {
    socket: Cdp,
    provider: Provider,
    document: crate::BrowserDocument,
    proof: origin::DocumentOrigin,
    execution: crate::ExecutionCorrelation,
}
impl BrowserCapture {
    fn subject(&self) -> PreviewSubject {
        PreviewSubject::Browser {
            access: self.proof.access(),
        }
    }
    fn socket(&self, authority: &dyn PreviewAuthority) -> Result<Cdp, ToolError> {
        match &self.socket.preparation {
            extension::PreparationTransport::NotRequired => Ok(self.socket.clone()),
            _ => Ok(self
                .socket
                .with_effect_scope(authority.browser_effect_scope().ok_or_else(|| {
                    failed("preview extension transport requires its current Host read-only scope")
                })?)),
        }
    }
    async fn verify(&self, socket: &Cdp) -> Result<(), ToolError> {
        if let Some(extension) = self.provider.extension() {
            if extension.is_closed() || extension.identity().generation != self.document.generation
            {
                return Err(failed("preview browser generation changed"));
            }
            // The transport checks the live physical claim and preparation
            // binding before and after consulting the current Host authority.
            let _admitted = socket.preparation.before_request().await?;
        } else {
            let (generation, tabs) = self.provider.inventory().await?;
            if generation != self.document.generation
                || !tabs.iter().any(|tab| tab.id == self.document.tab_id)
            {
                return Err(failed("preview tab was closed or replaced"));
            }
        }
        self.proof.check_cdp_current(socket, &self.document).await
    }
}
impl Capture for BrowserCapture {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn same_source(&self, other: &dyn Capture) -> bool {
        other.as_any().downcast_ref::<Self>().is_some_and(|other| {
            self.provider == other.provider
                && self.document == other.document
                && self.proof == other.proof
                && self.execution == other.execution
                && self.socket.extension_context == other.socket.extension_context
        })
    }
    fn authorize(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> crate::AuthorizationFuture {
        let capture = self.clone();
        Box::pin(async move {
            let socket = capture.socket(authority.as_ref())?;
            check_input(&stop)?;
            capture.verify(&socket).await?;
            authority.authorize(capture.subject(), stop.clone()).await?;
            capture.verify(&socket).await?;
            check_input(&stop)
        })
    }
    fn capture(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> CaptureFuture {
        let capture = self.clone();
        Box::pin(async move {
            let socket = capture.socket(authority.as_ref())?;
            check_input(&stop)?;
            capture.verify(&socket).await?;
            authority.authorize(capture.subject(), stop.clone()).await?;
            capture.verify(&socket).await?;
            check_input(&stop)?;
            // One-shot viewport reads create no producer, ACK obligation or
            // temporary page state. Agent screencast custody stays untouched.
            let image = socket
                .observe_in(
                    None,
                    "Page.captureScreenshot",
                    json!({"format":"jpeg", "quality":75, "captureBeyondViewport":false}),
                )
                .await?;
            check_input(&stop)?;
            authority.authorize(capture.subject(), stop.clone()).await?;
            capture.verify(&socket).await?;
            let data = image["data"]
                .as_str()
                .ok_or_else(|| failed("preview browser returned no pixels"))?;
            if data.len() > 44 * 1024 * 1024 {
                return Err(failed("preview browser image exceeds byte limit"));
            }
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .map(CapturedImage::Encoded)
                .map_err(failed)
        })
    }
}

#[cfg(test)]
mod tests;
