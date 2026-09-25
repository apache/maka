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
use maka_protocol::configuration::decode_catalog_query_input;
use maka_protocol::configuration_pages::{MAX_CATALOG_ENTRIES, decode_catalog_query_result};
use serde_json::{Value, json};

fn mixed_page() -> Value {
    json!({"kind":"page","revision":7,"defaultTarget":null,"connectionCount":1,
        "nextCursor":null,"items":[
        {"kind":"connection","connectionIndex":0,
         "connectionId":"12345678-1234-4123-8123-123456789abc","revision":1,
         "slug":"test-connection","name":"Test",
         "provider":{"packageId":"external.provider","entryId":"entry","scope":"profile","name":"custom"},
         "configuration":{"deployment":"opaque"},
         "enabled":true,"enabledModelIdCount":1,"modelCount":1,"catalogEntryCount":1,
         "modelSource":"fetched","lastTest":{"status":"verified","checkedAt":"today"}},
        {"kind":"enabled_model_id","connectionIndex":0,"itemIndex":0,"modelId":"model"},
        {"kind":"model","connectionIndex":0,"itemIndex":0,
         "model":{"id":"model","contextWindow":128000,"capabilities":{"chat":true}}},
        {"kind":"catalog_entry","connectionIndex":0,"itemIndex":0,
         "modelOverride":{"adapter":"external.responses","defaultThinkingLevel":"high","thinkingLevels":["low","high"],"vision":false},
         "entry":{"id":"model","displayName":"Model","description":"A model",
          "contextWindow":128000,"knowledgeCutoff":"2025-01","canUseAsChatDefault":true,
          "isDefault":false,"supportsVision":false,"thinkingLevels":["off","low","high"],
          "defaultSupportsVision":false,"defaultThinkingLevel":"high"}}
    ]})
}

#[test]
fn mixed_public_inventory_and_revision_changed_decode() {
    let page = mixed_page();
    assert_eq!(decode_catalog_query_result(&page).unwrap(), page);
    for status in ["verified", "needs_reauth", "error"] {
        for class in [
            "auth",
            "timeout",
            "provider_unavailable",
            "network",
            "unknown",
        ] {
            let mut value = page.clone();
            value["items"][0]["lastTest"] =
                json!({"status":status,"errorClass":class,"checkedAt":"today"});
            assert_eq!(decode_catalog_query_result(&value).unwrap(), value);
        }
    }
    let changed = json!({"kind":"revision_changed","expectedRevision":0,"actualRevision":7});
    assert_eq!(decode_catalog_query_result(&changed).unwrap(), changed);
    let empty = json!({"kind":"page","revision":0,"defaultTarget":null,
        "connectionCount":0,"items":[],"nextCursor":null});
    assert_eq!(decode_catalog_query_result(&empty).unwrap(), empty);
    for key in ["expectedRevision", "actualRevision"] {
        for bad in [Value::Null, json!(-1), json!(9007199254740992_u64)] {
            let mut value = changed.clone();
            value[key] = bad;
            assert!(decode_catalog_query_result(&value).is_err());
        }
    }
}

#[test]
fn strict_public_shapes_reject_nulls_private_fields_and_invalid_models() {
    let page = mixed_page();
    for (field, invalid) in [
        ("status", json!("future-status")),
        ("status", Value::Null),
        ("errorClass", json!("invented-error")),
        ("errorClass", Value::Null),
    ] {
        let mut value = page.clone();
        value["items"][0]["lastTest"][field] = invalid;
        assert!(decode_catalog_query_result(&value).is_err());
    }
    let mut bad_source = page.clone();
    bad_source["items"][0]["modelSource"] = json!("invented-source");
    assert!(decode_catalog_query_result(&bad_source).is_err());
    for pointer in [
        "/defaultTarget",
        "/nextCursor",
        "/items/0/modelSource",
        "/items/0/configuration",
        "/items/0/lastTest",
        "/items/0/requestBodyOverlay",
        "/items/3/entry/contextWindow",
        "/items/3/entry/displayName",
    ] {
        let mut value = page.clone();
        let (parent, field) = pointer.rsplit_once('/').unwrap();
        let parent = if parent.is_empty() {
            &mut value
        } else {
            value.pointer_mut(parent).unwrap()
        };
        parent[field] = Value::Null;
        if ["/defaultTarget", "/nextCursor"].contains(&pointer) {
            parent.as_object_mut().unwrap().remove(field);
        }
        assert!(decode_catalog_query_result(&value).is_err(), "{pointer}");
    }
    for (pointer, key, bad) in [
        ("/items/0", "modelsFetchedAt", json!(1)),
        ("/items/0", "modelsReceived", json!([])),
        (
            "/items/0",
            "requestHeaders",
            json!({"Authorization":"private"}),
        ),
        (
            "/items/2/model",
            "factOverriddenFields",
            json!(["contextWindow"]),
        ),
        ("/items/3/entry", "apiProtocol", json!("openai-chat")),
        ("/items/3/entry", "capabilities", json!({"chat":true})),
        ("/items/3/entry", "thinkingLevels", json!(["low", "low"])),
        ("/items/3/entry", "thinkingLevels", json!(["unknown"])),
        ("/items/3/entry", "thinkingLevels", Value::Null),
        ("/items/3/entry", "supportsVision", json!(1)),
        ("/items/3/entry", "defaultThinkingLevel", json!("medium")),
        ("/items/3/entry", "defaultThinkingLevel", Value::Null),
    ] {
        let mut value = page.clone();
        value.pointer_mut(pointer).unwrap()[key] = bad;
        assert!(
            decode_catalog_query_result(&value).is_err(),
            "{pointer}/{key}"
        );
    }
    for field in [
        "contextWindow",
        "inputLimit",
        "compactionThreshold",
        "defaultContextWindow",
        "defaultInputLimit",
    ] {
        for bad in [Value::Null, json!(0), json!(9007199254740992_u64)] {
            let mut value = page.clone();
            value["items"][3]["entry"][field] = bad;
            assert!(decode_catalog_query_result(&value).is_err(), "{field}");
        }
    }
}

