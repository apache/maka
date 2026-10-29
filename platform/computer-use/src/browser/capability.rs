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

//! Effective capability implementations use the existing owned tab/CDP path.
use super::*;
use crate::protocol::browser_capability::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
pub(super) mod viewport;

const RESOURCES: &str = include_str!("capability/resources.js");
const SVGS: &str = include_str!("capability/svgs.js");
mod discover;
const FETCH: &str = include_str!("capability/fetch.js");
const STYLES: [&str; 5] = [
    "background-image",
    "border-image-source",
    "cursor",
    "list-style-image",
    "mask-image",
];

pub(super) fn browser_info() -> Value {
    json!([{"id":"viewport","description":"Set or reset explicit dimensions for the session's active browser tab."}])
}
pub(super) fn tab_info() -> Value {
    json!([{"id":"pageAssets","description":"Inspect loaded page assets and save selected assets in a temporary bundle."}])
}
fn short_digest(input: &str) -> String {
    hex::encode(&Sha256::digest(input.as_bytes())[..8])
}

#[derive(Clone, Debug)]
enum Discovered {
    Resource(Asset),
    Svg(InlineSvg),
}
impl Discovered {
    fn id(&self) -> &str {
        match self {
            Self::Resource(a) => &a.id,
            Self::Svg(a) => &a.id,
        }
    }
    fn kind(&self) -> Kind {
        match self {
            Self::Resource(a) => a.kind,
            Self::Svg(_) => Kind::Image,
        }
    }
    fn name(&self) -> &str {
        match self {
            Self::Resource(a) => &a.name,
            Self::Svg(a) => &a.name,
        }
    }
    fn url(&self) -> String {
        match self {
            Self::Resource(a) => a.url.clone(),
            Self::Svg(a) => format!("inline-svg:{}", a.id),
        }
    }
    fn failure(&self, content_type: Option<String>, reason: String) -> Failure {
        Failure {
            content_type,
            id: self.id().into(),
            name: self.name().into(),
            reason,
            url: self.url(),
        }
    }
}
struct RetainedInventory {
    document_url: String,
    assets: Vec<Discovered>,
}
/// This is tab-local snapshot data, never an authorization or target registry.
#[derive(Default)]
pub(super) struct Inventories {
    retained: HashMap<String, RetainedInventory>,
}
impl Inventories {
    fn insert(
        &mut self,
        document_url: String,
        assets: Vec<Asset>,
        svgs: Vec<InlineSvg>,
    ) -> Inventory {
        let id = uuid::Uuid::new_v4().to_string();
        let mut by_kind = [
            Kind::Font,
            Kind::Image,
            Kind::Other,
            Kind::Script,
            Kind::Stylesheet,
            Kind::Video,
        ]
        .into_iter()
        .map(|kind| (kind, 0))
        .collect::<std::collections::BTreeMap<_, _>>();
        for asset in &assets {
            *by_kind.get_mut(&asset.kind).expect("all asset kinds") += 1;
        }
        let summary = Summary {
            by_kind,
            total_count: assets.len(),
            inline_svg_count: svgs.len(),
        };
        let mut retained: Vec<Discovered> = Vec::new();
        for asset in assets
            .iter()
            .cloned()
            .map(Discovered::Resource)
            .chain(svgs.iter().cloned().map(Discovered::Svg))
        {
            if let Some(index) = retained.iter().position(|prior| prior.id() == asset.id()) {
                retained[index] = asset;
            } else {
                retained.push(asset)
            }
        }
        self.retained.insert(
            id.clone(),
            RetainedInventory {
                document_url: document_url.clone(),
                assets: retained,
            },
        );
        Inventory {
            id,
            assets,
            inline_svgs: svgs,
            page_url: Some(document_url),
            summary,
        }
    }
    fn select(&self, url: &str, options: &BundleOptions) -> Result<Vec<Discovered>, ToolError> {
        let inventory = self
            .retained
            .get(&options.inventory_id)
            .filter(|inventory| inventory.document_url == url)
            .ok_or_else(|| failed("Asset inventory is no longer valid for this page"))?;
        let selected = if let Some(ids) = &options.asset_ids {
            let mut selected = Vec::new();
            for id in ids {
                selected.push(
                    inventory
                        .assets
                        .iter()
                        .find(|asset| asset.id() == id)
                        .ok_or_else(|| failed("Asset bundle request included unknown asset ids"))?
                        .clone(),
                );
            }
            selected
        } else {
            inventory.assets.clone()
        };
        let selected = selected
            .into_iter()
            .filter(|asset| {
                options
                    .kinds
                    .as_ref()
                    .is_none_or(|kinds| kinds.iter().any(|kind| kind.kind() == asset.kind()))
            })
            .collect::<Vec<_>>();
        if options.asset_ids.is_some() && selected.iter().any(|asset| !asset.kind().bundleable()) {
            return Err(failed(
                "Asset bundle request included unsupported asset kinds",
            ));
        }
        let selected = selected
            .into_iter()
            .filter(|asset| asset.kind().bundleable())
            .collect::<Vec<_>>();
        if selected.is_empty() {
            return Err(failed("Asset bundle request matched no discovered assets"));
        }
        Ok(selected)
    }
}

fn evaluated_value(reply: Value) -> Result<Value, ToolError> {
    if let Some(error) = reply.get("exceptionDetails") {
        return Err(failed(
            error["exception"]["description"]
                .as_str()
                .or_else(|| error["text"].as_str())
                .unwrap_or("Page evaluation failed"),
        ));
    }
    Ok(reply["result"]["value"].clone())
}

async fn evaluate(tab: &Tab, expression: String) -> Result<Value, ToolError> {
    let reply = tab
        .frame_request(
            None,
            "Runtime.evaluate",
            json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
        )
        .await?;
    evaluated_value(reply)
}

