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
    Capture, CaptureFuture, CapturedImage, ForegroundAuthority, PresentationArea,
    PresentationFuture, PresentationResult, PreviewAuthority, PreviewKind, PreviewRegistry,
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
    fn socket(&self, scope: Option<Arc<dyn crate::BrowserEffectScope>>) -> Result<Cdp, ToolError> {
        match &self.socket.preparation {
            extension::PreparationTransport::NotRequired => Ok(self.socket.clone()),
            _ => Ok(self.socket.with_effect_scope(scope.ok_or_else(|| {
                failed("browser presentation requires its current Host preparation scope")
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
    fn present(
        &self,
        authority: Arc<dyn ForegroundAuthority>,
        area: PresentationArea,
        stop: CancellationToken,
    ) -> PresentationFuture {
        let capture = self.clone();
        Box::pin(async move {
            let socket = capture.socket(authority.browser_effect_scope())?;
            let checkpoint = || async {
                check_input(&stop)?;
                capture.verify(&socket).await?;
                authority.authorize(capture.subject(), stop.clone()).await?;
                capture.verify(&socket).await?;
                check_input(&stop)
            };
            checkpoint().await?;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Bounds {
                left: i32,
                top: i32,
                width: i32,
                height: i32,
                window_state: String,
            }
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Window {
                window_id: i32,
                bounds: Bounds,
            }
            let window: Window = serde_json::from_value(
                socket
                    .request("Browser.getWindowForTarget", json!({}))
                    .await?,
            )
            .map_err(failed)?;
            if window.bounds.window_state != "normal"
                || window.bounds.width <= 0
                || window.bounds.height <= 0
            {
                return Err(failed(
                    "Browser presentation requires a normal, non-minimized bound window",
                ));
            }
            let width = f64::from(window.bounds.width).min(area.width).round();
            let height = f64::from(window.bounds.height).min(area.height).round();
            let left = (area.x + (area.width - width) / 2.0).round();
            let top = (area.y + (area.height - height) / 2.0).round();
            if ![left, top, width, height]
                .into_iter()
                .all(|value| (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value))
            {
                return Err(failed(
                    "Browser presentation coordinates exceed its desktop range",
                ));
            }
            let requested = json!({"left":left as i32,"top":top as i32,"width":width as i32,"height":height as i32});
            let same_window = || async {
                checkpoint().await?;
                let current: Window = serde_json::from_value(
                    socket
                        .request("Browser.getWindowForTarget", json!({}))
                        .await?,
                )
                .map_err(failed)?;
                if current.window_id != window.window_id {
                    return Err(failed("Browser target moved to another window"));
                }
                Ok(())
            };
            same_window().await?;
            socket
                .request(
                    "Browser.setWindowBounds",
                    json!({"windowId":window.window_id,"bounds":requested}),
                )
                .await?;
            let mut details = json!({"windowId":window.window_id,"placementRequested":requested});
            if let Err(error) = same_window().await {
                return crate::preview::presentation_failure(error, details);
            }
            let observed = match socket
                .request(
                    "Browser.getWindowBounds",
                    json!({"windowId":window.window_id}),
                )
                .await
            {
                Ok(value) => value,
                Err(ToolError::OutcomeUnknown(message)) => {
                    return Err(ToolError::OutcomeUnknown(format!(
                        "{message}; requested placement: {details}"
                    )));
                }
                Err(error) => {
                    return crate::preview::presentation_failure(error, details);
                }
            };
            details["placementObserved"] = observed.clone();
            let observed: Bounds =
                serde_json::from_value(observed["bounds"].clone()).map_err(failed)?;
            if observed.left != left as i32
                || observed.top != top as i32
                || observed.width != width as i32
                || observed.height != height as i32
                || observed.window_state != "normal"
            {
                return Ok(PresentationResult::Partial {
                    message: "Browser window placement was not verified".into(),
                    details,
                });
            }
            if let Err(error) = same_window().await {
                return crate::preview::presentation_failure(error, details);
            }
            let activation = match socket.request("Page.bringToFront", json!({})).await {
                Ok(value) => value,
                Err(ToolError::OutcomeUnknown(message)) => {
                    return Err(ToolError::OutcomeUnknown(format!(
                        "{message}; completed placement: {details}"
                    )));
                }
                Err(error) => {
                    return crate::preview::presentation_failure(error, details);
                }
            };
            details["activationRequested"] = activation;
            if let Err(error) = same_window().await {
                return crate::preview::presentation_failure(error, details);
            }
            // CDP acknowledges selecting this exact tab, without OS foreground proof.
            Ok(PresentationResult::Requested { details })
        })
    }
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
            let socket = capture.socket(authority.browser_effect_scope())?;
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
            let socket = capture.socket(authority.browser_effect_scope())?;
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
