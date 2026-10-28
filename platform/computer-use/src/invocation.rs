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

use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

pub type AuthorizationFuture = Pin<Box<dyn Future<Output = Result<(), ToolError>> + Send>>;

/// The remainder of an already dispatched request whose physical result has
/// been independently confirmed. Completion observes that same request's reply.
pub type SettlementFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// Per-call custody supplied by the original Host invocation. A rejection must
/// return the future intact so the caller can drain it before returning.
pub trait OperationSettlement: Send + Sync {
    fn retain(&self, pending: SettlementFuture) -> Result<(), (ToolError, SettlementFuture)>;
}

pub type HostEffectFuture = Pin<Box<dyn Future<Output = Result<(), ToolError>> + Send + 'static>>;

/// The security origin reported by the bound browser execution context. An
/// about:blank frame can inherit a site origin; its URL cannot substitute here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrowserAttachmentOrigin {
    Site(String),
    Opaque,
}

/// Check-only authority for an actual attached page between Agent calls. This
/// capability follows the logical Turn and VM attachment, never a saved Run.
pub trait BrowserAttachmentAuthorization: Send + Sync {
    fn check(
        &self,
        origin: BrowserAttachmentOrigin,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture;
}

/// Existing Host-service admission for automatic attached-browser effects.
/// The future must be unpolled: rejection cannot leave a dispatched request.
/// This capability never grants site access or fabricates an Agent invocation.
pub trait BrowserHostEffects: Send + Sync {
    fn spawn(&self, unpolled: HostEffectFuture) -> Result<(), ToolError>;
}

/// The selected browser's current document, resolved by the platform backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserDocument {
    pub browser_id: String,
    pub generation: String,
    pub tab_id: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserAccess {
    Read {
        document: BrowserDocument,
    },
    Navigate {
        document: BrowserDocument,
        url: String,
    },
}

impl BrowserAccess {
    pub fn document(&self) -> &BrowserDocument {
        match self {
            Self::Read { document } | Self::Navigate { document, .. } => document,
        }
    }

    pub fn url(&self) -> &str {
        match self {
            Self::Read { document } => &document.url,
            Self::Navigate { url, .. } => url,
        }
    }

    pub fn origin(&self) -> Result<Option<String>, ToolError> {
        if self.url() == "about:blank" {
            return Ok(None);
        }
        let url = reqwest::Url::parse(self.url())
            .map_err(|error| ToolError::Failed(format!("invalid browser URL: {error}")))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ToolError::Failed(
                "browser access supports HTTP(S) and about:blank".into(),
            ));
        }
        Ok(Some(url.origin().ascii_serialization()))
    }
}

/// Implemented by the embedding Host using its actual invocation and grants.
/// `check` never requests a new grant, including for asynchronous page events.
pub trait BrowserAuthorization: Send + Sync {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture;
    fn check(&self, access: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture;
    fn attachment(&self) -> Option<Arc<dyn BrowserAttachmentAuthorization>> {
        None
    }
}

/// Trusted Host context. It is never deserialized from a model command.
#[derive(Clone)]
pub struct InvocationContext<'a> {
    session: &'a str,
    turn: &'a str,
    browser_authorization: Option<Arc<dyn BrowserAuthorization>>,
    operation_settlement: Option<Arc<dyn OperationSettlement>>,
    browser_host_effects: Option<Arc<dyn BrowserHostEffects>>,
    app_target: Option<crate::ComputerAppTarget>,
}

impl<'a> InvocationContext<'a> {
    pub fn new(session: &'a str, turn: &'a str) -> Self {
        Self {
            session,
            turn,
            browser_authorization: None,
            operation_settlement: None,
            browser_host_effects: None,
            app_target: None,
        }
    }

    pub fn with_browser_authorization(
        mut self,
        authorization: Arc<dyn BrowserAuthorization>,
    ) -> Self {
        self.browser_authorization = Some(authorization);
        self
    }

    pub fn session(&self) -> &str {
        self.session
    }

    pub fn with_operation_settlement(mut self, settlement: Arc<dyn OperationSettlement>) -> Self {
        self.operation_settlement = Some(settlement);
        self
    }

    pub fn with_browser_host_effects(mut self, effects: Arc<dyn BrowserHostEffects>) -> Self {
        self.browser_host_effects = Some(effects);
        self
    }

    pub(crate) fn operation_settlement(&self) -> Option<Arc<dyn OperationSettlement>> {
        self.operation_settlement.clone()
    }

    pub(crate) fn browser_host_effects(&self) -> Option<Arc<dyn BrowserHostEffects>> {
        self.browser_host_effects.clone()
    }

    /// Freeze the native subject for this invocation. Approval remains Host-owned.
    pub fn with_app_target(mut self, target: crate::ComputerAppTarget) -> Self {
        self.app_target = Some(target);
        self
    }

    pub fn app_target(&self) -> Option<&crate::ComputerAppTarget> {
        self.app_target.as_ref()
    }

    pub fn turn(&self) -> &str {
        self.turn
    }

    pub(crate) fn browser_authorization(&self) -> Option<Arc<dyn BrowserAuthorization>> {
        self.browser_authorization.clone()
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) async fn authorize_browser(
        &self,
        access: BrowserAccess,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed("Browser authorization cancelled".into()));
        }
        if access.origin()?.is_none() {
            return Ok(());
        }
        let authorization = self.browser_authorization.as_ref().ok_or_else(|| {
            ToolError::Failed("Browser site access requires Host authorization".into())
        })?;
        authorization
            .authorize(access, cancellation.clone())
            .await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed("Browser authorization cancelled".into()));
        }
        Ok(())
    }
}
