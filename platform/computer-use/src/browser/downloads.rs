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

//! Download intents share the existing tab/CDP and actual Host authorization.
//!
//! Extension IDs and filenames are global provider metadata. The original URL-first
//! association is preserved; it does not turn a filename into file ownership.

use super::*;
use cua_driver_core::browser::ExtensionBrowserProvider;

mod coordinator;
mod metadata;
mod response;

use coordinator::Armed;
pub(super) use coordinator::Controller;

#[derive(Default)]
pub(super) struct Store {
    owners: HashMap<(uuid::Uuid, BrowserIdentity), metadata::MetadataOwner>,
}

impl Store {
    fn metadata(
        &mut self,
        owner: uuid::Uuid,
        identity: BrowserIdentity,
        provider: &ExtensionBrowserProvider,
    ) -> Result<Option<metadata::Metadata>, ToolError> {
        if !provider
            .capabilities()
            .map_err(failed)?
            .download_notifications
        {
            return Ok(None);
        }
        Ok(Some(
            self.owners
                .entry((owner, identity))
                .or_insert_with(|| metadata::MetadataOwner::start(provider))
                .metadata(),
        ))
    }

    pub(super) async fn path(
        &self,
        owner: uuid::Uuid,
        expected_browser: &BrowserIdentity,
        scope: &str,
        extension_id: &str,
    ) -> Result<Value, ToolError> {
        if extension_id.is_empty() {
            return Err(failed("playwright_download_path requires a download_id"));
        }
        let metadata = self
            .owners
            .get(&(owner, expected_browser.clone()))
            .filter(|metadata| metadata.metadata().scope() == scope)
            .map(|metadata| metadata.metadata())
            .ok_or_else(|| failed("Download metadata scope is no longer available"))?;
        metadata.synchronize().await?;
        Ok(json!({"path":metadata.path(extension_id)}))
    }

    pub(super) async fn close_owner(&mut self, owner: uuid::Uuid) -> Result<(), ToolError> {
        let keys = self
            .owners
            .keys()
            .filter(|(candidate, _)| *candidate == owner)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.owners
                .get_mut(&key)
                .expect("retained download metadata owner")
                .close()
                .await?;
            self.owners.remove(&key);
        }
        Ok(())
    }
}

pub(super) fn timeout(options: &BrowserDownloadOptions) -> Result<Duration, ToolError> {
    crate::protocol::timeout_duration(
        options
            .timeout_ms
            .as_ref()
            .and_then(Value::as_f64)
            .unwrap_or(3000.0),
    )
}

fn cleanup(error: impl std::fmt::Display) -> ToolError {
    ToolError::CleanupUnconfirmed(error.to_string())
}

fn required_completion(result: Result<Value, ToolError>) -> Result<(), ToolError> {
    match result {
        Err(
            error @ (ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::OperationCleanupUnconfirmed { .. }),
        ) => Err(error),
        _ => Ok(()),
    }
}

