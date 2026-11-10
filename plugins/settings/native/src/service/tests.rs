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
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::json;

#[tokio::test]
async fn ollama_cloud_enabled_model_resolves_to_a_settings_choice() {
    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let configuration = maka_config::ConfigurationStore::for_root(root)
        .await
        .unwrap();
    let revision = configuration.catalog().await.unwrap().revision;
    let committed = configuration.create_connection(serde_json::from_value(json!({
        "expectedCatalogRevision":revision,
        "connection":{
            "slug":"ollama-cloud","name":"Ollama Cloud",
            "provider":{"packageId":maka_providers::api::ID,"entryId":maka_providers::api::ID,"scope":"profile","name":"ollama-cloud"},
            "configuration":{"baseUrl":"https://ollama.com/v1"},
            "enabled":true,"enabledModelIds":["deepseek-v4-flash"]
        }
    })).unwrap()).await.unwrap();
    assert!(matches!(committed, CatalogMutationResult::Committed { .. }));
    let catalog = configuration.catalog().await.unwrap();
    let row = &catalog.connections[0];
    let snapshot = Arc::new(maka_providers::catalog::Snapshot::bundled().unwrap());
    assert!(selectable(row, snapshot.clone()));
    let choice = model_choice(row, &row.enabled_model_ids[0], snapshot)
        .await
        .unwrap();
    assert_eq!(choice.selection.model_id, "deepseek-v4-flash");
    assert_eq!(choice.selection.connection_id, row.connection_id);
    configuration.shutdown().await.unwrap();
}
