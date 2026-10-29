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

use maka_agent_facts::configuration::ConnectionCredentialTarget;
use maka_agent_facts::oauth::LoginStart;
use maka_agent_facts::oauth::Target;
use maka_agent_facts::provider::AuthenticationInput;
use maka_agent_facts::provider::Credential;
use maka_config::{
    ConfigurationStore,
    oauth::enrollment::{LoginCompletion, LoginPreparation},
};
use std::sync::Arc;

pub async fn login(store: &Arc<ConfigurationStore>, id: &str, secret: &str) {
    let row = store
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.connection_id == id)
        .unwrap();
    let LoginPreparation::Ready(ticket) = store
        .prepare_oauth_login(LoginStart {
            expected_credential: match store
                .credential_status(
                    maka_agent_facts::configuration::CredentialLocator::Connection {
                        connection_id: row.connection_id.clone(),
                        kind: maka_agent_facts::configuration::ConnectionCredentialKind::Provider,
                    },
                )
                .await
                .unwrap()
            {
                maka_agent_facts::configuration::CredentialVaultQueryResult::Status { status } => {
                    status.basis()
                }
                _ => panic!("connection status"),
            },
            attempt_id: uuid::Uuid::new_v4().to_string(),
            target: Target::Existing {
                expected: ConnectionCredentialTarget {
                    connection_id: row.connection_id,
                    revision: row.revision,
                    slug: row.slug,
                    provider: row.provider,
                    configuration: row.configuration.clone(),
                },
                configuration: row.configuration,
            },
            authentication: AuthenticationInput {
                method: "key".into(),
                input: serde_json::json!({}),
            },
        })
        .await
        .unwrap()
    else {
        panic!("expected login preparation");
    };
    assert!(ticket.claim().await.unwrap());
    assert!(matches!(
        ticket
            .complete(
                Credential {
                    secret: secret.into(),
                    refresh_at: None
                },
                42
            )
            .await
            .unwrap(),
        LoginCompletion::Committed(_)
    ));
}