impl Browsers {
    pub(crate) async fn prepare_download(
        &mut self,
        handle: Handle,
        options: BrowserDownloadOptions,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<crate::InvocationCompletion, ToolError> {
        let wait_cancellation = cancellation.child_token();
        let Handle::Tab(handle) = handle else {
            return Err(failed("Download wait requires a browser tab"));
        };
        let identity = self
            .targets
            .get(&handle)
            .ok_or_else(|| failed("stale_tab: bind it again"))?
            .identity()?;
        self.use_tab(&identity, invocation.turn(), cancellation)
            .await?;
        let tab = self
            .targets
            .get_mut(&handle)
            .expect("checked browser handle");
        tab.last_turn = invocation.turn().to_owned();
        // Full-preparation adapters require the distinct fixed-session Host
        // purpose before numeric CDP, including already attached claims. Arm
        // needs no content permission for the current page; response-time
        // effective Origin and Download authorization remain independent.
        tab.prepare_origin_transport(
            invocation,
            cancellation,
            language,
            super::extension::ClaimIntent::Implicit,
        )
        .await?;
        // Browser services are obtained through the original local or remote
        // Host scope, rather than direct fields absent in the Windows worker.
        let document = tab.document();
        let source = tab.document_identity().await?;
        let services = invocation
            .prepare_browser_services(
                crate::BrowserAccess::Metadata {
                    document: document.clone(),
                },
                cancellation,
            )
            .await?;
        tab.refresh_info(super::BrowserCall::new(invocation, cancellation, language))
            .await?;
        if tab.document() != document || tab.document_identity().await? != source {
            return Err(failed(
                "Download document changed during Host service admission",
            ));
        }
        let settlement = services.settlement.ok_or_else(|| {
            failed("Download waits require their original Host settlement custody")
        })?;
        let host = services.effects.ok_or_else(|| {
            failed("Download response handling requires current Host effect admission")
        })?;
        let armed = tab
            .arm_download(options, invocation, &wait_cancellation, host)
            .await?;
        let future = armed.shared();
        let retained = future.clone();
        let required: crate::CheckedSettlementFuture =
            Box::pin(async move { required_completion(retained.await) });
        if let Err((error, pending)) = settlement.retain_checked(required) {
            wait_cancellation.cancel();
            let result = future.await;
            let cleanup = pending.await;
            return match (result, cleanup) {
                (Err(ToolError::CleanupUnconfirmed(cause)), _) => {
                    Err(self::cleanup(format!("{error}; {cause}")))
                }
                (_, Err(cause)) => Err(self::cleanup(format!("{error}; {cause}"))),
                _ => Err(error),
            };
        }
        Ok(crate::InvocationCompletion::pending(async move {
            future
                .await
                .map_err(|error| super::with_unknown_guidance(error, language))
        }))
    }
}

impl Tab {
    pub(super) async fn ensure_downloads(&mut self) -> Result<(), ToolError> {
        self.ensure_downloads_with_host(self.dialog_host.clone())
            .await
    }

    async fn ensure_downloads_with_host(
        &mut self,
        host: Option<std::sync::Arc<dyn crate::BrowserHostEffects>>,
    ) -> Result<(), ToolError> {
        let Some(provider) = self.provider.extension() else {
            return Ok(());
        };
        let socket = self
            .socket
            .as_ref()
            .ok_or_else(|| failed("Download tab is not attached"))?
            .clone();
        if let Some(controller) = &self.downloads {
            controller.update(socket, host);
            return controller.install().await;
        }
        let metadata = self.cursor_host.lock().await.download_metadata.metadata(
            self.cursor_owner,
            self.identity()?.browser,
            provider,
        )?;
        self.downloads = Some(Controller::start(socket, metadata, host));
        // Install custody is retained in Tab before the first Fetch request is polled.
        self.downloads
            .as_ref()
            .expect("retained download interceptor")
            .install()
            .await
    }

    pub(super) async fn cleanup_downloads(&mut self) -> Result<(), ToolError> {
        if let Some(downloads) = self.downloads.as_mut() {
            downloads.close().await?;
        }
        self.downloads = None;
        Ok(())
    }

    /// Explicit Close still owns its current admitted operation. A held
    /// response must use that current socket, not a completed producer clone.
    pub(super) async fn cleanup_downloads_current(&mut self) -> Result<(), ToolError> {
        let socket = self.socket.clone();
        if let Some(downloads) = self.downloads.as_mut() {
            let socket = socket.ok_or_else(|| {
                cleanup("Explicit Close lost its current admitted browser transport")
            })?;
            downloads.close_with_socket(Some(socket)).await?;
        }
        self.downloads = None;
        Ok(())
    }

    async fn arm_download(
        &mut self,
        options: BrowserDownloadOptions,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        host: std::sync::Arc<dyn crate::BrowserHostEffects>,
    ) -> Result<Armed, ToolError> {
        self.ensure_downloads_with_host(Some(host)).await?;
        let authorization = invocation
            .browser_authorization()
            .ok_or_else(|| failed("Browser downloads require Host authorization"))?;
        let controller = self.downloads.as_ref().ok_or_else(|| {
            failed("Extension download notifications are unavailable for this browser provider")
        })?;
        let session_metadata = self
            .session_metadata(BrowserCall::new(invocation, cancellation, Language::En))
            .await?;
        controller
            .arm(
                self.document(),
                session_metadata,
                authorization,
                cancellation.clone(),
                timeout(&options)?,
            )
            .await
    }
}

#[cfg(test)]
mod tests;