impl Tab {
    pub(super) async fn page_assets_list(
        &mut self,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        self.authorize(None, call.invocation, call.cancellation, call.language)
            .await?;
        self.verify(call).await?;
        let url = self.info.url.clone();
        let tab: &Tab = self;
        let (assets, svgs) = tokio::join!(
            async {
                let snapshot = tab
                    .frame_observation(
                        None,
                        "DOMSnapshot.captureSnapshot",
                        json!({"computedStyles":STYLES,"includeDOMRects":false}),
                    )
                    .await?;
                let resources = evaluate(tab, format!("({RESOURCES})()")).await?;
                let resources: Vec<discover::Resource> =
                    serde_json::from_value(resources).map_err(failed)?;
                Ok::<_, ToolError>(discover::assets(&snapshot, resources))
            },
            evaluate(tab, format!("({SVGS})()"))
        );
        let assets = assets?;
        let svgs = svgs?;
        let svgs = svgs
            .as_array()
            .ok_or_else(|| failed("Invalid SVG observation"))?
            .iter()
            .enumerate()
            .filter_map(|(index, svg)| {
                let markup = svg["markup"].as_str().filter(|s| !s.is_empty())?;
                Some(InlineSvg {
                    id: short_digest(&format!("{index}:{markup}")),
                    markup: markup.into(),
                    name: svg["name"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("svg-{}", index + 1)),
                })
            })
            .collect::<Vec<_>>();
        check_input(call.cancellation)?;
        // Navigation here does not retroactively relabel the captured snapshot.
        // Original inventory lifetime is exact tab + URL, not loader/epoch.
        serde_json::to_value(self.page_assets.insert(url, assets, svgs)).map_err(failed)
    }

    pub(super) async fn page_assets_bundle(
        &mut self,
        options: BundleOptions,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        self.authorize(None, call.invocation, call.cancellation, call.language)
            .await?;
        self.verify(call).await?;
        let selected = self.page_assets.select(&self.info.url, &options)?;
        let document = self.document();
        let source_origin = self.document_origin().await?.origin();
        let began = std::time::Instant::now();
        let services = call
            .invocation
            .prepare_browser_services(
                crate::BrowserAccess::ReadDocument {
                    document: document.clone(),
                    origin: source_origin.clone(),
                },
                call.cancellation,
            )
            .await?;
        let publisher = services
            .files
            .ok_or_else(|| failed("Page asset bundles require the current Host file service"))?;
        call.invocation
            .authorize_browser(
                crate::BrowserAccess::PageAssetDownload {
                    document: document.clone(),
                    source_origin: source_origin.clone(),
                },
                call.cancellation,
            )
            .await?;
        self.refresh_info(call).await?;
        let proof = self.document_origin().await?;
        if self.document() != document || proof.origin() != source_origin {
            return Err(failed("Asset inventory is no longer valid for this page"));
        }
        let source = BundleSource {
            document,
            proof,
            call,
            fallback: Default::default(),
        };
        source.check_current(self).await?;
        let mut directory = publisher.begin(call.cancellation.clone()).await?;
        self.publish_assets(selected, &source, &mut directory, publisher, began)
            .await
    }

    async fn publish_assets(
        &self,
        selected: Vec<Discovered>,
        source: &BundleSource<'_>,
        directory: &mut Box<dyn crate::BrowserAssetDirectory>,
        publisher: std::sync::Arc<dyn crate::BrowserAssetFiles>,
        began: std::time::Instant,
    ) -> Result<Value, ToolError> {
        let result = async {
            let bundle = self
                .bundle_assets(selected, source, directory, publisher, began)
                .await?;
            source.check_current(self).await?;
            // The exact owned directory remains abortable after commit. Its
            // real Host epoch already owns the physical cleanup obligation.
            directory.commit(source.call.cancellation.clone()).await?;
            source.check_current(self).await?;
            serde_json::to_value(bundle).map_err(failed)
        }
        .await;
        match result {
            Ok(value) => Ok(value),
            Err(error) => match directory.abort().await {
                Ok(()) => Err(error),
                Err(cleanup) => Err(ToolError::CleanupUnconfirmed(format!(
                    "{error}; page asset bundle cleanup: {cleanup}"
                ))),
            },
        }
    }

    async fn bundle_assets(
        &self,
        selected: Vec<Discovered>,
        source: &BundleSource<'_>,
        directory: &mut Box<dyn crate::BrowserAssetDirectory>,
        publisher: std::sync::Arc<dyn crate::BrowserAssetFiles>,
        began: std::time::Instant,
    ) -> Result<Bundle, ToolError> {
        let requested_count = selected.len();
        let directory_path = directory.path().to_owned();
        let directory = tokio::sync::Mutex::new(directory);
        // Join every original read/write before inspecting failures or aborting.
        let items = futures_util::future::join_all(
            selected
                .into_iter()
                .map(|asset| self.bundle_asset(asset, source, &directory, &publisher)),
        )
        .await;
        let mut error = source.fallback.lock().await.failed.clone();
        let mut assets = Vec::new();
        let mut failures = Vec::new();
        for item in items {
            match item {
                Ok(asset) => assets.push(asset),
                Err(ItemError::Failure(failure)) => failures.push(failure),
                Err(ItemError::Fatal(failure)) => retain_error(&mut error, failure),
            }
        }
        if let Some(error) = error {
            return Err(error);
        }
        source.check_current(self).await?;
        let manifest = serde_json::to_vec_pretty(&json!({"assets":assets,"failures":failures}))
            .map_err(failed)?;
        let resource = publisher.snapshot("manifest.json".into(), manifest)?;
        let future = {
            let mut directory = directory.lock().await;
            source.check_current(self).await?;
            directory.write(
                "manifest.json".into(),
                resource,
                source.call.cancellation.clone(),
            )
        };
        let manifest_path = future.await?;
        source.check_current(self).await?;
        Ok(Bundle {
            summary: BundleSummary {
                downloaded_count: assets.len(),
                failed_count: failures.len(),
                requested_count,
                elapsed_ms: began.elapsed().as_secs_f64() * 1000.0,
            },
            assets,
            failures,
            directory_path,
            manifest_path,
        })
    }

