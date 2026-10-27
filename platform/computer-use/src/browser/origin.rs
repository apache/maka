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

use super::{Tab, check_input, failed};
use maka_agent_facts::{language::Language, tools::ToolError};
use serde_json::{Value, json};
use std::time::Duration;

// This private realm only executes this fixed metadata getter. It is never a
// target for caller expressions or the locator/clipboard injected utilities.
const ORIGIN_WORLD: &str = "maka-browser-origin-metadata";
const CONTEXT_DEADLINE: Duration = Duration::from_secs(10);
const ORIGIN_GETTER: &str = r#"(() => {
    const prototype = Object.getOwnPropertyDescriptor(Window.prototype, 'origin');
    const own = Object.getOwnPropertyDescriptor(globalThis, 'origin');
    const getter = typeof prototype?.get === 'function' ? prototype.get : own?.get;
    if (typeof getter !== 'function') throw new Error('native Window.origin getter unavailable');
    return Reflect.apply(getter, globalThis, []);
})()"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DocumentIdentity {
    frame: String,
    loader: String,
    url: String,
}
impl DocumentIdentity {
    pub(super) fn frame_id(&self) -> &str {
        &self.frame
    }
    pub(super) fn loader_id(&self) -> &str {
        &self.loader
    }
    pub(super) fn url(&self) -> &str {
        &self.url
    }
    pub(super) fn frame_token(&self) -> String {
        format!("{}:{}", self.frame_id(), self.loader_id())
    }

    fn from_tree(tree: &Value) -> Result<Self, ToolError> {
        let frame = &tree["frameTree"]["frame"];
        let field = |name: &str| {
            frame[name]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| failed(format!("browser origin metadata lacks {name}")))
        };
        if frame.get("parentId").is_some() {
            return Err(failed(
                "browser origin metadata did not identify the main frame",
            ));
        }
        let mut url = field("url")?;
        if let Some(fragment) = frame.get("urlFragment") {
            let fragment = fragment
                .as_str()
                .ok_or_else(|| failed("browser origin metadata has an invalid URL fragment"))?;
            if !fragment.is_empty() && !fragment.starts_with('#') {
                return Err(failed(
                    "browser origin metadata has an invalid URL fragment",
                ));
            }
            url.push_str(fragment);
        }
        Ok(Self {
            frame: field("id")?,
            loader: field("loaderId")?,
            url,
        })
    }
}

