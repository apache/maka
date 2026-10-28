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
use cua_driver_core::browser::{
    ExtensionAdapterMode, ExtensionBrowserProvider, ExtensionEndpointIdentity,
    ExtensionProviderError, ExtensionTabInfo, ValidatedExtensionEndpoint,
};
use std::sync::Arc;
use tokio::sync::OnceCell;

#[derive(Clone)]
pub(super) enum Provider {
    Cdp(BrowserConnection),
    Extension {
        id: String,
        connection: Arc<ExtensionBrowserProvider>,
    },
}
impl PartialEq for Provider {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Cdp(left), Self::Cdp(right)) => left == right,
            (
                Self::Extension {
                    connection: left, ..
                },
                Self::Extension {
                    connection: right, ..
                },
            ) => Arc::ptr_eq(left, right),
            _ => false,
        }
    }
}
impl Eq for Provider {}
impl From<BrowserConnection> for Provider {
    fn from(value: BrowserConnection) -> Self {
        Self::Cdp(value)
    }
}
impl Provider {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Cdp(provider) => &provider.id,
            Self::Extension { id, .. } => id,
        }
    }
    pub(super) fn extension(&self) -> Option<&Arc<ExtensionBrowserProvider>> {
        match self {
            Self::Extension { connection, .. } => Some(connection),
            Self::Cdp(_) => None,
        }
    }
    pub(super) fn extension_mode(&self) -> Option<ExtensionAdapterMode> {
        match self {
            Self::Extension { connection, .. } if !connection.is_closed() => {
                ExtensionAdapterMode::from_host_name(&connection.identity().adapter)
            }
            _ => None,
        }
    }
    pub(super) fn cdp(&self) -> Result<&BrowserConnection, ToolError> {
        match self {
            Self::Cdp(provider) => Ok(provider),
            Self::Extension { .. } => {
                Err(failed("extension provider requires its owned CDP claim"))
            }
        }
    }
    pub(super) fn api_profile(&self) -> Value {
        // This is Maka's implemented AX facade, not an inferred app feature flag.
        json!({"mode":"ax","user":self.extension().is_some()})
    }

    pub(super) fn info(&self) -> Value {
        match self {
            Self::Cdp(provider) => {
                json!({"id":provider.id,"name":provider.id,"type":"cdp","apiProfile":self.api_profile()})
            }
            Self::Extension { id, connection } => {
                let identity = connection.identity();
                let mode = self.extension_mode();
                let name = mode.map_or("Extension", |mode| mode.display_name());
                json!({"id":id,"name":name,"type":"extension","apiProfile":self.api_profile(),"metadata":{"extensionId":identity.extension_id,"extensionInstanceId":identity.instance_id,"generation":identity.generation}})
            }
        }
    }
    pub(super) fn public_tab_id(&self, raw: &str) -> String {
        match self {
            Self::Cdp(provider) => format!("{}:{raw}", provider.id),
            Self::Extension { .. } => raw.to_owned(),
        }
    }
    pub(super) async fn inventory(&self) -> Result<(String, Vec<TabInfo>), ToolError> {
        match self {
            Self::Cdp(provider) => inventory(provider).await,
            Self::Extension { connection, .. } => {
                if connection.is_closed() {
                    return Err(failed("extension browser generation is closed"));
                }
                let tabs = connection.list_user_tabs().await.map_err(extension_error)?;
                Ok((
                    connection.identity().generation.clone(),
                    tabs.into_iter().map(extension_tab).collect(),
                ))
            }
        }
    }
}

pub(super) fn extension_tab(tab: ExtensionTabInfo) -> TabInfo {
    TabInfo {
        id: tab.id.to_string(),
        title: tab.title.clone().unwrap_or_default(),
        url: tab.url.clone().unwrap_or_default(),
        kind: "page".into(),
        websocket: None,
        extension: Some(tab),
    }
}

pub(super) fn extension_error(
    error: impl std::borrow::Borrow<ExtensionProviderError>,
) -> ToolError {
    let error = error.borrow();
    match error {
        ExtensionProviderError::ChromeRejected { .. }
        | ExtensionProviderError::Refused { .. }
        | ExtensionProviderError::NotDispatched { .. } => failed(error),
        error => unknown(error),
    }
}