    async fn bundle_asset(
        &self,
        asset: Discovered,
        source: &BundleSource<'_>,
        directory: &tokio::sync::Mutex<&mut Box<dyn crate::BrowserAssetDirectory>>,
        publisher: &std::sync::Arc<dyn crate::BrowserAssetFiles>,
    ) -> Result<BundledAsset, ItemError> {
        source.check_current(self).await.map_err(ItemError::Fatal)?;
        let payload = match &asset {
            Discovered::Svg(svg) => Ok((
                Some("image/svg+xml".into()),
                svg.markup.as_bytes().to_vec(),
                ".svg".to_owned(),
            )),
            Discovered::Resource(item) => {
                let loaded = self.loaded_asset(&item.url).await;
                if let Err(error) = &loaded
                    && fatal(error)
                {
                    source.remember(error.clone()).await;
                    return Err(ItemError::Fatal(error.clone()));
                }
                source.check_current(self).await.map_err(ItemError::Fatal)?;
                let value = match loaded {
                    Ok(value) => value,
                    Err(loaded_error) => {
                        source
                            .approve_fallback(self, &item.url)
                            .await
                            .map_err(ItemError::Fatal)?;
                        match self.fetch_asset(&item.url, source).await {
                            Ok(value) => value,
                            Err(error) if fatal(&error) => {
                                source.remember(error.clone()).await;
                                return Err(ItemError::Fatal(error));
                            }
                            Err(error) => {
                                if source.fallback.lock().await.failed.is_some() {
                                    return Err(ItemError::Fatal(error));
                                }
                                return Err(ItemError::Failure(asset.failure(None, format!("Loaded resource fetch failed: {loaded_error}; page fetch failed: {error}"))));
                            }
                        }
                    }
                };
                decode_asset(value, &item.url)
            }
        };
        let (content_type, bytes, extension) = payload.map_err(|error| {
            if fatal(&error) {
                ItemError::Fatal(error)
            } else {
                ItemError::Failure(asset.failure(None, error.to_string()))
            }
        })?;
        if !valid_content_type(asset.kind(), content_type.as_deref(), &asset.url()) {
            let normalized = normalize_mime(content_type.as_deref());
            return Err(ItemError::Failure(asset.failure(
                normalized.clone(),
                format!(
                        "Asset response type {} is not valid for {}",
                        normalized.as_deref().unwrap_or("missing"),
                        serde_json::to_value(asset.kind())
                            .expect("kind")
                            .as_str()
                            .expect("kind string")
                    ),
            )));
        }
        source.check_current(self).await.map_err(ItemError::Fatal)?;
        let name = format!("{}{}", asset.id(), extension);
        let resource = publisher
            .snapshot(name.clone(), bytes)
            .map_err(ItemError::Fatal)?;
        let future = {
            let mut directory = directory.lock().await;
            source.check_current(self).await.map_err(ItemError::Fatal)?;
            directory.write(name, resource, source.call.cancellation.clone())
        };
        let written = future.await;
        if let Err(error) = &written
            && fatal(error)
        {
            source.remember(error.clone()).await;
            return Err(ItemError::Fatal(error.clone()));
        }
        source.check_current(self).await.map_err(ItemError::Fatal)?;
        let path =
            written.map_err(|error| ItemError::Failure(asset.failure(None, error.to_string())))?;
        Ok(BundledAsset {
            content_type,
            id: asset.id().into(),
            kind: asset.kind(),
            name: asset.name().into(),
            path,
            url: asset.url(),
        })
    }

    async fn fetch_asset(&self, url: &str, source: &BundleSource<'_>) -> Result<Value, ToolError> {
        source.check_current(self).await?;
        let group = format!("maka-page-asset-{}", uuid::Uuid::new_v4());
        // Capture the actual main-world receiver, then bracket it with the
        // original frame/loader/origin. An objectId cannot retarget a new page.
        let receiver = self
            .frame_request(
                None,
                "Runtime.evaluate",
                json!({
                    "expression":"this", "returnByValue":false, "objectGroup":group,
                }),
            )
            .await;
        let result = async {
            let receiver = receiver?;
            let object = receiver["result"]["objectId"].as_str().ok_or_else(|| failed("Page asset fetch receiver was not captured"))?;
            source.check_current(self).await?;
            let reply = self.frame_request(None, "Runtime.callFunctionOn", json!({
                "objectId":object,"functionDeclaration":format!("function(url){{return ({FETCH})(url);}}"),
                "arguments":[{"value":url}],"returnByValue":true,"awaitPromise":true,"objectGroup":group,
            })).await;
            if let Err(error) = &reply && fatal(error) { return Err(error.clone()); }
            source.check_current(self).await?;
            evaluated_value(reply?)
        }.await;
        let released = self
            .frame_request(
                None,
                "Runtime.releaseObjectGroup",
                json!({"objectGroup":group}),
            )
            .await;
        let mut error = None;
        if let Err(failure) = &result {
            retain_error(&mut error, failure.clone());
        }
        if let Err(failure) = released {
            let failure = if fatal(&failure) {
                failure
            } else {
                ToolError::CleanupUnconfirmed(format!(
                    "Page asset fetch receiver cleanup: {failure}"
                ))
            };
            retain_error(&mut error, failure);
        }
        if let Some(error) = error {
            return Err(error);
        }
        result
    }

