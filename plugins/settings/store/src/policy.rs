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

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode};
use maka_agent_facts::configuration::policy::ChatDefaults;
use maka_agent_facts::configuration::policy::EnabledPolicy;
use maka_agent_facts::configuration::policy::Personalization;
use maka_agent_facts::configuration::policy::PrivacyPolicy;
use maka_agent_facts::configuration::policy::RuntimePolicy;
use maka_agent_facts::configuration::policy::RuntimePolicyMutationResult;
use maka_agent_facts::configuration::policy::RuntimePolicySnapshot;
use maka_agent_facts::configuration::policy::decode_canonical_snapshot;
use maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER;
use maka_agent_facts::configuration::validation::revision;
use rusqlite::{Connection, OptionalExtension};

impl ConfigurationStore {
    pub async fn set_message_predictions(
        &self,
        expected_revision: u64,
        settings: maka_agent_facts::configuration::policy::MessagePredictionSettings,
    ) -> Result<RuntimePolicyMutationResult> {
        settings.validate().map_err(ConfigError::Invalid)?;
        self.update_policy(expected_revision, move |policy| {
            policy.predictions = settings
        })
        .await
    }

    pub async fn set_language(
        &self,
        expected_revision: u64,
        preference: maka_agent_facts::language::LanguagePreference,
    ) -> Result<RuntimePolicyMutationResult> {
        self.update_policy(expected_revision, move |policy| {
            policy.language = Some(preference)
        })
        .await
    }

    pub async fn set_compaction_prompt(
        &self,
        expected_revision: u64,
        prompt: Option<String>,
    ) -> Result<RuntimePolicyMutationResult> {
        self.update_policy(expected_revision, move |policy| {
            policy.compaction_prompt = prompt
        })
        .await
    }

    pub async fn set_network_proxy(
        &self,
        expected_revision: u64,
        value: maka_agent_facts::configuration::policy::NetworkProxy,
    ) -> Result<RuntimePolicyMutationResult> {
        self.update_policy(expected_revision, move |policy| {
            policy.network_proxy = value
        })
        .await
    }
    /// Reads the root policy without materializing defaults into persistence.
    pub async fn runtime_policy(&self) -> Result<RuntimePolicySnapshot> {
        self.transaction(TransactionMode::Deferred, |connection| read(connection))
            .await
    }

    /// Replaces chat defaults in the same root-owned transaction as its CAS.
    pub async fn set_chat_defaults(
        &self,
        expected_revision: u64,
        value: ChatDefaults,
    ) -> Result<RuntimePolicyMutationResult> {
        self.update_policy(expected_revision, move |policy| {
            policy.chat_defaults = value
        })
        .await
    }

    pub async fn set_personalization(
        &self,
        expected_revision: u64,
        value: Personalization,
    ) -> Result<RuntimePolicyMutationResult> {
        self.update_policy(expected_revision, move |policy| {
            policy.personalization = value
        })
        .await
    }

    pub async fn set_privacy(
        &self,
        expected_revision: u64,
        value: PrivacyPolicy,
    ) -> Result<RuntimePolicyMutationResult> {
        self.update_policy(expected_revision, move |policy| policy.privacy = value)
            .await
    }

    pub async fn set_workspace_instructions(
        &self,
        expected_revision: u64,
        value: EnabledPolicy,
    ) -> Result<RuntimePolicyMutationResult> {
        self.update_policy(expected_revision, move |policy| {
            policy.workspace_instructions = value
        })
        .await
    }

    pub async fn set_shell(
        &self,
        expected_revision: u64,
        value: maka_agent_facts::configuration::policy::ShellPolicy,
    ) -> Result<RuntimePolicyMutationResult> {
        let input =
            maka_agent_facts::configuration::policy::normalize_mutation(serde_json::json!({
                "expectedRevision": expected_revision,
                "operation": { "kind": "set_shell", "value": value }
            }))
            .map_err(ConfigError::Invalid)?;
        let maka_agent_facts::configuration::policy::RuntimePolicyMutation::SetShell { value } =
            input.operation
        else {
            unreachable!("normalized set_shell operation")
        };
        self.update_policy(expected_revision, move |policy| policy.shell = value)
            .await
    }
    async fn update_policy(
        &self,
        expected_revision: u64,
        update: impl FnOnce(&mut RuntimePolicy) + Send + 'static,
    ) -> Result<RuntimePolicyMutationResult> {
        revision(expected_revision, false).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Immediate, move |connection| {
            let mut snapshot = read(connection)?;
            if snapshot.revision != expected_revision {
                return Ok(RuntimePolicyMutationResult::RevisionConflict {
                    expected_revision,
                    actual_revision: snapshot.revision,
                });
            }
            if snapshot.revision == MAX_SAFE_INTEGER {
                return Err(ConfigError::Invalid(
                    "runtime policy revision exhausted".into(),
                ));
            }
            snapshot.revision += 1;
            let previous_proxy = snapshot.policy.network_proxy.clone();
            update(&mut snapshot.policy);
            if !maka_agent_facts::configuration::policy::network_update::same_route(
                &previous_proxy,
                &snapshot.policy.network_proxy,
            ) {
                crate::network::invalidate_tests(connection)?;
            }
            write(connection, &snapshot)?;
            Ok(RuntimePolicyMutationResult::Committed {
                revision: snapshot.revision,
            })
        })
        .await
    }
}

pub(crate) fn write(connection: &Connection, snapshot: &RuntimePolicySnapshot) -> Result<()> {
    snapshot.validate().map_err(ConfigError::Invalid)?;
    let document = serde_json::to_string(snapshot)?;
    connection.execute("INSERT INTO runtime_policy(singleton, document) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET document = excluded.document", rusqlite::params![document])?;
    Ok(())
}

pub(crate) fn read(connection: &Connection) -> Result<RuntimePolicySnapshot> {
    let document: Option<String> = connection
        .prepare_cached("SELECT document FROM runtime_policy WHERE singleton = 1")?
        .query_row(rusqlite::params![], |row| row.get(0))
        .optional()?;
    let Some(document) = document else {
        return Ok(RuntimePolicySnapshot {
            revision: 0,
            policy: RuntimePolicy::default(),
        });
    };
    let value = serde_json::from_str(&document)?;
    decode_canonical_snapshot(value).map_err(|_| ConfigError::UnsupportedDatabase)
}