#[test]
fn pages_enforce_bounds_and_forward_progress_without_requiring_whole_connections() {
    let page = mixed_page();
    let mut partial = page.clone();
    partial["items"] = json!([page["items"][3]]);
    partial["nextCursor"] = json!({"part":"catalog_entry","connectionIndex":0,"itemIndex":1});
    assert!(decode_catalog_query_result(&partial).is_ok());
    partial["nextCursor"]["itemIndex"] = json!(0);
    assert!(decode_catalog_query_result(&partial).is_err());
    for (pointer, bad) in [
        ("/connectionCount", json!(0)),
        ("/connectionCount", json!(1025)),
        ("/items", json!([])),
        ("/items", Value::Null),
        ("/items/0/enabledModelIdCount", json!(513)),
        ("/items/0/modelCount", json!(2049)),
        ("/items/0/catalogEntryCount", json!(MAX_CATALOG_ENTRIES + 1)),
        ("/items/1/itemIndex", json!(512)),
        ("/items/2/itemIndex", json!(2048)),
        ("/items/3/itemIndex", json!(MAX_CATALOG_ENTRIES)),
    ] {
        let mut value = page.clone();
        *value.pointer_mut(pointer).unwrap() = bad;
        assert!(decode_catalog_query_result(&value).is_err(), "{pointer}");
    }
    let mut reversed = page.clone();
    reversed["items"].as_array_mut().unwrap().swap(1, 2);
    assert!(decode_catalog_query_result(&reversed).is_err());
    let mut missing_source = page.clone();
    missing_source["items"][0]
        .as_object_mut()
        .unwrap()
        .remove("modelSource");
    assert!(decode_catalog_query_result(&missing_source).is_err());
    let cursor = json!({"kind":"continue","revision":7,
        "cursor":{"part":"catalog_entry","connectionIndex":0,"itemIndex":MAX_CATALOG_ENTRIES - 1}});
    assert!(decode_catalog_query_input(&cursor).is_ok());
    let mut beyond = cursor;
    beyond["cursor"]["itemIndex"] = json!(MAX_CATALOG_ENTRIES);
    assert!(decode_catalog_query_input(&beyond).is_err());
}

#[test]
fn model_overrides_are_preserved_or_rejected_and_empty_overlay_is_omitted() {
    let mut page = mixed_page();
    page["items"][0]["requestBodyOverlay"] = json!({});
    let result = decode_catalog_query_result(&page).unwrap();
    assert_eq!(
        result["items"][3]["modelOverride"],
        page["items"][3]["modelOverride"]
    );
    assert!(result["items"][0].get("requestBodyOverlay").is_none());
    page["items"][3]["modelOverride"] = json!({"thinkingLevels":["off"]});
    assert_eq!(
        decode_catalog_query_result(&page).unwrap()["items"][3]["modelOverride"],
        json!({"thinkingLevels":["off"]})
    );
    page["items"][3]["modelOverride"] = json!({});
    assert_eq!(
        decode_catalog_query_result(&page).unwrap()["items"][3]["modelOverride"],
        json!({})
    );
    for profile in [
        json!({"thinkingLevels":["low","low"]}),
        json!({"thinkingLevels":["unknown"]}),
        json!({"thinkingLevels":[]}),
        json!({"vision":null}),
        json!({"adapter":""}),
        json!({"adapter":"unsafe\nname"}),
        json!({"defaultThinkingLevel":"unknown"}),
        json!({"contextWindow":-1}),
        json!({"inputLimit":0}),
        json!({"maxOutputTokens":9007199254740992_u64}),
        json!({"capabilities":{"chat":"yes"}}),
        json!({"modalities":{"input":["text"],"output":["unknown"]}}),
        json!({"unknown":true}),
    ] {
        page["items"][3]["modelOverride"] = profile;
        assert!(decode_catalog_query_result(&page).is_err());
    }
}

#[test]
fn item_count_and_utf8_byte_budget_are_enforced() {
    let mut page = mixed_page();
    page["items"] = Value::Array(
        (0..129)
            .map(|n| {
                json!({"kind":"catalog_entry",
        "connectionIndex":0,"itemIndex":n,"entry":mixed_page()["items"][3]["entry"]})
            })
            .collect(),
    );
    assert!(decode_catalog_query_result(&page).is_err());
    page["items"].as_array_mut().unwrap().truncate(128);
    assert!(decode_catalog_query_result(&page).is_ok());
    for item in page["items"].as_array_mut().unwrap() {
        item["entry"]["description"] = json!("界".repeat(2048));
    }
    assert!(decode_catalog_query_result(&page).is_err());
}