    async fn loaded_asset(&self, url: &str) -> Result<Value, ToolError> {
        let tree = self
            .frame_observation(None, "Page.getFrameTree", json!({}))
            .await?;
        let frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or_else(|| failed("Unable to determine frame id"))?;
        self.frame_request(None, "Page.enable", json!({})).await?;
        let (content, tree) = tokio::join!(
            self.frame_observation(
                None,
                "Page.getResourceContent",
                json!({"frameId":frame,"url":url})
            ),
            self.frame_observation(None, "Page.getResourceTree", json!({}))
        );
        let content = content?;
        let tree = tree?;
        let encoded = content["base64Encoded"].as_bool() == Some(true);
        let content = content["content"]
            .as_str()
            .ok_or_else(|| failed("Unable to bundle asset"))?;
        Ok(
            json!({"base64": if encoded {content.to_owned()} else {base64::engine::general_purpose::STANDARD.encode(content.as_bytes())}, "contentType":resource_mime(&tree["frameTree"],url)}),
        )
    }
}

/// Captured inputs of one bundle, never a cached transfer grant.
struct BundleSource<'a> {
    document: crate::BrowserDocument,
    proof: origin::DocumentOrigin,
    call: BrowserCall<'a>,
    fallback: tokio::sync::Mutex<FallbackGate>,
}
impl BundleSource<'_> {
    fn download(&self) -> crate::BrowserAccess {
        crate::BrowserAccess::PageAssetDownload {
            document: self.document.clone(),
            source_origin: self.proof.origin(),
        }
    }
    fn fallback_request(&self, url: &str) -> crate::BrowserAccess {
        crate::BrowserAccess::PageAssetFallbackFetch {
            document: self.document.clone(),
            source_origin: self.proof.origin(),
            url: url.to_owned(),
        }
    }
    async fn remember(&self, error: ToolError) -> ToolError {
        retain_error(&mut self.fallback.lock().await.failed, error.clone());
        error
    }
    async fn check_source(&self, tab: &Tab) -> Result<(), ToolError> {
        check_input(self.call.cancellation)?;
        let cdp = tab
            .socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?;
        self.proof.check_cdp_current(cdp, &tab.document()).await?;
        let current =
            origin::resolve_document_origin(cdp, self.document.clone(), Some(&self.proof)).await?;
        if current.document_identity() != self.proof.document_identity()
            || current.origin() != self.proof.origin()
        {
            return Err(failed("Page asset source document or origin changed"));
        }
        Ok(())
    }
    async fn check_current(&self, tab: &Tab) -> Result<(), ToolError> {
        let urls = {
            let gate = self.fallback.lock().await;
            if let Some(error) = &gate.failed {
                return Err(error.clone());
            }
            gate.allowed.values().flatten().cloned().collect::<Vec<_>>()
        };
        let result = async {
            self.check_source(tab).await?;
            let authorization = self
                .call
                .invocation
                .browser_authorization()
                .ok_or_else(|| failed("Page asset bundles require current Host authorization"))?;
            authorization
                .check(self.download(), self.call.cancellation.clone())
                .await?;
            for url in urls {
                authorization
                    .check(self.fallback_request(&url), self.call.cancellation.clone())
                    .await?;
            }
            self.check_source(tab).await
        }
        .await;
        match result {
            Ok(()) => Ok(()),
            Err(error) => Err(self.remember(error).await),
        }
    }
    async fn approve_fallback(&self, tab: &Tab, url: &str) -> Result<(), ToolError> {
        let origin = asset_origin(url).unwrap_or_else(|| url.to_owned());
        let request = self.fallback_request(url);
        self.check_current(tab).await?;
        {
            let mut gate = self.fallback.lock().await;
            if let Some(error) = &gate.failed {
                return Err(error.clone());
            }
            if !gate.allowed.contains_key(&origin) {
                if let Err(error) = self
                    .call
                    .invocation
                    .authorize_browser(request.clone(), self.call.cancellation)
                    .await
                {
                    retain_error(&mut gate.failed, error.clone());
                    return Err(error);
                }
                gate.allowed.insert(origin.clone(), Vec::new());
            }
        }
        // Prompt deduplication is not a document binding or a current grant.
        let result = async {
            self.check_source(tab).await?;
            self.call
                .invocation
                .browser_authorization()
                .ok_or_else(|| failed("Page asset bundles require current Host authorization"))?
                .check(request, self.call.cancellation.clone())
                .await?;
            self.check_source(tab).await
        }
        .await;
        if let Err(error) = result {
            return Err(self.remember(error).await);
        }
        let mut gate = self.fallback.lock().await;
        if let Some(error) = &gate.failed {
            return Err(error.clone());
        }
        let urls = gate
            .allowed
            .get_mut(&origin)
            .expect("recorded prompt origin");
        if !urls.iter().any(|current| current == url) {
            urls.push(url.to_owned());
        }
        Ok(())
    }
}

fn retain_error(current: &mut Option<ToolError>, error: ToolError) {
    if current
        .as_ref()
        .is_none_or(|previous| !fatal(previous) && fatal(&error))
    {
        *current = Some(error);
    }
}

#[derive(Default)]
struct FallbackGate {
    // Origin keys coalesce prompts; URL rows are inputs to current checks only.
    allowed: HashMap<String, Vec<String>>,
    failed: Option<ToolError>,
}
enum ItemError {
    Failure(Failure),
    Fatal(ToolError),
}
fn fatal(error: &ToolError) -> bool {
    matches!(
        error,
        ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OperationCleanupUnconfirmed { .. }
            | ToolError::Persistence(_)
    )
}

fn asset_origin(url: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(url).ok()?;
    match url.scheme() {
        "http" | "https" => Some(url.origin().ascii_serialization()),
        "file" => {
            url.set_query(None);
            url.set_fragment(None);
            Some(url.to_string())
        }
        _ => None,
    }
}

