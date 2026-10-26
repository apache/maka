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
use serde_json::{Value, json};

fn accounting(rate: &str, usd: &str) -> String {
    format!(
        r#"{{"event_id":"request","quote":{{"providerId":"provider","revision":1,"pricing":{{"modelKey":"provider:model","inputUsdPer1M":{rate},"outputUsdPer1M":{rate},"cacheReadUsdPer1M":{rate},"cacheWriteUsdPer1M":{rate}}}}},"valuation":{{"usage":{{}},"usd":{usd}}},"kind":"accounting"}}"#
    )
}

#[test]
fn accounting_decodes_typed_numbers_without_changing_missing_price_semantics() {
    for (token, expected) in [
        ("0", 0.0_f64),
        ("-0.0", -0.0),
        ("0.7500", 0.75),
        ("7.5e-1", 0.75),
    ] {
        let text = accounting(token, token);
        let Record::Accounting {
            quote, valuation, ..
        } = serde_json::from_slice(text.as_bytes()).unwrap()
        else {
            panic!("accounting record")
        };
        let pricing = quote.pricing.unwrap();
        for actual in [
            pricing.input_usd_per_million,
            pricing.output_usd_per_million,
            pricing.cache_read_usd_per_million.unwrap(),
            pricing.cache_write_usd_per_million.unwrap(),
            valuation.unwrap().usd.unwrap(),
        ] {
            assert_eq!(actual.to_bits(), expected.to_bits(), "{token}");
        }
    }
    for text in [
        r#"{"kind":"accounting","event_id":"request","quote":{"providerId":"provider","revision":1,"pricing":null},"valuation":null}"#,
        r#"{"kind":"accounting","event_id":"request","quote":{"providerId":"provider","revision":1}}"#,
    ] {
        let Record::Accounting {
            quote, valuation, ..
        } = serde_json::from_str(text).unwrap()
        else {
            panic!("accounting record")
        };
        assert!(quote.pricing.is_none());
        assert!(valuation.is_none());
    }
    for usd in ["null", "0"] {
        let Record::Accounting { valuation, .. } =
            serde_json::from_str(&accounting("0", usd)).unwrap()
        else {
            panic!("accounting record")
        };
        assert_eq!(
            valuation.unwrap().usd,
            if usd == "null" { None } else { Some(0.0) }
        );
    }
    let mut value: Value = serde_json::from_str(&accounting("0", "null")).unwrap();
    value["valuation"].as_object_mut().unwrap().remove("usd");
    value["quote"]["pricing"]
        .as_object_mut()
        .unwrap()
        .remove("cacheReadUsdPer1M");
    value["quote"]["pricing"]
        .as_object_mut()
        .unwrap()
        .remove("cacheWriteUsdPer1M");
    let text = value.to_string();
    let Record::Accounting {
        quote, valuation, ..
    } = serde_json::from_str(&text).unwrap()
    else {
        panic!("accounting record")
    };
    assert!(valuation.unwrap().usd.is_none());
    assert!(quote.pricing.unwrap().cache_read_usd_per_million.is_none());
}

