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

mod patch;
pub use patch::{HeaderPatch, SecretChange, SecretsPatch};

use maka_capabilities::credentials;
use maka_capabilities::storage;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "DecisionsProtocol")]
pub enum Protocol {
    Jev,
    #[serde(rename = "openai_decisions")]
    OpenAiDecisions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "DecisionsSettings")]
pub struct Settings {
    pub protocol: Protocol,
    pub enabled: bool,
    pub url: String,
    pub model: String,
    pub timeout_ms: u64,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            protocol: Protocol::Jev,
            enabled: false,
            url: "https://api.typesafe.ai/v1/systemone".into(),
            model: "jev-latest".into(),
            timeout_ms: 8000,
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<(), storage::StoreError> {
        let url = url::Url::parse(&self.url).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || self.model.trim().is_empty()
            || self.model.chars().any(char::is_control)
            || self.timeout_ms == 0
        {
            return Err(invalid());
        }
        Ok(())
    }
    // Changing the destination must never forward a credential saved for another endpoint.
    pub fn credential_key(&self) -> String {
        format!(
            "endpoint-{}",
            hex::encode(Sha256::digest(self.url.as_bytes()))
        )
    }
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "DecisionsSnapshot")]
pub struct Snapshot {
    pub revision: Option<u64>,
    pub settings: Settings,
    pub credential_revision: Option<u64>,
    pub configured: bool,
    pub api_key_configured: bool,
    pub header_names: Vec<String>,
}
#[derive(Clone)]
pub struct Repository {
    pub store: Arc<dyn storage::Store>,
    pub credentials: Arc<dyn credentials::Credentials>,
}
impl Repository {
    pub async fn settings(&self) -> Result<(Option<u64>, Settings), storage::StoreError> {
        let record = self.store.read("settings".into()).await?;
        let revision = record.as_ref().map(|r| r.revision);
        let settings = record
            .and_then(|r| r.data.value().cloned())
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| invalid())?
            .unwrap_or_default();
        Settings::validate(&settings)?;
        Ok((revision, settings))
    }
    pub async fn snapshot(&self) -> Result<Snapshot, storage::StoreError> {
        let (revision, settings) = self.settings().await?;
        let credential = self.credentials.read(settings.credential_key()).await?;
        let secrets = credential
            .as_ref()
            .and_then(|record| record.secret.as_ref())
            .map(|secret| serde_json::from_str::<Secrets>(secret))
            .transpose()
            .map_err(|_| invalid())?;
        Ok(Snapshot {
            revision,
            settings,
            credential_revision: credential.as_ref().map(|record| record.revision),
            configured: secrets.is_some(),
            api_key_configured: secrets
                .as_ref()
                .is_some_and(|secret| secret.api_key.is_some()),
            header_names: secrets
                .map(|secret| secret.headers.into_keys().collect())
                .unwrap_or_default(),
        })
    }

    pub async fn save(
        &self,
        expected: Option<u64>,
        settings: Settings,
    ) -> Result<(), storage::StoreError> {
        settings.validate()?;
        self.store
            .batch(vec![storage::Mutation {
                key: "settings".into(),
                expected_revision: expected,
                data: storage::Data::Present(
                    serde_json::to_value(settings).map_err(|_| invalid())?,
                ),
            }])
            .await?;
        Ok(())
    }
}
fn invalid() -> storage::StoreError {
    storage::StoreError::Unavailable("Invalid Decisions API settings: use an HTTP(S) URL without user credentials or fragment, a model, and a positive timeout in milliseconds".into())
}

/// Endpoint-bound request secrets. Never returned by a settings read.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Secrets {
    pub api_key: Option<String>,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
}
impl Secrets {
    pub fn validate(&self) -> Result<(), storage::StoreError> {
        if self
            .api_key
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.chars().any(char::is_control))
        {
            return Err(invalid_headers());
        }
        let mut names = std::collections::BTreeSet::new();
        for (name, value) in &self.headers {
            let lower = name.to_ascii_lowercase();
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                || value.chars().any(char::is_control)
                || !names.insert(lower.clone())
                || matches!(
                    lower.as_str(),
                    "host"
                        | "content-length"
                        | "transfer-encoding"
                        | "connection"
                        | "content-type"
                        | "proxy-authorization"
                )
                || (lower == "authorization" && self.api_key.is_some())
            {
                return Err(invalid_headers());
            }
        }
        Ok(())
    }
    pub fn request_headers(&self) -> Result<Vec<(String, String)>, storage::StoreError> {
        self.validate()?;
        let mut headers: Vec<_> = self
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        headers.push(("Content-Type".into(), "application/json".into()));
        if let Some(key) = &self.api_key {
            headers.push(("Authorization".into(), format!("Bearer {key}")));
        }
        Ok(headers)
    }
}
fn invalid_headers() -> storage::StoreError {
    storage::StoreError::Unavailable(
        "Invalid Decisions API authentication or request headers".into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_protocol_does_not_change_endpoint_secret_identity() {
        let settings = Settings::default();
        let mut changed = settings.clone();
        changed.protocol = Protocol::OpenAiDecisions;
        assert_eq!(changed.credential_key(), settings.credential_key());
        assert_eq!(
            settings.credential_key(),
            format!(
                "endpoint-{}",
                hex::encode(Sha256::digest(settings.url.as_bytes()))
            )
        );
        let mut value = serde_json::to_value(settings).unwrap();
        value["protocol"] = serde_json::json!("unknown");
        assert!(serde_json::from_value::<Settings>(value.clone()).is_err());
        value.as_object_mut().unwrap().remove("protocol");
        assert!(serde_json::from_value::<Settings>(value).is_err());
    }
    #[test]
    fn destination_and_header_validation_prevent_credential_confusion() {
        let a = Settings::default();
        let b = Settings {
            url: "https://another.example/jev".into(),
            ..a.clone()
        };
        assert_ne!(a.credential_key(), b.credential_key());
        for url in [
            "file:///tmp/key",
            "https://user:pass@example.com/",
            "https://example.com/#secret",
        ] {
            assert!(
                Settings {
                    url: url.into(),
                    ..a.clone()
                }
                .validate()
                .is_err()
            );
        }
        for headers in [
            json!({"X-Key":"a","x-key":"b"}),
            json!({"X-Key":"a\r\nInjected: true"}),
            json!({"Host":"other.example"}),
            json!({"Authorization":"custom"}),
        ] {
            let secrets: Secrets =
                serde_json::from_value(json!({"apiKey":"key","headers":headers})).unwrap();
            assert!(secrets.validate().is_err());
        }
        let secrets: Secrets =
            serde_json::from_value(json!({"apiKey":null,"headers":{"Authorization":"Custom key"}}))
                .unwrap();
        assert!(
            secrets
                .request_headers()
                .unwrap()
                .contains(&("Authorization".into(), "Custom key".into()))
        );
    }
}