fn resource_mime<'a>(tree: &'a Value, url: &str) -> Option<&'a str> {
    if let Some(found) = tree["resources"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["url"].as_str() == Some(url)))
        .and_then(|item| item["mimeType"].as_str())
    {
        return Some(found);
    }
    tree["childFrames"]
        .as_array()?
        .iter()
        .find_map(|child| resource_mime(child, url))
}
fn decode_asset(value: Value, url: &str) -> Result<(Option<String>, Vec<u8>, String), ToolError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            value["base64"]
                .as_str()
                .ok_or_else(|| failed("Unable to bundle asset"))?,
        )
        .map_err(failed)?;
    let mime = value["contentType"].as_str().map(str::to_owned);
    let path = reqwest::Url::parse(url)
        .ok()
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|| url.split(['?', '#']).next().unwrap_or("").into());
    let name = path.rsplit('/').next().unwrap_or("");
    let extension = name
        .rfind('.')
        .filter(|index| *index > 0)
        .map(|index| name[index..].to_owned())
        .unwrap_or_default();
    Ok((mime, bytes, extension))
}
fn valid_content_type(kind: Kind, content_type: Option<&str>, url: &str) -> bool {
    let mime = normalize_mime(content_type);
    let Some(mime) = mime else {
        return kind == Kind::Stylesheet;
    };
    if mime == "application/octet-stream" {
        let path = reqwest::Url::parse(url)
            .ok()
            .map(|url| url.path().to_ascii_lowercase())
            .unwrap_or_else(|| {
                url.split(['?', '#'])
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase()
            });
        let ext = path.rsplit('.').next().unwrap_or("");
        return match kind {
            Kind::Font => matches!(ext, "otf" | "ttf" | "woff" | "woff2"),
            Kind::Image => matches!(
                ext,
                "avif" | "gif" | "ico" | "jpg" | "jpeg" | "png" | "svg" | "webp"
            ),
            Kind::Stylesheet => ext == "css",
            Kind::Video => matches!(ext, "mp4" | "mov" | "m4v" | "webm"),
            _ => false,
        };
    }
    match kind {
        Kind::Font => {
            mime.starts_with("font/")
                || matches!(
                    mime.as_str(),
                    "application/font-woff"
                        | "application/font-woff2"
                        | "application/vnd.ms-fontobject"
                        | "application/x-font-opentype"
                        | "application/x-font-ttf"
                )
        }
        Kind::Image => mime.starts_with("image/"),
        Kind::Stylesheet => mime == "text/css",
        Kind::Video => mime.starts_with("video/"),
        _ => false,
    }
}