#[test]
fn accounting_rejects_coerced_numbers_and_ambiguous_fields() {
    for token in [
        r#""0.75""#,
        "true",
        "[]",
        r#"{"$serde_json::private::Number":"0.75"}"#,
        "1e400",
    ] {
        for text in [accounting(token, "0"), accounting("0", token)] {
            assert!(serde_json::from_str::<Record>(&text).is_err(), "{text}");
        }
    }
    // Pricing's required and present optional rates are not nullable; valuation is.
    assert!(serde_json::from_str::<Record>(&accounting("null", "0")).is_err());
    let text = accounting("0.75", "0.25");
    for invalid in [
        text.replacen("{", r#"{"kind":"accounting","#, 1),
        text.replacen(r#""kind":"accounting""#, r#""kind":{"accounting":null}"#, 1),
        text.replacen(
            r#""event_id":"request""#,
            r#""event_id":"request","event_id":"again""#,
            1,
        ),
        text.replacen(r#""usd":0.25"#, r#""usd":0.25,"usd":0.5"#, 1),
        text.replacen(
            r#""inputUsdPer1M":0.75"#,
            r#""inputUsdPer1M":0.75,"inputUsdPer1M":1"#,
            1,
        ),
        text.replacen(r#""inputUsdPer1M":0.75,"#, "", 1),
        text.replacen(
            r#""inputUsdPer1M":0.75"#,
            r#""inputUsdPer1M":0.75,"foreign":0"#,
            1,
        ),
        text.replacen(
            r#""event_id":"request""#,
            r#""event_id":"request","sequence":1"#,
            1,
        ),
    ] {
        assert!(
            serde_json::from_str::<Record>(&invalid).is_err(),
            "{invalid}"
        );
    }
    for invalid in [
        "null",
        "[]",
        r#"["accounting"]"#,
        r#"{"kind":"unknown"}"#,
        r#"{"kind":"end","digest":"digest","frames":18446744073709551616}"#,
        r#"{"kind":"end","digest":"digest","frames":1.0}"#,
    ] {
        assert!(
            serde_json::from_str::<Record>(invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn every_record_variant_keeps_its_wire_shape_and_field_policy() {
    let records = [
        json!({"kind":"header","inventory":{"root_session_id":"root","subtree_digest":"digest","sessions":[{"id":"root","revision":1}]},"source_high_water":u64::MAX}),
        json!({"kind":"session","id":"root","parent":null,"created_at":1,"updated_at":2,"archived":false,"configuration":{"integer":u64::MAX,"nested":[1,"1",null]}}),
        json!({"kind":"copy","request":{"sourceSessionId":"source","targetSessionId":"target","expectedSourceRevision":1,"purpose":{"kind":"branch","turnId":null,"sideConversation":false}},"through":1,"observed_through":2,"lineage":{"kind":"branch","origin":{"parent_session_id":"source","turn_id":null}},"state":"committed"}),
        json!({"kind":"member","session":"root","sequence":1,"archive_sequence":null}),
        json!({"kind":"revision_source","session":"root","sequence":1}),
        json!({"kind":"history_artifact","session":"root","source_session":"source","source_artifact":"old","artifact":"new"}),
        json!({"kind":"event","sequence":1,"json":"{\"number\":1.00,\"other\":1e2}"}),
        json!({"kind":"blob","resource":"tool_result","event_id":"event","bytes":u64::MAX,"digest":"digest"}),
        json!({"kind":"blob","resource":"composition","event_id":"event","bytes":1,"digest":"digest"}),
        json!({"kind":"blob","resource":"artifact","metadata":{"id":"artifact","sessionId":"root","turnId":"turn","createdAt":1,"name":"image","kind":"image","sizeBytes":1,"source":"user_upload"},"digest":"digest","frozen_at":null}),
        serde_json::from_str(&accounting("0.75", "0.25").replace(
            r#""usage":{}"#,
            r#""usage":{"input_tokens":null,"output_tokens":null,"cache_read_tokens":null,"cache_write_tokens":null,"reasoning_tokens":null}"#,
        )).unwrap(),
        json!({"kind":"end","digest":"digest","frames":u64::MAX}),
    ];
    for value in records {
        let text = value.to_string();
        let record: Record = serde_json::from_str(&text).unwrap();
        assert_eq!(serde_json::to_value(record).unwrap(), value, "{text}");
        let mut unknown = value.clone();
        unknown["foreign"] = Value::Null;
        assert!(
            serde_json::from_str::<Record>(&unknown.to_string()).is_err(),
            "{unknown}"
        );
        // Duplicate tags are rejected even when the values agree.
        let duplicate = format!(r#"{{"kind":{},{}"#, value["kind"], &text[1..]);
        assert!(
            serde_json::from_str::<Record>(&duplicate).is_err(),
            "{duplicate}"
        );
    }
    for text in [
        r#"{"kind":"member","session":"root","sequence":1}"#,
        r#"{"kind":"session","id":"root","created_at":1,"updated_at":2,"archived":false,"configuration":null}"#,
        r#"{"kind":"blob","resource":"artifact","metadata":{"id":"artifact","sessionId":"root","turnId":"turn","createdAt":1,"name":"image","kind":"image","sizeBytes":1,"source":"user_upload"},"digest":"digest"}"#,
    ] {
        assert!(serde_json::from_str::<Record>(text).is_ok(), "{text}");
    }
    for text in [
        r#"{"kind":"event","sequence":1}"#,
        r#"{"kind":"blob","resource":"composition","resource":"composition","event_id":"event","bytes":1,"digest":"digest"}"#,
        r#"{"kind":"blob","resource":"composition","event_id":"event","bytes":1,"bytes":2,"digest":"digest"}"#,
        r#"{"kind":"blob","resource":"artifact","metadata":{"id":"artifact","sessionId":"root","turnId":"turn","createdAt":1,"name":"image","kind":"image","sizeBytes":1,"source":"user_upload","mimeType":null},"digest":"digest"}"#,
    ] {
        assert!(serde_json::from_str::<Record>(text).is_err(), "{text}");
    }
}

#[test]
fn ignored_usage_values_keep_complete_json_validation() {
    // The pre-fix tagged shape provides the feature-dependent validity oracle.
    // Integer-zero rates let it reach ignored metadata even with arbitrary_precision.
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum BufferedRecord {
        Accounting {
            #[serde(rename = "event_id")]
            _event_id: String,
            #[serde(rename = "quote")]
            _quote: Quote,
            #[serde(rename = "valuation")]
            _valuation: Option<Valuation>,
        },
    }
    let deep = format!("{}0{}", "[".repeat(130), "]".repeat(130));
    for payload in [
        r#""\ud800""#,
        "1e400",
        r#"{"$serde_json::private::Number":"not-a-number"}"#,
        r#"{"repeated":"\ud800","repeated":0}"#,
        deep.as_str(),
    ] {
        let text = accounting("0", "0").replace(
            r#""usage":{}"#,
            &format!(r#""usage":{{"foreign":{payload}}}"#),
        );
        // Record wraps decoder diagnostics in D::Error::custom; callers rely on
        // Json failure, not serde_json's category of the wrapped inner error.
        let expected = serde_json::from_str::<BufferedRecord>(&text)
            .map(|_| ())
            .map_err(|_| ());
        let actual = serde_json::from_str::<Record>(&text)
            .map(|_| ())
            .map_err(|_| ());
        assert_eq!(actual, expected, "{text}");
        if payload.contains("ud800") || payload == deep {
            assert!(actual.is_err(), "{text}");
        }
        if payload.contains("$serde_json::private::Number") {
            assert!(
                actual.is_ok(),
                "marker-shaped ignored object is ordinary data"
            );
        }
    }
}
