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
    NativeBrowserProvider, NativeEndpointIdentity, NativeProviderError, NativeTabInfo,
    ValidatedNativeEndpoint,
};
use std::sync::Arc;
use tokio::sync::OnceCell;

#[derive(Clone)]
pub(super) enum Provider {
    Cdp(BrowserConnection),
    Native {
        id: String,
        connection: Arc<NativeBrowserProvider>,
    },
}
impl PartialEq for Provider {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Cdp(left), Self::Cdp(right)) => left == right,
            (
                Self::Native {
                    connection: left, ..
                },
                Self::Native {
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
            Self::Native { id, .. } => id,
        }
    }
    pub(super) fn native(&self) -> Option<&Arc<NativeBrowserProvider>> {
        match self {
            Self::Native { connection, .. } => Some(connection),
            Self::Cdp(_) => None,
        }
    }
    pub(super) fn cdp(&self) -> Result<&BrowserConnection, ToolError> {
        match self {
            Self::Cdp(provider) => Ok(provider),
            Self::Native { .. } => Err(failed("native provider requires its owned CDP claim")),
        }
    }
    pub(super) fn api_profile(&self) -> Value {
        // This is Maka's implemented AX facade, not an inferred app feature flag.
        json!({"mode":"ax","user":self.native().is_some()})
    }

    pub(super) fn info(&self) -> Value {
        match self {
            Self::Cdp(provider) => {
                json!({"id":provider.id,"name":provider.id,"type":"cdp","apiProfile":self.api_profile()})
            }
            Self::Native { id, connection } => {
                let identity = connection.identity();
                json!({"id":id,"name":"Chrome","type":"extension","apiProfile":self.api_profile(),"metadata":{"extensionId":identity.extension_id,"extensionInstanceId":identity.instance_id,"generation":identity.generation}})
            }
        }
    }
    pub(super) fn public_tab_id(&self, raw: &str) -> String {
        match self {
            Self::Cdp(provider) => format!("{}:{raw}", provider.id),
            Self::Native { .. } => raw.to_owned(),
        }
    }
    pub(super) async fn inventory(&self) -> Result<(String, Vec<TabInfo>), ToolError> {
        match self {
            Self::Cdp(provider) => inventory(provider).await,
            Self::Native { connection, .. } => {
                if connection.is_closed() {
                    return Err(failed("native browser generation is closed"));
                }
                let tabs = connection.list_user_tabs().await.map_err(native_error)?;
                Ok((
                    connection.identity().generation.clone(),
                    tabs.into_iter().map(native_tab).collect(),
                ))
            }
        }
    }
}

pub(super) fn native_tab(tab: NativeTabInfo) -> TabInfo {
    TabInfo {
        id: tab.id.to_string(),
        title: tab.title.clone().unwrap_or_default(),
        url: tab.url.clone().unwrap_or_default(),
        kind: "page".into(),
        websocket: None,
        native: Some(tab),
    }
}

pub(super) fn native_error(error: NativeProviderError) -> ToolError {
    match error {
        NativeProviderError::ChromeRejected { .. } | NativeProviderError::Refused { .. } => {
            failed(error)
        }
        error => unknown(error),
    }
}

struct CachedNative {
    endpoint: ValidatedNativeEndpoint,
    ready: Arc<OnceCell<Result<Arc<NativeBrowserProvider>, ToolError>>>,
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
pub(crate) struct NativeCache {
    entries: HashMap<CacheIdentity, CachedNative>,
}
impl NativeCache {
    fn cell(
        &mut self,
        owner: uuid::Uuid,
        endpoint: &ValidatedNativeEndpoint,
    ) -> Result<Arc<OnceCell<Result<Arc<NativeBrowserProvider>, ToolError>>>, ToolError> {
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
                    "native descriptor changed its physical endpoint without changing generation",
                ));
            }
            return Ok(entry.ready.clone());
        }
        let ready = Arc::new(OnceCell::new());
        self.entries.insert(
            key,
            CachedNative {
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
    let discovered = match cua_driver_core::browser::discover_installed_native_endpoints().await {
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
            .map(|entry| format!("native browser descriptor rejected: {}", entry.reason)),
    );
    for endpoint in discovered.endpoints {
        let cell = match driver.lock().await.native_browsers.cell(owner, &endpoint) {
            Ok(cell) => cell,
            Err(error) => {
                result.errors.push(error.to_string());
                continue;
            }
        };
        let connection = match cell
            .get_or_init(|| async {
                NativeBrowserProvider::connect(endpoint)
                    .await
                    .map(Arc::new)
                    .map_err(native_error)
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
                .push("native browser generation is closed".into());
            continue;
        }
        let identity: &NativeEndpointIdentity = connection.identity();
        let id = format!(
            "native:{}:{}:{}:{}",
            identity.adapter, identity.extension_id, identity.instance_id, identity.generation
        );
        result.providers.push(Provider::Native { id, connection });
    }
    result
}
