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

use maka_agent_facts::configuration::*;
use maka_config::{model_catalog::resolve, projection::project};
use serde_json::json;

fn snapshot() -> ConnectionCatalogSnapshot {
    let models = ["one", "two", "three"]
        .map(|id| json!({"id":id,"contextWindow":8192,"description":"中文😀\n".repeat(5000)}));
    serde_json::from_value(json!({
        "revision":7,
        "defaultTarget":{"connectionId":"11111111-1111-4111-8111-111111111111","modelId":"one"},
        "connections":[{
            "connectionId":"11111111-1111-4111-8111-111111111111","revision":3,
            "slug":"relay","name":"Relay",
            "provider":{"packageId":"example","entryId":"account","scope":"profile","name":"api"},
            "configuration":{"baseUrl":"https://account.invalid/v1"},"enabled":true,
            "enabledModelIds":["one","two","three"],"modelSource":"fetched","modelsFetchedAt":123,
            "models":models,
            "modelOverrides":{"one":{"vision":true,"thinkingLevels":["low","high"]},"two":{}}
        }]
    }))
    .unwrap()
}

#[test]
fn pages_deliver_the_complete_resolved_catalog_with_profiles_and_original_text() {
    let snapshot = snapshot();
    let mut query = ConnectionCatalogQueryInput::Start;
    let mut items = Vec::new();
    loop {
        let page = project(&snapshot, &query, resolve).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 128 * 1024);
        assert_eq!(page["revision"], 7);
        assert_eq!(page["defaultTarget"]["modelId"], "one");
        items.extend(page["items"].as_array().unwrap().clone());
        if page["nextCursor"].is_null() {
            break;
        }
        let next = serde_json::from_value(json!({
            "kind":"continue","revision":7,"cursor":page["nextCursor"]
        }))
        .unwrap();
        assert_ne!(query, next, "each page must advance its cursor");
        query = next;
    }
    assert_eq!(items.len(), 10);
    assert_eq!(items[0]["catalogEntryCount"], 3);
    assert_eq!(items[0]["modelCount"], 3);
    assert!(items[0].get("modelsFetchedAt").is_none());
    assert_eq!(items[1]["modelId"], "one");
    assert_eq!(items[4]["model"]["contextWindow"], 8192);
    assert_eq!(items[7]["entry"]["isDefault"], true);
    assert_eq!(items[7]["entry"]["supportsVision"], true);
    assert_eq!(items[7]["modelOverride"]["vision"], true);
    assert_eq!(items[8]["modelOverride"], json!({}));
    assert_eq!(items[9]["entry"]["id"], "three");
    for item in &items[4..7] {
        assert_eq!(item["model"]["description"], "中文😀\n".repeat(5000));
    }
    for item in &items[7..10] {
        assert_eq!(item["entry"]["description"], "中文😀\n".repeat(5000));
    }
}

#[test]
fn revision_change_precedes_cursor_resolution_and_invalid_cursors_fail() {
    let snapshot = snapshot();
    let query = |revision| ConnectionCatalogQueryInput::Continue {
        revision,
        cursor: ConnectionCatalogCursor::CatalogEntry {
            connection_index: 0,
            item_index: 99,
        },
    };
    assert_eq!(
        project(&snapshot, &query(6), |_, _| panic!(
            "stale revisions must not resolve models"
        ))
        .unwrap(),
        json!({"kind":"revision_changed","expectedRevision":6,"actualRevision":7})
    );
    assert!(project(&snapshot, &query(7), resolve).is_err());
}
