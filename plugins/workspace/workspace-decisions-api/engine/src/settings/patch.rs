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

use super::{Repository, Secrets, Settings, invalid_headers};
use maka_capabilities::credentials;
use maka_capabilities::storage;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Only the credential owner reads kept values. Clients send intent, never a
/// masked placeholder or an invented copy of an unreadable secret.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SecretChange {
    #[default]
    Keep,
    Replace {
        value: String,
    },
    Remove,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeaderPatch {
    pub name: String,
    pub change: SecretChange,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretsPatch {
    #[serde(default)]
    pub api_key: SecretChange,
    #[serde(default)]
    pub headers: Vec<HeaderPatch>,
}
impl SecretsPatch {
    pub fn apply(self, previous: Option<Secrets>) -> Result<Option<Secrets>, storage::StoreError> {
        let mut secrets = previous.unwrap_or(Secrets {
            api_key: None,
            headers: BTreeMap::new(),
        });
        secrets.api_key = match self.api_key {
            SecretChange::Keep => secrets.api_key,
            SecretChange::Replace { value } => Some(value),
            SecretChange::Remove => None,
        };
        let mut names = BTreeSet::new();
        for patch in self.headers {
            if !names.insert(patch.name.to_ascii_lowercase()) {
                return Err(invalid_headers());
            }
            // Validate even removal names, without forwarding or exposing values.
            Secrets {
                api_key: None,
                headers: [(patch.name.clone(), String::new())].into(),
            }
            .validate()?;
            let existing = secrets
                .headers
                .keys()
                .find(|name| name.eq_ignore_ascii_case(&patch.name))
                .cloned();
            match patch.change {
                SecretChange::Keep => {}
                SecretChange::Replace { value } => {
                    if let Some(existing) = existing {
                        secrets.headers.remove(&existing);
                    }
                    secrets.headers.insert(patch.name, value);
                }
                SecretChange::Remove => {
                    if let Some(existing) = existing {
                        secrets.headers.remove(&existing);
                    }
                }
            }
        }
        secrets.validate()?;
        Ok((secrets.api_key.is_some() || !secrets.headers.is_empty()).then_some(secrets))
    }
}
impl Repository {
    pub async fn patch_credentials(
        &self,
        url: String,
        expected: Option<u64>,
        patch: SecretsPatch,
    ) -> Result<credentials::WriteResult, storage::StoreError> {
        let settings = Settings {
            url,
            ..Settings::default()
        };
        settings.validate()?;
        let key = settings.credential_key();
        let current = self.credentials.read(key.clone()).await?;
        let actual = current.as_ref().map(|record| record.revision);
        if expected != actual {
            return Ok(credentials::WriteResult::Conflict { actual });
        }
        let previous = current
            .and_then(|record| record.secret)
            .map(|secret| serde_json::from_str::<Secrets>(&secret))
            .transpose()
            .map_err(|_| invalid_headers())?;
        let secret = patch
            .apply(previous)?
            .map(|secret| serde_json::to_string(&secret))
            .transpose()
            .map_err(|_| invalid_headers())?;
        self.credentials
            .write(credentials::Write {
                key,
                expected_revision: expected,
                secret,
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_a_key_preserves_unreadable_headers_and_header_changes_preserve_the_key() {
        let before = Secrets {
            api_key: Some("old".into()),
            headers: [("X-Gateway".into(), " secret with spaces ".into())].into(),
        };
        let next = SecretsPatch {
            api_key: SecretChange::Replace {
                value: "new".into(),
            },
            headers: vec![],
        }
        .apply(Some(before))
        .unwrap()
        .unwrap();
        assert_eq!(next.headers["X-Gateway"], " secret with spaces ");
        assert_eq!(next.api_key.as_deref(), Some("new"));
        let next = SecretsPatch {
            api_key: SecretChange::Keep,
            headers: vec![HeaderPatch {
                name: "x-gateway".into(),
                change: SecretChange::Replace {
                    value: "replacement".into(),
                },
            }],
        }
        .apply(Some(next))
        .unwrap()
        .unwrap();
        assert_eq!(next.headers.len(), 1);
        assert_eq!(next.headers["x-gateway"], "replacement");
        assert_eq!(next.api_key.as_deref(), Some("new"));
        let next = SecretsPatch {
            api_key: SecretChange::Remove,
            headers: vec![],
        }
        .apply(Some(next))
        .unwrap()
        .unwrap();
        assert!(next.api_key.is_none());
        assert_eq!(next.headers["x-gateway"], "replacement");
    }

    #[test]
    fn conflicting_and_invalid_headers_reject_before_a_credential_can_be_written() {
        for changes in [
            vec![("X-Team", "one"), ("x-team", "two")],
            vec![("Authorization", "Bearer other")],
            vec![("X-Team", "line\nbreak")],
        ] {
            let patch = SecretsPatch {
                api_key: SecretChange::Keep,
                headers: changes
                    .into_iter()
                    .map(|(name, value)| HeaderPatch {
                        name: name.into(),
                        change: SecretChange::Replace {
                            value: value.into(),
                        },
                    })
                    .collect(),
            };
            assert!(
                patch
                    .apply(Some(Secrets {
                        api_key: Some("existing".into()),
                        headers: BTreeMap::new()
                    }))
                    .is_err()
            );
        }
    }
}

#[cfg(test)]
mod concurrency;
