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
use maka_config::{Result, projection::project};
use maka_runtime::configuration::*;
use maka_runtime::execution::ThinkingLevel;
use serde_json::json;

fn snapshot() -> ConnectionCatalogSnapshot {
    serde_json::from_value(json!({"revision":7,"defaultTarget":{
        "connectionId":"11111111-1111-4111-8111-111111111111","modelId":"manual-0"},
        "connections":[{"connectionId":"11111111-1111-4111-8111-111111111111",
        "revision":3,"slug":"relay","name":"Relay",
        "provider":{"packageId":"example","entryId":"account","scope":"profile","name":"api"},
        "configuration":{"baseUrl":"http://localhost:1234/v1"},"enabled":true,
        "enabledModelIds":(0..96).map(|i|format!("manual-{i}")).collect::<Vec<_>>(),
        "models":[{"id":"observed","contextWindow":8192}],
        "modelSource":"fetched","modelsFetchedAt":123,
        "modelOverrides":{"manual-0":{"vision":true,"thinkingLevels":["low","high"]},"manual-1":{}}}]}))
    .unwrap()
}

fn resolve(row: &ConnectionCatalogEntry, default: Option<&str>) -> Result<Vec<ModelCatalogEntry>> {
    assert_eq!(default, Some("manual-0"));
    Ok(row
        .enabled_model_ids
        .iter()
        .enumerate()
        .map(|(i, id)| ModelCatalogEntry {
            is_default: Some(id.as_str()) == default,
            supports_vision: i == 0,
            thinking_levels: vec![ThinkingLevel::Low, ThinkingLevel::High],
            default_supports_vision: Some(false),
            description: Some("界😀\n\"\\".repeat(100 + i)),
            context_window: Some(8192),
            ..ModelCatalogEntry::new(id)
        })
        .collect())
}

#[test]
fn pages_preserve_items_profiles_and_resolved_facts() {
    let snapshot = snapshot();
    let mut input = ConnectionCatalogQueryInput::Start;
    let mut items = Vec::new();
    let mut pages = 0;
    let mut projected = Vec::new();
    loop {
        let page = project(&snapshot, &input, resolve).unwrap();
        projected.push(page.clone());
        assert!(serde_json::to_vec(&page).unwrap().len() <= 128 * 1024);
        assert_eq!(page["revision"], 7);
        assert_eq!(
            page["defaultTarget"],
            serde_json::to_value(&snapshot.default_target).unwrap()
        );
        let rows = page["items"].as_array().unwrap();
        assert!(!rows.is_empty() && rows.len() <= 128);
        items.extend(rows.clone());
        pages += 1;
        if page["nextCursor"].is_null() {
            break;
        }
        input = serde_json::from_value(json!({"kind":"continue","revision":7,
            "cursor":page["nextCursor"]}))
        .unwrap();
        assert!(pages < 10);
    }
    assert!(pages >= 3);
    for adjacent in projected.windows(2) {
        let mut full = adjacent[0].clone();
        let count = full["items"].as_array().unwrap().len();
        if count == 128 {
            continue;
        }
        let next = adjacent[1]["items"].as_array().unwrap();
        full["items"].as_array_mut().unwrap().push(next[0].clone());
        full["nextCursor"] = if let Some(item) = next.get(1) {
            let mut cursor = json!({"part":item["kind"],"connectionIndex":item["connectionIndex"]});
            if let Some(index) = item.get("itemIndex") {
                cursor["itemIndex"] = index.clone();
            }
            cursor
        } else {
            adjacent[1]["nextCursor"].clone()
        };
        assert!(
            serde_json::to_vec(&full).unwrap().len() > 128 * 1024,
            "page must fit the maximal prefix including its actual next cursor"
        );
    }
    assert_eq!(items.len(), 194);
    assert_eq!(items[0]["catalogEntryCount"], 96);
    assert_eq!(items[0]["modelCount"], 1);
    assert_eq!(items[0]["enabledModelIdCount"], 96);
    assert!(items[1].get("modelOverride").is_none());
    assert_eq!(items[98]["modelOverride"]["vision"], true);
    assert_eq!(
        items[99].get("modelOverride"),
        Some(&json!({})),
        "empty declarations preserve manually added model identities in the client"
    );
    assert_eq!(items[97]["model"]["contextWindow"], 8192);
    assert_eq!(items[98]["entry"]["isDefault"], true);
    assert_eq!(items[193]["entry"]["id"], "manual-95");
    // Use the untouched client decoder and assembler, including the empty
    // manual declaration that a later settings save must preserve.
    let mut child = std::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/support/catalog_source.mjs"),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(
        child.stdin.take().unwrap(),
        &json!({
            "snapshot":snapshot, "pages":projected
        }),
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let encoded = serde_json::to_string(&items).unwrap();
    for private in [
        "modelsFetchedAt",
        "lastTestModelFactsFingerprint",
        "factOverriddenFields",
    ] {
        assert!(!encoded.contains(private));
    }
}

#[test]
fn revision_change_precedes_cursor_and_resolver_and_invalid_cursor_fails() {
    let snapshot = snapshot();
    let input = |revision| ConnectionCatalogQueryInput::Continue {
        revision,
        cursor: ConnectionCatalogCursor::CatalogEntry {
            connection_index: 0,
            item_index: 96,
        },
    };
    assert_eq!(
        project(&snapshot, &input(6), |_, _| panic!("must not resolve")).unwrap(),
        json!({"kind":"revision_changed","expectedRevision":6,"actualRevision":7})
    );
    assert!(project(&snapshot, &input(7), resolve).is_err());
    assert!(
        project(&snapshot, &ConnectionCatalogQueryInput::Start, |_, _| Ok(
            vec![ModelCatalogEntry::new("")]
        ))
        .is_err()
    );
}