fn normalize_mime(content_type: Option<&str>) -> Option<String> {
    let value = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
    };
    let valid = value
        .split_once('/')
        .is_some_and(|(major, minor)| token(major) && token(minor));
    Some(if valid { value } else { "invalid".into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn asset(id: &str, kind: Kind) -> Asset {
        Asset {
            id: id.into(),
            kind,
            name: id.into(),
            sources: vec![],
            url: format!("https://fixture.test/{id}"),
        }
    }
    fn options(id: &str, ids: Option<Vec<&str>>, kinds: Option<Vec<BundleKind>>) -> BundleOptions {
        BundleOptions {
            inventory_id: id.into(),
            asset_ids: ids.map(|ids| ids.into_iter().map(str::to_owned).collect()),
            kinds,
        }
    }
    #[test]
    fn inventory_selection_preserves_original_order_duplicates_and_filter_errors() {
        let mut store = Inventories::default();
        let inventory = store.insert(
            "https://fixture.test/page#one".into(),
            vec![asset("script", Kind::Script), asset("image", Kind::Image)],
            vec![],
        );
        assert_eq!(
            store
                .select(
                    "https://fixture.test/page#one",
                    &options(&inventory.id, None, None)
                )
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .select(
                    "https://fixture.test/page#one",
                    &options(&inventory.id, Some(vec!["image", "image"]), None)
                )
                .unwrap()
                .len(),
            2
        );
        assert!(
            store
                .select(
                    "https://fixture.test/page#two",
                    &options(&inventory.id, None, None)
                )
                .unwrap_err()
                .to_string()
                .contains("no longer valid")
        );
        assert!(
            store
                .select(
                    "https://fixture.test/page#one",
                    &options(&inventory.id, Some(vec!["missing"]), Some(vec![]))
                )
                .unwrap_err()
                .to_string()
                .contains("unknown asset ids")
        );
        assert!(
            store
                .select(
                    "https://fixture.test/page#one",
                    &options(&inventory.id, Some(vec!["script"]), None)
                )
                .unwrap_err()
                .to_string()
                .contains("unsupported asset kinds")
        );
        assert!(
            store
                .select(
                    "https://fixture.test/page#one",
                    &options(
                        &inventory.id,
                        Some(vec!["script"]),
                        Some(vec![BundleKind::Image])
                    )
                )
                .unwrap_err()
                .to_string()
                .contains("matched no discovered assets")
        );
        // Original retains exact URL inventories across a same-URL document refresh.
        assert!(
            store
                .select(
                    "https://fixture.test/page#one",
                    &options(&inventory.id, None, None)
                )
                .is_ok()
        );
    }
    #[test]
    fn bundle_mime_checks_use_kind_and_normalized_response_not_extension_alone() {
        assert!(valid_content_type(
            Kind::Image,
            Some("IMAGE/PNG; charset=x"),
            "https://f.test/x"
        ));
        assert!(!valid_content_type(
            Kind::Image,
            Some("text/html"),
            "https://f.test/x.png"
        ));
        assert!(!valid_content_type(
            Kind::Image,
            Some("image/"),
            "https://f.test/x.png"
        ));
        assert!(valid_content_type(
            Kind::Image,
            Some("application/octet-stream"),
            "https://f.test/x.PNG?a=1"
        ));
        assert!(valid_content_type(
            Kind::Stylesheet,
            None,
            "https://f.test/no-extension"
        ));
        assert!(!valid_content_type(
            Kind::Font,
            None,
            "https://f.test/font.woff2"
        ));
    }
    #[test]
    fn viewport_has_no_invented_u16_cap_and_rejects_non_integer_dimensions() {
        assert!(
            Viewport {
                width: 100000.0,
                height: 1.0
            }
            .validate()
            .is_ok()
        );
        for width in [0.0, -1.0, 0.5, f64::INFINITY, 9_007_199_254_740_992.0] {
            assert!(Viewport { width, height: 1.0 }.validate().is_err());
        }
    }
    use maka_capabilities::call::{OwnedTempDirectory, ReadResource};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use tokio::sync::{Notify, oneshot};

    #[derive(Default)]
    struct TransferAuthority {
        allowed: AtomicBool,
        prompts: AtomicUsize,
    }
    impl crate::BrowserAuthorization for TransferAuthority {
        fn authorize(
            &self,
            access: crate::BrowserAccess,
            _: CancellationToken,
        ) -> crate::AuthorizationFuture {
            assert!(matches!(
                access,
                crate::BrowserAccess::PageAssetFallbackFetch { .. }
            ));
            self.prompts.fetch_add(1, Ordering::SeqCst);
            let allowed = self.allowed.load(Ordering::SeqCst);
            Box::pin(async move {
                if allowed {
                    Ok(())
                } else {
                    Err(failed("fixture Download revoked"))
                }
            })
        }
        fn check(
            &self,
            access: crate::BrowserAccess,
            _: CancellationToken,
        ) -> crate::AuthorizationFuture {
            assert!(
                matches!(
                    access,
                    crate::BrowserAccess::PageAssetDownload { .. }
                        | crate::BrowserAccess::PageAssetFallbackFetch { .. }
                ),
                "Site read is not Download consent"
            );
            let allowed = self.allowed.load(Ordering::SeqCst);
            Box::pin(async move {
                if allowed {
                    Ok(())
                } else {
                    Err(failed("fixture Download revoked"))
                }
            })
        }
    }
    #[derive(Default)]
    struct Hold {
        entered: Notify,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }
    impl Hold {
        fn armed() -> (Arc<Self>, oneshot::Sender<()>) {
            let (release, receive) = oneshot::channel();
            (
                Arc::new(Self {
                    entered: Notify::new(),
                    release: Mutex::new(Some(receive)),
                }),
                release,
            )
        }
        async fn wait(&self) {
            let release = self.release.lock().unwrap().take();
            if let Some(release) = release {
                self.entered.notify_one();
                release.await.unwrap();
            }
        }
    }
    struct WireState {
        page: Mutex<(String, String)>,
        read: Option<Arc<Hold>>,
        loaded_error: bool,
        fetches: Mutex<Vec<String>>,
    }
    impl WireState {
        fn new(read: Option<Arc<Hold>>, loaded_error: bool) -> Arc<Self> {
            Arc::new(Self {
                page: Mutex::new(("https://fixture.test/page".into(), "original".into())),
                read,
                loaded_error,
                fetches: Mutex::new(Vec::new()),
            })
        }
    }
    async fn asset_tab(state: Arc<WireState>) -> (Tab, tokio::task::JoinHandle<()>) {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut wire = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = wire.next().await {
                let request: Value = serde_json::from_str(&text).unwrap();
                let method = request["method"].as_str().unwrap();
                let mut reply = json!({"id":request["id"],"result":{}});
                match method {
                    "Page.getFrameTree" => {
                        let (url, loader) = state.page.lock().unwrap().clone();
                        reply["result"] = json!({"frameTree":{"frame":{"id":"root","loaderId":loader,"url":url}}});
                    }
                    "Page.createIsolatedWorld" => {
                        reply["result"] = json!({"executionContextId":7});
                        wire.send(Message::Text(json!({"method":"Runtime.executionContextCreated","params":{"context":{"id":7,"uniqueId":"origin-world","name":request["params"]["worldName"],"auxData":{"frameId":"root","isDefault":false}}}}).to_string().into())).await.unwrap();
                    }
                    "Runtime.evaluate" if request["params"]["expression"] == "this" => {
                        let (_, loader) = state.page.lock().unwrap().clone();
                        reply["result"] = json!({"result":{"type":"object","objectId":format!("window-{loader}")}});
                    }
                    "Runtime.evaluate" => {
                        let url = state.page.lock().unwrap().0.clone();
                        let origin = reqwest::Url::parse(&url)
                            .unwrap()
                            .origin()
                            .ascii_serialization();
                        reply["result"] = json!({"result":{"value":origin}});
                    }
                    "Page.getResourceContent" => {
                        if let Some(hold) = &state.read {
                            hold.wait().await;
                        }
                        if state.loaded_error {
                            reply = json!({"id":request["id"],"error":{"code":-32000,"message":"fixture resource unavailable"}});
                        } else {
                            reply["result"] = json!({"content":"aGVsbG8=","base64Encoded":true});
                        }
                    }
                    "Page.getResourceTree" => {
                        reply["result"] = json!({"frameTree":{"resources":[{"url":"https://assets.test/one.png","mimeType":"image/png"},{"url":"https://assets.test/two.png","mimeType":"image/png"}]}});
                    }
                    "Runtime.callFunctionOn" => {
                        let object = request["params"]["objectId"].as_str().unwrap().to_owned();
                        state.fetches.lock().unwrap().push(object);
                        reply["result"] = json!({"result":{"value":{"base64":"aGVsbG8=","contentType":"image/png"}}});
                    }
                    "Runtime.enable" | "Page.enable" | "Runtime.releaseObjectGroup" => {}
                    other => panic!("unexpected asset fixture command: {other}"),
                }
                if wire
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let provider = BrowserConnection {
            id: "fixture".into(),
            endpoint: format!("http://{address}"),
        };
        let socket = Cdp::connect(&format!("ws://{address}"), &provider)
            .await
            .unwrap();
        let mut browsers = Browsers::default();
        let cancellation = CancellationToken::new();
        let invocation = crate::InvocationContext::new("asset-fixture", "turn");
        let bound = browsers
            .bind(
                TabSource {
                    provider: Provider::Cdp(provider),
                    generation: format!("ws://{address}"),
                    info: TabInfo {
                        id: "17".into(),
                        title: String::new().into(),
                        url: "https://fixture.test/page".into(),
                        kind: "page".into(),
                        websocket: None,
                        extension: None,
                    },
                },
                InitialState::Deferred,
                &invocation,
                &cancellation,
                Language::En,
            )
            .await
            .unwrap();
        let Handle::Tab(handle) = serde_json::from_value(bound["handle"].clone()).unwrap() else {
            panic!("fixture tab handle");
        };
        let mut tab = browsers.targets.remove(&handle).unwrap();
        tab.socket = Some(socket);
        tab.socket_prepared = true;
        (tab, server)
    }
    #[derive(Clone, Copy, Default)]
    enum RevokeAt {
        #[default]
        Never,
        Manifest,
        Commit,
    }
    struct Publications {
        authority: Arc<TransferAuthority>,
        writes: AtomicUsize,
        snapshots: AtomicUsize,
        commits: AtomicUsize,
        aborts: AtomicUsize,
        directory: Mutex<Option<Arc<OwnedTempDirectory>>>,
        hold_write: Option<Arc<Hold>>,
        revoke: RevokeAt,
    }
    impl Publications {
        fn new(
            authority: Arc<TransferAuthority>,
            revoke: RevokeAt,
            hold_write: Option<Arc<Hold>>,
        ) -> Arc<Self> {
            Arc::new(Self {
                authority,
                writes: AtomicUsize::new(0),
                snapshots: AtomicUsize::new(0),
                commits: AtomicUsize::new(0),
                aborts: AtomicUsize::new(0),
                directory: Mutex::new(None),
                hold_write,
                revoke,
            })
        }
        fn path(&self) -> std::path::PathBuf {
            self.directory
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .path()
                .to_owned()
        }
    }
    struct TestFiles(Arc<Publications>);
    struct TestDirectory {
        state: Arc<Publications>,
        native: Arc<OwnedTempDirectory>,
        path: String,
    }
    impl crate::BrowserAssetFiles for TestFiles {
        fn snapshot(
            &self,
            name: String,
            bytes: Vec<u8>,
        ) -> Result<Arc<dyn ReadResource>, ToolError> {
            self.0.snapshots.fetch_add(1, Ordering::SeqCst);
            Ok(maka_capabilities::call::immutable_bytes(name, bytes))
        }
        fn begin(
            &self,
            _: CancellationToken,
        ) -> crate::FilesFuture<Box<dyn crate::BrowserAssetDirectory>> {
            let state = self.0.clone();
            Box::pin(async move {
                let native = Arc::new(
                    tokio::task::spawn_blocking(|| {
                        OwnedTempDirectory::create("maka-assets-keeper-")
                    })
                    .await
                    .unwrap()
                    .map_err(failed)?,
                );
                *state.directory.lock().unwrap() = Some(native.clone());
                let path = native.path().to_str().unwrap().to_owned();
                Ok(Box::new(TestDirectory {
                    state,
                    native,
                    path,
                }) as Box<dyn crate::BrowserAssetDirectory>)
            })
        }
    }
    impl crate::BrowserAssetDirectory for TestDirectory {
        fn path(&self) -> &str {
            &self.path
        }
        fn write(
            &mut self,
            name: String,
            resource: Arc<dyn ReadResource>,
            cancellation: CancellationToken,
        ) -> crate::FilesFuture<String> {
            let state = self.state.clone();
            let native = self.native.clone();
            Box::pin(async move {
                if let Some(hold) = &state.hold_write {
                    hold.wait().await;
                }
                let manifest = name == "manifest.json";
                let path = tokio::task::spawn_blocking(move || {
                    native.write(&name, resource.as_ref(), &cancellation)
                })
                .await
                .unwrap()
                .map_err(failed)?;
                state.writes.fetch_add(1, Ordering::SeqCst);
                if manifest && matches!(state.revoke, RevokeAt::Manifest) {
                    state.authority.allowed.store(false, Ordering::SeqCst);
                }
                Ok(path.to_str().unwrap().to_owned())
            })
        }
        fn commit(&mut self, _: CancellationToken) -> crate::FilesFuture<()> {
            let state = self.state.clone();
            Box::pin(async move {
                state.commits.fetch_add(1, Ordering::SeqCst);
                if matches!(state.revoke, RevokeAt::Commit) {
                    state.authority.allowed.store(false, Ordering::SeqCst);
                }
                Ok(())
            })
        }
        fn abort(&mut self) -> crate::FilesFuture<()> {
            let state = self.state.clone();
            let native = self.native.clone();
            Box::pin(async move {
                state.aborts.fetch_add(1, Ordering::SeqCst);
                tokio::task::spawn_blocking(move || native.close())
                    .await
                    .unwrap()
                    .map_err(failed)
            })
        }
    }
    fn resource(id: &str) -> Discovered {
        Discovered::Resource(Asset {
            id: id.into(),
            kind: Kind::Image,
            name: id.into(),
            sources: vec![],
            url: format!("https://assets.test/{id}.png"),
        })
    }
    fn inline() -> Discovered {
        Discovered::Svg(InlineSvg {
            id: "svg".into(),
            name: "svg".into(),
            markup: "<svg/>".into(),
        })
    }
    async fn source<'a>(
        tab: &mut Tab,
        invocation: &'a crate::InvocationContext<'a>,
        cancellation: &'a CancellationToken,
    ) -> BundleSource<'a> {
        let proof = tab.document_origin().await.unwrap();
        BundleSource {
            document: tab.document(),
            proof,
            call: BrowserCall::new(invocation, cancellation, Language::En),
            fallback: Default::default(),
        }
    }
    async fn publish(
        mut tab: Tab,
        authority: Arc<TransferAuthority>,
        files: Arc<Publications>,
        assets: Vec<Discovered>,
    ) -> Result<Value, ToolError> {
        let cancellation = CancellationToken::new();
        let invocation = crate::InvocationContext::new("asset-fixture", "turn")
            .with_operation_id("original-operation".into())
            .with_browser_authorization(authority);
        let source = source(&mut tab, &invocation, &cancellation).await;
        let publisher = Arc::new(TestFiles(files)) as Arc<dyn crate::BrowserAssetFiles>;
        let mut directory = publisher.begin(cancellation.clone()).await?;
        tab.publish_assets(
            assets,
            &source,
            &mut directory,
            publisher,
            std::time::Instant::now(),
        )
        .await
    }
    fn allowed() -> Arc<TransferAuthority> {
        Arc::new(TransferAuthority {
            allowed: AtomicBool::new(true),
            prompts: AtomicUsize::new(0),
        })
    }
    async fn entered(hold: &Hold) {
        tokio::time::timeout(Duration::from_secs(5), hold.entered.notified())
            .await
            .expect("actual fixture I/O must enter");
    }

    #[tokio::test]
    async fn download_revocation_during_actual_deferred_resource_read_prevents_publication() {
        let (hold, release) = Hold::armed();
        let state = WireState::new(Some(hold.clone()), false);
        let (tab, server) = asset_tab(state).await;
        let authority = allowed();
        let files = Publications::new(authority.clone(), RevokeAt::Never, None);
        let pending = tokio::spawn(publish(
            tab,
            authority.clone(),
            files.clone(),
            vec![resource("one")],
        ));
        entered(&hold).await;
        authority.allowed.store(false, Ordering::SeqCst);
        assert!(!pending.is_finished());
        assert_eq!(
            files.aborts.load(Ordering::SeqCst),
            0,
            "the original read has not settled"
        );
        release.send(()).unwrap();
        let error = pending.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("Download revoked"));
        assert_eq!(files.snapshots.load(Ordering::SeqCst), 0);
        assert_eq!(files.writes.load(Ordering::SeqCst), 0);
        assert_eq!(files.commits.load(Ordering::SeqCst), 0);
        assert_eq!(files.aborts.load(Ordering::SeqCst), 1);
        assert!(!files.path().exists());
        server.abort();
    }
    #[tokio::test]
    async fn manifest_and_commit_revoke_boundaries_abort_the_same_directory_without_a_path_result()
    {
        for revoke in [RevokeAt::Manifest, RevokeAt::Commit] {
            let (tab, server) = asset_tab(WireState::new(None, false)).await;
            let authority = allowed();
            let files = Publications::new(authority.clone(), revoke, None);
            let error = publish(tab, authority, files.clone(), vec![inline()])
                .await
                .unwrap_err();
            assert!(error.to_string().contains("Download revoked"));
            assert_eq!(files.writes.load(Ordering::SeqCst), 2);
            assert_eq!(
                files.commits.load(Ordering::SeqCst),
                usize::from(matches!(revoke, RevokeAt::Commit))
            );
            assert_eq!(files.aborts.load(Ordering::SeqCst), 1);
            assert!(!files.path().exists());
            server.abort();
        }
    }
    #[tokio::test]
    async fn download_revoke_keeps_an_admitted_file_write_until_its_actual_terminal_before_abort() {
        let (hold, release) = Hold::armed();
        let (tab, server) = asset_tab(WireState::new(None, false)).await;
        let authority = allowed();
        let files = Publications::new(authority.clone(), RevokeAt::Never, Some(hold.clone()));
        let pending = tokio::spawn(publish(
            tab,
            authority.clone(),
            files.clone(),
            vec![inline()],
        ));
        entered(&hold).await;
        authority.allowed.store(false, Ordering::SeqCst);
        assert!(!pending.is_finished());
        assert_eq!(files.aborts.load(Ordering::SeqCst), 0);
        assert!(files.path().exists());
        release.send(()).unwrap();
        assert!(
            pending
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("Download revoked")
        );
        assert_eq!(files.writes.load(Ordering::SeqCst), 1);
        assert_eq!(files.commits.load(Ordering::SeqCst), 0);
        assert_eq!(files.aborts.load(Ordering::SeqCst), 1);
        assert!(!files.path().exists());
        server.abort();
    }
    #[tokio::test]
    async fn cached_fallback_prompt_never_authorizes_a_replacement_document_fetch() {
        for url in ["https://other.test/page", "https://fixture.test/page"] {
            let state = WireState::new(None, true);
            let (mut tab, server) = asset_tab(state.clone()).await;
            let authority = allowed();
            let cancellation = CancellationToken::new();
            let invocation = crate::InvocationContext::new("asset-fixture", "turn")
                .with_operation_id("original-operation".into())
                .with_browser_authorization(authority.clone());
            let source = source(&mut tab, &invocation, &cancellation).await;
            source
                .approve_fallback(&tab, "https://assets.test/one.png")
                .await
                .unwrap();
            tab.fetch_asset("https://assets.test/one.png", &source)
                .await
                .unwrap();
            assert_eq!(authority.prompts.load(Ordering::SeqCst), 1);
            assert_eq!(*state.fetches.lock().unwrap(), ["window-original"]);
            *state.page.lock().unwrap() = (url.into(), "replacement".into());
            assert!(
                source
                    .approve_fallback(&tab, "https://assets.test/two.png")
                    .await
                    .is_err()
            );
            assert_eq!(
                authority.prompts.load(Ordering::SeqCst),
                1,
                "cached prompt is not a fresh grant"
            );
            assert_eq!(
                state.fetches.lock().unwrap().len(),
                1,
                "replacement main world never receives the old source's fixed FETCH"
            );
            server.abort();
        }
    }
}
