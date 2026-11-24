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

impl RecentModel {
    fn normalized(mut self) -> Self {
        self.label = self.label.and_then(|label| {
            let trimmed = label.trim();
            (!trimmed.is_empty() && !trimmed.chars().any(char::is_control))
                .then(|| trimmed.to_owned())
        });
        self
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
        // Ignore a corrupt or schema-drifted row so a broken client preference never blocks startup.
        Ok(value.and_then(|value| {
            serde_json::from_str::<RecentModel>(&value)
                .ok()
                .map(RecentModel::normalized)
        }))
    }

    pub(crate) async fn set_recent_model(
        &self,
        owner: String,
        model: RecentModel,
    ) -> Result<RecentModel> {
        let write::Output::RecentModel(saved) = self
            .write(write::Command::SetRecentModel {
                owner,
                model: model.normalized(),
            })
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
    let model = model.normalized();
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
        let saved = journal
            .set_recent_model("host-a".into(), native.clone())
            .await
            .unwrap();
        assert_eq!(saved.label.as_deref(), Some("GPT-5"));
        assert_eq!(journal.recent_model("host-a").await.unwrap(), Some(saved));
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
        let saved_ext = journal
            .set_recent_model("host-a".into(), external.clone())
            .await
            .unwrap();
        assert_eq!(
            journal.recent_model("host-a").await.unwrap(),
            Some(saved_ext.clone())
        );

        let blank_label = RecentModel {
            backend: external.backend.clone(),
            label: Some("  \n ".into()),
        };
        let saved_blank = journal
            .set_recent_model("host-b".into(), blank_label)
            .await
            .unwrap();
        assert_eq!(saved_blank.label, None);
        assert_eq!(
            journal.recent_model("host-a").await.unwrap(),
            Some(saved_ext)
        );

        sqlx::query("UPDATE recent_model SET value='not valid json' WHERE owner='host-a'")
            .execute(&journal.pool)
            .await
            .unwrap();
        assert_eq!(journal.recent_model("host-a").await.unwrap(), None);

        let repaired = journal
            .set_recent_model("host-a".into(), external)
            .await
            .unwrap();
        assert_eq!(
            journal.recent_model("host-a").await.unwrap(),
            Some(repaired)
        );
    }
}