type ExtensionProviderCell = Arc<OnceCell<Result<Arc<ExtensionBrowserProvider>, ToolError>>>;

struct CachedExtension {
    endpoint: ValidatedExtensionEndpoint,
    ready: ExtensionProviderCell,
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheIdentity {
    owner: uuid::Uuid,
    adapter: String,
    extension: String,
    instance: String,
    generation: String,
    host_pid: u32,
}
#[derive(Default)]
pub(crate) struct ExtensionCache {
    entries: HashMap<CacheIdentity, CachedExtension>,
}
impl ExtensionCache {
    fn cell(
        &mut self,
        owner: uuid::Uuid,
        endpoint: &ValidatedExtensionEndpoint,
    ) -> Result<ExtensionProviderCell, ToolError> {
        let identity = endpoint.identity();
        let key = CacheIdentity {
            owner,
            adapter: identity.adapter.clone(),
            extension: identity.extension_id.clone(),
            instance: identity.instance_id.clone(),
            generation: identity.generation.clone(),
            host_pid: identity.host_pid,
        };
        if let Some(entry) = self.entries.get(&key) {
            if !entry.endpoint.same_endpoint(endpoint) {
                return Err(failed(
                    "extension descriptor changed its physical endpoint without changing generation",
                ));
            }
            return Ok(entry.ready.clone());
        }
        let ready = Arc::new(OnceCell::new());
        self.entries.insert(
            key,
            CachedExtension {
                endpoint: endpoint.clone(),
                ready: ready.clone(),
            },
        );
        Ok(ready)
    }
    pub(crate) async fn close_owner(&mut self, owner: uuid::Uuid) {
        let keys: Vec<_> = self
            .entries
            .keys()
            .filter(|identity| identity.owner == owner)
            .cloned()
            .collect();
        for key in keys {
            if let Some(entry) = self.entries.remove(&key)
                && let Some(Ok(connection)) = entry.ready.get()
            {
                connection.close().await;
            }
        }
    }
}

#[derive(Default)]
pub(super) struct Discovery {
    pub providers: Vec<Provider>,
    pub errors: Vec<String>,
}

pub(super) async fn discover(
    driver: &Arc<tokio::sync::Mutex<crate::Driver>>,
    owner: uuid::Uuid,
) -> Discovery {
    let mut result = Discovery::default();
    let discovered = match cua_driver_core::browser::discover_installed_extension_endpoints().await
    {
        Ok(discovered) => discovered,
        Err(error) => {
            result.errors.push(error.to_string());
            return result;
        }
    };
    result.errors.extend(
        discovered
            .rejected
            .into_iter()
            .map(|entry| format!("extension browser descriptor rejected: {}", entry.reason)),
    );
    for endpoint in discovered.endpoints {
        let cell = match driver
            .lock()
            .await
            .extension_browsers
            .cell(owner, &endpoint)
        {
            Ok(cell) => cell,
            Err(error) => {
                result.errors.push(error.to_string());
                continue;
            }
        };
        let connection = match cell
            .get_or_init(|| async {
                ExtensionBrowserProvider::connect(endpoint)
                    .await
                    .map(Arc::new)
                    .map_err(extension_error)
            })
            .await
            .clone()
        {
            Ok(connection) => connection,
            Err(error) => {
                result.errors.push(error.to_string());
                continue;
            }
        };
        if connection.is_closed() {
            result
                .errors
                .push("extension browser generation is closed".into());
            continue;
        }
        let identity: &ExtensionEndpointIdentity = connection.identity();
        let id = format!(
            "extension:{}:{}:{}:{}",
            identity.adapter, identity.extension_id, identity.instance_id, identity.generation
        );
        result
            .providers
            .push(Provider::Extension { id, connection });
    }
    result
}

// Exact IDs keep their endpoint and generation, including configured CDP IDs
// named maka/chatgpt. Only an unmatched shortcut filters extension identities.
pub(super) fn selection_mask<'provider>(
    selector: Option<&str>,
    providers: impl IntoIterator<Item = (&'provider str, Option<ExtensionAdapterMode>)>,
) -> Result<Vec<bool>, ToolError> {
    let providers = providers.into_iter().collect::<Vec<_>>();
    let exact = selector.is_some_and(|selector| providers.iter().any(|(id, _)| *id == selector));
    let short = selector.filter(|selector| !exact && matches!(*selector, "maka" | "chatgpt"));
    let selected = providers
        .into_iter()
        .map(|(id, mode)| match selector {
            None => true,
            Some(selector) if short.is_some() => {
                mode.is_some_and(|mode| mode.selector() == selector)
            }
            Some(selector) => id == selector,
        })
        .collect::<Vec<_>>();
    if let Some(selector) = short {
        match selected.iter().filter(|selected| **selected).count() {
            0 => {
                return Err(failed(format!(
                    "browser_unavailable: no current {} extension provider",
                    selector
                )));
            }
            1 => {}
            _ => {
                return Err(failed(format!(
                    "browser_ambiguous: multiple current {} extension providers; use a full browser ID",
                    selector
                )));
            }
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod selector_tests {
    use super::*;

    const MAKA: &str =
        "extension:org.apache.maka.browser_connector:fixture:instance-a:generation-1";
    const CHATGPT: &str = "extension:com.openai.codexextension:fixture:instance-b:generation-2";
    const OTHER_MAKA: &str =
        "extension:org.apache.maka.browser_connector:fixture:instance-c:generation-3";

    fn mode(host: &str) -> Option<ExtensionAdapterMode> {
        ExtensionAdapterMode::from_host_name(host)
    }

    #[test]
    fn unique_brand_shortcut_selects_the_existing_full_generation_identity() {
        for (selector, expected) in [("maka", vec![true, false]), ("chatgpt", vec![false, true])] {
            let selected = selection_mask(
                Some(selector),
                [
                    (MAKA, mode("org.apache.maka.browser_connector")),
                    (CHATGPT, mode("com.openai.codexextension")),
                ],
            )
            .unwrap();
            assert_eq!(selected, expected);
            let ids = [MAKA, CHATGPT]
                .into_iter()
                .zip(selected)
                .filter_map(|(id, keep)| keep.then_some(id))
                .collect::<Vec<_>>();
            assert_eq!(ids, [if selector == "maka" { MAKA } else { CHATGPT }]);
        }
    }

    #[test]
    fn configured_cdp_id_stays_exact_when_a_same_named_extension_appears() {
        for selector in ["maka", "chatgpt"] {
            let selected = selection_mask(
                Some(selector),
                [
                    (selector, None),
                    (MAKA, mode("org.apache.maka.browser_connector")),
                    (CHATGPT, mode("com.openai.codexextension")),
                ],
            )
            .unwrap();
            assert_eq!(selected, [true, false, false]);
        }
    }

    #[test]
    fn unmatched_brand_requires_a_current_recognized_extension() {
        for selector in ["maka", "chatgpt"] {
            let error = selection_mask(
                Some(selector),
                [
                    ("existing-profile", None),
                    (
                        "extension:unknown:fixture:instance:generation",
                        mode("unrecognized.host"),
                    ),
                ],
            )
            .unwrap_err();
            assert!(error.to_string().contains("browser_unavailable"));
        }
    }

    #[test]
    fn multiple_current_brand_endpoints_are_ambiguous_without_profile_priority() {
        let error = selection_mask(
            Some("maka"),
            [
                (MAKA, mode("org.apache.maka.browser_connector")),
                (OTHER_MAKA, mode("org.apache.maka.browser_connector")),
            ],
        )
        .unwrap_err();
        assert!(error.to_string().contains("browser_ambiguous"));
    }

    #[test]
    fn exact_ids_and_unfiltered_inventory_preserve_existing_selection_semantics() {
        for (selector, expected) in [
            (None, vec![true, true, true]),
            (Some(MAKA), vec![true, false, false]),
            (Some("existing-profile"), vec![false, false, true]),
            (
                Some(
                    "extension:org.apache.maka.browser_connector:fixture:instance-a:stale-generation",
                ),
                vec![false, false, false],
            ),
            (
                Some("extension:org.apache.maka.browser_connector:"),
                vec![false, false, false],
            ),
        ] {
            let selected = selection_mask(
                selector,
                [
                    (MAKA, mode("org.apache.maka.browser_connector")),
                    (OTHER_MAKA, mode("org.apache.maka.browser_connector")),
                    ("existing-profile", None),
                ],
            )
            .unwrap();
            assert_eq!(selected, expected, "selector={selector:?}");
        }
    }
}
