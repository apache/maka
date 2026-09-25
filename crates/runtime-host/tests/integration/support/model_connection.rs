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

use maka_client::Client;
use maka_protocol::{
    Operation,
    model_provider::Scope,
    oauth::{LoginStart, Phase, Target},
};
use maka_runtime::provider::AuthenticationInput;
use serde_json::{Value, json};
use std::time::Duration;

pub async fn create(
    client: &Client,
    provider: &str,
    slug: &str,
    base: &str,
    key: &str,
    mut models: Value,
) -> Value {
    for model in models
        .as_object_mut()
        .expect("fixture model declarations")
        .values_mut()
    {
        model
            .as_object_mut()
            .expect("fixture model override")
            .entry("contextWindow")
            .or_insert(json!(200_000));
    }
    let provider = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let directory = client.provider_directory(Scope::Profile).await.unwrap();
            if let Some(entry) = directory
                .entries
                .into_iter()
                .find(|entry| entry.identity.name == provider)
            {
                break entry;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture provider did not publish");
    let input = LoginStart {
        attempt_id: uuid::Uuid::new_v4().to_string(),
        target: Target::Create {
            provider: provider.identity,
            configuration: json!({"baseUrl":base}),
            slug: slug.into(),
            name: slug.into(),
        },
        authentication: AuthenticationInput {
            method: "api-key".into(),
            input: json!({"apiKey":key}),
        },
    };
    let login = tokio::time::timeout(Duration::from_secs(5), async {
        let mut login = client.start_oauth_login(&input).await.unwrap();
        while matches!(login.phase, Phase::Exchanging | Phase::Committing) {
            tokio::time::sleep(Duration::from_millis(10)).await;
            login = client
                .query_oauth_login(&input.recovery(), Some(&login.connection))
                .await
                .unwrap();
        }
        login
    })
    .await
    .expect("fixture authentication did not settle");
    assert_eq!(login.phase, Phase::Authenticated);
    let catalog = client
        .request(Operation::ConnectionCatalogQuery, json!({"kind":"start"}))
        .await
        .unwrap();
    assert!(
        catalog["nextCursor"].is_null(),
        "fixture catalog fits one page"
    );
    let row = catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| {
            row["kind"] == "connection" && row["connectionId"] == login.connection.connection_id
        })
        .unwrap();
    let result = client.request(Operation::ConnectionCatalogUpdate, json!({
        "expected":{"connectionId":row["connectionId"],"revision":row["revision"]},
        "changes":{"name":slug,"configuration":row["configuration"],"enabled":true,
            "enabledModelIds":models.as_object().expect("model overrides").keys().collect::<Vec<_>>(),"modelOverrides":models}
    })).await.unwrap();
    assert_eq!(result["kind"], "committed");
    result
}