pub(super) struct NavigationAdmission {
    url: String,
    source: DocumentIdentity,
}
impl NavigationAdmission {
    pub(super) fn new(url: &str, source: DocumentIdentity) -> Self {
        Self {
            url: url.to_owned(),
            source,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DocumentOrigin {
    document: crate::BrowserDocument,
    identity: DocumentIdentity,
    origin: crate::BrowserAttachmentOrigin,
    context: String,
}
impl DocumentOrigin {
    pub(super) fn document_identity(&self) -> &DocumentIdentity {
        &self.identity
    }

    pub(super) fn access(&self) -> crate::BrowserAccess {
        crate::BrowserAccess::ReadDocument {
            document: self.document.clone(),
            origin: self.origin.clone(),
        }
    }
    pub(super) fn origin(&self) -> crate::BrowserAttachmentOrigin {
        self.origin.clone()
    }
    pub(super) async fn check_cdp_current(
        &self,
        cdp: &super::Cdp,
        current: &crate::BrowserDocument,
    ) -> Result<(), ToolError> {
        if current != &self.document || document_identity(cdp).await? != self.identity {
            return Err(failed(
                "document changed during browser origin authorization; retry the operation",
            ));
        }
        Ok(())
    }

    pub(super) async fn check_current(&self, tab: &mut Tab) -> Result<(), ToolError> {
        self.check_cdp_current(
            tab.socket
                .as_ref()
                .ok_or_else(|| failed("tab connection unavailable"))?,
            &tab.document(),
        )
        .await
    }
}

fn serialized_origin(value: &Value) -> Result<crate::BrowserAttachmentOrigin, ToolError> {
    if value.get("exceptionDetails").is_some() {
        return Err(failed("fixed browser origin getter did not complete"));
    }
    let raw = value["result"]["value"]
        .as_str()
        .ok_or_else(|| failed("fixed browser origin getter returned no string"))?;
    if raw == "null" {
        return Ok(crate::BrowserAttachmentOrigin::Opaque);
    }
    let url = reqwest::Url::parse(raw)
        .map_err(|_| failed("browser origin getter returned an unsupported origin"))?;
    if !matches!(url.scheme(), "http" | "https") || url.origin().ascii_serialization() != raw {
        return Err(failed(
            "browser origin getter returned an unsupported origin",
        ));
    }
    Ok(crate::BrowserAttachmentOrigin::Site(raw.to_owned()))
}

/// Resolve the same fixed origin getter using an existing owned CDP route.
/// The caller admits metadata first and supplies freshly observed tab metadata;
/// this function grants no authority and cannot run caller-provided expressions.
pub(super) async fn resolve_document_origin(
    cdp: &super::Cdp,
    document: crate::BrowserDocument,
    previous: Option<&DocumentOrigin>,
) -> Result<DocumentOrigin, ToolError> {
    let before = document_identity(cdp).await?;
    if before.url() != document.url {
        return Err(failed(
            "browser tab metadata and current document differ; retry the operation",
        ));
    }
    let reusable = previous
        .filter(|proof| proof.document == document && proof.identity == before)
        .map(|proof| proof.context.clone());
    let context = match reusable {
        Some(context) => context,
        None => {
            let name = format!("{ORIGIN_WORLD}-{}", uuid::Uuid::new_v4());
            let mut events = cdp.connection.subscribe();
            cdp.request_in(None, "Runtime.enable", json!({})).await?;
            let world = cdp
                .request_in(
                    None,
                    "Page.createIsolatedWorld",
                    json!({
                        "frameId": before.frame, "worldName": name,
                        "grantUniveralAccess": false,
                    }),
                )
                .await?;
            let id = world["executionContextId"]
                .as_u64()
                .ok_or_else(|| failed("browser origin isolated context was not returned"))?;
            let deadline = tokio::time::Instant::now() + CONTEXT_DEADLINE;
            loop {
                let event = tokio::time::timeout_at(deadline, events.recv())
                    .await
                    .map_err(|_| failed("browser origin context identity was not observed"))?
                    .ok_or_else(|| failed("browser origin context event stream ended"))?;
                if event.session_id.is_some() || event.method != "Runtime.executionContextCreated" {
                    continue;
                }
                let candidate = &event.params["context"];
                if candidate["id"].as_u64() != Some(id) {
                    continue;
                }
                if candidate["name"].as_str() != Some(name.as_str())
                    || candidate["auxData"]["frameId"].as_str() != Some(before.frame.as_str())
                    || candidate["auxData"]["isDefault"] != false
                {
                    return Err(failed(
                        "browser origin context does not belong to the selected isolated main frame",
                    ));
                }
                break candidate["uniqueId"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| failed("browser origin context lacks its unique identity"))?
                    .to_owned();
            }
        }
    };
    if document_identity(cdp).await? != before {
        return Err(failed(
            "document changed while creating the browser origin context",
        ));
    }
    let result = cdp
        .observe_in(
            None,
            "Runtime.evaluate",
            json!({
                "uniqueContextId": context, "expression": ORIGIN_GETTER, "returnByValue": true,
            }),
        )
        .await?;
    let after = document_identity(cdp).await?;
    if before != after {
        return Err(failed(
            "document changed during fixed browser origin observation",
        ));
    }
    let proof = DocumentOrigin {
        document,
        identity: before,
        origin: serialized_origin(&result)?,
        context,
    };
    Ok(proof)
}

async fn document_identity(cdp: &super::Cdp) -> Result<DocumentIdentity, ToolError> {
    DocumentIdentity::from_tree(&cdp.request_in(None, "Page.getFrameTree", json!({})).await?)
}

impl Tab {
    pub(super) async fn document_identity(&mut self) -> Result<DocumentIdentity, ToolError> {
        DocumentIdentity::from_tree(&self.request("Page.getFrameTree", json!({})).await?)
    }

    pub(super) async fn check_navigation(&mut self, url: &str) -> Result<(), ToolError> {
        let admission = self
            .navigation_admission
            .take()
            .ok_or_else(|| failed("browser navigation lacks current destination admission"))?;
        if admission.url != url || self.document_identity().await? != admission.source {
            return Err(failed(
                "document changed before navigation dispatch; retry the operation",
            ));
        }
        Ok(())
    }

    pub(super) async fn document_origin(&mut self) -> Result<DocumentOrigin, ToolError> {
        let document = self.document();
        let proof = resolve_document_origin(
            self.socket
                .as_ref()
                .ok_or_else(|| failed("tab connection unavailable"))?,
            document.clone(),
            self.origin_proof.as_ref(),
        )
        .await?;
        if self.document() != document {
            return Err(failed(
                "document changed during fixed browser origin observation",
            ));
        }
        self.origin_proof = Some(proof.clone());
        Ok(proof)
    }

    /// Obtain transport for the fixed effective-origin observation. Adapters
    /// whose attachment also prepares a session require that separate bounded
    /// Host purpose before dispatch; Metadata alone never admits those effects.
    pub(super) async fn prepare_origin_transport(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
        intent: super::native::ClaimIntent,
    ) -> Result<(), ToolError> {
        match self.provider.native() {
            Some(native) => {
                let capabilities = native
                    .capabilities()
                    .map_err(super::provider::native_error)?;
                match capabilities.attachment_preparation {
                    cua_driver_core::browser::NativeAttachmentPreparation::FullPreparation => {
                        // Original numeric CDP can re-enter fixed preparation on
                        // an existing claim too. A prior admission is not current
                        // authority for a later turn/replacement document.
                        self.prepare_native_session(invocation, cancellation, language, intent)
                            .await
                    }
                    cua_driver_core::browser::NativeAttachmentPreparation::MetadataOnly => {
                        self.prepare_metadata(invocation, cancellation, language)
                            .await
                    }
                    cua_driver_core::browser::NativeAttachmentPreparation::Unknown => Err(failed(
                        "selected native adapter has not classified its attachment preparation",
                    )),
                }
            }
            None => {
                self.prepare_metadata(invocation, cancellation, language)
                    .await
            }
        }
    }

    /// Open only the existing transport and fixed metadata path. Content hooks,
    /// focus emulation, headers, overlays and descendant attachment stay out.
    pub(super) async fn prepare_metadata(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        self.refresh_info(language).await?;
        let document = self.document();
        invocation
            .authorize_browser(
                crate::BrowserAccess::Metadata {
                    document: document.clone(),
                },
                cancellation,
            )
            .await?;
        self.refresh_info(language).await?;
        if self.document() != document {
            return Err(failed("document changed during browser metadata admission"));
        }
        check_input(cancellation)?;
        if self.provider.native().is_some() {
            self.attach_native_metadata(invocation, cancellation)
                .await?;
        }
        self.connect_metadata().await?;
        check_input(cancellation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_origin_uses_fixed_getter_instead_of_frame_url_or_security_origin() {
        let inherited =
            serialized_origin(&json!({"result":{"value":"https://denied.example"}})).unwrap();
        assert_eq!(
            inherited,
            crate::BrowserAttachmentOrigin::Site("https://denied.example".into())
        );
        assert_eq!(
            serialized_origin(&json!({"result":{"value":"null"}})).unwrap(),
            crate::BrowserAttachmentOrigin::Opaque
        );
        for value in [
            json!({"result":{"value":"://"}}),
            json!({"result":{"value":"https://site.example/"}}),
            json!({"result":{"value":"chrome://newtab"}}),
            json!({"result":{"value":"null"},"exceptionDetails":{}}),
        ] {
            assert!(
                serialized_origin(&value).is_err(),
                "unsupported getter result accepted: {value}"
            );
        }
    }

    #[test]
    fn same_url_replacement_and_non_main_frames_have_distinct_identity() {
        let original = DocumentIdentity::from_tree(&json!({"frameTree":{"frame":{"id":"main","loaderId":"first","url":"about:blank","securityOrigin":"://"}}})).unwrap();
        let replacement = DocumentIdentity::from_tree(
            &json!({"frameTree":{"frame":{"id":"main","loaderId":"second","url":"about:blank"}}}),
        )
        .unwrap();
        assert_ne!(
            original, replacement,
            "same URL must not hide a document replacement"
        );
        assert!(DocumentIdentity::from_tree(&json!({"frameTree":{"frame":{"id":"child","loaderId":"second","url":"about:blank","parentId":"main"}}})).is_err());
    }

    #[test]
    fn document_identity_retains_route_and_empty_fragments_reported_separately_by_cdp() {
        for (fragment, expected) in [
            (None, "https://site.example/"),
            (Some(""), "https://site.example/"),
            (Some("#"), "https://site.example/#"),
            (Some("#route"), "https://site.example/#route"),
        ] {
            let mut tree = json!({"frameTree":{"frame":{"id":"main","loaderId":"first","url":"https://site.example/"}}});
            if let Some(fragment) = fragment {
                tree["frameTree"]["frame"]["urlFragment"] = json!(fragment);
            }
            assert_eq!(
                DocumentIdentity::from_tree(&tree).unwrap().url,
                expected,
                "fragment: {fragment:?}"
            );
        }
        assert!(DocumentIdentity::from_tree(&json!({"frameTree":{"frame":{"id":"main","loaderId":"first","url":"https://site.example/","urlFragment":"route"}}})).is_err());
    }
}
