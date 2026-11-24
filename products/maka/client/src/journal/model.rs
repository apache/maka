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

use super::{Journal, error, write};
use crate::Result;
use maka_agent_facts::executor::BackendPreference;
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentModel {
    pub backend: BackendPreference,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

fn valid_selector(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(char::is_control)
}

impl RecentModel {
    pub fn validate(&self) -> Result<()> {
        match &self.backend {
            BackendPreference::Model {
                connection_id,
                model_id,
                service_tier,
                ..
            } => {
                if !valid_selector(connection_id)
                    || !valid_selector(model_id)
                    || service_tier
                        .as_deref()
                        .is_some_and(|tier| !valid_selector(tier))
                {
                    return Err("Invalid recent model".into());
                }
            }
            BackendPreference::Executor { selection } => {
                if !valid_selector(&selection.executor) || selection.settings.validate().is_err() {
                    return Err("Invalid recent model".into());
                }
            }
        }
        Ok(())
    }

    fn normalized(mut self) -> Result<Self> {
        self.validate()?;
        self.label = self.label.and_then(|label| {
            let trimmed = label.trim();
            valid_selector(trimmed).then(|| trimmed.to_owned())
        });
        Ok(self)
    }
}

impl Journal {
    pub(crate) async fn recent_model(&self, owner: &str) -> Result<Option<RecentModel>> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT value FROM recent_model WHERE owner=?")
                .bind(owner)
                .fetch_optional(&self.pool)
                .await
                .map_err(error)?;
        // Ignore a corrupt, schema-drifted, or structurally invalid row so startup stays safe.
        Ok(value.and_then(|value| {
            serde_json::from_str::<RecentModel>(&value)
                .ok()
                .and_then(|model| model.normalized().ok())
        }))
    }

    pub(crate) async fn set_recent_model(
        &self,
        owner: String,
        model: RecentModel,
    ) -> Result<RecentModel> {
        let model = model.normalized()?;
        let write::Output::RecentModel(saved) = self
            .write(write::Command::SetRecentModel { owner, model })
            .await?
        else {
            unreachable!("recent model write returned a different result")
        };
        Ok(saved)
    }
}

pub(super) async fn set(
    connection: &mut SqliteConnection,
    owner: String,
    model: RecentModel,
) -> Result<RecentModel> {
    let model = model.normalized()?;
    sqlx::query(
        "INSERT INTO recent_model(owner,value) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value",
    )
    .bind(owner)
    .bind(serde_json::to_string(&model).map_err(error)?)
    .execute(connection)
    .await
    .map_err(error)?;
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::execution::ThinkingLevel;
    use maka_agent_facts::executor::{Effort, Selection, Settings};

    #[tokio::test]
    async fn recent_model_round_trips_native_and_external_per_owner_and_recovers_from_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(&dir.path().join("client.db")).await.unwrap();

        assert_eq!(journal.recent_model("host-a").await.unwrap(), None);

        let native = RecentModel {
            backend: BackendPreference::Model {
                connection_id: "conn-1".into(),
                model_id: "gpt-5".into(),
                service_tier: Some("fast".into()),
                thinking_level: Some(ThinkingLevel::High),
            },
            label: Some("  GPT-5  ".into()),
        };
        journal
            .set_recent_model("host-a".into(), native)
            .await
            .unwrap();
        assert_eq!(
            journal.recent_model("host-a").await.unwrap(),
            Some(RecentModel {
                backend: BackendPreference::Model {
                    connection_id: "conn-1".into(),
                    model_id: "gpt-5".into(),
                    service_tier: Some("fast".into()),
                    thinking_level: Some(ThinkingLevel::High),
                },
                label: Some("GPT-5".into()),
            })
        );
        assert_eq!(journal.recent_model("host-b").await.unwrap(), None);

        let external = RecentModel {
            backend: BackendPreference::Executor {
                selection: Selection {
                    executor: "external".into(),
                    settings: Settings {
                        runtime: Some("antigravity".into()),
                        model: Some("gemini-4-neon".into()),
                        thinking_level: Some(Effort::try_from("high".to_owned()).unwrap()),
                    },
                },
            },
            label: Some("Gemini 4 Neon".into()),
        };
        journal
            .set_recent_model("host-a".into(), external.clone())
            .await
            .unwrap();
        assert_eq!(
            journal.recent_model("host-a").await.unwrap(),
            Some(RecentModel {
                backend: BackendPreference::Executor {
                    selection: Selection {
                        executor: "external".into(),
                        settings: Settings {
                            runtime: Some("antigravity".into()),
                            model: Some("gemini-4-neon".into()),
                            thinking_level: Some(Effort::try_from("high".to_owned()).unwrap()),
                        },
                    },
                },
                label: Some("Gemini 4 Neon".into()),
            })
        );

        let blank_label = RecentModel {
            backend: external.backend.clone(),
            label: Some("  \n ".into()),
        };
        journal
            .set_recent_model("host-b".into(), blank_label)
            .await
            .unwrap();
        assert_eq!(
            journal.recent_model("host-b").await.unwrap().unwrap().label,
            None
        );
        assert_eq!(
            journal.recent_model("host-a").await.unwrap(),
            Some(external.clone())
        );

        let invalid_native = RecentModel {
            backend: BackendPreference::Model {
                connection_id: "conn-1".into(),
                model_id: "".into(),
                service_tier: None,
                thinking_level: None,
            },
            label: None,
        };
        assert!(
            journal
                .set_recent_model("host-a".into(), invalid_native)
                .await
                .is_err()
        );
        let invalid_executor = RecentModel {
            backend: BackendPreference::Executor {
                selection: Selection {
                    executor: "external".into(),
                    settings: Settings {
                        runtime: Some("".into()),
                        model: Some("gemini-4-neon".into()),
                        thinking_level: None,
                    },
                },
            },
            label: None,
        };
        assert!(
            journal
                .set_recent_model("host-a".into(), invalid_executor)
                .await
                .is_err()
        );

        for broken in [
            "not valid json",
            r#"{"backend":{"kind":"model","connectionId":"conn","modelId":"","thinkingLevel":null}}"#,
            r#"{"backend":{"kind":"executor","selection":{"executor":"external","settings":{"runtime":"","model":"gemini"}}}}"#,
        ] {
            sqlx::query("UPDATE recent_model SET value=? WHERE owner='host-a'")
                .bind(broken)
                .execute(&journal.pool)
                .await
                .unwrap();
            assert_eq!(journal.recent_model("host-a").await.unwrap(), None);
        }

        journal
            .set_recent_model("host-a".into(), external.clone())
            .await
            .unwrap();
        assert_eq!(
            journal.recent_model("host-a").await.unwrap(),
            Some(external)
        );
    }
}
